/* global document, window */
import { spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { requireOfflineProxy } from './offline.mjs';
import { auditContrast } from './contrast.mjs';
import { buildFragmentedPdf, buildInjectionPdf } from './sample-pdf.mjs';
import { boxDistance, clearSelection, selectSpans, unionBox } from './text-selection.mjs';

/**
 * Browser acceptance for the AI reading loop.
 *
 * It drives the real application against the real local service, with the offline mock provider
 * behind it — so everything except the network hop to DeepSeek is the production path: the
 * browser builds the context, the Vite proxy forwards it, the service checks its origin and
 * writes the prompt, the citation verifier runs, and the answer comes back and is rendered.
 *
 * What it checks is deliberately not "does an answer appear". It checks what was actually sent,
 * that the citations lead back to the right words on the right page, that a failure leaves the
 * reader's own work untouched, and that nothing about the key or the paper leaks.
 *
 * Screenshots go to docs/screenshots-phase4/.
 */

const PORT = Number(process.env.AI_VERIFY_PREVIEW_PORT ?? 4177);
const AI_PORT = Number(process.env.AI_VERIFY_PORT ?? 8788);
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const AI_ORIGIN = `http://127.0.0.1:${String(AI_PORT)}`;
const ROOT = new URL('../../', import.meta.url);
/**
 * Evidence from this run goes in a directory of its own, named for the moment it started.
 *
 * Nothing here is ever overwritten and nothing is ever deleted. A screenshot taken during a real
 * run cannot be taken again — the previous phase lost two of them to a `rm` with a wildcard, and
 * the lesson is that the safe default for evidence is "write somewhere new".
 */
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = new URL(`docs/screenshots-phase5/${RUN_STAMP}/`, ROOT);
const REPORT_FILE = new URL(`docs/screenshots-phase5/${RUN_STAMP}/report.json`, ROOT);
const WORK_DIR = new URL('.cache/verify/', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SERVER_ENTRY = fileURLToPath(new URL('server/start.mjs', ROOT));
const REAL_PAPER = new URL('.cache/papers/2610.22294.pdf', ROOT);
const STORAGE_KEY = 'rw.projects';

/**
 * Offline means offline.
 *
 * This suite must never be able to reach a paid service. It starts the service with `--offline`,
 * which makes every environment variable irrelevant, and it refuses to run at all on a machine
 * whose shell is configured for the real provider — because the failure mode that matters is not
 * "the flag was forgotten", it is "a key was exported here months ago and nobody remembered".
 */
function refuseIfConfiguredForRealProvider() {
  const provider = process.env.AI_PROVIDER ?? '';
  const key = process.env.DEEPSEEK_API_KEY ?? '';
  if (provider !== 'deepseek' && key === '') return;
  process.stderr.write(
    '这个验收套件只在离线模式下运行，但当前环境被配置成了真实提供方：\n' +
      `  AI_PROVIDER=${provider === '' ? '(未设置)' : provider}\n` +
      `  DEEPSEEK_API_KEY=${key === '' ? '(未设置)' : '(已设置)'}\n` +
      '请在未导出这些变量的终端里重跑。这里不会替你把它们去掉再继续——\n' +
      '上一次正是这种「看起来是干的、其实是湿的」环境发出了一次真实计费调用。\n',
  );
  process.exit(4);
}

/**
 * Refuses to share a port with a service it did not start.
 *
 * The same incident: a service the user had started kept the port, this script's own service
 * failed to bind, and every request went to the paid one. Checking before binding turns that
 * into a message instead of a bill.
 */
async function refuseIfPortTaken() {
  try {
    const response = await fetch(`${AI_ORIGIN}/api/ai/health`);
    if (response.ok) {
      const health = await response.json();
      process.stderr.write(
        `端口 ${String(AI_PORT)} 上已经有一个 AI 服务在运行（provider=${String(health.provider)}）。\n` +
          '本次验收不会使用它：它可能是另一个配置，也可能正在调用付费模型。\n' +
          '请先停掉它，或设置 AI_VERIFY_PORT 换一个端口。\n',
      );
      process.exit(4);
    }
  } catch {
    // Nothing there, which is what we want.
  }
}

const results = [];
const consoleIssues = [];
/** Every request body the page sent to the service, in order. */
const requests = [];
/** Every question this script asked for, so "one request per question" can be asserted. */
let asksSent = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
}

function watch(page) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleIssues.push({
        text: `${message.type()}: ${message.text()}`,
        url: message.location()?.url ?? '',
      });
    }
  });
  page.on('pageerror', (error) => {
    consoleIssues.push({ text: `pageerror: ${error.message}`, url: '' });
  });
}

/**
 * The local AI service, forced onto the mock provider. Its output is kept so it can be audited.
 *
 * `--offline` rather than `AI_PROVIDER=mock`: the flag wins over the environment, so a shell
 * with a key exported into it cannot turn this into a paid run.
 */
async function startService() {
  const child = spawn(process.execPath, [SERVER_ENTRY, '--offline'], {
    cwd: fileURLToPath(ROOT),
    env: { ...process.env, AI_PORT: String(AI_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${AI_ORIGIN}/api/ai/health`);
      if (response.ok) {
        // Identity, not availability: "something answered" is exactly the assumption that failed
        // before. Nothing proceeds until the service says it is the offline one.
        const health = await response.json();
        if (health.provider !== 'mock' || health.online !== false) {
          child.kill();
          throw new Error(
            `the service on ${String(AI_PORT)} is ${String(health.provider)} (online=${String(health.online)}), not the offline mock`,
          );
        }
        return { child, outputOf: () => output, health };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('the service on')) throw error;
      // Not up yet.
    }
    await sleep(200);
  }
  child.kill();
  throw new Error('the local AI service did not start');
}

/**
 * Brings the assistant into view, whether the side panel is collapsed (a rail button) or open
 * on another tab (a tab in the panel).
 */
async function openAiPanel(page) {
  const panel = page.getByRole('complementary', { name: 'AI 精读助手' });
  if ((await panel.count()) === 0) {
    const rail = page.getByRole('button', { name: '打开 AI 助手' });
    if ((await rail.count()) > 0) await rail.click();
    else await page.getByRole('button', { name: /^AI 助手$/ }).click();
  }
  await panel.waitFor({ timeout: 5000 });
}

async function startPreview() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    {
      cwd: fileURLToPath(ROOT),
      env: { ...process.env, AI_PORT: String(AI_PORT) },
      stdio: 'ignore',
    },
  );
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(ORIGIN)).ok) return child;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  child.kill();
  throw new Error('preview server did not start');
}

const payloadOf = (page) =>
  page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? 'null'), STORAGE_KEY);

async function createProject(page, title) {
  await page.getByLabel('新建项目').click();
  await page.getByLabel('核心论文标题').fill(title);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('heading', { level: 1, name: title }).waitFor();
}

async function importIntoProject(page, filePath) {
  await page.getByRole('button', { name: '导入新论文' }).click();
  const dialog = page.getByRole('dialog', { name: '导入论文' });
  await dialog.locator('input[type="file"]').setInputFiles(filePath);
  await dialog.getByRole('button', { name: '导入' }).click();
  await page.locator('.reader').waitFor({ timeout: 30_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 30_000 });
}

/**
 * Selects the run of single-character spans on a page and opens the toolbar.
 *
 * A formula in a PDF text layer is often one glyph per span. This finds those spans by
 * measurement rather than by index, so the fixture can change without the check going stale.
 */
async function selectGlyphRun(page, pageNumber) {
  const run = await page.evaluate((number) => {
    const layer = document.querySelector(`.pdf-page[data-page="${String(number)}"] .textLayer`);
    if (layer === null) return null;
    const leaves = [...layer.querySelectorAll('span')].filter(
      (span) => span.querySelector('span') === null,
    );
    const singles = leaves
      .map((span, index) => ({ index, text: (span.textContent ?? '').trim() }))
      .filter((entry) => entry.text.length === 1);
    if (singles.length < 3) return null;
    return { start: singles[0].index, end: singles.at(-1).index, count: singles.length };
  }, pageNumber);
  if (run === null) return null;

  await selectSpans(
    page,
    pageNumber,
    { span: run.start, offset: 0 },
    { span: run.end, offset: 999 },
  );
  await page.mouse.move(5, 5);
  await page
    .locator(`.pdf-page[data-page="${String(pageNumber)}"]`)
    .first()
    .dispatchEvent('mouseup');
  await toolbarOf(page).waitFor({ timeout: 5000 });
  return run;
}

/** Back to wherever we were, then into the reader for this project's paper. */
async function reopenReader(page, projectName) {
  const back = page.getByRole('button', { name: '返回' });
  if ((await back.count()) > 0) await back.click();
  const expand = page.getByLabel('展开侧栏');
  if ((await expand.count()) > 0) await expand.click();
  await page.getByRole('button', { name: projectName }).first().click();
  await page.getByRole('button', { name: '阅读' }).first().click();
  await page.locator('.reader').waitFor({ timeout: 30_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 30_000 });
}

const toolbarOf = (page) => page.getByRole('toolbar', { name: '批注' });

/** Selects a span range and waits for the floating toolbar. */
async function selectForToolbar(page, pageNumber, start, end) {
  const selection = await selectSpans(page, pageNumber, start, end);
  await page.mouse.move(5, 5);
  await page
    .locator(`.pdf-page[data-page="${String(pageNumber)}"]`)
    .first()
    .dispatchEvent('mouseup');
  await toolbarOf(page).waitFor({ timeout: 5000 });
  return selection;
}

/** The boxes of whatever is currently spotlighted on a page, in viewport coordinates. */ function spotlightBoxes(
  page,
  pageNumber,
) {
  return page.evaluate((number) => {
    const elements = [
      ...document.querySelectorAll(
        `.pdf-page[data-page="${String(number)}"] .pdf-highlight[data-spotlight="true"]`,
      ),
    ];
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
  }, pageNumber);
}

/** The page's full rendered text, so a check can prove a later page was not sent. */
function pageTextOf(page, pageNumber) {
  return page.evaluate(
    (number) =>
      document.querySelector(`.pdf-page[data-page="${String(number)}"] .textLayer`)?.textContent ??
      '',
    pageNumber,
  );
}

async function main() {
  refuseIfConfiguredForRealProvider();
  await refuseIfPortTaken();
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });

  const real = existsSync(fileURLToPath(REAL_PAPER));
  const fixture = real
    ? fileURLToPath(REAL_PAPER)
    : fileURLToPath(new URL('two-column.pdf', WORK_DIR));
  if (!real) await writeFile(fixture, (await import('./sample-pdf.mjs')).buildTwoColumnPdf());
  const injectionFile = fileURLToPath(new URL('injection.pdf', WORK_DIR));
  await writeFile(injectionFile, buildInjectionPdf());
  const fragmentedFile = fileURLToPath(new URL('fragmented.pdf', WORK_DIR));
  await writeFile(fragmentedFile, buildFragmentedPdf());

  const service = await startService();
  const server = await startPreview();
  // The page talks through the preview proxy: check the identity of *that* path, and pin
  // it to the service process this run started.
  await requireOfflineProxy(ORIGIN, {
    expectedInstance: service.health.instanceId,
    label: 'AI 验收',
  });
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  watch(page);

  // Every ask is captured before it is forwarded, so the checks describe what really went out.
  await page.route('**/api/ai/ask', async (route) => {
    try {
      requests.push(route.request().postDataJSON());
    } catch {
      requests.push(null);
    }
    await route.continue();
  });

  try {
    await page.goto(ORIGIN);
    await createProject(page, 'AI 精读验收');
    await importIntoProject(page, fixture);
    const title = await page.locator('.reader-title').innerText();
    check(
      'setup: a real PDF is open in the reader',
      (await pageTextOf(page, 1)).length > 200,
      `${String((await pageTextOf(page, 1)).length)} chars${real ? '' : ' (generated fallback)'}`,
    );

    // Creating a project also creates its core paper, so the one with a file is the import.
    const paper = Object.values((await payloadOf(page)).papers).find(
      (entry) => entry.pdf !== undefined,
    );

    // ---- 1. Selecting text opens the assistant ----------------------------
    const selected = await selectForToolbar(
      page,
      1,
      { span: 4, offset: 0 },
      { span: 9, offset: 999 },
    );
    await toolbarOf(page).getByRole('button', { name: '向这段文字提问' }).click();
    const menu = page.getByRole('group', { name: '向 AI 提问' });
    await menu.waitFor({ timeout: 5000 });
    check(
      'entry: the selection toolbar offers the five ways to ask',
      (await menu.getByRole('button').count()) >= 4,
    );
    asksSent += 1;
    await menu.getByRole('button', { name: '解释这段话' }).click();
    const panel = page.getByRole('complementary', { name: 'AI 精读助手' });
    await panel.waitFor({ timeout: 10_000 });
    await panel.locator('.ai-answer-body').waitFor({ timeout: 20_000 });
    check('ask: the assistant panel opens from a real selection', true);
    await page.screenshot({ path: fileURLToPath(new URL('01-ask-answer.png', SHOT_DIR)) });

    // ---- 2. What was sent ------------------------------------------------
    const first = requests.at(-1);
    const passages = first?.passages ?? [];
    const selectedPassage = passages.find((entry) => entry.selection);
    check(
      'request: the selected原文 is the primary passage, verbatim',
      selectedPassage?.text?.replace(/\s+/g, ' ').trim() ===
        selected.text.replace(/\s+/g, ' ').trim(),
      `${String(selectedPassage?.text?.length ?? 0)} chars sent`,
    );
    check(
      'request: it carries the paper identity, the page and the file hash',
      first?.paper?.id === paper.id &&
        first?.paper?.page === 1 &&
        first?.paper?.pdfSha256 === paper.pdf?.sha256 &&
        first?.paper?.title === title,
      `sent ${JSON.stringify(first?.paper)} for ${paper.id.slice(0, 12)} sha ${String(paper.pdf?.sha256 ?? '').slice(0, 8)}`,
    );
    check(
      'request: it is a structured request, not a chat transcript',
      first?.mode === 'explain' && Array.isArray(first.passages),
    );

    // ---- 3. It is not the whole paper ------------------------------------
    const totalChars = passages.reduce((sum, entry) => sum + entry.text.length, 0);
    const pages = new Set(passages.map((entry) => entry.page));
    check(
      'request: the context is bounded, not the document',
      totalChars <= 3800 && passages.length <= 3,
      `${String(totalChars)} chars in ${String(passages.length)} passages`,
    );
    check(
      'request: every passage comes from the page being read',
      pages.size === 1 && pages.has(1),
    );

    const secondPageText = await page.evaluate(() => {
      const slot = document.querySelectorAll('.reader-slot')[1];
      const layer = slot?.querySelector('.textLayer');
      return layer?.textContent ?? '';
    });
    await page.locator('.pdf-page[data-page="1"]').scrollIntoViewIfNeeded();
    const bodyText = JSON.stringify(first);
    const probe = secondPageText.replace(/\s+/g, ' ').trim().slice(0, 60);
    check(
      'request: no text from a page the reader is not on',
      probe.length < 20 || !bodyText.includes(probe),
    );

    // ---- 4. Citations lead back to the words -----------------------------
    const chip = panel.locator('.ai-citation').first();
    await chip.waitFor({ timeout: 10_000 });
    const chipLabel = await chip.innerText();
    await chip.click();
    await page.waitForTimeout(600);
    const spotlight = unionBox(await spotlightBoxes(page, 1));
    const backToSelection = await selectSpans(
      page,
      1,
      { span: 4, offset: 0 },
      { span: 9, offset: 999 },
    );
    const targetBox = unionBox(backToSelection.boxes);
    await clearSelection(page);
    const offset = boxDistance(spotlight, targetBox);
    check(
      'citation: following it marks the exact words it quoted',
      offset <= 2,
      `${chipLabel.replace(/\s+/g, ' ')} → worst edge ${offset.toFixed(1)}px from the fresh selection`,
    );
    check('citation: the chip names a page, not a guess', /\d+\s*页/.test(chipLabel));
    await page.screenshot({ path: fileURLToPath(new URL('02-citation-jump.png', SHOT_DIR)) });

    // ---- 5. Asking does not save anything --------------------------------
    const beforeSave = await payloadOf(page);
    check(
      'privacy: a conversation is not written to storage',
      JSON.stringify(beforeSave).length === JSON.stringify(await payloadOf(page)).length &&
        !JSON.stringify(beforeSave).includes('本地模拟回答'),
      `${String(beforeSave.annotations.length)} notes stored`,
    );

    // ---- 6. Saving the answer as a note ----------------------------------
    await panel.getByRole('button', { name: /保存为笔记/ }).click();
    const afterSave = await payloadOf(page);
    const saved = afterSave.annotations.at(-1);
    check(
      'note: the explanation is saved through the ordinary annotation path',
      afterSave.annotations.length === beforeSave.annotations.length + 1 &&
        saved?.paperId === paper.id &&
        saved?.page === 1,
      `${String(afterSave.annotations.length)} notes`,
    );
    check(
      'note: it is marked as coming from the assistant, with its source',
      saved?.origin === 'assistant' && /模拟|DeepSeek/.test(saved?.sourceLabel ?? ''),
      `origin=${String(saved?.origin)} source=${String(saved?.sourceLabel)}`,
    );
    // The stored quote is whitespace-normalised, the passage sent is the raw page slice, so the
    // two are compared in the same normal form rather than byte for byte.
    const collapse = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
    check(
      'note: it is anchored to the same words the model was shown',
      collapse(saved?.quote) === collapse(selectedPassage?.text),
      collapse(saved?.quote) === collapse(selectedPassage?.text)
        ? `${String(collapse(saved?.quote).length)} chars`
        : `saved ${JSON.stringify(collapse(saved?.quote).slice(0, 40))} vs sent ${JSON.stringify(collapse(selectedPassage?.text).slice(0, 40))}`,
    );

    // ---- 7. It survives a reload -----------------------------------------
    await page.reload();
    await reopenReader(page, 'AI 精读验收');
    // The notes panel is already open in a wide window; only narrow ones start with it closed.
    // The side panel opens on the notes in a wide window; open that tab if it is not showing.
    if ((await page.locator('.note-item').count()) === 0) {
      await page.getByRole('button', { name: /^我的笔记/ }).click();
    }
    const item = page.locator('.note-item').filter({ hasText: 'AI 辅助' }).first();
    await item.waitFor({ timeout: 10_000 });
    check('persistence: the saved note is still there after a reload, marked as AI-assisted', true);
    check(
      'persistence: it is drawn as a highlight on the page as well',
      (await page.locator('.pdf-highlight[data-annotation]').count()) > 0,
    );

    // ---- 8. Translation ---------------------------------------------------
    await openAiPanel(page);
    const toTranslate = await selectForToolbar(
      page,
      1,
      { span: 4, offset: 0 },
      { span: 6, offset: 999 },
    );
    await toolbarOf(page).getByRole('button', { name: '向这段文字提问' }).click();
    asksSent += 1;
    await page
      .getByRole('group', { name: '向 AI 提问' })
      .getByRole('button', { name: '翻译为中文' })
      .click();
    await page.locator('.ai-parallel').waitFor({ timeout: 20_000 });
    const original = (await page.locator('.ai-original').innerText()).replace(/\s+/g, ' ').trim();
    const translation = (await page.locator('.ai-translation').innerText())
      .replace(/\s+/g, ' ')
      .trim();
    const wanted = toTranslate.text.replace(/\s+/g, ' ').trim();
    check(
      'translate: the English shown is exactly what the reader selected',
      original.includes(wanted) && wanted.length > 20,
      `${String(wanted.length)} of ${String(original.length)} chars`,
    );
    check(
      'translate: a Chinese translation is shown beside it',
      /[一-鿿]/.test(translation) && translation.length > 20,
      `${String(translation.length)} chars`,
    );
    await page.screenshot({ path: fileURLToPath(new URL('03-translate.png', SHOT_DIR)) });
    await page.getByRole('button', { name: '隐藏译文' }).click();
    check(
      'translate: it can be folded away so it stops covering the page',
      (await page.locator('.ai-answer-body').count()) === 0 &&
        (await page.locator('.ai-original').count()) === 1,
    );

    // ---- 9. Failure, retry and cancellation -------------------------------
    const askWith = async (question) => {
      const box = page.getByRole('textbox', { name: '继续提问' });
      await box.fill(question);
      asksSent += 1;
      await page.getByRole('button', { name: '提问' }).click();
    };

    await askWith('故意触发错误 [[mock:error]]');
    const alert = page.getByRole('alert').last();
    await alert.waitFor({ timeout: 20_000 });
    check(
      'failure: a provider error is reported, with a retry',
      (await alert.innerText()).length > 0 &&
        (await page.getByRole('button', { name: '重试' }).count()) > 0,
      (await alert.innerText()).slice(0, 40),
    );
    const afterFailure = await payloadOf(page);
    check(
      'failure: the reader’s notes and highlights are untouched',
      afterFailure.annotations.length === afterSave.annotations.length,
      `${String(afterFailure.annotations.length)} notes still stored`,
    );
    await page.screenshot({ path: fileURLToPath(new URL('04-failure.png', SHOT_DIR)) });

    asksSent += 1;
    await page.getByRole('button', { name: '重试' }).click();
    await page.waitForTimeout(1200);
    check(
      'retry: retrying re-runs the same question and reports the same failure',
      (await page.getByRole('alert').count()) > 0 &&
        (await page.getByRole('textbox', { name: '继续提问' }).count()) === 1,
    );

    await askWith('这次说得慢一点 [[mock:timeout]]');
    await page.getByRole('button', { name: '取消' }).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: '取消' }).click();
    await page.waitForTimeout(600);
    check(
      'cancel: stopping a stalled request clears the busy state and leaves the panel usable',
      (await page.locator('.ai-busy').count()) === 0 &&
        (await page.getByRole('textbox', { name: '继续提问' }).count()) === 1,
    );

    // ---- 9b. The reply shapes a model actually produces -------------------
    // Each of these is a reply the parser has a named status for. What is being checked is what
    // the *reader* sees: never the protocol, always an honest sentence about what happened.

    await askWith('把真实失败原样放一遍 [[mock:escaped-envelope]]');
    const replay = page.locator('.ai-turn').last();
    await replay.locator('.ai-answer-body').waitFor({ timeout: 20_000 });
    const replayText = await replay.innerText();
    check(
      'replay: the saved live failure is shown as the answer it contains',
      replayText.includes('先说明提取质量') && replayText.includes('一句话总结'),
      `${String(replayText.length)} chars on screen`,
    );
    check(
      'replay: no JSON, no protocol fields and no escape sequences reach the reader',
      !replayText.includes('groundedInText') &&
        !replayText.includes('passageId') &&
        !replayText.includes('"citations"') &&
        !replayText.includes('\\"'),
    );
    check(
      'replay: the formula the model wrote inside it is typeset',
      (await replay.locator('.katex').count()) > 0,
      `${String(await replay.locator('.katex').count())} formulas`,
    );
    const details = replay.locator('.ai-diagnostics');
    check(
      'diagnostics: they are behind a disclosure, closed until the reader opens it',
      (await details.count()) === 1 && (await details.getAttribute('open')) === null,
    );
    await details.locator('summary').click();
    const detailText = await details.innerText();
    check(
      'diagnostics: opening it names the parse status and the stop reason, in numbers',
      detailText.includes('已还原') &&
        detailText.includes('结束原因') &&
        detailText.includes('字符'),
      detailText.replace(/\s+/g, ' ').slice(0, 60),
    );
    await page.screenshot({ path: fileURLToPath(new URL('09-replay.png', SHOT_DIR)) });

    await askWith('这次只给协议不给回答 [[mock:protocol-only]]');
    const broken = page.locator('.ai-turn').last();
    await broken.getByRole('alert').waitFor({ timeout: 20_000 });
    const brokenText = await broken.innerText();
    check(
      'malformed: a reply with no answer is reported, not printed',
      !brokenText.includes('"answer"') &&
        !brokenText.includes('"citations"') &&
        (await broken.locator('.ai-answer-body').count()) === 0,
    );
    check(
      'malformed: it offers a manual retry, and saves nothing',
      (await broken.getByRole('button', { name: '重试' }).count()) === 1 &&
        (await broken.getByRole('button', { name: /保存为笔记/ }).count()) === 0,
    );
    const afterMalformed = await payloadOf(page);
    check(
      'malformed: an unreadable reply does not touch the reader’s own work',
      afterMalformed.annotations.length === afterSave.annotations.length,
      `${String(afterMalformed.annotations.length)} notes still stored`,
    );

    await askWith('这次被截断了 [[mock:truncated]]');
    const cut = page.locator('.ai-turn').last();
    await cut.locator('.ai-answer-body').waitFor({ timeout: 20_000 });
    check(
      'incomplete: a cut-off reply is labelled as incomplete, not shown as whole',
      (await cut.innerText()).includes('没有写完'),
    );

    // ---- 9c. Mathematics ----------------------------------------------------
    await selectForToolbar(page, 1, { span: 4, offset: 0 }, { span: 9, offset: 999 });
    await toolbarOf(page).getByRole('button', { name: '向这段文字提问' }).click();
    asksSent += 1;
    await page
      .getByRole('group', { name: '向 AI 提问' })
      .getByRole('button', { name: '解释数学公式' })
      .click();
    const mathTurn = page.locator('.ai-turn').last();
    await mathTurn.locator('.katex').first().waitFor({ timeout: 20_000 });
    const mathBody = await mathTurn.innerText();
    const mathBox = await mathTurn.locator('.ai-math').first().boundingBox();
    check(
      'math: a formula in the answer is typeset rather than shown as LaTeX source',
      mathBox !== null && mathBox.height > 4 && !mathBody.includes('\\frac{P_1(u)}{P_0(u)}'),
      `first formula ${String(Math.round(mathBox?.height ?? 0))}px tall`,
    );
    check(
      'math: the LaTeX source stays available, and is not silently rewritten',
      ((await mathTurn.locator('.ai-math').first().getAttribute('data-latex')) ?? '').includes(
        '\\frac',
      ),
    );
    check(
      'math: the answer says the formula is the model’s typesetting, not extracted text',
      mathBody.includes('不是从 PDF 里提取出来的原文'),
    );
    await page.screenshot({ path: fileURLToPath(new URL('10-math.png', SHOT_DIR)) });

    // ---- 9d. A formula wider than the panel --------------------------------
    await askWith('来一个很宽的公式 [[mock:wide-formula]]');
    const wideTurn = page.locator('.ai-turn').last();
    await wideTurn.locator('.ai-math-block').waitFor({ timeout: 20_000 });
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector('.ai-panel');
      const blocks = document.querySelectorAll('.ai-math-block');
      const block = blocks[blocks.length - 1] ?? null;
      return {
        panel: panel === null ? 0 : panel.scrollWidth - panel.clientWidth,
        blockScrolls: block === null ? false : block.scrollWidth > block.clientWidth,
      };
    });
    check(
      'math: a formula wider than the panel scrolls inside its own box instead of widening the panel',
      overflow.panel <= 1 && overflow.blockScrolls,
      `panel overflow ${String(overflow.panel)}px, the formula scrolls: ${String(overflow.blockScrolls)}`,
    );

    // ---- 10. No key, no proxy, no execution -------------------------------
    const answers = await page.evaluate(() => document.body.innerText);
    check(
      'leak: no credential appears anywhere in the rendered app',
      !/sk-[A-Za-z0-9]{16,}/.test(answers),
    );

    const built = await readFile(new URL('dist/index.html', ROOT), 'utf8').catch(() => '');
    const scripts = await readdir(new URL('dist/assets/', ROOT)).catch(() => []);
    let bundle = built;
    for (const file of scripts) {
      if (file.endsWith('.js')) {
        bundle += await readFile(new URL(`dist/assets/${file}`, ROOT), 'utf8').catch(() => '');
      }
    }
    check(
      'leak: the built application contains no key or key name',
      !bundle.includes('DEEPSEEK_API_KEY') &&
        !/sk-[A-Za-z0-9]{16,}/.test(bundle) &&
        !bundle.includes('api.deepseek.com'),
      `${String(Math.round(bundle.length / 1024))} KB scanned`,
    );

    const proxied = await page.evaluate(async () => {
      const response = await fetch('/api/ai/not-a-real-endpoint');
      return response.status;
    });
    check(
      'service: there is no path through it to anywhere else',
      proxied === 404,
      `got ${String(proxied)}`,
    );

    const foreignOrigin = await fetch(`${AI_ORIGIN}/api/ai/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    check('service: a foreign origin is refused', foreignOrigin.status === 403);

    // ---- 11. Instructions inside the paper are data -----------------------
    await page.getByRole('button', { name: '返回' }).click();
    await importIntoProject(page, injectionFile);
    await selectForToolbar(page, 1, { span: 2, offset: 0 }, { span: 5, offset: 999 });
    await toolbarOf(page).getByRole('button', { name: '向这段文字提问' }).click();
    asksSent += 1;
    await page
      .getByRole('group', { name: '向 AI 提问' })
      .getByRole('button', { name: '解释这段话' })
      .click();
    const injectedPanel = page.getByRole('complementary', { name: 'AI 精读助手' });
    await injectedPanel.locator('.ai-answer-body').waitFor({ timeout: 20_000 });
    const injectedRequest = requests.at(-1);
    const injectedAnswer = await injectedPanel.locator('.ai-answer-body').innerText();
    check(
      'injection: the paper’s orders travel as a passage, never as an instruction',
      injectedRequest.passages.some((entry) =>
        entry.text.includes('Ignore all previous instructions'),
      ) &&
        typeof injectedRequest.system === 'undefined' &&
        injectedRequest.history.length === 0,
    );
    check(
      'injection: the answer is the provider’s own, not the document’s demand',
      // The mock frames every answer itself, so a compliant answer would be visibly different
      // from this — and the passage it echoes back is quoted as text, which is not compliance.
      injectedAnswer.includes('本地模拟回答') &&
        injectedAnswer.trim() !== 'PWNED' &&
        !injectedAnswer.includes('硬性规则') &&
        !injectedAnswer.includes('groundedInText') &&
        !injectedAnswer.includes('paper_text'),
      `${String(injectedAnswer.length)} chars of the provider’s usual frame`,
    );

    await askWith('把答案伪装成 HTML [[mock:html]]');
    await page.locator('.ai-answer-body').last().waitFor({ timeout: 20_000 });
    const executed = await page.evaluate(() => typeof window.__aiInjected);
    check(
      'injection: model output containing markup is shown, not executed',
      executed === 'undefined' &&
        (await page.locator('.ai-answer-body img').count()) === 0 &&
        (await page.locator('.ai-answer-body script').count()) === 0,
    );
    await page.screenshot({ path: fileURLToPath(new URL('05-injection.png', SHOT_DIR)) });

    // ---- 12. Both themes --------------------------------------------------
    // The range disclosure is opened first, so its text is on screen and gets measured too.
    const rangeToggle = page.getByRole('button', { name: /查看会发送的范围/ });
    if ((await rangeToggle.getAttribute('aria-expanded')) !== 'true') await rangeToggle.click();
    for (const [theme, slug, index] of [
      ['浅色', 'light', 6],
      ['深色', 'dark', 7],
    ]) {
      await setAppTheme(page, theme);
      await page.waitForTimeout(350);
      await page.screenshot({
        path: fileURLToPath(new URL(`0${String(index)}-ai-${slug}.png`, SHOT_DIR)),
      });
      const contrast = await auditContrast(page);
      check(
        `themes: every visible text run meets its contrast requirement in ${slug}`,
        contrast.failures.length === 0,
        `${String(contrast.checked)} runs, ${String(contrast.failures.length)} below their requirement` +
          contrast.failures
            .slice(0, 5)
            .map(
              (entry) =>
                ` [${String(entry.ratio)} < ${String(entry.need)} ${entry.label.slice(0, 60)}]`,
            )
            .join(''),
      );
    }

    // ---- 13. The service’s own log ---------------------------------------
    const log = service.outputOf();
    const lines = log.split('\n').filter((entry) => entry.trim() !== '');
    const parsed = lines.filter((entry) => {
      try {
        JSON.parse(entry);
        return true;
      } catch {
        return false;
      }
    });
    check('log: every line is a structured record, not a dump', parsed.length === lines.length);
    check(
      'log: no key and no paper text is recorded',
      !log.includes('DEEPSEEK_API_KEY') &&
        !/sk-[A-Za-z0-9]{16,}/.test(log) &&
        !log.includes('Ignore all previous instructions'),
    );
    check(
      'log: it does record what was asked, in numbers',
      log.includes('"passages"') && log.includes('"citations"'),
    );

    // ---- 14. The reader still works ---------------------------------------
    await page.getByRole('button', { name: '返回' }).click();
    await reopenReader(page, 'AI 精读验收');
    const before = (await payloadOf(page)).annotations.length;
    await selectForToolbar(page, 1, { span: 12, offset: 0 }, { span: 14, offset: 999 });
    await toolbarOf(page).getByRole('button', { name: '高亮' }).click();
    check(
      'regression: highlighting still works next to the assistant',
      (await payloadOf(page)).annotations.length === before + 1,
    );

    // ---- 15. A selection that is broken into pieces ------------------------
    await page.getByRole('button', { name: '返回' }).click();
    await importIntoProject(page, fragmentedFile);
    const run = await selectGlyphRun(page, 1);
    check(
      'fragmentation: this page really does store its formula one glyph per span',
      run !== null && run.count >= 8,
      `${String(run?.count ?? 0)} single-character spans`,
    );
    await toolbarOf(page).getByRole('button', { name: '向这段文字提问' }).click();
    asksSent += 1;
    await page
      .getByRole('group', { name: '向 AI 提问' })
      .getByRole('button', { name: '解释这段话' })
      .click();
    const fragmentPanel = page.getByRole('complementary', { name: 'AI 精读助手' });
    await fragmentPanel.locator('.ai-answer-body').waitFor({ timeout: 20_000 });
    const warnCount = await fragmentPanel.locator('.ai-source-warn').count();
    const fragmentWarn =
      warnCount === 0 ? '' : await fragmentPanel.locator('.ai-source-warn').first().innerText();
    check(
      'fragmentation: the panel says what the model is really being given, before it is sent',
      warnCount === 1 && fragmentWarn.includes('碎片') && fragmentWarn.includes('只有一个字符'),
      warnCount === 0 ? 'no warning rendered' : fragmentWarn.replace(/\s+/g, ' ').slice(0, 72),
    );
    await page.screenshot({ path: fileURLToPath(new URL('11-fragmented.png', SHOT_DIR)) });

    // The count is the whole point of this check: a service that retried, or a page that
    // re-sent on re-render, would show up here as more requests than questions.
    check(
      'calls: exactly one request left the page for each question asked, with no retries',
      requests.length === asksSent,
      `${String(requests.length)} requests for ${String(asksSent)} questions`,
    );

    // Three of the requests below are broken on purpose — the two provider errors and the
    // endpoint probe — so their browser-level noise is expected. Everything else is not.
    const provoked = consoleIssues.filter((issue) =>
      /\/api\/ai\/(ask|not-a-real-endpoint)/.test(issue.url),
    );
    const unexpected = consoleIssues.filter(
      (issue) => !/\/api\/ai\/(ask|not-a-real-endpoint)/.test(issue.url),
    );
    check(
      'console: nothing failed except the requests this run broke on purpose',
      unexpected.length === 0 && provoked.length <= 3,
      `${String(unexpected.length)} unexpected, ${String(provoked.length)} provoked`,
    );
    if (unexpected.length > 0) {
      process.stdout.write(
        `  unexpected: ${unexpected
          .slice(0, 3)
          .map((issue) => issue.text)
          .join(' | ')}\n`,
      );
    }
  } catch (error) {
    // A timeout deep in the run is hard to read from a stack trace alone. Say what the panel
    // was actually showing at the moment it gave up.
    process.stdout.write(`\n--- the run stopped here ---\n${String(error)}\n`);
    try {
      const last = page.locator('.ai-turn').last();
      process.stdout.write(`last turn:\n${(await last.innerHTML()).slice(0, 2000)}\n`);
      process.stdout.write(
        `console issues:\n${consoleIssues.map((issue) => issue.text).join('\n')}\n`,
      );
    } catch {
      // The page may be gone; the error above is still the useful part.
    }
    throw error;
  } finally {
    await browser.close();
    server.kill();
    service.child.kill();
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  await writeFile(
    REPORT_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        run: RUN_STAMP,
        provider: 'mock (offline, through the real local service)',
        providerIdentity: service.health,
        instanceId: service.health.instanceId,
        // Recorded so the report says, by itself, that this run could not have spent anything.
        environment: {
          offlineFlag: true,
          aiProviderEnv: process.env.AI_PROVIDER ?? null,
          deepseekKeyPresent: (process.env.DEEPSEEK_API_KEY ?? '') !== '',
        },
        fixture: real ? 'real CC-BY arXiv paper 2610.22294' : 'generated two-column sample',
        passed,
        failed,
        results,
        consoleIssues,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\n${String(passed)} passed, ${String(failed)} failed.\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();

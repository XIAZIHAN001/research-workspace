/* global document, window, HTMLCanvasElement */
import { spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { requireOfflineProxy } from './offline.mjs';
import { buildColourPdf } from './sample-pdf.mjs';
import { boxDistance, selectSpans, unionBox } from './text-selection.mjs';

/**
 * Browser acceptance for the immersive reading phase.
 *
 * Three things are being checked, and none of them is "the element exists":
 *
 * 1. the paper itself changes colour — sampled from the canvas, not from a CSS class;
 * 2. the assistant is reachable without a selection, and a question about the page sends the
 *    page and nothing else;
 * 3. the difficulty markers are anchored to real words, can be dismissed, and survive a reload
 *    without re-sending anything.
 *
 * The fixture is built for the purpose: white paper, black text, and three coloured blocks whose
 * colours must not move in any reading mode.
 */

const PORT = Number(process.env.AI_VERIFY_PREVIEW_PORT ?? 4179);
const AI_PORT = Number(process.env.AI_VERIFY_PORT ?? 8789);
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const AI_ORIGIN = `http://127.0.0.1:${String(AI_PORT)}`;
const ROOT = new URL('../../', import.meta.url);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = new URL(`docs/screenshots-phase5/${RUN_STAMP}-immersive/`, ROOT);
const REPORT_FILE = new URL(`docs/screenshots-phase5/${RUN_STAMP}-immersive/report.json`, ROOT);
const WORK_DIR = new URL('.cache/verify/', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SERVER_ENTRY = fileURLToPath(new URL('server/start.mjs', ROOT));

const results = [];
const consoleIssues = [];
const requests = { ask: [], difficulty: [] };
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
  page.on('response', (response) => {
    if (response.status() >= 400) {
      consoleIssues.push({
        text: `response ${String(response.status())}: ${response.url()}`,
        url: response.url(),
      });
    }
  });
  page.on('pageerror', (error) => {
    consoleIssues.push({ text: `pageerror: ${error.message}`, url: '' });
  });
}

function refuseIfConfiguredForRealProvider() {
  const provider = process.env.AI_PROVIDER ?? '';
  const key = process.env.DEEPSEEK_API_KEY ?? '';
  if (provider !== 'deepseek' && key === '') return;
  process.stderr.write(
    '这个验收套件只在离线模式下运行，但当前环境被配置成了真实提供方。\n' +
      '请在未导出 AI_PROVIDER / DEEPSEEK_API_KEY 的终端里重跑。\n',
  );
  process.exit(4);
}

async function refuseIfPortTaken() {
  try {
    const response = await fetch(`${AI_ORIGIN}/api/ai/health`);
    if (response.ok) {
      const health = await response.json();
      process.stderr.write(
        `端口 ${String(AI_PORT)} 上已经有一个 AI 服务在运行（provider=${String(health.provider)}）。\n` +
          '本次验收不会使用它，请先停掉它或设置 AI_VERIFY_PORT。\n',
      );
      process.exit(4);
    }
  } catch {
    // Nothing there, which is what we want.
  }
}

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
        const health = await response.json();
        if (health.provider !== 'mock' || health.online !== false) {
          child.kill();
          throw new Error(`the service on ${String(AI_PORT)} is not the offline mock`);
        }
        return { child, outputOf: () => output, health };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('the service on')) throw error;
    }
    await sleep(200);
  }
  child.kill();
  throw new Error('the local AI service did not start');
}

async function startPreview() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    // The preview proxy reads AI_PORT from its own environment. Without it the page talks to
    // the *default* port — which on this machine held a live paid service. This line is the
    // difference between an offline acceptance run and a bill.
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

async function createProject(page, title) {
  await page.getByLabel('新建项目').click();
  await page.getByLabel('核心论文标题').fill(title);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('heading', { level: 1, name: title }).waitFor();
}

async function importIntoProject(page, filePath) {
  await page.getByRole('button', { name: '导入新论文' }).click();
  const dialog = page.getByRole('dialog', { name: '导入论文' });
  await dialog.locator('input[type="file"][data-autofocus]').setInputFiles(filePath);
  await dialog.getByRole('button', { name: '导入' }).click();
  await page.locator('.reader').waitFor({ timeout: 30_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 30_000 });
}

/**
 * Back into the reader for this project, from wherever a reload left us.
 *
 * The click on 阅读 is retried: after a reload the project page is rebuilt from storage and a
 * click that lands during that rebuild can be lost. Retrying is harmless and keeps the check
 * about the reader, not about a race.
 */
async function reopenReader(page, projectName) {
  const back = page.getByRole('button', { name: '返回' });
  if ((await back.count()) > 0) await back.click();
  const expand = page.getByLabel('展开侧栏');
  if ((await expand.count()) > 0) await expand.click();
  await page.getByRole('button', { name: projectName }).first().click();
  await page.waitForTimeout(500);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // `exact` matters: the project is called 沉浸式阅读验收, and Playwright's name matching is
    // a substring search by default — without it this clicks the sidebar row instead.
    const read = page.getByRole('button', { name: '阅读', exact: true }).first();
    if ((await read.count()) === 0) {
      await page.waitForTimeout(500);
      continue;
    }
    await read.click();
    try {
      await page.locator('.reader').waitFor({ timeout: 5000 });
      await page
        .locator('.pdf-page[data-page="1"] .textLayer span')
        .first()
        .waitFor({ timeout: 30_000 });
      return;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  await page.screenshot({
    path: fileURLToPath(new URL('reopen-failed.png', SHOT_DIR)),
    fullPage: false,
  });
  process.stdout.write(
    `  reopen failed; screen reads:
${(await page.evaluate(() => document.body.innerText)).slice(0, 400)}
`,
  );
  process.stdout.write(
    `  screen reads:
${(await page.evaluate(() => document.body.innerText)).slice(0, 400)}
`,
  );
  throw new Error('could not reopen the reader');
}

/** Closes whichever side panel is open, so the rail can be checked. */
async function closeSidePanel(page) {
  for (const name of ['关闭目录', '关闭 AI 面板', '关闭相关知识']) {
    const button = page.getByRole('button', { name });
    if ((await button.count()) > 0) {
      await button.first().click();
      await page.waitForTimeout(150);
      return;
    }
  }
}

const toolbarOf = (page) => page.getByRole('toolbar', { name: '批注' });
const sidePanel = (page) => page.getByRole('complementary', { name: 'AI 精读助手' });

/**
 * Waits until the page has stopped re-rendering.
 *
 * Opening a panel changes the fit-width scale, which rebuilds every canvas and text layer. A
 * selection made during that rebuild is reported and then dismissed by the scroll that restores
 * the reading position — so the checks wait for the canvas width to hold still first.
 */
async function waitForSettled(page) {
  let last = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const width = await page.evaluate(() => {
      const canvas = document.querySelector('.pdf-canvas');
      return canvas instanceof HTMLCanvasElement ? canvas.width : 0;
    });
    if (width !== 0 && width === last) return;
    last = width;
    await page.waitForTimeout(200);
  }
}

async function selectForToolbar(page, pageNumber, start, end) {
  // The text layer is rebuilt whenever the fit-width scale changes, which is what opening a
  // panel does. Selecting during a rebuild finds no spans at all, so the selection is retried
  // until it holds and the toolbar has rendered.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await waitForSettled(page);
    const selection = await selectSpans(page, pageNumber, start, end);
    if (selection === null) {
      await page.waitForTimeout(300);
      continue;
    }
    await page.mouse.move(5, 5);
    await page
      .locator(`.pdf-page[data-page="${String(pageNumber)}"]`)
      .first()
      .dispatchEvent('mouseup');
    try {
      await page.locator('.annotation-toolbar').first().waitFor({ timeout: 1500 });
      return selection;
    } catch {
      await page.waitForTimeout(300);
    }
  }
  throw new Error('the selection toolbar did not appear');
}

/**
 * Samples the rendered page.
 *
 * Colour is read from the canvas the reader is looking at, after the recolouring has run — a
 * check on a CSS class would pass even if the pixels never changed.
 */
function samplePage(page, pageNumber) {
  return page.evaluate((number) => {
    const canvas = document.querySelector(`.pdf-page[data-page="${String(number)}"] .pdf-canvas`);
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d', { willReadFrequently: true });
    if (context === null) return null;
    context.drawImage(canvas, 0, 0);
    const pixel = (fx, fy) => {
      const data = context.getImageData(
        Math.floor(fx * copy.width),
        Math.floor(fy * copy.height),
        1,
        1,
      ).data;
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
    };
    const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const all = context.getImageData(0, 0, copy.width, copy.height).data;
    let sum = 0;
    let min = 255;
    let max = 0;
    let count = 0;
    for (let index = 0; index < all.length; index += 4 * 53) {
      const value =
        0.2126 * (all[index] ?? 0) +
        0.7152 * (all[index + 1] ?? 0) +
        0.0722 * (all[index + 2] ?? 0);
      sum += value;
      if (value < min) min = value;
      if (value > max) max = value;
      count += 1;
    }
    const paper = pixel(0.5, 0.75);
    return {
      paper,
      paperLum: lum(paper),
      red: pixel(0.269, 0.25),
      blue: pixel(0.72, 0.25),
      mean: sum / Math.max(1, count),
      min,
      max,
    };
  }, pageNumber);
}

const near = (one, other, tolerance) =>
  Math.abs(one[0] - other[0]) <= tolerance &&
  Math.abs(one[1] - other[1]) <= tolerance &&
  Math.abs(one[2] - other[2]) <= tolerance;

const RED = [217, 26, 26];

/**
 * Waits until the canvas reports the paper colour this mode should have.
 *
 * Every wait also requires the red block to be drawn. A canvas that has only been cleared to
 * its background is white, which passes a "is it white" test — and that race made the original
 * mode check fail intermittently with a page that had not finished rendering.
 */
async function waitForPaper(page, pageNumber, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await samplePage(page, pageNumber);
    if (last !== null && predicate(last)) return last;
    await page.waitForTimeout(120);
  }
  return last;
}

/**
 * Chooses a paper mode through the toolbar's trigger menu. The modes are options inside the
 * menu (with hints in their accessible name), so matching is by substring.
 */
async function choosePaperMode(page, label) {
  const trigger = page.getByRole('button', { name: /纸张模式/ });
  const menu = page.locator('.paper-modes__menu');
  if (!(await menu.isVisible().catch(() => false))) {
    await trigger.click();
  }
  await menu.waitFor({ state: 'visible' });
  // Filter by the option's name span, not by the whole accessible name: the hints of the other
  // options can carry the same substring ("跟随外观"的提示里就有"深灰"), and a bare substring
  // would match two options at once. The name span holds exactly the mode's label.
  await page
    .locator('.paper-modes__option')
    .filter({ has: page.locator('.paper-modes__name', { hasText: label }) })
    .click();
}

async function main() {
  refuseIfConfiguredForRealProvider();
  await refuseIfPortTaken();
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });

  const colourFile = fileURLToPath(new URL('colour.pdf', WORK_DIR));
  await writeFile(colourFile, buildColourPdf());

  const service = await startService();
  const server = await startPreview();
  // The page talks through the preview proxy: check the identity of *that* path, and pin
  // it to the service process this run started.
  await requireOfflineProxy(ORIGIN, {
    expectedInstance: service.health.instanceId,
    label: '沉浸式验收',
  });
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  watch(page);

  await page.route('**/api/ai/difficulties', async (route) => {
    requests.difficulty.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.route('**/api/ai/ask', async (route) => {
    requests.ask.push(route.request().postDataJSON());
    await route.continue();
  });

  try {
    await page.goto(ORIGIN);
    await createProject(page, '沉浸式阅读验收');
    await importIntoProject(page, colourFile);
    check('setup: the colour fixture is open in the reader', true);

    // ---- A. Paper modes ----------------------------------------------------
    // The app starts in its light theme, so the paper follows into warm.
    const warm = await waitForPaper(
      page,
      1,
      (sample) => sample.paper[0] > 200 && near(sample.red, RED, 60),
    );
    check(
      'paper: the default mode follows the app theme into warm paper',
      (await page.locator('.pdf-page[data-page="1"]').getAttribute('data-paper')) === 'warm' &&
        warm !== null &&
        near(warm.paper, [246, 241, 230], 6),
      warm === null ? 'no canvas' : `paper ${String(warm.paper)}`,
    );
    check(
      'paper: colour survives the warm mode untouched',
      warm !== null && near(warm.red, [217, 26, 26], 30) && near(warm.blue, [26, 115, 217], 30),
      warm === null ? '' : `red ${String(warm.red)} blue ${String(warm.blue)}`,
    );

    await choosePaperMode(page, '原始');
    const original = await waitForPaper(page, 1, (sample) =>
      near(sample.paper, [255, 255, 255], 2),
    );
    check(
      'paper: the original mode leaves the page exactly as rendered',
      original !== null &&
        near(original.paper, [255, 255, 255], 1) &&
        near(original.red, [217, 26, 26], 30),
      original === null ? '' : `paper ${String(original.paper)} mean ${original.mean.toFixed(0)}`,
    );

    await choosePaperMode(page, '深灰');
    const dark = await waitForPaper(
      page,
      1,
      (sample) => sample.paperLum < 80 && near(sample.red, RED, 60),
    );
    check(
      'paper: the dark mode changes the sheet itself, not just the shell around it',
      dark !== null && dark.paperLum < 70 && dark.mean < 120,
      dark === null ? '' : `paper ${String(dark.paper)} mean ${dark.mean.toFixed(0)}`,
    );
    check(
      'paper: text becomes light on dark, so it can still be read',
      dark !== null && dark.max > 150,
      dark === null ? '' : `brightest ink ${dark.max.toFixed(0)}`,
    );
    check(
      'paper: the coloured blocks keep their colour in dark mode',
      dark !== null && near(dark.red, [217, 26, 26], 40) && near(dark.blue, [26, 115, 217], 40),
      dark === null ? '' : `red ${String(dark.red)} blue ${String(dark.blue)}`,
    );
    await page.screenshot({ path: fileURLToPath(new URL('01-paper-dark.png', SHOT_DIR)) });

    // A highlight drawn in one mode must sit on the same words in another.
    const selected = await selectForToolbar(
      page,
      1,
      { span: 0, offset: 0 },
      { span: 2, offset: 999 },
    );
    await toolbarOf(page).getByRole('button', { name: '高亮' }).click();
    await page.waitForTimeout(200);
    const highlightBox = async () =>
      unionBox(
        await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '.pdf-page[data-page="1"] .pdf-highlight[data-annotation]',
            ),
          ].map((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
          }),
        ),
      );
    const darkBox = await highlightBox();
    await choosePaperMode(page, '暖纸');
    await page.waitForTimeout(400);
    const warmBox = await highlightBox();
    const stillSelected = await selectSpans(
      page,
      1,
      { span: 0, offset: 0 },
      { span: 2, offset: 999 },
    );
    await page.evaluate(() => {
      window.getSelection()?.removeAllRanges();
    });
    check(
      'paper: a highlight stays on the same words when the paper mode changes',
      selected.boxes.length > 0 &&
        boxDistance(darkBox, warmBox) <= 1 &&
        boxDistance(warmBox, unionBox(stillSelected.boxes)) <= 2,
      `mode to mode ${boxDistance(darkBox, warmBox).toFixed(1)}px, to a fresh selection ${boxDistance(warmBox, unionBox(stillSelected.boxes)).toFixed(1)}px`,
    );

    // The mode is a preference: it must survive a reload.
    await choosePaperMode(page, '深灰');
    await page.waitForTimeout(300);
    await page.reload();
    await reopenReader(page, '沉浸式阅读验收');
    const afterReload = await waitForPaper(
      page,
      1,
      (sample) => sample.paperLum < 80 && near(sample.red, RED, 60),
    );
    check(
      'paper: the chosen mode is still in force after a reload',
      afterReload !== null &&
        afterReload.paperLum < 80 &&
        (await page.locator('.pdf-page[data-page="1"]').getAttribute('data-paper')) === 'dark',
      afterReload === null ? '' : `paper luminance ${afterReload.paperLum.toFixed(0)}`,
    );

    // Follow the app theme again, and check it really follows.
    await choosePaperMode(page, '跟随外观');
    await setAppTheme(page, '浅色');
    const followed = await waitForPaper(
      page,
      1,
      (sample) => sample.paperLum > 200 && near(sample.red, RED, 60),
    );
    check(
      'paper: in follow mode the paper tracks the application theme',
      followed !== null && followed.paperLum > 200,
      followed === null ? '' : `paper luminance ${followed.paperLum.toFixed(0)}`,
    );

    // ---- B. The assistant without a selection ------------------------------
    // The notes panel opens by itself in a wide window; collapse it to see the rail.
    await closeSidePanel(page);
    const rail = page.getByRole('button', { name: '打开 AI 助手' });
    check(
      'assistant: a permanent entrance exists in the reading workspace',
      (await rail.count()) === 1,
    );

    await rail.click();
    const panel = sidePanel(page);
    await panel.waitFor({ timeout: 10_000 });
    check(
      'assistant: it opens without any text being selected',
      (await panel.innerText()).includes('可以直接问这一页的任何问题'),
    );

    await panel.getByRole('button', { name: '这一页讲了什么' }).click();
    await panel.locator('.ai-answer-body').waitFor({ timeout: 20_000 });
    asksSent += 1;
    const pageAsk = requests.ask.at(-1);
    check(
      'assistant: a question about the page sends the page as the primary passage',
      pageAsk?.scope === 'page' &&
        pageAsk?.passages?.length === 1 &&
        pageAsk.passages[0].id === 'page' &&
        pageAsk.passages[0].selection === true &&
        pageAsk.passages[0].page === 1,
      `scope ${String(pageAsk?.scope)} · ${String(pageAsk?.passages?.[0]?.text?.length ?? 0)} chars`,
    );
    // Since 37493ba the reader sends the whole extracted paper when it is ready; what must
    // hold either way is that the panel discloses exactly what the request carries.
    check(
      'assistant: the range disclosure matches what the request carries',
      (pageAsk?.scope === 'document') === (await panel.innerText()).includes('整篇论文') &&
        (pageAsk?.passages?.length ?? 0) >= 1,
      `scope ${String(pageAsk?.scope)}`,
    );
    await page.screenshot({ path: fileURLToPath(new URL('02-page-question.png', SHOT_DIR)) });

    const turnsBefore = await panel.locator('.ai-turn').count();
    await panel.getByRole('button', { name: '关闭 AI 面板' }).click();
    await page.waitForTimeout(200);
    check(
      'assistant: closing the panel leaves a compact entrance, not a blank column',
      (await sidePanel(page).count()) === 0 &&
        (await page.getByRole('button', { name: '打开 AI 助手' }).count()) === 1,
    );
    await page.getByRole('button', { name: '打开 AI 助手' }).click();
    await sidePanel(page).waitFor({ timeout: 5000 });
    check(
      'assistant: the conversation is still there when the panel comes back',
      (await sidePanel(page).locator('.ai-turn').count()) === turnsBefore,
    );

    // A selection still works, through the toolbar.
    const sent = await selectForToolbar(page, 1, { span: 1, offset: 0 }, { span: 2, offset: 999 });
    await toolbarOf(page).getByRole('button', { name: '向这段文字提问' }).click();
    await page.getByRole('group', { name: '向 AI 提问' }).waitFor({ timeout: 5000 });
    await page
      .getByRole('group', { name: '向 AI 提问' })
      .getByRole('button', { name: '解释这段话' })
      .click();
    asksSent += 1;
    await sidePanel(page).locator('.ai-answer-body').last().waitFor({ timeout: 20_000 });
    const selectionAsk = requests.ask.at(-1);
    const collapse = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
    // A selection ask may ride along with the whole paper now, but the selected words are
    // still the passage the answer anchors to.
    check(
      'assistant: asking about a selection sends exactly that selection',
      selectionAsk.passages.find((passage) => passage.selection)?.text !== undefined &&
        collapse(selectionAsk.passages.find((passage) => passage.selection).text) ===
          collapse(sent.text),
      `${String(collapse(sent.text).length)} chars selected`,
    );

    // ---- C. Difficulty suggestions ----------------------------------------
    // The side panel is already open on the assistant; the difficulty tab is beside it.
    const openDifficulty = async () => {
      if ((await sidePanel(page).count()) === 0) {
        await page.getByRole('button', { name: '打开相关知识与难点' }).click();
      } else {
        await page.getByRole('button', { name: /^知识( \d+)?$/ }).click();
      }
      await page.getByRole('complementary', { name: '相关知识' }).waitFor({ timeout: 5000 });
    };
    await openDifficulty();
    const difficulty = page.getByRole('complementary', { name: '相关知识' });
    await difficulty.waitFor({ timeout: 10_000 });
    check(
      'difficulty: the enable screen states what is sent, what it costs and what is covered',
      (await difficulty.innerText()).includes('一次只分析当前页') &&
        (await difficulty.innerText()).includes('不产生任何费用') &&
        (await difficulty.innerText()).includes('缓存'),
    );
    check(
      'difficulty: nothing is analysed before the reader turns it on',
      requests.difficulty.length === 0,
    );

    await difficulty.getByRole('button', { name: '启用难点标注' }).click();
    await difficulty.getByRole('button', { name: '开始分析' }).click();
    await page.locator('.pdf-suggestion').first().waitFor({ timeout: 25_000 });
    const analysisRequest = requests.difficulty.at(-1);
    check(
      'difficulty: enabling analyses one page, and only this page',
      analysisRequest?.paper?.page === 1 &&
        typeof analysisRequest.pageText === 'string' &&
        analysisRequest.pageText.length > 20,
      `${String(analysisRequest?.pageText?.length ?? 0)} chars sent`,
    );

    const markers = await page.locator('.pdf-suggestion').count();
    check(
      'difficulty: suggestions are drawn on the words they quote',
      markers > 0,
      `${String(markers)} markers`,
    );
    check(
      'difficulty: a suggestion whose quotation was not in the text never becomes a marker',
      !(await difficulty.innerText()).includes('一条应该被丢弃'),
    );

    const markerBox = await page.locator('.pdf-suggestion').first().boundingBox();
    await page.locator('.pdf-suggestion').first().click();
    const card = page.getByRole('dialog', { name: /难点：/ });
    await card.waitFor({ timeout: 5000 });
    check(
      'difficulty: clicking a marker shows the short explanation first',
      (await card.innerText()).length > 20 &&
        (await card.innerText()).includes('本地模拟') &&
        markerBox !== null &&
        markerBox.width > 4,
      `${String(Math.round(markerBox?.width ?? 0))}px wide marker`,
    );
    check(
      'difficulty: the card says it is AI output, not the paper',
      (await card.innerText()).includes('不是原文'),
    );
    await page.screenshot({ path: fileURLToPath(new URL('03-difficulty-card.png', SHOT_DIR)) });

    await card.getByRole('button', { name: /深入理解/ }).click();
    await sidePanel(page).locator('.ai-answer-body').last().waitFor({ timeout: 20_000 });
    asksSent += 1;
    const deeperAsk = requests.ask.at(-1);
    const deeperSelection = deeperAsk?.passages?.find((passage) => passage.selection)?.text;
    check(
      'difficulty: going deeper asks about the very passage the suggestion quoted',
      typeof deeperSelection === 'string' && deeperSelection.length > 10,
      `${String(deeperSelection?.length ?? 0)} chars of context`,
    );

    // Dismiss one, then hide them all.
    await openDifficulty();
    const before = await page.locator('.pdf-suggestion').count();
    const firstTitle = await difficulty.locator('.knowledge-difficulty-title').first().innerText();
    await page.locator('.pdf-suggestion').first().click();
    await page
      .getByRole('dialog', { name: /难点：/ })
      .getByRole('button', { name: '忽略' })
      .click();
    await page.waitForTimeout(250);
    check(
      'difficulty: ignoring one suggestion removes just that marker',
      (await page.locator('.pdf-suggestion').count()) < before,
      `${String(before)} → ${String(await page.locator('.pdf-suggestion').count())} markers · ${firstTitle}`,
    );

    await difficulty.getByRole('checkbox', { name: /在页面上显示标记/ }).click();
    await page.waitForTimeout(200);
    check(
      'difficulty: hiding the markers leaves the suggestions and the page intact',
      (await page.locator('.pdf-suggestion').count()) === 0 &&
        (await difficulty.locator('.knowledge-difficulty-item').count()) > 0,
    );
    await page.screenshot({ path: fileURLToPath(new URL('04-markers-hidden.png', SHOT_DIR)) });

    await difficulty.getByRole('checkbox', { name: /在页面上显示标记/ }).click();
    await page.waitForTimeout(200);
    const beforeReloadRequests = requests.difficulty.length;
    const beforeReloadMarkers = await page.locator('.pdf-suggestion').count();
    await page.reload();
    await reopenReader(page, '沉浸式阅读验收');
    await page.waitForTimeout(1500);
    check(
      'difficulty: a cached page is not sent again after a reload',
      requests.difficulty.length === beforeReloadRequests,
      `${String(requests.difficulty.length)} requests in total`,
    );
    check(
      'difficulty: the markers come back from the cache, on the same words',
      (await page.locator('.pdf-suggestion').count()) === beforeReloadMarkers,
      `${String(await page.locator('.pdf-suggestion').count())} markers`,
    );

    // A different file must never inherit the first file's suggestions.
    const firstMarkerId = await page
      .locator('.pdf-suggestion')
      .first()
      .getAttribute('data-suggestion');
    await page.getByRole('button', { name: '返回' }).click();
    const otherFile = fileURLToPath(new URL('injection.pdf', WORK_DIR));
    if (!existsSync(otherFile)) {
      const { buildInjectionPdf } = await import('./sample-pdf.mjs');
      await writeFile(otherFile, buildInjectionPdf());
    }
    await importIntoProject(page, otherFile);
    await page.waitForTimeout(600);
    check(
      'difficulty: a different file never inherits the first file’s markers',
      (await page
        .locator(`.pdf-suggestion[data-suggestion="${String(firstMarkerId)}"]`)
        .count()) === 0,
      `first file's marker ${String(firstMarkerId)} is absent`,
    );

    // ---- D. Reading is unaffected -----------------------------------------
    await reopenReader(page, '沉浸式阅读验收');
    check(
      'regression: the reader still opens after all of this',
      (await page.locator('.pdf-page').count()) > 0,
    );

    check(
      'calls: one assistant request per question, no automatic retries',
      requests.ask.length === asksSent,
      `${String(requests.ask.length)} requests for ${String(asksSent)} questions`,
    );

    const unexpected = consoleIssues.filter(
      (issue) => !/\/api\/ai\/(ask|difficulties|not-a-real-endpoint)/.test(issue.url),
    );
    check(
      'console: nothing failed except requests this run provoked',
      unexpected.length === 0,
      `${String(unexpected.length)} unexpected, ${String(consoleIssues.length)} total`,
    );
    if (unexpected.length > 0) {
      process.stdout.write(`  unexpected: ${unexpected[0].text}\n`);
    }
  } catch (error) {
    process.stdout.write(`\n--- the run stopped here ---\n${String(error)}\n`);
    try {
      process.stdout.write(
        `reader html:\n${(await page.locator('.reader').innerHTML()).slice(0, 1500)}\n`,
      );
      process.stdout.write(
        `console issues:\n${consoleIssues.map((issue) => issue.text).join('\n')}\n`,
      );
    } catch {
      // The page may be gone.
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
        provider: 'mock (offline)',
        providerIdentity: service.health,
        instanceId: service.health.instanceId,
        environment: {
          offlineFlag: true,
          aiProviderEnv: process.env.AI_PROVIDER ?? null,
          deepseekKeyPresent: (process.env.DEEPSEEK_API_KEY ?? '') !== '',
        },
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

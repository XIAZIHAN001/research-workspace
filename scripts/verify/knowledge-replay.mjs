/* global document, window */
import { spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { requireOfflineProxy } from './offline.mjs';
import { createReplayProvider, loadReplayFixtures } from './replay-provider.mjs';
import { selectSpans } from './text-selection.mjs';

/**
 * Phase 8.2 acceptance D: the Phase 8.1 live replies replayed through the real interface.
 *
 * No network request leaves the machine. The service is the real service, the verification is
 * the real verification, and the browser drives the real reading flow; only the "model" is a
 * provider that returns the stored live output for the matching selection.
 *
 * The two fixtures cover: 6 concepts / 10 relations with English technical names and several
 * two-quote relations; 6 concepts / 8 relations with long Chinese names and one rejected
 * quotation. The script also re-runs an analysis to check that no duplicate nodes appear.
 */

const PORT = Number(process.env.AI_VERIFY_PREVIEW_PORT ?? 4182);
const AI_PORT = Number(process.env.AI_VERIFY_PORT ?? 8795);
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const AI_ORIGIN = `http://127.0.0.1:${String(AI_PORT)}`;
const ROOT = new URL('../../', import.meta.url);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = new URL(`docs/screenshots-phase8.2/${RUN_STAMP}-replay/`, ROOT);
const REPORT_FILE = new URL(`docs/screenshots-phase8.2/${RUN_STAMP}-replay/report.json`, ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const PAPER_TS = new URL('.cache/papers/2610.22327.pdf', ROOT);
const PAPER_DLM = new URL('.cache/papers/2610.22294.pdf', ROOT);

const PROJECT = '真实回放验收';
const QUOTE_11 =
  'Time Series Language Models (TSLMs) enable language-based understanding and reasoning over temporal data';
const QUOTE_05 =
  'We propose a dual-tower architecture that combines line plots and normalized delay embeddings within a shared language model';
const QUOTE_12 =
  'Diffusion language models (DLMs) offer a natural interface for these tasks because they are not restricted to next-token prediction and can generate tokens anywhere on the shared canvas';
const REPLAY_LABEL = 'Phase 8.1 真实响应回放（离线，无费用）';

const results = [];
const consoleIssues = [];
const aiRequests = [];
const analysisResponses = [];
const details = {};

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
  page.on('request', (request) => aiRequests.push(request.url()));
  page.on('response', (response) => {
    if (!response.url().includes('/api/ai/knowledge')) return;
    void response
      .json()
      .then((body) => {
        analysisResponses.push({
          status: body.status,
          concepts: body.concepts?.length ?? 0,
          relations: body.relations?.length ?? 0,
          rejected: body.rejected ?? 0,
          rejectedDetails: body.rejectedDetails ?? [],
          diagnostics: body.diagnostics ?? null,
        });
      })
      .catch(() => {});
  });
}

function refuseIfConfiguredForRealProvider() {
  const provider = process.env.AI_PROVIDER ?? '';
  const key = process.env.DEEPSEEK_API_KEY ?? '';
  if (provider !== 'deepseek' && key === '') return;
  process.stderr.write(
    '这个回放套件不调用任何模型，请在没有导出 AI_PROVIDER / DEEPSEEK_API_KEY 的终端里重跑。\n',
  );
  process.exit(4);
}

async function refuseIfPortTaken() {
  try {
    const response = await fetch(`${AI_ORIGIN}/api/ai/health`);
    if (response.ok) {
      process.stderr.write(
        `端口 ${String(AI_PORT)} 上已经有一个 AI 服务在运行，本次回放不会使用它。\n`,
      );
      process.exit(4);
    }
  } catch {
    // Nothing there.
  }
}

async function startReplayService() {
  const { createAiServer } = await import('../../server/index.mjs');
  const { readConfig } = await import('../../server/config.mjs');
  const { createLogger } = await import('../../server/log.mjs');
  const fixtures = await loadReplayFixtures();
  const config = { ...readConfig({}, { forceOffline: true }), port: AI_PORT };
  const { server, health } = createAiServer({
    config,
    provider: createReplayProvider(fixtures),
    log: createLogger({ enabled: false }),
  });
  await new Promise((resolve) => {
    server.listen(AI_PORT, '127.0.0.1', resolve);
  });
  return {
    server,
    health,
    fixtures,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startPreview() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    {
      cwd: fileURLToPath(ROOT),
      env: { ...process.env, AI_PORT: String(AI_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(ORIGIN)).ok) return child;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  child.kill();
  throw new Error(`preview server did not start:\n${output}`);
}

/* ------------------------------------------------------------------ *
 * Interface helpers
 * ------------------------------------------------------------------ */

const toolbarOf = (page) => page.getByRole('toolbar', { name: '批注' });
const panelOf = (page) => page.locator('.knowledge-panel');
const listOf = (page) => page.getByLabel('概念列表');
const detailOf = (page, name) => page.getByRole('region', { name: `概念：${name}` });

async function createProject(page, title) {
  await page.getByLabel('新建项目').click();
  await page.getByLabel('核心论文标题').fill(title);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('heading', { level: 1, name: title }).waitFor();
}

async function importPaper(page, filePath) {
  await page.getByRole('button', { name: '导入新论文' }).click();
  const dialog = page.getByRole('dialog', { name: '导入论文' });
  await dialog.locator('input[type="file"][data-autofocus]').setInputFiles(filePath);
  await dialog.getByRole('button', { name: '导入' }).click();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await page.locator('.reader').count()) > 0) break;
    const duplicate = dialog.getByRole('button', { name: '仍然新建一篇论文' });
    if ((await duplicate.count()) > 0) {
      await duplicate.click();
      break;
    }
    await page.waitForTimeout(200);
  }
  await page.locator('.reader').waitFor({ timeout: 60_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
}

async function toProject(page, name) {
  const back = page.getByRole('button', { name: '返回' });
  if ((await back.count()) > 0) await back.click();
  const expand = page.getByLabel('展开侧栏');
  if ((await expand.count()) > 0) await expand.click();
  await page.getByRole('button', { name }).first().click();
  await page.getByRole('heading', { level: 1, name }).waitFor();
}

async function openPaper(page) {
  if ((await page.locator('.reader').count()) === 0) {
    await page.getByRole('button', { name: '阅读' }).first().click();
  }
  await page.locator('.reader').waitFor({ timeout: 60_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
}

async function gotoPage(page, number) {
  const jump = page.locator('.reader-page-jump input');
  await jump.fill(String(number));
  await jump.press('Enter');
  await page
    .locator(`.pdf-page[data-page="${String(number)}"] .textLayer span`)
    .first()
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(900);
}

/** Selects a verbatim span in the rendered text layer; copied from the Phase 8 verifier. */
async function selectQuote(page, quote, pageNumber) {
  const picked = await page.evaluate(
    ({ needle, pageNumber: number }) => {
      const root = document.querySelector(`.pdf-page[data-page="${String(number)}"]`);
      if (root === null) return { miss: true, noRoot: true, wanted: number };
      const normalize = (text) => text.replace(/\s+/g, ' ').trim();
      const spans = [...root.querySelectorAll('.textLayer span')].filter(
        (span) => span.querySelector('span') === null && (span.textContent ?? '') !== '',
      );
      const segments = spans.map((span) => normalize(span.textContent ?? ''));
      const starts = [];
      let cursor = 0;
      for (const segment of segments) {
        starts.push(cursor);
        cursor += segment.length + 1;
      }
      const haystack = segments.join(' ');
      const target = normalize(needle);
      const at = haystack.indexOf(target);
      if (at < 0) {
        const probe = target.slice(0, 24);
        const near = haystack.indexOf(probe);
        return {
          miss: true,
          length: haystack.length,
          probe,
          near:
            near < 0 ? haystack.slice(0, 240) : haystack.slice(Math.max(0, near - 40), near + 160),
        };
      }
      const touched = [];
      for (let index = 0; index < segments.length; index += 1) {
        const start = starts[index];
        const end = start + segments[index].length;
        if (segments[index] !== '' && start < at + target.length && end > at) touched.push(index);
      }
      if (touched.length === 0) return null;
      const first = touched[0];
      const last = touched[touched.length - 1];
      return { start: first, end: last, endLength: (spans[last]?.textContent ?? '').length };
    },
    { needle: quote, pageNumber },
  );
  if (picked === null) throw new Error('the page has no text layer');
  if (picked.miss === true) {
    throw new Error(
      `the page does not contain the quotation: ${quote.slice(0, 60)}\n${JSON.stringify(picked)}`,
    );
  }
  const selection = await selectSpans(
    page,
    pageNumber,
    { span: picked.start, offset: 0 },
    { span: picked.end, offset: picked.endLength },
  );
  await page.mouse.move(5, 5);
  await page
    .locator(`.pdf-page[data-page="${String(pageNumber)}"]`)
    .first()
    .dispatchEvent('mouseup');
  await toolbarOf(page).waitFor({ timeout: 10_000 });
  return selection?.text ?? '';
}

async function closeKnowledgePanel(page) {
  const close = page.getByRole('button', { name: '关闭相关知识' });
  if ((await close.count()) > 0) await close.click();
}

async function analyze(page, quote, pageNumber) {
  await closeKnowledgePanel(page);
  // Closing the panel can leave the reader mid-layout; make sure the page we are about to
  // select from is rendered again before addressing its spans.
  await gotoPage(page, pageNumber);
  await selectQuote(page, quote, pageNumber);
  await toolbarOf(page).getByRole('button', { name: '查看相关知识' }).click();
  const panel = panelOf(page);
  await panel.waitFor({ timeout: 10_000 });
  await panel.getByRole('button', { name: '分析知识关联' }).click();
  await panel.getByText('发送前确认').waitFor({ timeout: 60_000 });
  await panel.getByRole('button', { name: '开始分析' }).click();
  await panel.locator('.knowledge-results').waitFor({ timeout: 60_000 });
  return panel;
}

async function knowledgeCounts(page) {
  return page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem('rw.knowledge') ?? 'null');
    return {
      concepts: Array.isArray(state?.concepts) ? state.concepts.length : 0,
      relations: Array.isArray(state?.relations) ? state.relations.length : 0,
      evidence: Array.isArray(state?.evidence) ? state.evidence.length : 0,
    };
  });
}

async function main() {
  refuseIfConfiguredForRealProvider();
  await refuseIfPortTaken();
  await mkdir(SHOT_DIR, { recursive: true });

  const service = await startReplayService();
  const preview = await startPreview();
  const server = { kill: () => preview.kill() };
  const probe = await requireOfflineProxy(ORIGIN, {
    expectedInstance: service.health.instanceId,
    label: 'Phase 8.2 回放验收',
    allowedProviders: ['replay'],
  });
  check(
    'offline: the page is served by this run’s replay provider, which reports online=false',
    probe.provider === 'replay' && probe.online === false,
    `${probe.provider} · online=${String(probe.online)}`,
  );

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  watch(page);

  try {
    await page.goto(ORIGIN);
    await createProject(page, PROJECT);
    await importPaper(page, fileURLToPath(PAPER_TS));

    // Seed the two concepts the live 11-boundary-existing request already had, so the replay
    // exercises relation endpoints that belong to the reader rather than to the model.
    const projectId = await page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
      return Array.isArray(state?.projects) ? (state.projects[0]?.id ?? '') : '';
    });
    if (projectId === '') throw new Error('no project id after creating the project');
    await page.evaluate((id) => {
      const knowledge = {
        version: 1,
        concepts: [
          {
            id: 'seed-tslm',
            name: 'Time Series Language Model',
            aliases: ['TSLM', 'TSLMs'],
            summary: '把时间序列作为输入并用语言模型理解与推理的模型。',
            origin: 'user',
            status: 'confirmed',
            projectIds: [id],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'seed-lm',
            name: 'Language Model',
            aliases: ['LM'],
            summary: '在 token 序列上建模并生成输出的模型。',
            origin: 'user',
            status: 'confirmed',
            projectIds: [id],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        relations: [
          {
            id: 'seed-prereq',
            from: 'seed-tslm',
            to: 'seed-lm',
            kind: 'prerequisite',
            status: 'confirmed',
            origin: 'user',
            note: '',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        evidence: [],
      };
      window.localStorage.setItem('rw.knowledge', JSON.stringify(knowledge));
    }, projectId);
    await page.reload();
    await toProject(page, PROJECT);
    await openPaper(page);
    await gotoPage(page, 1);

    // ---- Replay 11: six concepts, ten relations, multi-quote evidence ------
    let panel = await analyze(page, QUOTE_11, 1);
    const header11 = await panel.locator('.knowledge-results-head').innerText();
    details.replay11Header = header11;
    check(
      'replay 11: six concepts and ten relations arrive through the real service',
      header11.includes('6 个概念') && header11.includes('10 条关系'),
      header11,
    );
    check(
      'replay 11: the result is labelled as the offline replay, not as a mock',
      (await panel.getByText(REPLAY_LABEL).count()) === 1 &&
        (await panel.locator('.knowledge-mock-warning').count()) === 0,
    );
    check(
      'replay 11: long English technical names survive',
      (await panel.getByText('Normalized Delay Embedding', { exact: true }).count()) > 0 &&
        (await panel.getByText('Dual-Tower Architecture', { exact: true }).count()) > 0,
    );
    const quoteCounts = await panel
      .locator('.knowledge-suggestion-row')
      .evaluateAll((rows) =>
        rows.map((row) => row.querySelectorAll('.knowledge-evidence-quote').length),
      );
    details.quoteCounts11 = quoteCounts;
    check(
      'replay 11: the quotations that fall inside this run’s context survive',
      Math.max(...quoteCounts, 0) >= 1,
      `max ${String(Math.max(...quoteCounts, 0))} quotes`,
    );
    check(
      'replay 11: quotations outside this run’s context are left out, not given a placeholder id',
      (await panel.locator('.knowledge-rejected').count()) === 0 &&
        (await panel.getByText('__not-sent__').count()) === 0,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('01-replay11-suggestions.png', SHOT_DIR)),
    });

    const conceptBlock = panel
      .locator('.knowledge-suggestion-block')
      .filter({ hasText: '概念建议' })
      .first();
    const relationBlock = panel
      .locator('.knowledge-suggestion-block')
      .filter({ hasText: '关系建议' })
      .first();
    const firstConceptRow = conceptBlock.locator('.knowledge-suggestion-row').first();
    const firstName = (await firstConceptRow.locator('.knowledge-concept-name').innerText()).trim();
    await firstConceptRow.getByRole('button', { name: '确认概念' }).click();
    const firstRelationRow = relationBlock.locator('.knowledge-suggestion-row').first();
    const firstRelationLabel = await firstRelationRow
      .locator('.knowledge-suggestion-direction')
      .innerText();
    await firstRelationRow.getByRole('button', { name: '采纳' }).click();
    await page.waitForTimeout(400);
    check(
      'replay 11: the reader accepted one concept and one relation explicitly',
      (await conceptBlock.getByText('已确认').count()) > 0 &&
        (await relationBlock.getByText('已采纳').count()) > 0,
      `${firstName} · ${firstRelationLabel.replace(/\s+/g, ' ').slice(0, 40)}`,
    );

    // The relation endpoint Time Series Language Model is the seeded concept, not a new node.
    const after11 = await knowledgeCounts(page);
    details.after11 = after11;
    check(
      'replay 11: the existing concept was reused, so only the six proposed concepts were added',
      after11.concepts === 8,
      `${String(after11.concepts)} concepts total`,
    );

    // ---- The rich output in the knowledge view -----------------------------
    await firstConceptRow.getByRole('button', { name: '在知识视图中打开' }).click();
    await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    await listOf(page).locator(`.concept-card[data-concept-name="${firstName}"]`).first().click();
    const detail = detailOf(page, firstName);
    check(
      'replay 11: the accepted relation appears with its support and explanation',
      (await detail.locator('.kb-support-direct').count()) > 0 &&
        (await detail.getByText(/模型解释/).count()) > 0,
    );
    const evidenceInDetail = detail.locator('.evidence-row');
    check(
      'replay 11: the concept detail lists the verified quotations',
      (await evidenceInDetail.count()) >= 1,
      `${String(await evidenceInDetail.count())} occurrence(s)`,
    );

    // Jump to the original and back, keeping the selected concept.
    await evidenceInDetail.first().getByRole('button', { name: '打开原文' }).click();
    await page.locator('.reader').waitFor({ timeout: 60_000 });
    await page.locator('[data-spotlight="true"]').first().waitFor({ timeout: 20_000 });
    check(
      'replay 11: a quotation opens the paper with the quoted words marked',
      (await page.locator('[data-spotlight="true"]').count()) > 0,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('02-replay11-jump.png', SHOT_DIR)),
    });
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    check(
      'replay 11: returning keeps the concept selected',
      (await detailOf(page, firstName).count()) === 1,
    );

    // ---- Dark theme and a narrow window in the knowledge view -------------
    await setAppTheme(page, '深色');
    await page.waitForTimeout(300);
    const darkBox = await page.locator('.knowledge').boundingBox();
    check(
      'layout: the replay result does not overflow in dark mode',
      darkBox !== null && darkBox.width <= 1440,
      `${String(Math.round(darkBox?.width ?? 0))}px wide`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('03-replay11-dark.png', SHOT_DIR)),
    });
    await setAppTheme(page, '浅色');
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(300);
    const narrow = await page.evaluate(() => {
      const element = document.querySelector('.knowledge');
      return element === null
        ? null
        : {
            width: element.getBoundingClientRect().width,
            overflow: element.scrollWidth - element.clientWidth,
          };
    });
    check(
      'layout: the replay result reflows in a narrow window without sideways overflow',
      narrow !== null && narrow.overflow <= 1,
      `${String(Math.round(narrow?.width ?? 0))}px wide, overflow ${String(narrow?.overflow ?? 0)}px`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('04-replay11-narrow.png', SHOT_DIR)),
    });
    await page.setViewportSize({ width: 1440, height: 950 });

    // ---- Replay 05: long Chinese names and a rejected quotation -----------
    await page.getByRole('button', { name: '文献', exact: true }).click();
    await openPaper(page);
    await gotoPage(page, 3);
    panel = await analyze(page, QUOTE_05, 3);
    const header05 = await panel.locator('.knowledge-results-head').innerText();
    details.replay05Header = header05;
    check(
      'replay 05: six concepts and eight relations arrive through the real service',
      header05.includes('6 个概念') && header05.includes('8 条关系'),
      header05,
    );
    check(
      'replay 05: the long Chinese names are shown as the model wrote them',
      (await panel.getByText(/互补表示（complementary representations）/).count()) > 0 &&
        (await panel.getByText(/单主表示局限（single primary representation）/).count()) > 0,
    );
    const after05 = await knowledgeCounts(page);
    const names05 = await page.evaluate(() =>
      (JSON.parse(window.localStorage.getItem('rw.knowledge') ?? 'null')?.concepts ?? []).map(
        (concept) => concept.name,
      ),
    );
    details.reuse05 = { after05, names05 };
    check(
      'replay 05: three concepts matched the existing English ones by alias; only three nodes were added',
      after05.concepts === 11 &&
        names05.includes('Complementary Representations') &&
        !names05.some((name) => name.includes('互补表示')),
      `${String(after05.concepts)} concepts, ${String(names05.length)} names`,
    );
    await panel.locator('.knowledge-rejected summary').click();
    check(
      'replay 05: the invalid quotation is reported as dropped',
      (await panel.locator('.knowledge-rejected').count()) === 1 &&
        (await panel.locator('.knowledge-rejected').innerText()).includes('引文为空、过短或过长'),
    );
    check(
      'replay 05: the dropped quotation never becomes evidence',
      (await panel
        .locator('.knowledge-evidence-quote')
        .evaluateAll(
          (nodes) =>
            nodes.filter((node) => (node.textContent ?? '').replace(/[“”\s]/g, '') === '').length,
        )) === 0,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('05-replay05-rejected.png', SHOT_DIR)),
    });

    // Reject one relation and accept one concept, then re-run the same analysis.
    const relationBlock05 = panel
      .locator('.knowledge-suggestion-block')
      .filter({ hasText: '关系建议' })
      .first();
    const rejectRow = relationBlock05
      .locator('.knowledge-suggestion-row')
      .filter({ hasText: '折线图' })
      .first();
    const beforeReject = await relationBlock05.locator('.knowledge-suggestion-row').count();
    await rejectRow.getByRole('button', { name: '忽略' }).click();
    await page.waitForTimeout(400);
    check(
      'replay 05: ignoring a relation removes that suggestion only',
      (await relationBlock05.locator('.knowledge-suggestion-row').count()) === beforeReject - 1,
    );
    const conceptBlock05 = panel
      .locator('.knowledge-suggestion-block')
      .filter({ hasText: '概念建议' })
      .first();
    await conceptBlock05
      .locator('.knowledge-suggestion-row')
      .first()
      .getByRole('button', { name: '确认概念' })
      .click();
    await page.waitForTimeout(400);

    const beforeRepeat = await knowledgeCounts(page);
    panel = await analyze(page, QUOTE_05, 3);
    const afterRepeat = await knowledgeCounts(page);
    details.repeat = { beforeRepeat, afterRepeat };
    check(
      'repeat: re-running the same reply adds no duplicate concept node',
      afterRepeat.concepts === beforeRepeat.concepts,
      `${String(beforeRepeat.concepts)}→${String(afterRepeat.concepts)} concepts`,
    );
    check(
      'repeat: existing relations are skipped; only the one explicitly ignored may return',
      afterRepeat.relations >= beforeRepeat.relations &&
        afterRepeat.relations - beforeRepeat.relations <= 1,
      `${String(beforeRepeat.relations)}→${String(afterRepeat.relations)} relations`,
    );
    check(
      'repeat: the interface says the duplicates were skipped rather than silently dropped',
      (await panel.locator('.knowledge-skipped').count()) === 1,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('06-replay05-repeat.png', SHOT_DIR)),
    });

    // ---- Replay 12: one relation with two quotations from the selection ----
    await closeKnowledgePanel(page);
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('heading', { level: 1, name: PROJECT }).waitFor();
    await importPaper(page, fileURLToPath(PAPER_DLM));
    await gotoPage(page, 2);
    const panel12 = await analyze(page, QUOTE_12, 2);
    const header12 = await panel12.locator('.knowledge-results-head').innerText();
    details.replay12Header = header12;
    check(
      'replay 12: six concepts and seven relations arrive through the real service',
      header12.includes('6 个概念') && header12.includes('7 条关系'),
      header12,
    );
    const multiRow = panel12
      .locator('.knowledge-suggestion-row')
      .filter({ hasText: 'In-place editing / infilling of masked regions' });
    const multiQuotes = await panel12.locator('.knowledge-suggestion-row').evaluateAll((rows) =>
      rows.map((row) => ({
        text: (row.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
        quotes: row.querySelectorAll('.knowledge-evidence-quote').length,
      })),
    );
    details.quoteCounts12 = multiQuotes;
    check(
      'replay 12: one relation shows two verified quotations from the selection',
      multiQuotes.some((row) => row.quotes >= 2),
      `${String(Math.max(...multiQuotes.map((row) => row.quotes), 0))} quotes on one row`,
    );
    check(
      'replay 12: the multi-evidence relation is the DLM → in-place editing edge',
      (await multiRow.count()) > 0,
    );
    check(
      'replay 12: the relation keeps its support and explanation',
      (await multiRow
        .first()
        .getByText(/模型解释/)
        .count()) === 1,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('07-replay12-multi-evidence.png', SHOT_DIR)),
    });

    check(
      'offline: every browser request went to the preview or the local replay service',
      aiRequests.every((url) => url.startsWith(ORIGIN) || url.startsWith(AI_ORIGIN)),
    );
    check(
      'console: no unexpected errors or warnings',
      consoleIssues.length === 0,
      consoleIssues.map((entry) => entry.text).join(' | '),
    );
  } catch (error) {
    await page
      .screenshot({ path: fileURLToPath(new URL('00-failure.png', SHOT_DIR)) })
      .catch(() => {});
    details.failureText = await page
      .locator('body')
      .innerText()
      .then((text) => text.replace(/\s+/g, ' ').slice(0, 2400))
      .catch(() => '');
    check(
      'run: the replay script finished without an exception',
      false,
      error instanceof Error ? error.message : String(error),
    );
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    server.kill();
    await service.stop().catch(() => {});
  }

  const passed = results.filter((entry) => entry.passed).length;
  const failed = results.length - passed;
  details.aiRequests = aiRequests;
  details.analysisResponses = analysisResponses;
  details.consoleIssues = consoleIssues;
  details.results = results;
  await writeFile(
    fileURLToPath(REPORT_FILE),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), runStamp: RUN_STAMP, passed, failed, details },
      null,
      2,
    ),
    'utf8',
  );
  process.stdout.write(`\n${String(passed)} passed, ${String(failed)} failed.\n`);
  process.stdout.write(`screenshots: ${fileURLToPath(SHOT_DIR)}\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();

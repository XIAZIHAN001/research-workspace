/* global document, window */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { requireOfflineProxy } from './offline.mjs';
import { selectSpans } from './text-selection.mjs';

/**
 * Phase 8 acceptance: knowledge suggestions with evidence, from a real paper to a real backup.
 *
 * Three browser environments, because the requirement is a chain rather than a screen:
 *
 *   A. make a Phase 7-shaped workspace (a project, a real paper, a hand-made concept) and export
 *      it — no Phase 8 fields, no model call;
 *   B. restore that backup in a fresh browser, run the knowledge analysis on the real paper,
 *      accept a concept and a relation, follow the learning path back to the text, add a second
 *      real paper, and export again;
 *   C. restore the new backup in another fresh browser and verify the evidence, support labels,
 *      learning path and jumps survived.
 *
 * The model is the offline mock throughout. Its suggestions are labelled as simulations; the
 * quotations it cites are copied from the real paper's text layer and checked by the service.
 */

const PORT = Number(process.env.AI_VERIFY_PREVIEW_PORT ?? 4180);
const AI_PORT = Number(process.env.AI_VERIFY_PORT ?? 8793);
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const AI_ORIGIN = `http://127.0.0.1:${String(AI_PORT)}`;
const ROOT = new URL('../../', import.meta.url);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = new URL(`docs/screenshots-phase8/${RUN_STAMP}-knowledge-ai/`, ROOT);
const REPORT_FILE = new URL(`docs/screenshots-phase8/${RUN_STAMP}-knowledge-ai/report.json`, ROOT);
const WORK_DIR = new URL('.cache/verify/', ROOT);
const OLD_BACKUP = new URL('.cache/verify/phase8-old-shape.rwbackup', ROOT);
const NEW_BACKUP = new URL('.cache/verify/phase8-new-shape.rwbackup', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SERVER_ENTRY = fileURLToPath(new URL('server/start.mjs', ROOT));
const PAPER_DLM = new URL('.cache/papers/2610.22294.pdf', ROOT);
const PAPER_TS = new URL('.cache/papers/2610.22327.pdf', ROOT);

const PROJECT = '证据约束知识';
const OLD_CONCEPT = '旧备份概念';
const DLM_QUOTE =
  'Diffusion language models (DLMs) offer a natural interface for these tasks because they are not restricted to next-token prediction and can generate tokens anywhere on the shared canvas';
const TS_QUOTE =
  'Time Series Language Models (TSLMs) enable language-based understanding and reasoning over temporal data';

const results = [];
const consoleIssues = [];
const aiRequests = [];
const details = {};

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
}

function watch(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleIssues.push({
        label,
        text: `${message.type()}: ${message.text()}`,
        url: message.location()?.url ?? '',
      });
    }
  });
  page.on('pageerror', (error) => {
    consoleIssues.push({ label, text: `pageerror: ${error.message}`, url: '' });
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/ai/')) aiRequests.push(request.url());
  });
}

function refuseIfConfiguredForRealProvider() {
  const provider = process.env.AI_PROVIDER ?? '';
  const key = process.env.DEEPSEEK_API_KEY ?? '';
  if (provider !== 'deepseek' && key === '') return;
  process.stderr.write(
    '这个验收套件只在离线模式下运行，请在没有导出 AI_PROVIDER / DEEPSEEK_API_KEY 的终端里重跑。\n',
  );
  process.exit(4);
}

async function refuseIfPortTaken() {
  try {
    const response = await fetch(`${AI_ORIGIN}/api/ai/health`);
    if (response.ok) {
      const health = await response.json();
      process.stderr.write(
        `端口 ${String(AI_PORT)} 上已经有一个 AI 服务在运行（provider=${String(health.provider)}），本次验收不会使用它。\n`,
      );
      process.exit(4);
    }
  } catch {
    // Nothing there.
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
          throw new Error('the service on the port is not the offline mock');
        }
        return { child, health };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('the service on')) throw error;
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`the local AI service did not start:\n${output}`);
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

async function openKnowledgeView(page) {
  await page.getByRole('button', { name: '知识', exact: true }).first().click();
  await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
}

async function createConcept(page, name, summary = '') {
  await page.getByRole('button', { name: /新建概念/ }).click();
  await page.getByLabel('概念名称').fill(name);
  if (summary !== '') await page.getByLabel('简短概述').fill(summary);
  await page.getByRole('button', { name: '创建', exact: true }).click();
}

async function openPaper(page) {
  await page.getByRole('button', { name: '阅读' }).first().click();
  await page.locator('.reader').waitFor({ timeout: 60_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
}

const cardOf = (page, name) =>
  page.getByLabel('概念列表').locator(`.concept-card[data-concept-name="${name}"]`).first();
const detailOf = (page, name) => page.getByRole('region', { name: `概念：${name}` });
const toolbarOf = (page) => page.getByRole('toolbar', { name: '批注' });
const panelOf = (page) => page.locator('.knowledge-panel');

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

async function openBackupDialog(page) {
  const expand = page.getByLabel('展开侧栏');
  if ((await expand.count()) > 0) await expand.click();
  await page.getByRole('button', { name: '备份与恢复' }).click();
  const dialog = page.getByRole('dialog', { name: '备份与恢复' });
  await dialog.waitFor({ timeout: 10_000 });
  return dialog;
}

async function exportBackup(page, destination) {
  const dialog = await openBackupDialog(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: '导出备份文件' }).click(),
  ]);
  await download.saveAs(fileURLToPath(destination));
  await dialog.getByRole('button', { name: '关闭' }).click();
}

async function restoreBackup(page, source) {
  const dialog = await openBackupDialog(page);
  await dialog.getByLabel('选择备份文件').setInputFiles(fileURLToPath(source));
  await dialog
    .getByText(/本次会新增|这个备份不能恢复|读取备份时出错/)
    .first()
    .waitFor({ timeout: 60_000 });
  await dialog.getByRole('button', { name: '开始恢复' }).click();
  await dialog.locator('.backup-message.is-success').waitFor({ timeout: 90_000 });
  await dialog.getByRole('button', { name: '重新载入以查看恢复后的内容' }).click();
  await page.waitForTimeout(1500);
}

async function readContainer(source) {
  const bytes = await readFile(fileURLToPath(source));
  const magic = bytes.subarray(0, 8).toString('utf8');
  const headerLength = bytes.readUInt32LE(8);
  const header = JSON.parse(bytes.subarray(16, 16 + headerLength).toString('utf8'));
  return { bytes, header, magic };
}

/* ------------------------------------------------------------------ *
 * Service-level boundary cases
 * ------------------------------------------------------------------ */

const SERVICE_PASSAGE =
  'A KZG commitment relies on a bilinear pairing over an elliptic curve group. The commitment is a single group element.';

async function postKnowledge(focus, overrides = {}) {
  const response = await fetch(`${AI_ORIGIN}/api/ai/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paper: {
        id: 'verify-paper',
        title: 'Verification paper',
        page: 1,
        pdfSha256: 'a'.repeat(64),
      },
      focus,
      scope: 'selection',
      passages: [
        {
          id: 'selection',
          page: 1,
          text: SERVICE_PASSAGE,
          selection: true,
          role: 'selection',
          label: '',
        },
      ],
      existingConcepts: [],
      existingRelations: [],
      ...overrides,
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function runServiceCases() {
  const cases = {};
  for (const [name, trigger] of [
    ['broken', '[[mock:knowledge-broken]]'],
    ['truncated', '[[mock:knowledge-truncated]]'],
    ['empty', '[[mock:knowledge-empty]]'],
    ['badQuote', '[[mock:knowledge-bad-quote]]'],
    ['wrongPage', '[[mock:knowledge-wrong-page]]'],
    ['wrongDirection', '[[mock:knowledge-wrong-direction]]'],
    ['duplicate', '[[mock:knowledge-duplicate]]'],
    ['cycle', '[[mock:knowledge-cycle]]'],
    ['bypass', '[[mock:knowledge-bypass]]'],
    ['invalidKind', '[[mock:knowledge-invalid-kind]]'],
  ]) {
    cases[name] = await postKnowledge(trigger);
  }
  details.serviceCases = Object.fromEntries(
    Object.entries(cases).map(([name, value]) => [
      name,
      {
        status: value.status,
        output: value.body.status,
        online: value.body.online,
        concepts: value.body.concepts?.length ?? 0,
        relations: value.body.relations?.length ?? 0,
        rejected: value.body.rejected ?? 0,
        codes: (value.body.rejectedDetails ?? []).map((entry) => entry.code),
        countsDescribed: value.body.diagnostics ?? null,
      },
    ]),
  );

  check(
    'service: every boundary case is answered by the offline mock',
    Object.values(cases).every(
      (entry) =>
        entry.status === 200 && entry.body.provider === 'mock' && entry.body.online === false,
    ),
  );
  check(
    'service: broken JSON is reported as malformed, with no suggestions',
    cases.broken.body.status === 'malformed' && cases.broken.body.concepts.length === 0,
  );
  check(
    'service: a truncated reply is reported as incomplete',
    cases.truncated.body.status === 'incomplete',
  );
  check(
    'service: an empty reply is valid but groundedInText is false',
    cases.empty.body.status === 'valid' && cases.empty.body.groundedInText === false,
  );
  check(
    'service: a quotation absent from the paper is rejected',
    cases.badQuote.body.rejected > 0 &&
      cases.badQuote.body.concepts.every((entry) => entry.evidence.length === 0),
  );
  check(
    'service: a contradictory page number is rejected',
    cases.wrongPage.body.diagnostics.pageMismatches > 0,
  );
  check(
    'service: a relation direction that contradicts its kind is rejected',
    cases.wrongDirection.body.rejectedDetails.some((entry) => entry.code === 'relation-direction'),
  );
  check(
    'service: repeated concepts and relations are deduplicated',
    cases.duplicate.body.concepts.length === 2 && cases.duplicate.body.relations.length === 1,
  );
  check(
    'service: a prerequisite loop is rejected',
    cases.cycle.body.rejectedDetails.some((entry) => entry.code === 'relation-cycle'),
  );
  check(
    'service: model-supplied status, ids and identifiers are ignored',
    cases.bypass.body.diagnostics.ignoredProvenanceFields > 0 &&
      cases.bypass.body.diagnostics.ignoredIdentityFields > 0 &&
      cases.bypass.body.concepts.every((entry) => entry.status === undefined),
  );
  check(
    'service: an unknown relation kind is rejected',
    cases.invalidKind.body.rejectedDetails.some((entry) => entry.code === 'relation-kind'),
  );
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  refuseIfConfiguredForRealProvider();
  await refuseIfPortTaken();
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });

  const service = await startService();
  const server = await startPreview();
  await requireOfflineProxy(ORIGIN, {
    expectedInstance: service.health.instanceId,
    label: '证据约束知识验收',
  });
  details.service = {
    provider: service.health.provider,
    instanceId: service.health.instanceId,
    online: service.health.online,
    limits: service.health.limits,
  };

  await runServiceCases();

  const browser = await launchBrowser();
  let contextA;
  let contextB;
  let contextC;
  try {
    /* -------- Environment A: a Phase 7-shaped workspace ------------------ */
    contextA = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const pageA = await contextA.newPage();
    watch(pageA, 'A');
    await pageA.goto(ORIGIN);
    await createProject(pageA, PROJECT);
    await importPaper(pageA, fileURLToPath(PAPER_DLM));
    await toProject(pageA, PROJECT);
    await openKnowledgeView(pageA);
    await createConcept(pageA, OLD_CONCEPT, '这份数据写在 Phase 8 之前，用来验证旧备份。');
    await pageA.screenshot({
      path: fileURLToPath(new URL('01-old-workspace.png', SHOT_DIR)),
    });

    const beforeOldExport = aiRequests.length;
    await exportBackup(pageA, OLD_BACKUP);
    const oldContainer = await readContainer(OLD_BACKUP);
    const oldKnowledge = JSON.stringify(oldContainer.header.data.knowledge);
    check(
      'old backup: it is a Phase 7-shaped file with no Phase 8 fields',
      oldContainer.magic === 'RWBACKUP' &&
        oldContainer.header.formatVersion === 1 &&
        !oldKnowledge.includes('"support"') &&
        !oldKnowledge.includes('"relationId"') &&
        !oldKnowledge.includes('"verification"'),
    );
    check(
      'old backup: it carries the project, paper and hand-made concept',
      oldContainer.header.counts.projects === 1 &&
        oldContainer.header.counts.papers >= 1 &&
        oldContainer.header.counts.concepts === 1 &&
        oldContainer.header.files.length === 1,
      JSON.stringify(oldContainer.header.counts),
    );
    check('old backup: making it did not call any model', aiRequests.length === beforeOldExport);
    await contextA.close();
    contextA = undefined;

    /* -------- Environment B: restore old, analyse, export new ------------ */
    contextB = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await contextB.newPage();
    watch(page, 'B');
    await page.goto(ORIGIN);
    await restoreBackup(page, OLD_BACKUP);
    await page.getByRole('button', { name: PROJECT }).first().waitFor({ timeout: 30_000 });
    const restoredOld = await page.evaluate(() => ({
      projects: window.localStorage.getItem('rw.projects'),
      knowledge: window.localStorage.getItem('rw.knowledge'),
    }));
    check(
      'restore old: the Phase 7 workspace opens in the Phase 8 build',
      restoredOld.projects !== null && restoredOld.knowledge?.includes(OLD_CONCEPT) === true,
    );
    check(
      'restore old: no AI call happened during the restore',
      aiRequests.every((url) => !url.includes('/knowledge')),
    );

    await toProject(page, PROJECT);
    await openPaper(page);
    await gotoPage(page, 2);
    const selectedDlm = await selectQuote(page, DLM_QUOTE, 2);
    check(
      'real paper: the quotation was selected from the rendered page',
      selectedDlm.length > 80,
      `${String(selectedDlm.length)} characters`,
    );
    await toolbarOf(page).getByRole('button', { name: '查看相关知识' }).click();
    const panel = panelOf(page);
    await panel.waitFor({ timeout: 10_000 });
    check(
      'local panel: it opens without a model call',
      (await panel.getByText('本地已有知识').count()) === 1 &&
        !aiRequests.some((url) => url.includes('/knowledge')),
    );
    check(
      'local panel: it says when nothing local is related yet',
      (await panel.getByText(/还没有与这段文字直接相关的概念/).count()) === 1,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('02-local-knowledge-panel.png', SHOT_DIR)),
    });

    const knowledgeBefore = aiRequests.filter((url) => url.includes('/knowledge')).length;
    await panel.getByRole('button', { name: '分析知识关联' }).click();
    await panel.getByText('发送前确认').waitFor({ timeout: 60_000 });
    const planSummary = await panel.locator('.knowledge-plan-summary').innerText();
    const planRows = await panel.locator('.knowledge-plan-list li').count();
    const planCost = await panel.locator('.knowledge-plan-cost').innerText();
    details.plan = { summary: planSummary, rows: planRows, cost: planCost };
    check(
      'context plan: it names the pages, segments and characters before sending',
      planSummary.includes('使用第') &&
        planSummary.includes('段') &&
        planSummary.includes('字') &&
        planRows > 0,
      planSummary,
    );
    check(
      'context plan: it says the mock is offline and free',
      planCost.includes('不会发起在线调用') && planCost.includes('不产生费用'),
    );
    check(
      'context plan: building it made no model call',
      aiRequests.filter((url) => url.includes('/knowledge')).length === knowledgeBefore,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('03-context-plan.png', SHOT_DIR)),
    });

    await panel.getByRole('button', { name: '开始分析' }).click();
    await panel.locator('.knowledge-results').waitFor({ timeout: 60_000 });
    const knowledgeAfter = aiRequests.filter((url) => url.includes('/knowledge')).length;
    check(
      'explicit analysis: exactly one knowledge request was made after the second click',
      knowledgeAfter === knowledgeBefore + 1,
      `${String(knowledgeAfter - knowledgeBefore)} request(s)`,
    );
    check(
      'explicit analysis: no question or difficulty request was made',
      aiRequests.every((url) => !url.includes('/ask') && !url.includes('/difficulties')),
    );
    check(
      'mock boundary: the result is labelled as a simulation',
      (await panel.getByText(/本地模拟（mock provider）/).count()) === 1,
    );
    check(
      'support: the reply shows direct, inferred and external classifications',
      (await panel.locator('.kb-support-direct').count()) > 0 &&
        (await panel.locator('.kb-support-inferred').count()) > 0 &&
        (await panel.locator('.kb-support-external').count()) > 0,
    );
    check(
      'evidence: the suggestions carry quotations from the real page',
      (await panel.locator('.knowledge-evidence-quote').count()) > 0,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('04-knowledge-suggestions.png', SHOT_DIR)),
    });

    const conceptBlock = panel
      .locator('.knowledge-suggestion-block')
      .filter({ hasText: '概念建议' })
      .first();
    const relationBlock = panel
      .locator('.knowledge-suggestion-block')
      .filter({ hasText: '关系建议' })
      .first();
    const conceptARow = conceptBlock
      .locator('.knowledge-suggestion-row')
      .filter({ hasText: '模拟概念 A' })
      .first();
    await conceptARow.getByRole('button', { name: '确认概念' }).click();
    await page.waitForTimeout(400);
    const prerequisiteRow = relationBlock
      .locator('.knowledge-suggestion-row[data-kind="prerequisite"]')
      .filter({ hasText: '模拟概念 A' })
      .first();
    await prerequisiteRow.getByRole('button', { name: '采纳' }).click();
    await page.waitForTimeout(400);
    check(
      'confirmation: the reader accepted a concept and a relation',
      (await conceptBlock.getByText('已确认').count()) > 0 &&
        (await relationBlock.getByText('已采纳').count()) > 0,
    );

    const relatedRow = relationBlock
      .locator('.knowledge-suggestion-row[data-kind="related"]')
      .first();
    await relatedRow.getByLabel('改为哪种关系').selectOption({ label: '扩展' });
    await page.waitForTimeout(400);
    check(
      'manual type: changing a suggested relation keeps it visible as 扩展',
      (await relationBlock.locator('.knowledge-suggestion-row[data-kind="extends"]').count()) === 1,
    );
    await relationBlock
      .locator('.knowledge-suggestion-row[data-kind="extends"]')
      .first()
      .getByRole('button', { name: '忽略' })
      .click();
    await page.waitForTimeout(400);
    check(
      'rejection: the ignored relation is gone',
      (await relationBlock.locator('.knowledge-suggestion-row[data-kind="extends"]').count()) === 0,
    );

    const localA = panel.locator('.knowledge-concept').filter({ hasText: '模拟概念 A' }).first();
    check(
      'learning path: the panel shows the accepted prerequisite order',
      (await localA.locator('.knowledge-path').count()) === 1 &&
        (await localA.locator('.knowledge-path').innerText()).includes('模拟概念 B'),
    );
    await page.screenshot({
      path: fileURLToPath(new URL('05-accepted-learning-path.png', SHOT_DIR)),
    });

    await localA.getByRole('button', { name: '在知识视图中打开' }).click();
    await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    await cardOf(page, '模拟概念 A').waitFor();
    await cardOf(page, '模拟概念 A').click();
    const detailA = detailOf(page, '模拟概念 A');
    check(
      'knowledge view: the confirmed relation is part of the concept detail',
      (await detailA.getByText('前置知识').count()) > 0 &&
        (await detailA.locator('.learning-path li').count()) >= 2,
    );
    check(
      'knowledge view: the AI relation shows its support and explanation',
      (await detailA.locator('.kb-support-direct').count()) > 0 &&
        (await detailA.getByText(/模型解释/).count()) > 0,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('06-knowledge-view-path.png', SHOT_DIR)),
    });

    // ---- A second real paper, into the same project -----------------------
    await page.getByRole('button', { name: '文献', exact: true }).click();
    await importPaper(page, fileURLToPath(PAPER_TS));
    await gotoPage(page, 1);
    const selectedTs = await selectQuote(page, TS_QUOTE, 1);
    check(
      'second paper: its quotation was selected from its own rendered page',
      selectedTs.length > 60,
      `${String(selectedTs.length)} characters`,
    );
    await toolbarOf(page).getByRole('button', { name: '查看相关知识' }).click();
    await panel.waitFor();
    await panel.getByRole('button', { name: '分析知识关联' }).click();
    await panel.getByText('发送前确认').waitFor({ timeout: 60_000 });
    await panel.getByRole('button', { name: '开始分析' }).click();
    await panel.locator('.knowledge-results').waitFor({ timeout: 60_000 });
    check(
      'cross-paper: the existing concept receives a new occurrence instead of a duplicate',
      (await panel.getByText('已有概念的新出处').count()) === 1 &&
        (await panel
          .locator('.knowledge-suggestion-row')
          .filter({ hasText: '模拟概念 A' })
          .count()) > 0,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('07-cross-paper-evidence.png', SHOT_DIR)),
    });

    const existingBlock = panel
      .locator('.knowledge-suggestion-block')
      .filter({ hasText: '已有概念的新出处' })
      .first();
    await existingBlock
      .locator('.knowledge-suggestion-row')
      .filter({ hasText: '模拟概念 A' })
      .first()
      .getByRole('button', { name: '在知识视图中打开' })
      .click();
    await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    const detailAgain = detailOf(page, '模拟概念 A');
    const paperTitles = await page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
      return Object.values(state?.papers ?? {}).map((entry) => entry.title);
    });
    const tsTitle = paperTitles.find((title) => /time-series|time series/i.test(title)) ?? '';
    check(
      'cross-paper: the concept lists both papers and both occurrences',
      (await detailAgain.locator('.evidence-row').count()) >= 2 &&
        (await detailAgain.getByText(/涉及论文/).count()) === 1,
      `${String(paperTitles.length)} paper(s) in the workspace`,
    );
    const tsEvidence = detailAgain.locator('.evidence-row').filter({ hasText: tsTitle }).first();
    await tsEvidence.getByRole('button', { name: '打开原文' }).click();
    await page.locator('.reader').waitFor({ timeout: 60_000 });
    await page
      .locator('.pdf-page[data-page="1"] [data-spotlight="true"]')
      .first()
      .waitFor({ timeout: 20_000 });
    check(
      'cross-paper jump: the evidence opens the other paper and marks the quoted text',
      (await page.locator('.pdf-page[data-page="1"] [data-spotlight="true"]').count()) > 0,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('08-jump-to-second-paper.png', SHOT_DIR)),
    });
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    check(
      'return: the knowledge view keeps the selected concept',
      (await detailOf(page, '模拟概念 A').count()) === 1,
    );

    // ---- Export the Phase 8 workspace ------------------------------------
    await exportBackup(page, NEW_BACKUP);
    const newContainer = await readContainer(NEW_BACKUP);
    const newKnowledge = JSON.stringify(newContainer.header.data.knowledge);
    details.newBackupCounts = newContainer.header.counts;
    check(
      'new backup: concepts, relations and evidence travel together',
      newContainer.header.counts.projects === 1 &&
        newContainer.header.counts.papers >= 2 &&
        newContainer.header.counts.concepts === 3 &&
        newContainer.header.counts.relations >= 1 &&
        newContainer.header.counts.evidence >= 2,
      JSON.stringify(newContainer.header.counts),
    );
    check(
      'new backup: Phase 8 support, explanation and evidence links are present',
      newKnowledge.includes('"support"') &&
        newKnowledge.includes('"rationale"') &&
        newKnowledge.includes('"relationId"') &&
        newKnowledge.includes('"verification"'),
    );
    check(
      'new backup: the format version stayed readable',
      newContainer.header.formatVersion === 1 && newContainer.header.app.knowledgeVersion === 2,
    );
    await contextB.close();
    contextB = undefined;

    /* -------- Environment C: fresh restore of the new backup ------------- */
    contextC = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const pageC = await contextC.newPage();
    watch(pageC, 'C');
    await pageC.goto(ORIGIN);
    await restoreBackup(pageC, NEW_BACKUP);
    await pageC.getByRole('button', { name: PROJECT }).first().waitFor({ timeout: 30_000 });
    const restoredNew = await pageC.evaluate(() => ({
      knowledge: JSON.parse(window.localStorage.getItem('rw.knowledge') ?? 'null'),
    }));
    const restoredRelations = restoredNew.knowledge?.relations ?? [];
    const confirmed = restoredRelations.find(
      (entry) => entry.status === 'confirmed' && entry.origin === 'ai',
    );
    check(
      'restore new: the confirmed AI relation survives with its support and explanation',
      confirmed?.support === 'direct' &&
        typeof confirmed?.rationale === 'string' &&
        confirmed.rationale.length > 0,
    );
    check(
      'restore new: its evidence link survives',
      restoredNew.knowledge?.evidence?.some(
        (entry) => entry.relationId === confirmed?.id && entry.verification !== undefined,
      ) === true,
    );

    await toProject(pageC, PROJECT);
    await openKnowledgeView(pageC);
    await cardOf(pageC, '模拟概念 A').click();
    const detailC = detailOf(pageC, '模拟概念 A');
    check(
      'restore new: the learning path is still navigable',
      (await detailC.locator('.learning-path li').count()) >= 2,
    );
    check(
      'restore new: both papers and occurrences are still listed',
      (await detailC.locator('.evidence-row').count()) >= 2,
    );
    const tsEvidenceC = detailC.locator('.evidence-row').filter({ hasText: tsTitle }).first();
    await tsEvidenceC.getByRole('button', { name: '打开原文' }).click();
    await pageC.locator('.reader').waitFor({ timeout: 60_000 });
    await pageC
      .locator('.pdf-page[data-page="1"] [data-spotlight="true"]')
      .first()
      .waitFor({ timeout: 20_000 });
    check(
      'restore new: evidence from the second paper still jumps to its text',
      (await pageC.locator('[data-spotlight="true"]').count()) > 0,
    );
    await pageC.screenshot({
      path: fileURLToPath(new URL('09-restored-phase8-workspace.png', SHOT_DIR)),
    });

    check(
      'offline: every browser request went to the offline mock',
      aiRequests.every((url) => url.startsWith(ORIGIN) || url.startsWith(AI_ORIGIN)),
    );
    check(
      'console: no unexpected errors or warnings',
      consoleIssues.length === 0,
      consoleIssues.map((entry) => entry.text).join(' | '),
    );
  } catch (error) {
    check(
      'run: the acceptance script finished without an exception',
      false,
      error instanceof Error ? error.message : String(error),
    );
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  } finally {
    await contextA?.close().catch(() => {});
    await contextB?.close().catch(() => {});
    await contextC?.close().catch(() => {});
    await browser.close().catch(() => {});
    server.kill();
    service.child.kill();
  }

  const passed = results.filter((entry) => entry.passed).length;
  const failed = results.length - passed;
  details.aiRequests = aiRequests;
  details.consoleIssues = consoleIssues;
  details.results = results;
  await writeFile(
    fileURLToPath(REPORT_FILE),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runStamp: RUN_STAMP,
        passed,
        failed,
        details,
      },
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

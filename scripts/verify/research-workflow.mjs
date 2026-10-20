/* global document, window, HTMLInputElement */
import { spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { requireOfflineProxy } from './offline.mjs';
import { selectSpans } from './text-selection.mjs';

/**
 * Phase 9 acceptance C/D: a real research project, end to end.
 *
 * Two CC BY papers already used in earlier phases: a DLM paper and a time-series paper. The
 * reader creates real annotations (a highlight, a question, an insight), builds manual concepts
 * and dependencies from those quotations, reuses one concept across both papers, jumps from the
 * knowledge view back to the exact text, runs the offline mock analysis, rejects a suggestion,
 * re-runs it, undoes the rejection, accepts a relation, rejects another, exports a backup,
 * restores it in a fresh browser, and keeps reading.
 *
 * The mock suggestions are labelled as mock throughout. Manual relations are the reader's own
 * and are never described as model output.
 */

const PORT = Number(process.env.AI_VERIFY_PREVIEW_PORT ?? 4184);
const AI_PORT = Number(process.env.AI_VERIFY_PORT ?? 8797);
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const AI_ORIGIN = `http://127.0.0.1:${String(AI_PORT)}`;
const ROOT = new URL('../../', import.meta.url);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = new URL(`docs/screenshots-phase9/${RUN_STAMP}-research-workflow/`, ROOT);
const REPORT_FILE = new URL(
  `docs/screenshots-phase9/${RUN_STAMP}-research-workflow/report.json`,
  ROOT,
);
const WORK_DIR = new URL('.cache/verify/', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SERVER_ENTRY = fileURLToPath(new URL('server/start.mjs', ROOT));
const PAPER_DLM = new URL('.cache/papers/2610.22294.pdf', ROOT);
const PAPER_TS = new URL('.cache/papers/2610.22327.pdf', ROOT);
const BACKUP = new URL('phase9-research-workflow.rwbackup', WORK_DIR);

const PROJECT = 'Phase 9 真实精读';

const Q_DEFINITION = 'We consider a partially observed canvas';
const Q_FORMULA = 'We model joint generation of output lengths and contents';
const Q_HIGHLIGHT =
  'Common strategies select positions by prediction confidence or a prescribed order';
const Q_DLM_LANGUAGE_MODEL =
  'We therefore introduce multi-target few-shot prompting with diffusion language models';
const Q_TS_LANGUAGE_MODEL =
  'We propose a dual-tower architecture that combines line plots and normalized delay embeddings within a shared language model.';
const Q_AI_SELECTION =
  'The task is to fill these regions while preserving the visible content of the canvas.';

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
  page.on('request', (request) => aiRequests.push({ label, url: request.url() }));
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
      process.stderr.write(
        `端口 ${String(AI_PORT)} 上已经有一个 AI 服务在运行，本次验收不会使用它。\n`,
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

const toolbarOf = (page) => page.getByRole('toolbar', { name: '批注' });
const panelOf = (page) => page.locator('.knowledge-panel');
const detailOf = (page, name) => page.getByRole('region', { name: `概念：${name}` });
const listOf = (page) => page.getByLabel('概念列表');

async function closeNotes(page) {
  const close = page.getByRole('button', { name: '收起笔记' });
  if ((await close.count()) > 0) await close.click();
}

async function closeKnowledgePanel(page) {
  const close = page.getByRole('button', { name: '关闭相关知识' });
  if ((await close.count()) > 0) await close.click();
}

async function createProject(page, title) {
  await page.getByLabel('新建项目').click();
  await page.getByLabel('核心论文标题').fill(title);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('heading', { level: 1, name: title }).waitFor();
}

async function importIntoCore(page, filePath) {
  const core = page.locator('.project-section').filter({ hasText: '核心论文' }).first();
  await core.getByRole('button', { name: '导入 PDF' }).click();
  await finishImport(page, filePath);
}

async function importRelated(page, filePath) {
  await page.getByRole('button', { name: '导入新论文' }).click();
  await finishImport(page, filePath);
}

async function finishImport(page, filePath) {
  const dialog = page.getByRole('dialog', { name: /导入论文|导入 PDF 文件/ });
  await dialog.locator('input[type="file"]').setInputFiles(filePath);
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
  await page.waitForFunction(
    () => {
      const layer = document.querySelector('.pdf-page[data-page="1"] .textLayer');
      return layer !== null && (layer.textContent ?? '').trim().length > 800;
    },
    { timeout: 60_000 },
  );
  await page.waitForTimeout(600);
}

async function toProject(page) {
  const back = page.getByRole('button', { name: '返回' });
  if ((await back.count()) > 0) await back.click();
  const literature = page.getByRole('button', { name: '文献', exact: true });
  if ((await literature.count()) > 0) await literature.click();
  const expand = page.getByLabel('展开侧栏');
  if ((await expand.count()) > 0) await expand.click();
  await page.getByRole('button', { name: PROJECT }).first().click();
  await page.getByRole('heading', { level: 1, name: PROJECT }).waitFor();
}

async function openCorePaper(page) {
  if ((await page.locator('.reader').count()) === 0) {
    await page.getByRole('button', { name: '阅读' }).first().click();
  }
  await page.locator('.reader').waitFor({ timeout: 60_000 });
  // The reader restores the last page it was on; that page may not be page 1.
  await page.locator('.pdf-page .textLayer span').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(700);
}

async function gotoPage(page, number) {
  const jump = page.locator('.reader-page-jump input');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await jump.fill(String(number));
    await jump.press('Enter');
    try {
      await page.waitForFunction(
        (target) => {
          const input = document.querySelector('.reader-page-jump input');
          const layer = document.querySelector(
            `.pdf-page[data-page="${String(target)}"] .textLayer`,
          );
          return (
            input instanceof HTMLInputElement &&
            input.value === String(target) &&
            layer !== null &&
            (layer.textContent ?? '').trim().length > 800
          );
        },
        number,
        { timeout: 8000 },
      );
      await page.waitForTimeout(500);
      return;
    } catch {
      // The reader can clamp a jump while page heights are still being measured; ask again.
      await page.waitForTimeout(500);
    }
  }
  throw new Error(`the reader did not settle on page ${String(number)}`);
}

/** Selects a verbatim span in the rendered text layer; copied from the Phase 8 verifier. */
async function selectQuote(page, quote, pageNumber) {
  let picked = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    picked = await page.evaluate(
      ({ needle, pageNumber: number }) => {
        const root = document.querySelector(`.pdf-page[data-page="${String(number)}"]`);
        if (root === null) return { miss: true, noRoot: true };
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
              near < 0
                ? haystack.slice(0, 240)
                : haystack.slice(Math.max(0, near - 60), near + 220),
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
    if (picked !== null && picked.miss !== true) break;
    await sleep(250);
  }
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
  return selection?.text ?? '';
}

async function ensureSelectionToolbar(page, quote, pageNumber) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await selectQuote(page, quote, pageNumber);
    // A late text-layer re-render can clear the selection right after it appears. Check and
    // select again rather than letting the next click time out on a toolbar that has gone.
    await page.waitForTimeout(400);
    if ((await toolbarOf(page).count()) > 0) return;
    await page.waitForTimeout(500);
  }
  throw new Error('the annotation toolbar did not appear after four selections');
}

async function addHighlight(page, quote, pageNumber) {
  await closeNotes(page);
  await ensureSelectionToolbar(page, quote, pageNumber);
  await toolbarOf(page).getByRole('button', { name: '高亮' }).click();
  await page.waitForTimeout(400);
}

async function annotationCount(page) {
  return page.evaluate(() => {
    const state = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
    return Array.isArray(state?.annotations) ? state.annotations.length : 0;
  });
}

async function addNote(page, quote, pageNumber, kind, note) {
  await closeNotes(page);
  const before = await annotationCount(page);
  await ensureSelectionToolbar(page, quote, pageNumber);
  await toolbarOf(page).getByRole('button', { name: '笔记' }).click();
  if (kind !== '记录') await toolbarOf(page).getByRole('button', { name: kind }).click();
  await toolbarOf(page).getByLabel('笔记内容').fill(note);
  await toolbarOf(page).getByRole('button', { name: '保存' }).click();
  await page.waitForFunction(
    (previous) => {
      const state = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
      return Array.isArray(state?.annotations) && state.annotations.length > previous;
    },
    before,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(400);
}

async function openKnowledge(page) {
  await page.getByRole('button', { name: '知识', exact: true }).first().click();
  await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
}

async function createConcept(page, name, summary = '') {
  await page.getByRole('button', { name: /新建概念/ }).click();
  await page.getByLabel('概念名称').fill(name);
  if (summary !== '') await page.getByLabel('简短概述').fill(summary);
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await detailOf(page, name).waitFor({ timeout: 5000 });
}

async function attachEvidence(page, conceptName, quoteFragment) {
  const detail = detailOf(page, conceptName);
  const toggle = detail.getByRole('button', { name: /从笔记里添加出处/ });
  if ((await detail.locator('.evidence-picker').count()) === 0) await toggle.click();
  const row = detail.locator('.evidence-picker li').filter({ hasText: quoteFragment }).first();
  await row.getByRole('button', { name: '添加' }).click();
  await page.waitForTimeout(300);
}

async function addRelation(page, conceptName, kindLabel, targetLabel) {
  const detail = detailOf(page, conceptName);
  await detail.getByLabel('关系类型').selectOption({ label: kindLabel });
  await detail.getByLabel('关系对象').selectOption({ label: targetLabel });
  await detail.getByRole('button', { name: '添加关系' }).click();
  await page.waitForTimeout(300);
}

async function startAnalysisAndWait(page, panel) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes('/api/ai/knowledge') && candidate.request().method() === 'POST',
    { timeout: 60_000 },
  );
  await panel.getByRole('button', { name: '开始分析' }).click();
  await response;
  await panel.locator('.knowledge-results').waitFor({ timeout: 60_000 });
  // The old results stay mounted while the new request runs; wait for the new render to settle.
  await page.waitForTimeout(600);
}

async function runMockAnalysis(page, quote, pageNumber) {
  await closeNotes(page);
  await closeKnowledgePanel(page);
  await gotoPage(page, pageNumber);
  await ensureSelectionToolbar(page, quote, pageNumber);
  await toolbarOf(page).getByRole('button', { name: '查看相关知识' }).click();
  const panel = panelOf(page);
  await panel.waitFor({ timeout: 10_000 });
  await panel.getByRole('button', { name: '分析知识关联' }).click();
  await panel.getByText('发送前确认').waitFor({ timeout: 60_000 });
  await startAnalysisAndWait(page, panel);
  return panel;
}

async function rerunMockAnalysis(page, panel) {
  await panel.getByRole('button', { name: '重新分析' }).click();
  await panel.getByText('发送前确认').waitFor({ timeout: 60_000 });
  await startAnalysisAndWait(page, panel);
}

async function knowledgePayload(page) {
  return page.evaluate(() => JSON.parse(window.localStorage.getItem('rw.knowledge') ?? 'null'));
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

async function main() {
  refuseIfConfiguredForRealProvider();
  await refuseIfPortTaken();
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(fileURLToPath(WORK_DIR), { recursive: true });

  const service = await startService();
  const preview = await startPreview();
  await requireOfflineProxy(ORIGIN, {
    expectedInstance: service.health.instanceId,
    label: 'Phase 9 真实科研工作流',
  });

  const browser = await launchBrowser();
  let contextA;
  let contextB;
  try {
    contextA = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await contextA.newPage();
    watch(page, 'A');

    await page.goto(ORIGIN);
    await createProject(page, PROJECT);
    await importIntoCore(page, fileURLToPath(PAPER_DLM));
    const corePdf = await page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
      const papers = Object.values(state?.papers ?? {});
      return papers.find((paper) => paper.pdf !== undefined)?.pdf ?? null;
    });
    check(
      'setup: the core paper is a real multi-page PDF, not a placeholder',
      corePdf !== null && corePdf.pageCount > 1 && corePdf.bytes > 1000,
      corePdf === null
        ? 'no PDF'
        : `${String(corePdf.pageCount)} pages, ${String(corePdf.bytes)} bytes`,
    );

    // ---- Read the technical definition and formula --------------------------
    await gotoPage(page, 4);
    await addHighlight(page, Q_HIGHLIGHT, 4);
    await addNote(
      page,
      Q_DEFINITION,
      4,
      '疑问',
      '这里的 shared canvas 与普通上下文窗口有什么本质区别？',
    );
    await gotoPage(page, 5);
    await addNote(
      page,
      Q_FORMULA,
      5,
      '理解',
      '长度向量先决定每个目标要生成多少 token，再把占位符展开成 mask；长度和内容是一起建模的。',
    );
    await gotoPage(page, 1);
    await addNote(
      page,
      Q_DLM_LANGUAGE_MODEL,
      1,
      '理解',
      'DLM 属于语言模型的一种，但它用扩散式掩码填充而不是从左到右生成。',
    );
    const annotationsAfterDlm = await page.evaluate(() => {
      const projects = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
      return projects?.annotations?.length ?? 0;
    });
    details.annotationsAfterDlm = annotationsAfterDlm;
    check(
      'reading: a highlight, a question and an insight were saved on real paper text',
      annotationsAfterDlm === 4,
      `${String(annotationsAfterDlm)} annotation(s)`,
    );
    await closeNotes(page);
    await page.screenshot({
      path: fileURLToPath(new URL('01-dlm-annotations.png', SHOT_DIR)),
    });
    await page.getByRole('button', { name: '暖纸' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: fileURLToPath(new URL('01b-dlm-warm-paper.png', SHOT_DIR)),
    });
    await page.getByRole('button', { name: '深灰' }).click();
    await page.waitForTimeout(300);
    const darkReader = await page.evaluate(() => {
      const reader = document.querySelector('.reader');
      return reader === null
        ? null
        : {
            width: reader.getBoundingClientRect().width,
            overflow: reader.scrollWidth - reader.clientWidth,
          };
    });
    check(
      'layout: the real paper stays readable in the dark paper mode without sideways overflow',
      darkReader !== null && darkReader.overflow <= 1,
      `${String(Math.round(darkReader?.width ?? 0))}px wide, overflow ${String(darkReader?.overflow ?? 0)}px`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('01c-dlm-dark-paper.png', SHOT_DIR)),
    });
    await page.getByRole('button', { name: '原始' }).click();

    // ---- Reading position through zoom and the side panel ------------------
    await gotoPage(page, 4);
    const pageBefore = await page.locator('.reader-page-jump input').inputValue();
    await page.getByRole('button', { name: '放大' }).click();
    await page.waitForTimeout(500);
    const pageAfterZoom = await page.locator('.reader-page-jump input').inputValue();
    const sidebar = page.getByLabel('收起侧栏');
    if ((await sidebar.count()) > 0) await sidebar.click();
    await page.waitForTimeout(300);
    const pageAfterSidebar = await page.locator('.reader-page-jump input').inputValue();
    check(
      'reading position: zoom and sidebar changes keep the same page',
      pageBefore === '4' && pageAfterZoom === '4' && pageAfterSidebar === '4',
      `${pageBefore} / ${pageAfterZoom} / ${pageAfterSidebar}`,
    );

    // ---- A second real paper ----------------------------------------------
    await toProject(page);
    await importRelated(page, fileURLToPath(PAPER_TS));
    await gotoPage(page, 3);
    await addNote(
      page,
      Q_TS_LANGUAGE_MODEL,
      3,
      '理解',
      '这里的 shared language model 与 DLM 的共享画布不是同一件事，真正的共同点是“语言模型”。',
    );
    check(
      'cross-paper: the second paper has its own real annotation',
      (await annotationCount(page)) === 5,
      `${String(await annotationCount(page))} annotation(s) across both papers`,
    );
    await closeNotes(page);

    // ---- Manual knowledge built from the reader's own notes ---------------
    await toProject(page);
    await openKnowledge(page);
    await createConcept(page, 'language model', '在 token 序列上建模并生成输出的模型。');
    await attachEvidence(page, 'language model', Q_DLM_LANGUAGE_MODEL.slice(0, 40));
    await attachEvidence(page, 'language model', Q_TS_LANGUAGE_MODEL.slice(0, 40));
    const languageDetail = detailOf(page, 'language model');
    check(
      'knowledge: one concept carries occurrences from both real papers',
      (await languageDetail.locator('.evidence-row').count()) === 2,
      `${String(await languageDetail.locator('.evidence-row').count())} occurrence(s)`,
    );

    await createConcept(page, 'shared canvas', 'DLM 在同一个画布上放示例、目标和可见上下文。');
    await attachEvidence(page, 'shared canvas', Q_DEFINITION.slice(0, 40));
    await createConcept(
      page,
      'masked diffusion language model',
      '用掩码扩散方式在共享画布上填充多个缺失区域的模型。',
    );
    await attachEvidence(page, 'masked diffusion language model', Q_DEFINITION.slice(0, 40));
    await addRelation(page, 'masked diffusion language model', '定义依赖', 'shared canvas');
    await addRelation(page, 'masked diffusion language model', '扩展', 'language model');

    const afterManual = await knowledgePayload(page);
    details.afterManual = {
      concepts: afterManual.concepts.length,
      relations: afterManual.relations.length,
      evidence: afterManual.evidence.length,
    };
    check(
      'knowledge: two manually verified dependencies were created from the reader’s notes',
      afterManual.relations.length === 2 &&
        afterManual.relations.every((relation) => relation.origin === 'user'),
      `${String(afterManual.relations.length)} relation(s), all user-origin`,
    );
    check(
      'knowledge: AI suggestions and reader-made relations are distinguishable',
      afterManual.relations.every((relation) => relation.status === 'confirmed'),
    );
    await page.screenshot({
      path: fileURLToPath(new URL('02-manual-knowledge.png', SHOT_DIR)),
    });

    // ---- Jump from the knowledge view to the exact paper text -------------
    await listOf(page).locator('.concept-card[data-concept-name="shared canvas"]').first().click();
    await detailOf(page, 'shared canvas')
      .locator('.evidence-row')
      .first()
      .getByRole('button', { name: '打开原文' })
      .click();
    await page.locator('.reader').waitFor({ timeout: 60_000 });
    await page.locator('[data-spotlight="true"]').first().waitFor({ timeout: 20_000 });
    check(
      'navigation: the evidence opens the real paper and marks the quotation',
      (await page.locator('[data-spotlight="true"]').count()) > 0,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('03-evidence-jump.png', SHOT_DIR)),
    });
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    check(
      'navigation: returning keeps the selected concept',
      (await detailOf(page, 'shared canvas').count()) === 1,
    );

    // ---- Offline mock analysis, with explicit rejection -------------------
    await toProject(page);
    await openCorePaper(page);
    let panel = await runMockAnalysis(page, Q_AI_SELECTION, 4);
    const firstHead = await panel.locator('.knowledge-results-head').innerText();
    check(
      'AI (mock): the suggestions are labelled as an offline simulation',
      (await panel.locator('.knowledge-mock-warning').count()) === 1,
    );

    // Closing and reopening the panel must not silently discard the analysis context.
    await closeKnowledgePanel(page);
    await page.getByRole('button', { name: '打开相关知识' }).click();
    await panelOf(page).waitFor({ timeout: 10_000 });
    check(
      'interaction: closing and reopening the AI panel keeps the current result',
      (await panelOf(page).locator('.knowledge-results').count()) === 1 &&
        (await panelOf(page).locator('.knowledge-results-head').innerText()) === firstHead,
    );
    const pageAfterReopen = await page.locator('.reader-page-jump input').inputValue();
    check(
      'interaction: closing and reopening the AI panel keeps the reader on the selected page',
      pageAfterReopen === '4',
      `page ${pageAfterReopen}`,
    );

    let relationBlock = panelOf(page)
      .locator('.knowledge-suggestion-block')
      .filter({ hasText: '关系建议' })
      .first();
    const prerequisiteRow = relationBlock
      .locator('.knowledge-suggestion-row[data-kind="prerequisite"]')
      .first();
    await prerequisiteRow.getByRole('button', { name: '拒绝该关系' }).click();
    await page.waitForTimeout(400);
    check(
      'rejection: the rejected relation leaves the suggestion list and is recorded',
      (await relationBlock
        .locator('.knowledge-suggestion-row[data-kind="prerequisite"]')
        .count()) === 0 &&
        (await panelOf(page)
          .locator('.knowledge-suggestion-block')
          .filter({ hasText: '已拒绝的关系建议' })
          .count()) === 1,
    );
    const afterFirstRejection = await knowledgePayload(page);
    details.afterFirstRejection = afterFirstRejection.rejections.length;

    // Same analysis again: the exact same claim must not silently return.
    await rerunMockAnalysis(page, panelOf(page));
    details.afterFirstRerunPanel = {
      head: await panelOf(page).locator('.knowledge-results-head').innerText(),
      rows: await relationBlock.locator('.knowledge-suggestion-row').evaluateAll((rows) =>
        rows.map((row) => ({
          kind: row.getAttribute('data-kind'),
          status: row.getAttribute('data-status'),
          text: (row.textContent ?? '').replace(/\s+/g, ' ').slice(0, 100),
        })),
      ),
      skipped: await panelOf(page)
        .locator('.knowledge-skipped')
        .innerText()
        .catch(() => null),
    };
    const skippedFirst = panelOf(page).locator('.knowledge-skipped');
    if ((await skippedFirst.count()) > 0) await skippedFirst.locator('summary').click();
    check(
      'rejection: re-analysis does not restore the identical claim',
      (await relationBlock
        .locator('.knowledge-suggestion-row[data-kind="prerequisite"]')
        .count()) === 0 && (await skippedFirst.innerText()).includes('明确拒绝'),
    );

    // Undo through the knowledge view, then the same suggestion may return.
    await toProject(page);
    await openKnowledge(page);
    await listOf(page).locator('.concept-card[data-concept-name="模拟概念 A"]').first().click();
    const mockDetail = detailOf(page, '模拟概念 A');
    check(
      'rejection: the decision is visible with an undo control in the knowledge view',
      (await mockDetail.getByText('已拒绝的关系建议').count()) === 1,
    );
    await mockDetail.getByRole('button', { name: '撤销拒绝' }).click();
    await page.waitForTimeout(300);
    check(
      'rejection: undo is possible and removes the record',
      (await knowledgePayload(page)).rejections.length === 0,
    );

    await toProject(page);
    await openCorePaper(page);
    panel = await runMockAnalysis(page, Q_AI_SELECTION, 4);
    relationBlock = panel
      .locator('.knowledge-suggestion-block')
      .filter({ hasText: '关系建议' })
      .first();
    check(
      'rejection: after undo, a new analysis can propose the same claim again',
      (await relationBlock
        .locator('.knowledge-suggestion-row[data-kind="prerequisite"]')
        .count()) === 1,
    );
    await relationBlock
      .locator('.knowledge-suggestion-row[data-kind="prerequisite"]')
      .first()
      .getByRole('button', { name: '采纳' })
      .click();
    const acceptedPayload = await knowledgePayload(page);
    const acceptedRelation = acceptedPayload.relations.find(
      (relation) => relation.origin === 'ai' && relation.status === 'confirmed',
    );
    const relatedRow = relationBlock
      .locator('.knowledge-suggestion-row[data-kind="related"]')
      .first();
    await relatedRow.getByRole('button', { name: '拒绝该关系' }).click();
    await page.waitForTimeout(400);
    await rerunMockAnalysis(page, panel);
    const afterRerunPayload = await knowledgePayload(page);
    const confirmedMock = afterRerunPayload.relations.filter(
      (relation) => relation.origin === 'ai' && relation.status === 'confirmed',
    );
    details.afterRerun = {
      confirmed: confirmedMock.length,
      rejections: afterRerunPayload.rejections.length,
      relations: afterRerunPayload.relations.length,
    };
    const skippedSecond = panel.locator('.knowledge-skipped');
    if ((await skippedSecond.count()) > 0) await skippedSecond.locator('summary').click();
    details.afterSecondRerunPanel = {
      head: await panel.locator('.knowledge-results-head').innerText(),
      rows: await relationBlock.locator('.knowledge-suggestion-row').evaluateAll((rows) =>
        rows.map((row) => ({
          kind: row.getAttribute('data-kind'),
          status: row.getAttribute('data-status'),
          text: (row.textContent ?? '').replace(/\s+/g, ' ').slice(0, 100),
        })),
      ),
      skipped: await skippedSecond.innerText().catch(() => null),
    };
    const confirmedAfter = afterRerunPayload.relations.find(
      (relation) => relation.id === acceptedRelation?.id,
    );
    check(
      'confirmed knowledge: a confirmed AI relation is not overwritten by re-analysis',
      confirmedMock.length === 1 &&
        acceptedRelation !== undefined &&
        confirmedAfter?.status === 'confirmed' &&
        confirmedAfter.kind === acceptedRelation.kind &&
        confirmedAfter.updatedAt === acceptedRelation.updatedAt,
      `id ${String(acceptedRelation?.id ?? '?')}, status ${String(confirmedAfter?.status ?? '?')}`,
    );
    check(
      'rejection: the second rejected claim stays rejected after re-analysis',
      afterRerunPayload.rejections.length === 1 &&
        (await skippedSecond.innerText()).includes('明确拒绝'),
    );
    await page.screenshot({
      path: fileURLToPath(new URL('04-ai-rejection-and-confirmed.png', SHOT_DIR)),
    });

    // ---- Dark, warm paper, narrow window ----------------------------------
    await toProject(page);
    await openKnowledge(page);
    await setAppTheme(page, '深色');
    await page.waitForTimeout(300);
    await page.screenshot({ path: fileURLToPath(new URL('05-knowledge-dark.png', SHOT_DIR)) });
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
      'layout: real annotations and knowledge reflow in a narrow window',
      narrow !== null && narrow.overflow <= 1,
      `${String(Math.round(narrow?.width ?? 0))}px wide, overflow ${String(narrow?.overflow ?? 0)}px`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('06-knowledge-narrow.png', SHOT_DIR)),
    });
    await page.setViewportSize({ width: 1440, height: 950 });

    // ---- Export and restore in an isolated browser ------------------------
    await exportBackup(page, BACKUP);
    const exported = await readFile(fileURLToPath(BACKUP));
    check(
      'backup: a real backup file was written with the research project',
      exported.length > 1024 && exported.subarray(0, 8).toString('utf8') === 'RWBACKUP',
      `${String(exported.length)} bytes`,
    );
    await contextA.close();
    contextA = undefined;

    contextB = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const restored = await contextB.newPage();
    watch(restored, 'B');
    await restored.goto(ORIGIN);
    await restoreBackup(restored, BACKUP);
    await restored.getByRole('button', { name: PROJECT }).first().waitFor({ timeout: 30_000 });
    await toProject(restored);
    await openKnowledge(restored);
    const restoredPayload = await knowledgePayload(restored);
    details.restored = {
      concepts: restoredPayload.concepts.length,
      relations: restoredPayload.relations.length,
      evidence: restoredPayload.evidence.length,
      rejections: restoredPayload.rejections.length,
      version: restoredPayload.version,
    };
    check(
      'restore: concepts, occurrences, manual relations and the rejection all survive',
      restoredPayload.version === 2 &&
        restoredPayload.concepts.length === 5 &&
        restoredPayload.relations.length === 3 &&
        restoredPayload.rejections.length === 1,
      JSON.stringify(details.restored),
    );
    check(
      'restore: the rejection is still identifiable as an explicit decision',
      restoredPayload.rejections[0]?.fingerprint?.startsWith('rel1-') === true,
    );

    await listOf(restored)
      .locator('.concept-card[data-concept-name="language model"]')
      .first()
      .click();
    const restoredLanguage = detailOf(restored, 'language model');
    check(
      'restore: the cross-paper concept still lists both occurrences',
      (await restoredLanguage.locator('.evidence-row').count()) === 2,
    );
    await restoredLanguage
      .locator('.evidence-row')
      .filter({ hasText: '第 3 页' })
      .first()
      .getByRole('button', { name: '打开原文' })
      .click();
    await restored.locator('.reader').waitFor({ timeout: 60_000 });
    await restored.locator('[data-spotlight="true"]').first().waitFor({ timeout: 20_000 });
    check(
      'restore: navigating to the second paper still opens the quoted text',
      (await restored.locator('[data-spotlight="true"]').count()) > 0,
    );
    await restored.screenshot({
      path: fileURLToPath(new URL('07-restored-cross-paper.png', SHOT_DIR)),
    });

    await restored.getByRole('button', { name: '返回' }).click();
    await restored.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    check(
      'restore: the reader can continue from the knowledge view',
      (await detailOf(restored, 'language model').count()) === 1,
    );

    check(
      'offline: every browser request went to the preview or the local mock service',
      aiRequests.every((entry) => entry.url.startsWith(ORIGIN) || entry.url.startsWith(AI_ORIGIN)),
    );
    check(
      'console: no unexpected errors or warnings',
      consoleIssues.length === 0,
      consoleIssues.map((entry) => `${entry.label}: ${entry.text}`).join(' | '),
    );

    const annotationsAfterRestore = await restored.evaluate(() => {
      const projects = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
      return projects?.annotations?.length ?? 0;
    });
    details.annotationsAfterRestore = annotationsAfterRestore;
    check(
      'restore: all five real annotations came back',
      annotationsAfterRestore === 5,
      `${String(annotationsAfterRestore)} annotation(s)`,
    );
  } catch (error) {
    const failedPage = contextA?.pages()[0] ?? contextB?.pages()[0];
    details.readerDebug = await failedPage
      ?.evaluate(() => ({
        jump: document.querySelector('.reader-page-jump input')?.value ?? null,
        toolbar: document.querySelectorAll('.annotation-toolbar').length,
        selection: (window.getSelection()?.toString() ?? '').slice(0, 120),
        pages: [...document.querySelectorAll('.pdf-page')].map((element) => ({
          page: element.getAttribute('data-page'),
          spans: element.querySelectorAll('.textLayer span').length,
        })),
      }))
      .catch(() => null);
    await failedPage
      ?.screenshot({ path: fileURLToPath(new URL('00-failure.png', SHOT_DIR)) })
      .catch(() => {});
    check(
      'run: the research workflow finished without an exception',
      false,
      error instanceof Error ? error.message : String(error),
    );
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  } finally {
    await contextA?.close().catch(() => {});
    await contextB?.close().catch(() => {});
    await browser.close().catch(() => {});
    preview.kill();
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

/* global document, window */
import { spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { requireOfflineProxy } from './offline.mjs';
import { selectSpans } from './text-selection.mjs';

/**
 * Export a whole workspace, then restore it into a browser that has never seen it.
 *
 * Environment A builds the workspace through the ordinary interface: a project, a real paper
 * imported twice so two papers share one PDF, a note, a reading position, two concepts and a
 * relation, and one concept shared with a second project. It then exports through the real
 * download path. Environment B is a new browser context with empty storage: it imports the file
 * that was actually downloaded — nothing is copied between storage directories, and the file is
 * parsed, verified and written by the application itself.
 *
 * The rest of the run is the failure side: a corrupt file, a newer format, a duplicate import,
 * a same-id conflict that must be chosen explicitly, a paper whose PDF is missing, and a write
 * that fails halfway through and must roll back. None of them may damage what was already there.
 */

const PORT = Number(process.env.AI_VERIFY_PREVIEW_PORT ?? 4176);
const AI_PORT = Number(process.env.AI_VERIFY_PORT ?? 8791);
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const AI_ORIGIN = `http://127.0.0.1:${String(AI_PORT)}`;
const ROOT = new URL('../../', import.meta.url);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = new URL(`docs/screenshots-phase7/${RUN_STAMP}-backup/`, ROOT);
const REPORT_FILE = new URL(`docs/screenshots-phase7/${RUN_STAMP}-backup/report.json`, ROOT);
const WORK_DIR = new URL('.cache/verify/', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SERVER_ENTRY = fileURLToPath(new URL('server/start.mjs', ROOT));
const PAPER = new URL('.cache/papers/2610.22294.pdf', ROOT);
const BACKUP = new URL('.cache/verify/backup-e2e.rwbackup', ROOT);
const PROJECT_A = '迁移验收';
const PROJECT_B = '第二个项目';

const results = [];
const consoleIssues = [];
const aiRequests = [];

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
        return { child, outputOf: () => output, health };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('the service on')) throw error;
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`the local AI service did not start:
${output}`);
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
  let previewOutput = '';
  child.stdout.on('data', (chunk) => {
    previewOutput += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    previewOutput += String(chunk);
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
  throw new Error(`preview server did not start:
${previewOutput}`);
}

/* ------------------------------------------------------------------ *
 * Backup-file surgery for the negative cases
 * ------------------------------------------------------------------ */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value).sort(([one], [other]) =>
    one < other ? -1 : one > other ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

async function readContainer(path) {
  const bytes = await readFile(fileURLToPath(path));
  const headerLength = bytes.readUInt32LE(8);
  const payloadLength = bytes.readUInt32LE(12);
  const header = JSON.parse(bytes.subarray(16, 16 + headerLength).toString('utf8'));
  const payload = bytes.subarray(16 + headerLength, 16 + headerLength + payloadLength);
  return { header, payload };
}

function writeContainer(header, payload) {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const frame = Buffer.alloc(16);
  frame.write('RWBACKUP', 0, 'ascii');
  frame.writeUInt32LE(headerBytes.length, 8);
  frame.writeUInt32LE(payload.length, 12);
  return Buffer.concat([frame, headerBytes, payload]);
}

function resign(header) {
  header.integrity.dataSha256 = sha256(Buffer.from(canonical(header.data), 'utf8'));
}

/* ------------------------------------------------------------------ *
 * Driving the interface
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
  // The same bytes imported a second time is a deliberate choice, not a silent duplicate.
  // The question appears only after the form has been submitted, so wait for either outcome.
  const duplicate = dialog.getByRole('button', { name: '仍然新建一篇论文' });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await page.locator('.reader').count()) > 0) break;
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
}

async function toProject(page, name) {
  const back = page.getByRole('button', { name: '返回' });
  if ((await back.count()) > 0) await back.click();
  const expand = page.getByLabel('展开侧栏');
  if ((await expand.count()) > 0) await expand.click();
  await page.getByRole('button', { name }).first().click();
  await page.getByRole('heading', { level: 1, name }).waitFor();
}

async function openKnowledge(page) {
  await page.getByRole('button', { name: '知识', exact: true }).click();
  await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
}

async function createConcept(page, name, summary = '') {
  await page.getByRole('button', { name: /新建概念/ }).click();
  await page.getByLabel('概念名称').fill(name);
  if (summary !== '') await page.getByLabel('简短概述').fill(summary);
  await page.getByRole('button', { name: '创建', exact: true }).click();
}

const cardOf = (page, name) =>
  page.getByLabel('概念列表').locator(`.concept-card[data-concept-name="${name}"]`).first();
const detailOf = (page, name) => page.getByRole('region', { name: `概念：${name}` });

/** Selects a run of the first page's text, the way a small drag would. */
async function selectSomeText(page) {
  const picked = await page.evaluate(() => {
    const root = document.querySelector('.pdf-page[data-page="1"]');
    if (root === null) return null;
    const spans = [...root.querySelectorAll('.textLayer span')].filter(
      (span) => span.querySelector('span') === null && (span.textContent ?? '').trim() !== '',
    );
    for (let index = 0; index + 2 < spans.length; index += 1) {
      const run = spans.slice(index, index + 3);
      if (run.map((span) => span.textContent ?? '').join(' ').length > 60) {
        return {
          start: index,
          end: index + 2,
          endLength: (spans[index + 2]?.textContent ?? '').length,
        };
      }
    }
    return null;
  });
  if (picked === null) throw new Error('page 1 has no usable text run to select');
  const selection = await selectSpans(
    page,
    1,
    { span: picked.start, offset: 0 },
    { span: picked.end, offset: picked.endLength },
  );
  await page.mouse.move(5, 5);
  await page.locator('.pdf-page[data-page="1"]').first().dispatchEvent('mouseup');
  return selection;
}

const toolbarOf = (page) => page.getByRole('toolbar', { name: '批注' });

async function openBackupDialog(page) {
  const expand = page.getByLabel('展开侧栏');
  if ((await expand.count()) > 0) await expand.click();
  await page.getByRole('button', { name: '备份与恢复' }).click();
  const dialog = page.getByRole('dialog', { name: '备份与恢复' });
  await dialog.waitFor({ timeout: 10_000 });
  return dialog;
}

async function importBackup(dialog, filePath) {
  await dialog.getByLabel('选择备份文件').setInputFiles(filePath);
  // Inspection either produces a plan ("本次会新增") or an explicit refusal.
  await dialog
    .getByText(/本次会新增|这个备份不能恢复|读取备份时出错/)
    .first()
    .waitFor({ timeout: 60_000 });
}

async function main() {
  refuseIfConfiguredForRealProvider();
  await refuseIfPortTaken();
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });

  const service = await startService();
  const server = await startPreview();
  await requireOfflineProxy(ORIGIN, {
    expectedInstance: service.health.instanceId,
    label: '备份恢复验收',
  });

  const browser = await launchBrowser();
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await contextA.newPage();
  watch(page);

  const paperBytes = await readFile(fileURLToPath(PAPER));
  const paperSha = sha256(paperBytes);

  try {
    await page.goto(ORIGIN);
    await createProject(page, PROJECT_A);
    await importPaper(page, fileURLToPath(PAPER));

    // ---- A note and a reading position, on the paper's own text -------------
    const selection = await selectSomeText(page);
    const toolbar = toolbarOf(page);
    await toolbar.waitFor({ timeout: 10_000 });
    await toolbar.getByRole('button', { name: '笔记' }).click();
    await toolbar.getByLabel('笔记内容').fill('迁移验收的笔记');
    await toolbar.getByRole('button', { name: '保存' }).click();
    check(
      'environment A: a note is anchored to real text in the real paper',
      (selection?.text ?? '').length > 40,
      `${String((selection?.text ?? '').length)} characters`,
    );

    // ---- A second paper with the same file ---------------------------------
    await toProject(page, PROJECT_A);
    await importPaper(page, fileURLToPath(PAPER));
    const sharedCounts = await page.evaluate(() => {
      const papers = Object.values(
        JSON.parse(window.localStorage.getItem('rw.projects') ?? '{}').papers ?? {},
      );
      const counts = {};
      for (const entry of papers) {
        if (entry.pdf !== undefined) counts[entry.pdf.sha256] = (counts[entry.pdf.sha256] ?? 0) + 1;
      }
      return Object.values(counts);
    });
    check(
      'environment A: the same PDF is attached to two separate paper records',
      sharedCounts.some((count) => count === 2),
      sharedCounts.join(','),
    );

    // ---- Concepts, a relation, and a second project ------------------------
    await toProject(page, PROJECT_A);
    await createProject(page, PROJECT_B);
    await toProject(page, PROJECT_A);
    await openKnowledge(page);

    await createConcept(page, 'KZG commitment', '一种多项式承诺方案。');
    const detail = detailOf(page, 'KZG commitment');
    await detail.getByRole('button', { name: /从笔记里添加出处/ }).click();
    await detail.locator('.evidence-picker').getByRole('button', { name: '添加' }).click();
    check(
      'environment A: the concept has the note as its evidence',
      (await detail.locator('.evidence-row').count()) === 1,
    );

    await createConcept(page, 'Polynomial commitment', '把多项式绑定到承诺上的方案。');
    await cardOf(page, 'KZG commitment').click();
    await detailOf(page, 'KZG commitment')
      .getByLabel('关系对象')
      .selectOption({ label: 'Polynomial commitment' });
    await detailOf(page, 'KZG commitment').getByRole('button', { name: '添加关系' }).click();

    await detailOf(page, 'KZG commitment')
      .getByRole('combobox', { name: '加入项目' })
      .selectOption({ label: PROJECT_B });
    await detailOf(page, 'KZG commitment').getByRole('button', { name: '加入项目' }).click();
    check(
      'environment A: one concept now links both projects',
      (await detailOf(page, 'KZG commitment').innerText()).includes(PROJECT_B),
    );

    // Graph mode and a selected concept, so environment B can prove the return keeps them.
    await page.getByRole('button', { name: '关系图' }).click();
    await page
      .getByRole('group', { name: '概念关系图' })
      .getByRole('button', { name: 'KZG commitment', exact: true })
      .click();
    await detailOf(page, 'KZG commitment')
      .locator('.evidence-row')
      .getByRole('button', { name: '打开原文' })
      .click();
    await page
      .locator('.pdf-highlight[data-spotlight="true"]')
      .first()
      .waitFor({ timeout: 20_000 });
    check(
      'environment A: evidence jumps into the paper and marks the quotation',
      (await page.locator('.pdf-highlight[data-spotlight="true"]').count()) > 0,
    );
    await toProject(page, PROJECT_A);
    await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    check(
      'environment A: coming back from the paper keeps the graph and the concept',
      (await page.locator('.knowledge-body').getAttribute('data-mode')) === 'graph' &&
        (await page.locator('.concept-node[data-selected="true"]').getAttribute('aria-label')) ===
          'KZG commitment',
    );

    // ---- A reading position, after the last evidence jump ------------------
    // (The evidence jump above opens the paper at page 1 on purpose; the position this test
    // checks is the one set afterwards, which is the ordinary "where I stopped reading".)
    await page.getByRole('button', { name: '文献', exact: true }).click();
    await page.getByRole('button', { name: '阅读' }).first().click();
    await page.locator('.reader').waitFor({ timeout: 30_000 });
    await page
      .locator('.pdf-page[data-page="1"] .textLayer span')
      .first()
      .waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    const jump = page.locator('.reader-page-jump input');
    await jump.fill('2');
    await jump.press('Enter');
    await page
      .locator('.pdf-page[data-page="2"] .textLayer span')
      .first()
      .waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2000); // smooth scrolling ignores the observer for 1.5s
    const readingNow = await page.evaluate(() =>
      Object.values(
        JSON.parse(window.localStorage.getItem('rw.projects') ?? '{}').papers ?? {},
      ).map((entry) => entry.reading?.page ?? null),
    );
    check(
      'environment A: the reader stopped on page 2 and the app stored it',
      readingNow.includes(2),
      JSON.stringify(readingNow),
    );
    await toProject(page, PROJECT_A);

    // ---- Theme, then export ------------------------------------------------
    await setAppTheme(page, '深色');
    await page.waitForTimeout(300);
    const beforeExport = await page.evaluate(() =>
      JSON.stringify({
        projects: window.localStorage.getItem('rw.projects'),
        knowledge: window.localStorage.getItem('rw.knowledge'),
      }),
    );

    const dialog = await openBackupDialog(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: '导出备份文件' }).click(),
    ]);
    await download.saveAs(fileURLToPath(BACKUP));
    await dialog.getByRole('button', { name: '关闭' }).click();

    const afterExport = await page.evaluate(() =>
      JSON.stringify({
        projects: window.localStorage.getItem('rw.projects'),
        knowledge: window.localStorage.getItem('rw.knowledge'),
      }),
    );
    check('export: exporting does not modify the stored workspace', beforeExport === afterExport);

    const { header } = await readContainer(BACKUP);
    check(
      'export: the file carries every kind of record',
      header.counts.projects === 2 &&
        header.counts.papers === 4 &&
        header.counts.annotations === 1 &&
        header.counts.concepts === 2 &&
        header.counts.relations === 1,
      JSON.stringify(header.counts),
    );
    check(
      'export: two papers that share one PDF produce one packed file',
      header.files.length === 1 && header.files[0].sha256 === paperSha,
      `${String(header.files.length)} file(s)`,
    );

    // ---- Environment B: a browser that has never seen any of this -----------
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const pageB = await contextB.newPage();
    watch(pageB);
    await pageB.goto(ORIGIN);

    await openBackupDialog(pageB);
    await importBackup(pageB, fileURLToPath(BACKUP));
    const dialogB = pageB.getByRole('dialog', { name: '备份与恢复' });

    // ---- Cancelling writes nothing ----------------------------------------
    await dialogB.getByRole('button', { name: '取消' }).click();
    check(
      'safety: cancelling the restore leaves the empty browser empty',
      (await pageB.evaluate(() => window.localStorage.getItem('rw.projects'))) === null,
    );

    await openBackupDialog(pageB);
    await importBackup(pageB, fileURLToPath(BACKUP));
    check(
      'environment B: the preview names what will be added',
      (await dialogB.innerText()).includes('本次会新增 2 个项目'),
      '2 projects',
    );
    await pageB.screenshot({ path: fileURLToPath(new URL('01-restore-preview.png', SHOT_DIR)) });
    await dialogB.getByRole('button', { name: '开始恢复' }).click();
    await dialogB.locator('.backup-message.is-success').waitFor({ timeout: 60_000 });
    await pageB.screenshot({ path: fileURLToPath(new URL('02-restore-complete.png', SHOT_DIR)) });
    await dialogB.getByRole('button', { name: '重新载入以查看恢复后的内容' }).click();
    await pageB.getByRole('button', { name: PROJECT_A }).first().waitFor({ timeout: 30_000 });

    const restored = await pageB.evaluate(() => {
      const projects = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
      const knowledge = JSON.parse(window.localStorage.getItem('rw.knowledge') ?? 'null');
      return {
        projectNames: (projects?.projects ?? []).map((entry) => entry.name).sort(),
        papers: Object.values(projects?.papers ?? {}),
        annotations: projects?.annotations ?? [],
        concepts: (knowledge?.concepts ?? []).map((entry) => entry.name).sort(),
        relations: knowledge?.relations ?? [],
        theme: window.localStorage.getItem('rw.theme'),
      };
    });
    check(
      'restore: both projects came back',
      JSON.stringify(restored.projectNames) === JSON.stringify([PROJECT_A, PROJECT_B].sort()),
      restored.projectNames.join(', '),
    );
    check(
      'restore: four paper records, and every attached file has the original content hash',
      restored.papers.length === 4 &&
        restored.papers
          .filter((paper) => paper.pdf !== undefined)
          .every((paper) => paper.pdf.sha256 === paperSha),
      `${String(restored.papers.length)} papers`,
    );
    check(
      'restore: the reading position is the page the reader stopped on',
      restored.papers.some((paper) => paper.reading?.page === 2),
    );
    check(
      'restore: the note came back with its text and anchor',
      restored.annotations.length === 1 && restored.annotations[0]?.note === '迁移验收的笔记',
    );
    check(
      'restore: concepts and their relation came back',
      JSON.stringify(restored.concepts) ===
        JSON.stringify(['KZG commitment', 'Polynomial commitment']) &&
        restored.relations.length === 1,
      `${String(restored.concepts.length)} concepts`,
    );
    check('restore: the theme preference was restored', restored.theme === 'dark');

    // ---- Open the restored paper: PDF, position, note, evidence ------------
    await pageB.getByRole('button', { name: PROJECT_A }).first().click();
    await pageB.getByRole('heading', { level: 1, name: PROJECT_A }).waitFor();
    await pageB.getByRole('button', { name: '阅读' }).first().click();
    await pageB.locator('.reader').waitFor({ timeout: 30_000 });
    await pageB.locator('.pdf-page .textLayer span').first().waitFor({ timeout: 60_000 });
    await pageB.waitForTimeout(800);
    check(
      'environment B: the restored PDF renders its own text',
      (await pageB.locator('.pdf-page[data-page="1"] .textLayer').innerText()).length > 200,
    );
    check(
      'environment B: the reader reopens on the restored page',
      (await pageB.locator('.reader-page-jump input').inputValue()) === '2',
    );
    const notesPanel = pageB.getByRole('complementary', { name: '论文笔记' });
    if ((await notesPanel.count()) === 0) {
      await pageB.getByRole('button', { name: '打开我的笔记' }).click();
    }
    await notesPanel.waitFor({ timeout: 10_000 });
    check(
      'environment B: the restored note is on the paper',
      (await notesPanel.innerText()).includes('迁移验收的笔记'),
    );
    await pageB.screenshot({ path: fileURLToPath(new URL('03-restored-paper.png', SHOT_DIR)) });

    // ---- Evidence still finds its quotation --------------------------------
    await pageB.getByRole('button', { name: '返回' }).click();
    await openKnowledge(pageB);
    await pageB.getByRole('button', { name: '关系图' }).click();
    await pageB
      .getByRole('group', { name: '概念关系图' })
      .getByRole('button', { name: 'KZG commitment', exact: true })
      .click();
    await detailOf(pageB, 'KZG commitment')
      .locator('.evidence-row')
      .getByRole('button', { name: '打开原文' })
      .click();
    await pageB
      .locator('.pdf-highlight[data-spotlight="true"]')
      .first()
      .waitFor({ timeout: 30_000 });
    check(
      'environment B: a restored evidence record still opens the quoted passage',
      (await pageB.locator('.pdf-highlight[data-spotlight="true"]').count()) > 0,
    );
    await pageB.getByRole('button', { name: '返回' }).click();
    await pageB.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    check(
      'environment B: returning from the paper keeps the graph and the selected concept',
      (await pageB.locator('.knowledge-body').getAttribute('data-mode')) === 'graph' &&
        (await pageB.locator('.concept-node[data-selected="true"]').getAttribute('aria-label')) ===
          'KZG commitment',
    );

    // ---- The concept is shared by both projects ---------------------------
    await pageB.getByRole('button', { name: PROJECT_B }).first().click();
    await pageB.getByRole('heading', { level: 1, name: PROJECT_B }).waitFor();
    await openKnowledge(pageB);
    // The view mode is kept across projects; use the list for the card assertions.
    await pageB.getByRole('button', { name: '列表' }).click();
    check(
      'restore: the shared concept appears in the other project too',
      (await pageB.locator('.concept-card').filter({ hasText: 'KZG commitment' }).count()) === 1,
    );
    await cardOf(pageB, 'KZG commitment').click();
    const sharedDetail = await detailOf(pageB, 'KZG commitment').innerText();
    check(
      'restore: and it still says which projects it belongs to',
      sharedDetail.includes(PROJECT_A) && sharedDetail.includes(PROJECT_B),
    );
    await pageB.screenshot({ path: fileURLToPath(new URL('04-shared-concept.png', SHOT_DIR)) });

    // ---- The dialog in a narrow dark window -------------------------------
    await pageB.setViewportSize({ width: 900, height: 900 });
    await pageB.waitForTimeout(300);
    const narrowDialog = await openBackupDialog(pageB);
    const overflow = await narrowDialog.evaluate((element) => {
      const body = element.querySelector('.dialog-body');
      return body === null ? 0 : body.scrollWidth - body.clientWidth;
    });
    check(
      'layout: the backup dialog fits a narrow window in the restored dark theme',
      overflow <= 1,
      `${String(overflow)}px overflow`,
    );
    await pageB.screenshot({ path: fileURLToPath(new URL('05-backup-narrow.png', SHOT_DIR)) });
    await narrowDialog.getByRole('button', { name: '关闭' }).click();
    await pageB.setViewportSize({ width: 1440, height: 950 });

    // ---- Importing the same file twice is a no-op -------------------------
    const beforeDuplicate = await pageB.evaluate(() => window.localStorage.getItem('rw.projects'));
    const dialogDup = await openBackupDialog(pageB);
    await importBackup(dialogDup, fileURLToPath(BACKUP));
    check(
      'duplicate: a second import adds nothing',
      (await dialogDup.innerText()).includes('本次会新增 0 个项目'),
    );
    await dialogDup.getByRole('button', { name: '校验并完成恢复' }).click();
    await dialogDup.locator('.backup-message.is-success').waitFor({ timeout: 60_000 });
    check(
      'duplicate: the stored workspace is byte-identical afterwards',
      (await pageB.evaluate(() => window.localStorage.getItem('rw.projects'))) === beforeDuplicate,
    );
    await dialogDup.getByRole('button', { name: '关闭' }).click();

    // ---- A damaged file and a newer format --------------------------------
    const bytes = await readFile(fileURLToPath(BACKUP));
    const truncatedPath = new URL('.cache/verify/backup-truncated.rwbackup', ROOT);
    await writeFile(truncatedPath, bytes.subarray(0, bytes.length - 40));
    const dialogBad = await openBackupDialog(pageB);
    await importBackup(dialogBad, fileURLToPath(truncatedPath));
    check(
      'safety: a truncated backup is refused before anything is written',
      (await dialogBad.innerText()).includes('不能恢复'),
    );
    await dialogBad.getByRole('button', { name: '关闭' }).click();

    const container = await readContainer(BACKUP);
    container.header.formatVersion = 2;
    const newerPath = new URL('.cache/verify/backup-newer.rwbackup', ROOT);
    await writeFile(newerPath, writeContainer(container.header, container.payload));
    const dialogNewer = await openBackupDialog(pageB);
    await importBackup(dialogNewer, fileURLToPath(newerPath));
    check(
      'safety: a backup from a newer format version is refused, not guessed at',
      (await dialogNewer.innerText()).includes('更新版本'),
    );
    await dialogNewer.getByRole('button', { name: '关闭' }).click();

    // ---- A same-id conflict: the reader must choose ----------------------
    const conflict = await readContainer(BACKUP);
    conflict.header.data.projects.projects[0].name = '备份里改过名的项目';
    resign(conflict.header);
    const conflictPath = new URL('.cache/verify/backup-conflict.rwbackup', ROOT);
    await writeFile(conflictPath, writeContainer(conflict.header, conflict.payload));

    const dialogConflict = await openBackupDialog(pageB);
    await importBackup(dialogConflict, fileURLToPath(conflictPath));
    const restoreButton = dialogConflict.getByRole('button', { name: /开始恢复|校验并完成恢复/ });
    check(
      'conflict: an object with the same id but different content needs an explicit choice',
      (await restoreButton.isDisabled()) &&
        (await dialogConflict.innerText()).includes('请选择保留哪一边'),
    );
    await dialogConflict.getByRole('radio', { name: /保留本机版本/ }).check();
    await restoreButton.click();
    await dialogConflict.locator('.backup-message.is-success').waitFor({ timeout: 60_000 });
    const conflictNames = await pageB.evaluate(() =>
      JSON.parse(window.localStorage.getItem('rw.projects') ?? '{}').projects.map(
        (entry) => entry.name,
      ),
    );
    check(
      'conflict: choosing the local version keeps the name this machine already had',
      JSON.stringify(conflictNames.sort()) === JSON.stringify([PROJECT_A, PROJECT_B].sort()),
      conflictNames.join(', '),
    );
    await dialogConflict.getByRole('button', { name: '关闭' }).click();

    // ---- A backup whose PDF is missing -----------------------------------
    const missing = await readContainer(BACKUP);
    missing.header.files = [];
    missing.header.missingFiles = [paperSha];
    missing.header.data.missingFiles = [paperSha];
    resign(missing.header);
    const missingPath = new URL('.cache/verify/backup-missing-pdf.rwbackup', ROOT);
    await writeFile(missingPath, writeContainer(missing.header, Buffer.alloc(0)));

    const contextE = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const pageE = await contextE.newPage();
    watch(pageE);
    await pageE.goto(ORIGIN);
    const dialogE = await openBackupDialog(pageE);
    await importBackup(dialogE, fileURLToPath(missingPath));
    const restoreE = dialogE.getByRole('button', { name: '开始恢复' });
    check(
      'missing PDF: the restore waits for an explicit acknowledgement',
      (await restoreE.isDisabled()) &&
        (await dialogE.innerText()).includes('不在备份里，也不在本机'),
    );
    await dialogE.getByRole('checkbox').check();
    await restoreE.click();
    await dialogE.locator('.backup-message.is-success').waitFor({ timeout: 60_000 });
    const missingState = await pageE.evaluate(() => {
      const projects = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
      return {
        papers: Object.values(projects?.papers ?? {}).length,
        annotations: projects?.annotations?.length ?? 0,
      };
    });
    check(
      'missing PDF: the records are restored and the missing file is stated, not invented',
      missingState.papers === 4 && missingState.annotations === 1,
      JSON.stringify(missingState),
    );
    await contextE.close();

    // ---- A write that fails halfway through ------------------------------
    const contextF = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await contextF.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (key === 'rw.knowledge' && window.sessionStorage.getItem('rw.fail-once') === '1') {
          window.sessionStorage.removeItem('rw.fail-once');
          throw new DOMException('quota', 'QuotaExceededError');
        }
        return original.call(this, key, value);
      };
    });
    const pageF = await contextF.newPage();
    watch(pageF);
    await pageF.goto(ORIGIN);
    await createProject(pageF, '原有项目');
    const beforeFailure = await pageF.evaluate(() => window.localStorage.getItem('rw.projects'));
    const dialogF = await openBackupDialog(pageF);
    await importBackup(dialogF, fileURLToPath(BACKUP));
    await pageF.evaluate(() => {
      window.sessionStorage.setItem('rw.fail-once', '1');
    });
    await dialogF.getByRole('button', { name: '开始恢复' }).click();
    await dialogF.getByText(/已撤销本次恢复写入的内容/).waitFor({ timeout: 60_000 });
    check(
      'write failure: the restore reports the failure and rolls back every key',
      (await pageF.evaluate(() => window.localStorage.getItem('rw.projects'))) === beforeFailure &&
        (await pageF.evaluate(() => window.localStorage.getItem('rw.knowledge'))) === null,
    );
    await dialogF.getByRole('button', { name: '关闭' }).click();
    await pageF.reload();
    await pageF.getByRole('heading', { level: 1, name: '原有项目' }).waitFor({ timeout: 30_000 });
    check(
      'write failure: the original project is intact after a reload, and no recovery banner remains',
      (await pageF.locator('.banner-warning').count()) === 0,
    );
    await contextF.close();

    // ---- Process-level safety --------------------------------------------
    check(
      'safety: the service this run started was the offline mock',
      service.health.provider === 'mock' && service.health.online === false,
      `instance ${String(service.health.instanceId).slice(0, 8)}`,
    );
    check(
      'safety: exporting and restoring made no assistant request at all',
      aiRequests.length === 0,
      `${String(aiRequests.length)} request(s)`,
    );

    const unexpected = consoleIssues.filter((issue) => issue.text.includes('error'));
    check(
      'console: nothing failed unexpectedly',
      unexpected.length === 0,
      `${String(unexpected.length)} unexpected`,
    );
    if (unexpected.length > 0) process.stdout.write(`  ${unexpected[0].text}\n`);

    await contextA.close();
    await contextB.close();
  } catch (error) {
    process.stdout.write(`\n--- the run stopped here ---\n${String(error)}\n`);
    try {
      await page.screenshot({ path: fileURLToPath(new URL('failure.png', SHOT_DIR)) });
      process.stdout.write(
        `screen reads:\n${(await page.evaluate(() => document.body.innerText)).slice(0, 900)}\n`,
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
        paperSha256: paperSha,
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

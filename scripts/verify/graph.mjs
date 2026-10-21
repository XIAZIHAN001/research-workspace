/* global document, window */
import { spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { requireOfflineProxy } from './offline.mjs';
import { buildColourPdf } from './sample-pdf.mjs';

/**
 * Browser acceptance for the knowledge graph.
 *
 * The loop this checks is the one the phase is about: read a paper, keep a concept from it,
 * see what that concept stands on, follow an occurrence back to the exact words — and then make
 * sure the graph survives the ordinary mistakes: a duplicate name, a deleted relation, a deleted
 * project, a replaced file.
 */

// 4190 is on the Fetch specification's blocked-port list, so `fetch` refuses it even
// though curl reaches it. The suite talks to the preview with fetch, so it cannot use it.
const PORT = Number(process.env.AI_VERIFY_PREVIEW_PORT ?? 4175);
const AI_PORT = Number(process.env.AI_VERIFY_PORT ?? 8790);
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const AI_ORIGIN = `http://127.0.0.1:${String(AI_PORT)}`;
const ROOT = new URL('../../', import.meta.url);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = new URL(`docs/screenshots-phase6/${RUN_STAMP}-graph/`, ROOT);
const REPORT_FILE = new URL(`docs/screenshots-phase6/${RUN_STAMP}-graph/report.json`, ROOT);
const WORK_DIR = new URL('.cache/verify/', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SERVER_ENTRY = fileURLToPath(new URL('server/start.mjs', ROOT));

const results = [];
const consoleIssues = [];
const difficultyRequests = [];

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

/** Back to the project page, whichever view we are in. */
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

/** Closes whichever side panel is open, so the rail is reachable. */
async function closeSidePanel(page) {
  for (const name of ['收起笔记', '关闭 AI 面板', '关闭难点面板']) {
    const button = page.getByRole('button', { name });
    if ((await button.count()) > 0) {
      await button.first().click();
      await page.waitForTimeout(150);
      return;
    }
  }
}

const detailOf = (page, name) => page.getByRole('region', { name: `概念：${name}` });
const listOf = (page) => page.getByLabel('概念列表');

async function main() {
  refuseIfConfiguredForRealProvider();
  await refuseIfPortTaken();
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });

  const pdfPath = fileURLToPath(new URL('colour.pdf', WORK_DIR));
  await writeFile(pdfPath, buildColourPdf());

  const service = await startService();
  const server = await startPreview();
  await requireOfflineProxy(ORIGIN, {
    expectedInstance: service.health.instanceId,
    label: '知识图谱验收',
  });

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  watch(page);
  await page.route('**/api/ai/difficulties', async (route) => {
    difficultyRequests.push(route.request().postDataJSON());
    await route.continue();
  });

  try {
    await page.goto(ORIGIN);
    await createProject(page, '知识验收');
    await importIntoProject(page, pdfPath);

    // ---- Read a page so there is something to build concepts from ----------
    await closeSidePanel(page);
    await page.getByRole('button', { name: '打开智能难点' }).click();
    const difficulty = page.getByRole('complementary', { name: '智能难点' });
    await difficulty.waitFor({ timeout: 10_000 });
    await difficulty.getByRole('button', { name: '启用智能难点标注' }).click();
    await difficulty.getByRole('button', { name: '开始分析' }).click();
    await page.locator('.pdf-suggestion').first().waitFor({ timeout: 25_000 });
    check(
      'reading: the page produced difficulty suggestions to build knowledge from',
      (await page.locator('.pdf-suggestion').count()) > 0,
      `${String(await page.locator('.pdf-suggestion').count())} markers`,
    );

    // ---- Turning a difficulty into a concept, from the card -----------------
    await page.locator('.pdf-suggestion').first().click();
    const card = page.getByRole('dialog', { name: /难点：/ });
    await card.waitFor({ timeout: 5000 });
    await card.getByRole('button', { name: /存为概念/ }).click();
    await page.waitForTimeout(300);

    await toProject(page, '知识验收');
    await openKnowledge(page);
    const list = listOf(page);
    // The name span also holds the status badge, which is on its own line.
    // The name span also holds the status badge; the badge text is not part of the name.
    const firstConcept = (await list.locator('.concept-card-name').first().innerText())
      .replace('待确认', '')
      .replace(/\s+/g, ' ')
      .trim();
    check(
      'concept: a difficulty on the page became a concept in the project',
      firstConcept.length > 0,
      firstConcept,
    );
    check(
      'concept: it is marked as unconfirmed AI output, not as the reader’s own knowledge',
      (await detailOf(page, firstConcept).innerText()).includes('待确认') &&
        (await detailOf(page, firstConcept).innerText()).includes('AI 提出'),
    );

    // ---- Evidence points back at the paper ---------------------------------
    const evidence = detailOf(page, firstConcept).locator('.evidence-row').first();
    await evidence.waitFor({ timeout: 5000 });
    const evidenceText = await evidence.innerText();
    await evidence.getByRole('button', { name: '打开原文' }).click();
    await page.locator('.reader').waitFor({ timeout: 20_000 });
    await page
      .locator('.pdf-highlight[data-spotlight="true"]')
      .first()
      .waitFor({ timeout: 20_000 });
    check(
      'evidence: opening it lands on the paper with the quoted words marked',
      (await page.locator('.pdf-highlight[data-spotlight="true"]').count()) > 0 &&
        evidenceText.includes('第 1 页'),
      evidenceText.replace(/\s+/g, ' ').slice(0, 48),
    );
    await page.screenshot({ path: fileURLToPath(new URL('01-evidence-jump.png', SHOT_DIR)) });

    // ---- Confirm it, then build a dependency -------------------------------
    await toProject(page, '知识验收');
    await openKnowledge(page);
    await detailOf(page, firstConcept).getByRole('button', { name: '确认这个概念' }).click();
    check(
      'concept: confirming removes the unconfirmed badge',
      !(await detailOf(page, firstConcept).innerText()).includes('待确认'),
    );

    await createConcept(page, 'Bilinear pairing', '一种配对运算，KZG 的安全性建立在它之上。');
    // The card's accessible name is its whole text, so this is a substring match on purpose.
    await page.getByLabel('概念列表').getByRole('button', { name: firstConcept }).first().click();
    await page.getByLabel('关系对象').selectOption({ label: 'Bilinear pairing' });
    await page.getByRole('button', { name: '添加关系' }).click();

    const detail = detailOf(page, firstConcept);
    check(
      'navigation: the concept now lists the knowledge it depends on',
      // The first link list is now 所属项目; the prerequisite block is the one named 前置知识.
      (
        await detail
          .locator('.concept-block', { hasText: '前置知识' })
          .first()
          .locator('.concept-links')
          .innerText()
      ).includes('Bilinear pairing'),
    );
    // Exact: the remove button's aria-label also contains the name.
    await detail.getByRole('button', { name: 'Bilinear pairing', exact: true }).first().click();
    check(
      'navigation: and the dependency knows what depends on it',
      (await detailOf(page, 'Bilinear pairing').innerText()).includes(firstConcept),
    );

    // ---- The graph shows what the list shows -------------------------------
    await page.getByRole('button', { name: '关系图' }).click();
    const graph = page.getByRole('group', { name: '概念关系图' });
    await graph.waitFor({ timeout: 5000 });
    check(
      'graph: every concept is a node, and the relation is an edge',
      (await graph.locator('.concept-node').count()) === 2 &&
        (await graph.locator('.concept-edge[data-kind="prerequisite"]').count()) === 1,
      `${String(await graph.locator('.concept-node').count())} nodes, ${String(await graph.locator('.concept-edge').count())} edges`,
    );
    await page.screenshot({ path: fileURLToPath(new URL('02-graph.png', SHOT_DIR)) });
    await page.getByRole('button', { name: '列表' }).click();

    // ---- A duplicate name is not a merge -----------------------------------
    await createConcept(page, firstConcept, '同名但来源不同。');
    check(
      'identity: the same name creates a second concept, not a merge',
      (await page.getByLabel('概念列表').locator('.concept-card').count()) === 3,
      `${String(await page.getByLabel('概念列表').locator('.concept-card').count())} concepts`,
    );

    // ---- Deleting a relation keeps both concepts ---------------------------
    await page.getByLabel('概念列表').getByRole('button', { name: firstConcept }).first().click();
    await detailOf(page, firstConcept)
      .getByRole('button', { name: '删除指向 Bilinear pairing 的前置关系' })
      .click();
    check(
      'deletion: removing a relation leaves both concepts in place',
      (await page.getByLabel('概念列表').locator('.concept-card').count()) === 3 &&
        (await detailOf(page, firstConcept).innerText()).includes('还没有记录它依赖什么'),
    );

    // ---- Dark theme and a narrow window ------------------------------------
    await setAppTheme(page, '深色');
    await page.waitForTimeout(300);
    await page.screenshot({ path: fileURLToPath(new URL('03-knowledge-dark.png', SHOT_DIR)) });
    const darkBox = await page.locator('.knowledge').boundingBox();
    check(
      'layout: the knowledge zone does not overflow in dark mode',
      darkBox !== null && darkBox.width <= 1440,
      `${String(Math.round(darkBox?.width ?? 0))}px wide`,
    );
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
      'layout: the knowledge zone reflows in a narrow window without sideways overflow',
      narrow !== null && narrow.overflow <= 1,
      `${String(Math.round(narrow?.width ?? 0))}px wide, overflow ${String(narrow?.overflow ?? 0)}px`,
    );
    await page.screenshot({ path: fileURLToPath(new URL('04-knowledge-narrow.png', SHOT_DIR)) });
    await page.setViewportSize({ width: 1440, height: 950 });

    // ---- Deleting the project keeps what was learned ----------------------
    // A second project so the app has somewhere to be after the deletion.
    await createProject(page, '第二项目');
    await page.getByRole('button', { name: '管理项目' }).click();
    // The row's delete control names the project, which makes it unambiguous.
    await page.getByRole('button', { name: '删除 知识验收' }).click();
    const confirm = page.getByRole('dialog', { name: '删除项目' });
    await confirm.waitFor({ timeout: 5000 });
    await confirm.getByRole('button', { name: '删除', exact: true }).click();
    await page.waitForTimeout(400);

    const stored = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem('rw.knowledge') ?? 'null'),
    );
    check(
      'deletion: removing the project does not delete the knowledge it contributed',
      stored !== null && stored.concepts.length >= 3,
      `${String(stored?.concepts?.length ?? 0)} concepts still stored`,
    );
    check(
      'deletion: the surviving concepts are unlinked from the deleted project, not removed',
      (stored?.concepts ?? []).every((concept) => concept.projectIds.length === 0),
      `${String((stored?.concepts ?? []).filter((concept) => concept.projectIds.length === 0).length)} unlinked`,
    );

    // ---- Nothing reached the paid service ---------------------------------
    check(
      'safety: the service this run started was the offline mock',
      service.health.provider === 'mock' && service.health.online === false,
      `instance ${String(service.health.instanceId).slice(0, 8)}`,
    );
    check(
      'safety: difficulty analysis ran only against the offline service',
      difficultyRequests.length > 0 &&
        difficultyRequests.every((request) => typeof request?.pageText === 'string'),
      `${String(difficultyRequests.length)} analysis request(s)`,
    );

    const unexpected = consoleIssues.filter(
      (issue) => !/\/api\/ai\/(ask|difficulties)/.test(issue.url) && issue.text.includes('error'),
    );
    check(
      'console: nothing failed unexpectedly',
      unexpected.length === 0,
      `${String(unexpected.length)} unexpected`,
    );
    if (unexpected.length > 0) process.stdout.write(`  ${unexpected[0].text}\n`);
  } catch (error) {
    process.stdout.write(`\n--- the run stopped here ---\n${String(error)}\n`);
    try {
      await page.screenshot({ path: fileURLToPath(new URL('failure.png', SHOT_DIR)) });
      process.stdout.write(
        `screen reads:\n${(await page.evaluate(() => document.body.innerText)).slice(0, 700)}\n`,
      );
      process.stdout.write(
        `detail html:\n${(await page.locator('.concept-detail').first().innerHTML()).slice(0, 1400)}\n`,
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

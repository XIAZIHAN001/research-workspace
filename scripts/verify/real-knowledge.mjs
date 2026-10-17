/* global document */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { requireOfflineProxy } from './offline.mjs';
import { selectSpans } from './text-selection.mjs';
import { buildColourPdf } from './sample-pdf.mjs';

/**
 * A knowledge network built from two real papers, through the ordinary interface.
 *
 * The two papers are the Creative-Commons papers the earlier phases already read (a diffusion
 * language model paper and a time-series language model paper). Every concept below is named
 * after a phrase the paper itself uses, and every occurrence is a quotation selected from the
 * rendered page — nothing here is a mock suggestion, and no model is called.
 *
 * The network is deliberately small but real: one concept (language model) is used by both
 * papers in different ways, two chains of prerequisites are three levels deep, and one concept
 * has no evidence at all, so the interface has to say so rather than look complete.
 */

const PORT = Number(process.env.AI_VERIFY_PREVIEW_PORT ?? 4179);
const AI_PORT = Number(process.env.AI_VERIFY_PORT ?? 8792);
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const AI_ORIGIN = `http://127.0.0.1:${String(AI_PORT)}`;
const ROOT = new URL('../../', import.meta.url);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = new URL(`docs/screenshots-phase7/${RUN_STAMP}-real-knowledge/`, ROOT);
const REPORT_FILE = new URL(
  `docs/screenshots-phase7/${RUN_STAMP}-real-knowledge/report.json`,
  ROOT,
);
const WORK_DIR = new URL('.cache/verify/', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SERVER_ENTRY = fileURLToPath(new URL('server/start.mjs', ROOT));
const PAPER_DLM = new URL('.cache/papers/2610.22294.pdf', ROOT);
const PAPER_TS = new URL('.cache/papers/2610.22327.pdf', ROOT);
const PROJECT = '真实知识网络';
const PROJECT_TS = '时间序列研究';

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
        return { child, health };
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
const toolbarOf = (page) => page.getByRole('toolbar', { name: '批注' });

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

/** Selects the part of `quote` that the rendered text layer covers, and returns what it got. */
async function selectQuote(page, quote, pageNumber) {
  const picked = await page.evaluate(
    ({ needle, pageNumber: number }) => {
      const root = document.querySelector(`.pdf-page[data-page="${String(number)}"]`);
      if (root === null) {
        return {
          miss: true,
          noRoot: true,
          wanted: number,
          pages: [...document.querySelectorAll('.pdf-page')].map((element) =>
            element.getAttribute('data-page'),
          ),
        };
      }
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
      // Spans are text items, not words: the quotation usually starts and ends inside one.
      // Select from the first intersecting span's start to the last one's end; the result is a
      // superset of the quotation, but every character in it is genuinely on the page.
      const touched = [];
      for (let index = 0; index < segments.length; index += 1) {
        const start = starts[index];
        const end = start + segments[index].length;
        if (segments[index] !== '' && start < at + target.length && end > at) touched.push(index);
      }
      if (touched.length === 0) return null;
      const first = touched[0];
      const last = touched[touched.length - 1];
      return {
        start: first,
        end: last,
        endLength: (spans[last]?.textContent ?? '').length,
      };
    },
    { needle: quote, pageNumber },
  );
  if (picked === null) throw new Error('the page has no text layer');
  if (picked.miss === true) {
    throw new Error(
      `the page does not contain the quotation: ${quote.slice(0, 60)}
${JSON.stringify(picked)}`,
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

async function annotate(page, quote, conceptName, pageNumber = 1) {
  await gotoPage(page, pageNumber);
  const selected = await selectQuote(page, quote, pageNumber);
  const toolbar = toolbarOf(page);
  await toolbar.getByRole('button', { name: '笔记' }).click();
  await toolbar.getByLabel('笔记内容').fill(`出处：${conceptName}`);
  await toolbar.getByRole('button', { name: '保存' }).click();
  return selected;
}

async function attachEvidence(page, conceptName, quotePrefix) {
  await cardOf(page, conceptName).click();
  const detail = detailOf(page, conceptName);
  const toggle = detail.getByRole('button', { name: /从笔记里添加出处/ });
  if ((await toggle.count()) > 0) await toggle.click();
  const row = detail.locator('.evidence-picker li').filter({ hasText: quotePrefix }).first();
  await row.waitFor({ timeout: 5000 });
  await row.getByRole('button', { name: '添加' }).click();
}

async function addRelation(page, from, to) {
  await cardOf(page, from).click();
  const detail = detailOf(page, from);
  await detail.getByLabel('关系类型').selectOption({ label: '前置知识' });
  await detail.getByLabel('关系对象').selectOption({ label: to });
  await detail.getByRole('button', { name: '添加关系' }).click();
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
    label: '真实知识网络验收',
  });

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  watch(page);
  const selected = {};

  try {
    await page.goto(ORIGIN);
    await createProject(page, PROJECT);
    await importPaper(page, fileURLToPath(PAPER_DLM));

    // ---- Four quotations from the diffusion paper -------------------------
    selected.lmFromDlm = await annotate(
      page,
      'Diffusion language models (DLMs) offer a natural interface for these tasks because they are not restricted to next-token prediction and can generate tokens anywhere on the shared canvas',
      '语言模型',
      2,
    );
    selected.fewShot = await annotate(
      page,
      'Few-shot prompting is useful when instructions and rewards are hard to specify.',
      '少样本提示',
    );
    selected.diffusion = await annotate(
      page,
      'Masked diffusion language models iteratively unmask positions within a shared canvas, supporting flexible generation orders and parallel decoding',
      '扩散语言模型',
      3,
    );
    selected.multiTarget = await annotate(
      page,
      'We therefore introduce multi-target few-shot prompting with diffusion language models, where examples guide the infilling of multiple masked regions within a shared canvas.',
      '多目标少样本提示',
    );
    check(
      'real paper D: four quotations were selected from its own rendered text',
      Object.values(selected).every((text) => text.length > 40),
      Object.values(selected)
        .map((text) => text.length)
        .join(','),
    );

    // ---- Three quotations from the time-series paper ----------------------
    await toProject(page, PROJECT);
    await importPaper(page, fileURLToPath(PAPER_TS));
    selected.tslm = await annotate(
      page,
      'Time Series Language Models (TSLMs) enable language-based understanding and reasoning over temporal data',
      '时间序列语言模型',
    );
    selected.lmFromTs = await annotate(
      page,
      'Existing TSLMs typically expose the language model to a single representation, imposing a fixed inductive bias across downstream tasks.',
      '语言模型',
    );
    selected.vlm = await annotate(
      page,
      'Recent evaluations further show that simply rendering a time series as a line plot can already provide strong temporal',
      '视觉语言模型',
    );
    check(
      'real paper T: three quotations were selected from its own rendered text',
      [selected.tslm, selected.lmFromTs, selected.vlm].every((text) => text.length > 40),
    );

    // ---- The concepts and their evidence ---------------------------------
    await toProject(page, PROJECT);
    await openKnowledge(page);

    const concepts = [
      ['语言模型', '把序列映射为表示并按上下文生成输出的模型；两篇论文都以它为底座。'],
      ['少样本提示', '用少量示例说明任务，而不必写出完整的指令或奖励函数。'],
      ['扩散语言模型', '通过迭代去掩码在共享画布上生成文本，不受下一个词预测的限制。'],
      ['多目标少样本提示', '让示例引导共享画布上多个掩码区域同时填充的提示方式。'],
      ['时间序列语言模型', '把时间序列作为一种模态输入、用自然语言理解与推理它的模型。'],
      ['视觉语言模型', '同时接收图像与文本的模型；时间序列可以先画成折线图再交给它。'],
      ['并行解码', '在扩散模型中一次解码多个位置的做法（论文提到，尚未链接原文出处）。'],
    ];
    for (const [name, summary] of concepts) await createConcept(page, name, summary);

    await attachEvidence(page, '语言模型', selected.lmFromDlm.slice(0, 30));
    await attachEvidence(page, '语言模型', selected.lmFromTs.slice(0, 30));
    await attachEvidence(page, '少样本提示', selected.fewShot.slice(0, 30));
    await attachEvidence(page, '扩散语言模型', selected.diffusion.slice(0, 30));
    await attachEvidence(page, '多目标少样本提示', selected.multiTarget.slice(0, 30));
    await attachEvidence(page, '时间序列语言模型', selected.tslm.slice(0, 30));
    await attachEvidence(page, '视觉语言模型', selected.vlm.slice(0, 30));

    await addRelation(page, '多目标少样本提示', '少样本提示');
    await addRelation(page, '多目标少样本提示', '扩散语言模型');
    await addRelation(page, '扩散语言模型', '语言模型');
    await addRelation(page, '少样本提示', '语言模型');
    await addRelation(page, '时间序列语言模型', '语言模型');
    await addRelation(page, '时间序列语言模型', '视觉语言模型');
    await addRelation(page, '视觉语言模型', '语言模型');

    await cardOf(page, '语言模型').click();
    const lmDetail = await detailOf(page, '语言模型').innerText();
    const evidencePapers = await detailOf(page, '语言模型')
      .locator('.evidence-row .evidence-paper')
      .allInnerTexts();
    check(
      'one concept, two papers, two different occurrences',
      (await detailOf(page, '语言模型').locator('.evidence-row').count()) === 2 &&
        new Set(evidencePapers).size === 2,
      evidencePapers.join(' / '),
    );
    check(
      'the two occurrences are different quotations, each from its own paper',
      lmDetail.includes(selected.lmFromDlm.slice(0, 24)) &&
        lmDetail.includes(selected.lmFromTs.slice(0, 24)),
    );

    // ---- Multi-level navigation ------------------------------------------
    await cardOf(page, '多目标少样本提示').click();
    await detailOf(page, '多目标少样本提示')
      .getByRole('button', { name: '扩散语言模型', exact: true })
      .click();
    await detailOf(page, '扩散语言模型')
      .getByRole('button', { name: '语言模型', exact: true })
      .click();
    check(
      'navigation: a three-level chain can be walked (multi-target → diffusion → language model)',
      (await detailOf(page, '语言模型').count()) === 1,
    );
    await cardOf(page, '时间序列语言模型').click();
    await detailOf(page, '时间序列语言模型')
      .getByRole('button', { name: '视觉语言模型', exact: true })
      .click();
    await detailOf(page, '视觉语言模型')
      .getByRole('button', { name: '语言模型', exact: true })
      .click();
    check(
      'navigation: the second chain also reaches the shared concept (TSLM → VLM → language model)',
      (await detailOf(page, '语言模型').count()) === 1,
    );

    // ---- The graph and the return from the paper -------------------------
    await page.getByRole('button', { name: '关系图' }).click();
    const graph = page.getByRole('group', { name: '概念关系图' });
    await graph.waitFor();
    check(
      'graph: seven concepts and seven dependencies',
      (await graph.locator('.concept-node').count()) === 7 &&
        (await graph.locator('.concept-edge').count()) === 7,
      `${String(await graph.locator('.concept-node').count())} nodes, ${String(await graph.locator('.concept-edge').count())} edges`,
    );
    await page.screenshot({ path: fileURLToPath(new URL('01-real-graph.png', SHOT_DIR)) });

    await graph.getByRole('button', { name: '多目标少样本提示', exact: true }).click();
    await detailOf(page, '多目标少样本提示')
      .locator('.evidence-row')
      .getByRole('button', { name: '打开原文' })
      .click();
    await page
      .locator('.pdf-highlight[data-spotlight="true"]')
      .first()
      .waitFor({ timeout: 20_000 });
    check(
      'evidence: opening the occurrence lands on the quoted sentence in the paper',
      (await page.locator('.pdf-highlight[data-spotlight="true"]').count()) > 0,
    );
    await toProject(page, PROJECT);
    await page.getByRole('heading', { level: 2, name: '知识' }).waitFor();
    check(
      'returning: the graph and the selected concept are still where they were',
      (await page.locator('.knowledge-body').getAttribute('data-mode')) === 'graph' &&
        (await page.locator('.concept-node[data-selected="true"]').getAttribute('aria-label')) ===
          '多目标少样本提示',
    );
    await page.screenshot({ path: fileURLToPath(new URL('02-multilevel.png', SHOT_DIR)) });

    // ---- A concept with no evidence is marked, not hidden -----------------
    await page.getByRole('button', { name: '列表' }).click();
    await cardOf(page, '并行解码').click();
    const bareDetail = await detailOf(page, '并行解码').innerText();
    check(
      'honesty: a concept without evidence says so in the list and the detail',
      (await cardOf(page, '并行解码').locator('.kb-badge-empty').innerText()) === '尚无出处' &&
        bareDetail.includes('还没有原文出处'),
    );

    // ---- Shared with a second project ------------------------------------
    await createProject(page, PROJECT_TS);
    await toProject(page, PROJECT);
    await openKnowledge(page);
    await cardOf(page, '语言模型').click();
    await detailOf(page, '语言模型')
      .getByRole('combobox', { name: '加入项目' })
      .selectOption({ label: PROJECT_TS });
    await detailOf(page, '语言模型').getByRole('button', { name: '加入项目' }).click();
    await page.getByRole('button', { name: PROJECT_TS }).first().click();
    await page.getByRole('heading', { level: 1, name: PROJECT_TS }).waitFor();
    await openKnowledge(page);
    await page.getByRole('button', { name: '列表' }).click();
    check(
      'cross-project: the same concept is available in the second project',
      (await page.locator('.concept-card').filter({ hasText: '语言模型' }).count()) === 1,
    );
    await cardOf(page, '语言模型').click();
    check(
      'cross-project: the occurrences from both papers are visible there too',
      (await detailOf(page, '语言模型').locator('.evidence-row').count()) === 2,
    );
    await page.screenshot({ path: fileURLToPath(new URL('03-shared-concept.png', SHOT_DIR)) });

    // ---- Replacing the PDF makes the old occurrence stale ----------------
    await toProject(page, PROJECT);
    await page.getByRole('button', { name: '文献', exact: true }).click();
    const tsRow = page.locator('.paper-row').filter({ hasText: '2610.22327' }).first();
    await tsRow.getByRole('button', { name: '替换 PDF' }).click();
    const dialog = page.getByRole('dialog', { name: '导入 PDF 文件' });
    const colour = new URL('colour.pdf', WORK_DIR);
    await writeFile(colour, buildColourPdf());
    await dialog.locator('input[type="file"]').setInputFiles(fileURLToPath(colour));
    await dialog.getByRole('button', { name: '导入' }).click();
    await page.locator('.reader').waitFor({ timeout: 30_000 });
    await toProject(page, PROJECT);
    await openKnowledge(page);
    await page.getByRole('button', { name: '列表' }).click();
    await cardOf(page, '时间序列语言模型').click();
    const staleRow = detailOf(page, '时间序列语言模型').locator('.evidence-row').first();
    await staleRow.waitFor();
    check(
      'replaced file: the old occurrence is kept but cannot jump into the new file',
      (await staleRow.getAttribute('data-stale')) === 'true' &&
        (await staleRow.getByRole('button', { name: '打开原文' }).isDisabled()) &&
        (await staleRow.innerText()).includes('另一个文件版本'),
    );
    await page.screenshot({ path: fileURLToPath(new URL('04-stale-evidence.png', SHOT_DIR)) });

    // ---- Process-level safety -------------------------------------------
    check(
      'safety: the service this run started was the offline mock',
      service.health.provider === 'mock' && service.health.online === false,
      `instance ${String(service.health.instanceId).slice(0, 8)}`,
    );
    check(
      'safety: the knowledge network was built without any assistant request',
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
        papers: ['2610.22294', '2610.22327'],
        selectedQuotes: selected,
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

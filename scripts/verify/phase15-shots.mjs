/**
 * Real-UI screenshots for the PR #2 review round: review card, BibTeX preview, glossary hover
 * and the draft dialog. Serves the production build, drives the installed browser, and writes
 * PNGs into docs/screenshots-phase15/. Evidence only — no assertions.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { assertFreshBuild } from './preview-gate.mjs';
import { buildTwoColumnPdf } from './sample-pdf.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 4191;
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const OUT = `${ROOT}docs/screenshots-phase15/`;
const VITE_BIN = `${ROOT}node_modules/vite/bin/vite.js`;

const CONTEXT = {
  version: 10,
  projects: [
    {
      id: 'p1',
      name: '截图项目',
      corePaperId: 'pa',
      relatedPaperIds: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  papers: {
    pa: {
      id: 'pa',
      title: 'Two Column Paper',
      authors: ['Ada Lovelace'],
      createdAt: 1,
      updatedAt: 2,
    },
  },
  annotations: [
    {
      id: 'an1',
      paperId: 'pa',
      pdfSha256: 'a'.repeat(64),
      page: 1,
      quote: 'The left column carries the main argument of the paper.',
      prefix: '',
      suffix: '',
      rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.02 }],
      kind: 'insight',
      note: '这一段给出了全文的核心论点，后面都在展开它。',
      origin: 'user',
      sourceLabel: '',
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: 'an2',
      paperId: 'pa',
      pdfSha256: 'a'.repeat(64),
      page: 2,
      quote: 'The right column holds the evaluation and the figures.',
      prefix: '',
      suffix: '',
      rects: [{ x: 0.55, y: 0.3, width: 0.4, height: 0.02 }],
      kind: 'question',
      note: '为什么评估只在这一栏？',
      origin: 'user',
      sourceLabel: '',
      createdAt: 2,
      updatedAt: 3,
    },
  ],
  bookmarks: [],
  glossary: [
    {
      id: 'g1',
      paperId: 'pa',
      term: 'LEFT-HEADING',
      definition: '样张里的标记词，用于验证悬停定义卡。',
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  selectedId: 'p1',
};

const KNOWLEDGE = {
  version: 2,
  concepts: [
    {
      id: 'c1',
      name: 'KZG commitment',
      aliases: [],
      summary: '对多项式在单点的常数大小承诺，可验证任意求值。',
      origin: 'user',
      status: 'confirmed',
      projectIds: ['p1'],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  evidence: [
    {
      id: 'e1',
      conceptId: 'c1',
      paperId: 'pa',
      pdfSha256: 'a'.repeat(64),
      page: 1,
      quote: 'The left column carries the main argument of the paper.',
      prefix: '',
      suffix: '',
      rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.02 }],
      source: 'annotation',
      note: '',
      createdAt: 1,
    },
  ],
  relations: [],
  rejections: [],
};

const REVIEW_SEED = {
  version: 1,
  cards: {
    c1: { conceptId: 'c1', ease: 2.5, intervalDays: 0, reps: 0, lapses: 0, dueAt: 0, lastAt: 0 },
  },
};

async function main() {
  await mkdir(`${ROOT}docs/screenshots-phase15`, { recursive: true });
  await writeFile(`${ROOT}.cache/verify/two-column.pdf`, buildTwoColumnPdf());

  assertFreshBuild(import.meta.url);
  const server = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(ORIGIN)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }

  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(
      ([state, knowledge, review]) => {
        const store = globalThis.localStorage;
        store.setItem('rw.projects', state);
        store.setItem('rw.knowledge', knowledge);
        store.setItem('rw.review', review);
        store.setItem('rw.theme', 'light');
      },
      [JSON.stringify(CONTEXT), JSON.stringify(KNOWLEDGE), JSON.stringify(REVIEW_SEED)],
    );
    await page.goto(ORIGIN);

    // ---- 1) Review card ----------------------------------------------------------
    await page.getByRole('button', { name: /^复习/ }).click();
    await page.getByText('KZG commitment').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '显示答案' }).click();
    await page.getByText(/对多项式在单点的常数大小承诺/).waitFor({ timeout: 5000 });
    await page.screenshot({ path: `${OUT}review-card.png` });
    process.stdout.write('review-card.png\n');

    // ---- 2) BibTeX import preview ------------------------------------------------
    const bib = [
      '@article{vaswani2017, title = {Attention Is All You Need}, author = {Vaswani and Shazeer}, year = {2017}, doi = {10.5555/3295222}}',
      '@article{copy2017, title = {A Duplicate}, doi = {10.5555/3295222}}',
      '@article{broken, author = {No Title Here}}',
      '@misc{preprint, title = {A Preprint}, eprint = {2401.12345}}',
    ].join('\n');
    await page.getByRole('button', { name: '论文库' }).click();
    await page.getByRole('button', { name: '导入 BibTeX' }).click();
    await page.getByText('从 BibTeX 导入').waitFor({ timeout: 10000 });
    await page
      .locator('input[type=file]')
      .last()
      .setInputFiles({
        name: 'library.bib',
        mimeType: 'text/plain',
        buffer: Buffer.from(bib, 'utf-8'),
      });
    await page.getByText(/条可导入/).waitFor({ timeout: 10000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}bibtex-import-preview.png` });
    process.stdout.write('bibtex-import-preview.png\n');
    await page.getByRole('button', { name: '取消' }).click();

    // ---- 3) Glossary hover ---------------------------------------------------------
    await page.getByText('截图项目').first().waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '截图项目' }).first().click();
    // The seeded paper has no file: import the sample PDF through the real dialog, which
    // opens the reader on success — the same path a reader would take.
    await page.getByRole('button', { name: '导入 PDF' }).first().click();
    await page.getByText('导入 PDF 文件').waitFor({ timeout: 10000 });
    await page
      .locator('input[type=file]')
      .last()
      .setInputFiles({
        name: 'two-column.pdf',
        mimeType: 'application/pdf',
        buffer: await readFile(`${ROOT}.cache/verify/two-column.pdf`),
      });
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await page.locator('.textLayer span').first().waitFor({ timeout: 30000 });
    const span = page.locator('.textLayer span', { hasText: 'LEFT-HEADING' }).first();
    await span.waitFor({ timeout: 20000 });
    await span.hover();
    await page.getByRole('tooltip').waitFor({ timeout: 5000 });
    await page.screenshot({ path: `${OUT}glossary-hover.png` });
    process.stdout.write('glossary-hover.png\n');
    await page.getByRole('button', { name: '返回' }).click();
    await page.waitForTimeout(300);

    // ---- 4) Draft dialog (offline-mock answer via route interception) ---------------
    await page.route('**/api/ai/ask', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'mock',
          providerLabel: '本地模拟',
          model: 'mock-1',
          online: false,
          mode: 'draft',
          status: 'valid',
          answer: [
            '## 论点一：结构安排',
            '笔记指出第 1 页给出了全文核心论点 [1]，第 2 页是评估部分 [2]。',
            '',
            '## 待弄清',
            '- 读者在 [2] 处留下的疑问：评估为何只占一栏。',
          ].join('\n'),
          groundedInText: true,
          citations: [
            { n: 1, passageId: 'n1', page: 1, quote: 'x', selection: true },
            { n: 2, passageId: 'n2', page: 2, quote: 'y', selection: false },
          ],
          warnings: [],
          diagnostics: {
            rawChars: 100,
            recovery: null,
            citationEntries: 2,
            citationsAccepted: 2,
            citationsRejected: 0,
            finishReason: 'stop',
            truncated: false,
          },
          usage: null,
        }),
      });
    });
    await page.getByRole('button', { name: '全部笔记' }).click();
    await page.getByRole('button', { name: 'AI 整理成稿' }).click();
    await page.getByRole('button', { name: '开始整理' }).click();
    await page.getByText('论点一：结构安排').waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}draft-dialog.png` });
    process.stdout.write('draft-dialog.png\n');
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();

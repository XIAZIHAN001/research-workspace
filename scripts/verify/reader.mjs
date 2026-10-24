/* global document, getComputedStyle, window */
import { spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { buildBrokenPdf, buildSamplePdf } from './sample-pdf.mjs';

/**
 * Browser acceptance for the reader, run against the production build.
 *
 * It drives a real file through the real import path — File API, IndexedDB, pdf.js — and
 * checks what a user would see: pages rendered, navigation, zoom, selectable text, a position
 * that survives a reload, the duplicate-file decision, and the messages shown when a file is
 * refused or when the browser has no database. Screenshots go to `docs/screenshots-reader/`
 * so the Phase 0/1 evidence in `docs/screenshots/` is never touched.
 */

const PORT = 4174;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const ROOT = new URL('../../', import.meta.url);
const SHOT_DIR = new URL('docs/screenshots-reader/', ROOT);
const REPORT_FILE = new URL('docs/reader-verification-report.json', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SAMPLE_FILE = fileURLToPath(new URL('.cache/verify/sample-paper.pdf', ROOT));
const BROKEN_FILE = fileURLToPath(new URL('.cache/verify/broken.pdf', ROOT));

const results = [];
const consoleIssues = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const status = passed ? 'PASS' : 'FAIL';
  process.stdout.write(`${status}  ${name}${detail === '' ? '' : `  (${detail})`}\n`);
}

async function startPreview() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: fileURLToPath(ROOT), stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(ORIGIN);
      if (response.ok) return child;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  child.kill();
  throw new Error('preview server did not start');
}

function watch(page) {
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    // pdf.js reconstructs the xref of the generated sample fixture and says so on every run;
    // the message is about the fixture, not the app, and it never varies.
    if (message.text() === 'Warning: Indexing all PDF objects') return;
    consoleIssues.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    consoleIssues.push(`pageerror: ${error.message}`);
  });
}

const storedPayload = (page) =>
  page.evaluate(() => JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null'));

async function createProject(page, title) {
  await page.getByLabel('新建项目').click();
  await page.getByLabel('核心论文标题').fill(title);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('heading', { level: 1, name: title }).waitFor();
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(fileURLToPath(new URL('.cache/verify/', ROOT)), { recursive: true });
  await writeFile(SAMPLE_FILE, buildSamplePdf());
  await writeFile(BROKEN_FILE, buildBrokenPdf());

  const server = await startPreview();
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  watch(page);

  try {
    await page.goto(ORIGIN);
    await createProject(page, 'Attention Is All You Need');

    // ---- Import a real PDF -------------------------------------------------
    await page.getByRole('button', { name: '导入新论文' }).click();
    const importDialog = page.getByRole('dialog', { name: '导入论文' });
    await importDialog.locator('input[type="file"][data-autofocus]').setInputFiles(SAMPLE_FILE);
    check(
      'import: title is prefilled from the file name',
      (await importDialog.getByRole('textbox', { name: '标题' }).inputValue()) === 'sample paper',
      await importDialog.getByRole('textbox', { name: '标题' }).inputValue(),
    );
    await page.screenshot({ path: fileURLToPath(new URL('01-import-dialog.png', SHOT_DIR)) });
    await importDialog.getByRole('button', { name: '导入' }).click();

    await page.locator('.reader').waitFor({ timeout: 20_000 });
    check('import: the reader opens for the imported paper', true);

    // ---- The page really rendered -----------------------------------------
    await page.locator('.pdf-page[data-page="1"] canvas').waitFor({ timeout: 20_000 });
    await page.locator('.pdf-page[data-page="1"] .textLayer span').first().waitFor({
      timeout: 20_000,
    });
    const firstPageText = await page.locator('.pdf-page[data-page="1"] .textLayer').textContent();
    check(
      'render: page 1 canvas and text layer are present',
      (firstPageText ?? '').includes('MARKER-PAGE-1'),
      `text layer: ${(firstPageText ?? '').trim().slice(0, 40)}…`,
    );
    const canvasSize = await page
      .locator('.pdf-page[data-page="1"] canvas')
      .evaluate((canvas) => ({ width: canvas.clientWidth, height: canvas.clientHeight }));
    check(
      'render: the canvas has a real size',
      canvasSize.width > 100 && canvasSize.height > 100,
      `${String(canvasSize.width)}x${String(canvasSize.height)}`,
    );

    const indicator = page.locator('.reader-page-jump input');
    check('pages: the indicator starts at 1', (await indicator.inputValue()) === '1');

    // ---- Navigation --------------------------------------------------------
    await page.getByRole('button', { name: '下一页' }).click();
    await page.waitForFunction(
      () => document.querySelector('.reader-page-jump input')?.value === '2',
    );
    await page.locator('.pdf-page[data-page="2"] .textLayer span').first().waitFor({
      timeout: 20_000,
    });
    const secondPageText = await page.locator('.pdf-page[data-page="2"] .textLayer').textContent();
    check(
      'pages: the next-page button moves to page 2',
      (secondPageText ?? '').includes('MARKER-PAGE-2'),
    );

    await indicator.fill('3');
    await indicator.press('Enter');
    let jumped = true;
    try {
      await page.waitForFunction(
        () => document.querySelector('.reader-page-jump input')?.value === '3',
        null,
        { timeout: 8000 },
      );
    } catch {
      jumped = false;
    }
    // Whatever happened, say what the page actually looked like.
    const jumpState = await page.evaluate(() => ({
      indicator: document.querySelector('.reader-page-jump input')?.value ?? null,
      scrollTop: Math.round(document.querySelector('.reader-scroll')?.scrollTop ?? -1),
      page3Top: document.querySelector('.pdf-page[data-page="3"]')?.style.top ?? null,
      page3Rendered: document.querySelector('.pdf-page[data-page="3"] canvas') !== null,
      column: document.querySelector('.reader-column')?.style.height ?? null,
    }));
    check('pages: jumping by number reaches page 3', jumped, JSON.stringify(jumpState));
    if (jumpState.page3Rendered) {
      const thirdPageText = await page.locator('.pdf-page[data-page="3"] .textLayer').textContent();
      check(
        'pages: the jumped-to page has its own text',
        (thirdPageText ?? '').includes('MARKER-PAGE-3'),
      );
    }

    // ---- Zoom --------------------------------------------------------------
    await page.getByRole('button', { name: '上一页' }).click();
    await page.waitForFunction(
      () => document.querySelector('.reader-page-jump input')?.value === '2',
    );
    const fitWidth = await page
      .locator('.pdf-page[data-page="2"] canvas')
      .evaluate((canvas) => canvas.clientWidth);
    await page.getByRole('button', { name: '放大' }).click();
    await page.waitForFunction(
      (width) =>
        (document.querySelector('.pdf-page[data-page="2"] canvas')?.clientWidth ?? 0) > width + 5,
      fitWidth,
    );
    const zoomedWidth = await page
      .locator('.pdf-page[data-page="2"] canvas')
      .evaluate((canvas) => canvas.clientWidth);
    check(
      'zoom: zooming in makes the page bigger',
      zoomedWidth > fitWidth,
      `${String(fitWidth)} → ${String(zoomedWidth)}`,
    );

    await page.getByRole('button', { name: '适应宽度' }).click();
    await page.waitForFunction(
      (width) =>
        Math.abs(
          (document.querySelector('.pdf-page[data-page="2"] canvas')?.clientWidth ?? 0) - width,
        ) < 3,
      fitWidth,
    );
    check('zoom: fit-width returns to the container width', true, `${String(fitWidth)}px`);

    // The canvas being present is not the same as the page having been drawn: sample pixels.
    const inkSamples = await page.locator('.pdf-page[data-page="2"] canvas').evaluate((canvas) => {
      const context = canvas.getContext('2d');
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      for (let index = 0; index < data.length; index += 4 * 53) {
        if ((data[index] ?? 255) < 200) dark += 1;
      }
      return dark;
    });
    check(
      'render: the page canvas really has ink on it',
      inkSamples > 0,
      `${String(inkSamples)} dark samples`,
    );

    // ---- Text selection ----------------------------------------------------
    const selected = await page.evaluate(() => {
      const layer = document.querySelector('.pdf-page[data-page="2"] .textLayer');
      if (layer === null) return '';
      const range = document.createRange();
      range.selectNodeContents(layer);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? '';
    });
    check(
      'text: the page text can be selected and copied',
      selected.includes('MARKER-PAGE-2') && selected.includes('selected and copied'),
      selected.replace(/\s+/g, ' ').trim().slice(0, 60),
    );

    // ---- The file is durable, the position is remembered -------------------
    const before = await storedPayload(page);
    const importedPaper = Object.values(before.papers).find((paper) => paper.pdf !== undefined);
    check(
      'storage: the paper records the file hash and page count',
      typeof importedPaper?.pdf?.sha256 === 'string' &&
        importedPaper.pdf.sha256.length === 64 &&
        importedPaper.pdf.pageCount === 3,
      `${String(importedPaper?.pdf?.pageCount ?? '?')} pages`,
    );

    await page.locator('.reader-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForFunction(
      () => document.querySelector('.reader-page-jump input')?.value === '3',
    );
    await sleep(1500); // long enough for the debounced position write
    const saved = await storedPayload(page);
    check(
      'reading position: the page is written to the registry',
      saved.papers[importedPaper.id]?.reading?.page === 3,
      `page ${String(saved.papers[importedPaper.id]?.reading?.page ?? '?')}`,
    );

    // Frame the evidence screenshot on a page whose top is in view.
    await indicator.fill('2');
    await indicator.press('Enter');
    await page.waitForFunction(
      () => document.querySelector('.reader-page-jump input')?.value === '2',
    );
    // The jump animates for about a second; the indicator must not flicker back meanwhile.
    const seen = new Set();
    for (let tick = 0; tick < 8; tick += 1) {
      seen.add(await indicator.inputValue());
      await sleep(120);
    }
    check(
      'pages: the indicator stays on the jumped-to page while it animates',
      seen.size === 1 && seen.has('2'),
      `saw ${[...seen].join(', ')}`,
    );
    const geometry = await page.evaluate(() => {
      const scroll = document.querySelector('.reader-scroll');
      const pageElement = document.querySelector('.pdf-page[data-page="2"]');
      const scrollBox = scroll?.getBoundingClientRect();
      const pageBox = pageElement?.getBoundingClientRect();
      return {
        scroll:
          scrollBox === undefined
            ? null
            : [
                Math.round(scrollBox.left),
                Math.round(scrollBox.top),
                Math.round(scrollBox.width),
                Math.round(scrollBox.height),
              ],
        page:
          pageBox === undefined
            ? null
            : [
                Math.round(pageBox.left),
                Math.round(pageBox.top),
                Math.round(pageBox.width),
                Math.round(pageBox.height),
              ],
        scrollTop: Math.round(scroll?.scrollTop ?? -1),
      };
    });
    const visible =
      geometry.scroll !== null &&
      geometry.page !== null &&
      geometry.page[1] < geometry.scroll[1] + geometry.scroll[3] &&
      geometry.page[1] + geometry.page[3] > geometry.scroll[1] &&
      geometry.page[0] < geometry.scroll[0] + geometry.scroll[2] &&
      geometry.page[0] + geometry.page[2] > geometry.scroll[0];
    check(
      'layout: the current page sits inside the visible area',
      visible,
      JSON.stringify(geometry),
    );
    await page.screenshot({ path: fileURLToPath(new URL('02-reader-light.png', SHOT_DIR)) });

    // ---- Dark theme --------------------------------------------------------
    await setAppTheme(page, '深色');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    const pageBackground = await page
      .locator('.pdf-page[data-page="3"]')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.screenshot({ path: fileURLToPath(new URL('03-reader-dark.png', SHOT_DIR)) });
    // Phase 5 changed this on purpose: the paper follows the reading mode instead of staying
    // white, and the original mode is the escape hatch back to a white page.
    check(
      'theme: the page follows the reading mode in dark mode',
      pageBackground !== 'rgb(255, 255, 255)',
      pageBackground,
    );
    // The paper modes live in the toolbar's trigger menu (Phase 5): open it, then pick.
    await page.getByRole('button', { name: /纸张模式/ }).click();
    await page.getByRole('option', { name: /^原始\s/ }).click();
    await page.waitForTimeout(300);
    const originalBackground = await page
      .locator('.pdf-page[data-page="3"]')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    check(
      'theme: the original paper mode still gives a white page in dark mode',
      originalBackground === 'rgb(255, 255, 255)',
      originalBackground,
    );
    await page.getByRole('button', { name: /纸张模式/ }).click();
    await page.getByRole('option', { name: /^跟随外观\s/ }).click();
    await setAppTheme(page, '浅色');

    // Leave the reader on page 3 and wait for the debounced write before reloading.
    await indicator.fill('3');
    await indicator.press('Enter');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await storedPayload(page);
      if (current.papers[importedPaper.id]?.reading?.page === 3) break;
      await sleep(200);
    }

    // ---- Reopening after a reload -----------------------------------------
    await page.reload();
    await page.getByRole('button', { name: 'Attention Is All You Need' }).first().click();
    await page.getByRole('button', { name: '阅读' }).click();
    await page.locator('.pdf-page[data-page="3"] .textLayer span').first().waitFor({
      timeout: 20_000,
    });
    check(
      'reopen: the reader returns to the page it left',
      (await indicator.inputValue()) === '3',
      `page ${await indicator.inputValue()}`,
    );
    const reopenedText = await page.locator('.pdf-page[data-page="3"] .textLayer').textContent();
    check(
      'reopen: the stored file loads again without picking it a second time',
      (reopenedText ?? '').includes('MARKER-PAGE-3'),
    );

    // ---- The same file a second time --------------------------------------
    await page.getByRole('button', { name: '返回' }).click();
    const secondPage = await page.getByRole('dialog', { name: '导入论文' }).count();
    check('flow: no import dialog is left open after importing', secondPage === 0);

    await page.getByRole('button', { name: '导入新论文' }).click();
    const duplicateDialog = page.getByRole('dialog', { name: '导入论文' });
    await duplicateDialog.locator('input[type="file"][data-autofocus]').setInputFiles(SAMPLE_FILE);
    await duplicateDialog.getByRole('button', { name: '导入' }).click();
    const decision = duplicateDialog.getByText(/同一份文件不代表同一篇论文/);
    await decision.waitFor({ timeout: 10_000 });
    await page.screenshot({ path: fileURLToPath(new URL('04-duplicate-decision.png', SHOT_DIR)) });
    check('duplicate: the same file asks before reusing a paper', true);

    await duplicateDialog.getByRole('button', { name: '仍然新建一篇论文' }).click();
    await page.locator('.reader').waitFor({ timeout: 20_000 });
    const afterDuplicate = await storedPayload(page);
    const withFiles = Object.values(afterDuplicate.papers).filter(
      (paper) => paper.pdf !== undefined,
    );
    check(
      'duplicate: two papers can share one stored file',
      withFiles.length === 2 && withFiles[0].pdf.sha256 === withFiles[1].pdf.sha256,
      `${String(withFiles.length)} papers, ${String(new Set(withFiles.map((p) => p.pdf.sha256)).size)} stored file`,
    );

    // ---- A file that is not a PDF -----------------------------------------
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('button', { name: '导入新论文' }).click();
    const brokenDialog = page.getByRole('dialog', { name: '导入论文' });
    await brokenDialog.locator('input[type="file"][data-autofocus]').setInputFiles(BROKEN_FILE);
    await brokenDialog.getByRole('button', { name: '导入' }).click();
    const refusal = brokenDialog.getByRole('alert');
    await refusal.waitFor({ timeout: 10_000 });
    const refusalText = await refusal.textContent();
    await page.screenshot({ path: fileURLToPath(new URL('05-invalid-file.png', SHOT_DIR)) });
    const afterRefusal = await storedPayload(page);
    check(
      'invalid file: it is refused with a plain explanation and nothing is stored',
      (refusalText ?? '').includes('不是一个 PDF 文件') &&
        Object.keys(afterRefusal.papers).length === Object.keys(afterDuplicate.papers).length,
      (refusalText ?? '').trim(),
    );
    await brokenDialog.getByRole('button', { name: '取消' }).click();

    // ---- The library -------------------------------------------------------
    await page.getByRole('button', { name: '论文库', exact: true }).click();
    await page.getByRole('region', { name: '论文库' }).waitFor();
    const rows = await page.getByRole('article').count();
    check(
      'library: every paper is listed',
      rows === Object.keys(afterRefusal.papers).length,
      `${String(rows)} rows`,
    );
    await page.screenshot({ path: fileURLToPath(new URL('06-library.png', SHOT_DIR)) });

    // ---- No browser database ----------------------------------------------
    const noDb = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const noDbPage = await noDb.newPage();
    watch(noDbPage);
    await noDbPage.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        get() {
          throw new Error('IndexedDB is blocked in this context');
        },
      });
    });
    await noDbPage.goto(ORIGIN);
    await createProject(noDbPage, 'No Storage Project');
    await noDbPage.getByRole('button', { name: '导入新论文' }).click();
    const noDbDialog = noDbPage.getByRole('dialog', { name: '导入论文' });
    await noDbDialog.locator('input[type="file"][data-autofocus]').setInputFiles(SAMPLE_FILE);
    await noDbDialog.getByRole('button', { name: '导入' }).click();
    const storageAlert = noDbDialog.getByRole('alert');
    await storageAlert.waitFor({ timeout: 10_000 });
    const storageText = await storageAlert.textContent();
    await noDbPage.screenshot({
      path: fileURLToPath(new URL('07-storage-unavailable.png', SHOT_DIR)),
    });
    const noDbPayload = await storedPayload(noDbPage);
    check(
      'storage unavailable: the user is told, and no PDF is recorded',
      (storageText ?? '').includes('不支持本地文件库') &&
        Object.values(noDbPayload.papers).every((paper) => paper.pdf === undefined),
      (storageText ?? '').trim(),
    );
    await noDb.close();

    // ---- Console -----------------------------------------------------------
    check(
      'console: no errors, warnings or page exceptions',
      consoleIssues.length === 0,
      consoleIssues.slice(0, 3).join(' | '),
    );
  } finally {
    await browser.close();
    server.kill();
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  await writeFile(
    REPORT_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
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

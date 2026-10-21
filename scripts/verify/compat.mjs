/* global document, window */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import {
  buildLongPdf,
  buildRichTextPdf,
  buildScannedPdf,
  buildTextlessPdf,
  buildTwoColumnPdf,
} from './sample-pdf.mjs';

/**
 * Reader compatibility run: what the reader actually does with paper-shaped PDFs.
 *
 * Each fixture is a generated but genuinely valid file with the layout it is named after —
 * two columns, special characters and scripts, a scan, a long document. The measurements come
 * from the rendered text layer in a real browser, because that is what text anchors are built
 * from; anything taken from the PDF alone would not tell us whether selection works.
 *
 * Results are measurements, not opinions: text order, span counts, selection geometry, and how
 * many pages the reader keeps rendered at once. Screenshots go to docs/screenshots-phase3/.
 */

const PORT = 4175;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const ROOT = new URL('../../', import.meta.url);
const SHOT_DIR = new URL('docs/screenshots-phase3/', ROOT);
const REPORT_FILE = new URL('docs/compat-verification-report.json', ROOT);
const WORK_DIR = new URL('.cache/verify/', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));

const results = [];
const measurements = {};

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
}

async function startPreview() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: fileURLToPath(ROOT), stdio: 'ignore' },
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

/** Imports one fixture into a fresh workspace and returns the page handle sitting in the reader. */
async function openFixture(browser, filePath, title) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(ORIGIN);
  await page.getByLabel('新建项目').click();
  await page.getByLabel('核心论文标题').fill(title);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('button', { name: '导入新论文' }).click();
  const dialog = page.getByRole('dialog', { name: '导入论文' });
  await dialog.locator('input[type="file"][data-autofocus]').setInputFiles(filePath);
  await dialog.getByRole('button', { name: '导入' }).click();
  await page.locator('.reader').waitFor({ timeout: 20_000 });
  await page.locator('.pdf-page[data-page="1"] .textLayer').waitFor({ timeout: 20_000 });
  // The page is ready either when its text layer has spans, or when the reader has decided
  // there is nothing to extract and said so.
  await page.waitForFunction(
    () => {
      const root = document.querySelector('.pdf-page[data-page="1"]');
      return (
        root?.querySelector('.textLayer span') !== null ||
        root?.querySelector('.pdf-page-hint') !== null
      );
    },
    null,
    { timeout: 20_000 },
  );
  return { context, page };
}

/** Everything the reader shows for one page, read from the DOM. */
const pageProbe = (page, pageNumber) =>
  page.evaluate((number) => {
    const root = document.querySelector(`.pdf-page[data-page="${number}"]`);
    const spans = [...(root?.querySelectorAll('.textLayer span') ?? [])];
    const canvas = root?.querySelector('canvas');
    return {
      spanCount: spans.length,
      text: spans.map((span) => span.textContent ?? '').join(''),
      rendered: canvas !== null && canvas !== undefined,
      hint: root?.querySelector('.pdf-page-hint')?.textContent?.trim() ?? null,
    };
  }, pageNumber);

/** Selects a run of characters across spans and reports what the browser selected and where. */
function selectRange(page, pageNumber, from, to) {
  return page.evaluate(
    ({ number, start, end }) => {
      const root = document.querySelector(`.pdf-page[data-page="${number}"]`);
      const spans = [...(root?.querySelectorAll('.textLayer span') ?? [])];
      const nodes = spans.flatMap((span) => [...span.childNodes]);
      const length = nodes.reduce((total, node) => total + (node.textContent?.length ?? 0), 0);
      if (length === 0) return null;
      const locate = (offset) => {
        let seen = 0;
        for (const node of nodes) {
          const size = node.textContent?.length ?? 0;
          if (seen + size >= offset) return { node, offset: Math.max(0, offset - seen) };
          seen += size;
        }
        const last = nodes.at(-1);
        return last === undefined ? null : { node: last, offset: last.textContent?.length ?? 0 };
      };
      const first = locate(Math.min(start, end));
      const last = locate(Math.max(start, end));
      if (first === null || last === null) return null;
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const rects = [...range.getClientRects()].map((rect) => ({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
      }));
      return {
        text: selection?.toString() ?? '',
        rectCount: rects.length,
        rects: rects.slice(0, 6),
      };
    },
    { number: pageNumber, start: from, end: to },
  );
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(fileURLToPath(WORK_DIR), { recursive: true });

  const fixtures = {
    twoColumn: { file: 'two-column.pdf', title: 'Two Column', buffer: buildTwoColumnPdf() },
    richText: { file: 'rich-text.pdf', title: 'Rich Text', buffer: buildRichTextPdf() },
    scanned: { file: 'scanned.pdf', title: 'Scanned Page', buffer: buildScannedPdf() },
    textless: { file: 'textless.pdf', title: 'Textless Page', buffer: buildTextlessPdf() },
    long: { file: 'long.pdf', title: 'Long Document', buffer: buildLongPdf(24) },
  };
  const paths = {};
  for (const [key, fixture] of Object.entries(fixtures)) {
    paths[key] = fileURLToPath(new URL(fixture.file, WORK_DIR));
    await writeFile(paths[key], fixture.buffer);
  }

  const server = await startPreview();
  const browser = await launchBrowser();

  try {
    // ---- Two columns, multi-line text ------------------------------------
    {
      const { context, page } = await openFixture(
        browser,
        paths.twoColumn,
        fixtures.twoColumn.title,
      );
      const probe = await pageProbe(page, 1);
      const left = probe.text.indexOf('LEFT-HEADING');
      const right = probe.text.indexOf('RIGHT-HEADING');
      const rightEnd = probe.text.indexOf('when text is extracted in order.');
      measurements.twoColumn = { spanCount: probe.spanCount, text: probe.text };
      check(
        'two columns: every line becomes a span in the text layer',
        probe.spanCount >= 11,
        `${String(probe.spanCount)} spans`,
      );
      check(
        'two columns: extraction keeps each column together, left before right',
        left >= 0 && right > left && rightEnd > right,
        `left@${String(left)} right@${String(right)} rightEnd@${String(rightEnd)}`,
      );

      // The offsets come from the text that is actually rendered, not from a guess.
      const firstLine = 'The left column starts here and';
      const lastLine = 'of the same column without';
      const from = probe.text.indexOf(firstLine);
      const to = probe.text.indexOf(lastLine) + lastLine.length;
      const selection = await selectRange(page, 1, from, to);
      measurements.twoColumnSelection = selection;
      check(
        'two columns: a drag across five lines selects exactly those lines',
        selection !== null &&
          selection.text.includes(firstLine) &&
          selection.text.includes(lastLine) &&
          !selection.text.includes('RIGHT-HEADING') &&
          selection.rectCount >= 4,
        `${String(selection?.rectCount ?? 0)} line boxes: ${JSON.stringify(selection?.text ?? '')}`,
      );
      await page.screenshot({ path: fileURLToPath(new URL('01-compat-two-column.png', SHOT_DIR)) });
      await context.close();
    }

    // ---- Special characters, scripts, tables, images ---------------------
    {
      const { context, page } = await openFixture(browser, paths.richText, fixtures.richText.title);
      const probe = await pageProbe(page, 1);
      measurements.richText = { spanCount: probe.spanCount, text: probe.text };
      const text = probe.text;
      const occurrences = text.split('REPEATED-SENTENCE-ALPHA').length - 1;
      check(
        'special characters survive into the text layer',
        text.includes('°C') &&
          text.includes('± 0.5') &&
          text.includes('× 4 ÷ 2') &&
          text.includes('§ 12'),
        'degree, plus-minus, times, divide, section',
      );
      check(
        'typographic punctuation survives into the text layer',
        text.includes('–') && text.includes('—') && text.includes('…') && text.includes('“'),
        'en dash, em dash, ellipsis, curly quote',
      );
      check('a symbol-font run comes through as Greek letters', text.includes('αβγδ'), 'αβγδ');
      check(
        'a non-embedded CJK font comes through as Chinese',
        text.includes('中文测试'),
        '中文测试',
      );
      check(
        'a sentence repeated on one page stays two separate occurrences',
        occurrences === 2,
        `${String(occurrences)} occurrences`,
      );
      check('the page with an image and a table still renders', probe.rendered);
      await page.screenshot({ path: fileURLToPath(new URL('02-compat-rich-text.png', SHOT_DIR)) });
      await context.close();
    }

    // ---- A scan, and a page with no text at all --------------------------
    {
      const { context, page } = await openFixture(browser, paths.scanned, fixtures.scanned.title);
      const probe = await pageProbe(page, 1);
      measurements.scanned = { spanCount: probe.spanCount, text: probe.text, hint: probe.hint };
      check(
        'a scanned page keeps its caption text and nothing else',
        probe.text.includes('photograph') && !probe.text.includes('REPEATED'),
        `${String(probe.spanCount)} spans`,
      );
      await page.screenshot({ path: fileURLToPath(new URL('03-compat-scanned.png', SHOT_DIR)) });
      await context.close();
    }
    {
      const { context, page } = await openFixture(browser, paths.textless, fixtures.textless.title);
      const probe = await pageProbe(page, 1);
      measurements.textless = { spanCount: probe.spanCount, hint: probe.hint };
      check(
        'a page with no text layer renders, has no spans, and says why',
        probe.rendered && probe.spanCount === 0 && (probe.hint ?? '').includes('没有可提取的文字'),
        `hint: ${probe.hint ?? 'none'}`,
      );
      await page.screenshot({ path: fileURLToPath(new URL('04-compat-textless.png', SHOT_DIR)) });
      await context.close();
    }

    // ---- A long document -------------------------------------------------
    {
      const { context, page } = await openFixture(browser, paths.long, fixtures.long.title);
      const total = await page.locator('.reader-page-total').textContent();
      const rendered = await page.evaluate(
        () => document.querySelectorAll('.pdf-page canvas').length,
      );
      const probe = await pageProbe(page, 1);
      measurements.long = {
        total,
        rendered,
        firstPageHasMarker: probe.text.includes('LONGPAGE-1'),
      };
      check(
        'a 24 page document opens with the right page count',
        (total ?? '').includes('24'),
        total ?? '',
      );
      check(
        'a long document keeps only a few pages rendered at once',
        rendered > 0 && rendered <= 3,
        `${String(rendered)} canvases for 24 pages`,
      );
      await page.screenshot({ path: fileURLToPath(new URL('05-compat-long.png', SHOT_DIR)) });
      await context.close();
    }
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
        measurements,
        note: 'All fixtures are generated files (see scripts/verify/sample-pdf.mjs). No real paper PDF was used.',
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\n${String(passed)} passed, ${String(failed)} failed.\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();

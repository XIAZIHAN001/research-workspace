/* global document, window */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { clearSelection, selectSpans, unionBox } from './text-selection.mjs';

/**
 * What the reader does with real papers.
 *
 * Everything in Phase 2 and Phase 3 was checked against PDFs this repository generated. They are
 * genuinely valid files, but they are also ones we chose, laid out the way we chose, which is
 * exactly the kind of evidence that stops being worth anything the moment a real paper arrives.
 * This script is the counterweight: it drives the reader over papers fetched from arXiv under a
 * Creative Commons licence, and measures the same things — column order, selection geometry,
 * what the extraction recovered, and whether a highlight still lands on the same words after a
 * reload and a zoom.
 *
 * The files stay in `.cache/papers/` and are never committed. If they are absent, the run says
 * so and reports the result as unverified rather than quietly substituting a generated file.
 *
 * Usage:  node scripts/verify/real-paper.mjs
 * Fetch:  node scripts/verify/fetch-papers.mjs
 */

const PORT = 4178;
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const ROOT = new URL('../../', import.meta.url);
const SHOT_DIR = new URL('docs/screenshots-phase4/', ROOT);
const REPORT_FILE = new URL('docs/phase4-real-paper-report.json', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const STORAGE_KEY = 'rw.projects';

/** Papers with an explicit CC-BY 4.0 licence, downloaded once and kept out of Git. */
const PAPERS = [
  {
    file: new URL('.cache/papers/2610.22294.pdf', ROOT),
    arxivId: '2610.22294',
    licence: 'CC BY 4.0',
    note: '33 pages, two columns, equations and figures',
  },
  {
    file: new URL('.cache/papers/2610.22350.pdf', ROOT),
    arxivId: '2610.22350',
    licence: 'CC BY 4.0',
    note: '14 pages, two columns, 8 figures, 4 tables',
  },
];

const results = [];
const measurements = {};
const consoleIssues = [];

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

const payloadOf = (page) =>
  page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? 'null'), STORAGE_KEY);

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
  await page.locator('.reader').waitFor({ timeout: 60_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 60_000 });
}

async function gotoPage(page, number) {
  const input = page.locator('.reader-page-jump input');
  await input.fill(String(number));
  await input.press('Enter');
  await page
    .locator(`.pdf-page[data-page="${String(number)}"] .textLayer span`)
    .first()
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
}

const toolbarOf = (page) => page.getByRole('toolbar', { name: '批注' });

async function selectForToolbar(page, pageNumber, start, end) {
  const selection = await selectSpans(page, pageNumber, start, end);
  await page.mouse.move(5, 5);
  await page
    .locator(`.pdf-page[data-page="${String(pageNumber)}"]`)
    .first()
    .dispatchEvent('mouseup');
  await toolbarOf(page).waitFor({ timeout: 10_000 });
  return selection;
}

/**
 * The measurements a real paper makes possible, all taken from the rendered page.
 *
 * `spanInk` is the one that earns its keep: for every span of the text layer it samples the
 * canvas directly beneath it and asks whether anything is actually drawn there. A PDF whose
 * extracted text has drifted away from its glyphs — the failure that would make every highlight
 * land on the wrong words — shows up here and almost nowhere else.
 */
function measurePage(page, pageNumber) {
  return page.evaluate((number) => {
    const root = document.querySelector(`.pdf-page[data-page="${String(number)}"]`);
    if (root === null) return null;
    const box = root.getBoundingClientRect();
    const canvas = root.querySelector('canvas');
    const spans = [...root.querySelectorAll('.textLayer span')].filter(
      (span) => span.querySelector('span') === null && (span.textContent ?? '').trim() !== '',
    );

    const text = [...root.querySelectorAll('.textLayer span')]
      .map((span) => span.textContent ?? '')
      .join(' ');

    const lines = new Map();
    const centres = [];
    for (const span of spans) {
      const rect = span.getBoundingClientRect();
      const key = Math.round(rect.top / Math.max(4, rect.height * 0.6));
      lines.set(key, (lines.get(key) ?? 0) + 1);
      centres.push((rect.left + rect.right) / 2);
    }

    let ink = null;
    if (canvas !== null) {
      const context = canvas.getContext('2d');
      const scaleX = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
      const scaleY = canvas.height / Math.max(1, canvas.getBoundingClientRect().height);
      let inked = 0;
      let total = 0;
      let spansWithInk = 0;
      let spansChecked = 0;
      for (const span of spans) {
        if ((span.textContent ?? '').trim().length < 3) continue;
        const rect = span.getBoundingClientRect();
        const x = Math.max(0, Math.floor((rect.left - box.left) * scaleX));
        const y = Math.max(0, Math.floor((rect.top - box.top) * scaleY));
        const w = Math.max(1, Math.ceil(rect.width * scaleX));
        const h = Math.max(1, Math.ceil(rect.height * scaleY));
        if (x + w > canvas.width || y + h > canvas.height) continue;
        const data = context.getImageData(x, y, w, h).data;
        let dark = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index] < 200) dark += 1;
        }
        spansChecked += 1;
        if (dark > 0) spansWithInk += 1;
      }
      // Whole-page ink, so "the page rendered" is a measurement rather than an assumption.
      const pageData = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < pageData.length; index += 4) {
        total += 1;
        if (pageData[index] < 200) inked += 1;
      }
      ink = { spansChecked, spansWithInk, pageInk: total === 0 ? 0 : inked / total };
    }

    // Ligatures and unmapped glyphs are how a broken extraction shows itself in the text.
    const ligatures = (text.match(/[ﬀ-ﬆ]/g) ?? []).length;
    const unmapped = (text.match(/\(cid:\d+\)|�/g) ?? []).length;
    const maths = (text.match(/[∀-⋿Ͱ-Ͽ∑√×±≤≥∈∂∇]/g) ?? []).length;

    return {
      spans: spans.length,
      lines: lines.size,
      centreSpread: centres.length === 0 ? 0 : Math.max(...centres) - Math.min(...centres),
      pageWidth: box.width,
      chars: text.length,
      ligatures,
      unmapped,
      maths,
      ink,
    };
  }, pageNumber);
}

/** The highlight boxes of an annotation, as fractions of the page box. */
function relativeBoxes(page, pageNumber, annotationId) {
  return page.evaluate(
    ({ number, id }) => {
      const root = document.querySelector(`.pdf-page[data-page="${String(number)}"]`);
      if (root === null) return [];
      const box = root.getBoundingClientRect();
      return [...root.querySelectorAll(`.pdf-highlight[data-annotation="${id}"]`)].map(
        (element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: (rect.left - box.left) / box.width,
            top: (rect.top - box.top) / box.height,
            right: (rect.right - box.left) / box.width,
            bottom: (rect.bottom - box.top) / box.height,
          };
        },
      );
    },
    { number: pageNumber, id: annotationId },
  );
}

/**
 * The longest run of consecutive text spans that lies wholly in one column.
 *
 * Text extraction order on a real two-column page follows the content stream, which does not
 * have to keep a column together. Choosing a selection by index alone would therefore measure a
 * range that jumps the gutter, so the range is chosen by where the spans actually are.
 */
function columnRunOf(page, pageNumber) {
  return page.evaluate((number) => {
    const root = document.querySelector(`.pdf-page[data-page="${String(number)}"]`);
    if (root === null) return null;
    const box = root.getBoundingClientRect();
    const half = box.left + box.width / 2;
    const left = [];
    [...root.querySelectorAll('.textLayer span')].forEach((span, index) => {
      if (span.querySelector('span') !== null) return;
      if ((span.textContent ?? '').trim() === '') return;
      if (span.getBoundingClientRect().right <= half) left.push(index);
    });
    let best = null;
    let start = null;
    let previous = null;
    for (const index of left) {
      if (previous === null || index === previous + 1) {
        if (start === null) start = index;
      } else {
        if (best === null || previous - start > best[1] - best[0]) best = [start, previous];
        start = index;
      }
      previous = index;
    }
    if (
      start !== null &&
      previous !== null &&
      (best === null || previous - start > best[1] - best[0])
    ) {
      best = [start, previous];
    }
    if (best === null || best[1] - best[0] < 3) return null;
    return { from: best[0], to: best[1] };
  }, pageNumber);
}

/**
 * Extracts every page of a paper with pdf.js alone, without the app.
 *
 * The browser checks can only speak for the pages they opened. This walks all of them and counts
 * what the extraction produced — characters, unmapped glyphs, ligature artefacts and mathematics
 * — so the report can make a claim about the whole document instead of a sample.
 */
async function scanCorpus(filePath) {
  // pdf.js validates that a factory url ends in a forward slash, and `path.join` strips one.
  const dist = join(process.cwd(), 'node_modules', 'pdfjs-dist');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl: `${dist}/standard_fonts/`,
    cMapUrl: `${dist}/cmaps/`,
    cMapPacked: true,
  });
  const doc = await task.promise;
  const totals = {
    pages: doc.numPages,
    chars: 0,
    maths: 0,
    unmapped: 0,
    ligatures: 0,
    emptyPages: 0,
  };
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str ?? '').join(' ');
    totals.chars += text.length;
    totals.maths += (text.match(/[∀-⋿Ͱ-Ͽ∑√×±≤≥∈∂∇]/g) ?? []).length;
    totals.unmapped += (text.match(/\(cid:\d+\)|�/g) ?? []).length;
    totals.ligatures += (text.match(/[ﬀ-ﬆ]/g) ?? []).length;
    if (text.trim().length < 20) totals.emptyPages += 1;
    page.cleanup();
  }
  await task.destroy();
  return totals;
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });

  const available = PAPERS.filter((paper) => existsSync(fileURLToPath(paper.file)));
  if (available.length === 0) {
    // Saying "unverified" is the whole point of this script existing.
    await writeFile(
      REPORT_FILE,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          status: 'unverified',
          reason: 'no real paper in .cache/papers/ — run scripts/verify/fetch-papers.mjs',
          results: [],
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write('UNVERIFIED  no real paper present; nothing was measured.\n');
    process.stdout.write('            run: node scripts/verify/fetch-papers.mjs\n');
    return;
  }

  const server = await startPreview();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleIssues.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    consoleIssues.push(`pageerror: ${error.message}`);
  });
  page.on('crash', () => {
    consoleIssues.push('page crashed');
  });
  browser.on('disconnected', () => {
    consoleIssues.push('browser disconnected');
  });

  try {
    await page.goto(ORIGIN);

    for (const [index, paper] of available.entries()) {
      const label = `arXiv:${paper.arxivId}`;
      const file = fileURLToPath(paper.file);
      const bytes = (await readFile(file)).length;
      await createProject(page, label);
      await importPaper(page, file);
      const readerTitle = await page.locator('.reader-title').innerText();
      const stored = Object.values((await payloadOf(page)).papers).find(
        (entry) => entry.title === readerTitle,
      );
      check(
        `${label}: imported and opened`,
        stored?.pdf?.bytes === bytes,
        `${String(Math.round(bytes / 1024))} KB, ${String(stored?.pdf?.pageCount ?? '?')} pages, open as “${readerTitle}”`,
      );

      // ---- What the page is actually made of ------------------------------
      await gotoPage(page, 1);
      const first = await measurePage(page, 1);
      measurements[label] = { page1: first };

      check(
        `${label}: the first page renders ink and extracts text`,
        first !== null && first.ink.pageInk > 0.005 && first.chars > 200,
        `${String(first?.chars ?? 0)} chars, ${String(((first?.ink.pageInk ?? 0) * 100).toFixed(1))}% of the page is ink`,
      );
      check(
        `${label}: the text layer sits on top of the glyphs it claims to be`,
        first !== null &&
          first.ink.spansChecked > 0 &&
          first.ink.spansWithInk === first.ink.spansChecked,
        `${String(first?.ink.spansWithInk ?? 0)}/${String(first?.ink.spansChecked ?? 0)} spans have ink under them`,
      );
      check(
        `${label}: the layout is two columns`,
        first !== null && first.centreSpread > first.pageWidth * 0.2,
        `span boxes span ${String(Math.round(first?.centreSpread ?? 0))}px of a ${String(Math.round(first?.pageWidth ?? 0))}px page`,
      );

      // ---- Cross-line selection inside one column -------------------------
      // Spans are chosen by geometry, not by index: on a real two-column paper the extraction
      // order is not guaranteed to keep a column together, and picking indices blindly would
      // just measure a selection that crosses the gutter.
      const columnRun = await columnRunOf(page, 1);
      const acrossLines =
        columnRun === null
          ? null
          : await selectForToolbar(
              page,
              1,
              { span: columnRun.from, offset: 0 },
              { span: columnRun.to, offset: 999 },
            );
      check(
        `${label}: a single-column run of spans exists to select`,
        columnRun !== null && acrossLines !== null,
        columnRun === null
          ? 'no run of consecutive spans lies wholly inside one column'
          : `spans ${String(columnRun.from)}–${String(columnRun.to)}`,
      );
      const acrossBoxes = await page.evaluate(() => {
        const selection = window.getSelection();
        if (selection === null || selection.rangeCount === 0) return [];
        return [...selection.getRangeAt(0).getClientRects()].map((rect) => ({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        }));
      });
      const union = unionBox(acrossBoxes);
      const pageBox = await page.evaluate((number) => {
        const rect = document
          .querySelector(`.pdf-page[data-page="${String(number)}"]`)
          .getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      }, 1);
      check(
        `${label}: a cross-line selection stays inside one column`,
        union !== null && union.right - union.left < pageBox.width * 0.55,
        `${String(acrossBoxes.length)} line boxes, ${String(Math.round((((union?.right ?? 0) - (union?.left ?? 0)) / pageBox.width) * 100))}% of the page wide`,
      );
      // The text the reader captured has to be the text the browser says is selected — the app
      // reads it back out of the page's own index, and this is where those two could diverge.
      const browserText = await page.evaluate(() => window.getSelection()?.toString() ?? '');
      const same = (one, other) =>
        one.replace(/\s+/g, ' ').trim() === other.replace(/\s+/g, ' ').trim();
      check(
        `${label}: the captured selection is the text the browser selected`,
        acrossLines !== null && same(acrossLines.text, browserText) && browserText.length > 20,
        `${String(browserText.trim().split(/\s+/).length)} words, ${String(browserText.length)} chars`,
      );

      // ---- Saving it, and finding it again --------------------------------
      await toolbarOf(page).getByRole('button', { name: '高亮' }).click();
      const saved = (await payloadOf(page)).annotations.at(-1);
      check(
        `${label}: the highlight is stored against the paper and the file`,
        saved?.pdfSha256 === stored?.pdf?.sha256 && saved?.page === 1,
      );

      const before = await relativeBoxes(page, 1, saved.id);
      await page.reload();
      await page.getByRole('button', { name: label }).first().click();
      await page.getByRole('button', { name: '阅读' }).first().click();
      await page.locator('.pdf-page[data-page="1"] .textLayer span').first().waitFor({
        timeout: 60_000,
      });
      await page.waitForTimeout(700);
      const after = await relativeBoxes(page, 1, saved.id);
      const reloadDrift = Math.max(
        ...before.map((box, position) => {
          const other = after[position];
          if (other === undefined) return 1;
          return Math.max(
            Math.abs(box.left - other.left),
            Math.abs(box.top - other.top),
            Math.abs(box.right - other.right),
            Math.abs(box.bottom - other.bottom),
          );
        }),
      );
      const afterState = await page.evaluate(() => ({
        title: document.querySelector('.reader-title')?.textContent ?? '',
        page: document.querySelector('.reader-page-jump input')?.value ?? '',
        highlights: document.querySelectorAll('.pdf-highlight[data-annotation]').length,
        noteCount: document.querySelectorAll('.note-item').length,
      }));
      check(
        `${label}: the highlight is on the same words after a reload`,
        before.length > 0 && before.length === after.length && reloadDrift < 0.002,
        `${String(before.length)} boxes before, ${String(after.length)} after` +
          ` (page ${afterState.page} of “${afterState.title}”, ${String(afterState.highlights)} highlights, ${String(afterState.noteCount)} notes in the panel)`,
      );

      for (const [direction, arrow] of [
        ['out', '缩小'],
        ['in', '放大'],
      ]) {
        void direction;
        await page.getByLabel(arrow).click();
      }
      await page.waitForTimeout(700);
      const zoomed = await relativeBoxes(page, 1, saved.id);
      const zoomDrift = Math.max(
        ...before.map((box, position) => {
          const other = zoomed[position];
          if (other === undefined) return 1;
          return Math.max(
            Math.abs(box.left - other.left),
            Math.abs(box.top - other.top),
            Math.abs(box.right - other.right),
            Math.abs(box.bottom - other.bottom),
          );
        }),
      );
      check(
        `${label}: the highlight is on the same words after zooming`,
        zoomed.length === before.length && zoomDrift < 0.002,
        `worst drift ${(zoomDrift * 1000).toFixed(1)}‰ of the page`,
      );

      // ---- A later page, to prove this is not a one-page trick ------------
      const last = Math.min(stored?.pdf?.pageCount ?? 1, index === 0 ? 7 : 5);
      await gotoPage(page, last);
      const later = await measurePage(page, last);
      measurements[label].laterPage = { page: last, ...later };
      check(
        `${label}: page ${String(last)} extracts text the same way`,
        later !== null &&
          later.chars > 200 &&
          later.ink.spansWithInk === later.ink.spansChecked &&
          later.unmapped === 0,
        `${String(later?.chars ?? 0)} chars, ${String(later?.unmapped ?? 0)} unmapped glyphs`,
      );
      check(
        `${label}: the extraction has no ligature or replacement artefacts`,
        first.ligatures === 0 && first.unmapped === 0 && later.unmapped === 0,
        `${String(first.ligatures)} ligatures, ${String(first.unmapped)} unmapped on page 1`,
      );
      await page.screenshot({
        path: fileURLToPath(
          new URL(`2${String(index)}-real-${paper.arxivId}-page${String(last)}.png`, SHOT_DIR),
        ),
      });

      // ---- Back to the project for the next paper -------------------------
      const corpus = await scanCorpus(file);
      measurements[label].corpus = corpus;
      check(
        `${label}: every page of the document extracts without unmapped glyphs`,
        corpus.unmapped === 0 && corpus.emptyPages === 0,
        `${String(corpus.pages)} pages, ${String(corpus.chars)} chars, ${String(corpus.maths)} maths symbols, ${String(corpus.unmapped)} unmapped, ${String(corpus.emptyPages)} empty`,
      );

      await page.getByRole('button', { name: '返回' }).click();
      await clearSelection(page);
    }

    // ---- What the corpus as a whole was -----------------------------------
    const corpus = available.map((paper) => ({
      id: paper.arxivId,
      ...(measurements[`arXiv:${paper.arxivId}`]?.corpus ?? {}),
    }));
    check(
      'papers: the corpus is real research prose, with mathematics in it',
      corpus.every((entry) => (entry.maths ?? 0) > 0 && (entry.chars ?? 0) > 10_000),
      corpus
        .map(
          (entry) =>
            `${entry.id}: ${String(entry.maths ?? 0)} maths symbols in ${String(entry.chars ?? 0)} chars`,
        )
        .join(', '),
    );

    check(
      'console: no errors, warnings or page exceptions',
      consoleIssues.length === 0,
      consoleIssues.slice(0, 3).join(' | '),
    );
  } catch (error) {
    // Whatever went wrong, the browser's own account of it is the most useful thing to print.
    process.stdout.write(`
run failed: ${String(error)}
`);
    for (const issue of consoleIssues.slice(-12))
      process.stdout.write(`  ${issue}
`);
    throw error;
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
        status: failed === 0 ? 'real papers verified' : 'real papers checked, failures above',
        papers: available.map((paper) => ({
          arxivId: paper.arxivId,
          licence: paper.licence,
          note: paper.note,
        })),
        passed,
        failed,
        results,
        measurements,
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

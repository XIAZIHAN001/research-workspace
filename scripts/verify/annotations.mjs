/* global document, getComputedStyle, window */
import { spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { buildRichTextPdf, buildTwoColumnPdf } from './sample-pdf.mjs';
import {
  boxDistance,
  clearSelection,
  highlightBoxes,
  selectSpans,
  spanTexts,
  unionBox,
} from './text-selection.mjs';

/**
 * Browser acceptance for highlights and notes.
 *
 * It drives the real reader: selects real text in a rendered page, saves it, writes a note,
 * reloads, and checks that the highlight lands on the same words — by geometry, not just by a
 * DOM node existing. Screenshots go to docs/screenshots-phase3/.
 */

const PORT = 4176;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const ROOT = new URL('../../', import.meta.url);
const SHOT_DIR = new URL(
  `docs/screenshots-phase3/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-annotations/`,
  ROOT,
);
const REPORT_FILE = new URL('report.json', SHOT_DIR);
const WORK_DIR = new URL('.cache/verify/', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const STORAGE_KEY = 'rw.projects';

const results = [];
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

function watch(page) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleIssues.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    consoleIssues.push(`pageerror: ${error.message}`);
  });
}

/**
 * The highlight's box as a fraction of the page element, which is the only way to compare
 * positions across a reload or a zoom: viewport coordinates move with the scroll.
 */
function relativeHighlightBox(page, annotationId) {
  return page.evaluate((id) => {
    const pageElement = document.querySelector('.pdf-page[data-page="1"]');
    if (pageElement === null) return null;
    const pageBox = pageElement.getBoundingClientRect();
    const boxes = [...document.querySelectorAll(`.pdf-highlight[data-annotation="${id}"]`)].map(
      (element) => element.getBoundingClientRect(),
    );
    if (boxes.length === 0 || pageBox.width === 0) return null;
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return {
      left: (left - pageBox.left) / pageBox.width,
      top: (top - pageBox.top) / pageBox.height,
      right: (right - pageBox.left) / pageBox.width,
      bottom: (bottom - pageBox.top) / pageBox.height,
    };
  }, annotationId);
}

const payloadOf = (page) =>
  page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? 'null'), STORAGE_KEY);

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
  await page.locator('.reader').waitFor({ timeout: 20_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 20_000 });
}

/** Opens the paper of the current project in the reader again (after a reload, say). */
async function reopenReader(page, projectName) {
  await page.getByRole('button', { name: projectName }).first().click();
  await page.getByRole('button', { name: '阅读' }).first().click();
  await page.locator('.reader').waitFor({ timeout: 20_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 20_000 });
}

/** The floating toolbar over a selection. Scoped, because the reader bar has a "笔记" too. */
const toolbarOf = (page) => page.getByRole('toolbar', { name: '批注' });

/** The merged table of contents, which carries bookmarks and notes since 37493ba. */
const outlinePanelOf = (page) => page.getByRole('complementary', { name: '论文目录' });

/** Opens the outline from the rail when it is folded; waits for it either way. */
async function openOutline(page) {
  if ((await outlinePanelOf(page).count()) === 0) {
    await page.getByRole('button', { name: '打开目录、书签和笔记' }).click();
  }
  await outlinePanelOf(page).waitFor({ timeout: 5000 });
}

/** The note row whose excerpt contains the given text. */
const noteMark = (page, text) =>
  outlinePanelOf(page).locator('.outline-mark[data-kind="note"]').filter({ hasText: text });

/** Selects the given span/offset range and waits for the reader's toolbar to appear. */
async function selectForAnnotation(page, pageNumber, start, end) {
  const selection = await selectSpans(page, pageNumber, start, end);
  await page.mouse.move(5, 5); // a stray mouseup would clear the selection
  await page.locator('.pdf-page[data-page="1"]').first().dispatchEvent('mouseup');
  await page.locator('.annotation-toolbar').waitFor({ timeout: 5000 });
  return selection;
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(fileURLToPath(WORK_DIR), { recursive: true });
  const twoColumn = fileURLToPath(new URL('two-column.pdf', WORK_DIR));
  const richText = fileURLToPath(new URL('rich-text.pdf', WORK_DIR));
  await writeFile(twoColumn, buildTwoColumnPdf());
  await writeFile(richText, buildRichTextPdf());

  const server = await startPreview();
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  watch(page);

  try {
    await page.goto(ORIGIN);
    await createProject(page, 'Two Column Paper');
    await importIntoProject(page, twoColumn);

    // ---- Anchoring a selection -------------------------------------------
    // Five lines of the left column: "The left column starts here and" … "without".
    const selection = await selectForAnnotation(
      page,
      1,
      { span: 1, offset: 0 },
      { span: 5, offset: 26 },
    );
    await page.screenshot({ path: fileURLToPath(new URL('10-annotation-toolbar.png', SHOT_DIR)) });
    check(
      'selection: the toolbar appears over a multi-line selection',
      await page.locator('.annotation-toolbar').isVisible(),
      (selection?.text ?? '').replace(/\s+/g, ' ').slice(0, 48),
    );

    await toolbarOf(page).getByRole('button', { name: '高亮' }).click();

    const annotations = await page.evaluate((key) => {
      const payload = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return payload.annotations ?? [];
    }, STORAGE_KEY);
    const created = annotations[0];
    const firstPageSha = await page.evaluate((key) => {
      const payload = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      const paper = Object.values(payload.papers).find((candidate) => candidate.pdf !== undefined);
      return paper.pdf.sha256;
    }, STORAGE_KEY);

    check(
      'highlight: exactly one annotation was saved',
      annotations.length === 1,
      `${String(annotations.length)}`,
    );
    check(
      'highlight: it records the file hash, the page and the text',
      created?.pdfSha256 === firstPageSha &&
        created?.page === 1 &&
        typeof created.quote === 'string' &&
        created.quote.includes('The left column starts here and') &&
        created.quote.includes('without'),
      `page ${String(created?.page ?? '?')}, ${String(created?.quote?.length ?? 0)} chars, hash ${created?.pdfSha256 === firstPageSha ? 'matches' : 'differs'}, hasHead ${String(created?.quote?.includes('The left column starts here and'))}, hasTail ${String(created?.quote?.includes('without'))}, quote "${String(created?.quote ?? '').slice(0, 40)}…${String(created?.quote ?? '').slice(-24)}"`,
    );
    check(
      'highlight: it keeps context on both sides of the quote',
      (created?.prefix ?? '').length > 0 && (created?.suffix ?? '').length > 0,
      `prefix "${created?.prefix ?? ''}" suffix "${created?.suffix ?? ''}"`,
    );
    check(
      'highlight: the boxes are stored as fractions of the page',
      Array.isArray(created?.rects) &&
        created.rects.length >= 4 &&
        created.rects.every(
          (rect) =>
            rect.x >= 0 &&
            rect.x <= 1 &&
            rect.y >= 0 &&
            rect.y <= 1 &&
            rect.width > 0 &&
            rect.height > 0,
        ),
      `${String(created?.rects?.length ?? 0)} boxes`,
    );

    // ---- The boxes really cover the selected words ------------------------
    const drawn = await highlightBoxes(page, created.id);
    const drawnUnion = unionBox(drawn);
    const wanted = unionBox(selection?.boxes ?? []);
    const distance = boxDistance(drawnUnion, wanted);
    check(
      'highlight: what is drawn sits exactly on the selected text',
      drawn.length >= 4 && distance <= 3,
      `${String(drawn.length)} boxes, worst edge off by ${distance.toFixed(1)}px`,
    );

    // The same text, selected again, must give the same box: the anchor is not guesswork.
    const reselection = await selectSpans(page, 1, { span: 1, offset: 0 }, { span: 5, offset: 26 });
    check(
      'highlight: selecting the same lines again reproduces the same box',
      boxDistance(unionBox(reselection?.boxes ?? []), wanted) <= 1,
      `off by ${boxDistance(unionBox(reselection?.boxes ?? []), wanted).toFixed(1)}px`,
    );
    await clearSelection(page);

    // ---- A note on a fresh selection -------------------------------------
    await selectForAnnotation(page, 1, { span: 6, offset: 0 }, { span: 6, offset: 18 });
    await toolbarOf(page).getByRole('button', { name: '笔记' }).click();
    await toolbarOf(page).getByRole('button', { name: '理解' }).click();
    await toolbarOf(page).getByLabel('笔记内容').fill('右栏和左栏的阅读顺序不一样。');
    await toolbarOf(page).getByRole('button', { name: '保存' }).click();

    // The notes live in the table of contents since 37493ba; open it from the rail.
    await openOutline(page);
    const outline = outlinePanelOf(page);
    const createdRow = noteMark(page, '右栏和左栏的阅读顺序不一样。');
    check(
      'note: the outline lists both marks with kind and page',
      (await outline.locator('.outline-mark[data-kind="note"]').count()) === 2 &&
        (await createdRow.count()) === 1 &&
        ((await createdRow.locator('.outline-mark-kind').textContent()) ?? '').trim() === '理解' &&
        /第 1 页/.test((await createdRow.locator('.outline-mark-page').textContent()) ?? ''),
      `${String(await outline.locator('.outline-mark[data-kind="note"]').count())} marks`,
    );
    await page.screenshot({ path: fileURLToPath(new URL('11-annotations-light.png', SHOT_DIR)) });

    // ---- Clicking a note goes back to its text ---------------------------
    const secondQuote = await outline
      .locator('.outline-mark[data-kind="note"]')
      .first()
      .locator('.outline-mark-text')
      .textContent();
    await outline
      .locator('.outline-mark[data-kind="note"]')
      .first()
      .locator('.outline-mark-main')
      .click();
    await page.waitForFunction(
      () => document.querySelector('.reader-page-jump input')?.value === '1',
    );
    const flashed = await page.evaluate(
      () => document.querySelectorAll('.pdf-highlight[data-flash="true"]').length,
    );
    check(
      'notes: going back to a note marks the highlight it belongs to',
      flashed > 0,
      `first note is about "${(secondQuote ?? '').slice(0, 30)}…"`,
    );

    // ---- Editing a note ---------------------------------------------------
    const editRow = noteMark(page, '右栏和左栏的阅读顺序不一样。');
    // The row's actions reveal on hover or keyboard focus — hover is the mouse path.
    await editRow.hover();
    await editRow.getByRole('button', { name: /编辑/ }).click();
    // Editing happens in place: one form per row, Enter or 保存笔记 commits.
    const editForm = outline.locator('.outline-mark-edit--note');
    await editForm.getByRole('textbox').fill('改成：为什么先左后右。');
    await editForm.getByRole('button', { name: '保存笔记' }).click();
    const edited = await payloadOf(page);
    const editedNote = edited.annotations.find((entry) => entry.note === '改成：为什么先左后右。');
    check(
      'notes: an edit is saved in place and keeps its kind',
      editedNote?.kind === 'insight',
      `${String(editedNote?.kind ?? '?')} / ${String(editedNote?.note ?? '')}`,
    );

    // ---- Export: the notes leave as Markdown ------------------------------
    const downloadPromise = page.waitForEvent('download');
    await outline.getByRole('button', { name: '导出笔记' }).click();
    const download = await downloadPromise;
    const exportPath = fileURLToPath(new URL('notes-export.md', WORK_DIR));
    await download.saveAs(exportPath);
    const exported = await readFile(exportPath, 'utf8');
    check(
      'export: the notes leave as Markdown carrying the note text',
      download.suggestedFilename().endsWith('.md') &&
        exported.includes('改成：为什么先左后右。') &&
        exported.includes('The left column starts here and'),
      download.suggestedFilename(),
    );

    // ---- Reload: same highlight, same place ------------------------------
    // Measured relative to the page: viewport coordinates move with the scroll, and only the
    // position on the page says anything about where the highlight sits.
    const beforeReload = await relativeHighlightBox(page, created.id);
    await page.reload();
    await reopenReader(page, 'Two Column Paper');
    const afterReload = await highlightBoxes(page, created.id);
    const afterReloadRelative = await relativeHighlightBox(page, created.id);
    check(
      'reload: the highlight is drawn again in the same place on the page',
      afterReload.length >= 4 && boxDistance(afterReloadRelative, beforeReload) <= 0.005,
      `off by ${(boxDistance(afterReloadRelative, beforeReload) * 1000).toFixed(1)}‰ of the page`,
    );
    await openOutline(page);
    check(
      'reload: the notes are still listed in the outline',
      (await outlinePanelOf(page).locator('.outline-mark[data-kind="note"]').count()) === 2,
      `${String(await outlinePanelOf(page).locator('.outline-mark[data-kind="note"]').count())} marks`,
    );

    // ---- Zoom: the highlight follows the page ----------------------------
    const widthBefore = await page
      .locator('.pdf-page[data-page="1"] canvas')
      .evaluate((canvas) => canvas.clientWidth);
    await page.getByRole('button', { name: '放大' }).click();
    await page.waitForFunction(
      (before) => {
        const canvas = document.querySelector('.pdf-page[data-page="1"] canvas');
        return canvas !== null && canvas.clientWidth > before + 5;
      },
      widthBefore,
      { timeout: 10_000 },
    );
    const zoomedWidth = await page
      .locator('.pdf-page[data-page="1"] canvas')
      .evaluate((canvas) => canvas.clientWidth);
    const zoomedRelative = await relativeHighlightBox(page, created.id);
    check(
      'zoom: the page grows and the highlight stays on the same words',
      boxDistance(zoomedRelative, beforeReload) <= 0.005,
      `${String(widthBefore)}px → ${String(zoomedWidth)}px, box off by ${(boxDistance(zoomedRelative, beforeReload) * 1000).toFixed(1)}‰`,
    );
    // Zooming rebuilds the text layer; wait for it to settle before re-selecting the words.
    let zoomedSelection = await selectSpans(
      page,
      1,
      { span: 1, offset: 0 },
      { span: 5, offset: 26 },
    );
    for (
      let attempt = 0;
      attempt < 10 && (zoomedSelection?.boxes?.length ?? 0) === 0;
      attempt += 1
    ) {
      await sleep(400);
      zoomedSelection = await selectSpans(page, 1, { span: 1, offset: 0 }, { span: 5, offset: 26 });
    }
    const zoomedDrawn = unionBox(await highlightBoxes(page, created.id));
    check(
      'zoom: the drawn boxes still match a fresh selection of the same words',
      boxDistance(zoomedDrawn, unionBox(zoomedSelection?.boxes ?? [])) <= 3,
      `off by ${boxDistance(zoomedDrawn, unionBox(zoomedSelection?.boxes ?? [])).toFixed(1)}px`,
    );
    await clearSelection(page);
    await page.getByRole('button', { name: '适应宽度' }).click();

    // ---- Dark theme ------------------------------------------------------
    await setAppTheme(page, '深色');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    const highlightPaint = await page
      .locator('.pdf-highlight')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.screenshot({ path: fileURLToPath(new URL('12-annotations-dark.png', SHOT_DIR)) });
    check(
      'theme: the highlight is still painted in dark mode',
      highlightPaint.startsWith('rgba(') || highlightPaint.startsWith('rgb('),
      highlightPaint,
    );
    await setAppTheme(page, '浅色');

    // ---- The same paper in another project -------------------------------
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('button', { name: '论文库', exact: true }).click();
    await page.getByLabel('新建项目').click();
    const createDialog = page.getByRole('dialog', { name: '新建项目' });
    await createDialog.getByLabel('核心论文标题').fill('Second Project');
    await createDialog.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '论文库', exact: true }).click();
    const library = page.getByRole('region', { name: '论文库' });
    const repeatedRow = () =>
      library.getByRole('article').filter({ hasText: 'Repeated Sentence Paper' });
    // The paper that carries the PDF: the second project starts with a paper of its own, and
    // the library lists every paper, so pick by the row that holds the file.
    // Matched on the file name: every row's note mentions the project called "Two Column Paper".
    const fileRow = () => library.getByRole('article').filter({ hasText: 'two-column.pdf' });
    const secondProjectId = await page.evaluate((key) => {
      const payload = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return payload.projects.find((project) => project.name === 'Second Project').id;
    }, STORAGE_KEY);
    // The picker lives behind the row's overflow menu: open it, choose "加入项目", then pick.
    await fileRow().getByRole('button', { name: '更多操作' }).click();
    await fileRow().getByRole('menuitem', { name: '加入项目' }).click();
    const picker = fileRow().getByLabel('选择要加入的项目');
    await picker.selectOption(secondProjectId);
    check(
      'library: the project picker takes the chosen project',
      (await picker.inputValue()) === secondProjectId,
      `picker on ${String(await picker.inputValue()).slice(0, 8)}…`,
    );
    await fileRow().getByRole('button', { name: '加入' }).click();
    await page.getByRole('button', { name: 'Second Project' }).first().click();
    await page.getByRole('button', { name: '阅读' }).first().click();
    await openOutline(page);
    check(
      'reuse: opening the same paper from another project shows the same notes',
      (await outlinePanelOf(page).locator('.outline-mark[data-kind="note"]').count()) === 2 &&
        (await highlightBoxes(page, created.id)).length >= 4,
      `${String(await outlinePanelOf(page).locator('.outline-mark[data-kind="note"]').count())} marks`,
    );

    // ---- Repeated text: no guessing --------------------------------------
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('button', { name: '论文库', exact: true }).click();
    await library.getByRole('button', { name: '导入论文' }).click();
    const importDialog = page.getByRole('dialog', { name: '导入论文' });
    await importDialog.locator('input[type="file"][data-autofocus]').setInputFiles(richText);
    await importDialog.getByRole('textbox', { name: '标题' }).fill('Repeated Sentence Paper');
    await importDialog.getByRole('button', { name: '导入' }).click();
    await page.locator('.reader').waitFor({ timeout: 20_000 });
    await page
      .locator('.pdf-page[data-page="1"] .textLayer span')
      .first()
      .waitFor({ timeout: 20_000 });

    // A highlight on the *second* of two identical sentences in the rich-text fixture.
    const spans = await spanTexts(page, 1);
    const repeatIndex = spans.findIndex((text) =>
      text.startsWith('REPEATED-SENTENCE-ALPHA on this page.'),
    );
    const secondRepeat = spans.findIndex(
      (text, index) =>
        index > repeatIndex && text.startsWith('REPEATED-SENTENCE-ALPHA on this page.'),
    );
    check(
      'repeated text: the fixture really has the sentence twice',
      repeatIndex >= 0 && secondRepeat > repeatIndex,
      `spans ${String(repeatIndex)} and ${String(secondRepeat)}`,
    );

    await selectForAnnotation(
      page,
      1,
      { span: secondRepeat, offset: 0 },
      { span: secondRepeat, offset: 25 },
    );
    // Saving the highlight closes the toolbar, so the note is written in one pass.
    await toolbarOf(page).getByRole('button', { name: '笔记' }).click();
    await toolbarOf(page).getByLabel('笔记内容').fill('这里是第二次出现。');
    await toolbarOf(page).getByRole('button', { name: '保存' }).click();
    const repeatedPayload = await payloadOf(page);
    const repeated = repeatedPayload.annotations.find(
      (entry) => entry.note === '这里是第二次出现。',
    );
    check(
      'repeated text: the stored context is enough to tell the two apart',
      (repeated?.prefix ?? '').length > 0 || (repeated?.suffix ?? '').length > 0,
      `prefix "${repeated?.prefix ?? ''}"`,
    );

    await openOutline(page);
    await outlinePanelOf(page)
      .locator('.outline-mark[data-kind="note"]')
      .first()
      .locator('.outline-mark-main')
      .click();
    await sleep(300);
    const ambiguousNotice = await page.getByText(/出现了多次/).count();
    check(
      'repeated text: the context resolves it, so no ambiguity is reported',
      ambiguousNotice === 0,
    );

    // Now an anchor with no context at all: the reader must refuse to guess.
    await page.evaluate(
      ({ key, note }) => {
        const payload = JSON.parse(window.localStorage.getItem(key) ?? 'null');
        const target = payload.annotations.find((entry) => entry.note === note);
        target.prefix = '';
        target.suffix = '';
        window.localStorage.setItem(key, JSON.stringify(payload));
      },
      { key: STORAGE_KEY, note: '这里是第二次出现。' },
    );
    await page.reload();
    await reopenReader(page, 'Two Column Paper');
    await page.getByRole('button', { name: '论文库', exact: true }).click();
    await repeatedRow().getByRole('button', { name: '阅读' }).click();
    await page
      .locator('.pdf-page[data-page="1"] .textLayer span')
      .first()
      .waitFor({ timeout: 20_000 });
    await openOutline(page);
    await outlinePanelOf(page)
      .locator('.outline-mark[data-kind="note"]')
      .first()
      .locator('.outline-mark-main')
      .click();
    const ambiguity = page.getByText(/出现了多次/);
    await ambiguity.waitFor({ timeout: 5000 });
    await page.screenshot({
      path: fileURLToPath(new URL('13-annotation-ambiguous.png', SHOT_DIR)),
    });
    check('repeated text: an anchor without context is reported, not guessed', true);

    // ---- Replacing the file keeps the notes, but not on the new pages -----
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('button', { name: '论文库', exact: true }).click();
    await repeatedRow().getByRole('button', { name: '更多操作' }).click();
    await repeatedRow()
      .getByRole('menuitem', { name: /替换 PDF/ })
      .click();
    const replaceDialog = page.getByRole('dialog', { name: '导入 PDF 文件' });
    await replaceDialog.locator('input[type="file"][data-autofocus]').setInputFiles(twoColumn);
    await replaceDialog.getByRole('button', { name: '导入' }).click();
    await page.locator('.reader').waitFor({ timeout: 20_000 });
    await openOutline(page);
    const afterReplace = await payloadOf(page);
    check(
      'replacement: the old notes are still stored',
      afterReplace.annotations.some((entry) => entry.note === '这里是第二次出现。'),
    );
    check(
      'replacement: they are listed as belonging to another file, and not drawn',
      (await page.getByText(/另一份 PDF 上的笔记/).count()) === 1 &&
        (await page.locator('.pdf-highlight').count()) === 0,
      `${String(await page.locator('.pdf-highlight').count())} highlights drawn`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL('14-annotation-other-file.png', SHOT_DIR)),
    });

    // ---- Deleting asks first ---------------------------------------------
    const staleRow = outlinePanelOf(page).locator('.outline-mark[data-stale]').first();
    await staleRow.hover();
    await staleRow.getByRole('button', { name: /删除/ }).click();
    const confirm = page.getByRole('dialog', { name: '删除笔记' });
    await confirm.waitFor({ timeout: 5000 });
    await confirm.getByRole('button', { name: '取消' }).click();
    const stillThere = await payloadOf(page);
    check(
      'delete: cancelling keeps the note',
      stillThere.annotations.length === afterReplace.annotations.length,
    );
    await staleRow.hover();
    await staleRow.getByRole('button', { name: /删除/ }).click();
    await page
      .getByRole('dialog', { name: '删除笔记' })
      .getByRole('button', { name: '删除' })
      .click();
    const afterDelete = await payloadOf(page);
    check(
      'delete: confirming removes exactly that note',
      afterDelete.annotations.length === afterReplace.annotations.length - 1,
      `${String(afterReplace.annotations.length)} → ${String(afterDelete.annotations.length)}`,
    );

    // ---- Knowledge loop: note → concept evidence → back to the paper ------
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('button', { name: 'Two Column Paper' }).first().click();
    await page
      .getByRole('group', { name: '项目内容' })
      .getByRole('button', { name: '知识' })
      .click();
    await page.getByRole('button', { name: '新建概念' }).click();
    const conceptName = page.getByRole('textbox', { name: '概念名称' });
    await conceptName.fill('双栏阅读顺序');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    // The new concept opens; its first evidence comes from the note written earlier.
    await page.getByRole('button', { name: '从笔记里添加出处' }).click();
    await page.getByRole('button', { name: '添加', exact: true }).first().click();
    await page.locator('.evidence-row').first().waitFor({ timeout: 5000 });
    await page.screenshot({
      path: fileURLToPath(new URL('15-knowledge-evidence.png', SHOT_DIR)),
    });
    check(
      'knowledge: a note can be filed as a concept evidence',
      (await page.locator('.evidence-row').count()) === 1,
      `${String(await page.locator('.evidence-row').count())} rows`,
    );

    // The evidence opens the paper on the exact words the note anchored.
    await page.getByRole('button', { name: '打开原文' }).click();
    await page.locator('.reader').waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelector('.reader-page-jump input')?.value === '1',
    );
    // The focus jump lands after the page's text layer is ready, so wait for the mark.
    await page.locator('.pdf-highlight[data-spotlight="true"]').first().waitFor({ timeout: 8000 });
    check(
      'knowledge: the evidence opens the paper and marks the quoted words',
      (await page.locator('.pdf-highlight[data-spotlight="true"]').count()) > 0,
    );

    // A restart keeps the concept, the evidence and the jump.
    await page.reload();
    await page.getByRole('button', { name: 'Two Column Paper' }).first().click();
    await page
      .getByRole('group', { name: '项目内容' })
      .getByRole('button', { name: '知识' })
      .click();
    await page
      .getByRole('button', { name: /双栏阅读顺序/ })
      .first()
      .click();
    await page.locator('.evidence-row').first().waitFor({ timeout: 10_000 });
    check(
      'knowledge: the concept and its evidence survive a restart',
      (await page.locator('.evidence-row').count()) === 1,
    );
    await page.getByRole('button', { name: '打开原文' }).click();
    await page.locator('.reader').waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelector('.reader-page-jump input')?.value === '1',
    );
    await page.locator('.pdf-highlight[data-spotlight="true"]').first().waitFor({ timeout: 8000 });
    check(
      'knowledge: the evidence jump still works after a restart',
      (await page.locator('.pdf-highlight[data-spotlight="true"]').count()) > 0,
    );

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
    `${JSON.stringify({ generatedAt: new Date().toISOString(), passed, failed, results, consoleIssues }, null, 2)}\n`,
  );
  process.stdout.write(`\n${String(passed)} passed, ${String(failed)} failed.\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();

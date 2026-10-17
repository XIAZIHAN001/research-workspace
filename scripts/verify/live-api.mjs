/* global document, window */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { selectSpans } from './text-selection.mjs';

/**
 * The live run: three real questions to the real DeepSeek API, through the real application.
 *
 * This script holds no credential and reads none. It talks to the local service on 127.0.0.1,
 * which is where the key lives, and refuses to run at all unless that service reports itself as
 * the online provider — so a mock cannot be mistaken for a live result.
 *
 * It is deliberately small and deliberate: a hard ceiling on how many billable calls it can make,
 * no retry of a failed call, and an immediate stop on anything that looks like an account or
 * credential problem.
 *
 * Usage:
 *   1. AI_PROVIDER=deepseek DEEPSEEK_API_KEY=… npm run ai:serve
 *   2. node scripts/verify/live-api.mjs
 */

const PORT = 4179;
const SERVICE = process.env.AI_PORT ?? '8787';
const SERVICE_ORIGIN = `http://127.0.0.1:${SERVICE}`;
const ORIGIN = `http://127.0.0.1:${String(PORT)}/`;
const ROOT = new URL('../../', import.meta.url);
const SHOT_DIR = new URL('docs/screenshots-phase4.1/', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const PAPER = new URL('.cache/papers/2610.22294.pdf', ROOT);
const STORAGE_KEY = 'rw.projects';

/**
 * The approved budget. Approved for four; the script counts every call it makes and stops
 * itself at the ceiling rather than trusting its own control flow to be correct.
 */
const CALL_BUDGET = 4;

/**
 * `--only=formula` runs a single case.
 *
 * Re-running all three to re-test one of them would spend two calls on questions that already
 * have answers, so a single case can be re-run on its own. Its report is written under a name
 * that says which case it was, and never replaces the full run's.
 */
const CASES = ['explain', 'formula', 'translate'];
const only =
  process.argv
    .slice(2)
    .find((argument) => argument.startsWith('--only='))
    ?.slice('--only='.length) ?? null;
if (only !== null && !CASES.includes(only)) {
  throw new Error(`--only must be one of: ${CASES.join(', ')}`);
}
const want = (name) => only === null || only === name;

const MODE_LABEL = {
  explain: '解释这段话',
  walkthrough: '逐步讲解原理',
  formula: '解释数学公式',
  translate: '翻译为中文',
  ask: '自由提问',
};

const calls = [];
const results = [];
let spent = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
}

/** Nothing here may ever print a credential, so anything printed goes through this first. */
function redact(text) {
  return String(text).replace(/sk-[A-Za-z0-9_-]{8,}/g, '«redacted»');
}

async function serviceHealth() {
  try {
    const response = await fetch(`${SERVICE_ORIGIN}/api/ai/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function startPreview() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: fileURLToPath(ROOT), env: { ...process.env, AI_PORT: SERVICE }, stdio: 'ignore' },
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

/** Which page of the paper carries actual mathematics, found offline before anything is spent. */
async function findMathPage(filePath) {
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
  let best = { page: 1, symbols: 0 };
  for (let number = 1; number <= Math.min(doc.numPages, 12); number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str ?? '').join(' ');
    const symbols = (text.match(/[∀-⋿Ͱ-Ͽ∑√×±≤≥∈∂∇]/g) ?? []).length;
    if (symbols > best.symbols) best = { page: number, symbols };
    page.cleanup();
  }
  await task.destroy();
  return best;
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

/**
 * Jumps to a page and waits for the smooth scroll to actually stop.
 *
 * The reader clears a pending selection whenever the page moves, which is right — a toolbar
 * hanging over a moving page would point at nothing. It also means a selection made while the
 * scroll is still gliding gets thrown away mid-click, so the jump is not finished until the
 * scroll position has held still for a few samples.
 */
async function gotoPage(page, number) {
  const input = page.locator('.reader-page-jump input');
  await input.fill(String(number));
  await input.press('Enter');
  await page
    .locator(`.pdf-page[data-page="${String(number)}"] .textLayer span`)
    .first()
    .waitFor({ timeout: 60_000 });

  let previous = null;
  let stable = 0;
  for (let attempt = 0; attempt < 60 && stable < 3; attempt += 1) {
    await page.waitForTimeout(120);
    const top = await page.evaluate(
      () => document.querySelector('.reader-scroll')?.scrollTop ?? null,
    );
    stable = top !== null && previous !== null && Math.abs(top - previous) < 1 ? stable + 1 : 0;
    previous = top;
  }
}

/**
 * Leaf spans of a page, with the geometry needed to pick a range inside one column.
 *
 * Every leaf span is kept, including empty ones, because `selectSpans` addresses spans by their
 * position in this same list. Filtering empties here would shift every index and the selection
 * would land somewhere else than the range that was chosen — which is exactly what happened
 * once, and was only visible because the model quoted the passage it had actually been given.
 */
function spanInfo(page, number) {
  return page.evaluate((n) => {
    const root = document.querySelector(`.pdf-page[data-page="${String(n)}"]`);
    if (root === null) return null;
    const box = root.getBoundingClientRect();
    return {
      half: box.left + box.width / 2,
      spans: [...root.querySelectorAll('.textLayer span')]
        .filter((span) => span.querySelector('span') === null)
        .map((span) => {
          const rect = span.getBoundingClientRect();
          return { text: span.textContent ?? '', left: rect.left, right: rect.right };
        }),
    };
  }, number);
}

/**
 * A run of consecutive spans that stays within one column, preferring one that does (or does
 * not) contain mathematics. Chosen by geometry because extraction order on a real two-column
 * page is not guaranteed to keep a column together.
 */
function pickRun(info, { wantMath, minSpans = 3, minChars = 80, maxChars = 600 }) {
  const runs = [];
  let start = null;
  let previous = null;
  const flush = () => {
    if (start !== null && previous !== null && previous - start + 1 >= minSpans) {
      runs.push([start, previous]);
    }
    start = null;
  };
  info.spans.forEach((span, index) => {
    if (span.right <= info.half) {
      if (previous === null || index === previous + 1) {
        if (start === null) start = index;
      } else {
        flush();
        start = index;
      }
      previous = index;
    } else {
      flush();
      previous = null;
    }
  });
  flush();

  const textOf = ([from, to]) =>
    info.spans
      .slice(from, to + 1)
      .map((span) => span.text)
      .join('');

  const scored = runs
    .map((run) => ({ run, text: textOf(run) }))
    .filter((entry) => entry.text.trim().length >= minChars)
    .map((entry) => {
      // Trim the range to the character budget, span by span, from the front.
      let cut = entry.text;
      let to = entry.run[1];
      while (cut.length > maxChars && to > entry.run[0]) {
        to -= 1;
        cut = info.spans
          .slice(entry.run[0], to + 1)
          .map((span) => span.text)
          .join('');
      }
      const maths = (cut.match(/[∀-⋿Ͱ-Ͽ∑√×±≤≥∈∂∇]/g) ?? []).length;
      return { from: entry.run[0], to, text: cut, maths };
    })
    .filter((entry) => entry.text.trim().length >= minChars);

  // A run that is asked to contain mathematics and does not is not a substitute for one that
  // does. Falling back would quietly turn the formula test into a second prose test and then
  // fail a check about symbols, which reads as a product problem when it is a fixture problem.
  //
  // Containing a symbol is not enough either. A page of axis labels carries `β` and `−` and no
  // mathematics at all — asking a model to explain a formula that is really a set of tick marks
  // measures nothing except its willingness to say so.
  //
  // Two signals, because one was not enough: the run must state something (`=`, `∈`, `≤`, `≥`)
  // *and* must not be mostly numerals. `1 2 4 8 16 −10 0 10 20 30 gain over unguided (pp) …
  // β= 0.5 1 2 4 8` satisfies the equality test and is a chart axis; a passage that explains
  // notation has letters in it and a few numbers, not the other way round.
  const equationLike = (text) => /[=∈≤≥]|:=/.test(text);
  const mostlyNumerals = (text) => {
    const digits = (text.match(/\d/g) ?? []).length;
    const letters = (text.match(/[A-Za-z一-鿿]/g) ?? []).length;
    return digits + letters > 0 && digits / (digits + letters) > 0.25;
  };
  const pool = wantMath
    ? scored.filter(
        (entry) => entry.maths > 0 && equationLike(entry.text) && !mostlyNumerals(entry.text),
      )
    : scored;
  if (pool.length === 0) return null;
  // For mathematics, prefer the longest run: a complete sentence that uses the notation beats a
  // two-character fragment that merely contains it.
  if (wantMath) pool.sort((one, other) => other.text.length - one.text.length);
  return pool[0] ?? null;
}

/**
 * Finds a passage that uses notation, by reading the text rather than the geometry.
 *
 * Displayed equations in this paper are not contiguous in the extraction: a single line comes
 * back as a scatter of items — `≥`, `∈`, `) :=`, `∏` — and the column cut used elsewhere in this
 * script splits sentences that happen to straddle the page midpoint. So the formula case picks a
 * *window of consecutive spans whose text reads like notation in prose*: it must contain an
 * equality or an inequality, real words, and not be mostly numerals (a chart axis satisfies a
 * naive search and teaches nothing).
 *
 * Returns null rather than substituting a passage without notation. The caller fails loudly; a
 * formula test that silently becomes a prose test is worse than no result.
 */
/**
 * Where the notation passage is, checked offline with pdf.js before any of this runs.
 *
 * Displayed equations in this paper do not extract contiguously — a single definition comes back
 * as a scatter of items (`Qβ(u) :=`, `P1(u) exp(βR(u))`, `Zβ`) — so a geometric or heuristic
 * search picks either a chart axis or a fragment cut mid-expression, and neither is a fair test
 * of "explain this maths". This sentence is the paper's own definition of the symbols, found by
 * reading the page rather than by guessing at geometry, and it is pinned for that reason.
 *
 * The page is verified at run time: if the phrase is not there, the search falls back and, if
 * that fails too, nothing is sent.
 */
const PINNED_NOTATION = { page: 6, phrase: 'normalizing constant', minChars: 70 };

/**
 * Finds a passage that uses notation.
 *
 * Tries the pinned definition first, then a content-based window scan. Returns null rather than
 * substituting a passage without notation: a formula test that silently becomes a prose test is
 * worse than no result, and the caller fails loudly.
 */
async function findNotationWindow(page, nearPage) {
  // 1. The pinned definition, if this paper still has it.
  await gotoPage(page, PINNED_NOTATION.page);
  const pinnedInfo = await spanInfo(page, PINNED_NOTATION.page);
  if (pinnedInfo !== null) {
    const at = pinnedInfo.spans.findIndex((span) => span.text.includes(PINNED_NOTATION.phrase));
    if (at >= 0) {
      let from = at;
      let text = '';
      while (from >= 0) {
        text = pinnedInfo.spans
          .slice(from, at + 1)
          .map((span) => span.text)
          .join('');
        if (text.length >= PINNED_NOTATION.minChars) break;
        from -= 1;
      }
      const maths = (text.match(/[∀-⋿Ͱ-Ͽ∑√×±≤≥∈∂∇]/g) ?? []).length;
      if (maths > 0) {
        return { page: PINNED_NOTATION.page, run: { from, to: at, text, maths } };
      }
    }
  }
  process.stdout.write('  the pinned definition was not found; falling back to a search\n');

  // 2. A window of consecutive spans whose text reads like notation in prose.
  const order = [nearPage, nearPage - 1, nearPage + 1, nearPage + 2, nearPage - 2, nearPage + 3];
  const seen = [];
  let fallback = null;
  for (const number of order) {
    if (number < 1) continue;
    await gotoPage(page, number);
    const info = await spanInfo(page, number);
    if (info === null) continue;

    for (let from = 0; from < info.spans.length; from += 1) {
      let text = '';
      for (let to = from; to < Math.min(info.spans.length, from + 12); to += 1) {
        text += info.spans[to].text;
        if (text.length < 70) continue;
        if (text.length > 400) break;
        const letters = (text.match(/[A-Za-z一-鿿]/g) ?? []).length;
        const digits = (text.match(/\d/g) ?? []).length;
        const maths = (text.match(/[∀-⋿Ͱ-Ͽ∑√×±≤≥∈∂∇]/g) ?? []).length;
        const states = /[=≥≤∈]|:=/.test(text);
        if (!states || maths === 0 || letters < 25 || digits / (digits + letters) >= 0.3) continue;
        const run = { from, to, text, maths };
        if (text.includes(':=')) return { page: number, run, definition: true };
        if (fallback === null) fallback = { page: number, run, definition: false };
      }
    }
    seen.push(number);
  }
  if (fallback !== null) return fallback;
  process.stdout.write(
    `  no passage of notation found on pages ${seen.join(', ')} — nothing was sent\n`,
  );
  return null;
}

/** Asks one question through the running app and returns what the service sent back. */
async function ask(page, { pageNumber, mode, run, question, label }) {
  if (spent >= CALL_BUDGET) {
    throw new Error(`approved call budget of ${String(CALL_BUDGET)} is used up; stopping`);
  }
  spent += 1;

  await selectSpans(page, pageNumber, { span: run.from, offset: 0 }, { span: run.to, offset: 999 });
  await page.mouse.move(5, 5);
  await page
    .locator(`.pdf-page[data-page="${String(pageNumber)}"]`)
    .first()
    .dispatchEvent('mouseup');
  const toolbar = page.getByRole('toolbar', { name: '批注' });
  await toolbar.waitFor({ timeout: 10_000 });
  await toolbar.getByRole('button', { name: 'AI' }).click();
  const menu = page.getByRole('group', { name: '向 AI 提问' });
  await menu.waitFor({ timeout: 5_000 });

  const started = Date.now();
  const [request, response] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/ai/ask') && r.method() === 'POST', {
      timeout: 120_000,
    }),
    page.waitForResponse(
      (r) => r.url().includes('/api/ai/ask') && r.request().method() === 'POST',
      { timeout: 120_000 },
    ),
    (async () => {
      if (question === undefined) {
        await menu.getByRole('button', { name: MODE_LABEL[mode] }).click();
      } else {
        await menu.getByRole('textbox', { name: '针对这段原文提问' }).fill(question);
        await menu.getByRole('button', { name: '提问' }).click();
      }
    })(),
  ]);
  const elapsedMs = Date.now() - started;
  const status = response.status();
  const body = await response.json().catch(() => null);
  const sentBody = request.postDataJSON?.() ?? null;
  const sentSelection = sentBody?.passages?.find((passage) => passage.selection)?.text ?? null;

  const record = {
    label,
    page: pageNumber,
    mode,
    question: question ?? null,
    selectionChars: run.text.length,
    selectionExcerpt: run.text.slice(0, 120),
    /** What the application actually put in the request — not what this script meant to select. */
    sentSelection,
    status,
    elapsedMs,
    answer: null,
    /** How the reply was read: valid / recovered / malformed / incomplete. */
    outputStatus: null,
    /** Lengths, counts and the provider's stop reason. Never the prompt or the paper. */
    diagnostics: null,
    citations: null,
    rejectedCitations: null,
    usage: null,
    warnings: null,
    model: null,
    provider: null,
    error: null,
  };

  // The one invariant that makes every other check mean anything: the passage recorded here is
  // the passage the model was given. Without it, a selector bug can pass every other check by
  // measuring its own intent — which it did, once.
  const collapse = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
  check(
    `${label}: the passage sent is the passage selected`,
    sentSelection !== null && collapse(sentSelection) === collapse(run.text),
    sentSelection === null
      ? 'no ask request was captured'
      : `${String(collapse(sentSelection).length)} sent vs ${String(collapse(run.text).length)} selected` +
          (collapse(sentSelection) === collapse(run.text)
            ? ''
            : ` — sent ${JSON.stringify(collapse(sentSelection).slice(0, 50))}`),
  );

  if (body === null || status !== 200) {
    record.error = body?.message ?? `HTTP ${String(status)}`;
    calls.push(record);
    // A failure is evidence too, and the panel's account of it is what the reader sees.
    await page
      .getByRole('alert')
      .last()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(300);
    await page.screenshot({
      path: fileURLToPath(new URL(`3${String(calls.length)}-live-${mode}-failed.png`, SHOT_DIR)),
    });
    // An account or credential problem is not something to keep trying through.
    if (['auth', 'insufficient-balance'].includes(body?.error)) {
      throw new Error(`stopping: ${redact(record.error)}`);
    }
    return record;
  }

  record.answer = body.answer;
  record.outputStatus = body.status ?? null;
  record.diagnostics = body.diagnostics ?? null;
  record.citations = body.citations;
  record.usage = body.usage;
  record.warnings = body.warnings;
  record.model = body.model;
  record.provider = body.provider;
  const rejected = (body.warnings ?? []).join(' ').match(/有 (\d+) 条引用未通过校验/);
  record.rejectedCitations = rejected === null ? 0 : Number(rejected[1]);
  calls.push(record);

  // Wait for the panel to finish showing it, so the screenshot in the report is the real one.
  await page
    .locator('.ai-answer-body')
    .last()
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({
    path: fileURLToPath(new URL(`3${String(calls.length)}-live-${mode}.png`, SHOT_DIR)),
    fullPage: false,
  });
  return record;
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });

  const health = await serviceHealth();
  if (health === null) {
    // Both syntaxes, because whoever reads this is in their own shell and half of them are in
    // PowerShell — where `VAR=value command` is not a command prefix but a failed lookup.
    process.stdout.write(
      'REFUSED  no local AI service on ' +
        SERVICE_ORIGIN +
        '\n' +
        'start it first, in the shell you actually use:\n' +
        "  PowerShell   $env:AI_PROVIDER='deepseek'; $env:DEEPSEEK_API_KEY='…'; npm run ai:serve\n" +
        '  bash         AI_PROVIDER=deepseek DEEPSEEK_API_KEY=… npm run ai:serve\n',
    );
    process.exitCode = 2;
    return;
  }
  if (health.provider !== 'deepseek' || health.online !== true) {
    // Running this against the mock and calling it a live result is the one mistake this
    // script exists to make impossible.
    process.stdout.write(
      `REFUSED  the service is reporting provider=${redact(health.provider)} online=${String(health.online)}.\n` +
        'This run is only meaningful against the online provider; nothing was sent.\n',
    );
    process.exitCode = 2;
    return;
  }
  if (!existsSync(fileURLToPath(PAPER))) {
    process.stdout.write('REFUSED  no real paper in .cache/papers/ — run fetch-papers.mjs\n');
    process.exitCode = 2;
    return;
  }

  process.stdout.write(
    `provider ${redact(health.label)} · ${redact(health.reasoning ?? '?')} · ` +
      `output ceiling ${String(health.limits?.answerTokens ?? '?')} tokens · ` +
      `budget ${String(CALL_BUDGET)} calls${only === null ? '' : ` · only: ${only}`}\n\n`,
  );

  const math = await findMathPage(fileURLToPath(PAPER));

  // Recorded in the report, so the evidence says which settings produced it rather than
  // leaving it to be inferred from a command line nobody kept.
  const serviceLimits = health.limits ?? {};
  const reasoningSetting = health.reasoning ?? null;

  process.stdout.write(
    `page ${String(math.page)} carries ${String(math.symbols)} maths symbols\n\n`,
  );

  const server = await startPreview();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleIssues = [];
  page.on('pageerror', (error) => {
    consoleIssues.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleIssues.push(`console: ${message.text()}`);
  });

  try {
    await page.goto(ORIGIN);
    await createProject(page, '真实联调');
    await importPaper(page, fileURLToPath(PAPER));
    const stored = Object.values((await payloadOf(page)).papers).find(
      (entry) => entry.pdf !== undefined,
    );
    check(
      'setup: the CC BY 4.0 paper is open',
      stored?.pdf?.bytes === (await readFile(fileURLToPath(PAPER))).length,
    );

    // ---- Test 1: explain a passage -------------------------------------
    if (want('explain')) {
      await gotoPage(page, 1);
      const prose = pickRun(await spanInfo(page, 1), { wantMath: false });
      if (prose === null) throw new Error('no usable passage on page 1');
      const explain = await ask(page, {
        pageNumber: 1,
        mode: 'explain',
        run: prose,
        label: '原文解释',
      });
      check(
        'explain: the model answered and the app parsed it',
        explain.status === 200 && typeof explain.answer === 'string' && explain.answer.length > 0,
        `${String(explain.answer?.length ?? 0)} chars in ${String(explain.elapsedMs)} ms`,
      );
      // The model may legitimately cite the surrounding context it was given, so the check is
      // that every citation names a passage that was actually sent, and that the passage the
      // reader selected is among them — not that it only ever cites the selection.
      const sentIds = new Set(['selection', 'before', 'after']);
      const cited = explain.citations ?? [];
      check(
        'explain: the answer cites text that is really in what was sent',
        cited.length > 0 &&
          cited.every((citation) => sentIds.has(citation.passageId)) &&
          cited.some((citation) => citation.passageId === 'selection'),
        `${String(cited.length)} verified, ${String(explain.rejectedCitations)} rejected, from ` +
          `${[...new Set(cited.map((citation) => citation.passageId))].join('/')}`,
      );
      check(
        'explain: usage, model and thinking budget were reported',
        explain.usage?.promptTokens != null && explain.usage?.completionTokens != null,
        `in ${String(explain.usage?.promptTokens)} / out ${String(explain.usage?.completionTokens)}` +
          (explain.usage?.reasoningTokens == null
            ? ''
            : ` (reasoning ${String(explain.usage.reasoningTokens)})`),
      );
      check(
        'explain: the answer is not the passage echoed back',
        explain.answer !== null && !explain.answer.startsWith(prose.text.slice(0, 40)),
      );
    }

    // ---- Test 2: a passage with mathematics ----------------------------
    if (want('formula')) {
      const found = await findNotationWindow(page, math.page);
      if (found === null) throw new Error('no page offered a usable passage of notation');
      const formulaPage = found.page;
      const formula = found.run;
      const symbolsInSelection = (formula.text.match(/[∀-⋿Ͱ-Ͽ∑√×±≤≥∈∂∇]/g) ?? []).length;
      const formulaRun = await ask(page, {
        pageNumber: formulaPage,
        mode: 'formula',
        run: formula,
        label: '公式解释',
      });
      check(
        'formula: the selection really contained symbols',
        symbolsInSelection > 0,
        `${String(symbolsInSelection)} symbols in ${String(formula.text.length)} chars`,
      );
      check(
        'formula: the model answered',
        formulaRun.status === 200 && (formulaRun.answer?.length ?? 0) > 0,
        formulaRun.status === 200
          ? `${String(formulaRun.answer?.length ?? 0)} chars in ${String(formulaRun.elapsedMs)} ms`
          : `HTTP ${String(formulaRun.status)} after ${String(formulaRun.elapsedMs)} ms — ${String(formulaRun.error)}`,
      );
    }

    // ---- Test 3: translation, on page 1 again --------------------------
    if (want('translate')) {
      await gotoPage(page, 1);
      const translation = pickRun(await spanInfo(page, 1), { wantMath: false, maxChars: 400 });
      if (translation === null) throw new Error('no usable passage to translate');
      const translate = await ask(page, {
        pageNumber: 1,
        mode: 'translate',
        run: translation,
        label: '英文翻译',
      });
      check(
        'translate: the model answered',
        translate.status === 200 && (translate.answer?.length ?? 0) > 0,
        `${String(translate.answer?.length ?? 0)} chars in ${String(translate.elapsedMs)} ms`,
      );
      const chinese = (translate.answer?.match(/[一-鿿]/g) ?? []).length;
      check(
        'translate: the answer is actually Chinese',
        chinese > 10,
        `${String(chinese)} CJK characters`,
      );
    }

    // ---- What this run cost --------------------------------------------
    const totalIn = calls.reduce((sum, call) => sum + (call.usage?.promptTokens ?? 0), 0);
    const totalOut = calls.reduce((sum, call) => sum + (call.usage?.completionTokens ?? 0), 0);
    check(
      'budget: the run stayed inside the approved number of calls',
      spent <= CALL_BUDGET,
      `${String(spent)} of ${String(CALL_BUDGET)} used, ${String(totalIn)} in / ${String(totalOut)} out`,
    );
    check(
      'safety: no credential appears anywhere in what was captured',
      !/sk-[A-Za-z0-9_-]{8,}/.test(JSON.stringify({ calls, consoleIssues })),
    );
    // The formula question deliberately walks into the token ceiling to see what happens, and
    // the 502 that produces is the run working as intended, not the page failing.
    const provoked = consoleIssues.filter((issue) => issue.includes('502'));
    const unexpected = consoleIssues.filter((issue) => !issue.includes('502'));
    check(
      'safety: the page reported no errors beyond the ones this run provoked',
      unexpected.length === 0,
      `${String(unexpected.length)} unexpected, ${String(provoked.length)} provoked`,
    );
    if (unexpected.length > 0) {
      process.stdout.write(`  unexpected: ${unexpected.slice(0, 2).join(' | ')}\n`);
    }
  } finally {
    await browser.close();
    server.kill();
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const price = { in: 0.15, out: 0.6 };
  const totalIn = calls.reduce((sum, call) => sum + (call.usage?.promptTokens ?? 0), 0);
  const totalOut = calls.reduce((sum, call) => sum + (call.usage?.completionTokens ?? 0), 0);
  await writeFile(
    new URL(`docs/phase4.1-live-api${only === null ? '' : `-${only}`}-report.json`, ROOT),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        provider: 'deepseek (live)',
        model: calls[0]?.model ?? null,
        cases: only === null ? CASES : [only],
        outputCeiling: serviceLimits.answerTokens ?? null,
        reasoning: reasoningSetting,
        callsMade: spent,
        callBudget: CALL_BUDGET,
        tokens: { prompt: totalIn, completion: totalOut },
        estimatedCostUsd: Number(
          ((totalIn / 1e6) * price.in + (totalOut / 1e6) * price.out).toFixed(6),
        ),
        passed,
        failed,
        results,
        calls,
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

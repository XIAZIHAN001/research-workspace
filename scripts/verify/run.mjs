/* global document, getComputedStyle */
import { spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { auditContrast } from './contrast.mjs';
import {
  dialogState,
  findOverflow,
  readAppState,
  readGlow,
  runAxe,
  watchPage,
} from './page-checks.mjs';

/**
 * Browser-level acceptance run for Phase 0. Serves the production build (`npm run build`
 * first) on loopback only, drives the installed Edge or Chrome, and writes screenshots to
 * docs/screenshots and a machine-readable summary to docs/verification-report.json.
 */

const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const ROOT = new URL('../../', import.meta.url);
const SHOT_DIR = new URL('docs/screenshots/', ROOT);
const REPORT_FILE = new URL('docs/verification-report.json', ROOT);
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));

const TITLES = [
  'Attention Is All You Need',
  'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
  'Deep Residual Learning for Image Recognition',
  'Denoising Diffusion Probabilistic Models',
  'Language Models are Few-Shot Learners',
  'An Image is Worth 16x16 Words',
  'Mastering the game of Go with deep neural networks and tree search',
];

const results = [];
const details = {};
const shots = [];
const watchers = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const settle = (page) => page.waitForTimeout(450);

async function shot(page, name) {
  await settle(page);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, SHOT_DIR)) });
  shots.push(`${name}.png`);
}

async function scenario(name, run) {
  try {
    await run();
  } catch (error) {
    check(`${name}: ran to completion`, false, String(error.message).split('\n')[0]);
  }
}

async function startPreview() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: fileURLToPath(ROOT), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`vite preview exited early:\n${output}`);
    try {
      if ((await fetch(ORIGIN)).ok) return child;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`vite preview did not come up on ${ORIGIN}:\n${output}`);
}

async function openPage(browser, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'zh-CN',
    ...options,
  });
  const page = await context.newPage();
  watchers.push(watchPage(page));
  await page.goto(ORIGIN);
  await page.waitForSelector('.app');
  return page;
}

/** Axe, pixel-level text contrast and viewport overflow for whatever is on screen now. */
async function audit(page, label) {
  const axe = await runAxe(page);
  check(
    `${label}: axe violations`,
    axe.violations.length === 0,
    axe.violations.length
      ? axe.violations.map((v) => `${v.id}x${v.count} ${v.targets[0]}`).join('; ')
      : `${axe.passes} rules passed, ${axe.incomplete.length} flagged for manual review`,
  );
  const contrast = await auditContrast(page);
  const behindOverlay = contrast.skipped.modal + contrast.skipped.scrim;
  const skippedNote = behindOverlay > 0 ? `, ${behindOverlay} behind an overlay skipped` : '';
  check(
    `${label}: text contrast`,
    contrast.failures.length === 0,
    contrast.failures.length
      ? contrast.failures
          .slice(0, 3)
          .map((f) => `${f.label} ${f.ratio} < ${f.need}`)
          .join('; ')
      : `${contrast.checked} runs, lowest ${contrast.lowest[0]?.ratio ?? 'n/a'}${skippedNote}`,
  );
  const overflow = await findOverflow(page);
  check(
    `${label}: nothing outside the viewport`,
    overflow.offenders.length === 0,
    overflow.offenders.join('; '),
  );
  details[label] = { axe, contrast, overflow };
}

async function createProject(page, title) {
  await page.locator('button[aria-label="新建项目"]').click();
  const dialog = page.locator('dialog[open]');
  await dialog.locator('input').fill(title);
  await dialog.locator('button[type="submit"]').click();
  await dialog.waitFor({ state: 'detached' });
}

async function wideFlow(browser) {
  const page = await openPage(browser, { colorScheme: 'light' });

  await scenario('empty home', async () => {
    const state = await readAppState(page);
    check(
      'empty home: light theme, following the system',
      state.theme === 'light' && state.pref === 'system' && state.narrow === 'false',
      JSON.stringify(state),
    );
    const duration = await page.evaluate(
      () => getComputedStyle(document.querySelector('aside.sidebar')).transitionDuration,
    );
    check(
      'motion is on by default',
      parseFloat(duration.split(',')[0]) >= 0.05,
      `transition-duration ${duration.split(',')[0]}`,
    );
    await shot(page, '01-light-home-empty');
    await audit(page, 'light empty home');
  });

  await scenario('create dialog', async () => {
    await page.locator('button[aria-label="新建项目"]').click();
    await page.waitForSelector('dialog[open]');
    const state = await dialogState(page);
    check(
      'create dialog: modal, focus inside',
      state.open && state.modal && state.focusInside,
      JSON.stringify(state),
    );
    await shot(page, '02-light-create-dialog');
    await audit(page, 'light create dialog');

    let escaped = 0;
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press('Tab');
      if ((await dialogState(page)).focusEscaped) escaped += 1;
    }
    check(
      'create dialog: Tab never leaves the dialog',
      escaped === 0,
      `${escaped} escapes in 8 presses`,
    );

    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    const opener = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    check(
      'create dialog: Escape closes it and returns focus to the opener',
      opener === '新建项目',
      `focus on ${opener}`,
    );
  });

  await scenario('seven projects', async () => {
    for (const title of TITLES) await createProject(page, title);
    await page.getByRole('button', { name: '首页' }).click();
    const rows = await page.locator('.rows .row').count();
    const recent = await page.locator('section[aria-labelledby="recent-title"] .nav-item').count();
    check(
      'seven projects listed, three in "最近更新"',
      rows === 7 && recent === 3,
      `${rows} rows, ${recent} recent`,
    );
    await shot(page, '03-light-home-7');
    await audit(page, 'light home');
  });

  await scenario('pointer light', async () => {
    await page.locator('.nav-item.spot').first().hover();
    await page.waitForTimeout(500);
    const lit = await readGlow(page, '.nav-item.spot');
    await page.mouse.move(700, 400);
    await page.waitForTimeout(500);
    const dim = await readGlow(page, '.nav-item.spot');
    check(
      'pointer light fades in on hover and out on leave',
      lit > 0.5 && dim < 0.05,
      `hover ${lit}, away ${dim}`,
    );
  });

  await scenario('keyboard focus ring', async () => {
    await page.reload();
    await page.waitForSelector('.app');
    const stops = [];
    for (let press = 0; press < 40; press += 1) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24) || el.tagName,
          ring:
            (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
            style.boxShadow !== 'none',
        };
      });
      if (stop === null || stops.some((s) => s.name === stop.name && s.index === press)) break;
      if (stops.length > 0 && stops[0].name === stop.name) break;
      stops.push({ ...stop, index: press });
    }
    const bare = stops.filter((s) => !s.ring).map((s) => s.name);
    check(
      'keyboard: every tab stop shows a focus indicator',
      stops.length > 0 && bare.length === 0,
      bare.length ? `no ring on: ${bare.join(', ')}` : `${stops.length} tab stops`,
    );
    details.tabStops = stops.map((s) => s.name);
  });

  await scenario('project view and manage mode', async () => {
    await page.locator('.rows button.row-main').first().click();
    await shot(page, '04-light-project');
    await audit(page, 'light project');
    await page.getByRole('button', { name: '管理项目' }).click();
    const renames = await page.locator('button[aria-label^="重命名 "]').count();
    check(
      'manage mode exposes rename for every project',
      renames === 7,
      `${renames} rename buttons`,
    );
    await shot(page, '05-light-manage');
    await audit(page, 'light manage mode');
    await page.getByRole('button', { name: '管理项目' }).click();
  });

  await scenario('collapsed sidebar', async () => {
    await page.getByRole('button', { name: '首页' }).click();
    await page.getByRole('button', { name: '收起侧栏' }).click();
    await settle(page);
    const state = await readAppState(page);
    check(
      'collapsed sidebar: the column goes away and its contents are inert',
      state.sidebar === 'closed' && state.inert === true,
      JSON.stringify(state),
    );
    await shot(page, '12-light-sidebar-collapsed');
    await audit(page, 'light sidebar collapsed');

    await page.getByRole('button', { name: '展开侧栏' }).click();
    await settle(page);
    check(
      'collapsed sidebar: expanding brings the same sidebar back',
      (await readAppState(page)).inert === false,
    );
  });

  await scenario('dark theme', async () => {
    // Self-contained: the collapsed-sidebar scenario above ends on the home page.
    await page.locator('.rows button.row-main').first().click();
    await settle(page);
    // Theme controls live in Settings › Appearance since Phase 12.1; the window closes back
    // onto the project it was opened from.
    await setAppTheme(page, '深色');
    await settle(page);
    const state = await readAppState(page);
    check(
      'dark: explicit choice applies',
      state.theme === 'dark' && state.pref === 'dark',
      JSON.stringify(state),
    );
    await shot(page, '06-dark-project');
    await audit(page, 'dark project');
    await page.getByRole('button', { name: '首页' }).click();
    await shot(page, '07-dark-home');
    await audit(page, 'dark home');
    await page.locator('button[aria-label="新建项目"]').click();
    await page.waitForSelector('dialog[open]');
    await shot(page, '08-dark-create-dialog');
    await audit(page, 'dark create dialog');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  });

  await scenario('confirm delete dialog', async () => {
    await page.getByRole('button', { name: '管理项目' }).click();
    await page.locator('button[aria-label^="删除 "]').first().click();
    await page.waitForSelector('dialog[open]');
    const state = await dialogState(page);
    check(
      'delete confirm: modal, focus inside',
      state.modal && state.focusInside,
      JSON.stringify(state),
    );
    await shot(page, '09-dark-confirm-delete');
    await audit(page, 'dark delete confirm');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    const rows = await page.locator('.rows .row').count();
    check('delete confirm: Escape keeps the project', rows === 7, `${rows} rows`);
  });

  await scenario('persistence', async () => {
    await page.reload();
    await page.waitForSelector('.app');
    const state = await readAppState(page);
    const rows = await page.locator('.rows .row').count();
    check(
      'reload keeps theme and projects',
      state.theme === 'dark' && state.pref === 'dark' && rows === 7,
      `${state.theme}/${state.pref}, ${rows} rows`,
    );
  });

  await page.context().close();
}

async function systemDarkFlow(browser) {
  await scenario('system dark', async () => {
    const page = await openPage(browser, { colorScheme: 'dark' });
    let state = await readAppState(page);
    check(
      'system dark: theme follows the OS',
      state.theme === 'dark' && state.pref === 'system',
      JSON.stringify(state),
    );
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(250);
    state = await readAppState(page);
    check(
      'system dark: a live OS change applies without reload',
      state.theme === 'light',
      JSON.stringify(state),
    );
    await page.context().close();
  });
}

async function narrowFlow(browser) {
  await scenario('narrow layout', async () => {
    const page = await openPage(browser, { viewport: { width: 700, height: 800 } });
    const closed = await readAppState(page);
    check('narrow: layout flag set at 700px', closed.narrow === 'true', JSON.stringify(closed));
    check('narrow: closed sidebar is inert', closed.inert === true, JSON.stringify(closed));
    await shot(page, '10-narrow-closed');
    await audit(page, 'narrow closed');

    await page.locator('button[aria-label="展开侧栏"]').click();
    await settle(page);
    const open = await readAppState(page);
    check('narrow: expand opens the overlay', open.inert === false, JSON.stringify(open));
    await shot(page, '11-narrow-overlay');
    await audit(page, 'narrow overlay');

    await page.keyboard.press('Escape');
    await settle(page);
    check('narrow: Escape closes the overlay', (await readAppState(page)).inert === true);

    await page.locator('button[aria-label="展开侧栏"]').click();
    await settle(page);
    await page
      .locator('button[aria-label="关闭侧栏"]')
      .click({ position: { x: 4, y: 4 }, force: true });
    await settle(page);
    check('narrow: the scrim closes the overlay', (await readAppState(page)).inert === true);

    const sweep = {};
    for (const width of [759, 760, 761, 800]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(200);
      sweep[width] = (await readAppState(page)).narrow;
    }
    check(
      'narrow: wide above the breakpoint',
      sweep[800] === 'false' && sweep[761] === 'false',
      JSON.stringify(sweep),
    );
    details.breakpointSweep = sweep;
    await page.context().close();
  });
}

async function reducedMotionFlow(browser) {
  await scenario('reduced motion', async () => {
    const page = await openPage(browser, { reducedMotion: 'reduce' });
    const duration = await page.evaluate(
      () => getComputedStyle(document.querySelector('aside.sidebar')).transitionDuration,
    );
    check(
      'reduced motion: transitions collapse to ~0',
      parseFloat(duration.split(',')[0]) < 0.001,
      `transition-duration ${duration.split(',')[0]}`,
    );
    await page.context().close();
  });
}

let browser;
let server;
try {
  await mkdir(SHOT_DIR, { recursive: true });
  server = await startPreview();
  browser = await launchBrowser();
  await wideFlow(browser);
  await systemDarkFlow(browser);
  await narrowFlow(browser);
  await reducedMotionFlow(browser);

  const problems = watchers.flat();
  check(
    'no console errors, warnings, page errors or failed requests',
    problems.length === 0,
    problems.slice(0, 3).join(' | '),
  );

  const failed = results.filter((r) => !r.ok);
  await writeFile(
    REPORT_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        browser: browser.version(),
        passed: results.length - failed.length,
        failed: failed.length,
        results,
        details,
        shots,
      },
      null,
      2,
    ),
  );
  console.log(
    `\n${results.length - failed.length} passed, ${failed.length} failed. ${shots.length} screenshots in docs/screenshots.`,
  );
  for (const f of failed) console.log(`  FAIL ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser?.close();
  server?.kill();
}

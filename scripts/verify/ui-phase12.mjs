/**
 * Phase 12.1 UI acceptance: continuous neutral dark level, a single blue action colour,
 * layout safety and contrast — run against the production build in an isolated browser.
 *
 * The palette expectations were re-based for the Apple visual layer: the light page is
 * #F5F5F7 with a white sheet, home panels are filled tiles one step above the sheet, and the
 * light primary is the accent blue instead of the old black inverse. Everything measured for
 * layout, contrast, focus and motion is unchanged.
 *
 * It never touches the desktop webview data directory: the browser starts with a fresh
 * profile, and the only reader data it creates is a generated sample PDF imported through
 * the real import path. The Tauri IPC surface is stubbed inside this browser only, so the
 * AI settings dialog can be laid out without a sidecar, a credential store or a network call.
 */

/* global window, document, getComputedStyle, HTMLInputElement */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { auditContrast } from './contrast.mjs';
import { buildSamplePdf } from './sample-pdf.mjs';

const PORT = 4178;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const ROOT = new URL('../../', import.meta.url);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = new URL(`docs/screenshots-phase12/${STAMP}-ui/`, ROOT);
const REPORT_FILE = new URL('docs/phase12.1-ui-verification-report.json', ROOT);
const SAMPLE_FILE = fileURLToPath(new URL('.cache/verify/phase12-sample.pdf', ROOT));
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));

const results = [];
const contrasts = [];
const consoleIssues = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
}

/**
 * A preview gate is only evidence when it serves the sources it claims to. A stale dist once
 * let a design change pass a check it had actually inverted (blue button read as the
 * near-black design, PR #2 review): the gate now refuses to run on an older build than the code.
 */
function assertFreshBuild() {
  const distIndex = fileURLToPath(new URL('../../dist/index.html', import.meta.url));
  const distMtime = existsSync(distIndex) ? statSync(distIndex).mtimeMs : 0;
  const newest = (dir) => {
    let latest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      latest = Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
    }
    return latest;
  };
  const srcNewest = newest(fileURLToPath(new URL('../../src', import.meta.url)));
  if (distMtime < srcNewest) {
    throw new Error(
      'dist/ 比最新源码旧：本门禁服务生产构建，请先 npm run build 再跑（否则验证的是旧界面）。',
    );
  }
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
    const text = message.text();
    // The stubbed desktop service points at a closed loopback port on purpose; its failed
    // health fetch is the expected result, not a UI defect.
    if (text.includes('/api/ai/health') || text.includes('ERR_CONNECTION_REFUSED')) return;
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleIssues.push(`${message.type()}: ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    consoleIssues.push(`pageerror: ${error.message}`);
  });
}

/**
 * A minimal stand-in for the Tauri IPC surface. The dialog under test only reads status,
 * budget and credential booleans; every other command resolves to null. Nothing here can
 * reach the network or the real credential store.
 */
function tauriStub() {
  window.isTauri = true;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    transformCallback(callback) {
      const id = Math.floor(Math.random() * 1e9);
      window[`_rw_stub_${String(id)}`] = callback;
      return id;
    },
    async invoke(command) {
      if (command === 'ai_service_info') {
        return {
          state: 'ready',
          mode: 'mock',
          baseUrl: 'http://127.0.0.1:9',
          token: 'phase12-stub',
          provider: 'mock',
          model: 'mock-1',
          online: false,
          instanceId: 'phase12-verification',
          credentialConfigured: true,
          error: null,
        };
      }
      if (command === 'ai_providers') {
        return [
          {
            id: 'deepseek',
            label: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com',
            defaultModel: 'deepseek-flash',
            models: ['deepseek-flash', 'deepseek-v4-pro'],
            supportsThinking: true,
          },
          {
            id: 'custom',
            label: '自定义（OpenAI 兼容）',
            baseUrl: '',
            defaultModel: '',
            models: [],
            supportsThinking: false,
          },
        ];
      }
      if (command === 'ai_credentials_status') return { configured: true, error: null };
      if (command === 'get_ai_settings') {
        return {
          budget: { requests: 50, tokensPerRequest: 8192, tokensPerSession: 200000 },
          provider: 'mock',
          baseUrl: 'http://127.0.0.1:9',
          model: 'mock-1',
          reasoningEffort: 'none',
        };
      }
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return null;
      return null;
    },
  };
}

function sampleState() {
  const now = Date.now();
  return {
    version: 5,
    projects: [
      {
        id: 'proj-transformer',
        name: 'Transformer 架构精读',
        corePaperId: 'paper-attention',
        relatedPaperIds: ['paper-bert'],
        createdAt: now - 8 * 86_400_000,
        updatedAt: now - 3_600_000,
      },
      {
        id: 'proj-vision',
        name: '视觉骨干网络',
        corePaperId: 'paper-resnet',
        relatedPaperIds: [],
        createdAt: now - 16 * 86_400_000,
        updatedAt: now - 86_400_000,
      },
    ],
    papers: {
      'paper-attention': {
        id: 'paper-attention',
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        year: 2017,
        reading: { page: 7, updatedAt: now - 3_600_000 },
        createdAt: now - 8 * 86_400_000,
        updatedAt: now - 3_600_000,
      },
      'paper-resnet': {
        id: 'paper-resnet',
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He'],
        year: 2016,
        reading: { page: 3, updatedAt: now - 86_400_000 },
        createdAt: now - 16 * 86_400_000,
        updatedAt: now - 86_400_000,
      },
      'paper-bert': {
        id: 'paper-bert',
        title: 'BERT: Pre-training of Deep Bidirectional Transformers',
        authors: ['Jacob Devlin'],
        year: 2019,
        createdAt: now - 20 * 86_400_000,
        updatedAt: now - 200_000_000,
      },
    },
    annotations: [],
    selectedId: 'proj-transformer',
  };
}

async function seed(
  page,
  { theme = 'dark', style = null, level = 100, data = sampleState() } = {},
) {
  await page.evaluate(
    ({ themeValue, styleValue, levelValue, state }) => {
      window.localStorage.setItem('rw.projects', JSON.stringify(state));
      window.localStorage.setItem('rw.theme', themeValue);
      if (styleValue === null) window.localStorage.removeItem('rw.themeStyle');
      else window.localStorage.setItem('rw.themeStyle', styleValue);
      if (levelValue === null) window.localStorage.removeItem('rw.themeLevel');
      else window.localStorage.setItem('rw.themeLevel', String(levelValue));
      window.localStorage.setItem('rw.sidebar', 'open');
    },
    { themeValue: theme, styleValue: style, levelValue: level, state: data },
  );
  await page.reload();
  await page.locator('.app').waitFor();
  // Let the entry animations settle before a screenshot or a pixel measurement.
  await page.waitForTimeout(450);
}

async function shot(page, name) {
  const path = fileURLToPath(new URL(name, SHOT_DIR));
  await page.screenshot({ path, animations: 'disabled' });
  return path;
}

async function audit(page, label) {
  const report = await auditContrast(page);
  contrasts.push({ label, ...report });
  check(
    `contrast: ${label} — ${String(report.checked)} text runs meet WCAG AA`,
    report.failures.length === 0,
    report.failures.length === 0
      ? `lowest ${String(report.lowest[0]?.ratio ?? 'n/a')}`
      : report.failures
          .slice(0, 4)
          .map((failure) => `${failure.label} ${String(failure.ratio)}<${String(failure.need)}`)
          .join('; '),
  );
  return report;
}

async function openAppearance(page) {
  if ((await page.locator('dialog[open] .settings').count()) === 0) {
    await page.locator('.sidebar').getByRole('button', { name: '设置' }).click();
    await page.locator('dialog[open] .settings').waitFor();
  }
  await page.locator('.settings-nav').getByRole('button', { name: '外观' }).click();
  await page.locator('.theme-level').waitFor();
  await page.waitForTimeout(200);
}

/** Drives the range input the way a pointer does (input + change), then waits for the wash. */
async function setLevel(page, level) {
  await openAppearance(page);
  await page.locator('input[type="range"][aria-label="深色程度"]').evaluate((element, value) => {
    // React tracks the previous value on the element, so a plain assignment is invisible to
    // its change detection. The prototype setter updates the DOM without updating the tracker.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, level);
  await page.waitForTimeout(260);
}

/** The resolved colours of the app shell and its main surfaces, plus the level attributes. */
async function surfaces(page) {
  return page.evaluate(() => {
    const app = document.querySelector('.app');
    const main = document.querySelector('.main');
    const panel = document.querySelector('.home-panel');
    const root = document.documentElement;
    const rgb = (element) => {
      if (element === null) return null;
      const value = getComputedStyle(element).backgroundColor;
      const numbers = value.match(/\d+/g)?.map(Number) ?? [];
      return { css: value, channels: numbers.slice(0, 3) };
    };
    return {
      theme: root.dataset.theme,
      level: root.dataset.darkLevel,
      style: root.dataset.themeStyle,
      app: rgb(app),
      main: rgb(main),
      panel: rgb(panel),
      darkSidebar: root.style.getPropertyValue('--dark-sidebar'),
      darkElevated: root.style.getPropertyValue('--dark-elevated'),
      storedLevel: window.localStorage.getItem('rw.themeLevel'),
      storedStyle: window.localStorage.getItem('rw.themeStyle'),
    };
  });
}

async function primaryContrast(page) {
  return page.evaluate(() => {
    const button = document.querySelector('.home-actions .btn-primary');
    if (button === null) return null;
    const style = getComputedStyle(button);
    const parse = (value) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const linear = (channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([red, green, blue]) =>
      0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    const foreground = parse(style.color);
    const background = parse(style.backgroundColor);
    const one = luminance(foreground);
    const other = luminance(background);
    return {
      foreground: style.color,
      background: style.backgroundColor,
      ratio:
        Math.round(((Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05)) * 100) / 100,
      backgroundChannels: background,
      foregroundChannels: foreground,
    };
  });
}

async function openAiSettings(page) {
  if ((await page.locator('dialog[open] .settings').count()) === 0) {
    await page.locator('.sidebar').getByRole('button', { name: '设置' }).click();
    await page.locator('dialog[open] .settings').waitFor();
  }
  await page.locator('.settings-nav').getByRole('button', { name: 'AI 服务' }).click();
  await page.locator('.ai-settings').waitFor();
  await page.waitForTimeout(320);
}

async function closeSettings(page) {
  await page.locator('dialog[open] .dialog-head').getByRole('button', { name: '关闭' }).click();
  await page.waitForFunction(() => document.querySelector('dialog[open]') === null);
}

async function layoutMetrics(page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const foot = document.querySelector('.sidebar-foot');
    const main = document.querySelector('.main');
    const body = document.documentElement;
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const sidebarBox = box(sidebar);
    return {
      sidebarWidth: sidebar.getBoundingClientRect().width,
      foot: box(foot),
      footerControlsInside:
        foot === null
          ? true
          : [...foot.querySelectorAll('button')].every((button) => {
              const rect = button.getBoundingClientRect();
              return rect.left >= sidebarBox.left - 1 && rect.right <= sidebarBox.right + 1;
            }),
      bodyWidth: body.scrollWidth,
      viewportWidth: window.innerWidth,
      mainHorizontalOverflow: main.scrollWidth > main.clientWidth + 1,
    };
  });
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(fileURLToPath(new URL('.cache/verify/', ROOT)), { recursive: true });
  await writeFile(SAMPLE_FILE, buildSamplePdf());

  assertFreshBuild();
  const server = await startPreview();
  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });
  await context.addInitScript(tauriStub);
  const page = await context.newPage();
  watch(page);
  // A local health payload keeps the cost surface readable without a sidecar. It is not a
  // model response and no request leaves the browser.
  await page.route('**/api/ai/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        provider: 'mock',
        label: '离线 Mock',
        model: 'mock-1',
        reasoning: null,
        online: false,
        budget: { requests: 50, tokensPerRequest: 8192, tokensPerSession: 200000 },
        usage: {
          requests: 2,
          promptTokens: 1200,
          completionTokens: 800,
          reasoningTokens: 0,
          totalTokens: 2000,
          estimatedCostCny: 0,
          costKnown: true,
          unknownCostRequests: 0,
          exactTokens: true,
        },
        pricing: {
          model: 'mock-1',
          known: true,
          currency: 'CNY',
          asOf: '2026-10-19',
          source: 'local-mock',
          note: '离线模拟不产生费用。',
        },
        limits: {
          passages: 6,
          passageChars: 1200,
          totalContextChars: 12000,
          questionChars: 800,
          requestsPerMinute: 12,
          answerTokens: 2048,
        },
      }),
    }),
  );

  try {
    await page.goto(ORIGIN);
    await page.locator('.app').waitFor();

    // ---- First run: the default theme and a real, empty home ---------------------------
    await page.evaluate(() => {
      window.localStorage.clear();
    });
    await page.reload();
    await page.locator('.home').waitFor();
    await page.waitForTimeout(350);
    check(
      'theme: a fresh profile follows the system and defaults to light',
      (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light',
    );
    await openAppearance(page);
    const initial = await page.evaluate(() => ({
      level: document.documentElement.dataset.darkLevel,
      app: document.documentElement.style.getPropertyValue('--dark-app'),
      slider: document.querySelector('input[type="range"]')?.value ?? null,
      segments: [...document.querySelectorAll('.segmented[aria-label="主题"] .seg')].map((button) =>
        button.getAttribute('aria-label'),
      ),
    }));
    check(
      'theme: settings shows the dark level slider and the three theme choices',
      initial.level === '100' &&
        initial.app === '#000000' &&
        initial.slider === '100' &&
        initial.segments.join('|') === '跟随系统|浅色|深色',
      JSON.stringify(initial),
    );
    await shot(page, '00b-settings-appearance-1440x900.png');
    await closeSettings(page);
    check(
      'layout: theme controls are absent from the first-level home page',
      (await page.locator('.home').getByRole('slider').count()) === 0 &&
        (await page.locator('.home .segmented').count()) === 0,
    );
    const avatarPlacement = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar');
      const user = document.querySelector('.sidebar-user');
      const image = document.querySelector('.sidebar-user .avatar-img');
      if (sidebar === null || user === null || image === null) return null;
      const one = sidebar.getBoundingClientRect();
      const other = user.getBoundingClientRect();
      const photo = image.getBoundingClientRect();
      return {
        inSidebar: sidebar.contains(user),
        nearBottom: one.bottom - other.bottom < 40,
        nearLeft: photo.left - one.left < 30,
      };
    });
    check(
      'sidebar: the avatar sits at the bottom-left',
      avatarPlacement !== null &&
        avatarPlacement.inSidebar &&
        avatarPlacement.nearBottom &&
        avatarPlacement.nearLeft,
      JSON.stringify(avatarPlacement),
    );
    check(
      'home: an empty workspace shows no invented rows',
      (await page.locator('.home-list').count()) === 0,
    );
    check(
      'home: the empty state offers real entry points',
      (await page.getByRole('button', { name: '新建项目' }).count()) >= 1 &&
        (await page.getByRole('button', { name: '导入论文' }).count()) >= 1 &&
        (await page.getByRole('button', { name: '论文库' }).count()) >= 1,
    );
    await shot(page, '00-home-light-empty-1440x900.png');

    // ---- Seeded home in the default dark surface ---------------------------------------
    await seed(page, { theme: 'dark', level: 100 });
    check(
      'home: real reading positions are listed, newest first',
      (await page.locator('.home-row').first().textContent())?.includes(
        'Attention Is All You Need',
      ) ?? false,
    );
    check(
      'home: every project row is a real project',
      (await page.locator('.home-panel').nth(1).locator('.home-row').count()) === 2,
    );
    const black = await surfaces(page);
    check(
      'theme: the default dark app background is pure black',
      black.level === '100' &&
        black.app.channels.every((channel) => channel === 0) &&
        black.main.channels.every((channel) => channel === 13),
      JSON.stringify({ app: black.app.css, main: black.main.css }),
    );
    const primaryDark = await primaryContrast(page);
    check(
      'primary: dark mode uses a near-white button with near-black text',
      primaryDark !== null &&
        primaryDark.ratio >= 4.5 &&
        primaryDark.backgroundChannels.every((channel) => channel >= 240) &&
        primaryDark.foregroundChannels.every((channel) => channel <= 32),
      JSON.stringify(primaryDark),
    );
    await audit(page, 'home / dark 100');
    await shot(page, '01-home-dark-100-1440x900.png');

    const metrics = await layoutMetrics(page);
    // The designed default moved to 224px with the layout presets (feat 6ce9f3e).
    check(
      'layout: the sidebar sits within the 214–234px target',
      metrics.sidebarWidth >= 214 && metrics.sidebarWidth <= 234,
      `${String(metrics.sidebarWidth)}px`,
    );
    check('layout: the footer stays inside the sidebar', metrics.footerControlsInside);
    check(
      'layout: no document-level horizontal overflow',
      metrics.bodyWidth <= metrics.viewportWidth,
      `${String(metrics.bodyWidth)} / ${String(metrics.viewportWidth)}`,
    );
    check('layout: the main panel has no horizontal overflow', !metrics.mainHorizontalOverflow);

    // ---- The five required dark levels -------------------------------------------------
    const levels = [
      { level: 0, app: 36, panel: 49, sidebar: '#2c2c2c', elevated: '#3c3c3c' },
      { level: 25, app: 27, panel: 40, sidebar: '#232323', elevated: '#333333' },
      { level: 50, app: 18, panel: 31, sidebar: '#1a1a1a', elevated: '#2a2a2a' },
      { level: 75, app: 9, panel: 22, sidebar: '#111111', elevated: '#212121' },
      { level: 100, app: 0, panel: 13, sidebar: '#080808', elevated: '#181818' },
    ];
    for (const expected of levels) {
      await setLevel(page, expected.level);
      await closeSettings(page);
      const actual = await surfaces(page);
      const neutral = [actual.app, actual.main, actual.panel].every(
        (surface) =>
          surface !== null && surface.channels.every((value) => value === surface.channels[0]),
      );
      check(
        `dark level ${String(expected.level)}: app #${expected.app
          .toString(16)
          .padStart(2, '0')} stays neutral and the tiles step up`,
        actual.level === String(expected.level) &&
          actual.app.channels.every((channel) => channel === expected.app) &&
          actual.main.channels.every((channel) => channel === expected.panel) &&
          // A home panel is a filled tile now: one step above the sheet (elevated = panel + 11).
          actual.panel?.channels.every((channel) => channel === expected.app + 24) === true &&
          actual.darkSidebar === expected.sidebar &&
          actual.darkElevated === expected.elevated &&
          neutral,
        JSON.stringify({
          app: actual.app.css,
          main: actual.main.css,
          panel: actual.panel?.css,
          sidebar: actual.darkSidebar,
        }),
      );
    }

    await setLevel(page, 0);
    check(
      'slider: 0 is the lightest dark grey and the value is announced',
      (await page.locator('input[type="range"]').getAttribute('aria-valuetext')) === '深灰' &&
        (await page.locator('input[type="range"]').inputValue()) === '0',
    );
    await closeSettings(page);
    await audit(page, 'home / dark 0');
    await shot(page, '02-home-dark-0-1440x900.png');

    await setLevel(page, 50);
    await closeSettings(page);
    await audit(page, 'home / dark 50');
    await shot(page, '03-home-dark-50-1440x900.png');

    await page.reload();
    await page.locator('.home').waitFor();
    await page.waitForTimeout(350);
    const restored = await surfaces(page);
    check(
      'slider: a reload restores the saved level and colours',
      restored.level === '50' &&
        restored.app.channels.every((channel) => channel === 18) &&
        restored.storedLevel === '50',
      JSON.stringify({ level: restored.level, app: restored.app.css }),
    );
    await openAppearance(page);
    check(
      'slider: the restored value is shown in Settings',
      (await page.locator('input[type="range"]').inputValue()) === '50',
    );
    await closeSettings(page);

    // ---- Primary button: inverse, hover, press and focus -------------------------------
    await setLevel(page, 100);
    await closeSettings(page);
    const primary = page.locator('.home-actions .btn-primary');
    const baseBox = await primary.boundingBox();
    await primary.hover();
    await page.waitForTimeout(220);
    const hovered = await primary.evaluate((element) => getComputedStyle(element).backgroundColor);
    check(
      'primary: hover raises the button without changing its geometry',
      hovered === 'rgb(255, 255, 255)' &&
        Math.abs((await primary.boundingBox()).width - (baseBox?.width ?? 0)) < 0.5,
      hovered,
    );
    if (baseBox !== null) {
      await page.mouse.move(baseBox.x + baseBox.width / 2, baseBox.y + baseBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(160);
      const pressed = await primary.evaluate((element) => getComputedStyle(element).transform);
      // Release away from the button so the press is not also a click that opens a dialog.
      await page.mouse.move(12, 12);
      await page.mouse.up();
      await page.waitForTimeout(260);
      const released = await primary.evaluate((element) => getComputedStyle(element).transform);
      check(
        'primary: press scales to about 0.975 and release settles back',
        pressed.includes('0.975') && (released === 'none' || released.startsWith('matrix(1,')),
        `${pressed} -> ${released}`,
      );
    }

    const disabledOpacity = await page.evaluate(() => {
      const button = document.createElement('button');
      button.className = 'btn btn-primary';
      button.textContent = 'disabled probe';
      button.disabled = true;
      document.body.append(button);
      const opacity = getComputedStyle(button).opacity;
      button.remove();
      return opacity;
    });
    check(
      'primary: the disabled state is visibly distinct',
      Number(disabledOpacity) > 0.4 && Number(disabledOpacity) < 0.7,
      disabledOpacity,
    );

    // ---- Light theme: apple.com's white sheet on a grey page, one blue action ----------
    await seed(page, { theme: 'light', level: 100 });
    const white = await surfaces(page);
    const primaryLight = await primaryContrast(page);
    check(
      'theme: light keeps a white sheet on the #F5F5F7 page',
      white.theme === 'light' &&
        white.app.channels[0] === 245 &&
        white.app.channels[1] === 245 &&
        white.main.channels.every((channel) => channel === 255),
      JSON.stringify({ app: white.app.css, main: white.main.css }),
    );
    check(
      'primary: light mode uses the near-black inverse with white text',
      primaryLight !== null &&
        primaryLight.ratio >= 4.5 &&
        // A near-neutral dark fill: every channel low, and no hue left between channels.
        Math.max(...primaryLight.backgroundChannels) <= 60 &&
        Math.max(...primaryLight.backgroundChannels) -
          Math.min(...primaryLight.backgroundChannels) <=
          8 &&
        primaryLight.foregroundChannels.every((channel) => channel >= 240),
      JSON.stringify(primaryLight),
    );
    await audit(page, 'home / light');
    await shot(page, '04-home-light-1440x900.png');

    // ---- System mode carries the saved level into dark ---------------------------------
    await seed(page, { theme: 'system', level: 0 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    const systemDark = await surfaces(page);
    check(
      'system: a live switch to dark applies the saved level',
      systemDark.theme === 'dark' &&
        systemDark.level === '0' &&
        systemDark.app.channels.every((channel) => channel === 36),
      JSON.stringify({ theme: systemDark.theme, level: systemDark.level, app: systemDark.app.css }),
    );
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(300);
    check(
      'system: switching back to light keeps the level for the next dark session',
      (await surfaces(page)).theme === 'light' && (await surfaces(page)).level === '0',
    );

    // ---- Legacy Phase 12 profiles ------------------------------------------------------
    await page.evaluate(() => {
      window.localStorage.setItem('rw.theme', 'dark');
      window.localStorage.setItem('rw.themeStyle', 'graphite');
      window.localStorage.removeItem('rw.themeLevel');
    });
    await page.reload();
    await page.locator('.app').waitFor();
    await page.waitForTimeout(300);
    const legacyGraphite = await surfaces(page);
    check(
      'compatibility: a saved Graphite profile becomes level 36 neutral grey',
      legacyGraphite.level === '36' &&
        legacyGraphite.style === 'graphite' &&
        legacyGraphite.app.channels.every((channel) => channel === 23),
      JSON.stringify({ level: legacyGraphite.level, app: legacyGraphite.app.css }),
    );

    await page.evaluate(() => {
      window.localStorage.setItem('rw.theme', 'dark');
      window.localStorage.setItem('rw.themeStyle', 'obsidian');
      window.localStorage.removeItem('rw.themeLevel');
    });
    await page.reload();
    await page.locator('.app').waitFor();
    await page.waitForTimeout(300);
    check(
      'compatibility: a saved Obsidian profile becomes pure black',
      (await surfaces(page)).level === '100' &&
        (await surfaces(page)).app.channels.every((channel) => channel === 0),
    );

    await page.evaluate(() => {
      window.localStorage.setItem('rw.theme', 'dark');
      window.localStorage.setItem('rw.themeStyle', 'obsidian');
      window.localStorage.setItem('rw.themeLevel', '40');
    });
    await page.reload();
    await page.locator('.app').waitFor();
    await page.waitForTimeout(300);
    check(
      'compatibility: a stored level wins over the legacy palette name',
      (await surfaces(page)).level === '40' &&
        (await surfaces(page)).app.channels.every((channel) => channel === 22),
    );

    // ---- 1024×689 and a narrow window --------------------------------------------------
    await page.setViewportSize({ width: 1024, height: 689 });
    await seed(page, { theme: 'dark', level: 100 });
    const compact = await layoutMetrics(page);
    check('layout: 1024×689 keeps the footer inside the sidebar', compact.footerControlsInside);
    check(
      'layout: 1024×689 has no horizontal overflow',
      compact.bodyWidth <= compact.viewportWidth && !compact.mainHorizontalOverflow,
      `${String(compact.bodyWidth)} / ${String(compact.viewportWidth)}`,
    );
    await shot(page, '04-home-dark-100-1024x689.png');

    // The same physical 1440×900 window at 150% Windows scaling is a 960×600 CSS viewport.
    await page.setViewportSize({ width: 960, height: 600 });
    await page.waitForTimeout(250);
    const scaled = await layoutMetrics(page);
    check(
      'layout: a 150%-scale equivalent (960×600 CSS) keeps the footer inside',
      scaled.footerControlsInside && scaled.bodyWidth <= scaled.viewportWidth,
    );
    await shot(page, '04b-home-dark-100-960x600-scaled.png');

    await page.setViewportSize({ width: 720, height: 820 });
    await page.reload();
    await page.locator('.app').waitFor();
    await page.waitForTimeout(400);
    check(
      'layout: a narrow window starts with the sidebar as an overlay',
      (await page.locator('.app').getAttribute('data-narrow')) === 'true' &&
        (await page.locator('.app').getAttribute('data-sidebar')) === 'closed',
    );
    await shot(page, '05-home-narrow-720x820.png');
    await page.getByRole('button', { name: '展开侧栏' }).click();
    await page.waitForTimeout(400);
    check(
      'layout: the narrow overlay opens and dims the page',
      (await page.locator('.scrim').count()) === 1,
    );
    await shot(page, '06-sidebar-overlay-720x820.png');
    await page.locator('.scrim').click({ position: { x: 600, y: 400 } });
    await page.waitForTimeout(350);

    // ---- Library ------------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page, { theme: 'dark', level: 100 });
    await page.locator('.sidebar').getByRole('button', { name: '论文库' }).click();
    await page.locator('.library').waitFor();
    await page.waitForTimeout(250);
    check('library: all seeded papers are shown', (await page.locator('.paper-row').count()) === 3);
    await audit(page, 'library / dark 100');
    await shot(page, '07-library-dark-100-1440x900.png');

    // ---- Reader: import a generated PDF through the real path ---------------------------
    await page.getByRole('button', { name: '首页' }).click();
    await page.locator('.home').waitFor();
    await page.locator('.sidebar').getByRole('button', { name: '新建项目' }).click();
    await page.getByLabel('核心论文标题').fill('Phase 12 阅读器验收');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('heading', { level: 1, name: 'Phase 12 阅读器验收' }).waitFor();
    await page.getByRole('button', { name: '导入新论文' }).click();
    const importDialog = page.getByRole('dialog', { name: '导入论文' });
    // The dialog holds two file inputs: the real one the form reads (data-autofocus) and an
    // inert mirror inside the drop-zone label. Target the real one explicitly.
    await importDialog.locator('input[type="file"][data-autofocus]').setInputFiles(SAMPLE_FILE);
    await importDialog.getByRole('button', { name: '导入' }).click();
    await page.locator('.reader').waitFor({ timeout: 20_000 });
    await page.locator('.pdf-page[data-page="1"] canvas').waitFor({ timeout: 20_000 });
    await page.locator('.pdf-page[data-page="1"] .textLayer span').first().waitFor({
      timeout: 20_000,
    });
    await page.waitForTimeout(500);
    check(
      'reader: the generated PDF renders in the themed reader',
      (await page.locator('.pdf-page[data-page="1"] .textLayer').textContent())?.includes(
        'MARKER-PAGE-1',
      ) ?? false,
    );
    await audit(page, 'reader / dark 100');
    if ((await page.getByRole('button', { name: '关闭目录' }).count()) > 0) {
      await page.getByRole('button', { name: '关闭目录' }).click();
      await page.waitForTimeout(250);
    }
    await shot(page, '08-reader-dark-100-1440x900.png');
    // 37493ba merged bookmarks and notes into the outline panel; the rail button follows it.
    await page.getByRole('button', { name: '打开目录、书签和笔记' }).click();
    await page.waitForTimeout(300);
    await shot(page, '09-reader-notes-dark-100-1440x900.png');
    await page.getByRole('button', { name: '关闭目录' }).click();

    // ---- AI service settings: compact rows in the settings page ------------------------
    await page.setViewportSize({ width: 1024, height: 689 });
    await page.getByRole('button', { name: '返回' }).click();
    await page.locator('.project').waitFor();
    await openAiSettings(page);
    const ai = await page.evaluate(() => {
      const dialog = document.querySelector('dialog[open]');
      const settings = document.querySelector('.settings');
      const panel = document.querySelector('.ai-settings');
      const choices = [...document.querySelectorAll('.settings-choice')];
      const stats = document.querySelector('.ai-settings__stats');
      const box = (element) => element.getBoundingClientRect();
      return {
        dialogOpen: dialog !== null,
        choices: choices.length,
        choiceHeights: choices.map((choice) => box(choice).height),
        stacked: choices.every(
          (choice, index) => index === 0 || box(choice).top >= box(choices[index - 1]).bottom - 1,
        ),
        statsColumns:
          stats === null ? 0 : getComputedStyle(stats).gridTemplateColumns.split(' ').length,
        panelWidth: box(panel).width,
        dialogWidth: box(dialog).width,
        overflow: dialog.scrollWidth > dialog.clientWidth + 1,
        inside: [
          ...panel.querySelectorAll('.settings-choice, .ai-settings__stats, .ai-settings__budget'),
        ].every((element) => {
          const one = box(element);
          const other = box(dialog);
          return one.left >= other.left - 1 && one.right <= other.right + 1;
        }),
        text: settings.textContent ?? '',
        state: document.querySelector('.ai-settings__state')?.textContent?.trim() ?? '',
        notice: document.querySelector('.ai-settings__notice')?.textContent?.trim() ?? '',
      };
    });
    check(
      'ai settings: the settings window shows both modes as compact rows',
      ai.dialogOpen === true &&
        ai.choices === 2 &&
        ai.choiceHeights.every((height) => height <= 72),
      JSON.stringify({ dialog: ai.dialogOpen, choices: ai.choices, heights: ai.choiceHeights }),
    );
    check('ai settings: the two modes are stacked, not two large cards', ai.stacked);
    check(
      'ai settings: the stats grid keeps two columns',
      ai.statsColumns === 2,
      `${String(ai.statsColumns)} columns`,
    );
    check(
      'ai settings: nothing overflows the settings window',
      !ai.overflow && ai.inside,
      `${String(ai.panelWidth)} / ${String(ai.dialogWidth)}`,
    );
    // The provider choice list names its own presets; the status line and the notice must
    // stay neutral about which vendor is behind the offline mode.
    check(
      'ai settings: no vendor name is shown in the status or the notice',
      !/deepseek|openai|anthropic|claude|moonshot|bigmodel|gemini/i.test(
        `${ai.state} ${ai.notice}`,
      ),
    );
    check(
      'ai settings: the mode is stated in neutral words',
      /离线模拟/.test(ai.state) && !/deepseek/i.test(ai.state),
      ai.state,
    );
    await audit(page, 'AI settings / dark 100');
    await shot(page, '10-ai-settings-dark-100-1024x689.png');
    await closeSettings(page);

    await setLevel(page, 0);
    await openAiSettings(page);
    await audit(page, 'AI settings / dark 0');
    await shot(page, '11-ai-settings-dark-0-1024x689.png');
    await closeSettings(page);

    // Narrow settings: one column, still no horizontal overflow.
    await page.setViewportSize({ width: 800, height: 800 });
    await page.waitForTimeout(250);
    await openAiSettings(page);
    const narrowAi = await page.evaluate(() => {
      const choices = [...document.querySelectorAll('.settings-choice')];
      const budget = document.querySelector('.ai-settings__budget');
      const dialog = document.querySelector('dialog[open]');
      const box = (element) => element.getBoundingClientRect();
      return {
        stacked:
          choices.length >= 2 &&
          choices[0].getBoundingClientRect().top !== choices[1].getBoundingClientRect().top,
        budgetColumns:
          budget === null ? 0 : getComputedStyle(budget).gridTemplateColumns.split(' ').length,
        overflow: dialog.scrollWidth > dialog.clientWidth + 1,
        width: box(dialog).width,
        viewport: window.innerWidth,
      };
    });
    check('ai settings: narrow windows keep the compact mode rows stacked', narrowAi.stacked);
    check(
      'ai settings: narrow windows stack the budget fields',
      narrowAi.budgetColumns === 1,
      `${String(narrowAi.budgetColumns)} columns`,
    );
    check(
      'ai settings: narrow windows have no horizontal overflow',
      !narrowAi.overflow && narrowAi.width <= narrowAi.viewport - 30,
      `${String(narrowAi.width)} / ${String(narrowAi.viewport)}`,
    );
    await shot(page, '12-ai-settings-narrow-800x800.png');
    await closeSettings(page);

    // ---- Keyboard focus and rapid interaction -------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.locator('.home').waitFor();
    await page.waitForTimeout(300);
    await page.locator('.brand').click();
    let focusRing = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await page.keyboard.press('Tab');
      focusRing = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return null;
        const style = getComputedStyle(active);
        return {
          tag: active.tagName,
          label: active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 20),
          outlineWidth: style.outlineWidth,
          outlineStyle: style.outlineStyle,
        };
      });
      if (focusRing !== null && focusRing.outlineStyle === 'solid') break;
    }
    check(
      'keyboard: Tab reaches a control with a visible focus ring',
      focusRing !== null &&
        focusRing.outlineStyle === 'solid' &&
        parseFloat(focusRing.outlineWidth) >= 2,
      focusRing === null
        ? 'no focus'
        : `${focusRing.tag} ${focusRing.label} ${focusRing.outlineWidth}`,
    );

    await openAppearance(page);
    await page.locator('.segmented[aria-label="主题"] .seg').last().focus();
    await page.keyboard.press('Tab');
    const sliderFocus = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active.getAttribute('type') !== 'range') return null;
      const style = getComputedStyle(active);
      return {
        visible: active.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    check(
      'keyboard: the dark-level slider is reachable and visibly focused',
      sliderFocus !== null &&
        sliderFocus.visible &&
        sliderFocus.outlineStyle === 'solid' &&
        parseFloat(sliderFocus.outlineWidth) >= 2,
      JSON.stringify(sliderFocus),
    );
    await shot(page, '13-focus-ring-1440x900.png');

    await page.evaluate(() => {
      const input = document.querySelector('input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      for (const value of [10, 90, 0, 75, 100]) {
        setter?.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const buttons = document.querySelectorAll('.segmented[aria-label="主题"] .seg');
      for (let round = 0; round < 3; round += 1) {
        buttons.forEach((button) => button.click());
      }
    });
    await page.waitForTimeout(500);
    const rapidTheme = await page.evaluate(() => ({
      level: document.documentElement.dataset.darkLevel,
      theme: document.documentElement.dataset.theme,
      pref: document.documentElement.dataset.themePref,
      storedLevel: localStorage.getItem('rw.themeLevel'),
      pressed: [...document.querySelectorAll('.segmented[aria-label="主题"] .seg')].filter(
        (button) => button.getAttribute('aria-pressed') === 'true',
      ).length,
    }));
    check(
      'rapid input: slider and theme clicks leave one coherent, persisted state',
      rapidTheme.pressed === 1 &&
        rapidTheme.level === '100' &&
        rapidTheme.storedLevel === rapidTheme.level &&
        rapidTheme.theme === 'dark',
      JSON.stringify(rapidTheme),
    );
    await closeSettings(page);

    for (let round = 0; round < 4; round += 1) {
      const open = await page.locator('.app').getAttribute('data-sidebar');
      if (open === 'open') {
        await page.locator('.sidebar').getByRole('button', { name: '收起侧栏' }).click();
      } else {
        await page.getByRole('button', { name: '展开侧栏' }).click();
      }
    }
    await page.waitForTimeout(400);
    check(
      'rapid input: four sidebar toggles leave one coherent state',
      (await page.locator('.app').getAttribute('data-sidebar')) === 'open' &&
        (await page.locator('.sidebar').count()) === 1,
    );

    for (let round = 0; round < 3; round += 1) {
      await page.locator('.sidebar').getByRole('button', { name: '设置' }).click();
      await page.locator('.settings').waitFor();
      await page.locator('.settings-nav').getByRole('button', { name: 'AI 服务' }).click();
      await page.locator('.ai-settings').waitFor();
      await closeSettings(page);
    }
    check(
      'rapid input: repeated settings visits leave no overlay or stray page behind',
      (await page.locator('dialog[open]').count()) === 0 &&
        (await page.locator('.scrim').count()) === 0 &&
        (await page.locator('.home').count()) === 1,
    );

    // ---- Reduced motion ----------------------------------------------------------------
    const reduced = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    await reduced.addInitScript(tauriStub);
    const reducedPage = await reduced.newPage();
    watch(reducedPage);
    await reducedPage.goto(ORIGIN);
    await seed(reducedPage, { theme: 'dark', level: 100 });
    const motion = await reducedPage.evaluate(() => {
      const button = document.querySelector('.btn');
      const style = getComputedStyle(button);
      const ambient = getComputedStyle(document.querySelector('.app'), '::before');
      return {
        duration: style.transitionDuration,
        animation: getComputedStyle(document.querySelector('.welcome')).animationName,
        ambientFilter: ambient.filter,
        activeTransform: (() => {
          button.classList.add('rw-test-active');
          return style.transform;
        })(),
      };
    });
    const seconds = Math.max(
      ...motion.duration
        .split(',')
        .map((part) => parseFloat(part) * (part.includes('ms') ? 0.001 : 1)),
    );
    check(
      'reduced motion: transitions collapse to the instant end state',
      seconds <= 0.001,
      motion.duration,
    );
    check('reduced motion: the ambient layer drops its blur', motion.ambientFilter === 'none');
    await shot(reducedPage, '14-reduced-motion-1440x900.png');
    await reduced.close();

    check(
      'console: no unexpected errors or warnings',
      consoleIssues.length === 0,
      consoleIssues.join(' | '),
    );
  } finally {
    await browser.close();
    server.kill();
  }

  const failed = results.filter((result) => !result.passed);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: ORIGIN,
    viewportMatrix: ['1440x900', '1024x689', '720x820', '800x800'],
    dataIsolation:
      'Fresh Playwright browser profile; sample state written to localStorage in that profile only; ' +
      'desktop webview data directory is never opened.',
    aiBackend:
      'Tauri IPC stubbed in the browser context; no sidecar, credential store or network call.',
    consoleIssues,
    contrast: contrasts,
    results,
    passed: results.length - failed.length,
    failed: failed.length,
    screenshots: fileURLToPath(SHOT_DIR),
  };
  await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `\n${String(report.passed)}/${String(results.length)} checks passed; report: ${fileURLToPath(REPORT_FILE)}\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();

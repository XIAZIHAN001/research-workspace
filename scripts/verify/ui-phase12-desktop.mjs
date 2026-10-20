/**
 * Phase 12.1 desktop acceptance: continuous dark level and monochrome controls in the real
 * Tauri/WebView2 window, over CDP.
 *
 * The app is expected to be running already in development mode (the dev identifier and its
 * isolated WebView data directory), with
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9555`.
 * This script does not launch, install, uninstall or close the application, and it never
 * switches the AI provider or touches a credential. It only inspects and drives the UI that
 * is already on screen.
 */

/* global window, document, getComputedStyle, location, HTMLInputElement */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { auditContrast } from './contrast.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = join(ROOT, 'docs', 'screenshots-phase12', `${STAMP}-desktop`);
const REPORT_FILE = join(ROOT, 'docs', 'phase12.1-desktop-verification-report.json');
const CDP_PORT = Number(process.env.RW_UI_CDP_PORT ?? '9555');

const results = [];
const contrasts = [];
const consoleIssues = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
}

function watch(page) {
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('status of 401 (Unauthorized)')) return;
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleIssues.push(`${message.type()}: ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    consoleIssues.push(`pageerror: ${error.message}`);
  });
}

async function connect() {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(CDP_PORT)}`);
      const context = browser.contexts()[0];
      if (context !== undefined) {
        const page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 5000 }));
        await page.locator('.app').waitFor({ timeout: 20_000 });
        return { browser, page };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw lastError ?? new Error('could not connect to the development app over CDP');
}

async function shot(page, name) {
  await page.screenshot({ path: join(SHOT_DIR, name), animations: 'disabled' });
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

async function openSettings(page) {
  if ((await page.locator('dialog[open] .settings').count()) === 0) {
    await page.locator('.sidebar').getByRole('button', { name: '设置' }).click();
    await page.locator('dialog[open] .settings').waitFor();
  }
  await page.waitForTimeout(200);
}

async function openAppearance(page) {
  await openSettings(page);
  await page.locator('.settings-nav').getByRole('button', { name: '外观' }).click();
  await page.locator('.theme-level').waitFor();
  await page.waitForTimeout(200);
}

async function openAiSettings(page) {
  await openSettings(page);
  await page.locator('.settings-nav').getByRole('button', { name: 'AI 服务' }).click();
  await page.locator('.ai-settings').waitFor();
  await page.waitForTimeout(400);
}

async function closeSettings(page) {
  await page.locator('dialog[open]').getByRole('button', { name: '关闭' }).click();
  await page.waitForFunction(() => document.querySelector('dialog[open]') === null);
}

async function theme(page, label) {
  await openAppearance(page);
  await page.locator(`.segmented button[aria-label="${label}"]`).click();
  await page.waitForTimeout(280);
}

async function setLevel(page, level) {
  await openAppearance(page);
  await page.locator('input[type="range"][aria-label="深色程度"]').evaluate((element, value) => {
    // React tracks the previous value on the element; use the prototype setter so the
    // synthetic input event is seen as a real change.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, level);
  await page.waitForTimeout(280);
}

async function surfaces(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const rgb = (selector) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      const css = getComputedStyle(element).backgroundColor;
      return {
        css,
        channels: (css.match(/\d+/g) ?? []).slice(0, 3).map(Number),
      };
    };
    return {
      theme: root.dataset.theme,
      level: root.dataset.darkLevel,
      style: root.dataset.themeStyle,
      app: rgb('.app'),
      main: rgb('.main'),
      panel: rgb('.home-panel'),
      sidebar: root.style.getPropertyValue('--dark-sidebar'),
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
      backgroundChannels: background,
      foregroundChannels: foreground,
      ratio:
        Math.round(((Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05)) * 100) / 100,
    };
  });
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  const { browser, page } = await connect();
  watch(page);
  const initial = await page.evaluate(() => ({
    pref: window.localStorage.getItem('rw.theme'),
    level: window.localStorage.getItem('rw.themeLevel'),
    style: window.localStorage.getItem('rw.themeStyle'),
  }));
  let windowInfo;

  try {
    const base = await page.evaluate(() => ({
      url: location.href,
      viewport: [window.innerWidth, window.innerHeight],
      devicePixelRatio: window.devicePixelRatio,
      theme: document.documentElement.dataset.theme,
      pref: document.documentElement.dataset.themePref,
      style: document.documentElement.dataset.themeStyle,
    }));
    check(
      'desktop: the window is running the development UI over the dev server',
      base.url === 'http://127.0.0.1:1440/',
      base.url,
    );
    windowInfo = {
      cssViewport: `${String(base.viewport[0])}×${String(base.viewport[1])}`,
      devicePixelRatio: base.devicePixelRatio,
    };
    await openAppearance(page);
    const settingsBase = await page.evaluate(() => ({
      segments: [...document.querySelectorAll('.seg')].map((button) =>
        button.getAttribute('aria-label'),
      ),
      slider: document.querySelector('input[type="range"]')?.value ?? null,
      sliderBlock: (() => {
        const slider = document.querySelector('input[type="range"]');
        return slider === null ? null : slider.getBoundingClientRect().width;
      })(),
    }));
    check(
      'desktop: Settings › 外观 holds the three theme choices and the level slider',
      settingsBase.segments.join('|') === '跟随系统|浅色|深色' &&
        settingsBase.slider !== null &&
        (settingsBase.sliderBlock ?? 0) > 40,
      JSON.stringify(settingsBase),
    );
    await shot(page, '00-desktop-settings-appearance-1024x689.png');
    await closeSettings(page);
    check(
      'desktop: the first-level home page has no theme controls',
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
      'desktop: the avatar sits at the bottom-left of the sidebar',
      avatarPlacement !== null &&
        avatarPlacement.inSidebar &&
        avatarPlacement.nearBottom &&
        avatarPlacement.nearLeft,
      JSON.stringify(avatarPlacement),
    );

    const layout = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar');
      const foot = document.querySelector('.sidebar-foot');
      const main = document.querySelector('.main');
      const sidebarBox = sidebar.getBoundingClientRect();
      return {
        sidebarWidth: sidebarBox.width,
        footerInside: [...(foot?.querySelectorAll('button') ?? [])].every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= sidebarBox.left - 1 && rect.right <= sidebarBox.right + 1;
        }),
        bodyOverflow: document.documentElement.scrollWidth > window.innerWidth,
        mainOverflow: main.scrollWidth > main.clientWidth + 1,
      };
    });
    check(
      'desktop: the sidebar measures within 240–260px',
      layout.sidebarWidth >= 240 && layout.sidebarWidth <= 260,
      `${String(layout.sidebarWidth)}px`,
    );
    check('desktop: footer controls stay inside the sidebar', layout.footerInside);
    check(
      'desktop: no horizontal overflow in the window',
      !layout.bodyOverflow && !layout.mainOverflow,
    );

    // ---- Theme surfaces in the real WebView2 ------------------------------------------
    await theme(page, '深色');
    await closeSettings(page);
    const darkBase = await surfaces(page);
    check(
      'desktop theme: choosing dark keeps the control on dark',
      darkBase.theme === 'dark' &&
        (await page.evaluate(() => document.documentElement.dataset.themePref)) === 'dark',
      JSON.stringify({ theme: darkBase.theme, level: darkBase.level }),
    );

    for (const expected of [
      { level: 0, app: 36, panel: 49, name: '01-desktop-home-dark-0' },
      { level: 50, app: 18, panel: 31, name: '02-desktop-home-dark-50' },
      { level: 100, app: 0, panel: 13, name: '03-desktop-home-dark-100' },
    ]) {
      await setLevel(page, expected.level);
      await closeSettings(page);
      const actual = await surfaces(page);
      check(
        `desktop theme: level ${String(expected.level)} paints a neutral app and panel`,
        actual.level === String(expected.level) &&
          actual.app.channels.every((channel) => channel === expected.app) &&
          actual.main.channels.every((channel) => channel === expected.panel) &&
          actual.panel?.channels.every((channel) => channel === expected.panel) === true &&
          actual.app.channels.every((channel) => channel === actual.app.channels[0]),
        JSON.stringify({ app: actual.app.css, main: actual.main.css }),
      );
      if (expected.level === 100 || expected.level === 0) {
        await audit(page, `desktop home / dark ${String(expected.level)}`);
      }
      await shot(page, `${expected.name}-1024x689.png`);
    }

    await setLevel(page, 100);
    await closeSettings(page);
    const primary = await primaryContrast(page);
    check(
      'desktop primary: white button, near-black label, AA contrast',
      primary !== null &&
        primary.ratio >= 4.5 &&
        primary.backgroundChannels.every((channel) => channel >= 240) &&
        primary.foregroundChannels.every((channel) => channel <= 24),
      JSON.stringify(primary),
    );

    await theme(page, '浅色');
    await closeSettings(page);
    const light = await surfaces(page);
    const primaryLight = await primaryContrast(page);
    check(
      'desktop theme: light stays neutral and inverts the primary button',
      light.theme === 'light' &&
        light.app.channels.every((channel) => channel === 236) &&
        primaryLight !== null &&
        primaryLight.ratio >= 4.5 &&
        primaryLight.backgroundChannels.every((channel) => channel <= 24) &&
        primaryLight.foregroundChannels.every((channel) => channel >= 240),
      JSON.stringify({ light, primaryLight }),
    );
    await audit(page, 'desktop home / light');
    await shot(page, '04-desktop-home-light-1024x689.png');

    await theme(page, '深色');
    await setLevel(page, 100);
    await closeSettings(page);

    // ---- AI settings inside the Settings window ----------------------------------------
    await openAiSettings(page);
    const ai = await page.evaluate(() => {
      const dialog = document.querySelector('dialog[open]');
      const settings = document.querySelector('.settings');
      const panel = document.querySelector('.ai-settings');
      const choices = [...document.querySelectorAll('.settings-choice')];
      const stats = document.querySelector('.ai-settings__stats');
      const rect = (element) => element.getBoundingClientRect();
      return {
        dialogOpen: dialog !== null,
        choices: choices.length,
        heights: choices.map((choice) => rect(choice).height),
        stacked: choices.every(
          (choice, index) => index === 0 || rect(choice).top >= rect(choices[index - 1]).bottom - 1,
        ),
        statsColumns:
          stats === null ? 0 : getComputedStyle(stats).gridTemplateColumns.split(' ').length,
        overflow: dialog.scrollWidth > dialog.clientWidth + 1,
        panelWidth: rect(panel).width,
        dialogWidth: rect(dialog).width,
        inside: [
          ...panel.querySelectorAll('.settings-choice, .ai-settings__stats, .ai-settings__budget'),
        ].every((element) => {
          const one = rect(element);
          const other = rect(dialog);
          return one.left >= other.left - 1 && one.right <= other.right + 1;
        }),
        text: settings.textContent ?? '',
        state: document.querySelector('.ai-settings__state')?.textContent?.trim() ?? '',
      };
    });
    check(
      'desktop ai: the settings window shows both modes as compact rows',
      ai.dialogOpen === true && ai.choices === 2 && ai.heights.every((height) => height <= 72),
      JSON.stringify({ dialog: ai.dialogOpen, choices: ai.choices, heights: ai.heights }),
    );
    check('desktop ai: the two modes are stacked, not large cards', ai.stacked);
    check(
      'desktop ai: the stats grid keeps two columns',
      ai.statsColumns === 2,
      `${String(ai.statsColumns)} columns`,
    );
    check(
      'desktop ai: nothing overflows the settings window',
      !ai.overflow && ai.inside,
      `${String(ai.panelWidth)} / ${String(ai.dialogWidth)}`,
    );
    check(
      'desktop ai: no vendor name is shown',
      !/deepseek|openai|anthropic|claude|moonshot|bigmodel|gemini/i.test(ai.text),
    );
    check(
      'desktop ai: the mode is stated in neutral words',
      /离线模拟/.test(ai.state) && !/deepseek/i.test(ai.state),
      ai.state,
    );
    await audit(page, 'desktop AI settings / dark 100');
    await shot(page, '05-desktop-ai-settings-dark-100-1024x689.png');
    await closeSettings(page);

    await setLevel(page, 0);
    await openAiSettings(page);
    await audit(page, 'desktop AI settings / dark 0');
    await shot(page, '06-desktop-ai-settings-dark-0-1024x689.png');
    await closeSettings(page);

    await setLevel(page, 100);
    await closeSettings(page);

    // ---- Reader: the PDF stays the visual subject and is not filtered ------------------
    const pdfTitle = await page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null');
      const paper = Object.values(state?.papers ?? {}).find(
        (candidate) => candidate.pdf !== undefined && candidate.pdf !== null,
      );
      return paper?.title ?? null;
    });
    if (pdfTitle !== null) {
      await page.getByRole('button', { name: '首页' }).click();
      await page.locator('.home').waitFor();
      await page
        .locator('.sidebar')
        .getByRole('button', { name: /桌面开发验收/ })
        .first()
        .click();
      await page.locator('.project').waitFor();
      await page.getByRole('button', { name: '阅读' }).first().click();
      await page.locator('.reader').waitFor({ timeout: 20_000 });
      await page.locator('.pdf-page[data-page="1"] canvas').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(600);
      const pdf = await page.evaluate(() => {
        const pageBox = document.querySelector('.pdf-page');
        const scroll = document.querySelector('.reader-scroll');
        const pageStyle = getComputedStyle(pageBox);
        const scrollStyle = getComputedStyle(scroll);
        return {
          filter: pageStyle.filter,
          backdrop: pageStyle.backdropFilter || pageStyle.webkitBackdropFilter || 'none',
          scrollFilter: scrollStyle.filter,
          text: document.querySelector('.reader-bar')?.textContent ?? '',
        };
      });
      check(
        'desktop reader: the PDF page has no theme filter or blur',
        pdf.filter === 'none' && pdf.backdrop === 'none' && pdf.scrollFilter === 'none',
        JSON.stringify(pdf),
      );
      check(
        'desktop reader: the reading toolbar is present',
        pdf.text.includes('返回') && pdf.text.includes('适应宽度'),
      );
      await audit(page, 'desktop reader / dark 100');
      await shot(page, '07-desktop-reader-dark-100-1024x689.png');
      await page.getByRole('button', { name: '返回' }).click();
      await page.locator('.project').waitFor();
    } else {
      check('desktop reader: a paper with a PDF exists in the isolated profile', false);
    }

    // ---- Keyboard focus and reduced motion --------------------------------------------
    await page.getByRole('button', { name: '首页' }).click();
    await page.locator('.home').waitFor();
    await page.waitForTimeout(300);
    await page.locator('.brand').click();
    let ring = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await page.keyboard.press('Tab');
      ring = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return null;
        const style = getComputedStyle(active);
        return {
          label: active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 20),
          width: parseFloat(style.outlineWidth),
          style: style.outlineStyle,
        };
      });
      if (ring !== null && ring.style === 'solid') break;
    }
    check(
      'desktop keyboard: a visible focus ring appears',
      // Chromium rounds outline widths to whole device pixels. At this machine's 1.875 DPR a
      // 2 CSS px outline is 3 device px, reported as 1.6 CSS px — still visibly 3 pixels wide.
      ring !== null && ring.style === 'solid' && ring.width >= 1.5,
      ring === null ? 'no focus' : `${ring.label} ${String(ring.width)}px`,
    );

    await openAppearance(page);
    await page.locator('.segmented .seg').last().focus();
    await page.keyboard.press('Tab');
    const sliderFocus = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active.getAttribute('type') !== 'range') return null;
      const style = getComputedStyle(active);
      return {
        visible: active.matches(':focus-visible'),
        width: parseFloat(style.outlineWidth),
        style: style.outlineStyle,
      };
    });
    check(
      'desktop keyboard: the dark-level slider is reachable and visibly focused',
      sliderFocus !== null &&
        sliderFocus.visible &&
        sliderFocus.style === 'solid' &&
        sliderFocus.width >= 1.5,
      JSON.stringify(sliderFocus),
    );

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    const reduced = await page.evaluate(() => ({
      duration: getComputedStyle(document.querySelector('.btn')).transitionDuration,
      ambient: getComputedStyle(document.querySelector('.app'), '::before').filter,
    }));
    const longest = Math.max(
      ...reduced.duration
        .split(',')
        .map((part) => parseFloat(part) * (part.includes('ms') ? 0.001 : 1)),
    );
    check('desktop reduced motion: transitions collapse', longest <= 0.001, reduced.duration);
    check('desktop reduced motion: the ambient blur is removed', reduced.ambient === 'none');
    await shot(page, '08-desktop-reduced-motion-1024x689.png');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // ---- Rapid switching ---------------------------------------------------------------
    await page.evaluate(() => {
      const input = document.querySelector('input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      for (const value of [10, 90, 0, 75, 100]) {
        setter?.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const buttons = document.querySelectorAll('.segmented .seg');
      for (let round = 0; round < 3; round += 1) buttons.forEach((button) => button.click());
    });
    await page.waitForTimeout(500);
    const rapid = await page.evaluate(() => ({
      level: document.documentElement.dataset.darkLevel,
      theme: document.documentElement.dataset.theme,
      storedLevel: window.localStorage.getItem('rw.themeLevel'),
      pressed: [...document.querySelectorAll('.seg')].filter(
        (button) => button.getAttribute('aria-pressed') === 'true',
      ).length,
    }));
    check(
      'desktop rapid input: the slider and theme clicks settle on one persisted state',
      rapid.pressed === 1 &&
        rapid.level === '100' &&
        rapid.theme === 'dark' &&
        rapid.storedLevel === rapid.level,
      JSON.stringify(rapid),
    );

    check(
      'desktop console: no unexpected errors or warnings',
      consoleIssues.length === 0,
      consoleIssues.slice(0, 3).join(' | '),
    );
  } finally {
    // Put the profile back where it started; this is an inspection, not a preference change.
    await page.evaluate(
      ({ pref, level, style }) => {
        const restore = (key, value) => {
          if (value === null) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, value);
        };
        restore('rw.theme', pref);
        restore('rw.themeLevel', level);
        restore('rw.themeStyle', style);
      },
      { pref: initial.pref, level: initial.level, style: initial.style },
    );
    await page.reload();
    await page.locator('.app').waitFor();
    await browser.close();
  }

  const failed = results.filter((result) => !result.passed);
  const report = {
    generatedAt: new Date().toISOString(),
    source: `Tauri development window over CDP on 127.0.0.1:${String(CDP_PORT)}`,
    window: {
      ...(windowInfo ?? {}),
      note: 'The real WebView2 window; outline widths are rounded to whole device pixels.',
    },
    dataIsolation:
      'Development identifier com.researchworkspace.desktop.dev; the installed application and ' +
      'its webview directory were not opened. The profile was restored to its starting theme.',
    aiBackend:
      'The running development app, which starts in offline Mock. No mode switch, key operation ' +
      'or model request was performed.',
    consoleIssues,
    contrast: contrasts,
    results,
    passed: results.length - failed.length,
    failed: failed.length,
    screenshots: SHOT_DIR,
  };
  await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `\n${String(report.passed)}/${String(results.length)} desktop checks passed. Report: ${REPORT_FILE}\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();

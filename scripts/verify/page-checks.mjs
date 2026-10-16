/* global document, window, getComputedStyle */
import { createRequire } from 'node:module';

const AXE_PATH = createRequire(import.meta.url).resolve('axe-core');

/** Collects console errors and warnings, uncaught exceptions and failed requests. */
export function watchPage(page) {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`console.${message.type()}: ${message.text().slice(0, 200)}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));
  return problems;
}

/** Runs axe-core in the page and returns a compact summary. */
export async function runAxe(page) {
  if (!(await page.evaluate(() => 'axe' in window))) {
    await page.addScriptTag({ path: AXE_PATH });
  }
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ['violations', 'incomplete'] });
    const brief = (items) =>
      items.map((item) => ({
        id: item.id,
        impact: item.impact,
        help: item.help,
        count: item.nodes.length,
        targets: item.nodes.slice(0, 3).map((node) => node.target.join(' ')),
      }));
    return {
      violations: brief(result.violations),
      incomplete: brief(result.incomplete),
      passes: result.passes.length,
    };
  });
}

/**
 * Lists visible elements that stick out of the viewport horizontally. The body does not
 * scroll, so anything outside is simply cut off; a plain scrollWidth check would miss it.
 */
export function findOverflow(page) {
  return page.evaluate(() => {
    const limit = window.innerWidth;
    const offenders = [];
    for (const element of document.querySelectorAll('body *')) {
      if (element.closest('[inert], dialog:not([open]), .sr-only')) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(element).visibility === 'hidden') continue;
      if (box.right > limit + 1 || box.left < -1) {
        const name = String(element.className).split(' ')[0];
        offenders.push(
          `${element.tagName.toLowerCase()}${name ? `.${name}` : ''} [${Math.round(box.left)}..${Math.round(box.right)}]`,
        );
      }
    }
    return { width: limit, offenders: offenders.slice(0, 6) };
  });
}

/** Modal and focus facts about the open dialog, if any. */
export function dialogState(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]');
    const active = document.activeElement;
    return {
      open: dialog !== null,
      modal: dialog?.matches(':modal') ?? false,
      focusInside: dialog?.contains(active) ?? false,
      focusEscaped: dialog !== null && active !== document.body && !dialog.contains(active),
      active: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 20),
    };
  });
}

/** Current value of the registered --glow property on the first match of `selector`. */
export function readGlow(page, selector) {
  return page.evaluate(
    (sel) => Number(getComputedStyle(document.querySelector(sel)).getPropertyValue('--glow')),
    selector,
  );
}

export function readAppState(page) {
  return page.evaluate(() => {
    const app = document.querySelector('.app');
    const sidebar = document.querySelector('aside.sidebar');
    return {
      sidebar: app?.dataset.sidebar,
      narrow: app?.dataset.narrow,
      inert: sidebar?.hasAttribute('inert'),
      theme: document.documentElement.dataset.theme,
      pref: document.documentElement.dataset.themePref,
    };
  });
}

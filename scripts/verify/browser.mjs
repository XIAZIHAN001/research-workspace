import { chromium } from 'playwright-core';

/**
 * Launches an installed Chromium-family browser. Nothing is downloaded.
 * Set BROWSER_PATH to use a specific executable; otherwise Edge, then Chrome.
 */
export async function launchBrowser() {
  const executablePath = process.env.BROWSER_PATH;
  if (executablePath) return chromium.launch({ executablePath });

  const failures = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel });
    } catch (error) {
      failures.push(`${channel}: ${String(error.message).split('\n')[0]}`);
    }
  }
  throw new Error(`Could not launch an installed Edge or Chrome.\n${failures.join('\n')}`);
}

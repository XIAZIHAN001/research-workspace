/* global document */
/**
 * Shared theme switch for the browser acceptance scripts.
 *
 * Since Phase 12.1 the three themes live in Settings › Appearance, not on the first-level
 * page. The settings window is modal and leaves the reader mounted underneath, so this helper
 * can be used while a paper is open: open, change, close, and the caller stays where it was.
 */
export async function setAppTheme(page, label) {
  const alreadyOpen = (await page.locator('dialog[open] .settings').count()) > 0;
  if (!alreadyOpen) {
    if ((await page.locator('.app').getAttribute('data-sidebar')) !== 'open') {
      await page.getByRole('button', { name: '展开侧栏' }).click();
      await page.waitForTimeout(250);
    }
    await page.locator('.sidebar').getByRole('button', { name: '设置' }).click();
    await page.locator('dialog[open] .settings').waitFor();
  }
  await page.locator('.settings-nav').getByRole('button', { name: '外观' }).click();
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(250);
  if (!alreadyOpen) {
    await page.locator('dialog[open]').getByRole('button', { name: '关闭' }).click();
    await page.waitForFunction(() => document.querySelector('dialog[open]') === null);
  }
}

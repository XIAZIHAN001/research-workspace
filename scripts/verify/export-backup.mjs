/**
 * Exports the installed application's own `.rwbackup` to a path outside the project.
 *
 * This is a backup operation, not an acceptance test: it opens the real backup dialog and saves
 * the file the application produces. The default destination is deliberately outside the
 * repository so a later cleanup cannot remove the only copy.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const output = process.argv[2] ?? `D:\\Research Workspace Backups\\phase11-${STAMP}.rwbackup`;

function findExe() {
  const local = process.env.LOCALAPPDATA ?? '';
  return [
    process.env.RW_DESKTOP_EXE,
    join(local, 'Research Workspace', 'research-workspace.exe'),
    'D:\\Research Workspace\\research-workspace.exe',
    join(ROOT, 'src-tauri', 'target', 'release', 'research-workspace.exe'),
  ]
    .filter((value) => value !== undefined && value !== '')
    .find((candidate) => existsSync(candidate));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function connect(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
      const context = browser.contexts()[0];
      if (context !== undefined) {
        const page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 8000 }));
        await page.locator('.app').waitFor({ timeout: 20_000 });
        return { browser, page };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError ?? new Error('could not connect to the app over CDP');
}

const exe = findExe();
if (exe === null) throw new Error('找不到已安装的桌面应用；请先安装或设置 RW_DESKTOP_EXE。');
await mkdir(dirname(resolve(output)), { recursive: true });

const port = await freePort();
const child = spawn(exe, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${String(port)}`,
  },
  stdio: 'ignore',
});
let browser = null;
try {
  const connected = await connect(port);
  browser = connected.browser;
  const page = connected.page;
  await page.getByRole('button', { name: '备份与恢复' }).click();
  await page.getByRole('heading', { name: '导出整个知识库' }).waitFor({ timeout: 10_000 });
  const pending = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: '导出备份文件' }).click();
  const download = await pending;
  await download.saveAs(output);
  const info = await stat(output);
  process.stdout.write(`备份已导出：${output}（${String(info.size)} 字节）\n`);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p = Get-Process -Id ${String(child.pid)} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() | Out-Null }`,
      ],
      { windowsHide: true },
    );
  } catch {
    // Already gone.
  }
  await sleep(2000);
}

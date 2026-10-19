/**
 * Phase 11: the installed application with no development toolchain on PATH.
 *
 * The claim to check is narrow and concrete: the release binary starts, finds its bundled
 * `rw-node.exe`, serves its webview, authenticates its sidecar and answers an offline question
 * when neither Node.js, Rust/Cargo nor MSVC is on the process's PATH. This is not a clean
 * Windows machine — WebView2 is installed here, and the application was installed by this
 * project — so "clean machine" remains a separate, unverified claim.
 */

/* global window */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = join(ROOT, 'docs', 'screenshots-phase11', `${STAMP}-isolated-env`);
const REPORT_FILE = join(SHOT_DIR, 'report.json');

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
}

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

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
await mkdir(SHOT_DIR, { recursive: true });

// A deliberately bare PATH: no Node, no Cargo, no Visual Studio.
const sanitizedPath = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem';
const port = await freePort();
const child = spawn(exe, [], {
  env: {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    WINDIR: process.env.WINDIR ?? 'C:\\Windows',
    TEMP: process.env.TEMP ?? 'C:\\Windows\\Temp',
    TMP: process.env.TMP ?? 'C:\\Windows\\Temp',
    USERPROFILE: process.env.USERPROFILE ?? '',
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
    APPDATA: process.env.APPDATA ?? '',
    PROGRAMDATA: process.env.PROGRAMDATA ?? 'C:\\ProgramData',
    PATH: sanitizedPath,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${String(port)}`,
  },
  stdio: 'ignore',
});

let browser = null;
try {
  const connected = await connect(port);
  browser = connected.browser;
  const page = connected.page;
  await page.locator('.ai-service-badge[data-state="ready"]').waitFor({ timeout: 40_000 });
  check('无 Node/Rust/MSVC 的 PATH 下应用启动', true);
  check(
    'AI 状态为离线 Mock',
    (await page.locator('.ai-service-badge').innerText()).includes('离线 Mock'),
  );

  const sidecarPath = powershell(
    `$p = Get-CimInstance Win32_Process -Filter "Name='rw-node.exe'" | Where-Object { $_.ParentProcessId -eq ${String(child.pid)} } | Select-Object -First 1; if ($p) { $p.ExecutablePath }`,
  );
  check(
    'sidecar 来自安装目录而不是全局 Node',
    sidecarPath.toLowerCase().includes('research workspace\\sidecar\\rw-node.exe'),
    sidecarPath,
  );
  check('启动环境不含开发工具目录', !/nodejs|\\Rust\\|VS CODE/i.test(sanitizedPath), sanitizedPath);

  const roundTrip = await page.evaluate(async () => {
    const internals = window.__TAURI_INTERNALS__;
    if (internals === undefined) return { error: 'no-ipc' };
    const info = await internals.invoke('ai_service_info');
    if (info?.state !== 'ready' || info.baseUrl === null || info.token === null) {
      return { error: 'not-ready', info };
    }
    const healthResponse = await fetch(`${info.baseUrl}/api/ai/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    const health = await healthResponse.json();
    const askResponse = await fetch(`${info.baseUrl}/api/ai/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${info.token}`,
      },
      body: JSON.stringify({
        mode: 'ask',
        question: '这一页说明了什么？',
        paper: { id: 'isolated', title: 'Isolated run', page: 1, pdfSha256: 'a'.repeat(64) },
        passages: [
          {
            id: 'selection',
            page: 1,
            text: 'The model learns a representation that is invariant to the ordering of the input tokens.',
            selection: true,
          },
        ],
      }),
    });
    const ask = await askResponse.json();
    return { info, health, askStatus: askResponse.status, ask };
  });
  check(
    'IPC 能取得服务地址与令牌',
    roundTrip.error === undefined && roundTrip.info?.instanceId?.length >= 8,
    JSON.stringify(roundTrip.error ?? roundTrip.info?.instanceId ?? ''),
  );
  check(
    '健康检查证明离线服务可用',
    roundTrip.health?.provider === 'mock' && roundTrip.health?.online === false,
    JSON.stringify(roundTrip.health?.provider ?? roundTrip.error),
  );
  check(
    '离线问答在纯净 PATH 下仍可完成',
    roundTrip.askStatus === 200 && typeof roundTrip.ask?.answer === 'string',
    `status=${String(roundTrip.askStatus)}`,
  );
  await page.screenshot({ path: join(SHOT_DIR, '01-isolated-path.png') });
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

const failures = results.filter((entry) => !entry.passed);
await writeFile(
  REPORT_FILE,
  `${JSON.stringify(
    {
      phase: 11,
      mode: 'isolated-runtime-env',
      generatedAt: new Date().toISOString(),
      executable: exe,
      path: sanitizedPath,
      results,
      failures: failures.length,
      note: '这不是全新的 Windows 机器；WebView2 已安装，应用由本项目安装。干净机器安装仍未验证。',
    },
    null,
    2,
  )}\n`,
  'utf8',
);
process.stdout.write(
  `\n${String(results.length - failures.length)}/${String(results.length)} checks passed. Report: ${REPORT_FILE}\n`,
);
if (failures.length > 0) process.exitCode = 1;

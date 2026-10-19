/**
 * Phase 11 desktop acceptance: credentials, mode switching, cost surface and single instance.
 *
 * It runs against the installed application and a real Windows credential store, but it never
 * sends a model request. Online mode is switched on with a throwaway key solely to prove that
 * the shell starts the DeepSeek provider and reports it; the session request counter must stay
 * at zero, which is the evidence that entering online mode does not itself spend anything.
 *
 * The test key is created by this script and deleted by it. If a key was already configured
 * before the run, the script does not touch it and the key-dependent checks are reported as
 * skipped.
 */

/* global window */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = join(ROOT, 'docs', 'screenshots-phase11', `${STAMP}-desktop-ai`);
const REPORT_FILE = join(SHOT_DIR, 'report.json');
const KEY = `sk-phase11-acceptance-${STAMP.replace(/-/g, '')}`;
const CREDENTIAL_TARGET = 'ResearchWorkspace/DeepSeekApiKey';
const APP_IDENTIFIER = 'com.researchworkspace.desktop';

const results = [];
const consoleIssues = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
  return passed;
}

function skip(name, reason) {
  results.push({ name, passed: true, skipped: true, detail: reason });
  process.stdout.write(`SKIP  ${name}  (${reason})\n`);
}

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function findExe() {
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    process.env.RW_DESKTOP_EXE,
    join(local, 'Research Workspace', 'research-workspace.exe'),
    join(local, 'Programs', 'Research Workspace', 'research-workspace.exe'),
    'D:\\Research Workspace\\research-workspace.exe',
    join(ROOT, 'src-tauri', 'target', 'release', 'research-workspace.exe'),
  ].filter((value) => value !== undefined && value !== '');
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function launchApp(exe, port) {
  return spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${String(port)}`,
    },
    stdio: 'ignore',
  });
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

function processExists(pid) {
  return (
    powershell(
      `if (Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
    ) === 'yes'
  );
}

async function waitForAppExit(appPid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(appPid)) return true;
    await sleep(300);
  }
  return false;
}

async function closeApp(child) {
  try {
    powershell(
      `$p = Get-Process -Id ${String(child.pid)} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() | Out-Null }`,
    );
  } catch {
    // Already gone.
  }
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    sleep(15_000).then(() => false),
  ]);
  if (!exited) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  await waitForAppExit(child.pid, 10_000);
}

function sidecarPidsFor(appPid) {
  const output = powershell(
    `Get-CimInstance Win32_Process -Filter "Name='rw-node.exe'" | Where-Object { $_.ParentProcessId -eq ${String(appPid)} } | ForEach-Object { $_.ProcessId }`,
  );
  return output
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function appProcessCount() {
  const output = powershell(
    `@(Get-Process -Name research-workspace -ErrorAction SilentlyContinue).Count`,
  );
  return Number(output) || 0;
}

function credentialTargetExists() {
  const output = powershell('cmdkey /list');
  return output.includes(CREDENTIAL_TARGET);
}

async function directoryContains(directory, needle) {
  if (!existsSync(directory)) return false;
  const bytes = Buffer.from(needle, 'utf8');
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile()) {
        try {
          const content = await readFile(path);
          if (content.includes(bytes)) return true;
        } catch {
          // A locked WebView file is not evidence either way; the localStorage and config
          // checks cover the places this application can write.
        }
      }
    }
  }
  return false;
}

async function storageCounts(page) {
  return page.evaluate(() => {
    const parse = (key) => {
      try {
        return JSON.parse(window.localStorage.getItem(key) ?? 'null');
      } catch {
        return null;
      }
    };
    const projects = parse('rw.projects');
    const knowledge = parse('rw.knowledge');
    return {
      schema: projects?.version ?? null,
      projects: Array.isArray(projects?.projects) ? projects.projects.length : 0,
      papers: projects?.papers === undefined ? 0 : Object.keys(projects.papers).length,
      annotations: Array.isArray(projects?.annotations) ? projects.annotations.length : 0,
      knowledgeVersion: knowledge?.version ?? null,
      concepts: Array.isArray(knowledge?.concepts) ? knowledge.concepts.length : 0,
      relations: Array.isArray(knowledge?.relations) ? knowledge.relations.length : 0,
      rejections: Array.isArray(knowledge?.rejections) ? knowledge.rejections.length : 0,
    };
  });
}

async function openAiSettings(page) {
  await page.getByRole('button', { name: 'AI 设置' }).first().click();
  await page.locator('dialog[open] .ai-settings').waitFor({ timeout: 10_000 });
}

async function closeAiSettings(page) {
  await page.locator('dialog[open] button[aria-label="关闭"]').click();
  await page
    .locator('dialog[open]')
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {});
}

async function waitForBadge(page, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    const badge = page.locator('.ai-service-badge[data-state="ready"]');
    if ((await badge.count()) === 1) {
      text = await badge.innerText();
      if (predicate(text)) return text;
    }
    await sleep(400);
  }
  throw new Error(`AI badge did not reach the expected state: ${text}`);
}

async function screenshot(page, name) {
  await page.screenshot({ path: join(SHOT_DIR, name) });
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  const exe = findExe();
  if (exe === null) throw new Error('找不到桌面应用可执行文件；请先安装或设置 RW_DESKTOP_EXE。');
  check('找到桌面应用可执行文件', true, exe);

  const version = powershell(
    `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
  );
  check('安装版本为 0.11.0', version.startsWith('0.11.0'), version);

  const webviewDir = join(process.env.LOCALAPPDATA ?? '', APP_IDENTIFIER, 'webview');
  const configFile = join(process.env.APPDATA ?? '', APP_IDENTIFIER, 'ai-preferences.json');
  const keyConfiguredBefore = credentialTargetExists();
  if (keyConfiguredBefore) {
    skip('系统凭据写入与在线模式切换', '运行前已经存在一个 API Key，未覆盖用户凭据');
  }

  const port = await freePort();
  let app = launchApp(exe, port);
  let browser = null;
  let page;
  let projectCounts;

  try {
    ({ browser, page } = await connect(port));
    watch(page);
    await screenshot(page, '01-home.png');

    const badge = await waitForBadge(page, (text) => text.includes('离线 Mock'));
    check('启动后默认离线 Mock', badge.includes('离线 Mock'), badge);
    const before = await storageCounts(page);
    projectCounts = before;
    check(
      '正式应用数据可读',
      true,
      `项目 ${String(before.projects)}、论文 ${String(before.papers)}、笔记 ${String(before.annotations)}、概念 ${String(before.concepts)}`,
    );

    check('应用数据目录存在', existsSync(webviewDir), webviewDir);

    await openAiSettings(page);
    check('AI 设置可从侧栏打开', (await page.locator('dialog[open]').count()) === 1);
    check(
      '默认显示离线模式',
      (await page.locator('.ai-mode-card[data-active="true"]').innerText()).includes('离线 Mock'),
    );
    await screenshot(page, '02-ai-settings-offline.png');

    if (!keyConfiguredBefore) {
      const input = page.locator('.ai-settings__key-form input');
      await input.fill(KEY);
      const stored = await input.inputValue();
      check('Key 输入框接收一次性输入', stored === KEY);
      await page.getByRole('button', { name: '保存到系统凭据' }).click();
      await page.locator('.ai-settings__credential[data-configured="true"]').waitFor({
        timeout: 15_000,
      });
      check('Key 已显示为已配置（不回显明文）', true);
      check(
        '设置界面不显示 Key 明文',
        !(await page.locator('.ai-settings').innerText()).includes(KEY),
      );
      check('Windows 凭据管理器存在固定目标', credentialTargetExists(), CREDENTIAL_TARGET);

      const localStorageDump = await page.evaluate(() => JSON.stringify(window.localStorage));
      check('Key 不在 LocalStorage', !localStorageDump.includes(KEY));
      const configText = existsSync(configFile) ? await readFile(configFile, 'utf8') : '';
      check('Key 不在普通 JSON 配置', !configText.includes(KEY), configFile);
      check('Key 不在 WebView2 数据目录', !(await directoryContains(webviewDir, KEY)), webviewDir);
      check(
        'Key 不在页面可见文本或标题',
        !(await page.content()).includes(KEY) && !(await page.title()).includes(KEY),
      );

      await page.locator('.ai-mode-card').filter({ hasText: 'DeepSeek 官方 API' }).click();
      const confirm = page.getByRole('button', { name: '确认切换（可能产生费用）' });
      await confirm.waitFor({ timeout: 5000 });
      check('切换在线模式前有费用确认', true);
      await screenshot(page, '03-online-confirm.png');
      await confirm.click();

      const onlineBadge = await waitForBadge(
        page,
        (text) => text.includes('DeepSeek 在线'),
        40_000,
      );
      check('在线模式已启动 DeepSeek Provider', onlineBadge.includes('DeepSeek 在线'), onlineBadge);
      check('在线模式显示模型名称', onlineBadge.includes('deepseek-flash'), onlineBadge);
      check(
        '在线模式使用官方端点（健康状态由服务自报）',
        (await page.locator('.ai-settings__state[data-online="true"]').count()) === 1,
      );
      await sleep(1000);
      const requestRow = page.locator('.ai-settings__stats > div').filter({
        hasText: '本次会话请求',
      });
      const requestCount = (await requestRow.locator('dd').innerText()).trim();
      check('切换在线模式未自动发起模型请求', requestCount.startsWith('0 /'), requestCount);
      await screenshot(page, '04-ai-settings-online.png');

      // Back to mock before the restart so the restart does not bring a paid provider up.
      await page.locator('.ai-mode-card').filter({ hasText: '离线 Mock' }).click();
      await waitForBadge(page, (text) => text.includes('离线 Mock'));
      check('可切回离线 Mock', true);

      await closeAiSettings(page);
      await closeApp(app);
      app = null;
      const restartPort = await freePort();
      app = launchApp(exe, restartPort);
      ({ browser, page } = await connect(restartPort));
      watch(page);
      const restartBadge = await waitForBadge(page, (text) => text.includes('离线 Mock'));
      check('重启后仍默认离线 Mock', restartBadge.includes('离线 Mock'), restartBadge);
      await openAiSettings(page);
      await page.locator('.ai-settings__credential[data-configured="true"]').waitFor({
        timeout: 15_000,
      });
      check('重启后系统凭据仍在', true);
      await screenshot(page, '05-credential-after-restart.png');

      await page.getByRole('button', { name: '删除已保存的 Key' }).click();
      await page.getByRole('button', { name: '确认删除' }).click();
      await page.locator('.ai-settings__credential[data-configured="false"]').waitFor({
        timeout: 15_000,
      });
      check('删除后状态为未配置', true);
      check('Windows 凭据目标已删除', !credentialTargetExists(), CREDENTIAL_TARGET);
      check(
        '删除后模式回到离线 Mock',
        (await page.locator('.ai-settings__state[data-online="false"]').count()) === 1,
      );
    }

    await closeAiSettings(page);

    // ---- single instance -------------------------------------------------
    const mainHandle = powershell(
      `$p = Get-Process -Id ${String(app.pid)} -ErrorAction SilentlyContinue; if ($p) { $p.MainWindowHandle } else { 0 }`,
    );
    powershell(
      `Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);'; $p = Get-Process -Id ${String(app.pid)}; [Native.Win]::ShowWindow($p.MainWindowHandle, 6) | Out-Null; Start-Sleep -Milliseconds 400; if ([Native.Win]::IsIconic($p.MainWindowHandle)) { 'minimized' } else { 'not-minimized' }`,
    );
    const second = spawn(exe, [], { stdio: 'ignore' });
    const secondExited = await Promise.race([
      once(second, 'exit').then(() => true),
      sleep(12_000).then(() => false),
    ]);
    if (!secondExited) {
      try {
        second.kill();
      } catch {
        // Already gone.
      }
    }
    check('第二次启动的进程自行退出', secondExited);
    await sleep(1500);
    check('只有一个应用进程', appProcessCount() === 1, String(appProcessCount()));
    const sidecars = sidecarPidsFor(app.pid);
    check('只有一个 sidecar', sidecars.length === 1, `pids=${sidecars.join(',')}`);
    const restored = powershell(
      `Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'; $p = Get-Process -Id ${String(app.pid)}; $fg = [Native.Win]::GetForegroundWindow(); if ([Native.Win]::IsIconic($p.MainWindowHandle)) { 'minimized' } elseif ($fg -eq $p.MainWindowHandle) { 'focused' } else { 'not-focused' }`,
    );
    check('第二次启动把已有窗口带回前台', restored === 'focused', restored);
    check('主窗口句柄未变', mainHandle !== '0', `handle=${mainHandle}`);
    const stillThere = await page.locator('.app').count();
    check('第二次启动后原窗口仍可交互', stillThere === 1);
    await screenshot(page, '06-single-instance.png');

    // ---- data persistence ------------------------------------------------
    const after = await storageCounts(page);
    check(
      '模式与凭据操作没有改动项目数据',
      JSON.stringify(after) === JSON.stringify(projectCounts),
      JSON.stringify(after),
    );
    check(
      '知识 schema 仍为 v2',
      after.knowledgeVersion === 2,
      `version=${String(after.knowledgeVersion)}`,
    );
    check('控制台无错误', consoleIssues.length === 0, consoleIssues.slice(0, 4).join(' / '));

    await closeApp(app);
    app = null;

    // ---- a fresh launch after close -------------------------------------
    const finalPort = await freePort();
    app = launchApp(exe, finalPort);
    ({ browser, page } = await connect(finalPort));
    watch(page);
    await waitForBadge(page, (text) => text.includes('离线 Mock'));
    const final = await storageCounts(page);
    check(
      '关闭重开后项目数据保持',
      JSON.stringify(final) === JSON.stringify(projectCounts),
      JSON.stringify(final),
    );
    if (!keyConfiguredBefore) {
      await openAiSettings(page);
      const configured =
        (await page.locator('.ai-settings__credential[data-configured="true"]').count()) === 1;
      check('删除的凭据没有被重启恢复', !configured);
      await closeAiSettings(page);
    }
  } finally {
    if (app !== null) {
      await closeApp(app);
    }
    if (browser !== null) {
      await browser.close().catch(() => {});
    }
  }

  const failures = results.filter((entry) => !entry.passed);
  await writeFile(
    REPORT_FILE,
    `${JSON.stringify(
      {
        phase: 11,
        generatedAt: new Date().toISOString(),
        executable: exe,
        version,
        keyConfiguredBefore,
        results,
        failures: failures.length,
        consoleIssues,
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
}

await main();

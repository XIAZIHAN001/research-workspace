/**
 * Phase 10 desktop acceptance against the packaged Windows application.
 *
 * It drives the real installed app, not `tauri dev` and not a browser preview: launches the
 * executable with WebView2 remote debugging, connects over CDP, and checks the things a desktop
 * build can get wrong that a browser run cannot — the bundled sidecar, its credential, the
 * webview's own storage, the installer's resources, and the process lifecycle.
 *
 * Set RW_DESKTOP_EXE to test a specific executable; otherwise the current-user install path is
 * used, then the release build output.
 */

/* global document, getComputedStyle, window */
import { execFileSync, spawn } from 'node:child_process';
import { setAppTheme } from './appearance.mjs';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildLongPdf } from './sample-pdf.mjs';
import { selectSpans } from './text-selection.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = join(ROOT, 'docs', 'screenshots-phase10', `${STAMP}-desktop`);
const REPORT_FILE = join(SHOT_DIR, 'report.json');
const WORK_DIR = join(ROOT, '.cache', 'verify');
const PROJECT_NAME = `桌面验收 ${STAMP}`;
const CONCEPT_NAME = `桌面验收概念 ${STAMP.slice(11, 19)}`;
const NOTE_TEXT = '桌面验收笔记：这一页的左侧栏是正文的起点。';
const ARTIFACT_DIR = join(ROOT, 'src-tauri', 'target', 'phase10-artifacts');

const results = [];
const consoleIssues = [];
const trapHits = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}\n`,
  );
  return passed;
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
    // The NSIS installer is placed on the drive it is run from, so a D-drive installer
    // installs here. This is also the path the Phase 10 report records.
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
      // WebView2's own remote-debugging switch. It is test-only; the app does not read it.
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

function childOf(appPid) {
  return powershell(
    `$p = Get-CimInstance Win32_Process -Filter "Name='rw-node.exe'" | Where-Object { $_.ParentProcessId -eq ${String(appPid)} } | Select-Object -First 1; if ($p) { $p.ProcessId }`,
  );
}

function listenAddress(pid) {
  return powershell(
    `$c = Get-NetTCPConnection -OwningProcess ${String(pid)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { "$($c.LocalAddress)|$($c.LocalPort)" }`,
  );
}

function processExists(pid) {
  return (
    powershell(
      `if (Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
    ) === 'yes'
  );
}

async function closeApp(child) {
  try {
    powershell(
      `$p = Get-Process -Id ${String(child.pid)} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() | Out-Null }`,
    );
  } catch {
    // The process may already be gone.
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
  return exited;
}

async function waitForAppExit(appPid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(appPid)) return true;
    await sleep(300);
  }
  return false;
}

async function screenshot(page, name) {
  await page.screenshot({ path: join(SHOT_DIR, name) });
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const exe = findExe();
  if (exe === null) {
    throw new Error('找不到桌面应用可执行文件：请先构建，或设置 RW_DESKTOP_EXE。');
  }
  check('找到桌面应用可执行文件', true, exe);

  const pdfPath = join(WORK_DIR, 'desktop-long.pdf');
  await writeFile(pdfPath, buildLongPdf(3));

  // A service already listening on 8787 must never receive a request from the desktop app.
  const trap = createServer((request, response) => {
    trapHits.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true,"provider":"trap"}');
  });
  let trapActive;
  try {
    await new Promise((resolveListen, rejectListen) => {
      trap.once('error', rejectListen);
      trap.listen(8787, '127.0.0.1', resolveListen);
    });
    trapActive = true;
  } catch {
    trapActive = false;
  }
  check(
    '8787 端口陷阱（若空闲）',
    true,
    trapActive ? '已在 8787 启动陷阱服务' : '8787 已被占用，未触碰',
  );

  const port = await freePort();
  let app = launchApp(exe, port);
  let browser = null;
  let page;
  let sidecarPid;
  const storageDir = join(
    process.env.LOCALAPPDATA ?? '',
    'com.researchworkspace.desktop',
    'webview',
  );

  try {
    ({ browser, page } = await connect(port));
    watch(page);
    await screenshot(page, '01-home.png');
    check('桌面窗口加载 React 界面', (await page.locator('.app').count()) === 1);
    check('WebView2 数据目录已创建', existsSync(storageDir), storageDir);
    const themeBox = await page.locator('.sidebar-foot .segmented').boundingBox();
    const footBox = await page.locator('.sidebar-foot').boundingBox();
    const themeInside =
      themeBox !== null &&
      footBox !== null &&
      themeBox.x >= footBox.x - 0.5 &&
      themeBox.x + themeBox.width <= footBox.x + footBox.width + 0.5 &&
      themeBox.y + themeBox.height <= footBox.y + footBox.height + 0.5;
    check(
      '侧栏主题切换在非全屏窗口中完整可见',
      themeInside,
      themeBox === null || footBox === null
        ? 'missing'
        : `switch ${themeBox.x.toFixed(0)}+${themeBox.width.toFixed(0)} in footer ${footBox.x.toFixed(0)}+${footBox.width.toFixed(0)}`,
    );
    await screenshot(page, '00-sidebar-footer.png');
    await setAppTheme(page, '深色');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await screenshot(page, '01b-dark.png');
    check('桌面深色主题可切换', true);
    await setAppTheme(page, '浅色');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    check('桌面浅色主题可切换', true);

    sidecarPid = childOf(app.pid);
    check(
      '应用启动了自己的 rw-node sidecar',
      /^\d+$/.test(sidecarPid),
      `app=${String(app.pid)} sidecar=${sidecarPid}`,
    );
    const listened = sidecarPid === '' ? '' : listenAddress(sidecarPid);
    const [address, sidecarPort] = listened.split('|');
    check('sidecar 只监听回环地址', address === '127.0.0.1', listened);
    check(
      'sidecar 使用临时端口而非 8787',
      Number(sidecarPort) > 0 && Number(sidecarPort) !== 8787,
      listened,
    );

    await page.locator('.ai-service-badge[data-state="ready"]').waitFor({ timeout: 30_000 });
    const badge = await page.locator('.ai-service-badge').innerText();
    check('AI 服务状态为就绪且离线 Mock', badge.includes('离线 Mock'), badge);

    const service = await page.evaluate(async () =>
      window.__TAURI_INTERNALS__.invoke('ai_service_info'),
    );
    check(
      'IPC 报告的 sidecar 地址与进程端口一致',
      service.baseUrl?.endsWith(`:${sidecarPort}`) === true,
      service.baseUrl ?? '',
    );
    check(
      'IPC 凭据为每次启动生成的长令牌',
      typeof service.token === 'string' && service.token.length >= 32,
    );
    const health = await page.evaluate(
      async ({ baseUrl, token }) => {
        const response = await fetch(`${baseUrl}/api/ai/health`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: response.status, body: await response.json() };
      },
      { baseUrl: service.baseUrl, token: service.token },
    );
    check('带凭据的健康检查成功', health.status === 200 && health.body.ok === true);
    check(
      '健康检查返回同一实例且离线',
      health.body.instanceId === service.instanceId && health.body.online === false,
    );
    const unauthorized = await page.evaluate(
      async (baseUrl) => (await fetch(`${baseUrl}/api/ai/health`)).status,
      service.baseUrl,
    );
    check('缺少凭据的请求被拒绝', unauthorized === 401, String(unauthorized));

    // ---- Create a project and import a real PDF -------------------------
    await page.getByLabel('新建项目').click();
    await page.getByLabel('核心论文标题').fill(PROJECT_NAME);
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('heading', { level: 1, name: PROJECT_NAME }).waitFor();
    await page.getByRole('button', { name: '导入新论文' }).click();
    const importDialog = page.getByRole('dialog', { name: '导入论文' });
    await importDialog.locator('input[type="file"]').setInputFiles(pdfPath);
    await importDialog.getByRole('button', { name: '导入' }).click();
    // The same sample bytes may already be in the library from an earlier run. The import
    // dialog correctly asks before creating a second paper from identical content.
    const stillCreate = page.getByRole('button', { name: '仍然新建一篇论文' });
    try {
      await stillCreate.waitFor({ timeout: 2500 });
      await stillCreate.click();
    } catch {
      // No duplicate prompt; the import went straight through.
    }
    await page.locator('.reader').waitFor({ timeout: 30_000 });
    await page
      .locator('.pdf-page[data-page="1"] .textLayer span')
      .first()
      .waitFor({ timeout: 30_000 });
    const pageText = await page.locator('.pdf-page[data-page="1"] .textLayer').innerText();
    check(
      'PDF 在桌面 WebView 中渲染出文字层',
      pageText.includes('LONGPAGE-1 opens this page.'),
      pageText.slice(0, 80),
    );
    const canvasBox = await page.locator('.pdf-page[data-page="1"] canvas').first().boundingBox();
    check(
      'PDF 画布具有实际尺寸',
      canvasBox !== null && canvasBox.width > 300,
      canvasBox === null ? 'no canvas' : `${canvasBox.width.toFixed(0)}px`,
    );
    await screenshot(page, '02-reader.png');

    await page.getByLabel('下一页').click();
    await page
      .waitForFunction(
        () => document.querySelector('.reader-page-jump input')?.value === '2',
        null,
        { timeout: 10_000 },
      )
      .catch(() => {});
    const currentPage = await page.locator('.reader-page-jump input').inputValue();
    check('翻页到第 2 页', currentPage === '2', currentPage);
    await page.getByLabel('上一页').click();
    await page
      .waitForFunction(
        () => document.querySelector('.reader-page-jump input')?.value === '1',
        null,
        { timeout: 10_000 },
      )
      .catch(() => {});

    // ---- Mock AI answer ------------------------------------------------
    await page.getByLabel('打开 AI 助手').click();
    const aiPanel = page.getByLabel('AI 精读助手');
    await aiPanel.locator('input[placeholder^="就这一页"]').fill('这一页的核心内容是什么？');
    const askBox = await aiPanel.getByRole('button', { name: '提问' }).boundingBox();
    const badgeBox = await page.locator('.ai-service-badge').boundingBox();
    const badgesOverlap =
      askBox !== null &&
      badgeBox !== null &&
      askBox.x < badgeBox.x + badgeBox.width &&
      badgeBox.x < askBox.x + askBox.width &&
      askBox.y < badgeBox.y + badgeBox.height &&
      badgeBox.y < askBox.y + askBox.height;
    check('AI 状态角标不遮挡提问按钮', !badgesOverlap, askBox === null ? 'missing button' : '');
    await aiPanel.getByRole('button', { name: '提问' }).click();
    await aiPanel.locator('.ai-answer-body').first().waitFor({ timeout: 30_000 });
    const answer = await aiPanel.locator('.ai-answer-body').first().innerText();
    const provider = await aiPanel.locator('.ai-provider').innerText();
    check('AI Mock 返回回答', answer.includes('本地模拟回答'), answer.slice(0, 60));
    check('AI 面板标明离线来源', /mock|离线|不会发起任何在线调用/i.test(provider), provider);
    await screenshot(page, '03-ai.png');
    await page.getByLabel('关闭 AI 面板').click();

    // ---- KaTeX in the desktop webview --------------------------------
    await selectSpans(page, 1, { span: 1, offset: 0 }, { span: 3, offset: 10 });
    await page.mouse.move(5, 5);
    await page.locator('.pdf-page[data-page="1"]').first().dispatchEvent('mouseup');
    const formulaToolbar = page.getByRole('toolbar', { name: '批注' });
    await formulaToolbar.waitFor({ timeout: 5000 });
    await formulaToolbar.getByRole('button', { name: '向这段文字提问' }).click();
    await formulaToolbar.getByRole('button', { name: '解释数学公式' }).click();
    const formulaPanel = page.getByLabel('AI 精读助手');
    await formulaPanel.locator('.katex').first().waitFor({ timeout: 30_000 });
    const katexCount = await formulaPanel.locator('.katex').count();
    const formulaFont = await formulaPanel
      .locator('.katex')
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily);
    check('KaTeX 公式在桌面 WebView 中渲染', katexCount > 0, `${String(katexCount)} formula(s)`);
    check('KaTeX 使用随包字体', /KaTeX|math/i.test(formulaFont), formulaFont);
    await screenshot(page, '03b-formula.png');
    await page.getByLabel('关闭 AI 面板').click();

    // ---- Highlight and note -------------------------------------------
    const selection = await selectSpans(page, 1, { span: 1, offset: 0 }, { span: 5, offset: 26 });
    check(
      '在桌面 WebView 中选中文字',
      selection !== null && selection.text.length > 10,
      selection?.text.slice(0, 40) ?? 'none',
    );
    await page.mouse.move(5, 5);
    await page.locator('.pdf-page[data-page="1"]').first().dispatchEvent('mouseup');
    const toolbar = page.getByRole('toolbar', { name: '批注' });
    await toolbar.waitFor({ timeout: 5000 });
    await toolbar.getByRole('button', { name: '笔记' }).click();
    await toolbar.getByPlaceholder('写下疑问或理解…').fill(NOTE_TEXT);
    await toolbar.getByRole('button', { name: '保存' }).click();
    await page.locator('.pdf-highlight').first().waitFor({ timeout: 10_000 });
    check('高亮已绘制在 PDF 上', (await page.locator('.pdf-highlight').count()) > 0);
    await page.getByLabel('打开我的笔记').click();
    const notesPanel = page.getByLabel('论文笔记');
    await notesPanel.getByText(NOTE_TEXT).waitFor({ timeout: 10_000 });
    check('笔记面板读到刚保存的笔记', true);
    await screenshot(page, '04-note.png');
    await page.getByLabel('收起笔记').click();
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('heading', { level: 1, name: PROJECT_NAME }).waitFor();

    // ---- Manual concept -------------------------------------------------
    await page.locator('.project-modes').getByRole('button', { name: '知识' }).click();
    await page.getByRole('button', { name: '新建概念' }).click();
    await page.getByPlaceholder('概念名称，例如 KZG commitment').fill(CONCEPT_NAME);
    await page
      .getByPlaceholder('一两句话说明它是什么（可稍后补）')
      .fill('这是桌面验收创建的本地概念，用于验证知识与持久化。');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByText(CONCEPT_NAME, { exact: true }).first().waitFor({ timeout: 10_000 });
    check('知识概念可在桌面应用中创建', true, CONCEPT_NAME);
    await screenshot(page, '05-knowledge.png');

    // ---- Export a backup ------------------------------------------------
    await page.getByRole('button', { name: '备份与恢复' }).click();
    const backupDialog = page.getByRole('dialog', { name: '备份与恢复' });
    await backupDialog.waitFor();
    let exportPath = null;
    let download = null;
    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);
    await backupDialog.getByRole('button', { name: '导出备份文件' }).click();
    download = await downloadPromise;
    if (download !== null) {
      exportPath = join(ARTIFACT_DIR, `desktop-export-${STAMP}.rwbackup`);
      await download.saveAs(exportPath);
    }
    const exportNote = await backupDialog.innerText();
    check(
      '桌面备份导出成功',
      /备份已下载/.test(exportNote) || exportPath !== null,
      exportPath ?? 'download event not exposed; UI reported success',
    );
    await screenshot(page, '06-backup.png');

    // ---- Restart and verify persistence --------------------------------
    const firstSidecar = sidecarPid;
    await closeApp(app);
    check('应用正常关闭', await waitForAppExit(app.pid), `pid ${String(app.pid)}`);
    const sidecarGone = firstSidecar === '' ? false : !processExists(firstSidecar);
    check('正常关闭后 sidecar 进程结束', sidecarGone, firstSidecar);

    const port2 = await freePort();
    app = launchApp(exe, port2);
    ({ browser, page } = await connect(port2));
    watch(page);
    await page.getByRole('button', { name: PROJECT_NAME }).first().waitFor({ timeout: 20_000 });
    const stored = await page.evaluate(() => ({
      projects: JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null'),
      knowledge: JSON.parse(window.localStorage.getItem('rw.knowledge') ?? 'null'),
    }));
    const project = stored.projects?.projects?.find((entry) => entry.name === PROJECT_NAME);
    const annotation = stored.projects?.annotations?.find((entry) => entry.note === NOTE_TEXT);
    const concept = stored.knowledge?.concepts?.find((entry) => entry.name === CONCEPT_NAME);
    check('重启后项目仍在', project !== undefined);
    check('重启后笔记仍在', annotation !== undefined);
    check('重启后知识概念仍在', concept !== undefined, concept?.id ?? '');
    check(
      '知识 schema 仍为 v2',
      stored.knowledge?.version === 2,
      String(stored.knowledge?.version),
    );
    await page.getByRole('button', { name: PROJECT_NAME }).first().click();
    await page.getByRole('button', { name: '阅读' }).first().click();
    await page
      .locator('.pdf-page[data-page="1"] .textLayer span')
      .first()
      .waitFor({ timeout: 30_000 });
    const textAfterRestart = await page.locator('.pdf-page[data-page="1"] .textLayer').innerText();
    check(
      '重启后 PDF 仍可从 IndexedDB 打开',
      textAfterRestart.includes('LONGPAGE-1 opens this page.'),
    );
    await screenshot(page, '07-restart.png');
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('heading', { level: 1, name: PROJECT_NAME }).waitFor();

    // ---- Import a backup exported in this run --------------------------
    if (exportPath !== null) {
      await page.getByRole('button', { name: '备份与恢复' }).click();
      const dialog = page.getByRole('dialog', { name: '备份与恢复' });
      await dialog.getByLabel('选择备份文件').setInputFiles(exportPath);
      await dialog
        .getByText(/本次会新增|读取备份时出错|这个备份不能恢复/)
        .first()
        .waitFor({ timeout: 30_000 });
      const restoreButton = dialog.getByRole('button', { name: /开始恢复|校验并完成恢复/ });
      if (await restoreButton.count()) {
        await restoreButton.click();
        await dialog.getByText(/恢复完成，并已从本地存储回读校验/).waitFor({ timeout: 60_000 });
        check('桌面导出的备份可在桌面应用中恢复并回读校验', true);
        await dialog
          .getByRole('button', { name: '重新载入以查看恢复后的内容' })
          .click()
          .catch(() => {});
        await page.locator('.app').waitFor({ timeout: 30_000 });
      } else {
        check('桌面导出的备份可在桌面应用中恢复并回读校验', false, 'restore button not available');
      }
    } else {
      check('桌面导出的备份可在桌面应用中恢复并回读校验', false, 'no downloaded backup file');
    }

    // ---- Import a Phase 9 backup: old container, v2 knowledge, one rejection ----------
    const phase9Backup = join(ROOT, '.cache', 'verify', 'phase9-research-workflow.rwbackup');
    if (existsSync(phase9Backup)) {
      await page.getByRole('button', { name: '备份与恢复' }).click();
      const oldDialog = page.getByRole('dialog', { name: '备份与恢复' });
      await oldDialog.getByLabel('选择备份文件').setInputFiles(phase9Backup);
      await oldDialog
        .getByText(/本次会新增|开始恢复|校验并完成恢复|这个备份不能恢复/)
        .first()
        .waitFor({ timeout: 30_000 });
      const oldRestore = oldDialog.getByRole('button', { name: /开始恢复|校验并完成恢复/ });
      if (await oldRestore.count()) {
        await oldRestore.click();
        await oldDialog.getByText(/恢复完成，并已从本地存储回读校验/).waitFor({ timeout: 60_000 });
        await oldDialog
          .getByRole('button', { name: '重新载入以查看恢复后的内容' })
          .click()
          .catch(() => {});
        await page.locator('.app').waitFor({ timeout: 30_000 });
        const restored = await page.evaluate(() => ({
          projects: JSON.parse(window.localStorage.getItem('rw.projects') ?? 'null'),
          knowledge: JSON.parse(window.localStorage.getItem('rw.knowledge') ?? 'null'),
        }));
        check(
          'Phase 9 旧 .rwbackup 可在桌面导入',
          restored.projects?.projects?.some((entry) => entry.name === 'Phase 9 真实精读') === true,
        );
        check(
          '导入后拒绝记录仍在',
          (restored.knowledge?.rejections?.length ?? 0) >= 1,
          String(restored.knowledge?.rejections?.length ?? 0),
        );
        check(
          '导入后已确认关系仍在',
          (restored.knowledge?.relations?.length ?? 0) >= 3,
          String(restored.knowledge?.relations?.length ?? 0),
        );
        await page.getByRole('button', { name: 'Phase 9 真实精读' }).first().click();
        await page.locator('.project-modes').getByRole('button', { name: '知识' }).click();
        await page.getByText('模拟概念 B', { exact: true }).first().click();
        await page.getByText('已拒绝的关系建议').waitFor({ timeout: 10_000 });
        check('桌面知识视图显示已拒绝的关系建议', true);
        await screenshot(page, '09-rejection.png');
      } else {
        check('Phase 9 旧 .rwbackup 可在桌面导入', false, 'restore button not available');
      }
    } else {
      check('Phase 9 旧 .rwbackup 可在桌面导入', false, 'backup fixture missing');
    }

    // ---- Force kill: the watchdog must remove the orphan ----------------
    await page
      .getByRole('button', { name: '备份与恢复' })
      .click()
      .catch(() => {});
    await page.keyboard.press('Escape');
    const sidecarBeforeKill = childOf(app.pid);
    await page.locator('.app').waitFor();
    const appPid = app.pid;
    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Stop-Process -Id ${String(appPid)} -Force`],
        {
          windowsHide: true,
        },
      );
    } catch {
      // The process may already be gone.
    }
    const orphanGone = await waitForAppExit(Number(sidecarBeforeKill), 10_000);
    check(
      '强制结束应用后 sidecar 自行退出（无孤儿）',
      sidecarBeforeKill !== '' && orphanGone,
      sidecarBeforeKill,
    );

    check('桌面应用未向 8787 旧端口发出任何请求', trapHits.length === 0, trapHits.join(','));
    // The no-credential probe is expected to be refused; Chromium reports the 401 as a console
    // error, so only that exact message is excluded from the "no console errors" check.
    const unexpectedConsole = consoleIssues.filter(
      (text) => !/status of 401 \(Unauthorized\)/.test(text),
    );
    check(
      '桌面运行期间无控制台错误',
      unexpectedConsole.length === 0,
      unexpectedConsole.slice(0, 3).join(' | '),
    );
  } finally {
    try {
      if (browser !== null) await browser.close();
    } catch {
      // The app may already be gone.
    }
    try {
      if (processExists(app.pid)) {
        app.kill();
      }
    } catch {
      // Already gone.
    }
    if (trapActive) await new Promise((resolveClose) => trap.close(resolveClose));
  }

  const passed = results.filter((entry) => entry.passed).length;
  const summary = {
    stamp: STAMP,
    exe,
    passed,
    total: results.length,
    results,
    consoleIssues,
    trapHits,
  };
  await writeFile(REPORT_FILE, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`\n${passed}/${results.length} checks passed. Evidence: ${SHOT_DIR}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

await main();

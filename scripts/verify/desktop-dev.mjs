/**
 * Phase 10 development-mode acceptance (Tauri dev + Vite on 127.0.0.1:1440).
 *
 * The release acceptance covers the installed bundle. This script covers the other entry point:
 * the development app must load the Vite server (not the production assets), must still manage
 * its own sidecar, and must use a separate WebView data directory from the installed app.
 *
 * It also opens the CJK sample PDF, because the desktop WebView is a different PDF/rendering
 * environment from the browser used by the earlier phases.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildRichTextPdf } from './sample-pdf.mjs';
import { selectSpans } from './text-selection.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = join(ROOT, 'docs', 'screenshots-phase10', `${STAMP}-dev`);
const REPORT_FILE = join(SHOT_DIR, 'report.json');
const WORK_DIR = join(ROOT, '.cache', 'verify');
const CDP_PORT = Number(process.env.RW_DEV_CDP_PORT ?? '9555');
const PROJECT_NAME = `桌面开发验收 ${STAMP}`;
const NOTE_TEXT = '开发模式笔记：特殊字符与中文都在这一页。';
const DEV_DATA = join(
  process.env.LOCALAPPDATA ?? '',
  'com.researchworkspace.desktop.dev',
  'webview',
);
const PROD_DATA = join(process.env.LOCALAPPDATA ?? '', 'com.researchworkspace.desktop', 'webview');

const results = [];
const consoleIssues = [];

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

async function connect(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
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

function debugAppPid() {
  return powershell(
    `$p = Get-CimInstance Win32_Process -Filter "Name='research-workspace.exe'" | Where-Object { $_.ExecutablePath -like '*target\\debug*' } | Select-Object -First 1; if ($p) { $p.ProcessId }`,
  );
}

function childSidecar(appPid) {
  return powershell(
    `$p = Get-CimInstance Win32_Process -Filter "Name='rw-node.exe'" | Where-Object { $_.ParentProcessId -eq ${String(appPid)} } | Select-Object -First 1; if ($p) { $p.ProcessId }`,
  );
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  const pdfPath = join(WORK_DIR, 'desktop-rich-text.pdf');
  await writeFile(pdfPath, buildRichTextPdf());

  const { browser, page } = await connect();
  watch(page);
  await page.screenshot({ path: join(SHOT_DIR, '01-dev-home.png') });

  check(
    '开发模式加载的是 Vite 开发地址',
    page.url().startsWith('http://127.0.0.1:1440'),
    page.url(),
  );
  check('开发模式 React 界面已渲染', (await page.locator('.app').count()) === 1);
  check('开发模式使用独立的 WebView 数据目录', existsSync(DEV_DATA), DEV_DATA);
  check('开发数据目录与安装版分离', resolve(DEV_DATA) !== resolve(PROD_DATA), `dev=${DEV_DATA}`);

  const appPid = debugAppPid();
  const sidecarPid = appPid === '' ? '' : childSidecar(Number(appPid));
  check(
    '开发模式启动了自带的 sidecar',
    /^\d+$/.test(sidecarPid),
    `app=${appPid} sidecar=${sidecarPid}`,
  );

  await page.locator('.ai-service-badge[data-state="ready"]').waitFor({ timeout: 30_000 });
  const badge = await page.locator('.ai-service-badge').innerText();
  check('开发模式 AI 服务就绪且离线 Mock', badge.includes('离线 Mock'), badge);

  const themeBox = await page.locator('.sidebar-foot .segmented').boundingBox();
  const footBox = await page.locator('.sidebar-foot').boundingBox();
  check(
    '开发模式主题切换完整可见',
    themeBox !== null &&
      footBox !== null &&
      themeBox.x >= footBox.x - 0.5 &&
      themeBox.x + themeBox.width <= footBox.x + footBox.width + 0.5,
    themeBox === null ? 'missing' : `${themeBox.x.toFixed(0)}+${themeBox.width.toFixed(0)}`,
  );

  // ---- Import the CJK / special-character sample ----------------------
  await page.getByLabel('新建项目').click();
  await page.getByLabel('核心论文标题').fill(PROJECT_NAME);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('heading', { level: 1, name: PROJECT_NAME }).waitFor();
  await page.getByRole('button', { name: '导入新论文' }).click();
  const importDialog = page.getByRole('dialog', { name: '导入论文' });
  await importDialog.locator('input[type="file"]').setInputFiles(pdfPath);
  await importDialog.getByRole('button', { name: '导入' }).click();
  // The dev data directory is isolated but persists between runs, so the same sample file may
  // already be in the library. The dialog asks before creating a second paper from it.
  const stillCreate = page.getByRole('button', { name: '仍然新建一篇论文' });
  try {
    await stillCreate.waitFor({ timeout: 2500 });
    await stillCreate.click();
  } catch {
    // No duplicate prompt.
  }
  await page.locator('.reader').waitFor({ timeout: 30_000 });
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 30_000 });

  const textLayer = await page.locator('.pdf-page[data-page="1"] .textLayer').innerText();
  check(
    '开发模式 PDF 文字层渲染',
    textLayer.includes('Characters, Scripts and Figures'),
    textLayer.slice(0, 80),
  );
  check('PDF 中的中文文字层提取正确', textLayer.includes('中文测试'), textLayer.slice(0, 160));
  check(
    'PDF 特殊字符文字层提取正确',
    textLayer.includes('°C') && textLayer.includes('±') && textLayer.includes('×'),
    textLayer.slice(0, 200),
  );
  const canvasBox = await page.locator('.pdf-page[data-page="1"] canvas').first().boundingBox();
  check('开发模式 PDF 画布具有实际尺寸', canvasBox !== null && canvasBox.width > 300);
  await page.screenshot({ path: join(SHOT_DIR, '02-dev-cjk-pdf.png') });

  // ---- Mock AI -------------------------------------------------------
  await page.getByLabel('打开 AI 助手').click();
  const aiPanel = page.getByLabel('AI 精读助手');
  await aiPanel.locator('input[placeholder^="就这一页"]').fill('这一页有哪些特殊字符？');
  await aiPanel.getByRole('button', { name: '提问' }).click();
  await aiPanel.locator('.ai-answer-body').first().waitFor({ timeout: 30_000 });
  const answer = await aiPanel.locator('.ai-answer-body').first().innerText();
  check('开发模式 AI Mock 返回回答', answer.includes('本地模拟回答'), answer.slice(0, 60));
  await page.screenshot({ path: join(SHOT_DIR, '03-dev-ai.png') });
  await page.getByLabel('关闭 AI 面板').click();

  // ---- Selection and note -------------------------------------------
  const selection = await selectSpans(page, 1, { span: 1, offset: 0 }, { span: 3, offset: 10 });
  check(
    '开发模式可选中 PDF 文字',
    selection !== null && selection.text.length > 5,
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
  check('开发模式高亮已绘制', (await page.locator('.pdf-highlight').count()) > 0);
  await page.getByLabel('打开我的笔记').click();
  await page.getByLabel('论文笔记').getByText(NOTE_TEXT).waitFor({ timeout: 10_000 });
  check('开发模式笔记已保存并显示', true);

  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter(
        (name) =>
          // Vite, the bundled sidecar and Tauri IPC are all local; a remote third-party
          // script would be anything else.
          !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(name) &&
          !name.startsWith('http://ipc.localhost') &&
          !name.startsWith('data:') &&
          !name.startsWith('blob:'),
      ),
  );
  check('开发页面未加载远程第三方脚本', resources.length === 0, resources.slice(0, 3).join(','));

  check(
    '开发模式无控制台错误',
    consoleIssues.filter((text) => !/status of 401 \(Unauthorized\)/.test(text)).length === 0,
    consoleIssues.slice(0, 3).join(' | '),
  );
  await page.screenshot({ path: join(SHOT_DIR, '04-dev-note.png') });

  const passed = results.filter((entry) => entry.passed).length;
  await writeFile(
    REPORT_FILE,
    `${JSON.stringify({ stamp: STAMP, passed, total: results.length, results, consoleIssues }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`\n${passed}/${results.length} dev checks passed. Evidence: ${SHOT_DIR}\n`);
  if (passed !== results.length) process.exitCode = 1;
  await browser.close();
}

await main();

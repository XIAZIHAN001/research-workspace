/**
 * Phase 11 development acceptance: the desktop UI talking to a local DeepSeek simulator.
 *
 * The production application can only reach api.deepseek.com, and this phase is not authorised
 * to make real paid requests. The debug build therefore accepts `RW_AI_TEST_UPSTREAM` (a
 * loopback address only) and hands it to the sidecar; a release build has no such branch.
 *
 * This script launches `tauri dev`, stands a chat-completions simulator on loopback, switches
 * the app to online mode with a throwaway key, selects text in a PDF, asks the assistant, and
 * checks that the answer came back through the real desktop transport with a verified citation.
 * Nothing reaches the official endpoint, and no real key is involved.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildRichTextPdf } from './sample-pdf.mjs';
import { selectSpans } from './text-selection.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_DIR = join(ROOT, 'docs', 'screenshots-phase11', `${STAMP}-dev-online`);
const REPORT_FILE = join(SHOT_DIR, 'report.json');
const WORK_DIR = join(ROOT, '.cache', 'verify');
const CDP_PORT = Number(process.env.RW_DEV_ONLINE_CDP_PORT ?? '9566');
const PROJECT_NAME = `在线模拟验收 ${STAMP}`;
const KEY = `sk-phase11-simulator-${STAMP.replace(/-/g, '')}`;
const SENTINEL = '<<<CITATIONS>>>';

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

function selectionQuote(body) {
  for (const message of body?.messages ?? []) {
    const content = typeof message.content === 'string' ? message.content : '';
    const lines = content.split('\n');
    const index = lines.findIndex((line) => line.startsWith('[selection]'));
    if (index === -1) continue;
    const text = (lines[index + 1] ?? '').trim();
    if (text.length < 4) continue;
    return text.slice(0, Math.min(60, text.length));
  }
  return '';
}

async function startSimulator() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Recorded as null; the assertions will show the malformed request.
      }
      requests.push({ url: request.url, headers: request.headers, body });
      const system = body?.messages?.[0]?.content ?? '';
      let content;
      if (system.includes('知识结构')) {
        content = JSON.stringify({ groundedInText: true, concepts: [], relations: [] });
      } else {
        const quote = selectionQuote(body);
        content =
          quote === ''
            ? `在线模拟回答：这次请求没有可引用的选区。\n\n${SENTINEL}\n{"groundedInText":false,"citations":[]}`
            : `在线模拟回答：这段原文说明了模型学到的表示与输入顺序无关。[1]\n\n${SENTINEL}\n${JSON.stringify(
                {
                  groundedInText: true,
                  citations: [{ n: 1, passageId: 'selection', quote }],
                },
              )}`;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-phase11-sim',
          object: 'chat.completion',
          model: body?.model ?? 'deepseek-flash',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 500, completion_tokens: 40, prompt_cache_hit_tokens: 0 },
        }),
      );
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function connect(timeoutMs = 180_000) {
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
    await sleep(500);
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

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } catch {
    // Already gone.
  }
}

function existingDevApp() {
  return powershell(
    `$p = Get-CimInstance Win32_Process -Filter "Name='research-workspace.exe'" | Where-Object { $_.ExecutablePath -like '*target\\debug*' } | Select-Object -First 1; if ($p) { $p.ProcessId }`,
  );
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  const pdfPath = join(WORK_DIR, 'desktop-rich-text.pdf');
  await writeFile(pdfPath, buildRichTextPdf());

  if (existingDevApp() !== '') {
    throw new Error('已经有一个开发版应用在运行。请先关闭它，再运行在线模拟验收。');
  }

  const simulator = await startSimulator();
  const logStream = createWriteStream(join(SHOT_DIR, 'desktop-dev.log'), { flags: 'a' });
  // `tauri dev` compiles Rust. The MSVC environment is not in the user's default PATH on this
  // machine, so the launch goes through the same wrapper the release build uses. The test-only
  // upstream variable is inherited through it.
  const dev = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', 'scripts\\desktop\\msvc-env.cmd npm run desktop:dev'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        RW_AI_TEST_UPSTREAM: simulator.url,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${String(CDP_PORT)}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  dev.stdout.pipe(logStream);
  dev.stderr.pipe(logStream);

  let browser = null;
  try {
    const connected = await connect();
    browser = connected.browser;
    const page = connected.page;
    watch(page);
    await page.locator('.ai-service-badge[data-state="ready"]').waitFor({ timeout: 40_000 });
    check(
      '开发版启动并处于离线 Mock',
      (await page.locator('.ai-service-badge').innerText()).includes('离线 Mock'),
    );
    await page.screenshot({ path: join(SHOT_DIR, '01-dev-home.png') });

    // ---- Configure the throwaway key and switch online -------------------
    await page.getByRole('button', { name: 'AI 设置' }).first().click();
    await page.locator('dialog[open] .ai-settings').waitFor({ timeout: 10_000 });
    await page.locator('.ai-settings__key-form input').fill(KEY);
    await page.getByRole('button', { name: '保存到系统凭据' }).click();
    await page.locator('.ai-settings__credential[data-configured="true"]').waitFor({
      timeout: 15_000,
    });
    await page.locator('.ai-mode-card').filter({ hasText: 'DeepSeek 官方 API' }).click();
    await page.getByRole('button', { name: '确认切换（可能产生费用）' }).click();
    await page
      .locator('.ai-service-badge[data-state="ready"]')
      .filter({ hasText: 'DeepSeek 在线' })
      .waitFor({ timeout: 40_000 });
    check('在线模式通过本地模拟器就绪', true);
    await page.screenshot({ path: join(SHOT_DIR, '02-dev-online-mode.png') });
    await page.locator('dialog[open] button[aria-label="关闭"]').click();

    // ---- Import a PDF and ask about a selection --------------------------
    await page.getByLabel('新建项目').click();
    await page.getByLabel('核心论文标题').fill(PROJECT_NAME);
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('heading', { level: 1, name: PROJECT_NAME }).waitFor();
    await page.getByRole('button', { name: '导入新论文' }).click();
    const importDialog = page.getByRole('dialog', { name: '导入论文' });
    await importDialog.locator('input[type="file"][data-autofocus]').setInputFiles(pdfPath);
    await importDialog.getByRole('button', { name: '导入' }).click();
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

    const selection = await selectSpans(page, 1, { span: 1, offset: 0 }, { span: 3, offset: 10 });
    check('可选中 PDF 文字', selection !== null && selection.text.length > 5);
    await page.mouse.move(5, 5);
    await page.locator('.pdf-page[data-page="1"]').first().dispatchEvent('mouseup');
    const toolbar = page.getByRole('toolbar', { name: '批注' });
    await toolbar.waitFor({ timeout: 5000 });
    await toolbar.getByRole('button', { name: '向这段文字提问' }).click();
    await toolbar.getByRole('button', { name: '解释这段话' }).click();

    const aiPanel = page.getByLabel('AI 精读助手');
    await aiPanel.locator('.ai-answer-body').first().waitFor({ timeout: 40_000 });
    const answer = await aiPanel.locator('.ai-answer-body').first().innerText();
    check('在线回答通过桌面传输返回', answer.includes('在线模拟回答'), answer.slice(0, 80));
    check(
      '回答标注了在线提供方',
      (await aiPanel.locator('.ai-provider').innerText()).includes('会调用在线模型'),
    );
    const citation = aiPanel.locator('.ai-citation').first();
    check('引用校验保留', (await citation.count()) === 1);
    await page.screenshot({ path: join(SHOT_DIR, '03-dev-online-answer.png') });
    await page.getByLabel('关闭 AI 面板').click();

    check('模拟器收到了模型请求', simulator.requests.length >= 1);
    const sent = simulator.requests.at(-1);
    check('请求使用测试 Key', sent?.headers.authorization === `Bearer ${KEY}`);
    check('请求发往本地模拟器', sent?.url === '/chat/completions');
    check(
      '请求携带了选中的原文',
      (sent?.body?.messages ?? []).some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes(selection?.text.slice(0, 20) ?? 'not-present'),
      ),
    );

    // ---- Back to mock, remove the key -----------------------------------
    await page.getByRole('button', { name: 'AI 设置' }).first().click();
    await page.locator('dialog[open] .ai-settings').waitFor({ timeout: 10_000 });
    await page.locator('.ai-mode-card').filter({ hasText: '离线 Mock' }).click();
    await page
      .locator('.ai-service-badge[data-state="ready"]')
      .filter({ hasText: '离线 Mock' })
      .waitFor({ timeout: 40_000 });
    check('可切回离线 Mock', true);
    await page.getByRole('button', { name: '删除已保存的 Key' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await page.locator('.ai-settings__credential[data-configured="false"]').waitFor({
      timeout: 15_000,
    });
    check('测试 Key 已删除', true);
    await page.screenshot({ path: join(SHOT_DIR, '04-dev-key-removed.png') });

    check('控制台无错误', consoleIssues.length === 0, consoleIssues.slice(0, 3).join(' | '));
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    await simulator.close();
    killTree(dev.pid);
    logStream.end();
  }

  const failures = results.filter((entry) => !entry.passed);
  await writeFile(
    REPORT_FILE,
    `${JSON.stringify(
      {
        phase: 11,
        mode: 'dev-online-simulator',
        generatedAt: new Date().toISOString(),
        simulator: simulator.url,
        keyConfiguredBefore: true,
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

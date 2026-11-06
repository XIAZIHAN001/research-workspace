/* global window, IDBFactory, IDBObjectStore, indexedDB, PageTransitionEvent */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { assertFreshBuild } from './preview-gate.mjs';
import { buildSamplePdf } from './sample-pdf.mjs';
import { listenOnLoopback } from '../../server/loopback.mjs';
import { armHarnessDeadline, crashRenderer } from './crash-control.mjs';

/**
 * Linux/Chromium production-build acceptance, NOT Windows/Tauri acceptance.
 * Run: npm run build && BROWSER_PATH=/usr/bin/chromium node scripts/verify/stability.mjs
 * Every context/profile and every PDF is new, synthetic and local. No AI service is started,
 * no real credentials are read, and network requests outside this run's local origin fail.
 * Evidence (including the exact dist hash) is written exclusively under .cache/stability/.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUN = resolve(ROOT, '.cache/stability', new Date().toISOString().replace(/[:.]/g, '-'));
const DIST = resolve(ROOT, 'dist');
const BROWSER = process.env.BROWSER_PATH ?? '/usr/bin/chromium';
const PROJECT = 'Isolated stability fixture';
const PDF = resolve(RUN, 'synthetic-reader.pdf');
const BACKUP = resolve(RUN, 'synthetic-workspace.rwbackup');
const FILTER = process.env.STABILITY_FILTER ? new RegExp(process.env.STABILITY_FILTER) : null;
const results = [];
const externalRequests = [];
const aiRequests = [];
const errors = [];
const contexts = new Set();
const ownedChromium = new Set();
const HARNESS_TIMEOUT_MS = 8 * 60 * 1000;
let activeTest = null;
let browserServer;
let buildEvidence;
let origin;
let browser;
let sourceState;
let exportReady = false;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function test(name, work) {
  if (FILTER !== null && !FILTER.test(name)) return;
  const start = Date.now();
  activeTest = name;
  try {
    const detail = await work();
    results.push({ name, passed: true, durationMs: Date.now() - start, detail });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    results.push({
      name,
      passed: false,
      durationMs: Date.now() - start,
      error: String(error.stack ?? error),
    });
    process.stdout.write(`FAIL ${name}: ${String(error.message ?? error)}\n`);
  } finally {
    activeTest = null;
  }
}

function instrumentation() {
  window.__stability = { reads: [], writes: [], opens: [], lockHeld: false };
  for (const method of ['getItem', 'setItem', 'removeItem', 'clear']) {
    const original = Storage.prototype[method];
    Storage.prototype[method] = function (...args) {
      if (this === window.localStorage) {
        const entries = method === 'getItem' ? window.__stability.reads : window.__stability.writes;
        entries.push({ key: args[0] ?? '*', method, locked: window.__stability.lockHeld });
      }
      return original.apply(this, args);
    };
  }
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...args) {
    window.__stability.opens.push({ name: args[0], locked: window.__stability.lockHeld });
    return open.apply(this, args);
  };
  if (navigator.locks !== undefined) {
    const request = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = (name, options, callback) =>
      request(name, options, async (lock) => {
        if (name === 'rw.workspace.writer.v1') window.__stability.lockHeld = lock !== null;
        try {
          return await callback(lock);
        } finally {
          if (name === 'rw.workspace.writer.v1') window.__stability.lockHeld = false;
        }
      });
  }
}

async function configure(context) {
  contexts.add(context);
  context.setDefaultTimeout(12_000);
  await context.addInitScript(instrumentation);
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`)) {
      if (/\/api\/ai\/(?!health)/.test(url)) aiRequests.push(url);
      await route.continue();
    } else {
      externalRequests.push(url);
      await route.abort('blockedbyclient');
    }
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  return context;
}

async function fresh() {
  return configure(
    await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true }),
  );
}
async function close(context) {
  contexts.delete(context);
  await context.close();
}
async function ready(page) {
  await page.getByLabel('新建项目', { exact: true }).waitFor();
}
async function blocked(page) {
  await page.getByRole('heading', { name: '工作区已暂停' }).waitFor({ timeout: 15_000 });
}
async function createProject(page, name = PROJECT) {
  await ready(page);
  await page.getByLabel('新建项目', { exact: true }).click();
  await page.getByLabel('核心论文标题').fill(name);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
}
async function importPdf(page) {
  await page.getByRole('button', { name: '导入新论文' }).click();
  const dialog = page.getByRole('dialog', { name: '导入论文' });
  await dialog.locator('input[type="file"][data-autofocus]').setInputFiles(PDF);
  await dialog.getByRole('button', { name: '导入', exact: true }).click();
  await page
    .locator('.pdf-page[data-page="1"] .textLayer span')
    .first()
    .waitFor({ timeout: 30_000 });
  assert.match(
    await page.locator('.pdf-page[data-page="1"] .textLayer').innerText(),
    /MARKER-PAGE-1/,
  );
}
async function backupDialog(page) {
  const expand = page.getByLabel('展开侧栏');
  if (await expand.count()) await expand.click();
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '备份与恢复' });
  await dialog.waitFor();
  return dialog;
}
async function inspectBackup(page) {
  assert.ok(exportReady, 'Synthetic UI backup export must pass first');
  const dialog = await backupDialog(page);
  await dialog.getByLabel('选择备份文件').setInputFiles(BACKUP);
  await dialog
    .getByText(/本次会新增/)
    .first()
    .waitFor();
  return dialog;
}
async function workspaceState(page) {
  return page.evaluate(() => ({
    projects: window.localStorage.getItem('rw.projects'),
    knowledge: window.localStorage.getItem('rw.knowledge'),
  }));
}
async function dbRecord(page, database, store, key) {
  return page.evaluate(
    async ({ database, store, key }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!db.objectStoreNames.contains(store)) return null;
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction(store, 'readonly');
          const request =
            key === null
              ? transaction.objectStore(store).getAllKeys()
              : transaction.objectStore(store).get(key);
          let result;
          request.onsuccess = () => {
            result = request.result ?? null;
          };
          transaction.oncomplete = () => resolve(result);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    },
    { database, store, key },
  );
}
async function seed(page, journal, values = {}) {
  await page.goto(`${origin}/__fixture`);
  await page.evaluate(
    async ({ journal, values }) => {
      for (const [key, value] of Object.entries(values)) window.localStorage.setItem(key, value);
      if (journal === undefined) return;
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('rw.restore', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('journal');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('journal', 'readwrite');
        transaction.objectStore('journal').put(journal, 'current');
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
      db.close();
    },
    { journal, values },
  );
}
async function assertNoStores(page) {
  const telemetry = await page.evaluate(() => window.__stability);
  assert.deepEqual(
    telemetry.reads.filter((entry) => ['rw.projects', 'rw.knowledge'].includes(entry.key)),
    [],
    'blocked startup must not construct normal stores',
  );
  assert.deepEqual(telemetry.writes, [], 'blocked startup must not write LocalStorage');
  assert.equal(
    telemetry.opens.some((entry) => entry.name === 'rw.pdfs'),
    false,
    'blocked startup must not open PDF store',
  );
  assert.equal(await page.getByLabel('新建项目', { exact: true }).count(), 0);
  return telemetry;
}

async function startupFaults() {
  const faults = [
    [
      'Web Locks unsupported',
      () => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }),
    ],
    [
      'IndexedDB unavailable',
      () => Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }),
    ],
    [
      'IndexedDB accessor throws',
      () =>
        Object.defineProperty(window, 'indexedDB', {
          configurable: true,
          get() {
            throw new DOMException('isolated fixture', 'SecurityError');
          },
        }),
    ],
    [
      'journal database open throws',
      () => {
        IDBFactory.prototype.open = () => {
          throw new DOMException('isolated fixture', 'UnknownError');
        };
      },
    ],
    [
      'journal read throws',
      () => {
        const original = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function (...args) {
          if (this.transaction.db.name === 'rw.restore')
            throw new DOMException('isolated fixture', 'UnknownError');
          return original.apply(this, args);
        };
      },
    ],
    [
      'journal database open blocked',
      () => {
        const original = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function (...args) {
          if (args[0] !== 'rw.restore') return original.apply(this, args);
          const request = {};
          window.setTimeout(() => request.onblocked?.(), 0);
          return request;
        };
      },
    ],
  ];
  for (const [name, inject] of faults) {
    await test(`${name}: startup fails closed before stores`, async () => {
      const context = await fresh();
      try {
        await context.addInitScript(inject);
        const page = await context.newPage();
        await page.goto(origin);
        await blocked(page);
        const telemetry = await assertNoStores(page);
        await page.screenshot({ path: resolve(RUN, `startup-${name.replaceAll(' ', '-')}.png`) });
        return telemetry;
      } finally {
        await close(context);
      }
    });
  }
  for (const [name, journal] of [
    ['corrupt object', { id: 17, keys: [] }],
    [
      'invalid SHA256',
      {
        id: 'synthetic-bad-hash',
        startedAt: Date.now(),
        keys: { 'rw.projects': { previous: null, nextSha256: 'invalid' } },
      },
    ],
  ]) {
    await test(`${name}: raw journal preserved, workspace untouched`, async () => {
      const context = await fresh();
      try {
        const page = await context.newPage();
        await seed(page, journal, { 'rw.projects': 'UNREADABLE-SYNTHETIC-WORKSPACE' });
        await page.goto(origin);
        await blocked(page);
        await assertNoStores(page);
        assert.deepEqual(await dbRecord(page, 'rw.restore', 'journal', 'current'), journal);
        assert.equal(
          await page.evaluate(() => window.localStorage.getItem('rw.projects')),
          'UNREADABLE-SYNTHETIC-WORKSPACE',
        );
      } finally {
        await close(context);
      }
    });
  }
}

async function tabExclusion() {
  await test('exclusive lifetime Web Lock: second tab never reads or writes workspace', async () => {
    const context = await fresh();
    try {
      const first = await context.newPage();
      await first.goto(origin);
      await createProject(first);
      const second = await context.newPage();
      await second.goto(origin);
      await blocked(second);
      await assertNoStores(second);
      const locks = await first.evaluate(() => navigator.locks.query());
      assert.equal(
        locks.held.filter(
          (lock) => lock.name === 'rw.workspace.writer.v1' && lock.mode === 'exclusive',
        ).length,
        1,
      );
      await second.screenshot({ path: resolve(RUN, 'second-tab-blocked.png') });
      await first.close();
      await second.reload();
      await ready(second);
      await second.getByRole('heading', { level: 1, name: PROJECT, exact: true }).waitFor();
      const telemetry = await second.evaluate(() => window.__stability);
      assert.ok(
        telemetry.reads
          .filter((entry) => ['rw.projects', 'rw.knowledge'].includes(entry.key))
          .every((entry) => entry.locked),
      );
      assert.ok(
        telemetry.opens
          .filter((entry) => entry.name === 'rw.restore')
          .every((entry) => entry.locked),
      );
      return { locks, workspaceReadsRequireLock: true, closedTabHandoff: true };
    } finally {
      await close(context);
    }
  });
  await test('simultaneous startup permits exactly one editable tab; crash hands off lock', async () => {
    const context = await fresh();
    try {
      const pages = [await context.newPage(), await context.newPage()];
      await Promise.all(pages.map((page) => page.goto(origin)));
      await sleep(4200);
      const states = await Promise.all(
        pages.map(async (page) => ({
          editable: await page.getByLabel('新建项目', { exact: true }).count(),
          blocked: await page.getByRole('heading', { name: '工作区已暂停' }).count(),
        })),
      );
      assert.equal(states.filter((state) => state.editable === 1).length, 1);
      assert.equal(states.filter((state) => state.blocked === 1).length, 1);
      const winner = pages[states.findIndex((state) => state.editable === 1)];
      const loser = pages.find((page) => page !== winner);
      await assertNoStores(loser);
      const session = await context.newCDPSession(winner);
      await crashRenderer(winner, session);
      await loser.reload();
      await ready(loser);
      return { states, crash: 'Chromium renderer Page.crash', recovered: true };
    } finally {
      await close(context);
    }
  });
  await test('pagehide revokes writer; persisted pageshow reload cannot bypass another tab', async () => {
    const context = await fresh();
    try {
      const first = await context.newPage();
      await first.goto(origin);
      await ready(first);
      await first.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
      );
      const second = await context.newPage();
      await second.goto(origin);
      await ready(second);
      await Promise.all([
        first.waitForEvent('framenavigated'),
        first.evaluate(() =>
          window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
        ),
      ]);
      await blocked(first);
      await assertNoStores(first);
      return {
        lifecycleEventsInjected: true,
        realBrowserBFCacheNavigation: 'not asserted; Playwright routing disables cache',
      };
    } finally {
      await close(context);
    }
  });
}

async function backupRoundtrip() {
  await test('synthetic PDF imports, renders and exports through real UI', async () => {
    const context = await fresh();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await createProject(page);
      await importPdf(page);
      await page.screenshot({ path: resolve(RUN, 'synthetic-reader.png') });
      await page.getByRole('button', { name: '返回', exact: true }).click();
      sourceState = await workspaceState(page);
      const dialog = await backupDialog(page);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        dialog.getByRole('button', { name: '导出备份文件' }).click(),
      ]);
      await download.saveAs(BACKUP);
      const bytes = await readFile(BACKUP);
      assert.equal(bytes.subarray(0, 8).toString(), 'RWBACKUP');
      const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(8)).toString());
      assert.equal(header.files.length, 1);
      assert.equal(header.files[0].sha256, sha256(await readFile(PDF)));
      assert.deepEqual(await workspaceState(page), sourceState);
      exportReady = true;
      return { bytes: bytes.length, files: header.files.length, counts: header.counts };
    } finally {
      await close(context);
    }
  });
  await test('clean browser restores downloaded backup and renders identical PDF bytes', async () => {
    const context = await fresh();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await ready(page);
      const dialog = await inspectBackup(page);
      await dialog.getByRole('button', { name: '开始恢复' }).click();
      await dialog.locator('.backup-message.is-success').waitFor();
      await page.screenshot({ path: resolve(RUN, 'backup-restored.png') });
      await dialog.getByRole('button', { name: '重新载入以查看恢复后的内容' }).click();
      await ready(page);
      assert.equal((await workspaceState(page)).projects, sourceState.projects);
      await page.getByRole('button', { name: '阅读', exact: true }).first().click();
      await page.locator('.pdf-page[data-page="1"] .textLayer span').first().waitFor();
      assert.match(
        await page.locator('.pdf-page[data-page="1"] .textLayer').innerText(),
        /MARKER-PAGE-1/,
      );
      assert.deepEqual(await dbRecord(page, 'rw.pdfs', 'files', null), [
        sha256(await readFile(PDF)),
      ]);
      assert.equal(await dbRecord(page, 'rw.restore', 'journal', 'current'), null);
    } finally {
      await close(context);
    }
  });
  await test('LocalStorage failure after PDF write rolls back data and removes only newly added PDF', async () => {
    const context = await fresh();
    try {
      await context.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'rw.knowledge' && window.sessionStorage.getItem('stability.fail') === '1') {
            window.sessionStorage.removeItem('stability.fail');
            throw new DOMException('synthetic quota fault', 'QuotaExceededError');
          }
          return original.call(this, key, value);
        };
      });
      const page = await context.newPage();
      await page.goto(origin);
      await createProject(page, 'Original isolated project');
      const before = await workspaceState(page);
      const dialog = await inspectBackup(page);
      await page.evaluate(() => window.sessionStorage.setItem('stability.fail', '1'));
      await dialog.getByRole('button', { name: '开始恢复' }).click();
      await dialog.getByText(/已撤销本次恢复写入的内容/).waitFor();
      assert.deepEqual(await workspaceState(page), before);
      assert.deepEqual(await dbRecord(page, 'rw.pdfs', 'files', null), []);
      assert.equal(await dbRecord(page, 'rw.restore', 'journal', 'current'), null);
      await page.reload();
      await ready(page);
      await page.getByRole('heading', { level: 1, name: 'Original isolated project' }).waitFor();
    } finally {
      await close(context);
    }
  });
}

async function interruptedPdfRestore() {
  await test('renderer crash after PDF commit recovers journal and removes new unreferenced PDF', async () => {
    const context = await fresh();
    try {
      await context.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'rw.projects' && window.sessionStorage.getItem('stability.pause') === '1') {
            window.sessionStorage.removeItem('stability.pause');
            // A deliberate debugger stop gives the harness an exact crash point after PDF
            // transactions commit and before the first LocalStorage change can proceed.
            // eslint-disable-next-line no-debugger
            debugger;
          }
          return original.call(this, key, value);
        };
      });
      let page = await context.newPage();
      await page.goto(origin);
      await createProject(page, 'Before interrupted restore');
      const before = await workspaceState(page);
      const dialog = await inspectBackup(page);
      const session = await context.newCDPSession(page);
      await session.send('Debugger.enable');
      const paused = new Promise((resolve) => session.once('Debugger.paused', resolve));
      await page.evaluate(() => window.sessionStorage.setItem('stability.pause', '1'));
      const click = dialog
        .getByRole('button', { name: '开始恢复' })
        .click()
        .catch(() => {});
      await Promise.race([
        paused,
        sleep(15_000).then(() => {
          throw new Error('Restore did not reach the expected PDF-to-LocalStorage crash boundary');
        }),
      ]);
      // Inspect the same durable stores from a non-app page while the renderer is paused.
      const observer = await context.newPage();
      await observer.goto(`${origin}/__fixture`);
      const filesAtCrash = await dbRecord(observer, 'rw.pdfs', 'files', null);
      assert.deepEqual(filesAtCrash, [sha256(await readFile(PDF))]);
      const journalAtCrash = await dbRecord(observer, 'rw.restore', 'journal', 'current');
      assert.ok(journalAtCrash !== null);
      assert.ok(
        [...(journalAtCrash.pdfsAdded ?? []), ...(journalAtCrash.pdfsPending ?? [])].includes(
          sha256(await readFile(PDF)),
        ),
      );
      await crashRenderer(page, session);
      await click;
      await observer.close();
      page = await context.newPage();
      await page.goto(origin);
      await ready(page);
      assert.deepEqual(await workspaceState(page), before);
      assert.deepEqual(await dbRecord(page, 'rw.pdfs', 'files', null), []);
      assert.equal(await dbRecord(page, 'rw.restore', 'journal', 'current'), null);
      return {
        crash: 'Page.crash at debugger boundary before LocalStorage writes',
        filesAtCrash,
        recovered: true,
      };
    } finally {
      await close(context);
    }
  });
}

async function recoveryFixtures() {
  for (const committed of [false, true]) {
    await test(`${committed ? 'committed' : 'partial'} journal recovery preserves correct persisted state`, async () => {
      const context = await fresh();
      try {
        const page = await context.newPage();
        const journal = {
          id: 'synthetic-recovery',
          startedAt: Date.now(),
          committed,
          keys: {
            'rw.theme': { previous: 'light', nextSha256: sha256('dark') },
            'rw.paper': { previous: null, nextSha256: sha256('sepia') },
          },
        };
        await seed(page, journal, { 'rw.theme': 'dark' });
        await page.goto(origin);
        await ready(page);
        assert.equal(
          await page.evaluate(() => window.localStorage.getItem('rw.theme')),
          committed ? 'dark' : 'light',
        );
        assert.equal(await dbRecord(page, 'rw.restore', 'journal', 'current'), null);
      } finally {
        await close(context);
      }
    });
  }
}

async function launchPersistent(profile) {
  const child = spawn(
    BROWSER,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  trackChromium(child);
  let output = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Isolated Chromium did not expose a debugging endpoint')),
      15_000,
    );
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Isolated Chromium exited: ${code}`));
    });
  }).catch((error) => {
    child.kill('SIGKILL');
    throw error;
  });
  const connection = await chromium.connectOverCDP(endpoint);
  const context = await configure(connection.contexts()[0]);
  return { child, connection, context };
}
async function killPersistent(instance) {
  contexts.delete(instance.context);
  const exited = once(instance.child, 'exit');
  instance.child.kill('SIGKILL');
  await exited;
  await sleep(400);
}
async function crashPersistence() {
  await test('real Chromium process SIGKILL/reopen retains restored workspace and PDF', async () => {
    const profile = resolve(RUN, 'isolated-crash-profile');
    let instance = await launchPersistent(profile);
    try {
      let page = await instance.context.newPage();
      await page.goto(origin);
      await ready(page);
      const dialog = await inspectBackup(page);
      await dialog.getByRole('button', { name: '开始恢复' }).click();
      await dialog.locator('.backup-message.is-success').waitFor();
      const before = await workspaceState(page);
      await killPersistent(instance);
      instance = null;
      instance = await launchPersistent(profile);
      page = await instance.context.newPage();
      await page.goto(origin);
      await ready(page);
      assert.deepEqual(await workspaceState(page), before);
      await page.getByRole('button', { name: '阅读', exact: true }).first().click();
      await page.locator('.pdf-page[data-page="1"] .textLayer span').first().waitFor();
      assert.match(
        await page.locator('.pdf-page[data-page="1"] .textLayer').innerText(),
        /MARKER-PAGE-1/,
      );
      await page.screenshot({ path: resolve(RUN, 'after-process-crash.png') });
      return {
        crash: 'SIGKILL of isolated Linux Chromium process',
        profile: relative(ROOT, profile),
        desktopTauriAcceptance: false,
      };
    } finally {
      if (instance !== null) await killPersistent(instance);
    }
  });
}

function trackChromium(child) {
  ownedChromium.add(child);
  child.once('exit', () => ownedChromium.delete(child));
}

function makeReport(status) {
  return {
    generatedAt: new Date().toISOString(),
    status,
    activeTest,
    scope:
      'Isolated Linux Chromium against production Vite dist; NOT Windows/Tauri desktop acceptance',
    ...buildEvidence,
    browser: BROWSER,
    filter: process.env.STABILITY_FILTER ?? null,
    results,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    externalRequests,
    aiRequests,
    pageErrors: errors,
    notExecuted: [
      'Windows installation and NSIS packaging',
      'Tauri credential lifecycle and fake-key endpoint binding',
      'Tauri sidecar shutdown/restart/orphan process checks',
      'Real online AI and budget settlement',
      'Actual browser BFCache navigation (only lifecycle events injected)',
    ],
  };
}

await mkdir(RUN, { recursive: true });
await writeFile(PDF, buildSamplePdf());
assertFreshBuild(import.meta.url);
buildEvidence = {
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  distIndexSha256: sha256(await readFile(resolve(DIST, 'index.html'))),
};
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.bcmap': 'application/octet-stream',
};
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path === '/__fixture') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Isolated fixture setup</title>');
      return;
    }
    if (path.startsWith('/api/')) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"Offline acceptance has no AI service"}');
      return;
    }
    const file = resolve(DIST, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(`${DIST}/`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
const cancelDeadline = armHarnessDeadline(
  HARNESS_TIMEOUT_MS,
  () => {
    const message = `Acceptance harness timed out after ${HARNESS_TIMEOUT_MS} ms${activeTest === null ? '' : ` during ${activeTest}`}`;
    results.push({ name: 'browser harness overall timeout', passed: false, error: message });
    process.stderr.write(`${message}\n`);
    // Synchronous writing is intentional: even a stuck CDP request or cleanup must leave evidence
    // before this process exits, so the next CI step can upload a truthful failed report.
    writeFileSync(
      resolve(RUN, 'report.json'),
      `${JSON.stringify(makeReport('timed_out'), null, 2)}\n`,
    );
  },
  () => {
    for (const child of ownedChromium) child.kill('SIGKILL');
    process.exit(1);
  },
);
const port = await listenOnLoopback(server);
origin = `http://127.0.0.1:${port}`;
try {
  // The public BrowserServer process handle lets the watchdog terminate only Chromium children
  // owned by this isolated run, without scanning or killing unrelated browser processes.
  browserServer = await chromium.launchServer({
    executablePath: BROWSER,
    args: ['--disable-dev-shm-usage'],
  });
  trackChromium(browserServer.process());
  browser = await chromium.connect(browserServer.wsEndpoint());
  await startupFaults();
  await tabExclusion();
  await backupRoundtrip();
  await interruptedPdfRestore();
  await recoveryFixtures();
  await crashPersistence();
  await test('no online AI calls or external network requests', () => {
    assert.deepEqual(aiRequests, []);
    assert.deepEqual(externalRequests, []);
  });
} catch (error) {
  results.push({
    name: 'browser harness initialization or execution',
    passed: false,
    error: String(error.stack ?? error),
  });
  process.stderr.write(`BLOCKED browser harness: ${String(error.message ?? error)}\n`);
} finally {
  activeTest = 'browser harness cleanup';
  // Preserve results before cleanup too; the deadline remains armed if closing CDP hangs.
  writeFileSync(
    resolve(RUN, 'report.json'),
    `${JSON.stringify(makeReport('cleaning_up'), null, 2)}\n`,
  );
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) await browser.close();
  if (browserServer) await browserServer.close();
  await new Promise((resolve) => server.close(resolve));
  activeTest = null;
  const report = makeReport(results.some((result) => !result.passed) ? 'failed' : 'completed');
  await writeFile(resolve(RUN, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  cancelDeadline();
  process.stdout.write(
    `Report: ${relative(ROOT, resolve(RUN, 'report.json'))}\n${report.passed} passed; ${report.failed} failed\n`,
  );
  if (report.failed > 0) process.exitCode = 1;
}

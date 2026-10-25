/**
 * Phase 8.1 live knowledge-analysis runner.
 *
 * This script is the only path that may spend real money in this round. It is deliberately
 * conservative and deliberately boring:
 *
 * - the key is read from the environment or from the git-ignored `.env.live`, never printed;
 * - every POST is added to the ledger **before** it is sent, so a crash or timeout still counts;
 * - no request is ever retried;
 * - the hard caps are 12 requests, ¥2 reserved budget and explicit token ceilings;
 * - stage `main` stops after five requests so the outputs can be reviewed by a human before
 *   stage `boundary` is allowed to spend the rest;
 * - `--stage=mock` runs the same transport against the offline mock, for preflight only.
 *
 * The script never writes to the application's knowledge store. It calls the service endpoint
 * directly (through the preview proxy), and saves the request/response evidence under
 * `.cache/verify/phase8.1-live/`.
 *
 * Usage:
 *   node scripts/verify/live-knowledge-8.1.mjs --stage=mock
 *   node scripts/verify/live-knowledge-8.1.mjs --stage=main
 *   node scripts/verify/live-knowledge-8.1.mjs --stage=boundary --quality-ok
 *
 * Key setup (never paste a key into chat):
 *   Create `D:\论文阅读解构项目\.env.live` containing exactly one line:
 *   DEEPSEEK_API_KEY=sk-...
 *   The file is ignored by `.gitignore` (`.env.*`). The runner passes it only to the local
 *   service process's environment.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assertFreshBuild } from './preview-gate.mjs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { launchBrowser } from './browser.mjs';

const ROOT = new URL('../../', import.meta.url);
const WORK = new URL('.cache/verify/phase8.1-live/', ROOT);
const AI_PORT = Number(process.env.PHASE81_AI_PORT ?? 8794);
const PREVIEW_PORT = Number(process.env.PHASE81_PREVIEW_PORT ?? 4181);
const AI_ORIGIN = `http://127.0.0.1:${String(AI_PORT)}`;
const ORIGIN = `http://127.0.0.1:${String(PREVIEW_PORT)}/`;
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const SERVER_ENTRY = fileURLToPath(new URL('server/start.mjs', ROOT));
const DLM = new URL('.cache/papers/2610.22294.pdf', ROOT);
const TS = new URL('.cache/papers/2610.22327.pdf', ROOT);

const MODEL = 'deepseek-flash';
const MAX_REQUESTS = 12;
const MAX_BUDGET_CNY = 2;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_TOTAL_PROMPT_TOKENS = 60_000;
const MAX_TOTAL_COMPLETION_TOKENS = 50_000;

/**
 * Official DeepSeek Flash prices, read from api-docs.deepseek.com/quick_start/pricing on
 * 2026-10-18, in USD per 1M tokens:
 *
 *   cache hit input:  off-peak $0.003 / peak $0.006
 *   cache miss input: off-peak $0.15  / peak $0.30
 *   output:           off-peak $0.60  / peak $1.20
 *
 * The runner uses the *peak* cache-miss input and peak output, converted at a deliberately
 * conservative USD/CNY rate of 8.0. That is more than the official price in either period, so
 * the reservation is an upper bound rather than a forecast.
 */
const USD_CNY = 8;
const INPUT_CNY_PER_M = Number(process.env.PHASE81_INPUT_CNY_PER_M ?? 0.3 * USD_CNY);
const OUTPUT_CNY_PER_M = Number(process.env.PHASE81_OUTPUT_CNY_PER_M ?? 1.2 * USD_CNY);
const RESERVE_CNY_PER_REQUEST = Number(process.env.PHASE81_RESERVE_CNY ?? 0.12);

const STAGE_SMOKE = ['smoke-dlm-definition'];
const STAGE_MAIN = [
  'main-dlm-definition',
  'main-dlm-method',
  'main-ts-definition',
  'main-ts-method',
];
const STAGE_BOUNDARY = [
  'boundary-repeat',
  'boundary-adjacent',
  'boundary-short',
  'boundary-formula',
  'boundary-multicolumn',
  'boundary-minimal',
  'boundary-existing',
];

const args = new Set(process.argv.slice(2));
const stageArg = [...args].find((arg) => arg.startsWith('--stage='));
const stage = stageArg?.slice('--stage='.length) ?? '';
const qualityOk = args.has('--quality-ok');
const mockMode = stage === 'mock';

function say(line) {
  process.stdout.write(`${line}\n`);
}

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function cny(value) {
  return `¥${value.toFixed(4)}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

function cleanWindow(text, start, end, maxChars) {
  let left = Math.max(0, start);
  let right = Math.min(text.length, end);
  if (left > 0) {
    const space = text.indexOf(' ', left);
    if (space >= 0 && space - left < 40) left = space + 1;
  }
  if (right < text.length) {
    const space = text.lastIndexOf(' ', right);
    if (space > left && right - space < 40) right = space;
  }
  let slice = text.slice(left, right);
  if (slice.length > maxChars) slice = slice.slice(0, maxChars);
  return slice.trim();
}

async function extractPdf(file, title, paperId) {
  const bytes = new Uint8Array(await readFile(fileURLToPath(file)));
  // pdf.js transfers the buffer it is given, so the digest must be taken first; taking it after
  // extraction hashes an empty buffer and silently gives every paper the same file identity.
  const digest = sha256(bytes);
  const task = getDocument({ data: bytes, disableFontFace: true, useSystemFonts: true });
  const doc = await task.promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = normalize(
      content.items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join(' '),
    );
    pages.push({ page: pageNumber, text });
  }
  await task.destroy();
  return { paperId, title, sha256: digest, pages, pageCount: pages.length };
}

function findQuote(paper, quote) {
  const needle = normalize(quote);
  for (const page of paper.pages) {
    const at = page.text.indexOf(needle);
    if (at >= 0) return { page: page.page, at, text: page.text, quote: needle };
  }
  // A quote that crosses a page boundary is not usable here; fail loudly rather than silently
  // picking a near match.
  fail(`scenario quote not found in ${paper.paperId}: ${needle.slice(0, 80)}`, 3);
  return null;
}

function termsFromQuote(quote) {
  const stop = new Set([
    'the',
    'and',
    'for',
    'that',
    'with',
    'this',
    'from',
    'are',
    'was',
    'were',
    'not',
    'but',
    'they',
    'their',
    'which',
    'what',
    'when',
    'where',
    'while',
    'into',
    'over',
    'under',
    'between',
    'through',
    'because',
    'about',
    'also',
    'such',
    'can',
    'may',
    'will',
    'one',
    'two',
    'our',
    'its',
  ]);
  return [
    ...new Set(
      (quote.match(/[A-Za-z][A-Za-z0-9-]{4,}/g) ?? [])
        .map((word) => word.toLowerCase())
        .filter((word) => !stop.has(word)),
    ),
  ].slice(0, 8);
}

function contextWindow(page, terms, maxChars = 1000) {
  const lower = page.text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term);
    if (at >= 0) break;
  }
  if (at < 0) at = 0;
  return cleanWindow(page.text, at - 300, at + 700, maxChars);
}

function buildRequest(seed, papers) {
  const paper = papers[seed.paper];
  const found = findQuote(paper, seed.quote);
  const terms = termsFromQuote(found.quote);
  const selection = cleanWindow(
    found.text,
    found.at - (seed.selectionWindow ?? 350),
    found.at + found.quote.length + (seed.selectionWindow ?? 350),
    seed.selectionChars ?? 1400,
  );
  const passages = [
    {
      id: 'selection',
      page: found.page,
      text: selection,
      selection: true,
      role: 'selection',
      label: '读者选中的原文',
    },
  ];
  let total = selection.length;
  let contextIndex = 0;
  for (const pageNumber of seed.contextPages ?? []) {
    if (pageNumber === found.page) continue;
    const page = paper.pages.find((entry) => entry.page === pageNumber);
    if (page === undefined || page.text.trim() === '') continue;
    const text = contextWindow(page, terms, seed.contextChars ?? 1000);
    if (text === '') continue;
    if (total + text.length > (seed.maxTotalChars ?? 5000)) break;
    contextIndex += 1;
    passages.push({
      id: `ctx-${String(contextIndex)}`,
      page: pageNumber,
      text,
      selection: false,
      role: pageNumber === found.page + 1 || pageNumber === found.page - 1 ? 'neighbor' : 'context',
      label: `相关段落：第 ${String(pageNumber)} 页`,
    });
    total += text.length;
  }
  return {
    id: seed.id,
    stage: seed.stage,
    note: seed.note,
    paper: seed.paper,
    page: found.page,
    request: {
      paper: {
        id: paper.paperId,
        title: paper.title,
        page: found.page,
        pdfSha256: paper.sha256,
      },
      focus: found.quote,
      scope: 'selection',
      passages,
      existingConcepts: seed.existingConcepts ?? [],
      existingRelations: seed.existingRelations ?? [],
    },
    meta: {
      page: found.page,
      pages: [...new Set(passages.map((passage) => passage.page))],
      passages: passages.length,
      chars: total,
      quoteChars: found.quote.length,
    },
  };
}

async function buildScenarios() {
  const dlm = await extractPdf(
    DLM,
    'Multi-Target Few-Shot Prompting with Diffusion Language Models',
    'dlm-2610.22294',
  );
  const ts = await extractPdf(
    TS,
    'Twice Upon a Time: Complementary Representations for Time-Series Reasoning',
    'ts-2610.22327',
  );
  const papers = { dlm, ts };
  const seeds = [
    {
      id: 'smoke-dlm-definition',
      stage: 'smoke',
      paper: 'dlm',
      note: '冒烟：扩散语言模型的核心定义/接口段',
      quote:
        'Diffusion language models (DLMs) offer a natural interface for these tasks because they are not restricted to next-token prediction and can generate tokens anywhere on the shared canvas',
      contextPages: [1, 3],
    },
    {
      id: 'main-dlm-definition',
      stage: 'main',
      paper: 'dlm',
      note: '主场景：DLM 提出的多目标少样本提示（定义/贡献段）',
      quote:
        'We therefore introduce multi-target few-shot prompting with diffusion language models, where examples guide the infilling of multiple masked regions within a shared canvas',
      contextPages: [1, 2],
    },
    {
      id: 'main-dlm-method',
      stage: 'main',
      paper: 'dlm',
      note: '主场景：DLM 的 masked 解码方法',
      quote:
        'Masked diffusion language models iteratively unmask positions within a shared canvas, supporting flexible generation orders and parallel decoding',
      contextPages: [2, 4],
    },
    {
      id: 'main-ts-definition',
      stage: 'main',
      paper: 'ts',
      note: '主场景：TSLM 的定义与问题设定',
      quote:
        'Time Series Language Models (TSLMs) enable language-based understanding and reasoning over temporal data',
      contextPages: [2, 3],
    },
    {
      id: 'main-ts-method',
      stage: 'main',
      paper: 'ts',
      note: '主场景：双塔互补表示方法',
      quote:
        'We propose a dual-tower architecture that combines line plots and normalized delay embeddings within a shared language model',
      contextPages: [2, 4],
    },
    {
      id: 'boundary-adjacent',
      stage: 'boundary',
      paper: 'dlm',
      note: '边界：与主方法相邻的背景页',
      quote:
        'We consider a partially observed canvas containing D demonstrations, J target sites, and relevant surrounding context',
      contextPages: [3, 5],
    },
    {
      id: 'boundary-short',
      stage: 'boundary',
      paper: 'dlm',
      note: '边界：极短选区（一个术语）',
      quote: 'multi-target few-shot prompting',
      contextPages: [3],
      selectionWindow: 80,
      selectionChars: 300,
    },
    {
      id: 'boundary-formula',
      stage: 'boundary',
      paper: 'dlm',
      note: '边界：公式碎片选区',
      quote: 'R ( u ) := log P 1 ( u ) P 0 ( u )',
      contextPages: [5, 7],
      selectionWindow: 220,
    },
    {
      id: 'boundary-multicolumn',
      stage: 'boundary',
      paper: 'ts',
      note: '边界：方法页与前后页组成的多页上下文',
      quote: 'a Time Series Language Model (TSLM) generates a natural-language answer',
      contextPages: [3, 5],
      selectionWindow: 300,
    },
    {
      id: 'boundary-minimal',
      stage: 'boundary',
      paper: 'dlm',
      note: '边界：只提供选中段，没有其他上下文',
      quote:
        'Diffusion language models (DLMs) offer a natural interface for these tasks because they are not restricted to next-token prediction and can generate tokens anywhere on the shared canvas',
      contextPages: [],
      selectionWindow: 180,
    },
    {
      id: 'boundary-existing',
      stage: 'boundary',
      paper: 'ts',
      note: '边界：已有概念/已确认前置关系时的复用与反向关系',
      quote:
        'Time Series Language Models (TSLMs) enable language-based understanding and reasoning over temporal data',
      contextPages: [2, 3],
      existingConcepts: [
        {
          name: 'Time Series Language Model',
          aliases: ['TSLM', 'TSLMs'],
          summary: '把时间序列作为输入并用语言模型进行理解与推理的模型。',
        },
        {
          name: 'Language Model',
          aliases: ['LM'],
          summary: '在 token 序列上建模并生成输出的模型。',
        },
      ],
      existingRelations: [
        {
          from: 'Time Series Language Model',
          to: 'Language Model',
          kind: 'prerequisite',
          status: 'confirmed',
        },
      ],
    },
  ];
  const scenarios = seeds.map((seed) => buildRequest(seed, papers));
  const smoke = scenarios.find((scenario) => scenario.id === 'smoke-dlm-definition');
  if (smoke === undefined) fail('smoke scenario missing', 3);
  scenarios.push({
    ...structuredClone(smoke),
    id: 'boundary-repeat',
    stage: 'boundary',
    note: '边界：完全重复冒烟请求，检查稳定性',
  });
  return {
    papers: Object.fromEntries(
      Object.entries(papers).map(([key, paper]) => [
        key,
        { title: paper.title, pageCount: paper.pageCount, sha256: paper.sha256 },
      ]),
    ),
    scenarios,
  };
}

/* ------------------------------------------------------------------ *
 * Key, service, proxy
 * ------------------------------------------------------------------ */

async function loadKey() {
  const fromEnv = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (fromEnv !== '') return { key: fromEnv, source: 'environment' };
  const file = fileURLToPath(new URL('.env.live', ROOT));
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (match === null) continue;
      let value = (match[1] ?? '').trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value !== '') return { key: value, source: '.env.live' };
    }
  } catch {
    // No file: fall through to the explicit refusal below.
  }
  return null;
}

async function probeHealth(base) {
  try {
    const response = await fetch(`${base}/api/ai/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function refuseIfPortBusy() {
  for (const [label, base] of [
    ['AI', AI_ORIGIN],
    ['preview', ORIGIN.replace(/\/$/, '')],
  ]) {
    const health = await probeHealth(base);
    if (health !== null) {
      fail(
        `${label} 端口上已有服务在应答（provider=${String(health.provider)}）。本次联调不会使用它；请先停止它或换端口。`,
        4,
      );
    }
  }
}

async function startService(key, source) {
  const child = spawn(process.execPath, [SERVER_ENTRY, '--online'], {
    cwd: fileURLToPath(ROOT),
    env: {
      ...process.env,
      AI_PORT: String(AI_PORT),
      AI_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: key,
      DEEPSEEK_MODEL: MODEL,
      DEEPSEEK_THINKING: 'disabled',
      DEEPSEEK_REASONING_EFFORT: 'none',
      AI_TIMEOUT_MS: '120000',
      AI_MAX_OUTPUT_TOKENS: String(MAX_OUTPUT_TOKENS),
      AI_LOG_REQUESTS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const health = await probeHealth(AI_ORIGIN);
    if (health !== null) {
      return { child, health, keySource: source, output: () => output };
    }
    await sleep(250);
  }
  child.kill();
  fail(`本地在线服务没有启动：\n${output.slice(0, 2000)}`, 4);
  return null;
}

async function startMockService() {
  const child = spawn(process.execPath, [SERVER_ENTRY, '--offline'], {
    cwd: fileURLToPath(ROOT),
    env: { ...process.env, AI_PORT: String(AI_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const health = await probeHealth(AI_ORIGIN);
    if (health !== null) return { child, health, output: () => output };
    await sleep(200);
  }
  child.kill();
  fail(`离线 mock 没有启动：\n${output.slice(0, 2000)}`, 4);
  return null;
}

async function startPreview() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT), '--strictPort'],
    {
      cwd: fileURLToPath(ROOT),
      env: { ...process.env, AI_PORT: String(AI_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(ORIGIN)).ok) return child;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  child.kill();
  fail(`预览服务没有启动：\n${output.slice(0, 2000)}`, 4);
  return null;
}

async function verifyProxy(serviceHealth, expected) {
  const direct = await probeHealth(AI_ORIGIN);
  const proxied = await probeHealth(ORIGIN.replace(/\/$/, ''));
  if (direct === null || proxied === null) fail('健康检查失败：服务或代理没有应答。', 4);
  if (
    direct.instanceId !== serviceHealth.instanceId ||
    proxied.instanceId !== serviceHealth.instanceId
  ) {
    fail(
      `代理实例不一致：服务 ${String(serviceHealth.instanceId)} / 直连 ${String(direct.instanceId)} / 代理 ${String(proxied.instanceId)}`,
      4,
    );
  }
  if (expected === 'live') {
    if (direct.provider !== 'deepseek' || direct.online !== true) {
      fail(
        `服务不是在线 DeepSeek：provider=${String(direct.provider)} online=${String(direct.online)}`,
        4,
      );
    }
    if (direct.model !== MODEL) fail(`模型不是 ${MODEL}，而是 ${String(direct.model)}`, 4);
    if (direct.reasoning !== '思考模式关闭') {
      fail(`思考模式不是关闭：${String(direct.reasoning)}`, 4);
    }
  } else {
    if (direct.provider !== 'mock' || direct.online !== false) {
      fail(
        `mock 预检的服务不是离线 mock：provider=${String(direct.provider)} online=${String(direct.online)}`,
        4,
      );
    }
  }
  return { direct, proxied };
}

async function browserSmoke(expectedInstance, label) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    const health = await page.evaluate(() =>
      fetch('/api/ai/health', { headers: { Accept: 'application/json' } }).then((response) =>
        response.json(),
      ),
    );
    if (health.instanceId !== expectedInstance) {
      fail(`页面代理连接到了另一个实例：${String(health.instanceId)}`, 4);
    }
    const screenshot = new URL(`${label}/00-proxy-check.png`, WORK);
    await mkdir(new URL(`${label}/`, WORK), { recursive: true });
    await page.screenshot({ path: fileURLToPath(screenshot) });
    return health;
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ *
 * Ledger and budget
 * ------------------------------------------------------------------ */

const ledgerPath = (mode) => new URL(`${mode}-ledger.json`, WORK);

async function loadLedger(mode) {
  try {
    return JSON.parse(await readFile(fileURLToPath(ledgerPath(mode)), 'utf8'));
  } catch {
    return null;
  }
}

async function saveLedger(mode, ledger) {
  await writeFile(fileURLToPath(ledgerPath(mode)), JSON.stringify(ledger, null, 2), 'utf8');
}

function emptyLedger(mode, pricing) {
  return {
    mode,
    startedAt: new Date().toISOString(),
    model: mode === 'mock' ? 'mock-1' : MODEL,
    thinking: 'disabled',
    pricing,
    limits: {
      maxRequests: MAX_REQUESTS,
      maxBudgetCny: MAX_BUDGET_CNY,
      reserveCnyPerRequest: RESERVE_CNY_PER_REQUEST,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxTotalPromptTokens: MAX_TOTAL_PROMPT_TOKENS,
      maxTotalCompletionTokens: MAX_TOTAL_COMPLETION_TOKENS,
    },
    requests: [],
    count: 0,
    reservedCny: 0,
    estimatedCostCny: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    stopReason: null,
  };
}

function budgetCheck(ledger, worstPromptTokens) {
  if (ledger.count >= MAX_REQUESTS) return '已达到 12 次请求上限';
  if (ledger.reservedCny + RESERVE_CNY_PER_REQUEST > MAX_BUDGET_CNY + 1e-9) {
    return '预留预算将达到 ¥2 硬上限';
  }
  if (ledger.totalPromptTokens + worstPromptTokens > MAX_TOTAL_PROMPT_TOKENS) {
    return '达到 prompt token 上限';
  }
  if (ledger.totalCompletionTokens + MAX_OUTPUT_TOKENS > MAX_TOTAL_COMPLETION_TOKENS) {
    return '达到 completion token 上限';
  }
  return null;
}

function usageOf(body) {
  const usage = body?.usage;
  return {
    promptTokens:
      usage !== null && usage !== undefined && typeof usage.promptTokens === 'number'
        ? usage.promptTokens
        : null,
    completionTokens:
      usage !== null && usage !== undefined && typeof usage.completionTokens === 'number'
        ? usage.completionTokens
        : null,
    reasoningTokens:
      usage !== null && usage !== undefined && typeof usage.reasoningTokens === 'number'
        ? usage.reasoningTokens
        : null,
    cachedPromptTokens:
      usage !== null && usage !== undefined && typeof usage.cachedPromptTokens === 'number'
        ? usage.cachedPromptTokens
        : null,
  };
}

function estimatedCost(promptTokens, completionTokens, mock) {
  if (mock) return 0;
  return (promptTokens * INPUT_CNY_PER_M + completionTokens * OUTPUT_CNY_PER_M) / 1_000_000;
}

async function runScenario(scenario, ledger, mode) {
  const body = scenario.request;
  const requestChars = body.passages.reduce((sum, passage) => sum + passage.text.length, 0);
  const worstPromptTokens = Math.ceil(requestChars / 1.5) + 1200;
  const stop = budgetCheck(ledger, worstPromptTokens);
  if (stop !== null) {
    ledger.stopReason = stop;
    await saveLedger(mode, ledger);
    return { stop };
  }

  const number = ledger.count + 1;
  const at = new Date().toISOString();
  ledger.count = number;
  ledger.reservedCny = Number((ledger.reservedCny + RESERVE_CNY_PER_REQUEST).toFixed(4));
  ledger.requests.push({
    n: number,
    scenario: scenario.id,
    stage: scenario.stage,
    at,
    requestChars,
    worstPromptTokens,
    completionCap: MAX_OUTPUT_TOKENS,
    reservedCny: RESERVE_CNY_PER_REQUEST,
    status: 'pending',
  });
  await saveLedger(mode, ledger);
  await mkdir(new URL(`${mode}/requests/`, WORK), { recursive: true });
  await writeFile(
    fileURLToPath(
      new URL(`${mode}/requests/${String(number).padStart(2, '0')}-${scenario.id}.json`, WORK),
    ),
    JSON.stringify(body, null, 2),
    'utf8',
  );

  const started = Date.now();
  let outcome;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 130_000);
    try {
      const response = await fetch(`${ORIGIN}api/ai/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      outcome = {
        httpStatus: response.status,
        body: parsed,
        rawText: raw,
        latencyMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    outcome = {
      httpStatus: 0,
      body: null,
      rawText: '',
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'network',
    };
  }

  const entry = ledger.requests[ledger.requests.length - 1];
  const usage = usageOf(outcome.body);
  const mock = mode === 'mock';
  const promptTokens = usage.promptTokens ?? worstPromptTokens;
  const completionTokens = usage.completionTokens ?? MAX_OUTPUT_TOKENS;
  const cost = estimatedCost(promptTokens, completionTokens, mock);
  entry.status = outcome.httpStatus === 200 ? (outcome.body?.status ?? 'http-200') : 'http-error';
  entry.httpStatus = outcome.httpStatus;
  entry.latencyMs = outcome.latencyMs;
  entry.provider = outcome.body?.provider ?? null;
  entry.online = outcome.body?.online ?? null;
  entry.model = outcome.body?.model ?? null;
  entry.outputStatus = outcome.body?.status ?? null;
  entry.finishReason = outcome.body?.diagnostics?.finishReason ?? null;
  entry.rawChars = outcome.body?.diagnostics?.rawChars ?? null;
  entry.groundedInText = outcome.body?.groundedInText ?? null;
  entry.concepts = outcome.body?.concepts?.length ?? 0;
  entry.relations = outcome.body?.relations?.length ?? 0;
  entry.rejected = outcome.body?.rejected ?? 0;
  entry.rejectedCodes = (outcome.body?.rejectedDetails ?? []).map((detail) => detail.code);
  entry.ignoredIdentityFields = outcome.body?.diagnostics?.ignoredIdentityFields ?? null;
  entry.ignoredProvenanceFields = outcome.body?.diagnostics?.ignoredProvenanceFields ?? null;
  entry.pageMismatches = outcome.body?.diagnostics?.pageMismatches ?? null;
  entry.directionDefaulted = outcome.body?.diagnostics?.directionDefaulted ?? null;
  entry.supportDefaulted = outcome.body?.diagnostics?.supportDefaulted ?? null;
  entry.truncated = outcome.body?.diagnostics?.truncated ?? null;
  entry.usage = usage;
  entry.estimatedCostCny = Number(cost.toFixed(4));
  entry.error = outcome.error ?? null;
  ledger.estimatedCostCny = Number((ledger.estimatedCostCny + cost).toFixed(4));
  ledger.totalPromptTokens += promptTokens;
  ledger.totalCompletionTokens += completionTokens;

  await mkdir(new URL(`${mode}/responses/`, WORK), { recursive: true });
  await writeFile(
    fileURLToPath(
      new URL(`${mode}/responses/${String(number).padStart(2, '0')}-${scenario.id}.json`, WORK),
    ),
    JSON.stringify(
      {
        scenario: scenario.id,
        note: scenario.note,
        meta: scenario.meta,
        request: { ...body, passages: body.passages.map((passage) => ({ ...passage })) },
        httpStatus: outcome.httpStatus,
        latencyMs: outcome.latencyMs,
        response: outcome.body,
        error: outcome.error ?? null,
      },
      null,
      2,
    ),
    'utf8',
  );
  await saveLedger(mode, ledger);

  say(
    `#${String(number)} ${scenario.id}: HTTP ${String(outcome.httpStatus)} · ${String(entry.outputStatus)} · ` +
      `${String(outcome.latencyMs)}ms · in ${String(usage.promptTokens ?? '?')} / out ${String(usage.completionTokens ?? '?')} · ` +
      `concepts ${String(entry.concepts)} / relations ${String(entry.relations)} · rejected ${String(entry.rejected)} · ` +
      `est ${cny(cost)} · reserved ${cny(ledger.reservedCny)}`,
  );
  return { outcome, entry };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  if (!['mock', 'smoke', 'main', 'boundary'].includes(stage)) {
    fail('用法：--stage=mock | --stage=smoke | --stage=main | --stage=boundary --quality-ok', 2);
  }
  if (stage === 'boundary' && !qualityOk) {
    fail('拒绝直接运行 boundary：先在人工审阅 main 输出后，确认质量可接受，再加 --quality-ok。', 2);
  }
  await mkdir(WORK, { recursive: true });

  const scenarios = await buildScenarios();
  await writeFile(
    fileURLToPath(new URL('scenarios.json', WORK)),
    JSON.stringify(scenarios, null, 2),
    'utf8',
  );

  const selected =
    stage === 'mock'
      ? scenarios.scenarios.filter((scenario) =>
          ['smoke-dlm-definition', 'main-dlm-method', 'boundary-minimal'].includes(scenario.id),
        )
      : stage === 'smoke'
        ? scenarios.scenarios.filter((scenario) => STAGE_SMOKE.includes(scenario.id))
        : stage === 'main'
          ? scenarios.scenarios.filter((scenario) => STAGE_MAIN.includes(scenario.id))
          : scenarios.scenarios.filter((scenario) => STAGE_BOUNDARY.includes(scenario.id));

  if (selected.length === 0) fail('没有找到本阶段的场景。', 2);

  const pricing = {
    inputCnyPerM: INPUT_CNY_PER_M,
    outputCnyPerM: OUTPUT_CNY_PER_M,
    reserveCnyPerRequest: RESERVE_CNY_PER_REQUEST,
    source:
      '官方价（2026-10-18, api-docs.deepseek.com/quick_start/pricing）：deepseek-flash 峰值 输入缓存未命中 $0.30/M、输出 $1.20/M；按 1 USD = 8 CNY 保守折算。预留 ¥0.12/次。',
  };
  let ledger = mockMode ? emptyLedger('mock', pricing) : await loadLedger('live');
  if (ledger === null) {
    ledger = emptyLedger('live', pricing);
  }
  if (stage === 'boundary') {
    const smokeDone = ledger.requests.filter((entry) => entry.stage === 'smoke');
    const mainDone = ledger.requests.filter((entry) => entry.stage === 'main');
    if (smokeDone.length < 1 || mainDone.length < 4) {
      fail('main 阶段尚未完成，不能直接运行 boundary。', 2);
    }
    if (
      [...smokeDone, ...mainDone].some(
        (entry) =>
          entry.httpStatus !== 200 ||
          entry.outputStatus === 'malformed' ||
          entry.outputStatus === 'incomplete',
      )
    ) {
      fail('main 阶段存在未通过协议/HTTP 检查的请求；先人工分析，不要继续 boundary。', 2);
    }
    if (ledger.requests.some((entry) => entry.stage === 'boundary')) {
      fail('boundary 已经运行过；不会自动重试或重复计费。', 2);
    }
  }
  if (!mockMode) {
    const pending = ledger.requests.find((entry) => entry.status === 'pending');
    if (pending !== undefined) {
      fail(
        `ledger 中第 ${String(pending.n)} 次请求仍是 pending：可能已发送并计费。为避免重复请求，拒绝自动继续；请人工核对后处理 ledger。`,
        2,
      );
    }
    const already = ledger.requests.filter((entry) => entry.stage === stage);
    if (already.length > 0) {
      fail(`${stage} 阶段已经运行过；不会自动重试或重复计费。`, 2);
    }
    if (stage === 'main') {
      const smoke = ledger.requests.filter((entry) => entry.stage === 'smoke');
      if (smoke.length !== 1) {
        fail('main 阶段之前必须先完成一次 smoke 请求。', 2);
      }
      const first = smoke[0];
      if (
        first?.httpStatus !== 200 ||
        (first.outputStatus !== 'valid' && first.outputStatus !== 'recovered')
      ) {
        fail('smoke 请求没有通过协议/HTTP 检查；先人工分析，不要进入 main。', 2);
      }
    }
  }

  let service;
  let preview;
  let keyInfo = null;
  try {
    await refuseIfPortBusy();
    if (mockMode) {
      service = await startMockService();
    } else {
      keyInfo = await loadKey();
      if (keyInfo === null) {
        fail(
          [
            '未找到 DEEPSEEK_API_KEY，不能发起真实业务请求。',
            '请勿在聊天或命令行参数中粘贴密钥。请在项目根目录创建被 .gitignore 忽略的 .env.live：',
            '  DEEPSEEK_API_KEY=sk-...',
            '保存后重新运行本脚本。服务进程只会从环境变量读取它，脚本不会打印密钥。',
          ].join('\n'),
          5,
        );
      }
      service = await startService(keyInfo.key, keyInfo.source);
    }
    assertFreshBuild(import.meta.url);
    preview = await startPreview();
    const proxy = await verifyProxy(service.health, mockMode ? 'mock' : 'live');
    const browserHealth = await browserSmoke(service.health.instanceId, mockMode ? 'mock' : 'live');
    say(
      `preflight: provider=${String(proxy.proxied.provider)} online=${String(proxy.proxied.online)} ` +
        `model=${String(proxy.proxied.model)} instance=${String(proxy.proxied.instanceId)} ` +
        `browserInstance=${String(browserHealth.instanceId)} keySource=${String(keyInfo?.source ?? 'none')}`,
    );
    void browserHealth;
    if (!mockMode && service.health.reasoning !== '思考模式关闭') {
      fail(`思考模式未关闭：${String(service.health.reasoning)}`, 4);
    }
    ledger.instances = [
      ...(ledger.instances ?? []),
      {
        stage,
        at: new Date().toISOString(),
        instanceId: service.health.instanceId,
        provider: service.health.provider,
        online: service.health.online,
        model: service.health.model,
        reasoning: service.health.reasoning,
        limits: service.health.limits,
        keySource: keyInfo?.source ?? null,
      },
    ];
    await saveLedger(mockMode ? 'mock' : 'live', ledger);

    for (const scenario of selected) {
      const result = await runScenario(scenario, ledger, mockMode ? 'mock' : 'live');
      if (result.stop !== undefined) {
        say(`stop: ${result.stop}`);
        break;
      }
      const body = result.outcome.body;
      if (!mockMode) {
        const errorCode = body?.error;
        if (
          errorCode === 'auth' ||
          errorCode === 'insufficient-balance' ||
          errorCode === 'invalid-request' ||
          errorCode === 'bad-request' ||
          errorCode === 'incomplete'
        ) {
          ledger.stopReason = `服务返回不可重试的错误：${String(errorCode)}`;
          await saveLedger('live', ledger);
          say(`stop: ${ledger.stopReason}`);
          break;
        }
        if (
          stage === 'smoke' &&
          (result.outcome.httpStatus !== 200 ||
            (body?.status !== 'valid' && body?.status !== 'recovered'))
        ) {
          ledger.stopReason = '冒烟请求未通过 HTTP/协议检查';
          await saveLedger('live', ledger);
          say(`stop: ${ledger.stopReason}`);
          break;
        }
        if (result.outcome.httpStatus !== 200) {
          ledger.consecutiveFailures = (ledger.consecutiveFailures ?? 0) + 1;
        } else {
          ledger.consecutiveFailures = 0;
        }
        if ((ledger.consecutiveFailures ?? 0) >= 3) {
          ledger.stopReason = '连续 3 次上游错误或超时';
          await saveLedger('live', ledger);
          say(`stop: ${ledger.stopReason}`);
          break;
        }
        if (body?.provider !== 'deepseek' || body?.online !== true) {
          ledger.stopReason = '响应不是来自预期的在线 DeepSeek';
          await saveLedger('live', ledger);
          say(`stop: ${ledger.stopReason}`);
          break;
        }
        if (body?.status === 'malformed') {
          ledger.stopReason = '模型输出协议无法解析（malformed）';
          await saveLedger('live', ledger);
          say(`stop: ${ledger.stopReason}`);
          break;
        }
        if (body?.status === 'incomplete') {
          ledger.stopReason = '模型输出被截断（incomplete）';
          await saveLedger('live', ledger);
          say(`stop: ${ledger.stopReason}`);
          break;
        }
      }
      if (ledger.estimatedCostCny + RESERVE_CNY_PER_REQUEST > MAX_BUDGET_CNY) {
        ledger.stopReason = '实际估算费用加上下一次预留将超过 ¥2';
        await saveLedger(mockMode ? 'mock' : 'live', ledger);
        say(`stop: ${ledger.stopReason}`);
        break;
      }
      await sleep(2000);
    }
  } finally {
    preview?.kill();
    service?.child.kill();
  }

  const mode = mockMode ? 'mock' : 'live';
  await saveLedger(mode, ledger);
  say(
    `stage ${stage} complete: ${String(ledger.count)} request(s), reserved ${cny(ledger.reservedCny)}, ` +
      `estimated ${cny(ledger.estimatedCostCny)}, prompt ${String(ledger.totalPromptTokens)} / completion ${String(ledger.totalCompletionTokens)} tokens`,
  );
  if (ledger.stopReason !== null) say(`stopReason: ${ledger.stopReason}`);
  if (stage === 'smoke') {
    say('下一步：人工检查 live/responses/ 中的冒烟输出；协议与质量无阻断后，再运行 --stage=main。');
  }
  if (stage === 'main') {
    say(
      '下一步：人工审阅 live/responses/ 与论文原文；质量可接受后再运行 --stage=boundary --quality-ok。',
    );
  }
  if (stage === 'boundary') {
    say('边界阶段结束；不再自动发起任何真实调用。');
  }
}

await main();

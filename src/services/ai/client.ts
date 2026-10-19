/**
 * The browser's side of the conversation with the local AI service.
 *
 * Two things this module is careful about:
 *
 * - It never carries a credential. The request has no Authorization header and no key, because
 *   the service holds the key and the browser has no business seeing it.
 * - It always ends. Every call has a deadline and honours a cancellation, and a failure is
 *   returned as a value rather than thrown, because a failed explanation must not disturb the
 *   highlights, notes or reading position around it.
 */

import type { ProposedDifficulty } from '../../domain/difficulty';
import { getDesktopAiStatus, isDesktopApp } from '../desktop/aiService';
import type { KnowledgeAnalysis, KnowledgeRequest } from './knowledgeTypes';
import type {
  AiAnswer,
  AiAskRequest,
  AiFailure,
  AiFailureKind,
  AiHealth,
  AiPaperRef,
} from './types';

/** Matches the service's own default; the interface may lower it, never raise it. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface AiClientOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Empty by default: the page and the service share an origin through the Vite proxy. */
  baseUrl?: string;
}

export type AskOutcome = { ok: true; answer: AiAnswer } | { ok: false; failure: AiFailure };

/** HTTP status and the service's own error code, mapped to something the interface can show. */
const MESSAGES: Record<AiFailureKind, string> = {
  offline: '连接不上本地的 AI 服务。请确认它是启动着的（npm run ai:serve）。',
  timeout: '模型在限定时间内没有返回。已有的高亮和笔记不受影响，可以重试。',
  cancelled: '已取消这次提问。',
  busy: '本地服务同时在处理的请求太多，请稍后再试。',
  'rate-limit': '模型服务表示频率或并发受限，请稍后再试。',
  'insufficient-balance': '模型服务账户余额不足，充值后才能继续；重试不会有用。',
  'invalid-request': '本地服务构造的请求被模型服务拒绝了，这是应用的配置问题，不是你的操作问题。',
  incomplete: '模型没有写完回答就停了（思考模式的推理会占用同一份生成预算）。',
  auth: '模型服务拒绝了这次请求（凭据无效或没有权限）。',
  upstream: '模型服务返回了错误，这次没有得到回答。',
  'bad-request': '这次请求的内容不符合服务的要求，没有发送出去。',
  'budget-exceeded':
    '本次会话的在线模型预算已经用完，这次请求没有发送。可以在桌面「AI 设置」里调整上限，或重启 AI 服务开始新的会话。',
  unknown: '这次提问失败了，没有得到回答。',
};

function describeFailure(kind: AiFailureKind, override?: string): AiFailure {
  if (kind === 'offline' && override === undefined) {
    return { kind, message: offlineMessage() };
  }
  return { kind, message: override ?? MESSAGES[kind] };
}

function offlineMessage(): string {
  return isDesktopApp()
    ? '连接不上桌面应用内的 AI 服务。可以在右下角的状态区重新启动它。'
    : MESSAGES.offline;
}

/**
 * Resolves the transport for one call.
 *
 * Browser: unchanged — relative URLs through the Vite proxy. Desktop: ask Rust for the
 * sidecar's ephemeral base URL and launch token, then attach the token to every request. The
 * token is deliberately fetched per call rather than cached: a restart rotates it, and a
 * stale token would turn a working service into a confusing 401.
 *
 * An explicit `baseUrl` or `fetchImpl` means the caller (tests, verification scripts) owns the
 * transport, so the desktop path is never taken under them.
 */
async function resolveTransport(options: AiClientOptions): Promise<AiClientOptions> {
  if (!isDesktopApp() || options.baseUrl !== undefined || options.fetchImpl !== undefined) {
    return options;
  }

  const status = await getDesktopAiStatus();
  if (
    status === null ||
    status.state !== 'ready' ||
    status.baseUrl === null ||
    status.token === null
  ) {
    // The call will fail as "offline" without reaching the network. A fetch that rejects is
    // the same shape every caller already handles.
    const unavailable: typeof fetch = () => Promise.reject(new TypeError('AI service unavailable'));
    return { ...options, fetchImpl: unavailable };
  }

  const token = status.token;
  const withToken: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  return { ...options, baseUrl: status.baseUrl, fetchImpl: withToken };
}

function kindFor(status: number, code: unknown): AiFailureKind {
  if (code === 'busy') return 'busy';
  if (code === 'timeout' || status === 504) return 'timeout';
  if (code === 'incomplete') return 'incomplete';
  if (code === 'insufficient-balance') return 'insufficient-balance';
  if (code === 'invalid-request') return 'invalid-request';
  if (code === 'rate-limit' || status === 429) return 'rate-limit';
  if (code === 'auth') return 'auth';
  if (code === 'budget-exceeded') return 'budget-exceeded';
  if (code === 'bad-request' || status === 400 || status === 413) return 'bad-request';
  if (status === 502) return 'upstream';
  return 'unknown';
}

function isFailure(value: unknown): value is { error: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

const STATUSES = new Set(['valid', 'recovered', 'malformed', 'incomplete', 'provider-error']);

/**
 * Reads an answer, tolerating a service that predates `status`.
 *
 * A stale service process is a real thing — it happened during the Phase 4.1 run, where an old
 * build kept answering on the port. An answer without a status is therefore treated as
 * `recovered` rather than `valid`: the interface stops claiming the contract was followed, which
 * is the honest reading of "this reply did not say".
 */
function isAnswer(value: unknown): value is AiAnswer {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AiAnswer>;
  if (typeof candidate.answer !== 'string') return false;
  if (!Array.isArray(candidate.citations)) return false;
  if (typeof candidate.status !== 'string' || !STATUSES.has(candidate.status)) {
    candidate.status = 'recovered';
  }
  if (typeof candidate.diagnostics !== 'object') candidate.diagnostics = null;
  if (!Array.isArray(candidate.warnings)) candidate.warnings = [];
  return true;
}

export async function askAi(
  request: AiAskRequest,
  options: AiClientOptions = {},
): Promise<AskOutcome> {
  const {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    baseUrl = '',
  } = await resolveTransport(options);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const relay = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', relay, { once: true });

  try {
    const response = await fetchImpl(`${baseUrl}/api/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, failure: describeFailure('upstream') };
    }

    if (!response.ok) {
      const code = isFailure(payload) ? payload.error : undefined;
      return { ok: false, failure: describeFailure(kindFor(response.status, code)) };
    }
    if (!isAnswer(payload)) return { ok: false, failure: describeFailure('upstream') };
    return { ok: true, answer: payload };
  } catch {
    // The three ways a fetch rejects here: the reader cancelled, the deadline passed, or the
    // service is not running. They are different situations and get different wording.
    if (signal?.aborted === true) return { ok: false, failure: describeFailure('cancelled') };
    if (timedOut) return { ok: false, failure: describeFailure('timeout') };
    return { ok: false, failure: describeFailure('offline') };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

/** Asks the service what it is. Returns null when it is not running, which is not an error. */
export async function fetchAiHealth(options: AiClientOptions = {}): Promise<AiHealth | null> {
  const { fetchImpl = globalThis.fetch, baseUrl = '' } = await resolveTransport(options);
  try {
    const response = await fetchImpl(`${baseUrl}/api/ai/health`);
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    if (typeof payload !== 'object' || payload === null) return null;
    const candidate = payload as Partial<AiHealth>;
    if (typeof candidate.provider !== 'string' || typeof candidate.label !== 'string') return null;
    return candidate as AiHealth;
  } catch {
    return null;
  }
}

/** What one page's analysis came back with. */
export interface DifficultyAnalysis {
  provider: string;
  providerLabel: string;
  model: string;
  online: boolean;
  page: number;
  /** The rules that produced this, so the cache can key on them. */
  rulesVersion: string;
  status: 'valid' | 'recovered' | 'malformed';
  suggestions: ProposedDifficulty[];
  /** Suggestions whose quotation was not in the page text sent. */
  rejected: number;
}

export type DifficultyOutcome =
  { ok: true; value: DifficultyAnalysis } | { ok: false; failure: AiFailure };

function isAnalysis(value: unknown): value is DifficultyAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DifficultyAnalysis>;
  return (
    typeof candidate.page === 'number' &&
    typeof candidate.rulesVersion === 'string' &&
    Array.isArray(candidate.suggestions)
  );
}

/**
 * Asks the local service what is worth understanding on one page.
 *
 * Same contract as `askAi`: no credential, a deadline, a cancellation, and a failure returned
 * as a value. A failed analysis must never disturb the page it was analysing.
 */
export async function analyzeDifficulties(
  request: { paper: AiPaperRef; pageText: string },
  options: AiClientOptions = {},
): Promise<DifficultyOutcome> {
  const {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    baseUrl = '',
  } = await resolveTransport(options);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const relay = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', relay, { once: true });

  try {
    const response = await fetchImpl(`${baseUrl}/api/ai/difficulties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, failure: describeFailure('upstream') };
    }

    if (!response.ok) {
      const code = isFailure(payload) ? payload.error : undefined;
      return { ok: false, failure: describeFailure(kindFor(response.status, code)) };
    }
    if (!isAnalysis(payload)) return { ok: false, failure: describeFailure('upstream') };
    return { ok: true, value: payload };
  } catch {
    if (signal?.aborted === true) return { ok: false, failure: describeFailure('cancelled') };
    if (timedOut) return { ok: false, failure: describeFailure('timeout') };
    return { ok: false, failure: describeFailure('offline') };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

/** What one knowledge analysis came back with. */
export type KnowledgeOutcome =
  { ok: true; analysis: KnowledgeAnalysis } | { ok: false; failure: AiFailure };

const KNOWLEDGE_STATUSES = new Set(['valid', 'recovered', 'malformed', 'incomplete']);

function isKnowledgeAnalysis(value: unknown): value is KnowledgeAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<KnowledgeAnalysis>;
  if (!Array.isArray(candidate.concepts) || !Array.isArray(candidate.relations)) return false;
  if (typeof candidate.status !== 'string' || !KNOWLEDGE_STATUSES.has(candidate.status)) {
    // An older service process, or one that does not speak this protocol. The reply is still
    // readable as suggestions, but it did not follow the contract; saying so is more honest than
    // claiming `valid`.
    candidate.status = 'recovered';
  }
  if (!Array.isArray(candidate.rejectedDetails)) candidate.rejectedDetails = [];
  if (!Array.isArray(candidate.warnings)) candidate.warnings = [];
  if (typeof candidate.diagnostics !== 'object') candidate.diagnostics = null;
  if (typeof candidate.rulesVersion !== 'string') candidate.rulesVersion = '';
  return true;
}

/**
 * Asks the local service for evidence-backed concepts and relations.
 *
 * Same contract as every other call: no credential, a deadline, a cancellation, and a failure
 * returned as a value. A failed analysis must leave the reader's knowledge graph untouched,
 * which is why nothing is written until this function returns a result.
 */
export async function analyzeKnowledge(
  request: KnowledgeRequest,
  options: AiClientOptions = {},
): Promise<KnowledgeOutcome> {
  const {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    baseUrl = '',
  } = await resolveTransport(options);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const relay = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', relay, { once: true });

  try {
    const response = await fetchImpl(`${baseUrl}/api/ai/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, failure: describeFailure('upstream') };
    }

    if (!response.ok) {
      const code = isFailure(payload) ? payload.error : undefined;
      return { ok: false, failure: describeFailure(kindFor(response.status, code)) };
    }
    if (!isKnowledgeAnalysis(payload)) return { ok: false, failure: describeFailure('upstream') };
    return { ok: true, analysis: payload };
  } catch {
    if (signal?.aborted === true) return { ok: false, failure: describeFailure('cancelled') };
    if (timedOut) return { ok: false, failure: describeFailure('timeout') };
    return { ok: false, failure: describeFailure('offline') };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

/**
 * Configuration for the local AI service.
 *
 * The service exists so that the API key never has to exist inside the browser bundle. It reads
 * its settings from the environment of the process that starts it — never from the request — so
 * a page cannot point it at another host, another model, or another account.
 *
 * Two settings decide whether a request can cost money, and both must be set deliberately:
 * `AI_PROVIDER=deepseek` and a `DEEPSEEK_API_KEY`. The default is the offline mock provider, so
 * merely running the app cannot start a billable call.
 */

/**
 * The address the service binds to. This is not configurable: a loopback-only listener is the
 * whole boundary between the key holder and the network, and a typo in an environment variable
 * should not be able to turn it into a public one.
 */
export const LOOPBACK_HOST = '127.0.0.1';

export const DEFAULT_PORT = 8787;

/** Providers this build knows how to talk to. */
export const PROVIDER_NAMES = ['mock', 'deepseek'];

/** Endpoints that exist. Everything else is a 404, so this cannot act as a general proxy. */
export const ROUTES = {
  health: '/api/ai/health',
  ask: '/api/ai/ask',
  knowledge: '/api/ai/knowledge',
};

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** DeepSeek's current published model names, checked against api-docs.deepseek.com. */
export const KNOWN_DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

/**
 * Thinking mode, which upstream defaults to *on* at effort `high`.
 *
 * That default matters here for a reason worth writing down: `reasoning_tokens` count towards
 * `max_tokens`, so a long think can consume the whole generation budget and leave `content`
 * empty or cut off. The service therefore sends both settings explicitly rather than inheriting
 * someone else's default, and budgets the token ceiling for reasoning plus answer together.
 *
 * `reasoning_effort` can also switch thinking back on — the documented values are
 * `none` (disables it), `low`, `high` and `max` (all enable it). Sending `thinking: disabled`
 * together with an effort that enables it would be contradictory, so a disabled thinking mode
 * forces `none`.
 */
export const THINKING_TYPES = ['enabled', 'disabled'];
export const REASONING_EFFORTS = ['none', 'low', 'high', 'max'];

/** The effort used when thinking is on and nothing was configured: enough to help, bounded. */
export const DEFAULT_REASONING_EFFORT = 'low';

/** Bounds on what a single request may carry. Deliberately far below "a whole paper". */
export const LIMITS = {
  bodyBytes: 256 * 1024,
  passages: 8,
  passageChars: 2000,
  totalContextChars: 6000,
  questionChars: 1000,
  historyTurns: 6,
  historyChars: 2000,
  /**
   * Total generation budget, not just the answer's: in thinking mode this ceiling covers the
   * reasoning tokens as well.
   *
   * 4096 was not enough. Measured against the live API on a real paper: a prose explanation
   * spent 2689 of it thinking and still fitted, while a question about an equation spent the
   * whole 4096 reasoning and returned no answer at all. 8192 leaves room for an answer after a
   * think of that size, and is still a hard bound on what one request can cost.
   */
  answerTokens: 8192,
  /** Requests allowed per minute, per process. A runaway loop costs money; this caps it. */
  requestsPerMinute: 30,
  concurrentRequests: 4,
  /**
   * Knowledge analysis is stricter than a question on purpose: it may look at several pages of
   * the same paper, so the page count, passage count and total characters are bounded together.
   * A larger context does not buy a better graph; it buys a bigger bill and a harder review.
   */
  knowledgePassages: 8,
  knowledgeContextChars: 9000,
  knowledgePages: 6,
  existingConcepts: 60,
};

/**
 * A thinking-mode call is not quick. The same live run measured 21 s for a prose explanation and
 * 25 s for a formula question that then ran out of budget at 4096 tokens; one that is allowed
 * 8192 can take about a minute, and cutting it off at 60 s would turn a slow answer into none.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

function readInt(value, fallback, { min, max }) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** A model name has to survive being put in a JSON body; anything else is a configuration error. */
export function isValidModelName(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= 64 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/**
 * Loopback origins are always acceptable; anything else must be listed explicitly.
 *
 * The Origin check defends against a *web page* the reader happens to have open making requests
 * to this service: such a page can only ever present an origin from wherever it was served, and
 * it cannot serve itself from the reader's own loopback address. A configured allowlist exists
 * for the unusual case of an app served from a fixed non-loopback origin.
 */
export function isLoopbackOrigin(origin) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

export function readConfig(env = process.env, { forceOffline = false } = {}) {
  // `--offline` is not a preference, it is a wall: a machine that happens to have a key in its
  // environment must still be able to start a service that cannot spend anything.
  const provider = forceOffline ? 'mock' : env.AI_PROVIDER === 'deepseek' ? 'deepseek' : 'mock';
  const extraOrigins = (env.AI_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  // An effort that enables thinking would contradict a disabled thinking mode, so the two are
  // resolved here rather than sent upstream as a request that means two different things.
  const thinking = env.DEEPSEEK_THINKING === 'disabled' ? 'disabled' : 'enabled';
  const requestedEffort = REASONING_EFFORTS.includes(env.DEEPSEEK_REASONING_EFFORT)
    ? env.DEEPSEEK_REASONING_EFFORT
    : DEFAULT_REASONING_EFFORT;
  const reasoningEffort = thinking === 'disabled' ? 'none' : requestedEffort;

  return {
    port: readInt(env.AI_PORT, DEFAULT_PORT, { min: 1, max: 65535 }),
    provider,
    /** Set only for the deepseek provider; the mock provider ignores it entirely. */
    apiKey:
      forceOffline || typeof env.DEEPSEEK_API_KEY !== 'string' ? '' : env.DEEPSEEK_API_KEY.trim(),
    baseUrl: (env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, ''),
    model: isValidModelName(env.DEEPSEEK_MODEL) ? env.DEEPSEEK_MODEL : KNOWN_DEEPSEEK_MODELS[0],
    thinking,
    reasoningEffort,
    timeoutMs: readInt(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 1000, max: 600_000 }),
    /** Overrides the generation ceiling; bounded so a typo cannot ask for a million tokens. */
    answerTokens: readInt(env.AI_MAX_OUTPUT_TOKENS, LIMITS.answerTokens, { min: 256, max: 32_000 }),
    allowedOrigins: extraOrigins,
    /** Where the mock provider's answers come from; see providers/mock.mjs. */
    logRequests: env.AI_LOG_REQUESTS !== '0',
  };
}

/**
 * What is wrong with this configuration, in terms the operator can act on.
 *
 * Returning reasons rather than throwing lets `start.mjs` print them all at once, and lets the
 * tests assert on the wording of a misconfiguration instead of on a stack trace.
 */
export function configProblems(config) {
  const problems = [];
  if (!PROVIDER_NAMES.includes(config.provider)) {
    problems.push(`未知的 AI_PROVIDER：${config.provider}`);
  }
  if (config.provider === 'deepseek' && config.apiKey === '') {
    problems.push('AI_PROVIDER=deepseek 需要同时设置 DEEPSEEK_API_KEY（只从环境变量读取）。');
  }
  if (config.provider === 'deepseek' && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(config.baseUrl)) {
    problems.push(`DEEPSEEK_BASE_URL 必须是 https 地址，当前是 ${config.baseUrl}`);
  }
  for (const origin of config.allowedOrigins) {
    if (!/^https?:\/\/[^\s/]+$/.test(origin))
      problems.push(`AI_ALLOWED_ORIGINS 里的 ${origin} 不是来源`);
  }
  return problems;
}

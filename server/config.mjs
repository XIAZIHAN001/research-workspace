/**
 * Configuration for the local AI service.
 *
 * The service exists so that the API key never has to exist inside the browser bundle. It reads
 * its settings from the environment of the process that starts it — never from the request — so
 * a page cannot point it at another host, another model, or another account.
 *
 * Two settings decide whether a request can cost money, and both must be set deliberately:
 * `AI_PROVIDER` naming a real provider and an API key for it. The default is the offline mock
 * provider, so merely running the app cannot start a billable call.
 */

/**
 * The address the service binds to. This is not configurable: a loopback-only listener is the
 * whole boundary between the key holder and the network, and a typo in an environment variable
 * should not be able to turn it into a public one.
 */
export const LOOPBACK_HOST = '127.0.0.1';

export const DEFAULT_PORT = 8787;

/**
 * Providers this build knows how to talk to.
 *
 * The ids match `src-tauri/src/providers.rs`, which owns the display names, preset endpoints and
 * default models. Only `deepseek` has a dialect of its own (the `thinking` pair); every other id,
 * including `custom`, is sent an ordinary OpenAI-compatible chat-completions request.
 */
export const PROVIDER_NAMES = [
  'mock',
  'deepseek',
  'openai',
  'moonshot',
  'zhipu',
  'dashscope',
  'custom',
];

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
 * Desktop run modes.
 *
 * `mock` never reaches a network. `online` uses the DeepSeek provider and, before any key
 * arrives, refuses to serve a model call. The desktop shell chooses one at spawn time; the
 * request side cannot change it.
 */
export const DESKTOP_MODES = ['mock', 'online'];

/**
 * Per-session spending caps for the paid provider.
 *
 * `requests` counts attempts, including failed ones, because a retry loop is exactly what this
 * is meant to stop. The two token limits bound the generation budget per call and the total
 * session's upper-bound usage. They are enforced before the call, using a deliberately
 * pessimistic input estimate, so exceeding a limit ends with a refusal rather than a bill.
 */
export const DEFAULT_BUDGET = {
  requests: 50,
  tokensPerRequest: 8192,
  tokensPerSession: 200_000,
};

export const BUDGET_BOUNDS = {
  requests: { min: 1, max: 1000 },
  tokensPerRequest: { min: 256, max: 32_000 },
  tokensPerSession: { min: 256, max: 10_000_000 },
};

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

/** Bounds on what a single request may carry. */
export const LIMITS = {
  bodyBytes: 2 * 1024 * 1024,
  passages: 8,
  passageChars: 2000,
  totalContextChars: 6000,
  /**
   * Document scope: the reader attached the whole paper, one passage per page.
   *
   * These are separate from the selection limits on purpose. A question about one passage should
   * stay small and cheap; an explicit "read the whole paper" request is the one case where the
   * reader asked for a large input and should get it. 350k characters leaves room for the primary
   * passage plus the 340k-character document cap the reader applies.
   */
  documentPassages: 200,
  documentPassageChars: 12_000,
  documentContextChars: 350_000,
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
    value.length <= 128 &&
    /^[A-Za-z0-9._:/@-]+$/.test(value)
  );
}

/** The first non-empty string among the candidates, or undefined. */
function firstFilled(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** https anywhere; plain http only for a model server on this machine. */
function isAllowedBaseUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (/^https:\/\/[^\s]+$/i.test(value)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/i.test(value);
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

export function readConfig(
  env = process.env,
  { forceOffline = false, allowEphemeralPort = false, deferredKey = false } = {},
) {
  // `--offline` is not a preference, it is a wall: a machine that happens to have a key in its
  // environment must still be able to start a service that cannot spend anything.
  const requestedProvider = typeof env.AI_PROVIDER === 'string' ? env.AI_PROVIDER.trim() : '';
  const provider = forceOffline ? 'mock' : requestedProvider === '' ? 'mock' : requestedProvider;
  const extraOrigins = (env.AI_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  // An effort that enables thinking would contradict a disabled thinking mode, so the two are
  // resolved here rather than sent upstream as a request that means two different things.
  const thinking =
    firstFilled(env.AI_THINKING, env.DEEPSEEK_THINKING) === 'disabled' ? 'disabled' : 'enabled';
  const requestedEffort = firstFilled(env.AI_REASONING_EFFORT, env.DEEPSEEK_REASONING_EFFORT);
  const reasoningEffort =
    thinking === 'disabled'
      ? 'none'
      : REASONING_EFFORTS.includes(requestedEffort)
        ? requestedEffort
        : DEFAULT_REASONING_EFFORT;

  // The `DEEPSEEK_*` names are the pre-multi-provider spelling. They are still read so an
  // existing launcher, script or test keeps working; the shell now writes the generic names.
  const requestedBaseUrl = firstFilled(env.AI_BASE_URL, env.DEEPSEEK_BASE_URL);
  const baseUrl = (requestedBaseUrl ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, '');
  const requestedModel = firstFilled(env.AI_MODEL, env.DEEPSEEK_MODEL);
  const model = isValidModelName(requestedModel)
    ? requestedModel
    : // The mock provider never calls a model, and DeepSeek is the one provider whose default
      // model this build knows by name. Any other paid provider with no model is a configuration
      // problem rather than a guess that would be sent upstream.
      provider === 'mock' || provider === 'deepseek'
      ? KNOWN_DEEPSEEK_MODELS[0]
      : '';
  const apiKeyEnv = firstFilled(env.AI_API_KEY, env.DEEPSEEK_API_KEY) ?? '';

  return {
    port: readInt(env.AI_PORT, DEFAULT_PORT, { min: allowEphemeralPort ? 0 : 1, max: 65535 }),
    /**
     * The desktop shell's per-launch credential.
     *
     * Empty outside the desktop: the browser build talks to the service through the Vite proxy
     * and has no credential to present. When set, every non-preflight request must carry it,
     * which is what stops an unrelated local page from using the service even if it discovers
     * the ephemeral port.
     */
    sessionToken: typeof env.AI_SESSION_TOKEN === 'string' ? env.AI_SESSION_TOKEN.trim() : '',
    /**
     * Identifies the desktop shell instance that spawned this process. Echoed in `health` so
     * the shell can verify it is talking to the child it started, not to another process that
     * happens to answer on the same port.
     */
    desktopInstance:
      typeof env.AI_DESKTOP_INSTANCE === 'string' ? env.AI_DESKTOP_INSTANCE.trim() : '',
    /** `mock` or `online`; only meaningful to the desktop launcher. */
    desktopMode: env.AI_DESKTOP_MODE === 'online' ? 'online' : 'mock',
    provider,
    /**
     * Set only for a paid provider; the mock provider ignores it entirely.
     *
     * The desktop does not put the key in the environment at all. It starts the sidecar with
     * `deferredKey: true` and sends the key over stdin once the process exists. Until that line
     * arrives, the service refuses to listen for model calls.
     */
    apiKey: forceOffline ? '' : apiKeyEnv,
    deferredKey,
    baseUrl,
    model,
    thinking,
    reasoningEffort,
    timeoutMs: readInt(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 1000, max: 600_000 }),
    /** Overrides the generation ceiling; bounded so a typo cannot ask for a million tokens. */
    answerTokens: readInt(env.AI_MAX_OUTPUT_TOKENS, LIMITS.answerTokens, { min: 256, max: 32_000 }),
    budget: {
      requests: readInt(env.AI_BUDGET_REQUESTS, DEFAULT_BUDGET.requests, BUDGET_BOUNDS.requests),
      tokensPerRequest: readInt(
        env.AI_BUDGET_TOKENS_PER_REQUEST,
        DEFAULT_BUDGET.tokensPerRequest,
        BUDGET_BOUNDS.tokensPerRequest,
      ),
      tokensPerSession: readInt(
        env.AI_BUDGET_TOKENS_SESSION,
        DEFAULT_BUDGET.tokensPerSession,
        BUDGET_BOUNDS.tokensPerSession,
      ),
    },
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

  const paid = config.provider !== 'mock';
  if (paid && config.apiKey === '' && config.deferredKey !== true) {
    problems.push(
      `AI_PROVIDER=${config.provider} 需要同时提供一个 API Key（只从环境变量或桌面凭据通道读取）。`,
    );
  }
  if (paid) {
    // The endpoint is the reader's choice, so the rule is about transport, not about a named
    // vendor: https anywhere, plain http only on loopback where nothing leaves the machine.
    if (!isAllowedBaseUrl(config.baseUrl)) {
      problems.push(
        `API 地址必须是 https，或者本机（127.0.0.1 / localhost）的 http 地址，当前是 ${config.baseUrl}`,
      );
    }
    if (!isValidModelName(config.model)) {
      problems.push(`模型名称无效或缺失：${config.model === '' ? '（空）' : config.model}`);
    }
  }
  // A short desktop credential is not a credential. The shell generates 32 random bytes; this
  // bound refuses a hand-written placeholder rather than accepting it as protection.
  if (config.sessionToken !== '' && config.sessionToken.length < 32) {
    problems.push('AI_SESSION_TOKEN 至少需要 32 个字符；桌面会话凭据由桌面壳随机生成。');
  }
  for (const origin of config.allowedOrigins) {
    // Desktop webviews are not all http(s): Linux/macOS Tauri serves the page from the
    // custom `tauri://localhost` scheme. The rule is a scheme plus a host, not http only.
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/]+$/i.test(origin))
      problems.push(`AI_ALLOWED_ORIGINS 里的 ${origin} 不是来源`);
  }
  return problems;
}

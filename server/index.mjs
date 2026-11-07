/**
 * The local AI service.
 *
 * Its whole job is to keep the API key off the browser and the paper text off the network
 * except for the calls the reader explicitly asked for. Consequently:
 *
 * - it listens on 127.0.0.1 only (see `config.mjs`: not configurable);
 * - it serves only the four known paths and forwards nothing;
 * - the provider, the base URL and the model come from the environment, never the request;
 * - every request is bounded in size, rate and concurrency before it can cost anything;
 * - the response is JSON, and nothing in it is ever served as HTML.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DEFAULT_BUDGET, LIMITS } from './config.mjs';
import { verifyAnswer } from './citations.mjs';
import {
  DIFFICULTY_RULES_VERSION,
  buildDifficultyMessages,
  normalizeDifficultyRequest,
  verifySuggestions,
} from './difficulties.mjs';
import {
  buildKnowledgeMessages,
  normalizeKnowledgeRequest,
  verifyKnowledgeSuggestions,
} from './knowledge.mjs';
import { ProviderError } from './errors.mjs';
import { tokenCount } from './tokenUsage.mjs';
import {
  BodyTooLarge,
  ConcurrencyGate,
  RateLimiter,
  checkHost,
  checkMethod,
  checkOrigin,
  checkPath,
  checkSessionToken,
  readJsonBody,
  sendJson,
} from './guards.mjs';
import { buildMessages, normalizeAskRequest } from './prompt.mjs';
import { createProvider } from './providers/index.mjs';
import { createLogger } from './log.mjs';
import { describePrice, estimateCostCny } from './pricing.mjs';

/** CJK and full-width characters, which tokenizers treat at roughly one token each. */
const WIDE_CHAR = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu;

/**
 * A pessimistic input estimate, in tokens, used only for the *upper bound* a call may consume.
 *
 * The two scripts are not interchangeable: CJK is roughly one token per character, while Latin
 * text is about one per three and a half. A single `chars / 2` was above Latin and below CJK —
 * it refused long Latin documents that would have fitted, and under-reserved Chinese ones. The
 * fixed allowance covers the message framing.
 */
export function estimatePromptTokens(text) {
  const wide = text.match(WIDE_CHAR)?.length ?? 0;
  return 400 + wide + Math.ceil((text.length - wide) / 3.5);
}

function promptText(system, messages) {
  return system + messages.map((message) => message.content ?? '').join('');
}

/** Headers a browser needs before it will let the page read our reply, for allowed origins only. */
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function createAiServer({
  config,
  provider,
  log = createLogger({ enabled: config.logRequests }),
}) {
  const chosen = provider ?? createProvider(config);
  // A provider may state that it cannot reach a network even when it is not the mock (the
  // Phase 8.2 replay provider does exactly that). An absent field keeps the old rule.
  const online = chosen.online ?? chosen.name !== 'mock';
  const limiter = new RateLimiter(LIMITS.requestsPerMinute);
  const gate = new ConcurrencyGate(LIMITS.concurrentRequests);

  /**
   * Session accounting for the cost controls.
   *
   * This is in-memory on purpose: a sidecar restart is a new session and resets both the
   * counters and the budget. That makes "restart the service" the explicit way to start over,
   * rather than a budget that silently rolls over.
   *
   * `requests` counts attempts, including failed ones — a loop that keeps failing must still run
   * out. Token totals come from the provider's own `usage`; when it reports none, the preflight
   * upper bound is recorded instead and `exactTokens` becomes false, so the interface can say
   * the figure is conservative rather than exact.
   */
  const budget = config.budget ?? { ...DEFAULT_BUDGET };
  const usage = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    estimatedCostCny: 0,
    costKnown: true,
    unknownCostRequests: 0,
    exactTokens: true,
    /** Calls whose token figures include a conservative estimate rather than a reported usage. */
    estimatedRequests: 0,
  };
  let reservedTokens = 0;

  function usedTokens() {
    return usage.promptTokens + usage.completionTokens;
  }

  function usageSnapshot() {
    return {
      requests: usage.requests,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usedTokens(),
      estimatedCostCny: Number(usage.estimatedCostCny.toFixed(4)),
      costKnown: usage.costKnown,
      unknownCostRequests: usage.unknownCostRequests,
      exactTokens: usage.exactTokens,
      estimatedRequests: usage.estimatedRequests,
    };
  }

  /**
   * Checks the paid budget and reserves the upper bound for one call.
   *
   * The reservation is what makes concurrent requests safe: four requests that each fit the
   * remaining budget individually must not all pass and then collectively overspend. It is
   * released when the call provably never reached the provider and settled otherwise.
   */
  function reserveBudget({ prompt, maxTokens }) {
    const promptBound = estimatePromptTokens(prompt);
    const bound = promptBound + maxTokens;
    if (online && usage.requests >= budget.requests) {
      return {
        ok: false,
        message: `本次会话的在线请求次数已达上限（${String(usage.requests)}/${String(budget.requests)}）。可以在桌面「AI 设置」里调整上限，或重启 AI 服务开始新的会话。`,
      };
    }
    if (online && usedTokens() + reservedTokens + bound > budget.tokensPerSession) {
      return {
        ok: false,
        message: `本次会话的在线 token 预算不足：已用 ${String(usedTokens())}，本次最多还需 ${String(bound)}，上限 ${String(budget.tokensPerSession)}。可以在桌面「AI 设置」里调整上限，或重启 AI 服务开始新的会话。`,
      };
    }
    usage.requests += 1;
    reservedTokens += bound;
    return { ok: true, bound, promptBound, maxTokens };
  }

  function settleBudget(reservation, reported) {
    reservedTokens = Math.max(0, reservedTokens - reservation.bound);
    // The offline provider has no bill. Its requests are counted above, but it must not appear
    // in a paid-token or cost total.
    if (!online) return;

    const prompt = tokenCount(reported?.promptTokens);
    const completion = tokenCount(reported?.completionTokens);
    const reasoning = tokenCount(reported?.reasoningTokens);
    const cached = tokenCount(reported?.cachedPromptTokens);

    const promptKnown = prompt !== null;
    const completionKnown = completion !== null;
    if (!promptKnown || !completionKnown) {
      usage.exactTokens = false;
      usage.estimatedRequests += 1;
    }

    // Charge what was reported. Anything missing is charged at the reservation's own upper
    // bound, never at zero: the call was sent, so the local budget cannot assume it was free.
    const promptCharge = promptKnown ? prompt : reservation.promptBound;
    const completionCharge = completionKnown ? completion : reservation.maxTokens;
    usage.promptTokens += promptCharge;
    usage.completionTokens += completionCharge;
    if (reasoning !== null) usage.reasoningTokens += reasoning;

    const cost = estimateCostCny(chosen.model, {
      promptTokens: promptCharge,
      completionTokens: completionCharge,
      cachedPromptTokens: cached,
    });
    if (cost === null) {
      usage.costKnown = false;
      usage.unknownCostRequests += 1;
    } else {
      usage.estimatedCostCny += cost;
    }
  }

  function releaseBudget(reservation) {
    reservedTokens = Math.max(0, reservedTokens - reservation.bound);
  }

  /**
   * Ends a reservation that produced no result.
   *
   * - Nothing was sent (`requestSent === false`): the call was free, so the reservation is
   *   released and nothing is recorded.
   * - Anything else is unknown: the provider may have generated tokens even though this service
   *   has no usage. The reserved upper bound is charged and marked as an estimate. That is
   *   conservative bookkeeping, not a claim about the provider's invoice.
   */
  function abandonBudget(reservation, error) {
    if (error?.requestSent === false) {
      releaseBudget(reservation);
      return;
    }
    settleBudget(reservation, null);
  }

  function maxTokensForCall() {
    return online
      ? Math.min(config.answerTokens ?? LIMITS.answerTokens, budget.tokensPerRequest)
      : (config.answerTokens ?? LIMITS.answerTokens);
  }

  /**
   * Identifies *this process*, not this build.
   *
   * Phase 5 ended with two questions going to a service nobody meant to talk to. A port being
   * answered on is not evidence that it is the process a test started, so every service now
   * says which run it belongs to and the verification scripts pin it.
   */
  const instanceId = randomUUID();

  const health = {
    ok: true,
    instanceId,
    startedAt: new Date().toISOString(),
    provider: chosen.name,
    label: chosen.label,
    model: chosen.model,
    /** Echoed only in the desktop build, so the shell can pin the process it started. */
    ...(config.desktopInstance ? { desktopInstance: config.desktopInstance } : {}),
    /** What the call will spend, in the provider's own terms; null for the offline provider. */
    reasoning: chosen.reasoning ?? null,
    /** True when a call reaches a paid service. The interface says so before anything is sent. */
    online,
    /** The session caps the interface shows and the service enforces. Reset on restart. */
    budget: { ...budget },
    /** The basis of the cost estimate, or an explicit statement that there is none. */
    pricing: describePrice(chosen.model),
    limits: {
      passages: LIMITS.passages,
      passageChars: LIMITS.passageChars,
      totalContextChars: LIMITS.totalContextChars,
      questionChars: LIMITS.questionChars,
      requestsPerMinute: LIMITS.requestsPerMinute,
      // Reported so a live run can record, in its own evidence, which ceiling produced the
      // result — and so a stale process cannot silently keep using the old one.
      answerTokens: maxTokensForCall(),
      knowledgePassages: LIMITS.knowledgePassages,
      knowledgeContextChars: LIMITS.knowledgeContextChars,
      knowledgePages: LIMITS.knowledgePages,
    },
  };

  /** The request lifetime is shared; task validation and response formats stay below. */
  async function handleModelRequest(request, response, errorMessage, perform) {
    const started = Date.now();
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const logRequest = (entry) =>
      log.request({ method: 'POST', path, ms: Date.now() - started, ...entry });
    if (!limiter.take().ok) {
      sendJson(response, 429, {
        error: 'rate-limit',
        message: '本地服务一分钟内的请求次数已达上限，请稍后再试。',
      });
      logRequest({ status: 429 });
      return;
    }
    if (!gate.tryEnter()) {
      sendJson(response, 429, { error: 'busy', message: '同时进行的模型请求太多，请稍后再试。' });
      logRequest({ status: 429 });
      return;
    }

    const controller = new AbortController();
    const disconnected = () => controller.signal.aborted || response.destroyed;
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.on('close', onClose);

    // Only this block owns a reservation. A sent/unknown failure is conservatively charged;
    // requestSent === false releases it. Success settles reported usage even after disconnect.
    const complete = async (options) => {
      const maxTokens = maxTokensForCall();
      const reservation = reserveBudget({
        prompt: promptText(options.system, options.messages),
        maxTokens,
      });
      if (!reservation.ok) {
        sendJson(response, 429, { error: 'budget-exceeded', message: reservation.message });
        logRequest({ status: 429, provider: chosen.name });
        return null;
      }
      let outcome;
      try {
        if (disconnected()) {
          throw new ProviderError('network', '请求已取消。', { requestSent: false });
        }
        outcome = await chosen.complete({ ...options, maxTokens, signal: controller.signal });
      } catch (error) {
        abandonBudget(reservation, error);
        throw error;
      }
      settleBudget(reservation, outcome.usage);
      if (disconnected()) {
        logRequest({ status: 499 });
        return null;
      }
      return outcome;
    };

    try {
      let body;
      try {
        body = await readJsonBody(request, LIMITS.bodyBytes);
      } catch (error) {
        const tooLarge = error instanceof BodyTooLarge;
        if (disconnected() || (!tooLarge && !request.complete)) {
          logRequest({ status: 499 });
          return;
        }
        const status = tooLarge ? 413 : 400;
        const message = tooLarge ? error.message : '请求体不是合法 JSON。';
        sendJson(response, status, { error: 'bad-request', message });
        logRequest({ status });
        return;
      }
      await perform({ body, complete, logRequest });
    } catch (error) {
      if (disconnected() && !response.writableEnded) {
        logRequest({ status: 499 });
        return;
      }
      const isProvider = error instanceof ProviderError;
      const code = isProvider ? error.code : 'upstream';
      const message = isProvider ? error.message : errorMessage;
      const status = code === 'timeout' ? 504 : code === 'rate-limit' ? 429 : 502;
      if (!response.writableEnded) sendJson(response, status, { error: code, message });
      logRequest({ status, provider: chosen.name, model: chosen.model });
    } finally {
      response.removeListener('close', onClose);
      gate.leave();
    }
  }

  function handleAsk(request, response) {
    return handleModelRequest(
      request,
      response,
      '本地服务处理这次请求时出错了，没有发送任何论文内容。',
      async ({ body, complete, logRequest }) => {
        const normalized = normalizeAskRequest(body);
        if (!normalized.ok) {
          sendJson(response, 400, { error: 'bad-request', message: normalized.message });
          logRequest({ status: 400 });
          return;
        }
        const ask = normalized.value;
        const { system, messages } = buildMessages(ask);
        const chars = ask.passages.reduce((sum, passage) => sum + passage.text.length, 0);
        const outcome = await complete({
          system,
          messages,
          meta: { mode: ask.mode, question: ask.question, passages: ask.passages },
        });
        if (outcome === null) return;

        const verified = verifyAnswer(outcome.text, ask.passages, { truncated: outcome.truncated });
        const payload = {
          provider: chosen.name,
          providerLabel: chosen.label,
          model: chosen.model,
          online,
          mode: ask.mode,
          /**
           * How the reply came back, in one word. The interface shows different things for a
           * reply that followed the contract, one that had to be recovered, one that is cut off,
           * and one that could not be read — and it never shows the protocol text itself.
           */
          status: verified.status,
          answer: verified.answer,
          groundedInText: verified.groundedInText,
          citations: verified.citations,
          warnings: verified.warnings,
          /**
           * Numbers and enums only: lengths, counts, the provider's own stop reason. Not the
           * prompt, not the reply, not anything that came out of the paper. The panel shows these
           * only when the reader asks to see them.
           */
          diagnostics: {
            ...verified.diagnostics,
            finishReason: typeof outcome.finishReason === 'string' ? outcome.finishReason : null,
            truncated: outcome.truncated === true,
          },
          usage: outcome.usage ?? null,
        };
        sendJson(response, 200, payload);
        logRequest({
          status: 200,
          provider: chosen.name,
          model: chosen.model,
          passages: ask.passages.length,
          chars,
          outputStatus: verified.status,
          citations: verified.citations.length,
          rejectedCitations: verified.diagnostics.citationsRejected,
          finishReason: payload.diagnostics.finishReason,
        });
      },
    );
  }

  function handleDifficulties(request, response) {
    return handleModelRequest(
      request,
      response,
      '本地服务分析这一页时出错了，没有发送其它页面的内容。',
      async ({ body, complete, logRequest }) => {
        const normalized = normalizeDifficultyRequest(body);
        if (!normalized.ok) {
          sendJson(response, 400, { error: 'bad-request', message: normalized.message });
          logRequest({ status: 400 });
          return;
        }
        const page = normalized.value;
        const { system, messages } = buildDifficultyMessages(page);
        const outcome = await complete({
          system,
          messages,
          meta: {
            task: 'difficulty',
            title: page.paper.title,
            page: page.paper.page,
            pageText: page.pageText,
          },
        });
        if (outcome === null) return;

        const verified = verifySuggestions(outcome.text, page.pageText);
        sendJson(response, 200, {
          provider: chosen.name,
          providerLabel: chosen.label,
          model: chosen.model,
          online,
          page: page.paper.page,
          rulesVersion: DIFFICULTY_RULES_VERSION,
          status: verified.status,
          suggestions: verified.suggestions,
          rejected: verified.diagnostics.rejected,
          diagnostics: verified.diagnostics,
          usage: outcome.usage ?? null,
        });
        logRequest({
          status: 200,
          provider: chosen.name,
          model: chosen.model,
          page: page.paper.page,
          chars: page.pageText.length,
          outputStatus: verified.status,
          suggestions: verified.suggestions.length,
          rejectedSuggestions: verified.diagnostics.rejected,
        });
      },
    );
  }

  function handleKnowledge(request, response) {
    return handleModelRequest(
      request,
      response,
      '本地服务分析知识关联时出错了，没有发送其它页面的内容。',
      async ({ body, complete, logRequest }) => {
        const normalized = normalizeKnowledgeRequest(body);
        if (!normalized.ok) {
          sendJson(response, 400, { error: 'bad-request', message: normalized.message });
          logRequest({ status: 400 });
          return;
        }
        const knowledgeRequest = normalized.value;
        const { system, messages } = buildKnowledgeMessages(knowledgeRequest);
        const outcome = await complete({
          system,
          messages,
          // Classification, not prose: no deliberate sampling variety. Still checked line by line.
          temperature: 0,
          meta: {
            task: 'knowledge',
            paper: knowledgeRequest.paper,
            focus: knowledgeRequest.focus,
            passages: knowledgeRequest.passages,
            existingConcepts: knowledgeRequest.existingConcepts,
            existingRelations: knowledgeRequest.existingRelations,
          },
        });
        if (outcome === null) return;

        const verified = verifyKnowledgeSuggestions(outcome.text, knowledgeRequest, {
          truncated: outcome.truncated === true,
        });
        const payload = {
          provider: chosen.name,
          providerLabel: chosen.label,
          model: chosen.model,
          online,
          rulesVersion: verified.rulesVersion,
          status: verified.status,
          groundedInText: verified.groundedInText,
          concepts: verified.concepts,
          relations: verified.relations,
          rejected: verified.rejected,
          rejectedDetails: verified.rejectedDetails,
          warnings: verified.warnings,
          diagnostics: {
            ...verified.diagnostics,
            finishReason: typeof outcome.finishReason === 'string' ? outcome.finishReason : null,
          },
          usage: outcome.usage ?? null,
        };
        sendJson(response, 200, payload);
        logRequest({
          status: 200,
          provider: chosen.name,
          model: chosen.model,
          pages: new Set(knowledgeRequest.passages.map((passage) => passage.page)).size,
          chars: knowledgeRequest.passages.reduce((sum, passage) => sum + passage.text.length, 0),
          outputStatus: verified.status,
          concepts: verified.concepts.length,
          relations: verified.relations.length,
          rejected: verified.rejected,
        });
      },
    );
  }

  const server = createServer((request, response) => {
    const origin = request.headers.origin;

    const host = checkHost(request.headers.host);
    if (!host.ok) {
      sendJson(response, host.status, { error: 'forbidden-host', message: host.message });
      return;
    }
    const originCheck = checkOrigin(origin, config.allowedOrigins);
    if (!originCheck.ok) {
      sendJson(response, originCheck.status, {
        error: 'forbidden-origin',
        message: originCheck.message,
      });
      return;
    }

    // Emit the CORS headers as soon as the origin is accepted, so the desktop webview can read
    // an authentication failure (401) instead of seeing an opaque network error. A foreign
    // origin never reaches this point, so this does not widen what a page may read.
    if (typeof origin === 'string' && origin !== '') {
      for (const [name, value] of Object.entries(corsHeaders(origin)))
        response.setHeader(name, value);
    }

    let url;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      // A malformed request target is untrusted input, not a fatal process exception.
      sendJson(response, 400, { error: 'invalid-target', message: '请求地址格式不正确。' });
      return;
    }
    const pathCheck = checkPath(url.pathname);
    if (!pathCheck.ok) {
      sendJson(response, pathCheck.status, { error: 'not-found', message: pathCheck.message });
      return;
    }

    // Preflight is answered only for origins that already passed the check above.
    if (request.method === 'OPTIONS') {
      response.writeHead(204, typeof origin === 'string' ? corsHeaders(origin) : {});
      response.end();
      return;
    }

    // The desktop credential covers every real request, health included. Preflight above is
    // deliberately exempt: a browser does not attach Authorization to it.
    const session = checkSessionToken(request.headers.authorization, config.sessionToken);
    if (!session.ok) {
      sendJson(response, session.status, { error: 'unauthorized', message: session.message });
      return;
    }

    const methodCheck = checkMethod(request.method, url.pathname);
    if (!methodCheck.ok) {
      sendJson(response, methodCheck.status, {
        error: 'method-not-allowed',
        message: methodCheck.message,
      });
      return;
    }

    if (url.pathname === '/api/ai/health') {
      // Budget usage changes with every call, so it is read at request time rather than baked
      // into the startup snapshot.
      sendJson(response, 200, { ...health, usage: usageSnapshot() });
      return;
    }

    if (url.pathname === '/api/ai/difficulties') {
      void handleDifficulties(request, response);
      return;
    }

    if (url.pathname === '/api/ai/knowledge') {
      void handleKnowledge(request, response);
      return;
    }

    void handleAsk(request, response);
  });

  /** Keeps a stalled client from holding a socket forever. */
  server.headersTimeout = config.timeoutMs + 10_000;
  server.requestTimeout = config.timeoutMs + 20_000;

  return { server, health };
}

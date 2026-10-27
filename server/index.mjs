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
    };
  }

  /**
   * Checks the paid budget and reserves the upper bound for one call.
   *
   * The reservation is what makes concurrent requests safe: four requests that each fit the
   * remaining budget individually must not all pass and then collectively overspend. It is
   * released when the call fails and settled with the reported usage when it succeeds.
   */
  function reserveBudget({ prompt, maxTokens }) {
    const bound = estimatePromptTokens(prompt) + maxTokens;
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
    return { ok: true, bound };
  }

  function settleBudget(reservation, reported) {
    reservedTokens = Math.max(0, reservedTokens - reservation.bound);
    const prompt = typeof reported?.promptTokens === 'number' ? reported.promptTokens : null;
    const completion =
      typeof reported?.completionTokens === 'number' ? reported.completionTokens : null;
    const reasoning =
      typeof reported?.reasoningTokens === 'number' ? reported.reasoningTokens : null;
    const cached =
      typeof reported?.cachedPromptTokens === 'number' ? reported.cachedPromptTokens : null;

    if (prompt === null && completion === null) {
      // The provider did not report usage. Record the upper bound instead of zero, so the
      // session budget cannot be bypassed by a provider that omits its accounting.
      usage.promptTokens += reservation.bound;
      usage.exactTokens = false;
    } else {
      usage.promptTokens += prompt ?? 0;
      usage.completionTokens += completion ?? 0;
      if (reasoning !== null) usage.reasoningTokens += reasoning;
      if (prompt === null || completion === null) usage.exactTokens = false;
    }

    const cost = estimateCostCny(chosen.model, {
      promptTokens: prompt ?? reservation.bound,
      completionTokens: completion ?? 0,
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

  async function handleAsk(request, response, origin) {
    const started = Date.now();
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    const allowed = limiter.take();
    if (!allowed.ok) {
      sendJson(response, 429, {
        error: 'rate-limit',
        message: '本地服务一分钟内的请求次数已达上限，请稍后再试。',
      });
      log.request({ method: 'POST', path: url.pathname, status: 429, ms: Date.now() - started });
      return;
    }
    if (!gate.tryEnter()) {
      sendJson(response, 429, { error: 'busy', message: '同时进行的模型请求太多，请稍后再试。' });
      log.request({ method: 'POST', path: url.pathname, status: 429, ms: Date.now() - started });
      return;
    }

    const controller = new AbortController();
    // If the reader closes the page or presses stop, the upstream call goes with it.
    response.on('close', () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      let body;
      try {
        body = await readJsonBody(request, LIMITS.bodyBytes);
      } catch (error) {
        // A body over the cap is a 413; a body that is not JSON is the caller's mistake (400).
        const tooLarge = error instanceof BodyTooLarge;
        // A client that closed the connection cannot receive a reply, and writing to it would
        // be a wasted attempt. An oversized body keeps its 413 while the client is still
        // connected and streaming, so the incomplete check excludes that case.
        const disconnected = controller.signal.aborted || response.destroyed;
        if (disconnected || (!tooLarge && !request.complete)) {
          log.request({
            method: 'POST',
            path: url.pathname,
            status: 499,
            ms: Date.now() - started,
          });
          return;
        }
        const status = tooLarge ? 413 : 400;
        const message = tooLarge ? error.message : '请求体不是合法 JSON。';
        sendJson(response, status, { error: 'bad-request', message });
        log.request({ method: 'POST', path: url.pathname, status, ms: Date.now() - started });
        return;
      }

      const normalized = normalizeAskRequest(body);
      if (!normalized.ok) {
        sendJson(response, 400, { error: 'bad-request', message: normalized.message });
        log.request({ method: 'POST', path: url.pathname, status: 400, ms: Date.now() - started });
        return;
      }
      const ask = normalized.value;
      const { system, messages } = buildMessages(ask);
      const chars = ask.passages.reduce((sum, passage) => sum + passage.text.length, 0);
      const maxTokens = maxTokensForCall();

      // The budget check happens before the call, with a pessimistic input estimate and the
      // generation ceiling, so a refusal is decided without spending anything.
      const reservation = reserveBudget({
        prompt: promptText(system, messages),
        maxTokens,
      });
      if (!reservation.ok) {
        sendJson(response, 429, { error: 'budget-exceeded', message: reservation.message });
        log.request({
          method: 'POST',
          path: url.pathname,
          status: 429,
          ms: Date.now() - started,
          provider: chosen.name,
        });
        return;
      }

      let outcome;
      try {
        // The caller can disappear while the body is parsed or the budget is reserved. Do not
        // start a model call for a caller that is already gone; this also covers providers
        // that do not inspect the signal themselves. The reservation is released by the catch.
        if (controller.signal.aborted) {
          throw new ProviderError('network', '请求已取消。');
        }
        outcome = await chosen.complete({
          system,
          messages,
          maxTokens,
          signal: controller.signal,
          meta: { mode: ask.mode, question: ask.question, passages: ask.passages },
        });
      } catch (error) {
        releaseBudget(reservation);
        throw error;
      }
      settleBudget(reservation, outcome.usage);

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
      log.request({
        method: 'POST',
        path: url.pathname,
        status: 200,
        ms: Date.now() - started,
        provider: chosen.name,
        model: chosen.model,
        passages: ask.passages.length,
        chars,
        outputStatus: verified.status,
        citations: verified.citations.length,
        rejectedCitations: verified.diagnostics.citationsRejected,
        finishReason: payload.diagnostics.finishReason,
      });
    } catch (error) {
      if (controller.signal.aborted && !response.writableEnded) {
        // The reader went away; there is nobody left to answer.
        log.request({ method: 'POST', path: url.pathname, status: 499, ms: Date.now() - started });
        return;
      }
      const isProvider = error instanceof ProviderError;
      const code = isProvider ? error.code : 'upstream';
      const message = isProvider
        ? error.message
        : '本地服务处理这次请求时出错了，没有发送任何论文内容。';
      const status =
        code === 'timeout' ? 504 : code === 'auth' ? 502 : code === 'rate-limit' ? 429 : 502;
      if (!response.writableEnded) sendJson(response, status, { error: code, message });
      log.request({
        method: 'POST',
        path: url.pathname,
        status,
        ms: Date.now() - started,
        provider: chosen.name,
        model: chosen.model,
      });
    } finally {
      gate.leave();
      void origin;
    }
  }

  /**
   * One page of the paper, analysed for the places worth understanding.
   *
   * Same guards as a question — rate, concurrency, body size, cancellation, no retries — and
   * the same rule about what may leave: one page, and only when the reader turned this on.
   */
  async function handleDifficulties(request, response) {
    const started = Date.now();
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    const allowed = limiter.take();
    if (!allowed.ok) {
      sendJson(response, 429, {
        error: 'rate-limit',
        message: '本地服务一分钟内的请求次数已达上限，请稍后再试。',
      });
      log.request({ method: 'POST', path: url.pathname, status: 429, ms: Date.now() - started });
      return;
    }
    if (!gate.tryEnter()) {
      sendJson(response, 429, { error: 'busy', message: '同时进行的模型请求太多，请稍后再试。' });
      log.request({ method: 'POST', path: url.pathname, status: 429, ms: Date.now() - started });
      return;
    }

    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      let body;
      try {
        body = await readJsonBody(request, LIMITS.bodyBytes);
      } catch (error) {
        const tooLarge = error instanceof BodyTooLarge;
        // A client that closed the connection cannot receive a reply, and writing to it would
        // be a wasted attempt. An oversized body keeps its 413 while the client is still
        // connected and streaming, so the incomplete check excludes that case.
        const disconnected = controller.signal.aborted || response.destroyed;
        if (disconnected || (!tooLarge && !request.complete)) {
          log.request({
            method: 'POST',
            path: url.pathname,
            status: 499,
            ms: Date.now() - started,
          });
          return;
        }
        const status = tooLarge ? 413 : 400;
        const message = tooLarge ? error.message : '请求体不是合法 JSON。';
        sendJson(response, status, { error: 'bad-request', message });
        log.request({ method: 'POST', path: url.pathname, status, ms: Date.now() - started });
        return;
      }

      const normalized = normalizeDifficultyRequest(body);
      if (!normalized.ok) {
        sendJson(response, 400, { error: 'bad-request', message: normalized.message });
        log.request({ method: 'POST', path: url.pathname, status: 400, ms: Date.now() - started });
        return;
      }
      const page = normalized.value;
      const { system, messages } = buildDifficultyMessages(page);
      const maxTokens = maxTokensForCall();

      const reservation = reserveBudget({
        prompt: promptText(system, messages),
        maxTokens,
      });
      if (!reservation.ok) {
        sendJson(response, 429, { error: 'budget-exceeded', message: reservation.message });
        log.request({
          method: 'POST',
          path: url.pathname,
          status: 429,
          ms: Date.now() - started,
          provider: chosen.name,
        });
        return;
      }

      let outcome;
      try {
        // The caller can disappear while the body is parsed or the budget is reserved. Do not
        // start a model call for a caller that is already gone; this also covers providers
        // that do not inspect the signal themselves. The reservation is released by the catch.
        if (controller.signal.aborted) {
          throw new ProviderError('network', '请求已取消。');
        }
        outcome = await chosen.complete({
          system,
          messages,
          maxTokens,
          signal: controller.signal,
          meta: {
            task: 'difficulty',
            title: page.paper.title,
            page: page.paper.page,
            pageText: page.pageText,
          },
        });
      } catch (error) {
        releaseBudget(reservation);
        throw error;
      }
      settleBudget(reservation, outcome.usage);

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
      log.request({
        method: 'POST',
        path: url.pathname,
        status: 200,
        ms: Date.now() - started,
        provider: chosen.name,
        model: chosen.model,
        page: page.paper.page,
        chars: page.pageText.length,
        outputStatus: verified.status,
        suggestions: verified.suggestions.length,
        rejectedSuggestions: verified.diagnostics.rejected,
      });
    } catch (error) {
      if (controller.signal.aborted && !response.writableEnded) {
        log.request({ method: 'POST', path: url.pathname, status: 499, ms: Date.now() - started });
        return;
      }
      const isProvider = error instanceof ProviderError;
      const code = isProvider ? error.code : 'upstream';
      const message = isProvider
        ? error.message
        : '本地服务分析这一页时出错了，没有发送其它页面的内容。';
      const status =
        code === 'timeout' ? 504 : code === 'auth' ? 502 : code === 'rate-limit' ? 429 : 502;
      if (!response.writableEnded) sendJson(response, status, { error: code, message });
      log.request({
        method: 'POST',
        path: url.pathname,
        status,
        ms: Date.now() - started,
        provider: chosen.name,
        model: chosen.model,
      });
    } finally {
      gate.leave();
    }
  }

  /**
   * A bounded set of passages, analysed for concepts and the relations between them.
   *
   * Same guards as every other endpoint — rate, concurrency, body size, cancellation, no
   * retries — and the same rule about what may leave: only the passages the reader's own
   * context plan listed, never the whole paper.
   */
  async function handleKnowledge(request, response) {
    const started = Date.now();
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    const allowed = limiter.take();
    if (!allowed.ok) {
      sendJson(response, 429, {
        error: 'rate-limit',
        message: '本地服务一分钟内的请求次数已达上限，请稍后再试。',
      });
      log.request({ method: 'POST', path: url.pathname, status: 429, ms: Date.now() - started });
      return;
    }
    if (!gate.tryEnter()) {
      sendJson(response, 429, { error: 'busy', message: '同时进行的模型请求太多，请稍后再试。' });
      log.request({ method: 'POST', path: url.pathname, status: 429, ms: Date.now() - started });
      return;
    }

    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      let body;
      try {
        body = await readJsonBody(request, LIMITS.bodyBytes);
      } catch (error) {
        const tooLarge = error instanceof BodyTooLarge;
        // A client that closed the connection cannot receive a reply, and writing to it would
        // be a wasted attempt. An oversized body keeps its 413 while the client is still
        // connected and streaming, so the incomplete check excludes that case.
        const disconnected = controller.signal.aborted || response.destroyed;
        if (disconnected || (!tooLarge && !request.complete)) {
          log.request({
            method: 'POST',
            path: url.pathname,
            status: 499,
            ms: Date.now() - started,
          });
          return;
        }
        const status = tooLarge ? 413 : 400;
        const message = tooLarge ? error.message : '请求体不是合法 JSON。';
        sendJson(response, status, { error: 'bad-request', message });
        log.request({ method: 'POST', path: url.pathname, status, ms: Date.now() - started });
        return;
      }

      const normalized = normalizeKnowledgeRequest(body);
      if (!normalized.ok) {
        sendJson(response, 400, { error: 'bad-request', message: normalized.message });
        log.request({ method: 'POST', path: url.pathname, status: 400, ms: Date.now() - started });
        return;
      }
      const knowledgeRequest = normalized.value;
      const { system, messages } = buildKnowledgeMessages(knowledgeRequest);
      const maxTokens = maxTokensForCall();

      const reservation = reserveBudget({
        prompt: promptText(system, messages),
        maxTokens,
      });
      if (!reservation.ok) {
        sendJson(response, 429, { error: 'budget-exceeded', message: reservation.message });
        log.request({
          method: 'POST',
          path: url.pathname,
          status: 429,
          ms: Date.now() - started,
          provider: chosen.name,
        });
        return;
      }

      let outcome;
      try {
        // The caller can disappear while the body is parsed or the budget is reserved. Do not
        // start a model call for a caller that is already gone; this also covers providers
        // that do not inspect the signal themselves. The reservation is released by the catch.
        if (controller.signal.aborted) {
          throw new ProviderError('network', '请求已取消。');
        }
        outcome = await chosen.complete({
          system,
          messages,
          maxTokens,
          signal: controller.signal,
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
      } catch (error) {
        releaseBudget(reservation);
        throw error;
      }
      settleBudget(reservation, outcome.usage);

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
      log.request({
        method: 'POST',
        path: url.pathname,
        status: 200,
        ms: Date.now() - started,
        provider: chosen.name,
        model: chosen.model,
        pages: new Set(knowledgeRequest.passages.map((passage) => passage.page)).size,
        chars: knowledgeRequest.passages.reduce((sum, passage) => sum + passage.text.length, 0),
        outputStatus: verified.status,
        concepts: verified.concepts.length,
        relations: verified.relations.length,
        rejected: verified.rejected,
      });
    } catch (error) {
      if (controller.signal.aborted && !response.writableEnded) {
        log.request({ method: 'POST', path: url.pathname, status: 499, ms: Date.now() - started });
        return;
      }
      const isProvider = error instanceof ProviderError;
      const code = isProvider ? error.code : 'upstream';
      const message = isProvider
        ? error.message
        : '本地服务分析知识关联时出错了，没有发送其它页面的内容。';
      const status =
        code === 'timeout' ? 504 : code === 'auth' ? 502 : code === 'rate-limit' ? 429 : 502;
      if (!response.writableEnded) sendJson(response, status, { error: code, message });
      log.request({
        method: 'POST',
        path: url.pathname,
        status,
        ms: Date.now() - started,
        provider: chosen.name,
        model: chosen.model,
      });
    } finally {
      gate.leave();
    }
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
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

    void handleAsk(request, response, origin);
  });

  /** Keeps a stalled client from holding a socket forever. */
  server.headersTimeout = config.timeoutMs + 10_000;
  server.requestTimeout = config.timeoutMs + 20_000;

  return { server, health };
}

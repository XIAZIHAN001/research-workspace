/**
 * The local AI service.
 *
 * Its whole job is to keep the API key off the browser and the paper text off the network
 * except for the one call the reader asked for. Consequently:
 *
 * - it listens on 127.0.0.1 only (see `config.mjs`: not configurable);
 * - it serves exactly two paths and forwards nothing;
 * - the provider, the base URL and the model come from the environment, never the request;
 * - every request is bounded in size, rate and concurrency before it can cost anything;
 * - the response is JSON, and nothing in it is ever served as HTML.
 */

import { createServer } from 'node:http';
import { LIMITS } from './config.mjs';
import { verifyAnswer } from './citations.mjs';
import {
  DIFFICULTY_RULES_VERSION,
  buildDifficultyMessages,
  normalizeDifficultyRequest,
  verifySuggestions,
} from './difficulties.mjs';
import { ProviderError } from './errors.mjs';
import {
  BodyTooLarge,
  ConcurrencyGate,
  RateLimiter,
  checkHost,
  checkMethod,
  checkOrigin,
  checkPath,
  readJsonBody,
  sendJson,
} from './guards.mjs';
import { buildMessages, normalizeAskRequest } from './prompt.mjs';
import { createProvider } from './providers/index.mjs';
import { createLogger } from './log.mjs';

/** Headers a browser needs before it will let the page read our reply, for allowed origins only. */
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
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
  const limiter = new RateLimiter(LIMITS.requestsPerMinute);
  const gate = new ConcurrencyGate(LIMITS.concurrentRequests);

  const health = {
    ok: true,
    provider: chosen.name,
    label: chosen.label,
    model: chosen.model,
    /** What the call will spend, in the provider's own terms; null for the offline provider. */
    reasoning: chosen.reasoning ?? null,
    /** True when a call reaches a paid service. The interface says so before anything is sent. */
    online: chosen.name !== 'mock',
    limits: {
      passages: LIMITS.passages,
      passageChars: LIMITS.passageChars,
      totalContextChars: LIMITS.totalContextChars,
      questionChars: LIMITS.questionChars,
      requestsPerMinute: LIMITS.requestsPerMinute,
      // Reported so a live run can record, in its own evidence, which ceiling produced the
      // result — and so a stale process cannot silently keep using the old one.
      answerTokens: config.answerTokens ?? LIMITS.answerTokens,
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

      const outcome = await chosen.complete({
        system,
        messages,
        maxTokens: config.answerTokens ?? LIMITS.answerTokens,
        signal: controller.signal,
        meta: { mode: ask.mode, question: ask.question, passages: ask.passages },
      });

      const verified = verifyAnswer(outcome.text, ask.passages, { truncated: outcome.truncated });
      const payload = {
        provider: chosen.name,
        providerLabel: chosen.label,
        model: chosen.model,
        online: chosen.name !== 'mock',
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

      const outcome = await chosen.complete({
        system,
        messages,
        maxTokens: config.answerTokens ?? LIMITS.answerTokens,
        signal: controller.signal,
        meta: {
          task: 'difficulty',
          title: page.paper.title,
          page: page.paper.page,
          pageText: page.pageText,
        },
      });

      const verified = verifySuggestions(outcome.text, page.pageText);
      sendJson(response, 200, {
        provider: chosen.name,
        providerLabel: chosen.label,
        model: chosen.model,
        online: chosen.name !== 'mock',
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

    const methodCheck = checkMethod(request.method, url.pathname);
    if (!methodCheck.ok) {
      sendJson(response, methodCheck.status, {
        error: 'method-not-allowed',
        message: methodCheck.message,
      });
      return;
    }

    if (typeof origin === 'string' && origin !== '') {
      for (const [name, value] of Object.entries(corsHeaders(origin)))
        response.setHeader(name, value);
    }

    if (url.pathname === '/api/ai/health') {
      sendJson(response, 200, health);
      return;
    }

    if (url.pathname === '/api/ai/difficulties') {
      void handleDifficulties(request, response);
      return;
    }

    void handleAsk(request, response, origin);
  });

  /** Keeps a stalled client from holding a socket forever. */
  server.headersTimeout = config.timeoutMs + 10_000;
  server.requestTimeout = config.timeoutMs + 20_000;

  return { server, health };
}

/**
 * The adapter for an OpenAI-compatible chat-completions endpoint.
 *
 * It speaks the contract every provider in the settings list documents
 * (`POST {base}/chat/completions`, `Authorization: Bearer …`, `choices[0].message.content`), with
 * two rules kept from the DeepSeek-only version:
 *
 * - It never reads the request for a URL, a model or a credential. Everything comes from the
 *   process environment, so a page cannot redirect the call or spend another account's credit.
 * - It never puts the key, the prompt or the response body into an error message, a log line or
 *   a thrown value. Failures carry a status code and a category, nothing else.
 *
 * It never retries. A failed call is reported; asking again is the reader's decision.
 *
 * What is deliberately *not* sent: `thinking` and `reasoning_effort`. Those are DeepSeek's own
 * parameters (see `deepseek.mjs`, which passes them in through `extraBody`). An unknown field is
 * rejected outright by several providers, so the generic adapter sends only the documented
 * chat-completions fields.
 */

import { ProviderError } from '../errors.mjs';

/**
 * Status codes mapped to what the reader should do next. `402` is a balance problem rather than
 * a rate limit: waiting does not fix it.
 */
const FAILURE_BY_STATUS = new Map([
  [400, 'invalid-request'],
  [401, 'auth'],
  [402, 'insufficient-balance'],
  [403, 'auth'],
  [422, 'invalid-request'],
  [429, 'rate-limit'],
  [500, 'upstream'],
  [502, 'upstream'],
  [503, 'upstream'],
]);

function categoryForStatus(status) {
  const known = FAILURE_BY_STATUS.get(status);
  if (known !== undefined) return known;
  return status >= 500 ? 'upstream' : 'invalid-request';
}

/** The documented reasons generation can stop early, i.e. the answer is not all there. */
const INCOMPLETE_REASONS = new Set(['length', 'insufficient_system_resource', 'aborted']);

/**
 * A finish_reason that explains itself, for the reader rather than for a log.
 *
 * `insufficient_system_resource` in particular is worth naming: it means the service ran out of
 * capacity part-way through, so the text may be cut off without looking like it.
 */
function incompleteMessage(reason, finishReason) {
  if (reason === 'length') {
    return '模型在写完回答之前就用完了生成预算。思考模式的推理过程占用同一份额度，可以在 server/README.md 里降低推理档位或提高上限。';
  }
  if (finishReason === 'insufficient_system_resource') {
    return '模型服务中途资源不足，这次回答可能不完整。';
  }
  return '模型服务中断了这次生成，回答可能不完整。';
}

export function createChatCompletionsProvider({
  id,
  label,
  apiKey,
  baseUrl,
  model,
  /** Parameters specific to the provider's dialect; empty for a plain compatible endpoint. */
  extraBody = {},
  /** Shown next to the cost warning; `null` when the provider has no thinking switch. */
  reasoning = null,
  timeoutMs = 60_000,
  fetchImpl = fetch,
}) {
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new ProviderError('config', `${label} 需要 API Key，但还没有配置。`);
  }

  return {
    name: id,
    model,
    label: `${label} ${model}`,
    reasoning,

    async complete({ system, messages, maxTokens, signal, temperature = 0.3 }) {
      // Temperature is per call. The knowledge path asks for 0: it is a classification task and
      // the reader is going to check every relation, so sampling variety buys nothing. 0 does not
      // make the service deterministic — batching and hardware can still change logits — it only
      // removes the deliberate sampling noise.
      const sampling =
        typeof temperature === 'number' &&
        Number.isFinite(temperature) &&
        temperature >= 0 &&
        temperature <= 2
          ? temperature
          : 0.3;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const relay = () => {
        controller.abort();
      };
      signal?.addEventListener('abort', relay, { once: true });

      let response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: system }, ...messages],
            max_tokens: maxTokens,
            temperature: sampling,
            stream: false,
            // Deliberately *not* `response_format: json_object`.
            //
            // The answer is plain text ending in a small JSON citation block (see `prompt.mjs`).
            // JSON mode would put the whole LaTeX-heavy answer back inside a JSON string, which
            // is the exact shape that failed on a real reply: the model escaped its own protocol
            // into `answer` and the envelope never closed. The one part that must be JSON is
            // small, and it is checked rather than trusted.
            ...extraBody,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        // The message of a fetch failure can contain the URL. Only the category is kept.
        void error;
        if (timedOut) {
          throw new ProviderError('timeout', `模型在 ${String(timeoutMs)} 毫秒内没有返回。`);
        }
        if (signal?.aborted === true) throw new ProviderError('network', '请求已取消。');
        throw new ProviderError('network', '连接不上模型服务，请检查网络或代理设置。');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', relay);
      }

      if (!response.ok) {
        // The body is read and discarded: it may quote the prompt back, and it is not needed.
        await response.arrayBuffer().catch(() => undefined);
        const category = categoryForStatus(response.status);
        const wording = {
          auth: '模型服务拒绝了这次请求（凭据无效或没有权限）。',
          'insufficient-balance': '模型服务账户余额不足，需要充值后才能继续。',
          'rate-limit': '模型服务表示频率或并发受限，请稍后重试。',
          'invalid-request': `模型服务认为这次请求的参数不合法（HTTP ${String(response.status)}），这是应用的配置问题。`,
          upstream: `模型服务返回了错误（HTTP ${String(response.status)}）。`,
          network: '连接模型服务失败。',
          timeout: '模型服务超时。',
          config: '模型服务配置有误。',
        }[category];
        throw new ProviderError(category, wording);
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new ProviderError('upstream', '模型服务返回的不是 JSON。');
      }

      const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
      // `reasoning_content` is the thinking, kept apart from the answer on purpose: it is not
      // the reply and must never be shown or parsed as one.
      const content = choice?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        if (finishReason !== null && INCOMPLETE_REASONS.has(finishReason)) {
          throw new ProviderError('incomplete', incompleteMessage('length', finishReason));
        }
        if (finishReason === 'content_filter') {
          throw new ProviderError('upstream', '模型服务的输出被内容策略拦截了，这次没有得到回答。');
        }
        throw new ProviderError('upstream', '模型服务返回的内容里没有可用的回答。');
      }

      const usage = payload?.usage;
      const details = usage?.completion_tokens_details;
      return {
        text: content,
        usage:
          usage === undefined || usage === null
            ? null
            : {
                promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
                completionTokens:
                  typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
                /** Present only in thinking mode; the part of the budget spent thinking. */
                reasoningTokens:
                  typeof details?.reasoning_tokens === 'number' ? details.reasoning_tokens : null,
                cachedPromptTokens:
                  typeof usage.prompt_cache_hit_tokens === 'number'
                    ? usage.prompt_cache_hit_tokens
                    : null,
              },
        // `length` is the documented way to learn the answer hit the token ceiling; the other
        // two mean the service stopped it for its own reasons, which also leaves it incomplete.
        truncated: finishReason !== null && INCOMPLETE_REASONS.has(finishReason),
        /** Why generation stopped, verbatim from the provider. Safe to record: an enum, no text. */
        finishReason,
        stopped: finishReason,
      };
    },
  };
}

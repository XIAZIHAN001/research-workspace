/**
 * The DeepSeek adapter.
 *
 * It speaks the documented OpenAI-compatible chat-completions contract
 * (`POST {base}/chat/completions`, `Authorization: Bearer …`, `choices[0].message.content`)
 * against the endpoints and model names published at api-docs.deepseek.com, checked when this
 * was written rather than carried over from memory.
 *
 * Two things it deliberately does not do:
 *
 * - It never reads the request for a URL, a model or a credential. Everything comes from the
 *   process environment, so a page cannot redirect the call or spend another account's credit.
 * - It never puts the key, the prompt or the response body into an error message, a log line or
 *   a thrown value. Failures carry a status code and a category, nothing else.
 *
 * This provider is only constructed when `AI_PROVIDER=deepseek` *and* a key is present. Running
 * the app does not enable it.
 */

import { ProviderError } from '../errors.mjs';

/** DeepSeek returns these on the error object; they are safe to pass along. */
const FAILURE_BY_STATUS = new Map([
  [400, 'upstream'],
  [401, 'auth'],
  [402, 'rate-limit'],
  [403, 'auth'],
  [422, 'upstream'],
  [429, 'rate-limit'],
  [500, 'upstream'],
  [502, 'upstream'],
  [503, 'upstream'],
]);

function categoryForStatus(status) {
  const known = FAILURE_BY_STATUS.get(status);
  if (known !== undefined) return known;
  return status >= 500 ? 'upstream' : 'upstream';
}

export function createDeepSeekProvider({
  apiKey,
  baseUrl,
  model,
  timeoutMs = 60_000,
  fetchImpl = fetch,
}) {
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new ProviderError('config', 'DeepSeek provider 需要 API Key，但环境变量里没有。');
  }

  return {
    name: 'deepseek',
    model,
    label: `DeepSeek ${model}`,

    async complete({ system, messages, maxTokens, signal }) {
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
            temperature: 0.3,
            stream: false,
            // The answer carries citations that have to be checked against the passages, so it
            // is requested as JSON. The prompt says so too, which this mode requires.
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        });
      } catch (error) {
        // The message of a fetch failure can contain the URL; the URL is fixed, so it is safe,
        // but it is not useful either, so only the category is kept.
        void error;
        if (timedOut)
          throw new ProviderError('timeout', `模型在 ${String(timeoutMs)} 毫秒内没有返回。`);
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
          'rate-limit': '模型服务表示额度或频率受限，请稍后重试。',
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
      const content = choice?.message?.content;
      if (typeof content !== 'string') {
        throw new ProviderError('upstream', '模型服务返回的内容里没有可用的回答。');
      }

      const usage = payload?.usage;
      return {
        text: content,
        usage:
          usage === undefined || usage === null
            ? null
            : {
                promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
                completionTokens:
                  typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
              },
        // `length` is the documented way to learn the answer hit the token ceiling.
        truncated: choice?.finish_reason === 'length',
      };
    },
  };
}

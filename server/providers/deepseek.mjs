/**
 * The DeepSeek dialect.
 *
 * DeepSeek's chat-completions endpoint is OpenAI-compatible, with one addition that matters here:
 * `thinking` and `reasoning_effort`. Upstream defaults thinking to *on* at effort `high`, and
 * reasoning tokens are spent from the same budget as the answer, so leaving the pair implicit
 * would make an answer's length depend on someone else's default. Both are therefore sent
 * explicitly, and only for this provider — the generic adapter omits them.
 *
 * Everything else (request shape, error mapping, no retries, no key or prompt in messages) is
 * shared with the other compatible providers in `openaiCompatible.mjs`.
 *
 * This provider is only constructed when `AI_PROVIDER=deepseek` *and* a key is present. Running
 * the app does not enable it.
 */

import { createChatCompletionsProvider } from './openaiCompatible.mjs';

export function createDeepSeekProvider({
  apiKey,
  baseUrl,
  model,
  thinking = 'enabled',
  reasoningEffort = 'low',
  timeoutMs = 60_000,
  fetchImpl = fetch,
}) {
  return createChatCompletionsProvider({
    id: 'deepseek',
    label: 'DeepSeek',
    apiKey,
    baseUrl,
    model,
    // Both are sent explicitly; see the note above about upstream's defaults.
    extraBody: {
      thinking: { type: thinking },
      reasoning_effort: reasoningEffort,
    },
    /** Shown next to the cost warning, so the reader knows what is being paid for. */
    reasoning: thinking === 'disabled' ? '思考模式关闭' : `思考模式 ${reasoningEffort}`,
    timeoutMs,
    fetchImpl,
  });
}

/**
 * Choosing a provider.
 *
 * The choice is made once, from the environment, when the service starts — never per request.
 * A request cannot name a provider, a model or an endpoint, so there is no path by which a page
 * could redirect a call.
 *
 * The ids come from `src-tauri/src/providers.rs`. DeepSeek is the one dialect with extra
 * parameters; every other paid id is sent a plain OpenAI-compatible request.
 */

import { createDeepSeekProvider } from './deepseek.mjs';
import { createMockProvider } from './mock.mjs';
import { createChatCompletionsProvider } from './openaiCompatible.mjs';

/** Display names for the generic adapter. The registry in Rust owns the settings list. */
const DISPLAY_NAMES = {
  openai: 'OpenAI',
  moonshot: 'Moonshot',
  zhipu: '智谱 GLM',
  dashscope: '通义千问',
  custom: '自定义服务',
};

export function createProvider(config, { fetchImpl } = {}) {
  const options = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  };

  if (config.provider === 'deepseek') {
    return createDeepSeekProvider({
      ...options,
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    });
  }
  if (config.provider === 'mock') {
    return createMockProvider();
  }
  return createChatCompletionsProvider({
    ...options,
    id: config.provider,
    label: DISPLAY_NAMES[config.provider] ?? config.provider,
  });
}

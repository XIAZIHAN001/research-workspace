/**
 * Choosing a provider.
 *
 * The choice is made once, from the environment, when the service starts — never per request.
 * A request cannot name a provider, a model or an endpoint, so there is no path by which a page
 * could redirect a call.
 */

import { createDeepSeekProvider } from './deepseek.mjs';
import { createMockProvider } from './mock.mjs';

export function createProvider(config, { fetchImpl } = {}) {
  if (config.provider === 'deepseek') {
    return createDeepSeekProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
      timeoutMs: config.timeoutMs,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  }
  return createMockProvider();
}

/**
 * The two error types that cross module boundaries in this service.
 *
 * Both carry a message that is safe to show the reader: it never contains the API key, the
 * request body, or anything else private. The `code` exists so the browser can choose wording
 * and behaviour (retry, re-authorise, give up) without parsing prose.
 */

export class ProviderError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ requestSent?: boolean }} [options]
   *   `requestSent` is `false` only when this service *knows* the request never left for the
   *   provider. `undefined` means unknown, which the budget treats conservatively as "may have
   *   been billed": a failure is not evidence that the provider did no work.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.requestSent = options.requestSent;
  }
}

/**
 * Codes the browser understands, each mapping to a different thing for the reader to do:
 * wait (rate limit), top up (balance), report it (invalid request), try again smaller
 * (incomplete), or stop trying. `cancel` is never produced here — it comes from the request.
 */
export const PROVIDER_CODES = [
  'timeout',
  'auth',
  'rate-limit',
  'insufficient-balance',
  'invalid-request',
  'incomplete',
  'upstream',
  'network',
  'config',
];

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

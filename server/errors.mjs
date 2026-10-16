/**
 * The two error types that cross module boundaries in this service.
 *
 * Both carry a message that is safe to show the reader: it never contains the API key, the
 * request body, or anything else private. The `code` exists so the browser can choose wording
 * and behaviour (retry, re-authorise, give up) without parsing prose.
 */

export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
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

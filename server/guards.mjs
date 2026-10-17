/**
 * The request-side boundaries of the local AI service.
 *
 * Every check here is a pure function over a header value, so each one can be tested directly
 * and each one fails with a message an operator can act on. The service refuses anything it
 * does not recognise rather than forwarding it: there is deliberately no code path that takes
 * a URL, a host, a model or a credential from the request.
 */

/**
 * DNS-rebinding guard.
 *
 * A page on `evil.example` can make the browser resolve `evil.example` to 127.0.0.1 and then
 * talk to this service. It cannot, however, change the `Host` header it sends — that stays
 * `evil.example:8787` — so requiring a loopback `Host` closes that door.
 */
export function checkHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') {
    return { ok: false, status: 403, message: '请求缺少 Host 头。' };
  }
  // Bracketed IPv6, then host:port, then a bare host.
  const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader);
  const hostname = ipv6 !== null ? ipv6[1] : hostHeader.replace(/:\d+$/, '');
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    message: `Host ${hostname} 不是本机地址，服务只服务 127.0.0.1。`,
  };
}

/**
 * Origin guard.
 *
 * A browser always sends `Origin` on a cross-origin POST, so a present-but-foreign origin is
 * refused. An absent `Origin` means the caller is not a browser (curl, the test suite, another
 * local process) — and such a caller can already read the environment directly, so refusing it
 * would buy no safety while making the service untestable by hand.
 */
export function checkOrigin(originHeader, allowedOrigins) {
  if (originHeader === undefined || originHeader === null || originHeader === '') {
    return { ok: true };
  }
  if (typeof originHeader !== 'string') {
    return { ok: false, status: 403, message: 'Origin 头不是字符串。' };
  }
  if (isLoopback(originHeader) || allowedOrigins.includes(originHeader)) return { ok: true };
  return { ok: false, status: 403, message: `来源 ${originHeader} 不在允许列表里。` };
}

function isLoopback(origin) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

/** Only the known endpoints exist; there is no passthrough of any kind. */
export function checkPath(pathname) {
  if (
    pathname === '/api/ai/health' ||
    pathname === '/api/ai/ask' ||
    pathname === '/api/ai/difficulties' ||
    pathname === '/api/ai/knowledge'
  ) {
    return { ok: true };
  }
  return { ok: false, status: 404, message: '没有这个接口。' };
}

export function checkMethod(method, pathname) {
  const expected = pathname === '/api/ai/health' ? 'GET' : 'POST';
  if (method === expected) return { ok: true };
  return { ok: false, status: 405, message: `${pathname} 只接受 ${expected}。` };
}

/** JSON response helper. No HTML is ever produced, and no model output is ever served as HTML. */
export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // The service is not a browser-facing document; nothing should ever be framed or sniffed.
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

export class BodyTooLarge extends Error {}

/**
 * Reads a JSON body, refusing anything over the cap.
 *
 * The cap is enforced while the bytes arrive rather than after: a client that ignores the
 * advertised limit should not be able to make the service buffer an arbitrary amount.
 */
export function readJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLarge(`请求体超过 ${String(maxBytes)} 字节。`));
        // The rest is drained and thrown away rather than buffered, so an oversized body costs
        // no more memory than the cap — and the caller can still read the reply.
        request.removeAllListeners('data');
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON。'));
      }
    });
    request.on('error', reject);
  });
}

/** A sliding-window counter: a runaway client should hit a wall, not a bill. */
export class RateLimiter {
  #hits = [];

  constructor(perMinute) {
    this.perMinute = perMinute;
  }

  take(now = Date.now()) {
    this.#hits = this.#hits.filter((at) => now - at < 60_000);
    if (this.#hits.length >= this.perMinute) {
      return { ok: false, retryAfterMs: 60_000 - (now - this.#hits[0]) };
    }
    this.#hits.push(now);
    return { ok: true };
  }
}

/** Bounds how many model calls can be in flight at once, so a burst cannot fan out. */
export class ConcurrencyGate {
  #active = 0;

  constructor(limit) {
    this.limit = limit;
  }

  get active() {
    return this.#active;
  }

  tryEnter() {
    if (this.#active >= this.limit) return false;
    this.#active += 1;
    return true;
  }

  leave() {
    this.#active = Math.max(0, this.#active - 1);
  }
}

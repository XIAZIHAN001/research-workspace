import { describe, expect, it } from 'vitest';
import {
  ConcurrencyGate,
  RateLimiter,
  checkHost,
  checkMethod,
  checkOrigin,
  checkPath,
} from './guards.mjs';

describe('checkHost', () => {
  it('accepts loopback hosts, with or without a port', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:8787', 'localhost:1420', '[::1]:8787']) {
      expect(checkHost(host)).toEqual({ ok: true });
    }
  });

  it('refuses everything else, which is what stops DNS rebinding', () => {
    for (const host of ['evil.example', 'evil.example:8787', '127.0.0.1.evil.example', '0.0.0.0']) {
      const result = checkHost(host);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(403);
    }
  });

  it('refuses a missing Host header', () => {
    expect(checkHost(undefined).ok).toBe(false);
    expect(checkHost('').ok).toBe(false);
  });
});

describe('checkOrigin', () => {
  it('allows a request with no Origin, which cannot come from a page', () => {
    expect(checkOrigin(undefined, [])).toEqual({ ok: true });
    expect(checkOrigin('', [])).toEqual({ ok: true });
  });

  it('allows loopback origins and configured ones', () => {
    expect(checkOrigin('http://127.0.0.1:1420', []).ok).toBe(true);
    expect(checkOrigin('https://app.example', ['https://app.example']).ok).toBe(true);
  });

  it('refuses a foreign origin that is not configured', () => {
    const result = checkOrigin('https://evil.example', ['https://app.example']);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });
});

describe('checkPath and checkMethod', () => {
  it('serves exactly two endpoints and forwards nothing', () => {
    expect(checkPath('/api/ai/health').ok).toBe(true);
    expect(checkPath('/api/ai/ask').ok).toBe(true);
    for (const path of ['/', '/api/ai/proxy', '/api/ai/ask/../health', '/v1/chat/completions']) {
      expect(checkPath(path).ok).toBe(false);
    }
  });

  it('pins a method to each endpoint', () => {
    expect(checkMethod('GET', '/api/ai/health').ok).toBe(true);
    expect(checkMethod('POST', '/api/ai/health').ok).toBe(false);
    expect(checkMethod('POST', '/api/ai/ask').ok).toBe(true);
    expect(checkMethod('GET', '/api/ai/ask').ok).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit inside a minute and then refuses', () => {
    const limiter = new RateLimiter(3);
    const start = 1_000_000;
    expect(limiter.take(start).ok).toBe(true);
    expect(limiter.take(start + 1).ok).toBe(true);
    expect(limiter.take(start + 2).ok).toBe(true);
    const refused = limiter.take(start + 3);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it('forgets hits that fell out of the window', () => {
    const limiter = new RateLimiter(1);
    expect(limiter.take(0).ok).toBe(true);
    expect(limiter.take(1000).ok).toBe(false);
    expect(limiter.take(61_000).ok).toBe(true);
  });
});

describe('ConcurrencyGate', () => {
  it('caps how many calls can be in flight and releases correctly', () => {
    const gate = new ConcurrencyGate(2);
    expect(gate.tryEnter()).toBe(true);
    expect(gate.tryEnter()).toBe(true);
    expect(gate.tryEnter()).toBe(false);
    gate.leave();
    expect(gate.active).toBe(1);
    expect(gate.tryEnter()).toBe(true);
  });
});

import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { probeProxy } from './offline.mjs';

/**
 * The guard that decides whether an acceptance run is allowed to open a browser.
 *
 * These tests use real sockets on loopback: the whole point of the check is what a *port*
 * answers, and a mocked fetch would test the mock instead of the behaviour.
 */

async function serving(handler) {
  const server = createServer((request, response) => {
    handler(request, response);
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}/`,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

const json = (value) => (request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
};

describe('probeProxy', () => {
  it('accepts the offline mock this run started', async () => {
    const peer = await serving(json({ provider: 'mock', online: false, instanceId: 'run-1' }));
    try {
      const probe = await probeProxy(peer.origin);
      expect(probe.ok).toBe(true);
      expect(probe.health.instanceId).toBe('run-1');
    } finally {
      await peer.stop();
    }
  });

  it('refuses a paid provider, whatever else it reports', async () => {
    const peer = await serving(json({ provider: 'deepseek', online: true, instanceId: 'paid' }));
    try {
      const probe = await probeProxy(peer.origin);
      expect(probe.ok).toBe(false);
      expect(probe.reason).toBe('online-provider');
    } finally {
      await peer.stop();
    }
  });

  it('refuses a service that cannot say which process it is', async () => {
    const peer = await serving(json({ provider: 'mock', online: false }));
    try {
      expect((await probeProxy(peer.origin)).reason).toBe('no-instance-id');
    } finally {
      await peer.stop();
    }
  });

  it('refuses an error status', async () => {
    const peer = await serving((request, response) => {
      response.writeHead(500);
      response.end('nope');
    });
    try {
      expect((await probeProxy(peer.origin)).reason).toBe('status');
    } finally {
      await peer.stop();
    }
  });

  it('refuses something that is not JSON', async () => {
    const peer = await serving((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html></html>');
    });
    try {
      expect((await probeProxy(peer.origin)).reason).toBe('not-json');
    } finally {
      await peer.stop();
    }
  });

  it('reports an unreachable port rather than throwing', async () => {
    const peer = await serving(json({}));
    const { origin } = peer;
    await peer.stop();
    const probe = await probeProxy(origin);
    expect(probe.ok).toBe(false);
    expect(probe.reason).toBe('unreachable');
  });
});

import { createServer, Server } from 'node:http';
import { listenOnLoopback } from './loopback.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import { startTestService } from './testing.mjs';

const running = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (running.length > 0) await running.pop().stop();
});

it('rebinds an OS-selected fetch-forbidden port before exposing the service URL', async () => {
  // Simulate an OS with an unusual ephemeral range without taking a fixed port from another
  // process. The real socket still binds port 0; only the first allocation report is forbidden.
  vi.spyOn(Server.prototype, 'address').mockReturnValueOnce({
    address: '127.0.0.1',
    family: 'IPv4',
    port: 6000,
  });
  const started = await startTestService();
  running.push(started);
  expect((await fetch(`${started.base}/api/ai/health`)).status).toBe(200);
});

it('keeps simultaneous services on independently allocated loopback ports and closes them', async () => {
  const services = await Promise.all(Array.from({ length: 8 }, () => startTestService()));
  running.push(...services);
  expect(new Set(services.map(({ base }) => base)).size).toBe(8);
  const responses = await Promise.all(services.map(({ base }) => fetch(`${base}/api/ai/health`)));
  const healths = await Promise.all(responses.map((response) => response.json()));
  expect(new Set(healths.map(({ instanceId }) => instanceId)).size).toBe(8);
  for (const started of services) {
    expect(new URL(started.base).hostname).toBe('127.0.0.1');
    await started.stop();
    running.splice(running.indexOf(started), 1);
    await expect(fetch(`${started.base}/api/ai/health`)).rejects.toThrow();
  }
});

it('bounds forbidden-port retries and leaves no listening socket after exhaustion', async () => {
  const server = createServer();
  vi.spyOn(server, 'address').mockReturnValue({ address: '127.0.0.1', family: 'IPv4', port: 6000 });
  let allocations = 0;
  server.on('listening', () => {
    allocations += 1;
  });
  await expect(listenOnLoopback(server)).rejects.toThrow('临时端口');
  expect(allocations).toBe(5);
  expect(server.listening).toBe(false);
  expect(server.listenerCount('error')).toBe(0);
});

it.each(['event', 'throw'])(
  'rejects a bind failure (%s) and removes temporary listeners',
  async (kind) => {
    const server = createServer();
    const originalListeners = server.listeners('listening');
    const failure = Object.assign(new Error('bind denied'), { code: 'EACCES' });
    vi.spyOn(server, 'listen').mockImplementationOnce(() => {
      if (kind === 'throw') throw failure;
      queueMicrotask(() => server.emit('error', failure));
      return server;
    });
    await expect(listenOnLoopback(server)).rejects.toBe(failure);
    expect(server.listening).toBe(false);
    expect(server.listenerCount('error')).toBe(0);
    expect(server.listeners('listening')).toEqual(originalListeners);
  },
);

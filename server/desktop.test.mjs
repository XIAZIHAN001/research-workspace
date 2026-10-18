/**
 * The desktop launcher, exercised as a real child process.
 *
 * This is the closest thing to the shell's view: spawn it, read the one ready line, talk to it
 * over HTTP with and without the credential, then close its stdin and confirm it leaves. Unit
 * tests of the individual guards live in guards.test.mjs; this file tests that the launcher
 * wires them together and never falls back to a fixed port.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, 'desktop.mjs');
const TOKEN = 'a'.repeat(64);
const INSTANCE = 'desktop-test-instance';
const ORIGIN = 'http://tauri.localhost';

function startService(extraEnv = {}) {
  return spawn(process.execPath, [launcher], {
    env: {
      ...process.env,
      AI_SESSION_TOKEN: TOKEN,
      AI_DESKTOP_INSTANCE: INSTANCE,
      AI_PARENT_PID: String(process.pid),
      AI_PORT: '0',
      AI_ALLOWED_ORIGINS: ORIGIN,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForReady(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`desktop service did not become ready: ${buffer} ${stderr}`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      if (!line.startsWith('RW_AI_READY ')) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice('RW_AI_READY '.length)));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`desktop service exited with ${String(code)}: ${stderr}`));
    });
  });
}

async function stopService(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2500)),
  ]);
  if (!exited) child.kill();
}

describe('desktop AI launcher', () => {
  it('binds an ephemeral authenticated loopback port and answers only with the credential', async () => {
    const child = startService({ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-must-be-ignored' });
    try {
      const ready = await waitForReady(child);
      expect(ready.port).toBeGreaterThan(0);
      // Not the developer default: the desktop never joins a service already on 8787.
      expect(ready.port).not.toBe(8787);
      expect(ready.desktopInstance).toBe(INSTANCE);
      // The launcher forces the offline provider even though the parent environment selected
      // deepseek and carried a key.
      expect(ready.provider).toBe('mock');
      expect(ready.online).toBe(false);

      const base = `http://127.0.0.1:${ready.port}`;

      const unauthenticated = await fetch(`${base}/api/ai/health`, {
        headers: { Origin: ORIGIN },
      });
      expect(unauthenticated.status).toBe(401);

      const foreignOrigin = await fetch(`${base}/api/ai/health`, {
        headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` },
      });
      expect(foreignOrigin.status).toBe(403);

      const accepted = await fetch(`${base}/api/ai/health`, {
        headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}` },
      });
      expect(accepted.status).toBe(200);
      const health = await accepted.json();
      expect(health.desktopInstance).toBe(INSTANCE);
      expect(health.provider).toBe('mock');
      expect(health.online).toBe(false);
    } finally {
      await stopService(child);
    }
  });

  it('refuses to start without a usable credential', async () => {
    const child = spawn(process.execPath, [launcher], {
      env: { ...process.env, AI_SESSION_TOKEN: 'short' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const [code] = await once(child, 'exit');
    expect(code).toBe(2);
  });

  it('stops when its stdin pipe closes', async () => {
    const child = startService();
    await waitForReady(child);
    child.stdin.end();
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
  });
});

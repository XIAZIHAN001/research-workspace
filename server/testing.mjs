/**
 * Fixtures shared by the service's tests.
 *
 * Not a test file itself (no `.test.` in the name), so the runner ignores it.
 */

import { request as httpRequest } from 'node:http';

/** A request the service should accept, in the shape the browser sends. */
export function validAsk(overrides = {}) {
  return {
    mode: 'explain',
    question: '',
    paper: {
      id: 'paper-1',
      title: 'A Study of Two Columns',
      page: 3,
      pdfSha256: 'a'.repeat(64),
    },
    passages: [
      {
        id: 'selection',
        page: 3,
        text: 'The model learns a representation that is invariant to the ordering of the input tokens.',
        selection: true,
      },
      {
        id: 'ctx-1',
        page: 3,
        text: 'Earlier work assumed order mattered. We show it does not.',
        selection: false,
      },
    ],
    ...overrides,
  };
}

/** Starts the service on an ephemeral port and returns its base URL plus a stop function. */
export async function startTestService(deps) {
  const { createAiServer } = await import('./index.mjs');
  const { readConfig } = await import('./config.mjs');
  const config = { ...readConfig({}), logRequests: false, ...(deps?.config ?? {}) };
  const { server, health } = createAiServer({ config, ...deps });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    health,
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

/** Posts JSON with a loopback Host header, as the Vite proxy would. */
export function postJson(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * Sends a request with headers `fetch` refuses to let a caller set.
 *
 * `Host` is a forbidden header in the fetch standard, so the DNS-rebinding guard can only be
 * tested by going under it and writing the bytes directly.
 */
export function rawRequest(base, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

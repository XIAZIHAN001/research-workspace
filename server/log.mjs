/**
 * The server's log.
 *
 * What is logged is a fixed set of numbers and labels chosen in one place. There is no API that
 * accepts free text, so paper text, the reader's question and model output cannot reach the log
 * even by accident — and the key is never read outside the provider that holds it.
 */

function line(entry) {
  return JSON.stringify({ at: new Date().toISOString(), ...entry });
}

export function createLogger({
  enabled = true,
  write = (text) => process.stdout.write(`${text}\n`),
} = {}) {
  return {
    /** One line per completed request. Counts and durations only. */
    request({ method, path, status, ms, provider, model, passages, chars, citations }) {
      if (!enabled) return;
      write(
        line({
          kind: 'request',
          method,
          path,
          status,
          ms,
          provider: provider ?? null,
          model: model ?? null,
          passages: passages ?? null,
          chars: chars ?? null,
          citations: citations ?? null,
        }),
      );
    },
    /** Startup and shutdown, which an operator reads once. */
    note(message) {
      if (!enabled) return;
      write(line({ kind: 'note', message }));
    },
  };
}

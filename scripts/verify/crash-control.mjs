/**
 * Chromium may kill a renderer without replying to the raw CDP Page.crash command. A
 * newCDPSession is independent of Playwright's main page session, so that request can stay
 * pending even after the page emits "crash". The event, not a response, is the acceptance.
 */
export async function crashRenderer(page, session, timeoutMs = 10_000) {
  const crashed = page.waitForEvent('crash', { timeout: timeoutMs });
  let commandError;
  try {
    // Observe rejections without awaiting a response that termination may prevent forever.
    void Promise.resolve(session.send('Page.crash')).catch((error) => {
      commandError = error;
    });
  } catch (error) {
    commandError = error;
  }
  try {
    await crashed;
  } catch (error) {
    const detail = commandError === undefined ? '' : ` CDP command: ${String(commandError)}`;
    throw new Error(`No observed renderer crash within ${timeoutMs} ms.${detail}`, {
      cause: error,
    });
  }
}

/** Ensure a stuck harness leaves a failure report before its owning process terminates. */
export function armHarnessDeadline(timeoutMs, reportFailure, terminate) {
  const timer = setTimeout(() => {
    try {
      reportFailure();
    } finally {
      terminate();
    }
  }, timeoutMs);
  // Keep this timer referenced: even a stuck Promise with no remaining I/O must time out.
  return () => clearTimeout(timer);
}

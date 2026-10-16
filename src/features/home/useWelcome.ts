import { useEffect, useState } from 'react';
import { composeWelcome, type WelcomeContext, type WelcomeProvider } from '../../services/welcome';

type Outcome =
  { context: WelcomeContext; text: string } | { context: WelcomeContext; failed: true };

/**
 * Asks the provider for a welcome line whenever the context changes. While a new line is
 * on its way the previous one stays visible, so the page never flashes empty. If the
 * provider fails, the local template text is used instead of an empty space.
 * `context` must be memoized by the caller.
 */
export function useWelcome(provider: WelcomeProvider, context: WelcomeContext) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [lastText, setLastText] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    provider.greet(context, controller.signal).then(
      (text) => {
        if (controller.signal.aborted) return;
        setOutcome({ context, text });
        setLastText(text);
      },
      () => {
        if (!controller.signal.aborted) setOutcome({ context, failed: true });
      },
    );
    return () => {
      controller.abort();
    };
  }, [provider, context]);

  const current = outcome?.context === context ? outcome : null;
  if (current === null) return { text: lastText, status: 'loading' as const };
  if ('failed' in current) return { text: composeWelcome(context), status: 'error' as const };
  return { text: current.text, status: 'ready' as const };
}

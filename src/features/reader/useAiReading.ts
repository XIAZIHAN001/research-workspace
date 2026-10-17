import { useCallback, useRef, useState } from 'react';
import { askAi, fetchAiHealth, type AiClientOptions } from '../../services/ai/client';
import { buildAskContext, buildHistory } from '../../services/ai/context';
import type {
  AiAnswer,
  AiAskRequest,
  AiFailure,
  AiHistoryTurn,
  AiMode,
} from '../../services/ai/types';
import type { SelectionAnchor } from './selection';
import type { SelectionFragmentation } from './layout';

/**
 * One reading session's conversation with the assistant.
 *
 * The session is deliberately short-lived and deliberately not persisted. A conversation is
 * scratch work — the reader asks, reads, maybe asks again, and either saves the part that was
 * worth keeping as a note or closes the panel and moves on. Nothing here is written to storage,
 * so browsing twenty answers cannot quietly grow the workspace.
 *
 * A failure is a state of the session, not an exception: it leaves the reader's highlights,
 * notes and reading position exactly where they were, and the panel offers to try again.
 */

export interface AiSource {
  paperId: string;
  title: string;
  pdfSha256: string;
  /** The page this conversation is about. */
  page: number;
  /**
   * The reader's selection, or null when they asked about the page as a whole.
   *
   * A null anchor is a supported starting point, not a missing value: the assistant works
   * without a selection, and says plainly that it was given the page rather than the paper.
   */
  anchor: SelectionAnchor | null;
  /** The page's rendered text, so follow-ups can be built without re-reading the DOM. */
  pageText: string;
  /** The reader's own layout measurement, or null when there is nothing to report. */
  layoutNotice: string | null;
  /**
   * How broken up the selection was in the text layer. Measured once, at the moment of asking,
   * because that is when the rendered page it describes is still on screen.
   */
  fragmentation: SelectionFragmentation | null;
}

export interface AiTurn {
  mode: AiMode;
  question: string;
  request: AiAskRequest;
  answer: AiAnswer | null;
  failure: AiFailure | null;
}

export interface AiSession {
  source: AiSource;
  turns: AiTurn[];
}

/** What the reader can do from outside: the parts of the client the hook needs. */
export interface AiClient {
  ask: typeof askAi;
  health: typeof fetchAiHealth;
}

const DEFAULT_CLIENT: AiClient = { ask: askAi, health: fetchAiHealth };

/** Follow-up turns carry this much of the conversation back; the rest is dropped. */
const HISTORY_TURNS = 6;

function historyOf(turns: readonly AiTurn[]): AiHistoryTurn[] {
  return buildHistory(
    turns.map((turn) => ({ question: turn.question, answer: turn.answer?.answer ?? null })),
    { maxTurns: HISTORY_TURNS },
  );
}

export function useAiReading(client: AiClient = DEFAULT_CLIENT) {
  const [session, setSession] = useState<AiSession | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setBusy(false);
  }, []);

  const run = useCallback(
    async (source: AiSource, mode: AiMode, question: string, previous: readonly AiTurn[]) => {
      const request = buildAskContext({
        paperId: source.paperId,
        title: source.title,
        pdfSha256: source.pdfSha256,
        page: source.page,
        pageText: source.pageText,
        start: source.anchor?.start,
        end: source.anchor?.end,
        mode,
        question,
        history: historyOf(previous),
        layoutNotice: source.layoutNotice,
      });

      const blank: AiTurn = { mode, question, request, answer: null, failure: null };
      setSession({ source, turns: [...previous, blank] });
      setBusy(true);

      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      const options: AiClientOptions = { signal: controller.signal };
      const outcome = await client.ask(request, options);
      if (
        controller.signal.aborted &&
        outcome.ok === false &&
        outcome.failure.kind === 'cancelled'
      ) {
        // A cancelled turn leaves the conversation as it was before the question was asked.
        setSession((current) =>
          current === null ? null : { ...current, turns: current.turns.slice(0, -1) },
        );
        setBusy(false);
        return;
      }

      setSession((current) => {
        if (current === null) return null;
        const turns = [...current.turns];
        const last = turns.pop();
        if (last === undefined) return current;
        turns.push(
          outcome.ok ? { ...last, answer: outcome.answer } : { ...last, failure: outcome.failure },
        );
        return { ...current, turns };
      });
      setBusy(false);
    },
    [client],
  );

  /** Starts a new session at a selection. Any previous conversation is dropped, never stored. */
  const ask = useCallback(
    (source: AiSource, mode: AiMode, question = '') => {
      void run(source, mode, question, []);
    },
    [run],
  );

  /** Continues the current conversation, sending the earlier turns as context. */
  const followUp = useCallback(
    (question: string) => {
      if (session === null) return;
      void run(session.source, 'ask', question, session.turns);
    },
    [run, session],
  );

  /** Retries the last failed question without adding a turn of its own. */
  const retry = useCallback(() => {
    if (session === null) return;
    const last = session.turns.at(-1);
    if (last === undefined) return;
    void run(session.source, last.mode, last.question, session.turns.slice(0, -1));
  }, [run, session]);

  const clear = useCallback(() => {
    cancel();
    setSession(null);
  }, [cancel]);

  return { session, busy, ask, followUp, retry, cancel, clear };
}

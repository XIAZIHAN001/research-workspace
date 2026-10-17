/**
 * Assembling what gets sent, and nothing more.
 *
 * The rule the task set is narrow on purpose: the reader's selection is the evidence, a little
 * of the same page around it is context, and the rest of the paper is not sent. So this is a
 * pure function over the text the reader can already see on the current page — no PDF bytes, no
 * other pages, no other papers — and it reports exactly how much it is sending so the interface
 * can show that to the reader before anything leaves the machine.
 *
 * The text it slices from is the page's *rendered* text, the same string the anchors are built
 * from. That matters for two reasons: the passages line up with what the reader selected
 * character for character, and the model is never shown text the reader cannot see.
 */

import type { AiAskRequest, AiHistoryTurn, AiMode, AiPassage } from './types';

/** Characters of the same page kept on each side of the selection. */
export const CONTEXT_WINDOW = 900;

/** Matches the service's per-passage ceiling, so a long selection cannot be silently dropped. */
export const MAX_PASSAGE_CHARS = 2000;

/**
 * Mirrors the service's `historyChars` limit.
 *
 * It is duplicated here on purpose: the browser has to build a request the service will accept,
 * and a follow-up whose history contained one 2829-character answer was rejected with a 400 —
 * measured, during the Phase 4.2 acceptance run, on the recovered real response. Trimming here
 * keeps the conversation going instead of ending it.
 */
export const MAX_HISTORY_CHARS = 2000;

export const PASSAGE_IDS = {
  selection: 'selection',
  /** The whole of the current page, when the reader asks without selecting anything. */
  page: 'page',
  before: 'before',
  after: 'after',
} as const;

export interface AskContextInput {
  paperId: string;
  title: string;
  pdfSha256: string;
  page: number;
  /** The page's rendered text, whitespace-collapsed, as `buildPageText` produced it. */
  pageText: string;
  /**
   * Offsets of the selection inside `pageText`.
   *
   * Absent for a question about the page as a whole: the reader opened the assistant without
   * selecting anything, which is a supported way to use it rather than a mistake to correct.
   */
  start?: number;
  end?: number;
  mode: AiMode;
  question?: string;
  history?: readonly AiHistoryTurn[];
  /** The reader's own layout measurement; null when there is nothing to report. */
  layoutNotice?: string | null;
}

export function buildAskContext(input: AskContextInput): AiAskRequest {
  const text = input.pageText;
  const hasSelection =
    typeof input.start === 'number' && typeof input.end === 'number' && input.end > input.start;

  if (!hasSelection) {
    // The page is the whole of what was read; there is no "before" and "after" to add, and
    // pretending otherwise would send the reader's own page twice.
    return {
      mode: input.mode,
      question: input.question ?? '',
      paper: {
        id: input.paperId,
        title: input.title,
        page: input.page,
        pdfSha256: input.pdfSha256,
      },
      passages: [
        {
          id: PASSAGE_IDS.page,
          page: input.page,
          text: text.slice(0, MAX_PASSAGE_CHARS),
          selection: true,
        },
      ],
      history: (input.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
      layoutNotice: input.layoutNotice ?? null,
      scope: 'page',
    };
  }

  const start = Math.max(0, Math.min(input.start ?? 0, text.length));
  const end = Math.max(start, Math.min(input.end ?? start, text.length));

  const passages: AiPassage[] = [
    {
      id: PASSAGE_IDS.selection,
      page: input.page,
      text: text.slice(start, end).slice(0, MAX_PASSAGE_CHARS),
      selection: true,
    },
  ];

  const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
  if (before.trim() !== '') {
    passages.push({ id: PASSAGE_IDS.before, page: input.page, text: before, selection: false });
  }
  const after = text.slice(end, end + CONTEXT_WINDOW);
  if (after.trim() !== '') {
    passages.push({ id: PASSAGE_IDS.after, page: input.page, text: after, selection: false });
  }

  const history = (input.history ?? []).map((turn) => ({ role: turn.role, content: turn.content }));

  return {
    mode: input.mode,
    question: input.question ?? '',
    paper: {
      id: input.paperId,
      title: input.title,
      page: input.page,
      pdfSha256: input.pdfSha256,
    },
    passages,
    history,
    layoutNotice: input.layoutNotice ?? null,
    scope: 'selection',
  };
}

export interface ContextSummary {
  selectionChars: number;
  contextChars: number;
  totalChars: number;
  /** Pages involved. Always exactly one: context never leaves the current page. */
  pages: number;
  layoutNotice: string | null;
}

/** What is about to be sent, in numbers the interface can put in front of the reader. */
export function summarizeContext(request: AiAskRequest): ContextSummary {
  const selectionChars = request.passages
    .filter((passage) => passage.selection)
    .reduce((sum, passage) => sum + passage.text.length, 0);
  const totalChars = request.passages.reduce((sum, passage) => sum + passage.text.length, 0);
  return {
    selectionChars,
    contextChars: totalChars - selectionChars,
    totalChars,
    pages: new Set(request.passages.map((passage) => passage.page)).size,
    layoutNotice: request.layoutNotice ?? null,
  };
}

/** One line describing the range, for the panel's "what will be sent" disclosure. */
export function describeContext(request: AiAskRequest): string {
  const summary = summarizeContext(request);
  const parts = [
    request.scope === 'page'
      ? `这一页 ${String(summary.selectionChars)} 字`
      : `选中 ${String(summary.selectionChars)} 字`,
  ];
  for (const passage of request.passages) {
    if (passage.id === PASSAGE_IDS.before) parts.push(`同页上文 ${String(passage.text.length)} 字`);
    if (passage.id === PASSAGE_IDS.after) parts.push(`同页下文 ${String(passage.text.length)} 字`);
  }
  parts.push(`合计 ${String(summary.totalChars)} 字`);
  return parts.join('；');
}

/** One exchange, as far as history is concerned: a question and whatever came back. */
export interface HistoryTurn {
  question: string;
  answer: string | null;
}

/**
 * The recent part of a conversation, in the shape the service accepts.
 *
 * Two rules, both learned from a request the service refused:
 *
 * - a turn with no answer contributes nothing. An empty assistant message is noise the model
 *   has to read past, and a failed turn is not part of what was said;
 * - no single message exceeds the service's own limit. The recovered answer from the live run
 *   is 2829 characters, and sending it back verbatim made the *next* question a 400. Trimming
 *   keeps the conversation usable; the reader is not shown the trimmed copy, only this one.
 */
export function buildHistory(
  turns: readonly HistoryTurn[],
  { maxTurns = 6, maxChars = MAX_HISTORY_CHARS }: { maxTurns?: number; maxChars?: number } = {},
): AiHistoryTurn[] {
  const flatten = (text: string): string =>
    text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;

  const history: AiHistoryTurn[] = [];
  for (const turn of turns) {
    if (turn.answer === null || turn.answer.trim() === '') continue;
    history.push({ role: 'user', content: flatten(turn.question) });
    history.push({ role: 'assistant', content: flatten(turn.answer) });
  }
  return history.slice(-maxTurns);
}

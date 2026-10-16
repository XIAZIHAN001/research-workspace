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

export const PASSAGE_IDS = {
  selection: 'selection',
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
  /** Offsets of the selection inside `pageText`. */
  start: number;
  end: number;
  mode: AiMode;
  question?: string;
  history?: readonly AiHistoryTurn[];
  /** The reader's own layout measurement; null when there is nothing to report. */
  layoutNotice?: string | null;
}

export function buildAskContext(input: AskContextInput): AiAskRequest {
  const text = input.pageText;
  const start = Math.max(0, Math.min(input.start, text.length));
  const end = Math.max(start, Math.min(input.end, text.length));

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
  const parts = [`选中 ${String(summary.selectionChars)} 字`];
  for (const passage of request.passages) {
    if (passage.id === PASSAGE_IDS.before) parts.push(`同页上文 ${String(passage.text.length)} 字`);
    if (passage.id === PASSAGE_IDS.after) parts.push(`同页下文 ${String(passage.text.length)} 字`);
  }
  parts.push(`合计 ${String(summary.totalChars)} 字`);
  return parts.join('；');
}

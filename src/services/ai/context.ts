/**
 * Assembling what gets sent, and nothing more.
 *
 * The rule the task set is narrow on purpose: the reader's selection is the evidence, a little
 * of the same page around it is context, and no other paper is ever sent. When the reader has
 * the paper's text extracted locally, every page of *this* paper is attached after those primary
 * passages, so a question about one chapter can be answered against the whole argument; without
 * that text the request falls back to the page alone. The passages report exactly how much was
 * sent, and the service re-checks every bound before the model sees it.
 *
 * The text it slices from is the page's *rendered* text, the same string the anchors are built
 * from. That matters for two reasons: the passages line up with what the reader selected
 * character for character, and the model is never shown text the reader cannot see.
 */

import type { AiAskRequest, AiDocumentScope, AiHistoryTurn, AiMode, AiPassage } from './types';

/** Characters of the same page kept on each side of the selection. */
export const CONTEXT_WINDOW = 900;

/** Matches the service's per-passage ceiling, so a long selection cannot be silently dropped. */
export const MAX_PASSAGE_CHARS = 2000;

/**
 * The whole paper, when the reader asks with the document attached.
 *
 * Three ceilings guard the document half: characters, passages, and a rough token count. The
 * character count bounds the request body; the passage count bounds pathological files with
 * thousands of tiny pages; and the token estimate is the one that actually mirrors the model's
 * context — CJK runs about one token per character, Latin about one per four. A 128k-token model
 * can take a whole dissertation at this budget and still have room for the answer.
 */
export const MAX_DOCUMENT_CHARS = 340_000;

/** Roughly 90k tokens, leaving room for the system prompt, the primary passage and the answer. */
export const MAX_DOCUMENT_TOKENS = 90_000;

/** One PDF page is almost never longer than this; a pathological page is trimmed, not dropped. */
export const MAX_DOCUMENT_PASSAGE_CHARS = 12_000;

/**
 * Mirrors the service's `document` scope ceiling, minus room for the primary passage.
 *
 * The service accepts at most 200 passages in a document request; a selection can add three
 * (the quote plus its context on each side), so the document half stops at 196 rather than making
 * the whole request one passage too large to send.
 */
export const MAX_DOCUMENT_PASSAGES = 196;

/** One page of extracted paper text, in reading order. */
export interface DocumentPageText {
  page: number;
  text: string;
}

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
  /**
   * Every page of the paper, extracted locally, when the reader asked for the whole document.
   *
   * Absent or empty keeps the old behaviour exactly: one page, one selection. Providing it adds
   * the paper's pages as ordinary passages, so the model reads the whole argument before it
   * answers and every citation still points at a real page.
   */
  documentPages?: readonly DocumentPageText[];
}

/**
 * A deliberately rough token count for the document budget.
 *
 * It never leaves the browser and does not try to match a tokenizer: it only decides where to stop
 * attaching pages. Counting CJK characters as one token and Latin as one per 3.5 characters is
 * close enough for both scripts, and erring high is the safe direction.
 */
function estimateDocumentTokens(text: string): number {
  const wide = text.match(/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu)?.length ?? 0;
  return wide + Math.ceil((text.length - wide) / 3.5);
}

/**
 * The document half of a request: one passage per page, in page order, under a character cap.
 *
 * A page whose text is empty (a scanned plate, a blank leaf) is skipped rather than sent as an
 * empty passage the service would refuse. The cap is applied to the document alone, so the
 * primary passage is never the one that gets cut, and the summary reports exactly how many pages
 * made it.
 */
function buildDocumentPassages(
  pages: readonly DocumentPageText[],
  skipPage: number | null,
): { passages: AiPassage[]; summary: AiDocumentScope } | null {
  if (pages.length === 0) return null;
  const ordered = [...pages]
    .filter((page) => Number.isInteger(page.page) && page.page >= 1)
    .filter((page) => page.page !== skipPage)
    .filter((page) => page.text.trim() !== '')
    .sort((one, other) => one.page - other.page);
  if (ordered.length === 0) return null;

  const passages: AiPassage[] = [];
  let total = 0;
  let tokens = 0;
  let truncated = false;
  let sent = 0;
  for (const page of ordered) {
    if (sent >= MAX_DOCUMENT_PASSAGES) {
      truncated = true;
      break;
    }
    const remaining = MAX_DOCUMENT_CHARS - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = page.text.slice(0, Math.min(MAX_DOCUMENT_PASSAGE_CHARS, remaining));
    if (text.trim() === '') continue;
    if (text.length < page.text.length) truncated = true;
    const pageTokens = estimateDocumentTokens(text);
    if (tokens + pageTokens > MAX_DOCUMENT_TOKENS) {
      truncated = true;
      break;
    }
    passages.push({ id: `p${String(page.page)}`, page: page.page, text, selection: false });
    total += text.length;
    tokens += pageTokens;
    sent += 1;
  }
  if (passages.length === 0) return null;
  // The primary passage already carries the current page, so it is part of what was sent even
  // though the document list leaves it out. Reporting 134/135 for a whole paper would read as a
  // page quietly missing.
  const current = skipPage !== null && pages.some((page) => page.page === skipPage);
  return {
    passages,
    summary: {
      pagesSent: passages.length + (current ? 1 : 0),
      pagesTotal: pages.length,
      charsSent: total,
      truncated,
    },
  };
}

/**
 * The disclosure a document request would produce, without making the caller rebuild it.
 *
 * The summary panel used to estimate pages from the raw page count, which disagreed with the
 * request once empty pages, the current page, the character cap or the token cap applied.
 * Both sides now read the same calculation.
 */
export function documentScope(
  pages: readonly DocumentPageText[],
  skipPage: number | null,
): AiDocumentScope | null {
  return buildDocumentPassages(pages, skipPage)?.summary ?? null;
}

export function buildAskContext(input: AskContextInput): AiAskRequest {
  const text = input.pageText;
  const hasSelection =
    typeof input.start === 'number' && typeof input.end === 'number' && input.end > input.start;

  const passages: AiPassage[] = [];
  if (!hasSelection) {
    // The page is the whole of what was read; there is no "before" and "after" to add, and
    // pretending otherwise would send the reader's own page twice.
    passages.push({
      id: PASSAGE_IDS.page,
      page: input.page,
      text: text.slice(0, MAX_PASSAGE_CHARS),
      selection: true,
    });
  } else {
    const start = Math.max(0, Math.min(input.start ?? 0, text.length));
    const end = Math.max(start, Math.min(input.end ?? start, text.length));
    passages.push({
      id: PASSAGE_IDS.selection,
      page: input.page,
      text: text.slice(start, end).slice(0, MAX_PASSAGE_CHARS),
      selection: true,
    });

    const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
    if (before.trim() !== '') {
      passages.push({ id: PASSAGE_IDS.before, page: input.page, text: before, selection: false });
    }
    const after = text.slice(end, end + CONTEXT_WINDOW);
    if (after.trim() !== '') {
      passages.push({ id: PASSAGE_IDS.after, page: input.page, text: after, selection: false });
    }
  }

  // When the page itself is the primary passage it already carries that page's full text, so the
  // document list omits it; with a selection the full page is additional context worth sending.
  const document = buildDocumentPassages(
    input.documentPages ?? [],
    hasSelection ? null : input.page,
  );
  if (document !== null) passages.push(...document.passages);

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
    history: (input.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
    layoutNotice: input.layoutNotice ?? null,
    scope: document !== null ? 'document' : hasSelection ? 'selection' : 'page',
    document: document?.summary,
  };
}

export interface ContextSummary {
  selectionChars: number;
  contextChars: number;
  totalChars: number;
  /** Pages involved: one for a selection or a page, the whole paper in document scope. */
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
  if (request.scope === 'document') {
    const document = request.document;
    const pages =
      document === undefined
        ? `${String(summary.pages)} 页`
        : `${String(document.pagesSent)}/${String(document.pagesTotal)} 页`;
    return `整篇文档 ${pages} · 合计 ${String(summary.totalChars)} 字${
      document?.truncated === true ? '（超出长度上限，后面的页未发送）' : ''
    }`;
  }
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

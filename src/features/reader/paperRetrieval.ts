/**
 * What the model is allowed to read, chosen locally and explained before anything is sent.
 *
 * Knowledge analysis is the first feature that may look beyond the reader's current page, so the
 * retrieval has to be both bounded and inspectable. This module is the local half: it extracts
 * page text with pdf.js, ranks pages with a small BM25-like score plus definition cues, and
 * returns a **plan** listing every segment, its page, why it was chosen, and how much text it
 * contributes. Nothing here calls a model or a network.
 *
 * Deliberate limits:
 *
 * - no embeddings and no vector database; the index is words and sentences;
 * - at most 48 pages are scanned, even for a 300-page paper;
 * - at most four sources contribute context, and the total stays under 6000 characters;
 * - a page whose text layer is fragmented (usually a formula) is reported, not repaired.
 */

import type { PDFDocumentProxy } from './pdfjs';

/** Pages scanned for one analysis. Enough for a paper's argument; far from "the whole library". */
export const MAX_SCAN_PAGES = 48;

/** Characters of context; the service's own hard ceiling is 9000. */
export const MAX_PLAN_CHARS = 6000;

/** One source segment before it is cut down. */
export const MAX_SEGMENT_CHARS = 1200;

/** Additional pages beyond the current one. */
export const MAX_CONTEXT_PAGES = 3;

/** The service refuses more than six distinct pages in one analysis. */
export const MAX_PLAN_PAGES = 6;

export interface ExtractedPage {
  page: number;
  text: string;
  itemCount: number;
  /** Text items that hold exactly one character — the shape a broken formula takes. */
  singleCharItems: number;
  fragmented: boolean;
}

/**
 * Extracts one page's text without rendering it.
 *
 * The text order is whatever the PDF's content stream says; for a two-column paper that is
 * usually reading order but not guaranteed. The plan says so rather than pretending the order
 * was reconstructed. A page that cannot be read is reported as a failure, never as empty text.
 */
export async function extractPageText(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<ExtractedPage | null> {
  try {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const parts: string[] = [];
    let itemCount = 0;
    let singleCharItems = 0;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const raw = item.str ?? '';
      if (raw.trim() === '') continue;
      itemCount += 1;
      if (raw.trim().length === 1) singleCharItems += 1;
      parts.push(raw);
      parts.push('hasEOL' in item && item.hasEOL === true ? '\n' : ' ');
    }
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    const fragmented = itemCount >= 8 && singleCharItems / itemCount >= 0.45;
    return { page: pageNumber, text, itemCount, singleCharItems, fragmented };
  } catch {
    return null;
  }
}

/**
 * The pages worth extracting, in priority order.
 *
 * The reader's page comes first, then its neighbours, then the opening pages where definitions
 * usually live, then pages the reader already annotated. Everything else is filled in only if
 * the paper is short enough; `pagesSkipped` in the plan makes that visible.
 */
export function pagesToScan(
  pageCount: number,
  currentPage: number,
  knownPages: readonly number[] = [],
  maxPages: number = MAX_SCAN_PAGES,
): number[] {
  if (pageCount <= 0) return [];
  const ordered: number[] = [];
  const seen = new Set<number>();
  const add = (page: number): void => {
    if (!Number.isInteger(page) || page < 1 || page > pageCount || seen.has(page)) return;
    seen.add(page);
    ordered.push(page);
  };
  add(currentPage);
  for (let offset = 1; offset <= 4; offset += 1) add(currentPage - offset);
  for (let offset = 1; offset <= 4; offset += 1) add(currentPage + offset);
  for (let page = 1; page <= Math.min(12, pageCount); page += 1) add(page);
  for (const page of knownPages) add(page);
  for (let page = 1; page <= pageCount; page += 1) add(page);
  return ordered.slice(0, Math.max(1, maxPages));
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'this',
  'from',
  'are',
  'was',
  'were',
  'have',
  'has',
  'had',
  'not',
  'but',
  'they',
  'their',
  'there',
  'these',
  'those',
  'which',
  'what',
  'when',
  'where',
  'while',
  'into',
  'over',
  'under',
  'between',
  'through',
  'because',
  'about',
  'also',
  'such',
  'can',
  'could',
  'would',
  'should',
  'may',
  'might',
  'will',
  'one',
  'two',
  'three',
  'our',
  'its',
  'his',
  'her',
  'you',
  'your',
  'all',
  'any',
  'each',
  'more',
  'most',
  'than',
  'then',
  'them',
  'been',
  'being',
  'does',
  'did',
  'how',
  'who',
  'why',
  'use',
  'used',
  'using',
  'paper',
  'section',
  'figure',
  'table',
  'results',
  'result',
  'however',
  'therefore',
  'thus',
  'show',
  'shows',
  'shown',
  'given',
  'based',
  'first',
  'second',
]);

/** Terms worth searching for, from the reader's selection and the concepts already known. */
export function retrievalTerms(
  selection: string,
  conceptNames: readonly string[],
  limit = 10,
): string[] {
  const counts = new Map<string, number>();
  const add = (term: string, weight: number): void => {
    const key = term.replace(/\s+/g, ' ').trim().toLowerCase();
    if (key.length < 3 || key.length > 48) return;
    if (STOPWORDS.has(key)) return;
    counts.set(key, (counts.get(key) ?? 0) + weight);
  };
  for (const name of conceptNames) {
    const key = name.replace(/\s+/g, ' ').trim().toLowerCase();
    if (key !== '') add(key, 5);
  }
  const words = selection.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? [];
  for (const word of words) add(word, 1);
  return [...counts.entries()]
    .sort((one, other) => other[1] - one[1] || other[0].length - one[0].length)
    .slice(0, limit)
    .map(([term]) => term);
}

const DEFINITION_CUE =
  /\b(?:we\s+define|is\s+defined\s+as|are\s+defined\s+as|refers?\s+to|denotes?|definition|formally|we\s+call|termed|let\s+[A-Za-z]\b)/gi;

function occurrences(text: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?。；])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

export type PlanRole =
  'selection' | 'definition' | 'term' | 'neighbor' | 'annotation' | 'difficulty' | 'context';

export interface PlanSegment {
  id: string;
  page: number;
  text: string;
  role: PlanRole;
  label: string;
  /** Why this segment was chosen, in the reader's terms. */
  reason: string;
  score: number;
  truncated: boolean;
  fragmented: boolean;
}

export interface RetrievalPlan {
  segments: PlanSegment[];
  pagesUsed: number[];
  pagesScanned: number;
  pagesSkipped: number;
  totalChars: number;
  maxChars: number;
  truncated: boolean;
  extractionFailures: number[];
  formulaFragments: number[];
  terms: string[];
  notices: string[];
}

export interface PlanAnnotation {
  page: number;
  quote: string;
  note: string;
}

export interface PlanDifficulty {
  page: number;
  title: string;
  quote: string;
  quick: string;
}

export interface PlanInput {
  pages: readonly ExtractedPage[];
  pageCount: number;
  currentPage: number;
  selection: string;
  conceptNames: readonly string[];
  annotations?: readonly PlanAnnotation[];
  difficulties?: readonly PlanDifficulty[];
  failedPages?: readonly number[];
  maxChars?: number;
}

function trimSegment(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, max - 1))}…`, truncated: true };
}

/** The sentence window around the best term or definition cue on one page. */
function contextForPage(
  page: ExtractedPage,
  terms: readonly string[],
  weights: ReadonlyMap<string, number>,
  currentPage: number,
): { text: string; reason: string; score: number; role: PlanRole } | null {
  const text = page.text;
  if (text.trim() === '') return null;
  const sentences = sentencesOf(text);
  if (sentences.length === 0) return null;

  let bestIndex = -1;
  let bestScore = 0;
  let bestCue = false;
  for (const [index, sentence] of sentences.entries()) {
    const lower = sentence.toLowerCase();
    let score = 0;
    for (const term of terms) score += occurrences(lower, term) * (weights.get(term) ?? 1);
    const cues = (sentence.match(DEFINITION_CUE) ?? []).length;
    if (cues > 0) score += cues * 2.5;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
      bestCue = cues > 0;
    }
  }

  const at = bestIndex < 0 ? 0 : bestIndex;
  const pieces = sentences.slice(Math.max(0, at - 1), Math.min(sentences.length, at + 3));
  const window = pieces.join(' ');
  const textScore = bestScore + (page.fragmented ? 0 : 0.25);
  const role: PlanRole =
    bestCue && bestIndex >= 0
      ? 'definition'
      : bestIndex >= 0 && bestScore > 0
        ? 'term'
        : Math.abs(page.page - currentPage) <= 2
          ? 'neighbor'
          : 'context';
  const reason =
    bestIndex < 0
      ? page.page === currentPage
        ? '当前页'
        : `第 ${String(page.page)} 页的正文`
      : `${bestCue ? '含定义句式' : '包含检索词'}${bestScore > 0 ? `（相关度 ${bestScore.toFixed(1)}）` : ''}`;
  return { text: window, reason, score: textScore, role };
}

/**
 * Builds the plan. Pure: it takes extracted text and returns what would be sent.
 *
 * The same function is used by the interface (to show the plan) and by the request builder (to
 * construct the passages), so what the reader approves is exactly what leaves the machine.
 */
export function buildRetrievalPlan(input: PlanInput): RetrievalPlan {
  const maxChars = input.maxChars ?? MAX_PLAN_CHARS;
  const terms = retrievalTerms(input.selection, input.conceptNames);
  const pages = input.pages.filter((page) => page.text.trim() !== '');
  const weights = new Map<string, number>();
  for (const term of terms) {
    const df = pages.filter((page) => page.text.toLowerCase().includes(term)).length;
    weights.set(term, Math.log(1 + pages.length / Math.max(1, df)));
  }

  const scored = pages.map((page) => {
    const lower = page.text.toLowerCase();
    let score = 0;
    for (const term of terms) score += occurrences(lower, term) * (weights.get(term) ?? 1);
    score += (lower.match(DEFINITION_CUE) ?? []).length * 1.5;
    if (page.page === input.currentPage) score += 3;
    else if (Math.abs(page.page - input.currentPage) <= 2) score += 1;
    return { page, score };
  });

  const currentPageEntry = pages.find((page) => page.page === input.currentPage) ?? null;
  const contextPages = scored
    .filter((entry) => entry.page.page !== input.currentPage && entry.score > 0)
    .sort((one, other) => other.score - one.score || one.page.page - other.page.page)
    .slice(0, MAX_CONTEXT_PAGES);

  const segments: PlanSegment[] = [];
  const notices: string[] = [];
  let nextId = 1;

  const selectionText = input.selection.trim();
  if (selectionText !== '') {
    let text = selectionText;
    if (currentPageEntry !== null) {
      const at = currentPageEntry.text.indexOf(selectionText);
      if (at >= 0) {
        text = currentPageEntry.text.slice(Math.max(0, at - 350), at + selectionText.length + 350);
      }
    }
    const trimmed = trimSegment(text, MAX_SEGMENT_CHARS);
    segments.push({
      id: `s${String(nextId)}`,
      page: input.currentPage,
      text: trimmed.text,
      role: 'selection',
      label: '读者选中的原文',
      reason: '选中的原文及本页上下文',
      score: Number.POSITIVE_INFINITY,
      truncated: trimmed.truncated,
      fragmented: currentPageEntry?.fragmented ?? false,
    });
    nextId += 1;
  } else {
    // The protocol always needs one primary passage. Without a selection, the page the reader
    // is looking at is the primary passage; if that page has no text (a scan), the first page
    // with text stands in and the plan says which page it is.
    const primary = currentPageEntry ?? pages[0] ?? null;
    if (primary !== null) {
      const trimmed = trimSegment(primary.text, MAX_SEGMENT_CHARS);
      segments.push({
        id: `s${String(nextId)}`,
        page: primary.page,
        text: trimmed.text,
        role: 'selection',
        label: '当前页正文',
        reason: '没有选中文字，使用当前页正文',
        score: Number.POSITIVE_INFINITY,
        truncated: trimmed.truncated,
        fragmented: primary.fragmented,
      });
      nextId += 1;
    }
  }

  for (const entry of contextPages) {
    const context = contextForPage(entry.page, terms, weights, input.currentPage);
    if (context === null) continue;
    const trimmed = trimSegment(context.text, MAX_SEGMENT_CHARS);
    segments.push({
      id: `s${String(nextId)}`,
      page: entry.page.page,
      text: trimmed.text,
      role: context.role,
      label:
        context.role === 'definition'
          ? '定义段落'
          : context.role === 'term'
            ? '术语出现的位置'
            : context.role === 'neighbor'
              ? '当前页附近'
              : '相关段落',
      reason: context.reason,
      score: context.score,
      truncated: trimmed.truncated,
      fragmented: entry.page.fragmented,
    });
    nextId += 1;
  }

  for (const annotation of input.annotations ?? []) {
    if (annotation.quote.trim() === '') continue;
    const page = pages.find((entry) => entry.page === annotation.page);
    const text =
      annotation.note.trim() === ''
        ? annotation.quote
        : `${annotation.quote}（读者的笔记：${annotation.note}）`;
    const trimmed = trimSegment(text, MAX_SEGMENT_CHARS);
    segments.push({
      id: `s${String(nextId)}`,
      page: annotation.page,
      text: trimmed.text,
      role: 'annotation',
      label: '你的笔记',
      reason: '来自你在这篇论文里的笔记',
      score: 4,
      truncated: trimmed.truncated,
      fragmented: page?.fragmented ?? false,
    });
    nextId += 1;
  }

  for (const difficulty of input.difficulties ?? []) {
    if (difficulty.quote.trim() === '') continue;
    const text = `${difficulty.quote}（难点：${difficulty.title}。${difficulty.quick}）`;
    const trimmed = trimSegment(text, MAX_SEGMENT_CHARS);
    const page = pages.find((entry) => entry.page === difficulty.page);
    segments.push({
      id: `s${String(nextId)}`,
      page: difficulty.page,
      text: trimmed.text,
      role: 'difficulty',
      label: '难点建议',
      reason: '来自已缓存的难点分析',
      score: 3,
      truncated: trimmed.truncated,
      fragmented: page?.fragmented ?? false,
    });
    nextId += 1;
  }

  // Selection first, then the reader's own material, then context by relevance; duplicates and
  // segments already covered by a longer one are dropped.
  const ordered = [
    ...segments.filter((segment) => segment.role === 'selection'),
    ...segments.filter((segment) => segment.role === 'annotation'),
    ...segments.filter((segment) => segment.role === 'difficulty'),
    ...segments
      .filter(
        (segment) =>
          segment.role !== 'selection' &&
          segment.role !== 'annotation' &&
          segment.role !== 'difficulty',
      )
      .sort((one, other) => other.score - one.score || one.page - other.page),
  ];
  const kept: PlanSegment[] = [];
  for (const segment of ordered) {
    const key = segment.text.slice(0, 100);
    if (key === '') continue;
    const duplicate = kept.some(
      (other) => other.text.slice(0, 100) === key || other.text.includes(segment.text),
    );
    if (duplicate) continue;
    kept.push(segment);
  }

  // The service's page ceiling is part of the contract, not a suggestion. The selection is
  // first, so it always survives; extra sources beyond the sixth distinct page are dropped here
  // rather than being refused by the service after the reader has approved the plan.
  const pageSet = new Set<number>();
  const pageCapped: PlanSegment[] = [];
  let pageLimited = false;
  for (const segment of kept) {
    if (!pageSet.has(segment.page) && pageSet.size >= MAX_PLAN_PAGES) {
      pageLimited = true;
      continue;
    }
    pageSet.add(segment.page);
    pageCapped.push(segment);
  }

  let total = 0;
  let truncated = false;
  const finalSegments: PlanSegment[] = [];
  for (const segment of pageCapped) {
    const remaining = maxChars - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (segment.text.length > remaining) {
      const cut = trimSegment(segment.text, remaining);
      finalSegments.push({ ...segment, text: cut.text, truncated: true });
      total += cut.text.length;
      truncated = true;
      continue;
    }
    finalSegments.push(segment);
    total += segment.text.length;
  }

  const pagesUsed = [...new Set(finalSegments.map((segment) => segment.page))].sort(
    (one, other) => one - other,
  );
  const fragmentedPages = [
    ...new Set(finalSegments.filter((s) => s.fragmented).map((s) => s.page)),
  ];
  const failures = [...new Set(input.failedPages ?? [])].sort((one, other) => one - other);
  if (truncated) notices.push('上下文达到长度上限，后面的段落没有发送。');
  if (pageLimited) {
    notices.push(`一次最多分析 ${String(MAX_PLAN_PAGES)} 页，来自其余页面的段落没有发送。`);
  }
  if (fragmentedPages.length > 0) {
    notices.push(
      `第 ${fragmentedPages.join('、')} 页的文字层是碎片化的（很可能含公式）；模型只会看到这些碎片，不会看到排版好的公式。` +
        '模型若补写公式，那只是模型解释，不是 PDF 原文。',
    );
  }
  if (input.selection.trim() === '') {
    notices.push('没有选中文字，按当前页分析。');
  }
  if (terms.length === 0) {
    notices.push('没有提取到可用于检索的术语，只使用当前页及邻近页面。');
  }
  if (failures.length > 0) {
    notices.push(`第 ${failures.join('、')} 页的文字提取失败，未纳入分析。`);
  }
  const skipped = Math.max(0, input.pageCount - pages.length);
  if (skipped > 0) {
    notices.push(`本次扫描了 ${String(pages.length)} 页，其余 ${String(skipped)} 页未扫描。`);
  }

  return {
    segments: finalSegments,
    pagesUsed,
    pagesScanned: pages.length,
    pagesSkipped: skipped,
    totalChars: total,
    maxChars,
    truncated,
    extractionFailures: failures,
    formulaFragments: fragmentedPages,
    terms,
    notices,
  };
}

/** A plan written in one line, for the panel's summary. */
export function describePlan(plan: RetrievalPlan): string {
  return [
    `使用第 ${plan.pagesUsed.join('、')} 页`,
    `${String(plan.segments.length)} 段`,
    `${String(plan.totalChars)} 字`,
    plan.truncated ? '已截断' : '未截断',
  ].join(' · ');
}

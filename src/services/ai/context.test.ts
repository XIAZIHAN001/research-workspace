import { describe, expect, it } from 'vitest';
import {
  buildAskContext,
  CONTEXT_WINDOW,
  describeContext,
  MAX_PASSAGE_CHARS,
  PASSAGE_IDS,
  summarizeContext,
} from './context';
import type { AiAskRequest } from './types';

/** A page of filler with a known sentence at a known place. */
function pageOf(
  length: number,
  marker = 'THE SELECTED SENTENCE',
  at = 1000,
): { text: string; start: number } {
  const text = 'a'.repeat(length);
  const start = Math.min(at, Math.max(0, length - marker.length));
  return { text: `${text.slice(0, start)}${marker}${text.slice(start + marker.length)}`, start };
}

function ask(overrides: Partial<Parameters<typeof buildAskContext>[0]> = {}): AiAskRequest {
  const { text, start } = pageOf(4000);
  return buildAskContext({
    paperId: 'paper-1',
    title: 'A Paper',
    pdfSha256: 'a'.repeat(64),
    page: 3,
    pageText: text,
    start,
    end: start + 'THE SELECTED SENTENCE'.length,
    mode: 'explain',
    ...overrides,
  });
}

describe('buildAskContext', () => {
  it('makes the selection the first passage and marks it as the selection', () => {
    const request = ask();
    expect(request.passages[0]?.id).toBe(PASSAGE_IDS.selection);
    expect(request.passages[0]?.selection).toBe(true);
    expect(request.passages[0]?.text).toBe('THE SELECTED SENTENCE');
    expect(request.passages.filter((passage) => passage.selection)).toHaveLength(1);
  });

  it('adds a bounded window of the same page on each side', () => {
    const request = ask();
    const before = request.passages.find((passage) => passage.id === PASSAGE_IDS.before);
    const after = request.passages.find((passage) => passage.id === PASSAGE_IDS.after);
    expect(before?.text).toHaveLength(CONTEXT_WINDOW);
    expect(after?.text).toHaveLength(CONTEXT_WINDOW);
    expect(before?.page).toBe(3);
    expect(after?.page).toBe(3);
  });

  it('never leaves the current page, however long the paper is', () => {
    const request = ask();
    for (const passage of request.passages) expect(passage.page).toBe(3);
    const total = request.passages.reduce((sum, passage) => sum + passage.text.length, 0);
    // Three bounded passages, never the document.
    expect(total).toBeLessThanOrEqual(MAX_PASSAGE_CHARS + 2 * CONTEXT_WINDOW);
  });

  it('omits a side that has nothing in it', () => {
    const request = buildAskContext({
      paperId: 'p',
      title: 'T',
      pdfSha256: 'a'.repeat(64),
      page: 1,
      pageText: 'ONLY THIS',
      start: 0,
      end: 9,
      mode: 'translate',
    });
    expect(request.passages).toHaveLength(1);
    expect(request.passages[0]?.id).toBe(PASSAGE_IDS.selection);
  });

  it('clamps offsets that fall outside the page text', () => {
    const request = buildAskContext({
      paperId: 'p',
      title: 'T',
      pdfSha256: 'a'.repeat(64),
      page: 1,
      pageText: 'short page',
      start: -20,
      end: 999,
      mode: 'explain',
    });
    expect(request.passages[0]?.text).toBe('short page');
  });

  it('truncates a selection longer than a passage may be, rather than failing later', () => {
    const long = 'x'.repeat(5000);
    const request = buildAskContext({
      paperId: 'p',
      title: 'T',
      pdfSha256: 'a'.repeat(64),
      page: 1,
      pageText: long,
      start: 0,
      end: 5000,
      mode: 'explain',
    });
    expect(request.passages[0]?.text).toHaveLength(MAX_PASSAGE_CHARS);
  });

  it('carries the paper identity so a citation can name its source', () => {
    const request = ask();
    expect(request.paper).toEqual({
      id: 'paper-1',
      title: 'A Paper',
      page: 3,
      pdfSha256: 'a'.repeat(64),
    });
  });

  it('passes the layout notice through, and defaults it to null', () => {
    expect(ask().layoutNotice).toBeNull();
    expect(
      ask({ layoutNotice: '这一页是多栏排版；提取顺序与版面顺序一致。' }).layoutNotice,
    ).toContain('多栏');
  });

  it('carries history for a follow-up and nothing for a first question', () => {
    expect(ask().history).toEqual([]);
    const followUp = ask({ history: [{ role: 'user', content: '继续' }] });
    expect(followUp.history).toEqual([{ role: 'user', content: '继续' }]);
  });

  it('defaults the question to empty so a non-ask mode sends no question', () => {
    expect(ask().question).toBe('');
  });
});

describe('summarizeContext', () => {
  it('separates what the reader selected from what came with it', () => {
    const summary = summarizeContext(ask());
    expect(summary.selectionChars).toBe('THE SELECTED SENTENCE'.length);
    expect(summary.contextChars).toBe(2 * CONTEXT_WINDOW);
    expect(summary.totalChars).toBe(summary.selectionChars + summary.contextChars);
    expect(summary.pages).toBe(1);
  });

  it('reports at most one page even when the text repeats', () => {
    expect(summarizeContext(ask()).pages).toBe(1);
  });
});

describe('describeContext', () => {
  it('says how much is being sent, in the reader’s terms', () => {
    const line = describeContext(ask());
    expect(line).toContain(`选中 ${String('THE SELECTED SENTENCE'.length)} 字`);
    expect(line).toContain(`同页上文 ${String(CONTEXT_WINDOW)} 字`);
    expect(line).toContain(`同页下文 ${String(CONTEXT_WINDOW)} 字`);
    expect(line).toContain('合计');
  });
});

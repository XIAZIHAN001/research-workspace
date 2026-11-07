import { describe, expect, it } from 'vitest';
import {
  buildAskContext,
  buildHistory,
  CONTEXT_WINDOW,
  describeContext,
  documentScope,
  MAX_DOCUMENT_PASSAGES,
  MAX_DOCUMENT_PASSAGE_CHARS,
  MAX_HISTORY_CHARS,
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

/**
 * The history a follow-up carries back.
 *
 * A real acceptance run ended a conversation here: the recovered answer from the live failure is
 * 2829 characters, the service refuses any single history message over 2000, and the next
 * question came back 400. These are the rules that keep that from happening again.
 */
/**
 * A question about the page, asked without selecting anything.
 *
 * The assistant is not selection-only. What it gets is exactly this page's text — not the
 * paper, and not a selection invented to fit the old shape of the request.
 */
describe('buildAskContext: a question about the page', () => {
  const pageAsk = (overrides: Partial<Parameters<typeof buildAskContext>[0]> = {}): AiAskRequest =>
    buildAskContext({
      paperId: 'paper-1',
      title: 'A Paper',
      pdfSha256: 'a'.repeat(64),
      page: 5,
      pageText: 'x'.repeat(1200),
      mode: 'ask',
      question: '这一页讲了什么？',
      ...overrides,
    });

  it('sends the page as the primary passage and nothing else', () => {
    const request = pageAsk();
    expect(request.scope).toBe('page');
    expect(request.passages).toHaveLength(1);
    expect(request.passages[0]?.id).toBe(PASSAGE_IDS.page);
    expect(request.passages[0]?.selection).toBe(true);
    expect(request.passages[0]?.page).toBe(5);
    expect(request.passages[0]?.text).toBe('x'.repeat(1200));
  });

  it('still sends only one page, even when the page is long', () => {
    const request = pageAsk({ pageText: 'y'.repeat(9000) });
    expect(request.passages[0]?.text).toHaveLength(MAX_PASSAGE_CHARS);
    expect(new Set(request.passages.map((passage) => passage.page))).toEqual(new Set([5]));
  });

  it('keeps the history, so a page conversation can be continued', () => {
    const request = pageAsk({ history: [{ role: 'user', content: '上一问' }] });
    expect(request.history).toEqual([{ role: 'user', content: '上一问' }]);
  });

  it('describes the range as the page, not as a selection', () => {
    expect(describeContext(pageAsk())).toContain('这一页 1200 字');
  });

  it('treats an empty selection as a page question rather than an empty passage', () => {
    // A selection that never happened arrives as start === end; sending an empty primary
    // passage would be rejected by the service anyway.
    const request = pageAsk({ start: 4, end: 4 });
    expect(request.scope).toBe('page');
    expect(request.passages[0]?.id).toBe(PASSAGE_IDS.page);
  });
});

describe('buildAskContext: the whole paper', () => {
  const document = [
    { page: 1, text: 'FIRST PAGE' },
    { page: 2, text: 'SECOND PAGE' },
    { page: 3, text: 'CURRENT PAGE' },
  ];

  const pageAsk = (overrides: Partial<Parameters<typeof buildAskContext>[0]> = {}): AiAskRequest =>
    buildAskContext({
      paperId: 'paper-1',
      title: 'A Paper',
      pdfSha256: 'a'.repeat(64),
      page: 3,
      pageText: 'CURRENT PAGE',
      mode: 'ask',
      question: '第三章讲了什么？',
      documentPages: document,
      ...overrides,
    });

  it('adds the paper’s pages after the primary passage, in reading order', () => {
    const request = pageAsk();
    expect(request.scope).toBe('document');
    expect(request.passages[0]?.id).toBe(PASSAGE_IDS.page);
    expect(
      request.passages.slice(1).map((passage) => [passage.id, passage.page, passage.selection]),
    ).toEqual([
      ['p1', 1, false],
      ['p2', 2, false],
    ]);
    // The current page is the primary passage already, so the document half omits it — but it is
    // still part of what the model reads, so the summary counts all three.
    expect(request.document).toEqual({
      pagesSent: 3,
      pagesTotal: 3,
      charsSent: 21,
      truncated: false,
    });
  });

  it('reports exactly the scope the request actually carries', () => {
    // The summary disclosure and the request must not disagree about what is sent.
    expect(documentScope(document, 3)).toEqual(pageAsk().document);
  });

  it('keeps the current page inside the document when the question is about a selection', () => {
    const request = pageAsk({ start: 0, end: 7 });
    expect(request.scope).toBe('document');
    expect(request.passages.map((passage) => passage.id)).toContain('p3');
    expect(request.document?.pagesSent).toBe(3);
  });

  it('skips blank pages rather than sending an empty passage the service would refuse', () => {
    const request = pageAsk({
      documentPages: [
        { page: 1, text: 'FIRST PAGE' },
        { page: 2, text: '   ' },
        { page: 3, text: 'CURRENT PAGE' },
      ],
    });
    expect(request.passages.map((passage) => passage.id)).toEqual([PASSAGE_IDS.page, 'p1']);
    // Page 2 is blank and never sent; the current page brings the total of sent pages to two.
    expect(request.document?.pagesSent).toBe(2);
    expect(request.document?.truncated).toBe(false);
  });

  it('trims a pathological page instead of dropping it', () => {
    const request = pageAsk({
      documentPages: [{ page: 1, text: 'x'.repeat(MAX_DOCUMENT_PASSAGE_CHARS + 50) }],
    });
    expect(request.passages[1]?.text).toHaveLength(MAX_DOCUMENT_PASSAGE_CHARS);
    expect(request.document?.truncated).toBe(true);
  });

  it('stops at the passage ceiling and says the paper was cut short', () => {
    const request = pageAsk({
      documentPages: Array.from({ length: MAX_DOCUMENT_PASSAGES + 4 }, (_unused, index) => ({
        page: index + 1,
        text: 'word',
      })),
    });
    // The ceiling bounds document passages; the primary passage for the current page always goes.
    expect(request.document?.pagesSent).toBe(MAX_DOCUMENT_PASSAGES + 1);
    expect(request.document?.truncated).toBe(true);
  });

  it('falls back to the page alone when extraction produced nothing', () => {
    const request = pageAsk({ documentPages: [] });
    expect(request.scope).toBe('page');
    expect(request.passages).toHaveLength(1);
    expect(request.document).toBeUndefined();
  });

  it('describes the whole paper, including how many pages made it', () => {
    expect(describeContext(pageAsk())).toContain('整篇文档 3/3 页');
    // The primary passage is included in the total: 12 characters of page plus 21 of the paper.
    expect(describeContext(pageAsk())).toContain('合计 33 字');
  });
});

describe('buildHistory', () => {
  const long = 'x'.repeat(2829);

  it('carries a question and its answer as one exchange', () => {
    expect(buildHistory([{ question: '为什么？', answer: '因为 [1]。' }])).toEqual([
      { role: 'user', content: '为什么？' },
      { role: 'assistant', content: '因为 [1]。' },
    ]);
  });

  it('leaves out a turn that never got an answer', () => {
    expect(buildHistory([{ question: '失败的提问', answer: null }])).toEqual([]);
  });

  it('leaves out a turn whose answer is empty', () => {
    // The malformed reply produces exactly this: a turn with no text to send back.
    expect(buildHistory([{ question: '空的', answer: '   ' }])).toEqual([]);
  });

  it('trims a long answer to what the service accepts', () => {
    const history = buildHistory([{ question: '长回答', answer: long }]);
    const assistant = history.find((turn) => turn.role === 'assistant');
    expect(assistant?.content.length).toBe(MAX_HISTORY_CHARS);
    expect(assistant?.content.endsWith('…')).toBe(true);
  });

  it('keeps only the most recent exchanges', () => {
    const turns = Array.from({ length: 5 }, (_unused, index) => ({
      question: `问 ${String(index)}`,
      answer: `答 ${String(index)}`,
    }));
    const history = buildHistory(turns, { maxTurns: 4 });
    expect(history).toHaveLength(4);
    // Ten entries from five exchanges, cut to the last four: turns 3 and 4.
    expect(history[0]).toEqual({ role: 'user', content: '问 3' });
  });

  it('never sends a message the service would reject', () => {
    const history = buildHistory(
      Array.from({ length: 10 }, (_unused, index) => ({
        question: `问题 ${String(index)}`,
        answer: index % 2 === 0 ? long : `短答 ${String(index)}`,
      })),
    );
    for (const turn of history) {
      expect(turn.content.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    }
  });
});

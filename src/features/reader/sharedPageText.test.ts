import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from './pdfjs';
import { extractPageText } from './paperRetrieval';

function documentWith(text: string) {
  const getTextContent = vi.fn(async () => ({ items: [{ str: text }, { str: '学习' }] }));
  const getPage = vi.fn(async () => ({ getTextContent }));
  return { doc: { numPages: 1, getPage } as unknown as PDFDocumentProxy, getTextContent };
}

describe('shared page extraction', () => {
  it('deduplicates simultaneous and repeated extraction', async () => {
    const { doc, getTextContent } = documentWith('机器');
    const [a, b] = await Promise.all([extractPageText(doc, 1), extractPageText(doc, 1)]);
    expect(a?.text).toBe('机器 学习');
    expect(b).toEqual(a);
    await extractPageText(doc, 1);
    expect(getTextContent).toHaveBeenCalledTimes(1);
  });
  it('retries failures and isolates document identities', async () => {
    const one = documentWith('one');
    const two = documentWith('two');
    one.getTextContent.mockRejectedValueOnce(new Error('temporary'));
    expect(await extractPageText(one.doc, 1)).toBeNull();
    expect((await extractPageText(one.doc, 1))?.text).toBe('one 学习');
    expect((await extractPageText(two.doc, 1))?.text).toBe('two 学习');
    expect(one.getTextContent).toHaveBeenCalledTimes(2);
  });
});

it('bounds retained pages and leaves unadmitted pages readable', async () => {
  const { readSharedPageText, MAX_SHARED_TEXT_PAGES } = await import('./sharedPageText');
  const { doc, getTextContent } = documentWith('small');
  for (let page = 1; page <= MAX_SHARED_TEXT_PAGES + 1; page++) await readSharedPageText(doc, page);
  await readSharedPageText(doc, MAX_SHARED_TEXT_PAGES + 1);
  expect(getTextContent).toHaveBeenCalledTimes(MAX_SHARED_TEXT_PAGES + 2);
  expect((await readSharedPageText(doc, 1))?.search).toBe('small学习');
  expect(getTextContent).toHaveBeenCalledTimes(MAX_SHARED_TEXT_PAGES + 2);
});

it('deduplicates but does not retain oversized derived strings', async () => {
  const { readSharedPageText, MAX_SHARED_TEXT_CHARS } = await import('./sharedPageText');
  const { doc, getTextContent } = documentWith('a'.repeat(MAX_SHARED_TEXT_CHARS));
  const [a, b] = await Promise.all([readSharedPageText(doc, 1), readSharedPageText(doc, 1)]);
  expect(a).toBe(b);
  expect(a?.analysis.text.length).toBeGreaterThan(MAX_SHARED_TEXT_CHARS);
  expect(getTextContent).toHaveBeenCalledTimes(1);
  await readSharedPageText(doc, 1);
  expect(getTextContent).toHaveBeenCalledTimes(2);
});

it('retains useful admitted pages across sequential scans larger than its budget', async () => {
  const { readSharedPageText, MAX_SHARED_TEXT_PAGES } = await import('./sharedPageText');
  const { doc, getTextContent } = documentWith('short');
  for (let pass = 0; pass < 2; pass++) {
    for (let page = 1; page <= MAX_SHARED_TEXT_PAGES + 1; page++)
      await readSharedPageText(doc, page);
  }
  expect(getTextContent).toHaveBeenCalledTimes(MAX_SHARED_TEXT_PAGES + 2);
});

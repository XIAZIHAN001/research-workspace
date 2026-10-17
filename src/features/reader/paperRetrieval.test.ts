import { describe, expect, it } from 'vitest';
import {
  buildRetrievalPlan,
  describePlan,
  pagesToScan,
  retrievalTerms,
  type ExtractedPage,
} from './paperRetrieval';

const page = (number: number, text: string, fragmented = false): ExtractedPage => ({
  page: number,
  text,
  itemCount: fragmented ? 20 : 40,
  singleCharItems: fragmented ? 14 : 0,
  fragmented,
});

describe('retrieval terms', () => {
  it('keeps technical words and known concept names, and drops stopwords', () => {
    const terms = retrievalTerms(
      'We show that the KZG commitment relies on a bilinear pairing over the elliptic curve.',
      ['KZG commitment', 'Bilinear pairing'],
    );
    expect(terms).toContain('kzg commitment');
    expect(terms).toContain('bilinear pairing');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('show');
  });
});

describe('pagesToScan', () => {
  it('starts at the current page, then neighbours, then the opening pages', () => {
    const pages = pagesToScan(30, 15, [22], 20);
    expect(pages[0]).toBe(15);
    expect(pages.slice(0, 9)).toContain(14);
    expect(pages.slice(0, 9)).toContain(11);
    expect(pages).toContain(1);
    expect(pages).toContain(22);
    expect(pages).toHaveLength(20);
  });

  it('never returns the same page twice or a page outside the document', () => {
    const pages = pagesToScan(2, 1, [1, 2, 99]);
    expect(pages).toEqual([1, 2]);
  });
});

describe('buildRetrievalPlan', () => {
  const selection = 'A KZG commitment relies on a bilinear pairing over an elliptic curve group.';

  it('sends the selection and finds a definition page with a reason', () => {
    const plan = buildRetrievalPlan({
      pages: [
        page(2, `${selection} The commitment is a single group element.`),
        page(5, 'We define the pairing e: G1 x G2 -> GT as a bilinear map. It is non-degenerate.'),
        page(9, 'Unrelated discussion of data sets and evaluation metrics.'),
      ],
      pageCount: 9,
      currentPage: 2,
      selection,
      conceptNames: ['Bilinear pairing'],
    });
    expect(plan.segments[0]?.role).toBe('selection');
    expect(plan.segments[0]?.page).toBe(2);
    expect(plan.pagesUsed).toContain(5);
    const definition = plan.segments.find((segment) => segment.page === 5);
    expect(definition?.role).toBe('definition');
    expect(definition?.reason).toContain('定义');
    expect(plan.totalChars).toBeLessThanOrEqual(plan.maxChars);
  });

  it('caps the context and says it was truncated', () => {
    const long = 'KZG commitment bilinear pairing '.repeat(80);
    const plan = buildRetrievalPlan({
      pages: [page(1, `${selection} ${long}`), page(2, long), page(3, long), page(4, long)],
      pageCount: 4,
      currentPage: 1,
      selection,
      conceptNames: [],
      maxChars: 400,
    });
    expect(plan.truncated).toBe(true);
    expect(plan.totalChars).toBeLessThanOrEqual(400);
    expect(plan.notices.some((notice) => notice.includes('上限'))).toBe(true);
  });

  it('reports fragmented formula pages rather than repairing them', () => {
    const plan = buildRetrievalPlan({
      pages: [
        page(1, `${selection} R ( u ) := log P 1 ( u ) P 0 ( u )`),
        page(2, 'The KZG commitment uses a bilinear pairing in its verification equation.', true),
      ],
      pageCount: 2,
      currentPage: 1,
      selection,
      conceptNames: [],
    });
    expect(plan.formulaFragments).toContain(2);
    expect(plan.notices.some((notice) => notice.includes('碎片'))).toBe(true);
    expect(plan.segments.find((segment) => segment.page === 2)?.fragmented).toBe(true);
  });

  it('includes the reader’s own notes and cached difficulties without a model call', () => {
    const plan = buildRetrievalPlan({
      pages: [page(1, selection), page(3, 'A bilinear pairing is used here.')],
      pageCount: 3,
      currentPage: 1,
      selection,
      conceptNames: [],
      annotations: [{ page: 3, quote: 'A bilinear pairing is used here.', note: '关键的验证步骤' }],
      difficulties: [
        {
          page: 3,
          title: '双线性配对',
          quote: 'A bilinear pairing is used here.',
          quick: '把两个群元素映射到第三个群。',
        },
      ],
    });
    expect(plan.segments.some((segment) => segment.role === 'annotation')).toBe(true);
    expect(plan.segments.some((segment) => segment.role === 'difficulty')).toBe(true);
    expect(plan.pagesUsed).toContain(3);
  });

  it('says when no term was found and when pages were skipped', () => {
    const plan = buildRetrievalPlan({
      pages: [page(1, 'An ordinary sentence without technical vocabulary.')],
      pageCount: 300,
      currentPage: 1,
      selection: 'A of the.',
      conceptNames: [],
    });
    expect(plan.notices.some((notice) => notice.includes('没有提取到'))).toBe(true);
    expect(plan.notices.some((notice) => notice.includes('其余 299 页未扫描'))).toBe(true);
    expect(plan.pagesSkipped).toBe(299);
  });

  it('describes itself in one line', () => {
    const plan = buildRetrievalPlan({
      pages: [page(1, selection)],
      pageCount: 1,
      currentPage: 1,
      selection,
      conceptNames: [],
    });
    expect(describePlan(plan)).toContain('使用第 1 页');
    expect(describePlan(plan)).toContain('未截断');
  });
});

describe('plan page ceiling', () => {
  it('never plans more pages than the service accepts, and says what was left out', () => {
    const selection = 'A KZG commitment relies on a bilinear pairing.';
    const pages = Array.from({ length: 8 }, (_, index) =>
      page(index + 1, `KZG commitment and bilinear pairing on page ${String(index + 1)}.`),
    );
    const plan = buildRetrievalPlan({
      pages,
      pageCount: 8,
      currentPage: 1,
      selection,
      conceptNames: [],
      annotations: pages.map((entry) => ({
        page: entry.page,
        quote: `KZG commitment note on page ${String(entry.page)}.`,
        note: '',
      })),
    });
    expect(plan.pagesUsed.length).toBeLessThanOrEqual(6);
    expect(plan.notices.some((notice) => notice.includes('最多分析 6 页'))).toBe(true);
  });
});

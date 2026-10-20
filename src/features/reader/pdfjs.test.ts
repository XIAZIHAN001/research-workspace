import { describe, expect, it } from 'vitest';
import { parsePdfMetadata } from './pdfjs';

describe('parsePdfMetadata', () => {
  it('reads the four fields a well-formed producer writes', () => {
    expect(
      parsePdfMetadata({
        Title: 'Attention Is All You Need',
        // Producers separate authors with a semicolon or "and", not a comma: a comma is
        // already inside "Last, First", so treating it as a separator would halve every name.
        Author: 'Ashish Vaswani; Noam Shazeer',
        CreationDate: "D:20170612132401+02'00'",
        Subject: 'doi:10.1000/xyz123',
      }),
    ).toEqual({
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      doi: '10.1000/xyz123',
    });
  });

  it('returns nothing at all for a PDF that carries no dictionary', () => {
    expect(parsePdfMetadata({})).toEqual({});
    expect(parsePdfMetadata({ Title: '   ' })).toEqual({});
  });

  it('splits authors on every separator the common producers use', () => {
    expect(parsePdfMetadata({ Author: 'A; B and C' }).authors).toEqual(['A', 'B', 'C']);
    expect(parsePdfMetadata({ Author: '张三，李四' }).authors).toEqual(['张三', '李四']);
    expect(parsePdfMetadata({ Author: '张三、王五' }).authors).toEqual(['张三', '王五']);
    expect(parsePdfMetadata({ Author: 'Ada Lovelace & Alan Turing' }).authors).toEqual([
      'Ada Lovelace',
      'Alan Turing',
    ]);
  });

  it('refuses to offer a TeX fragment as an author', () => {
    // A LaTeX producer that forgot to expand the macro leaves control sequences behind.
    expect(parsePdfMetadata({ Author: '{Y. Bengio}, \\and{others}' }).authors).toEqual([
      'Y. Bengio',
      'others',
    ]);
    expect(parsePdfMetadata({ Author: '\\LaTeX' }).authors).toBeUndefined();
  });

  it('flattens a wrapped TeX title to one line', () => {
    expect(parsePdfMetadata({ Title: 'A Very\n  Long   Paper' }).title).toBe(
      'A Very Long Paper',
    );
    // A brace group is a LaTeX macro, not a title a reader wants to see.
    expect(parsePdfMetadata({ Title: '{A Title}' }).title).toBeUndefined();
  });

  it('takes the year from CreationDate in the D:YYYYMMDD form', () => {
    expect(parsePdfMetadata({ CreationDate: "D:20240301120000Z" }).year).toBe(2024);
    expect(parsePdfMetadata({ CreationDate: 'D:1999' }).year).toBe(1999);
    // Not the D: form at all, so no year is claimed.
    expect(parsePdfMetadata({ CreationDate: 'yesterday' }).year).toBeUndefined();
  });

  it('finds a DOI and a year in Subject and Keywords, and in either order', () => {
    expect(parsePdfMetadata({ Keywords: 'accepted 2024, doi:10.1109/5.771073' })).toEqual({
      doi: '10.1109/5.771073',
      year: 2024,
    });
    // CreationDate wins over anything scraped out of the free-text fields.
    expect(
      parsePdfMetadata({ CreationDate: 'D:20200101', Subject: 'published 2019' }).year,
    ).toBe(2020);
  });

  it('does not mistake an arXiv identifier for a year', () => {
    // 2401 is the arXiv YYMM prefix, not a publication year.
    expect(parsePdfMetadata({ Keywords: 'arXiv:2401.12345' }).year).toBeUndefined();
    expect(parsePdfMetadata({ Subject: 'arXiv:2401.12345 doi:10.1000/xyz123' }).doi).toBe(
      '10.1000/xyz123',
    );
  });

  it('strips sentence punctuation a DOI picked up from its surroundings', () => {
    expect(parsePdfMetadata({ Subject: 'See 10.1000/xyz123.' }).doi).toBe('10.1000/xyz123');
    expect(parsePdfMetadata({ Subject: '(10.1000/xyz123)' }).doi).toBe('10.1000/xyz123');
  });

  it('ignores a digit run that is not a plausible year', () => {
    expect(parsePdfMetadata({ Keywords: 'pages 1200-1400' }).year).toBeUndefined();
    expect(parsePdfMetadata({ Keywords: '123456' }).year).toBeUndefined();
  });

  it('ignores values of the wrong type rather than coercing them', () => {
    expect(parsePdfMetadata({ Title: 42, Author: null, CreationDate: 2020 })).toEqual({});
  });
});

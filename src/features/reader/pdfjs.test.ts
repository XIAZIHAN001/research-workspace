import { describe, expect, it } from 'vitest';
import { authorsFromPageText, isPlaceholderAuthor, parsePdfMetadata, readXmpFields } from './pdfjs';

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
    expect(parsePdfMetadata({ Title: 'A Very\n  Long   Paper' }).title).toBe('A Very Long Paper');
    // A brace group is a LaTeX macro, not a title a reader wants to see.
    expect(parsePdfMetadata({ Title: '{A Title}' }).title).toBeUndefined();
  });

  it('takes the year from CreationDate in the D:YYYYMMDD form', () => {
    expect(parsePdfMetadata({ CreationDate: 'D:20240301120000Z' }).year).toBe(2024);
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
    expect(parsePdfMetadata({ CreationDate: 'D:20200101', Subject: 'published 2019' }).year).toBe(
      2020,
    );
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

  it('fills empty fields from the XMP half of the metadata', () => {
    // A producer that writes XMP only (common for Word and journal pipelines): the
    // dictionary is empty, and the paper still has to arrive with its author and year.
    expect(
      parsePdfMetadata(
        {},
        {
          title: 'A Paper Described By XMP Only',
          creators: ['Ada Lovelace', 'Alan Turing'],
          dates: ['2019-04-01T00:00:00Z'],
          identifiers: ['https://doi.org/10.1000/xyz123'],
        },
      ),
    ).toEqual({
      title: 'A Paper Described By XMP Only',
      authors: ['Ada Lovelace', 'Alan Turing'],
      year: 2019,
      doi: '10.1000/xyz123',
    });
  });

  it('lets the information dictionary win where both halves have a field', () => {
    expect(
      parsePdfMetadata(
        { Title: 'Dictionary Title', Author: 'A; B', CreationDate: 'D:20200101' },
        { title: 'XMP Title', creators: ['C'], dates: ['2019-04-01'] },
      ),
    ).toEqual({ title: 'Dictionary Title', authors: ['A', 'B'], year: 2020 });
  });

  it('splits a creator entry that carries its own separators', () => {
    expect(parsePdfMetadata({}, { creators: ['A and B', 'C'] }).authors).toEqual(['A', 'B', 'C']);
    // A macro that survived into XMP is still not a person.
    expect(parsePdfMetadata({}, { creators: ['\\LaTeX'] }).authors).toBeUndefined();
  });

  it('reads an ISO date from XMP without mistaking the month for a boundary', () => {
    // findYear refuses a year followed by a hyphen (page ranges, arXiv ids); a date stamp
    // is the one place a hyphen after the year is legitimate, so it has its own reader.
    expect(parsePdfMetadata({}, { dates: ['2017-06-12'] }).year).toBe(2017);
    expect(parsePdfMetadata({}, { dates: ['not a date'] }).year).toBeUndefined();
    expect(parsePdfMetadata({}, { dates: ['0500-01-01'] }).year).toBeUndefined();
  });
});

describe('readXmpFields', () => {
  const metadataOf = (fields: Record<string, unknown>) => ({
    get: (name: string) => fields[name] ?? null,
  });

  it('collects the paper-relevant fields from an XMP packet', () => {
    expect(
      readXmpFields(
        metadataOf({
          'dc:title': ' Attention Is All You Need ',
          'dc:creator': ['Ashish Vaswani', 'Noam Shazeer'],
          'xmp:CreateDate': '2017-06-12',
          'dc:identifier': 'arXiv:1706.03762v5',
          'prism:doi': '10.48550/arXiv.1706.03762',
        }),
      ),
    ).toEqual({
      title: 'Attention Is All You Need',
      creators: ['Ashish Vaswani', 'Noam Shazeer'],
      dates: ['2017-06-12'],
      identifiers: ['10.48550/arXiv.1706.03762', 'arXiv:1706.03762v5'],
    });
  });

  it('tolerates a single string where a list is usual, and drops empty values', () => {
    expect(readXmpFields(metadataOf({ 'dc:creator': 'Solo Author' }))).toEqual({
      creators: ['Solo Author'],
    });
    expect(readXmpFields(metadataOf({ 'dc:creator': ['  ', 42], 'dc:title': '   ' }))).toEqual({});
  });

  it('returns nothing for an absent or malformed packet', () => {
    expect(readXmpFields(null)).toEqual({});
    expect(readXmpFields(undefined)).toEqual({});
    expect(readXmpFields({})).toEqual({});
    expect(readXmpFields({ get: () => throwIfCalled() })).toEqual({});
  });
});

function throwIfCalled(): never {
  throw new Error('should not be reached');
}

/** One text run, placed by an (x, y) that puts it in reading order when y descends. */
function run(str: string, x: number, y: number) {
  return { str, transform: [1, 0, 0, 1, x, y] };
}

/** A page laid out as lines: each line is a y, each string on that line a run. */
function page(...lines: (readonly [number, readonly string[]])[]) {
  return lines.flatMap(([y, runs]) => runs.map((text, index) => run(text, index * 60, y)));
}

/** A run set in a given type size, which pdf.js reports as the transform's scale. */
function runAt(str: string, x: number, y: number, size: number) {
  return { str, transform: [size, 0, 0, size, x, y] };
}

describe('isPlaceholderAuthor', () => {
  it('recognises the placeholders producers write when they have no author', () => {
    for (const name of [
      'Anonymous Author(s)',
      'anonymous authors',
      'Anonymous',
      'Unknown',
      'Author',
      'N/A',
      '  ',
    ]) {
      expect(isPlaceholderAuthor(name), name).toBe(true);
    }
  });

  it('leaves real names alone, including one that merely contains a keyword', () => {
    for (const name of ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'A. Author III']) {
      expect(isPlaceholderAuthor(name), name).toBe(false);
    }
  });
});

describe('authorsFromPageText', () => {
  const TITLE = 'Attention Is All You Need';

  it('reads the author line between the title and the abstract', () => {
    const items = page(
      [720, ['Attention Is All You Need']],
      [700, ['Ashish Vaswani, Noam Shazeer, Niki Parmar']],
      [690, ['Google Brain']],
      [660, ['Abstract']],
      [640, ['The dominant sequence transduction models are based on complex']],
    );
    expect(authorsFromPageText(items, TITLE)).toEqual([
      'Ashish Vaswani',
      'Noam Shazeer',
      'Niki Parmar',
    ]);
  });

  it('joins runs that belong to one line before reading them', () => {
    const items = [
      ...page([720, ['Attention Is All You Need']]),
      // A name split into three runs, one of them a superscript affiliation mark.
      run('Ashish', 10, 700),
      run('∗', 90, 700.4),
      run('Vaswani', 100, 700),
      ...page([670, ['Abstract']]),
    ];
    expect(authorsFromPageText(items, TITLE)).toEqual(['Ashish Vaswani']);
  });

  it('drops affiliations, emails, footnotes and superscript markers', () => {
    const items = page(
      [720, ['Deep Residual Learning for Image Recognition']],
      [704, ['Kaiming He1 , Xiangyu Zhang1 , Shaoqing Ren1 , Jian Sun1']],
      [694, ['1 Microsoft Research Asia']],
      [692, ['{kahe,xiaoz}@microsoft.com']],
      [676, ['∗ Equal contribution']],
      [650, ['Abstract']],
    );
    expect(authorsFromPageText(items, 'Deep Residual Learning for Image Recognition')).toEqual([
      'Kaiming He',
      'Xiangyu Zhang',
      'Shaoqing Ren',
      'Jian Sun',
    ]);
  });

  it('follows a title that wraps onto a second line', () => {
    const items = page(
      [720, ['Scaling Laws for Neural Language Models:']],
      [708, ['A Study of the Compute-Optimal Frontier']],
      [690, ['Jared Kaplan, Sam McCandlish']],
      [660, ['Abstract']],
    );
    expect(
      authorsFromPageText(
        items,
        'Scaling Laws for Neural Language Models: A Study of the Compute-Optimal Frontier',
      ),
    ).toEqual(['Jared Kaplan', 'Sam McCandlish']);
  });

  it('stops at the first section heading when there is no abstract', () => {
    const items = page(
      [720, ['A Paper']],
      [700, ['Jane Doe']],
      [688, ['Some sentence that is definitely not a name at all']],
      [676, ['1 Introduction']],
      [664, ['John Smith']],
    );
    expect(authorsFromPageText(items, 'A Paper')).toEqual(['Jane Doe']);
  });

  it('reads Chinese names and keeps them whole', () => {
    const items = page(
      [720, ['面向论文阅读的解构方法']],
      [700, ['张伟, 李娜, 王强']],
      [690, ['清华大学计算机科学与技术系']],
      [660, ['摘要']],
      [640, ['本文提出']],
    );
    expect(authorsFromPageText(items, '面向论文阅读的解构方法')).toEqual(['张伟', '李娜', '王强']);
  });

  it('returns nothing rather than guessing when the page has no author block', () => {
    const items = page(
      [720, ['A Paper Without Authors Listed']],
      [700, ['Abstract']],
      [680, ['Body text begins here.']],
    );
    expect(authorsFromPageText(items, 'A Paper Without Authors Listed')).toEqual([]);
  });

  it('returns nothing for a page with no text at all', () => {
    expect(authorsFromPageText([])).toEqual([]);
  });

  it('reads from the top of the page when the metadata title is unknown', () => {
    const items = page(
      [720, ['Some Other Title']],
      [700, ['Ada Lovelace, Alan Turing']],
      [670, ['Abstract']],
    );
    expect(authorsFromPageText(items)).toEqual(['Ada Lovelace', 'Alan Turing']);
  });

  it('anchors on the file-name title when the abstract heading sits above the title', () => {
    const items = page(
      [760, ['Abstract']],
      [730, ['Dynamic Zero-Knowledge Proofs and Their Applications']],
      [710, ['Weijie Wang']],
      [700, ['2026']],
      [680, ['This dissertation introduces valid source proof']],
    );
    expect(authorsFromPageText(items, 'Dynamic Zero Knowledge Proofs')).toEqual(['Weijie Wang']);
  });

  it('finds the title by its type when neither metadata nor file name names it', () => {
    const items = [
      runAt('Abstract', 0, 760, 9),
      runAt('Dynamic Zero-Knowledge Proofs and Their Applications', 0, 730, 17),
      runAt('Weijie Wang', 0, 710, 10),
      runAt('2026', 0, 700, 10),
      runAt('This dissertation introduces valid source proof', 0, 680, 10),
      runAt('and discusses the feasibility of the approach', 0, 660, 10),
    ];
    expect(authorsFromPageText(items)).toEqual(['Weijie Wang']);
  });
});

import { describe, expect, it } from 'vitest';
import type { Annotation } from './annotation';
import { buildNotesMarkdown, notesFileName } from './notesMarkdown';
import type { Paper } from './papers';

const PAPER: Paper = {
  id: 'paper-1',
  title: 'A Paper About Things',
  authors: ['Ada Lovelace', 'Alan Turing'],
  year: 2024,
  doi: '10.1000/xyz',
  createdAt: 0,
  updatedAt: 0,
};

function note(overrides: Partial<Annotation>): Annotation {
  return {
    id: 'note-1',
    paperId: PAPER.id,
    pdfSha256: 'sha',
    page: 1,
    quote: 'the quoted words',
    prefix: '',
    suffix: '',
    rects: [],
    kind: 'insight',
    note: 'my thoughts',
    origin: 'user',
    sourceLabel: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildNotesMarkdown', () => {
  it("keeps the paper's metadata and counts the notes", () => {
    const markdown = buildNotesMarkdown({
      paper: PAPER,
      annotations: [note({})],
      exportedAt: new Date(2026, 9, 21, 9, 5),
    });
    expect(markdown).toContain('# A Paper About Things');
    expect(markdown).toContain('Ada Lovelace、Alan Turing · 2024 · DOI: 10.1000/xyz');
    expect(markdown).toContain('笔记：1 条');
    expect(markdown).toContain('导出时间：2026-10-21 09:05');
  });

  it('groups by page and orders notes within a page by when they were written', () => {
    const markdown = buildNotesMarkdown({
      paper: PAPER,
      annotations: [
        note({ id: 'late', page: 2, createdAt: 2, note: 'second page' }),
        note({ id: 'second', page: 1, createdAt: 2, note: 'later on one' }),
        note({ id: 'first', page: 1, createdAt: 1, note: 'earlier on one' }),
      ],
    });
    expect(markdown.indexOf('## 第 1 页')).toBeLessThan(markdown.indexOf('## 第 2 页'));
    expect(markdown.indexOf('earlier on one')).toBeLessThan(markdown.indexOf('later on one'));
  });

  it('quotes every line of a multi-line passage', () => {
    const markdown = buildNotesMarkdown({
      paper: PAPER,
      annotations: [note({ quote: 'first line\nsecond line' })],
    });
    expect(markdown).toContain('> first line\n> second line');
  });

  it('marks AI-assisted notes and keeps their kind', () => {
    const markdown = buildNotesMarkdown({
      paper: PAPER,
      annotations: [note({ kind: 'question', origin: 'assistant' })],
    });
    expect(markdown).toContain('**疑问** · AI 辅助');
  });

  it('says so when there are no notes', () => {
    const markdown = buildNotesMarkdown({ paper: PAPER, annotations: [] });
    expect(markdown).toContain('还没有笔记。');
    expect(markdown).toContain('笔记：0 条');
  });

  it('leaves out notes that belong to another paper', () => {
    const markdown = buildNotesMarkdown({
      paper: PAPER,
      annotations: [note({ paperId: 'other', note: 'not mine' })],
    });
    expect(markdown).not.toContain('not mine');
    expect(markdown).toContain('笔记：0 条');
  });

  it('uses arXiv when there is no DOI', () => {
    const markdown = buildNotesMarkdown({
      paper: { ...PAPER, doi: undefined, arxivId: '2401.12345' },
      annotations: [],
    });
    expect(markdown).toContain('arXiv: 2401.12345');
  });
});

describe('notesFileName', () => {
  it('replaces characters no file system accepts', () => {
    expect(notesFileName({ ...PAPER, title: 'Why: a/b? "yes"' })).toBe('Why a b yes.md');
  });

  it('shortens a long title and keeps the extension', () => {
    const name = notesFileName({ ...PAPER, title: 'x'.repeat(120) });
    expect(name).toHaveLength(63);
    expect(name.endsWith('.md')).toBe(true);
  });

  it('falls back when the title has nothing usable left', () => {
    expect(notesFileName({ ...PAPER, title: '///' })).toBe('论文笔记.md');
  });
});

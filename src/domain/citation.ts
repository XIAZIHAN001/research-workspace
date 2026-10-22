import type { Paper } from './papers';

/**
 * BibTeX for one paper.
 *
 * Keys are short and stable enough to cite: first author's surname, the year, and the first
 * meaningful word of the title. When two papers would produce the same key, the caller passes
 * the keys already in use and the paper's own id is appended — never a counter, which would
 * change whenever a paper earlier in the list was added or removed.
 */

const LATEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  '#': '\\#',
  _: '\\_',
  $: '\\$',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
};

export function escapeBibtex(value: string): string {
  return value.replace(/[\\{}&%#_$^~]/g, (character) => LATEX_ESCAPES[character] ?? character);
}

/** The part of an author's name a citation key uses. Handles both "Ada Lovelace" and "Lovelace, Ada". */
function surname(author: string): string {
  const trimmed = author.trim();
  if (trimmed === '') return '';
  if (trimmed.includes(',')) return trimmed.split(',')[0]?.trim() ?? '';
  const parts = trimmed.split(/\s+/);
  return parts.at(-1) ?? '';
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'on',
  'of',
  'for',
  'and',
  'to',
  'in',
  'with',
  'is',
  'are',
  'towards',
  'toward',
]);

/** The first title word that is not an article or a preposition. */
function titleWord(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
  const meaningful = words.find((word) => !STOP_WORDS.has(word.toLowerCase()));
  return (meaningful ?? words[0] ?? 'paper').slice(0, 24);
}

function keyPart(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

/**
 * The citation key for a paper.
 *
 * `taken` is the other keys in the same bibliography. Comparison is case-insensitive because
 * BibTeX treats keys case-insensitively in practice.
 */
export function bibtexKey(paper: Paper, taken: readonly string[] = []): string {
  const parts = [
    keyPart(surname(paper.authors[0] ?? '') || 'paper'),
    paper.year === undefined ? 'nd' : String(paper.year),
    keyPart(titleWord(paper.title)),
  ];
  let key = parts.join('') || 'paper';
  const clash = taken.some((other) => other.toLowerCase() === key.toLowerCase());
  if (clash) {
    const suffix = keyPart(paper.id);
    key = suffix === '' ? key : `${key}-${suffix}`;
  }
  return key;
}

/**
 * One paper as a BibTeX entry.
 *
 * A paper with a year is an `@article`; without one there is not enough to claim a journal or a
 * proceedings volume, and `@misc` is the honest entry type for a record with only a title.
 */
export function toBibtex(paper: Paper, taken: readonly string[] = []): string {
  const entryType = paper.year === undefined ? 'misc' : 'article';
  const fields: string[] = [`  title = {${escapeBibtex(paper.title)}}`];
  if (paper.authors.length > 0) {
    fields.push(`  author = {${paper.authors.map(escapeBibtex).join(' and ')}}`);
  }
  if (paper.year !== undefined) fields.push(`  year = {${String(paper.year)}}`);
  if (paper.doi !== undefined) fields.push(`  doi = {${escapeBibtex(paper.doi)}}`);
  if (paper.arxivId !== undefined) {
    fields.push(`  eprint = {${escapeBibtex(paper.arxivId)}}`);
    fields.push('  archivePrefix = {arXiv}');
  }
  const url =
    paper.doi !== undefined
      ? `https://doi.org/${paper.doi}`
      : paper.arxivId === undefined
        ? null
        : `https://arxiv.org/abs/${paper.arxivId}`;
  if (url !== null) fields.push(`  url = {${escapeBibtex(url)}}`);

  return `@${entryType}{${bibtexKey(paper, taken)},\n${fields.join(',\n')}\n}\n`;
}

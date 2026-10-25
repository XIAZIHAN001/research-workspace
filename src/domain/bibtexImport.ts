import { normalizeArxivId, normalizeDoi } from './papers';

/**
 * BibTeX in, papers out.
 *
 * The goal is not a faithful BibTeX compiler — exporters disagree far more than the format
 * admits — but a reader that takes the file a reference manager or a publisher offers and
 * turns it into records worth keeping. Anything that cannot be read is skipped and *said so*,
 * never guessed into a half-paper.
 */

export interface BibtexEntry {
  /** The citation key, kept for the preview so the reader can find it in the file. */
  key: string;
  title: string;
  authors: string[];
  year?: number;
  /** Normalized DOI, lowercase. Only set when the field really is a DOI. */
  doi?: string;
  /** Normalized arXiv id. From `eprint` (with an arXiv prefix) or a recognizable URL. */
  arxivId?: string;
}

/** One entry the parser refused, with the reason in the reader's language. */
export interface BibtexSkipped {
  key: string;
  reason: string;
}

export interface BibtexParseResult {
  entries: BibtexEntry[];
  skipped: BibtexSkipped[];
}

/** Entry types that are metadata, not citations. */
const NON_ENTRY_TYPES = new Set(['comment', 'string', 'preamble']);

/** Undoes the escaping `toBibtex` does, and the braces exporters use to protect casing. */
function unlatex(value: string): string {
  // Control characters as sentinels: they cannot appear in a field value, so an escaped
  // brace survives the brace-stripping pass below as the literal character it is.
  const openSentinel = String.fromCharCode(1);
  const closeSentinel = String.fromCharCode(2);
  return (
    value
      .replace(/\s+/g, ' ')
      .replace(/\\textbackslash\{\}/g, '\\')
      .replace(/\\textasciicircum\{\}/g, '^')
      .replace(/\\textasciitilde\{\}/g, '~')
      // An escaped brace is a literal character, not protection: park it on sentinels so the
      // brace-stripping pass below cannot eat what the reader actually wrote.
      .replace(/\\([{}])/g, (_, brace: string) => (brace === '{' ? openSentinel : closeSentinel))
      .replace(/\\([&%#_$])/g, '$1')
      .replace(/[{}]/g, '')
      .split(openSentinel)
      .join('{')
      .split(closeSentinel)
      .join('}')
      .trim()
  );
}

/** The body of one entry, from after `@type{` to its matching close, with nesting counted. */
function entryBody(text: string, openIndex: number): { body: string; end: number } | null {
  const open = text[openIndex];
  const close = open === '{' ? '}' : ')';
  let depth = 1;
  let index = openIndex + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      // A `}` that closes an inner group lands at depth 0 for a paren-delimited entry too,
      // because `}` never decrements below the group it belongs to. Only the matching
      // delimiter at the entry's own depth may close the entry.
      if (depth === 0 && close === '}')
        return { body: text.slice(openIndex + 1, index), end: index };
      if (depth === 0) depth = 1;
    } else if (character === close && depth === 1) {
      return { body: text.slice(openIndex + 1, index), end: index };
    }
    index += 1;
  }
  return null;
}

/** One field's value: `{…}` with nesting, `"…"` with brace escapes, or a bare token. */
function readValue(body: string, start: number): { value: string; end: number } | null {
  let index = start;
  while (index < body.length && body[index] === ' ') index += 1;
  if (index >= body.length) return null;
  const quote = body[index];
  if (quote === '{') {
    let depth = 1;
    index += 1;
    const begin = index;
    while (index < body.length) {
      if (body[index] === '{') depth += 1;
      else if (body[index] === '}') {
        depth -= 1;
        if (depth === 0) return { value: body.slice(begin, index), end: index + 1 };
      }
      index += 1;
    }
    return null;
  }
  if (quote === '"') {
    const begin = index + 1;
    let close = body.indexOf('"', begin);
    // A brace-escaped quote inside a quoted value does not close it.
    while (close > 0 && body[close - 1] === '\\') close = body.indexOf('"', close + 1);
    if (close < 0) return null;
    return { value: body.slice(begin, close), end: close + 1 };
  }
  const begin = index;
  while (index < body.length && body[index] !== ',' && body[index] !== ' ') index += 1;
  return { value: body.slice(begin, index), end: index };
}

/**
 * Reads `name = value` pairs separated by commas. Concatenation (`#`) is treated as one more
 * value glued on, which is what it means; unknown syntax ends the field list rather than the
 * whole file.
 */
function readFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  let index = 0;
  while (index < body.length) {
    while (index < body.length && /[\s,]/.test(body[index] ?? '')) index += 1;
    if (index >= body.length) break;
    const nameMatch = /^[A-Za-z][A-Za-z0-9_-]*/.exec(body.slice(index));
    if (nameMatch === null) break;
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    while (index < body.length && body[index] === ' ') index += 1;
    if (body[index] !== '=') break;
    index += 1;
    let value = '';
    for (;;) {
      const part = readValue(body, index);
      if (part === null) {
        index = body.length;
        break;
      }
      value = value === '' ? part.value : `${value}${part.value}`;
      index = part.end;
      while (index < body.length && body[index] === ' ') index += 1;
      if (body[index] !== '#') break;
      index += 1;
    }
    fields.set(name, value);
  }
  return fields;
}

/** Splits a BibTeX author list on `and`, keeping each name as the file spelled it. */
function splitAuthors(raw: string): string[] {
  return raw
    .replace(/\s+and\s+/gi, '\n')
    .split('\n')
    .map((author) => unlatex(author))
    .filter((author) => author !== '');
}

/** A URL can carry the DOI or the arXiv id when the fields do not say so outright. */
function identifiersFromUrl(url: string): { doi?: string; arxivId?: string } {
  const doi = normalizeDoi(url);
  if (doi !== null) return { doi };
  const arxivId = normalizeArxivId(url);
  if (arxivId !== null) return { arxivId };
  return {};
}

/**
 * Parses a .bib file. Every `@entry` the reader can understand becomes a `BibtexEntry`;
 * the rest are reported with a reason instead of being silently dropped.
 */
export function parseBibtex(text: string): BibtexParseResult {
  const entries: BibtexEntry[] = [];
  const skipped: BibtexSkipped[] = [];
  let index = 0;

  for (;;) {
    const at = text.indexOf('@', index);
    if (at < 0) break;
    const head = /^@([A-Za-z]+)\s*([({])/.exec(text.slice(at, at + 40));
    if (head === null) {
      index = at + 1;
      continue;
    }
    const type = (head[1] ?? '').toLowerCase();
    const openIndex = at + head[0].length - 1;
    const parsed = entryBody(text, openIndex);
    if (parsed === null) {
      skipped.push({ key: type, reason: '条目没有闭合，文件可能被截断' });
      break;
    }
    index = parsed.end + 1;

    if (NON_ENTRY_TYPES.has(type)) continue;
    const comma = parsed.body.indexOf(',');
    const key = (comma < 0 ? parsed.body : parsed.body.slice(0, comma)).trim();
    const fields = readFields(comma < 0 ? '' : parsed.body.slice(comma + 1));

    const title = unlatex(fields.get('title') ?? '');
    if (title === '') {
      skipped.push({ key: key === '' ? type : key, reason: '没有可用的标题' });
      continue;
    }
    const yearRaw = fields.get('year');
    const year =
      yearRaw === undefined || !/^\d{1,4}$/.test(yearRaw.trim()) ? undefined : Number(yearRaw);

    const doi = normalizeDoi(fields.get('doi') ?? '');
    const eprint = normalizeArxivId(fields.get('eprint') ?? '');
    const fromUrl = identifiersFromUrl(fields.get('url') ?? '');

    const entry: BibtexEntry = { key, title, authors: splitAuthors(fields.get('author') ?? '') };
    if (year !== undefined) entry.year = year;
    if (doi !== null) entry.doi = doi;
    else if (fromUrl.doi !== undefined && eprint === null) entry.doi = fromUrl.doi;
    if (eprint !== null) entry.arxivId = eprint;
    else if (fromUrl.arxivId !== undefined) entry.arxivId = fromUrl.arxivId;
    entries.push(entry);
  }

  return { entries, skipped };
}

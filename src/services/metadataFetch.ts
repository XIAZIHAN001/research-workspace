import { normalizeArxivId, normalizeDoi } from '../domain/papers';

/**
 * Button-triggered metadata lookup: given a DOI or an arXiv id, ask the public registries what
 * they know and hand back title/authors/year for the reader to review in the edit dialog.
 *
 * This is the app's only network read, and it happens only when the reader asks: nothing here
 * runs on a timer, on import, or in the background. A DOI is preferred (the publisher's record
 * is the authoritative one); arXiv answers for preprints.
 */

export interface FetchedMetadata {
  title?: string;
  authors?: string[];
  year?: number;
}

export type MetadataFetchOutcome =
  | { status: 'ok'; metadata: FetchedMetadata }
  /** Neither field names a registry record worth asking. */
  | { status: 'no-identifier' }
  /** The request could not be made or did not arrive: offline, blocked or timed out. */
  | { status: 'unreachable' }
  /** The registry answered that it does not know this identifier. */
  | { status: 'not-found' };

const TIMEOUT = 8000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchPaperMetadata(
  ids: { doi?: string | null; arxivId?: string | null },
  fetchImpl: FetchLike = fetch,
): Promise<MetadataFetchOutcome> {
  const doi = ids.doi == null ? null : normalizeDoi(ids.doi);
  if (doi !== null) return fromCrossref(doi, fetchImpl);
  const arxivId = ids.arxivId == null ? null : normalizeArxivId(ids.arxivId);
  if (arxivId !== null) return fromArxiv(arxivId, fetchImpl);
  return { status: 'no-identifier' };
}

async function request(
  url: string,
  fetchImpl: FetchLike,
): Promise<'offline' | 'not-found' | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (response.status === 404) return 'not-found';
    if (!response.ok) return 'offline';
    return await response.text();
  } catch {
    return 'offline';
  } finally {
    clearTimeout(timer);
  }
}

async function fromCrossref(doi: string, fetchImpl: FetchLike): Promise<MetadataFetchOutcome> {
  // Crossref addresses the DOI with its slash unencoded; the rest of the charset is already
  // constrained by normalizeDoi.
  const encoded = encodeURIComponent(doi).replace(/%2F/g, '/');
  const body = await request(`https://api.crossref.org/works/${encoded}`, fetchImpl);
  if (body === 'offline') return { status: 'unreachable' };
  if (body === 'not-found') return { status: 'not-found' };
  try {
    const message = (JSON.parse(body) as { message?: Record<string, unknown> }).message;
    if (message === undefined) return { status: 'not-found' };
    const title = firstString(message.title);
    const authors = Array.isArray(message.author)
      ? message.author
          .map((author) => {
            if (typeof author !== 'object' || author === null) return '';
            const record = author as Record<string, unknown>;
            const given = firstString(record.given);
            const family = firstString(record.family);
            return [given, family]
              .filter((part) => part !== null)
              .join(' ')
              .trim();
          })
          .filter((name) => name !== '')
      : undefined;
    const year = issuedYear(message.issued);
    if (title === null && authors === undefined && year === undefined) {
      return { status: 'not-found' };
    }
    return {
      status: 'ok',
      metadata: {
        ...(title === null ? {} : { title }),
        ...(authors === undefined ? {} : { authors }),
        ...(year === undefined ? {} : { year }),
      },
    };
  } catch {
    return { status: 'not-found' };
  }
}

async function fromArxiv(arxivId: string, fetchImpl: FetchLike): Promise<MetadataFetchOutcome> {
  const body = await request(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`,
    fetchImpl,
  );
  if (body === 'offline') return { status: 'unreachable' };
  if (body === 'not-found') return { status: 'not-found' };
  try {
    const xml = new DOMParser().parseFromString(body, 'application/xml');
    const entry = xml.querySelector('entry');
    if (entry === null) return { status: 'not-found' };
    const rawTitle = entry.querySelector('title')?.textContent ?? '';
    const title = rawTitle.replace(/\s+/g, ' ').trim();
    // arXiv answers an error entry with the id echoed and no real title; that is a miss.
    if (title === '' || title.toLowerCase().includes('error')) return { status: 'not-found' };
    const authors = [...entry.querySelectorAll('author > name')]
      .map((node) => (node.textContent ?? '').trim())
      .filter((name) => name !== '');
    const published = entry.querySelector('published')?.textContent ?? '';
    const yearMatch = /(\d{4})/.exec(published);
    const year = yearMatch === null ? undefined : Number(yearMatch[1]);
    return {
      status: 'ok',
      metadata: {
        title,
        ...(authors.length === 0 ? {} : { authors }),
        ...(year === undefined ? {} : { year }),
      },
    };
  } catch {
    return { status: 'not-found' };
  }
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim() || null;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first.replace(/\s+/g, ' ').trim() || null : null;
  }
  return null;
}

function issuedYear(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const parts = (value as Record<string, unknown>)['date-parts'];
  if (!Array.isArray(parts)) return undefined;
  const first = parts[0];
  if (!Array.isArray(first) || typeof first[0] !== 'number') return undefined;
  return first[0];
}

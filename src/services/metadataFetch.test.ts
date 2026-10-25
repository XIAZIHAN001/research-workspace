import { describe, expect, it, vi } from 'vitest';
import { fetchPaperMetadata } from './metadataFetch';

const CROSSREF_BODY = JSON.stringify({
  message: {
    title: ['Attention Is All You Need'],
    author: [{ given: 'Ashish', family: 'Vaswani' }, { family: 'Shazeer' }],
    issued: { 'date-parts': [[2017, 6]] },
  },
});

const ARXIV_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2610.22294v2</id>
    <published>2026-10-28T12:00:00Z</published>
    <title>Multi-Target  Few-Shot
      Prompting</title>
    <author><name>Xue Yi</name></author>
    <author><name>Someone Else</name></author>
  </entry>
</feed>`;

type FetchMock = ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;

const ok = (body: string): Promise<Response> =>
  Promise.resolve(new Response(body, { status: 200 }));

describe('fetchPaperMetadata', () => {
  it('asks Crossref first when a DOI is given', async () => {
    const fetchImpl: FetchMock = vi.fn(() => ok(CROSSREF_BODY));
    const outcome = await fetchPaperMetadata(
      { doi: '10.5555/3295222', arxivId: '2401.1' },
      fetchImpl,
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('api.crossref.org/works/10.5555/3295222');
    expect(outcome).toStrictEqual({
      status: 'ok',
      metadata: {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Shazeer'],
        year: 2017,
      },
    });
  });

  it('parses the arXiv Atom answer, collapsing the title whitespace', async () => {
    const fetchImpl: FetchMock = vi.fn(() => ok(ARXIV_BODY));
    const outcome = await fetchPaperMetadata({ doi: null, arxivId: '2610.22294v2' }, fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('export.arxiv.org/api/query');
    expect(outcome).toStrictEqual({
      status: 'ok',
      metadata: {
        title: 'Multi-Target Few-Shot Prompting',
        authors: ['Xue Yi', 'Someone Else'],
        year: 2026,
      },
    });
  });

  it('says unreachable when the network refuses, and not-found on a 404', async () => {
    const offline: FetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await fetchPaperMetadata({ doi: '10.1000/xyz' }, offline)).toStrictEqual({
      status: 'unreachable',
    });
    const missing: FetchMock = vi.fn(() => Promise.resolve(new Response('nope', { status: 404 })));
    expect(await fetchPaperMetadata({ doi: '10.1000/xyz' }, missing)).toStrictEqual({
      status: 'not-found',
    });
  });

  it('refuses to ask anything without a usable identifier', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchPaperMetadata({ doi: 'not-a-doi', arxivId: '' }, fetchImpl)).toStrictEqual({
      status: 'no-identifier',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats an arXiv error entry as a miss rather than garbage metadata', async () => {
    const errorBody = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/9999.99999</id><title>Error</title></entry></feed>`;
    const fetchImpl: FetchMock = vi.fn(() => ok(errorBody));
    expect(await fetchPaperMetadata({ arxivId: '9999.99999' }, fetchImpl)).toStrictEqual({
      status: 'not-found',
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { PaperPdf } from '../../domain/pdfFile';
import {
  applyPaperEdit,
  createPaper,
  resolvePaperIdentity,
  type AddPaperOutcome,
  type Paper,
  type PaperEdit,
  type PaperEditResult,
  type PaperInput,
  type PaperReferenceOutcome,
} from '../../domain/papers';
import { commitImport, describeEditFailure, type ImportPorts } from './importPaperFlow';

const PDF: PaperPdf = {
  sha256: 'a'.repeat(64),
  name: 'attention.pdf',
  bytes: 2048,
  pageCount: 11,
  addedAt: 100,
};
const OTHER_PDF: PaperPdf = { ...PDF, sha256: 'b'.repeat(64) };

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return { id, title: `Paper ${id}`, authors: [], createdAt: 0, updatedAt: 0, ...overrides };
}

interface Harness {
  ports: ImportPorts;
  papers: Record<string, Paper>;
  edits: { paperId: string; edit: PaperEdit }[];
  references: { projectId: string; input: PaperInput }[];
  links: { projectId: string; paperId: string }[];
  added: PaperInput[];
}

/**
 * Real domain functions behind the ports, so these tests exercise the same rules the app
 * does; the harness only records what the flow asked for and in what order.
 */
function harness(initial: Record<string, Paper> = {}): Harness {
  const state = { papers: { ...initial } } as { papers: Record<string, Paper> };
  const log = {
    edits: [] as { paperId: string; edit: PaperEdit }[],
    references: [] as { projectId: string; input: PaperInput }[],
    links: [] as { projectId: string; paperId: string }[],
    added: [] as PaperInput[],
    calls: [] as string[],
  };
  let nextId = 0;

  const ports: ImportPorts = {
    get papers() {
      return state.papers;
    },
    updatePaper(paperId: string, edit: PaperEdit): PaperEditResult {
      log.edits.push({ paperId, edit });
      log.calls.push('updatePaper');
      const result = applyPaperEdit(state.papers, paperId, edit, 1);
      if (result.ok) state.papers = { ...state.papers, [paperId]: result.paper };
      return result;
    },
    referencePaper(projectId: string, input: PaperInput): PaperReferenceOutcome {
      log.references.push({ projectId, input });
      log.calls.push('referencePaper');
      const identity = resolvePaperIdentity(state.papers, input);
      if (identity.kind === 'conflict') return { status: 'conflict', papers: identity.papers };
      if (identity.kind === 'match') return { status: 'linked', paper: identity.paper };
      nextId += 1;
      const created = createPaper(input, () => `new-${String(nextId)}`, 1);
      if (created === null) return { status: 'invalid' };
      state.papers = { ...state.papers, [created.id]: created };
      return { status: 'linked', paper: created };
    },
    addPaper(input: PaperInput): AddPaperOutcome {
      log.added.push(input);
      log.calls.push('addPaper');
      const identity = resolvePaperIdentity(state.papers, input);
      if (identity.kind === 'conflict') return { status: 'conflict', papers: identity.papers };
      if (identity.kind === 'match') return { status: 'added', paper: identity.paper };
      nextId += 1;
      const created = createPaper(input, () => `new-${String(nextId)}`, 1);
      if (created === null) return { status: 'invalid' };
      state.papers = { ...state.papers, [created.id]: created };
      return { status: 'added', paper: created };
    },
    linkPaper(projectId: string, paperId: string): void {
      log.links.push({ projectId, paperId });
      log.calls.push('linkPaper');
    },
  };

  return {
    ports,
    get papers() {
      return state.papers;
    },
    edits: log.edits,
    references: log.references,
    links: log.links,
    added: log.added,
  };
}

const byDoi = paper('by-doi', { title: 'By DOI', doi: '10.1000/a' });
const byArxiv = paper('by-arxiv', { title: 'By arXiv', arxivId: '2401.12345' });

describe('commitImport: importing a new paper', () => {
  it('creates the paper with the file and adds it to the project', () => {
    const harnessed = harness();
    const outcome = commitImport(
      harnessed.ports,
      { kind: 'new-paper', projectId: 'p1' },
      { title: 'Attention', doi: '10.1000/attention' },
      PDF,
    );

    expect(outcome).toStrictEqual({ status: 'created', paperId: 'new-1' });
    expect(harnessed.references).toHaveLength(1);
    expect(harnessed.references[0]?.projectId).toBe('p1');
    expect(harnessed.references[0]?.input.pdf).toStrictEqual(PDF);
    expect(harnessed.papers['new-1']?.pdf).toStrictEqual(PDF);
  });

  it('adds it to the library alone when no project was named', () => {
    const harnessed = harness();
    const outcome = commitImport(
      harnessed.ports,
      { kind: 'new-paper', projectId: null },
      { title: 'Attention' },
      PDF,
    );

    expect(outcome.status).toBe('created');
    expect(harnessed.added).toHaveLength(1);
    expect(harnessed.links).toStrictEqual([]);
    expect(harnessed.references).toStrictEqual([]);
  });

  it('recognises an existing paper by DOI instead of creating a second one', () => {
    const harnessed = harness({ 'by-doi': byDoi });
    const outcome = commitImport(
      harnessed.ports,
      { kind: 'new-paper', projectId: 'p1' },
      { title: 'Attention Is All You Need', doi: 'https://doi.org/10.1000/A' },
      PDF,
    );

    expect(outcome).toStrictEqual({ status: 'recognised', paperId: 'by-doi' });
    expect(Object.keys(harnessed.papers)).toStrictEqual(['by-doi']);
    expect(harnessed.edits).toHaveLength(1);
    expect(harnessed.papers['by-doi']?.pdf).toStrictEqual(PDF);
    expect(harnessed.papers['by-doi']?.title).toBe('Attention Is All You Need');
    expect(harnessed.links).toStrictEqual([{ projectId: 'p1', paperId: 'by-doi' }]);
  });

  it('recognises an existing paper by arXiv id too', () => {
    const harnessed = harness({ 'by-arxiv': byArxiv });
    const outcome = commitImport(
      harnessed.ports,
      { kind: 'new-paper', projectId: null },
      { title: 'A new preprint', arxivId: 'arXiv:2401.12345v2' },
      PDF,
    );
    expect(outcome).toStrictEqual({ status: 'recognised', paperId: 'by-arxiv' });
    expect(harnessed.links).toStrictEqual([]);
  });

  it('refuses, and writes nothing, when the identifiers point at different papers', () => {
    const harnessed = harness({ 'by-doi': byDoi, 'by-arxiv': byArxiv });
    const outcome = commitImport(
      harnessed.ports,
      { kind: 'new-paper', projectId: 'p1' },
      { title: 'Attention', doi: '10.1000/a', arxivId: '2401.12345' },
      PDF,
    );

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.message).toContain('By DOI');
    expect(outcome.status === 'refused' && outcome.message).toContain('By arXiv');
    expect(harnessed.edits).toStrictEqual([]);
    expect(harnessed.references).toStrictEqual([]);
    expect(harnessed.links).toStrictEqual([]);
    expect(harnessed.papers['by-doi']?.pdf).toBeUndefined();
  });

  it('refuses a blank title without writing anything', () => {
    const harnessed = harness();
    const outcome = commitImport(
      harnessed.ports,
      { kind: 'new-paper', projectId: 'p1' },
      { title: '   ' },
      PDF,
    );
    expect(outcome).toStrictEqual({ status: 'refused', message: '请填写论文标题。' });
    expect(harnessed.references).toStrictEqual([]);
  });
});

describe('commitImport: attaching a file to an existing paper', () => {
  it('attaches the file and adds the paper to the project', () => {
    const harnessed = harness({ target: paper('target', { title: 'Attention' }) });
    const outcome = commitImport(
      harnessed.ports,
      { kind: 'attach-file', paperId: 'target', projectId: 'p1' },
      { title: 'Attention' },
      PDF,
    );

    expect(outcome).toStrictEqual({ status: 'attached', paperId: 'target' });
    expect(harnessed.papers.target?.pdf).toStrictEqual(PDF);
    expect(harnessed.links).toStrictEqual([{ projectId: 'p1', paperId: 'target' }]);
    expect(harnessed.references).toStrictEqual([]);
  });

  it('replaces an earlier file without touching any other paper', () => {
    const harnessed = harness({
      target: paper('target', { pdf: PDF }),
      other: paper('other', { pdf: PDF }),
    });
    commitImport(
      harnessed.ports,
      { kind: 'attach-file', paperId: 'target', projectId: null },
      { title: 'Attention' },
      OTHER_PDF,
    );

    expect(harnessed.papers.target?.pdf?.sha256).toBe(OTHER_PDF.sha256);
    // The other paper keeps the file it had, untouched.
    expect(harnessed.papers.other?.pdf).toStrictEqual(PDF);
    expect(harnessed.links).toStrictEqual([]);
  });

  it('refuses an identifier that belongs to another paper', () => {
    const harnessed = harness({
      target: paper('target', { title: 'Attention' }),
      owner: paper('owner', { title: 'BERT', doi: '10.1000/bert' }),
    });
    const outcome = commitImport(
      harnessed.ports,
      { kind: 'attach-file', paperId: 'target', projectId: 'p1' },
      { title: 'Attention', doi: '10.1000/bert' },
      PDF,
    );

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.message).toContain('BERT');
    expect(harnessed.papers.target?.pdf).toBeUndefined();
    expect(harnessed.papers.target?.doi).toBeUndefined();
    expect(harnessed.links).toStrictEqual([]);
  });

  it('clears an identifier the user removed in the form', () => {
    const harnessed = harness({ target: paper('target', { doi: '10.1000/old' }) });
    commitImport(
      harnessed.ports,
      { kind: 'attach-file', paperId: 'target', projectId: null },
      { title: 'Attention', doi: '' },
      PDF,
    );
    expect(harnessed.papers.target).not.toHaveProperty('doi');
  });

  it('reports a paper that no longer exists', () => {
    const harnessed = harness();
    const outcome = commitImport(
      harnessed.ports,
      { kind: 'attach-file', paperId: 'ghost', projectId: null },
      { title: 'Attention' },
      PDF,
    );
    expect(outcome).toStrictEqual({ status: 'refused', message: '找不到这篇论文，可能已被删除。' });
  });
});

describe('describeEditFailure', () => {
  it('explains every refusal in the user’s terms', () => {
    const messages = [
      describeEditFailure({ reason: 'blank-title' }),
      describeEditFailure({ reason: 'invalid-year', value: Number.NaN }),
      describeEditFailure({ reason: 'invalid-identifier', field: 'doi', value: 'nope' }),
      describeEditFailure({ reason: 'invalid-identifier', field: 'arxivId', value: 'nope' }),
      describeEditFailure({ reason: 'identifier-taken', field: 'doi', paper: byDoi }),
      describeEditFailure({ reason: 'unknown-paper' }),
    ];
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/undefined|\[object/);
    }
    expect(messages[4]).toContain('By DOI');
    expect(messages[4]).toContain('没有合并');
  });
});

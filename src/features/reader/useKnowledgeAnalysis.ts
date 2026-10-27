/**
 * One reading session's knowledge analysis: local first, model only on request.
 *
 * The hook owns the sequence the reader sees:
 *
 * 1. `open` gathers the local knowledge about the passage — no request;
 * 2. `prepare` extracts a bounded set of pages and builds a context plan — still local;
 * 3. `run` sends exactly that plan, then stores every returned item as a *suggestion*.
 *
 * Nothing is written before step 3 returns, and even then nothing is confirmed. The mapping from
 * the model's names to stable concept ids happens here, because this is where the local graph is
 * known; the model never sees or supplies an id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation } from '../../domain/annotation';
import type { DifficultySuggestion } from '../../domain/difficulty';
import {
  conceptIdForName,
  conceptMatchesForName,
  createEvidence,
  type Concept,
  type ConceptEvidence,
  type ConceptRelation,
  type KnowledgeState,
  type SuggestionReport,
} from '../../domain/knowledge';
import { analyzeKnowledge, type KnowledgeOutcome } from '../../services/ai/client';
import type {
  KnowledgeAnalysis,
  KnowledgeRequest,
  KnowledgePassageRole,
} from '../../services/ai/knowledgeTypes';
import type { KnowledgeApi } from '../knowledge/useKnowledgeApi';
import { localKnowledgeFor, type LocalKnowledge } from '../knowledge/localKnowledge';
import {
  buildRetrievalPlan,
  extractPageText,
  pagesToScan,
  type ExtractedPage,
  type RetrievalPlan,
} from './paperRetrieval';
import type { PDFDocumentProxy } from './pdfjs';
import type { LocatedQuote } from './useDifficultyScan';
import type { SelectionAnchor } from './selection';

export interface KnowledgeContext {
  paperId: string;
  title: string;
  pdfSha256: string;
  currentPage: number;
  projectId: string | null;
  /** The reader's selection, or null when the panel was opened on the page. */
  selection: SelectionAnchor | null;
  /** The current page's rendered text, used for the local match and the page-scope passage. */
  pageText: string;
  /** Notes on this paper, for the context plan. */
  annotations: readonly Annotation[];
  /** Cached difficulty suggestions for this paper. */
  difficulties: readonly DifficultySuggestion[];
}

export type KnowledgePhase = 'idle' | 'planning' | 'ready' | 'running' | 'done' | 'error';

export interface KnowledgeAnalysisHookOptions {
  doc: PDFDocumentProxy | null;
  knowledge: KnowledgeApi;
  makeId: () => string;
  /** Finds a quotation on a rendered page; used to measure AI evidence before storing it. */
  locate: (page: number, quote: string) => LocatedQuote;
  /** Injectable for tests. */
  analyze?: typeof analyzeKnowledge;
}

export interface KnowledgeAnalysisState {
  context: KnowledgeContext | null;
  local: LocalKnowledge | null;
  phase: KnowledgePhase;
  plan: RetrievalPlan | null;
  analysis: KnowledgeAnalysis | null;
  report: SuggestionReport | null;
  error: string | null;
  /** Pages that could not be read during the last `prepare`. */
  failedPages: number[];
  open: (context: KnowledgeContext) => void;
  prepare: () => void;
  run: () => void;
  cancel: () => void;
  reset: () => void;
}

const PAGE_ROLE: Record<RetrievalPlan['segments'][number]['role'], KnowledgePassageRole> = {
  selection: 'selection',
  definition: 'definition',
  term: 'term',
  neighbor: 'neighbor',
  annotation: 'annotation',
  difficulty: 'difficulty',
  context: 'context',
};

function messageFor(outcome: Extract<KnowledgeOutcome, { ok: false }>): string {
  return outcome.failure.message;
}

export function useKnowledgeAnalysis(
  options: KnowledgeAnalysisHookOptions,
): KnowledgeAnalysisState {
  const { doc, knowledge, makeId, locate, analyze } = options;
  const [context, setContext] = useState<KnowledgeContext | null>(null);
  const [phase, setPhase] = useState<KnowledgePhase>('idle');
  const [plan, setPlan] = useState<RetrievalPlan | null>(null);
  const [analysis, setAnalysis] = useState<KnowledgeAnalysis | null>(null);
  const [report, setReport] = useState<SuggestionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedPages, setFailedPages] = useState<number[]>([]);

  const cache = useRef(new Map<number, ExtractedPage>());
  const controller = useRef<AbortController | null>(null);
  /** Identifies the current extraction; an older prepare must not install its plan. */
  const prepareSeq = useRef(0);
  /** Identifies the current model request; a cancelled or replaced run must not write results. */
  const runSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  // Page text belongs to one document; opening another must not reuse the previous text.
  // The in-flight request is aborted too: its answer would be about a file the reader is no
  // longer looking at, and waiting for it would keep spending on that analysis.
  useEffect(() => {
    cache.current.clear();
    prepareSeq.current += 1;
    runSeq.current += 1;
    controller.current?.abort();
    controller.current = null;
    // The cancelled run returns without touching the phase, so the "running" state of a request
    // that no longer exists must be cleared here. This runs after the abort; a new run installs
    // its own controller first, so it cannot be reset by this.
    queueMicrotask(() => {
      if (!mounted.current || controller.current !== null) return;
      setPhase((current) => (current === 'running' ? 'idle' : current));
    });
  }, [doc]);

  const local = useMemo(() => {
    if (context === null) return null;
    return localKnowledgeFor(knowledge.state, {
      projectId: context.projectId,
      paperId: context.paperId,
      currentPage: context.currentPage,
      selection: context.selection?.quote ?? '',
      pageText: context.pageText,
    });
  }, [context, knowledge.state]);

  const open = useCallback((next: KnowledgeContext) => {
    prepareSeq.current += 1;
    runSeq.current += 1;
    controller.current?.abort();
    controller.current = null;
    setContext(next);
    setPlan(null);
    setAnalysis(null);
    setReport(null);
    setError(null);
    setFailedPages([]);
    setPhase('idle');
  }, []);

  const cancel = useCallback(() => {
    prepareSeq.current += 1;
    runSeq.current += 1;
    controller.current?.abort();
    controller.current = null;
    setPhase('idle');
  }, []);

  const reset = useCallback(() => {
    prepareSeq.current += 1;
    runSeq.current += 1;
    controller.current?.abort();
    controller.current = null;
    setContext(null);
    setPlan(null);
    setAnalysis(null);
    setReport(null);
    setError(null);
    setFailedPages([]);
    setPhase('idle');
  }, []);

  const prepare = useCallback(() => {
    if (context === null || doc === null) {
      setError('这篇论文的文件还没有打开，暂时无法分析知识关联。');
      setPhase('error');
      return;
    }
    const sequence = ++prepareSeq.current;
    const pageCount = doc.numPages;
    const knownPages = [
      ...context.annotations.map((annotation) => annotation.page),
      ...context.difficulties.map((suggestion) => suggestion.page),
    ];
    const targets = pagesToScan(pageCount, context.currentPage, knownPages);
    setPhase('planning');
    setError(null);
    setFailedPages([]);

    void (async () => {
      const failures: number[] = [];
      const extracted: ExtractedPage[] = [];
      const currentRendered = context.pageText.trim();

      const one = async (page: number): Promise<ExtractedPage | null> => {
        if (page === context.currentPage && currentRendered !== '') {
          // The rendered page is the text the reader is actually reading; prefer it.
          return {
            page,
            text: currentRendered,
            itemCount: 0,
            singleCharItems: 0,
            fragmented: false,
          };
        }
        const cached = cache.current.get(page);
        if (cached !== undefined) return cached;
        const found = await extractPageText(doc, page);
        if (found !== null) cache.current.set(page, found);
        return found;
      };

      for (let index = 0; index < targets.length; index += 4) {
        if (sequence !== prepareSeq.current) return;
        const batch = targets.slice(index, index + 4);
        const results = await Promise.all(batch.map(one));
        if (sequence !== prepareSeq.current) return;
        for (const [offset, result] of results.entries()) {
          const page = batch[offset];
          if (result === null) {
            if (page !== undefined) failures.push(page);
            continue;
          }
          extracted.push(result);
        }
      }

      if (!mounted.current || sequence !== prepareSeq.current) return;
      const selectionText = context.selection?.quote ?? '';
      const conceptNames =
        context.projectId === null
          ? knowledge.state.concepts.flatMap((concept) => [concept.name, ...concept.aliases])
          : knowledge.state.concepts
              .filter((concept) => concept.projectIds.includes(context.projectId ?? ''))
              .flatMap((concept) => [concept.name, ...concept.aliases]);
      const nextPlan = buildRetrievalPlan({
        pages: extracted,
        pageCount,
        currentPage: context.currentPage,
        selection: selectionText,
        conceptNames,
        annotations: context.annotations.slice(-4).map((annotation) => ({
          page: annotation.page,
          quote: annotation.quote,
          note: annotation.note,
        })),
        difficulties: context.difficulties.slice(-4).map((suggestion) => ({
          page: suggestion.page,
          title: suggestion.title,
          quote: suggestion.anchor?.quote ?? suggestion.quote,
          quick: suggestion.quick,
        })),
        failedPages: failures,
      });
      setPlan(nextPlan);
      setFailedPages([...new Set(failures)].sort((one, other) => one - other));
      setPhase('ready');
      if (nextPlan.segments.length === 0) {
        setError('这篇论文没有可用的文字，无法分析知识关联。');
        setPhase('error');
      }
    })().catch(() => {
      if (!mounted.current || sequence !== prepareSeq.current) return;
      setError('提取论文文字时出错了，没有发送任何内容。');
      setPhase('error');
    });
  }, [context, doc, knowledge.state]);

  const run = useCallback(() => {
    if (context === null || plan === null) return;
    if (plan.segments.length === 0) return;
    const ask = analyze ?? analyzeKnowledge;

    setPhase('running');
    setError(null);
    setAnalysis(null);
    setReport(null);
    controller.current?.abort();
    const sequence = ++runSeq.current;
    const active = new AbortController();
    controller.current = active;

    const stateSnapshot = knowledge.state;
    const scopeConcepts =
      context.projectId === null
        ? stateSnapshot.concepts
        : stateSnapshot.concepts.filter((concept) =>
            concept.projectIds.includes(context.projectId ?? ''),
          );
    const existingConcepts = scopeConcepts.slice(0, 60).map((concept) => ({
      name: concept.name,
      aliases: concept.aliases,
      summary: concept.summary,
    }));
    const includedIds = new Set(scopeConcepts.slice(0, 60).map((concept) => concept.id));
    const nameOf = (id: string): string =>
      stateSnapshot.concepts.find((concept) => concept.id === id)?.name ?? '';
    const existingRelations = stateSnapshot.relations
      .filter(
        (relation) =>
          relation.status === 'confirmed' &&
          includedIds.has(relation.from) &&
          includedIds.has(relation.to),
      )
      .slice(0, 200)
      .map((relation) => ({
        from: nameOf(relation.from),
        to: nameOf(relation.to),
        kind: relation.kind,
        status: 'confirmed' as const,
      }));

    const request: KnowledgeRequest = {
      paper: {
        id: context.paperId,
        title: context.title,
        page: context.currentPage,
        pdfSha256: context.pdfSha256,
      },
      focus: context.selection?.quote ?? '',
      scope: context.selection === null ? 'page' : 'selection',
      passages: plan.segments.map((segment) => ({
        id: segment.id,
        page: segment.page,
        text: segment.text,
        selection: segment.role === 'selection',
        role: PAGE_ROLE[segment.role],
        label: segment.label,
      })),
      existingConcepts,
      existingRelations,
    };

    void (async () => {
      const outcome = await ask(request, { signal: active.signal });
      if (!mounted.current || runSeq.current !== sequence) return;
      if (!outcome.ok) {
        if (active.signal.aborted) return;
        setError(messageFor(outcome));
        setPhase('error');
        return;
      }

      const result = outcome.analysis;
      setAnalysis(result);
      if (result.status === 'malformed') {
        setError('模型返回的内容无法还原成知识建议；原始输出没有加入知识库。');
        setPhase('error');
        return;
      }

      const batch = buildSuggestionBatch(result, {
        state: stateSnapshot,
        projectId: context.projectId,
        paperId: context.paperId,
        pdfSha256: context.pdfSha256,
        currentPage: context.currentPage,
        locate,
        makeId,
        now: Date.now(),
      });
      const mergeReport = knowledge.addSuggestions(batch);
      if (!mounted.current) return;
      setReport(mergeReport);
      setPhase('done');
    })().catch((caught: unknown) => {
      if (!mounted.current || runSeq.current !== sequence || active.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : '知识关联分析失败了，没有得到建议。');
      setPhase('error');
    });
  }, [analyze, context, knowledge, locate, makeId, plan]);

  return {
    context,
    local,
    phase,
    plan,
    analysis,
    report,
    error,
    failedPages,
    open,
    prepare,
    run,
    cancel,
    reset,
  };
}

interface BatchInput {
  state: KnowledgeState;
  projectId: string | null;
  paperId: string;
  pdfSha256: string;
  currentPage: number;
  locate: (page: number, quote: string) => LocatedQuote;
  makeId: () => string;
  now: number;
}

/**
 * Turns one verified analysis into the batch the domain layer can merge.
 *
 * The mapping is name-based and local: an existing concept (by name or alias) keeps its stable
 * id; a new one gets a fresh id and the current project. Relation evidence is measured against
 * the rendered page when it is available, so a jump back is exact; otherwise it is stored as
 * `verbatim` with no boxes and the interface says the position was not measured.
 */
export function buildSuggestionBatch(
  analysis: KnowledgeAnalysis,
  input: BatchInput,
): {
  concepts: Concept[];
  relations: ConceptRelation[];
  evidence: ConceptEvidence[];
} {
  const concepts: Concept[] = [];
  const relations: ConceptRelation[] = [];
  const evidence: ConceptEvidence[] = [];
  const idByName = new Map<string, string>();

  const remember = (name: string, id: string): void => {
    const key = name.replace(/\s+/g, ' ').trim().toLowerCase();
    if (key === '' || idByName.has(key)) return;
    const matches = conceptMatchesForName(input.state, name);
    // A name that means several things cannot identify one concept, and a new concept's alias
    // must not shadow a different concept the reader already has.
    if (matches.length > 1) return;
    if (matches.length === 1 && matches[0]?.id !== id) return;
    idByName.set(key, id);
  };

  const resolve = (name: string): string | null => {
    const key = name.replace(/\s+/g, ' ').trim().toLowerCase();
    const mapped = idByName.get(key);
    if (mapped !== undefined) return mapped;
    const existing = conceptIdForName(input.state, name);
    if (existing !== null) {
      idByName.set(key, existing);
      return existing;
    }
    return null;
  };

  for (const proposed of analysis.concepts) {
    const matches = conceptMatchesForName(input.state, proposed.name);
    if (matches.length > 1) {
      // The server already refuses ambiguous names; this keeps a hand-built batch from creating
      // a duplicate node next to the two concepts the name could mean.
      continue;
    }
    const existing = matches[0]?.id ?? null;
    if (existing !== null) {
      remember(proposed.name, existing);
      for (const alias of proposed.aliases) remember(alias, existing);
      continue;
    }
    const id = input.makeId();
    const concept: Concept = {
      id,
      name: proposed.name,
      aliases: proposed.aliases,
      summary: proposed.summary,
      origin: 'ai',
      status: 'suggested',
      projectIds: input.projectId === null ? [] : [input.projectId],
      createdAt: input.now,
      updatedAt: input.now,
    };
    concepts.push(concept);
    remember(concept.name, id);
    for (const alias of concept.aliases) remember(alias, id);
  }

  const evidenceFor = (
    entries: readonly { passageId: string; page: number; quote: string }[],
    conceptId: string,
    relationId: string | undefined,
  ): void => {
    for (const entry of entries) {
      const located =
        entry.page === input.currentPage
          ? input.locate(entry.page, entry.quote)
          : { location: 'missing' as const, anchor: null };
      const anchor = located.location === 'found' ? located.anchor : null;
      const created = createEvidence(
        {
          conceptId,
          paperId: input.paperId,
          pdfSha256: input.pdfSha256,
          page: entry.page,
          quote: entry.quote,
          prefix: anchor?.prefix ?? '',
          suffix: anchor?.suffix ?? '',
          rects: anchor?.rects ?? [],
          source: 'ai',
          ...(relationId === undefined ? {} : { relationId }),
          verification: anchor === null ? 'verbatim' : 'located',
        },
        input.makeId,
        input.now,
      );
      if (created !== null) evidence.push(created);
    }
  };

  for (const proposed of analysis.concepts) {
    const conceptId = resolve(proposed.name);
    if (conceptId === null) continue;
    evidenceFor(proposed.evidence, conceptId, undefined);
  }

  for (const proposed of analysis.relations) {
    const from = resolve(proposed.from);
    const to = resolve(proposed.to);
    if (from === null || to === null) continue;
    const id = input.makeId();
    const relation: ConceptRelation = {
      id,
      from,
      to,
      kind: proposed.kind,
      status: 'suggested',
      origin: 'ai',
      note: '',
      support: proposed.support,
      rationale: proposed.explanation,
      provider: analysis.provider,
      providerLabel: analysis.providerLabel,
      model: analysis.model,
      rulesVersion: analysis.rulesVersion,
      evidenceIds: [],
      createdAt: input.now,
      updatedAt: input.now,
    };
    relations.push(relation);
    evidenceFor(proposed.evidence, from, id);
  }

  return { concepts, relations, evidence };
}

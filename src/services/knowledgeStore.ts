/**
 * Where the knowledge graph lives.
 *
 * Its own key, its own version, its own store: the concepts a reader built must not be able to
 * disappear because a paper, an annotation or a suggestion was saved badly somewhere else. If
 * this payload is ever unreadable, the bytes are copied aside before anything is written over
 * them — unlike the disposable difficulty cache, this is work the reader did.
 */

import {
  EMPTY_KNOWLEDGE,
  RELATION_KINDS,
  type Concept,
  type ConceptEvidence,
  type ConceptRelation,
  type KnowledgeState,
  type RelationKind,
} from '../domain/knowledge';
import { knowledgeReducer, type KnowledgeAction } from '../domain/knowledgeState';
import { defaultStore, readItem, writeItem, type KeyValueStore } from './storage';

export const KNOWLEDGE_STORAGE_KEY = 'rw.knowledge';
export const KNOWLEDGE_BACKUP_KEY = 'rw.knowledge.corrupt';
export const KNOWLEDGE_VERSION = 1;

export type KnowledgeIssue = 'unreadable' | 'wrong-shape';

export interface KnowledgeLoad {
  state: KnowledgeState;
  issue: KnowledgeIssue | null;
  /** Entries that were not readable as concepts/evidence/relations and were left out. */
  dropped: number;
  /** True when the unreadable payload was copied aside before we continued empty. */
  backupSaved: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isConcept(value: unknown): value is Concept {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    isStringArray(value.aliases) &&
    typeof value.summary === 'string' &&
    (value.origin === 'user' || value.origin === 'ai') &&
    (value.status === 'confirmed' || value.status === 'suggested') &&
    isStringArray(value.projectIds) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

function isEvidence(value: unknown): value is ConceptEvidence {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.conceptId === 'string' &&
    typeof value.paperId === 'string' &&
    typeof value.pdfSha256 === 'string' &&
    typeof value.page === 'number' &&
    typeof value.quote === 'string' &&
    typeof value.note === 'string' &&
    Array.isArray(value.rects)
  );
}

function isRelation(value: unknown): value is ConceptRelation {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.kind === 'string' &&
    RELATION_KINDS.includes(value.kind as RelationKind) &&
    (value.status === 'confirmed' || value.status === 'suggested') &&
    (value.origin === 'user' || value.origin === 'ai')
  );
}

/**
 * Reads the payload, keeping every entry this build understands and counting the rest.
 *
 * A dropped entry is not deleted from the stored payload — this function returns a state, and
 * the next save writes what was kept. To keep that from silently losing data, the original is
 * copied aside first whenever anything had to be dropped.
 */
export function loadKnowledge(store: KeyValueStore | null = defaultStore()): KnowledgeLoad {
  const raw = readItem(KNOWLEDGE_STORAGE_KEY, store);
  if (raw === null) {
    return { state: EMPTY_KNOWLEDGE, issue: null, dropped: 0, backupSaved: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: EMPTY_KNOWLEDGE,
      issue: 'unreadable',
      dropped: 0,
      backupSaved: keepCopy(raw, store),
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.concepts)) {
    return {
      state: EMPTY_KNOWLEDGE,
      issue: 'wrong-shape',
      dropped: 0,
      backupSaved: keepCopy(raw, store),
    };
  }

  const concepts = parsed.concepts.filter(isConcept);
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence.filter(isEvidence) : [];
  const relations = Array.isArray(parsed.relations) ? parsed.relations.filter(isRelation) : [];
  const dropped =
    parsed.concepts.length -
    concepts.length +
    (Array.isArray(parsed.evidence) ? parsed.evidence.length - evidence.length : 0) +
    (Array.isArray(parsed.relations) ? parsed.relations.length - relations.length : 0);

  // Anything dropped means the stored payload is not fully understood by this build; keep a
  // copy of it before a later save writes the reduced version.
  const backupSaved = dropped > 0 ? keepCopy(raw, store) : false;

  return {
    state: { version: KNOWLEDGE_VERSION, concepts, evidence, relations },
    issue: dropped > 0 ? 'wrong-shape' : null,
    dropped,
    backupSaved,
  };
}

/** Copies an unreadable payload aside, but never over a different one already there. */
function keepCopy(raw: string, store: KeyValueStore | null): boolean {
  const existing = readItem(KNOWLEDGE_BACKUP_KEY, store);
  if (existing === raw) return true;
  if (existing !== null) return false;
  return writeItem(KNOWLEDGE_BACKUP_KEY, raw, store);
}

export function saveKnowledge(
  state: KnowledgeState,
  store: KeyValueStore | null = defaultStore(),
): boolean {
  return writeItem(KNOWLEDGE_STORAGE_KEY, JSON.stringify(state), store);
}

export interface KnowledgeSnapshot {
  state: KnowledgeState;
  /** False after a write failed. The graph is still right in memory, but would be lost. */
  persisted: boolean;
  issue: KnowledgeIssue | null;
  /** Entries that could not be read when this session started. */
  dropped: number;
  /** True when the unreadable payload could not be copied aside; writes are then blocked. */
  writesBlocked: boolean;
}

export interface KnowledgeStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => KnowledgeSnapshot;
  dispatch: (action: KnowledgeAction) => void;
}

/**
 * External store for `useSyncExternalStore`, persisted inside `dispatch`.
 *
 * If the stored payload could not be copied aside, writing over it would destroy the only
 * copy of whatever the reader had. In that case the session still works in memory and the
 * snapshot says plainly that nothing is being saved.
 */
export function createKnowledgeStore(
  storage: KeyValueStore | null = defaultStore(),
): KnowledgeStore {
  const loaded = loadKnowledge(storage);
  const writesBlocked = loaded.issue !== null && !loaded.backupSaved;
  let snapshot: KnowledgeSnapshot = {
    state: loaded.state,
    persisted: true,
    issue: loaded.issue,
    dropped: loaded.dropped,
    writesBlocked,
  };
  const listeners = new Set<() => void>();

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dispatch: (action) => {
      const state = knowledgeReducer(snapshot.state, action);
      if (state === snapshot.state) return;
      snapshot = {
        ...snapshot,
        state,
        persisted: writesBlocked ? false : saveKnowledge(state, storage),
      };
      for (const notify of listeners) notify();
    },
  };
}

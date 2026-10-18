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
  isConceptRecord,
  isEvidenceRecord,
  isRejectedRelationRecord,
  isRelationRecord,
  type KnowledgeState,
} from '../domain/knowledge';
import { knowledgeReducer, type KnowledgeAction } from '../domain/knowledgeState';
import { defaultStore, readItem, writeItem, type KeyValueStore } from './storage';

export const KNOWLEDGE_STORAGE_KEY = 'rw.knowledge';
export const KNOWLEDGE_BACKUP_KEY = 'rw.knowledge.corrupt';
export const KNOWLEDGE_VERSION = 2;

export type KnowledgeIssue = 'unreadable' | 'wrong-shape' | 'newer-version';

export interface KnowledgeLoad {
  state: KnowledgeState;
  issue: KnowledgeIssue | null;
  /** Entries that were not readable as concepts/evidence/relations and were left out. */
  dropped: number;
  /** True when the unreadable payload was copied aside before we continued empty. */
  backupSaved: boolean;
  /**
   * True when this build must not write at all: the payload is from a newer schema, and a
   * reduced rewrite would destroy fields this build cannot even name.
   */
  writeBlocked: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    return {
      state: EMPTY_KNOWLEDGE,
      issue: null,
      dropped: 0,
      backupSaved: false,
      writeBlocked: false,
    };
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
      writeBlocked: false,
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.concepts)) {
    return {
      state: EMPTY_KNOWLEDGE,
      issue: 'wrong-shape',
      dropped: 0,
      backupSaved: keepCopy(raw, store),
      writeBlocked: false,
    };
  }

  const version = parsed.version;
  if (typeof version === 'number' && version > KNOWLEDGE_VERSION) {
    // A newer schema may contain fields this build cannot preserve. Keep the bytes aside and
    // refuse every write: showing an empty graph is recoverable, rewriting it is not.
    return {
      state: EMPTY_KNOWLEDGE,
      issue: 'newer-version',
      dropped: 0,
      backupSaved: keepCopy(raw, store),
      writeBlocked: true,
    };
  }
  if (version !== undefined && version !== 1 && version !== 2) {
    return {
      state: EMPTY_KNOWLEDGE,
      issue: 'wrong-shape',
      dropped: 0,
      backupSaved: keepCopy(raw, store),
      writeBlocked: false,
    };
  }

  const concepts = parsed.concepts.filter(isConceptRecord);
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence.filter(isEvidenceRecord) : [];
  const relations = Array.isArray(parsed.relations)
    ? parsed.relations.filter(isRelationRecord)
    : [];
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const rejectedRaw = version === 2 && Array.isArray(parsed.rejections) ? parsed.rejections : [];
  const rejections = rejectedRaw
    .filter(isRejectedRelationRecord)
    .filter(
      (rejection) =>
        conceptIds.has(rejection.from) &&
        conceptIds.has(rejection.to) &&
        rejection.from !== rejection.to,
    );
  const dropped =
    parsed.concepts.length -
    concepts.length +
    (Array.isArray(parsed.evidence) ? parsed.evidence.length - evidence.length : 0) +
    (Array.isArray(parsed.relations) ? parsed.relations.length - relations.length : 0) +
    (version === 2 && Array.isArray(parsed.rejections)
      ? parsed.rejections.length - rejections.length
      : 0);

  // Anything dropped means the stored payload is not fully understood by this build; keep a
  // copy of it before a later save writes the reduced version.
  const backupSaved = dropped > 0 ? keepCopy(raw, store) : false;

  return {
    state: { version: KNOWLEDGE_VERSION, concepts, evidence, relations, rejections },
    issue: dropped > 0 ? 'wrong-shape' : null,
    dropped,
    backupSaved,
    writeBlocked: false,
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
  const writesBlocked = loaded.writeBlocked || (loaded.issue !== null && !loaded.backupSaved);
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

import { REVIEW_STORAGE_KEY } from '../app/config';
import {
  EMPTY_REVIEW_STATE,
  REVIEW_VERSION,
  applyGrade,
  beginCard,
  parseReviewState,
  type ReviewGrade,
  type ReviewState,
} from '../domain/review';
import { defaultStore, readItem, writeItem, type KeyValueStore } from './storage';

/**
 * The review schedule, in its own key with its own version — the same boundary the knowledge
 * graph draws. Scheduling is not knowledge: if the payload cannot be read, the honest recovery
 * is to start the schedule over rather than quarantine the app, and the reader loses only ease
 * factors and due dates, never a concept or a note.
 */

export type ReviewAction =
  | { type: 'grade'; conceptId: string; grade: ReviewGrade; at: number }
  | { type: 'forget'; conceptId: string };

/**
 * A payload from a newer build is left untouched: writing our (older) shape over it would
 * destroy whatever that build had scheduled. The session then works in memory only.
 */
function loadReview(storage: KeyValueStore | null): { state: ReviewState; blocked: boolean } {
  const raw = readItem(REVIEW_STORAGE_KEY, storage);
  if (raw === null) return { state: EMPTY_REVIEW_STATE, blocked: false };
  try {
    return (
      parseReviewState(JSON.parse(raw) as unknown) ?? {
        state: EMPTY_REVIEW_STATE,
        blocked: false,
      }
    );
  } catch {
    return { state: EMPTY_REVIEW_STATE, blocked: false };
  }
}

export interface ReviewStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => { state: ReviewState; persisted: boolean };
  dispatch: (action: ReviewAction) => void;
}

/** External store for `useSyncExternalStore`; every dispatch persists immediately. */
export function createReviewStore(storage: KeyValueStore | null = defaultStore()): ReviewStore {
  const loaded = loadReview(storage);
  let state = loaded.state;
  let persisted = !loaded.blocked;
  // `useSyncExternalStore` compares snapshots with Object.is: the object must stay the same
  // between dispatches, or every render loops. It is replaced only when a dispatch changes it.
  let snapshot = { state, persisted };
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    dispatch(action) {
      // A concept id is an external identifier too; never use one as a magic object key.
      if (action.conceptId === '__proto__') return;
      if (action.type === 'grade') {
        // Own property only: with a bare index, an id such as `constructor` resolves to a
        // function from Object.prototype and `applyGrade` would write NaN into the schedule.
        const existing = Object.hasOwn(state.cards, action.conceptId)
          ? state.cards[action.conceptId]
          : undefined;
        const current = existing ?? beginCard(action.conceptId, action.at);
        const graded = applyGrade(current, action.grade, action.at);
        state = {
          version: REVIEW_VERSION,
          cards: { ...state.cards, [action.conceptId]: graded },
        };
      } else {
        const cards = { ...state.cards };
        delete cards[action.conceptId];
        state = { version: REVIEW_VERSION, cards };
      }
      persisted = loaded.blocked
        ? false
        : writeItem(REVIEW_STORAGE_KEY, JSON.stringify(state), storage);
      snapshot = { state, persisted };
      emit();
    },
  };
}

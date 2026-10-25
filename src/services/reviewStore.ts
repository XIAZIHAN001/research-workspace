import { REVIEW_STORAGE_KEY } from '../app/config';
import { applyGrade, beginCard, type ReviewCard, type ReviewGrade } from '../domain/review';
import { defaultStore, readItem, writeItem, type KeyValueStore } from './storage';

/**
 * The review schedule, in its own key with its own version — the same boundary the knowledge
 * graph draws. Scheduling is not knowledge: if the payload cannot be read, the honest recovery
 * is to start the schedule over rather than quarantine the app, and the reader loses only ease
 * factors and due dates, never a concept or a note.
 */

const REVIEW_VERSION = 1;

export interface ReviewState {
  version: typeof REVIEW_VERSION;
  cards: Record<string, ReviewCard>;
}

export type ReviewAction =
  | { type: 'grade'; conceptId: string; grade: ReviewGrade; at: number }
  | { type: 'forget'; conceptId: string };

const EMPTY: ReviewState = { version: REVIEW_VERSION, cards: {} };

/** A card survives validation or it does not exist; the rest of the schedule is unaffected. */
function parseCard(value: unknown): ReviewCard | null {
  if (typeof value !== 'object' || value === null) return null;
  const card = value as Record<string, unknown>;
  const { conceptId, ease, intervalDays, reps, lapses, dueAt, lastAt } = card;
  if (typeof conceptId !== 'string' || conceptId === '') return null;
  for (const number of [ease, intervalDays, reps, lapses, dueAt, lastAt]) {
    if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  }
  return {
    conceptId,
    ease: card.ease as number,
    intervalDays: card.intervalDays as number,
    reps: card.reps as number,
    lapses: card.lapses as number,
    dueAt: card.dueAt as number,
    lastAt: card.lastAt as number,
  };
}

/**
 * A payload from a newer build is left untouched: writing our (older) shape over it would
 * destroy whatever that build had scheduled. The session then works in memory only.
 */
function loadReview(storage: KeyValueStore | null): { state: ReviewState; blocked: boolean } {
  const raw = readItem(REVIEW_STORAGE_KEY, storage);
  if (raw === null) return { state: EMPTY, blocked: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { state: EMPTY, blocked: false };
    const version = (parsed as Record<string, unknown>).version;
    if (version === REVIEW_VERSION) {
      const cardsRaw = (parsed as Record<string, unknown>).cards;
      if (typeof cardsRaw !== 'object' || cardsRaw === null)
        return { state: EMPTY, blocked: false };
      const cards: Record<string, ReviewCard> = {};
      for (const [id, value] of Object.entries(cardsRaw)) {
        const card = parseCard(value);
        if (card !== null) cards[id] = card;
      }
      return { state: { version: REVIEW_VERSION, cards }, blocked: false };
    }
    if (typeof version === 'number' && version > REVIEW_VERSION) {
      return { state: EMPTY, blocked: true };
    }
    return { state: EMPTY, blocked: false };
  } catch {
    return { state: EMPTY, blocked: false };
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
      if (action.type === 'grade') {
        const current = state.cards[action.conceptId] ?? beginCard(action.conceptId, action.at);
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

import { describe, expect, it } from 'vitest';
import { REVIEW_STORAGE_KEY } from '../app/config';
import { beginCard } from '../domain/review';
import { createReviewStore } from './reviewStore';
import type { KeyValueStore } from './storage';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe('reviewStore', () => {
  it('grades a concept into existence and persists the schedule', () => {
    const store = memoryStore();
    const review = createReviewStore(store);
    review.dispatch({ type: 'grade', conceptId: 'c1', grade: 'good', at: 1000 });
    const snapshot = review.getSnapshot();
    expect(snapshot.persisted).toBe(true);
    const saved = JSON.parse(store.getItem(REVIEW_STORAGE_KEY) ?? '{}');
    expect(saved.version).toBe(1);
    expect(saved.cards.c1.intervalDays).toBe(1);
    expect(snapshot.state.cards.c1).toStrictEqual(saved.cards.c1);
  });

  it('reads a schedule back after a reload', () => {
    const first = createReviewStore(memoryStore());
    first.dispatch({ type: 'grade', conceptId: 'c1', grade: 'good', at: 1000 });
    const saved = JSON.stringify({
      version: 1,
      cards: { c1: first.getSnapshot().state.cards.c1 },
    });
    const second = createReviewStore(memoryStore({ [REVIEW_STORAGE_KEY]: saved }));
    expect(second.getSnapshot().state.cards.c1).toStrictEqual(first.getSnapshot().state.cards.c1);
  });

  it('drops unreadable data instead of quarantining the session', () => {
    const review = createReviewStore(memoryStore({ [REVIEW_STORAGE_KEY]: '{not json at all' }));
    expect(Object.keys(review.getSnapshot().state.cards)).toHaveLength(0);
  });

  it('refuses to write over a newer version, but still works in memory', () => {
    const newer = JSON.stringify({ version: 99, cards: { x: {} } });
    const store = memoryStore({ [REVIEW_STORAGE_KEY]: newer });
    const review = createReviewStore(store);
    expect(review.getSnapshot().persisted).toBe(false);
    review.dispatch({ type: 'grade', conceptId: 'c1', grade: 'good', at: 1 });
    expect(review.getSnapshot().state.cards.c1).toBeDefined();
    expect(store.getItem(REVIEW_STORAGE_KEY)).toBe(newer);
  });

  it('forgets a concept, for when the reader resets a schedule by hand', () => {
    const review = createReviewStore(memoryStore());
    review.dispatch({ type: 'grade', conceptId: 'c1', grade: 'good', at: 1000 });
    review.dispatch({ type: 'forget', conceptId: 'c1' });
    expect(review.getSnapshot().state.cards.c1).toBeUndefined();
  });

  it('notifies subscribers on every dispatch', () => {
    const review = createReviewStore(memoryStore());
    let ticks = 0;
    const unsubscribe = review.subscribe(() => {
      ticks += 1;
    });
    review.dispatch({ type: 'grade', conceptId: 'c1', grade: 'easy', at: 1 });
    review.dispatch({ type: 'forget', conceptId: 'c1' });
    expect(ticks).toBe(2);
    unsubscribe();
  });

  it('keeps a card that already exists when grading, rather than restarting it', () => {
    const card = beginCard('c1', 10);
    const seeded = memoryStore({
      [REVIEW_STORAGE_KEY]: JSON.stringify({ version: 1, cards: { c1: card } }),
    });
    const review = createReviewStore(seeded);
    review.dispatch({ type: 'grade', conceptId: 'c1', grade: 'good', at: 2000 });
    const graded = review.getSnapshot().state.cards.c1;
    expect(graded?.reps).toBe(1);
    expect(graded?.intervalDays).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyGrade,
  describeDueIn,
  isDue,
  orderQueue,
  parseReviewState,
  type ReviewCard,
} from './review';

const DAY = 86_400_000;

function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    conceptId: 'c1',
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    dueAt: 0,
    lastAt: 0,
    ...overrides,
  };
}

describe('applyGrade', () => {
  it('schedules the first success one day out, the second six days out', () => {
    const first = applyGrade(card(), 'good', 1000);
    expect(first.intervalDays).toBe(1);
    expect(first.dueAt).toBe(1000 + DAY);
    expect(first.reps).toBe(1);
    const second = applyGrade(first, 'good', first.dueAt);
    expect(second.intervalDays).toBe(6);
    expect(second.dueAt).toBe(first.dueAt + 6 * DAY);
  });

  it('multiplies the interval by the ease factor from the third success on', () => {
    const second = applyGrade(applyGrade(card(), 'good', 0), 'good', 0);
    const third = applyGrade(second, 'good', second.dueAt);
    expect(third.intervalDays).toBe(Math.round(6 * third.ease));
    expect(third.ease).toBeGreaterThan(2.4);
  });

  it('raises the ease for easy answers and lowers it for hard ones, with a floor', () => {
    const easy = applyGrade(card({ ease: 2.5 }), 'easy', 0);
    expect(easy.ease).toBeCloseTo(2.6, 5);
    const hard = applyGrade(card({ ease: 2.5 }), 'hard', 0);
    expect(hard.ease).toBeCloseTo(2.36, 5);
    const floored = applyGrade(card({ ease: 1.31 }), 'hard', 0);
    expect(floored.ease).toBe(1.3);
  });

  it('keeps a forgotten card due in the same session and counts the lapse', () => {
    const learned = applyGrade(applyGrade(card(), 'good', 0), 'good', 0);
    const forgot = applyGrade(learned, 'again', learned.dueAt);
    expect(forgot.dueAt).toBe(learned.dueAt);
    expect(isDue(forgot, learned.dueAt)).toBe(true);
    expect(forgot.reps).toBe(0);
    expect(forgot.lapses).toBe(1);
    // The streak starts over: the next success is one day out again.
    const again = applyGrade(forgot, 'good', learned.dueAt);
    expect(again.intervalDays).toBe(1);
  });
});

describe('queue ordering', () => {
  it('puts the most overdue first and sorts the rest by due time', () => {
    const cards = [
      card({ conceptId: 'c', dueAt: 3 }),
      card({ conceptId: 'a', dueAt: 1 }),
      card({ conceptId: 'b', dueAt: 2 }),
    ];
    expect(orderQueue(cards).map((entry) => entry.conceptId)).toStrictEqual(['a', 'b', 'c']);
  });
});

describe('describeDueIn', () => {
  it('speaks in whole days, with a word for tomorrow and now', () => {
    expect(describeDueIn(0, 10)).toBe('现在');
    expect(describeDueIn(10 + DAY, 10)).toBe('明天');
    expect(describeDueIn(10 + 3 * DAY, 10)).toBe('3 天后');
  });
});

describe('parseReviewState', () => {
  it('ignores a card key that would mutate the map prototype', () => {
    const value = JSON.parse(
      JSON.stringify({
        version: 1,
        cards: { c1: card(), ['__proto__']: card({ conceptId: 'evil' }) },
      }),
    ) as unknown;
    const parsed = parseReviewState(value);
    expect(parsed?.blocked).toBe(false);
    expect(Object.keys(parsed?.state.cards ?? {})).toStrictEqual(['c1']);
    expect(Object.getPrototypeOf(parsed?.state.cards ?? {})).toBe(Object.prototype);
  });
});

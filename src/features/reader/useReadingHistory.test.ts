import { describe, expect, it } from 'vitest';
import {
  canGoBack,
  canGoForward,
  createReadingHistory,
  recordJump,
  stepBack,
  stepForward,
} from './useReadingHistory';

describe('reading history', () => {
  it('starts at the page the reader was left on, clamped to a real page', () => {
    expect(createReadingHistory(7)).toEqual({ entries: [7], index: 0 });
    expect(createReadingHistory(0)).toEqual({ entries: [1], index: 0 });
    expect(canGoBack(createReadingHistory(3))).toBe(false);
    expect(canGoForward(createReadingHistory(3))).toBe(false);
  });

  it('records both ends of a jump, ignoring one within the same page', () => {
    const start = createReadingHistory(2);
    expect(recordJump(start, 2, 2)).toBe(start);
    expect(recordJump(start, 2, 9)).toEqual({ entries: [2, 9], index: 1 });
  });

  it('walks back and forward between recorded places', () => {
    const history = recordJump(recordJump(createReadingHistory(2), 2, 9), 9, 12);
    expect(history.entries).toEqual([2, 9, 12]);

    const back = stepBack(history);
    expect(back?.page).toBe(9);
    expect(canGoForward(back?.history ?? history)).toBe(true);

    const forward = stepForward(back?.history ?? history);
    expect(forward?.page).toBe(12);
    expect(stepForward(forward?.history ?? history)).toBeNull();
  });

  it('records where a jump actually started when the reader had scrolled away', () => {
    const history = recordJump(createReadingHistory(1), 1, 5);
    // The reader then scrolls to 8 without a jump and follows an outline entry to 12.
    const scrolled = recordJump(history, 8, 12);
    expect(scrolled.entries).toEqual([1, 5, 8, 12]);
    expect(stepBack(scrolled)?.page).toBe(8);
  });

  it('drops the forward branch when a new jump starts after going back', () => {
    const history = recordJump(recordJump(createReadingHistory(1), 1, 5), 5, 9);
    const back = stepBack(history);
    const branched = recordJump(back?.history ?? history, 5, 12);
    expect(branched.entries).toEqual([1, 5, 12]);
    expect(branched.index).toBe(2);
    expect(canGoForward(branched)).toBe(false);
  });

  it('abandons the forward branch even when the jump stays on the returned page', () => {
    const history = recordJump(recordJump(createReadingHistory(1), 1, 5), 5, 9);
    const back = stepBack(history);
    const branched = recordJump(back?.history ?? history, 5, 5);
    expect(branched.entries).toEqual([1, 5]);
    expect(canGoForward(branched)).toBe(false);
  });

  it('refuses to step past either end', () => {
    const history = createReadingHistory(4);
    expect(stepBack(history)).toBeNull();
    expect(stepForward(history)).toBeNull();
  });
});

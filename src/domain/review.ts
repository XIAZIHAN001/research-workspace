/**
 * Spaced repetition for the concepts a reader confirmed.
 *
 * The schedule is SM-2, the algorithm every flashcard program's default descends from: an ease
 * factor that rises with easy answers and falls with hard ones, and an interval that multiplies
 * by that factor once a card is past its first two steps. "忘了" keeps the card in the same
 * session — the honest behaviour while studying — and resets its progress.
 */

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

export const REVIEW_GRADES: readonly ReviewGrade[] = ['again', 'hard', 'good', 'easy'];

export const REVIEW_GRADE_LABEL: Record<ReviewGrade, string> = {
  again: '忘了',
  hard: '困难',
  good: '良好',
  easy: '轻松',
};

/** The classic SM-2 quality an answer maps onto. */
const QUALITY: Record<ReviewGrade, number> = { again: 2, hard: 3, good: 4, easy: 5 };

export const MIN_EASE = 1.3;
const DAY = 86_400_000;

export interface ReviewCard {
  /** The confirmed concept this card drills. Concepts are deleted; cards then stop matching. */
  conceptId: string;
  /** The SM-2 ease factor. Never below MIN_EASE. */
  ease: number;
  /** Days between reviews once scheduled; 0 means the card has not left the session yet. */
  intervalDays: number;
  /** Successful reviews in a row; "忘了" resets it. */
  reps: number;
  /** How often the answer was forgotten, kept as an honest difficulty signal. */
  lapses: number;
  /** Epoch ms when the card is next due. */
  dueAt: number;
  /** Epoch ms of the last graded answer. */
  lastAt: number;
}

/** A card is due when its time has come; a card with no schedule at all is a new card. */
export function isDue(card: ReviewCard, now: number): boolean {
  return card.dueAt <= now;
}

/**
 * The schedule a confirmed concept starts with: no history, due right away, at the default
 * ease. Cards exist from the first answer on — an unreviewed concept needs no record.
 */
export function beginCard(conceptId: string, now: number): ReviewCard {
  return {
    conceptId,
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    dueAt: now,
    lastAt: 0,
  };
}

/** The queue order: overdue longest first, then the rest by when they come due. */
export function orderQueue(cards: readonly ReviewCard[]): ReviewCard[] {
  return [...cards].sort((one, other) => one.dueAt - other.dueAt);
}

/**
 * Applies one answer.
 *
 * "忘了" is graded within the session: the card stays due now, its streak resets, and its ease
 * drops. Everything else schedules forward: the first success is one day out, the second six,
 * and from there the interval multiplies by the (updated) ease factor.
 */
export function applyGrade(card: ReviewCard, grade: ReviewGrade, now: number): ReviewCard {
  const quality = QUALITY[grade];
  const easeDelta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const ease = Math.max(MIN_EASE, card.ease + easeDelta);

  if (grade === 'again') {
    return {
      ...card,
      ease,
      intervalDays: 0,
      reps: 0,
      lapses: card.lapses + 1,
      dueAt: now,
      lastAt: now,
    };
  }

  const reps = card.reps + 1;
  const intervalDays =
    reps === 1 ? 1 : reps === 2 ? 6 : Math.max(1, Math.round(card.intervalDays * ease));
  return {
    ...card,
    ease,
    intervalDays,
    reps,
    dueAt: now + intervalDays * DAY,
    lastAt: now,
  };
}

/** A friendly description of how long a card has left, for the empty-queue line. */
export function describeDueIn(dueAt: number, now: number): string {
  const ms = dueAt - now;
  if (ms <= 0) return '现在';
  const days = Math.ceil(ms / DAY);
  if (days <= 1) return '明天';
  return `${String(days)} 天后`;
}

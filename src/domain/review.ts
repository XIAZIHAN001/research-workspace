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

/**
 * The schedule's own version, independent of the projects schema.
 *
 * It lives here rather than in the store because the backup also has to read and write the
 * same shape; a second parser would be a second thing to keep in step.
 */
export const REVIEW_VERSION = 1;

export interface ReviewState {
  version: typeof REVIEW_VERSION;
  /** Keyed by concept id: a card stops matching when its concept is deleted. */
  cards: Record<string, ReviewCard>;
}

export const EMPTY_REVIEW_STATE: ReviewState = { version: REVIEW_VERSION, cards: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A card survives validation or it does not exist; the rest of the schedule is unaffected. */
export function parseReviewCard(value: unknown): ReviewCard | null {
  if (!isRecord(value)) return null;
  const { conceptId, ease, intervalDays, reps, lapses, dueAt, lastAt } = value;
  if (typeof conceptId !== 'string' || conceptId === '') return null;
  for (const number of [ease, intervalDays, reps, lapses, dueAt, lastAt]) {
    if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  }
  // Hand-edited or restored values still have to describe a schedule this build can run.
  // Clamping here keeps a bad number from producing a card that is never due or has an
  // impossible ease, without discarding the rest of the record.
  return {
    conceptId,
    ease: Math.max(MIN_EASE, ease as number),
    intervalDays: Math.max(0, Math.floor(intervalDays as number)),
    reps: Math.max(0, Math.floor(reps as number)),
    lapses: Math.max(0, Math.floor(lapses as number)),
    dueAt: dueAt as number,
    lastAt: lastAt as number,
  };
}

/**
 * Reads a persisted schedule, or null when the payload is not one.
 *
 * `blocked` means the payload was written by a newer build: its cards are left untouched on
 * disk rather than overwritten with an older shape. The caller decides whether that is a
 * session-only condition (the live store) or a reason to skip the section (a backup).
 */
export function parseReviewState(value: unknown): { state: ReviewState; blocked: boolean } | null {
  if (!isRecord(value)) return null;
  const { version } = value;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  if (version > REVIEW_VERSION) return { state: EMPTY_REVIEW_STATE, blocked: true };
  if (!isRecord(value.cards)) return null;
  const cards: Record<string, ReviewCard> = {};
  for (const [id, card] of Object.entries(value.cards)) {
    // `cards['__proto__'] = …` would change the map's prototype and hide the record.
    if (id === '__proto__') continue;
    const parsed = parseReviewCard(card);
    if (parsed !== null) cards[id] = parsed;
  }
  return { state: { version: REVIEW_VERSION, cards }, blocked: false };
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

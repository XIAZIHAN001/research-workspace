import { GraduationCap } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Concept, ConceptEvidence } from '../../domain/knowledge';
import type { Paper } from '../../domain/papers';
import {
  describeDueIn,
  isDue,
  orderQueue,
  REVIEW_GRADES,
  REVIEW_GRADE_LABEL,
  type ReviewCard,
  type ReviewGrade,
} from '../../domain/review';

interface ReviewViewProps {
  /** Every confirmed concept; suggested ones wait for their confirmation, not for review. */
  concepts: readonly Concept[];
  evidence: readonly ConceptEvidence[];
  papers: Readonly<Record<string, Paper>>;
  /** The schedule, from the review store. Cards whose concept is gone are ignored. */
  cards: Readonly<Record<string, ReviewCard>>;
  now: number;
  onGrade: (conceptId: string, grade: ReviewGrade) => void;
}

/**
 * The study session: due concepts as flashcards.
 *
 * The front is the name — the answer is the reader's own recall of it, which is what spaced
 * repetition trains. The back shows the summary the reader wrote and the evidence quotes that
 * ground it, so even a wrong memory is corrected against the paper, not against a generated
 * explanation.
 */
export function ReviewView({ concepts, evidence, papers, cards, now, onGrade }: ReviewViewProps) {
  const [revealed, setRevealed] = useState(false);
  /**
   * Cards forgotten during this session.
   *
   * The app's shared clock ticks once a minute, while a grade happens now. Asking `isDue`
   * with that older clock hid a just-forgotten card until the next tick, which contradicted
   * the whole point of keeping it in the session. Membership here is the session's own
   * evidence that the card is due *now*, independent of the shared clock; grading it again
   * removes it and returns the card to the ordinary schedule.
   */
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(new Set());
  /*
   * The session's own order. "忘了" keeps a card due immediately, so the due-date sort alone
   * would show it again on the very next card — an endless loop on one hard concept. The
   * session list re-inserts a forgotten card three places back; it stays honest to the
   * schedule (the store's dueAt is unchanged) while giving the reader other cards first.
   */
  const [session, setSession] = useState<string[] | null>(null);

  const queue = useMemo(() => {
    const byId = new Map(concepts.map((concept) => [concept.id, concept]));
    const dueCards = Object.values(cards).filter(
      (card) => byId.has(card.conceptId) && isDue(card, now),
    );
    const scheduled = orderQueue(dueCards).map((card) => byId.get(card.conceptId) as Concept);
    // New confirmed concepts — no card yet — join after the overdue ones, in name order, so a
    // first session is not a wall of alphabet soup before the review proper.
    const fresh = concepts
      .filter((concept) => !Object.hasOwn(cards, concept.id))
      .sort((one, other) => one.name.localeCompare(other.name, 'zh-Hans-CN'));
    return [...scheduled, ...fresh];
  }, [concepts, cards, now]);

  // The live session: what is left of the chosen order, plus due cards that arrived since.
  // A forgotten card stays through the session even while the shared clock is behind.
  const dueIds = queue.map((concept) => concept.id);
  const knownIds = new Set(concepts.map((concept) => concept.id));
  const order =
    session === null
      ? dueIds
      : [
          ...session.filter((id) => knownIds.has(id) && (forgotten.has(id) || dueIds.includes(id))),
          ...dueIds.filter((id) => !session.includes(id)),
        ];
  const currentId = order[0] ?? null;
  const current = currentId === null ? null : (concepts.find((c) => c.id === currentId) ?? null);

  const grade = (value: ReviewGrade): void => {
    if (current === null) return;
    onGrade(current.id, value);
    setForgotten((currentForgotten) => {
      const next = new Set(currentForgotten);
      if (value === 'again') next.add(current.id);
      else next.delete(current.id);
      return next;
    });
    setRevealed(false);
    if (value === 'again') {
      const rest = order.slice(1);
      const at = Math.min(3, rest.length);
      setSession([...rest.slice(0, at), current.id, ...rest.slice(at)]);
      return;
    }
    setSession(order.slice(1).length === 0 ? null : order.slice(1));
  };

  const nextDueAt = useMemo(() => {
    const future = Object.values(cards)
      .filter((card) => !isDue(card, now) && concepts.some((c) => c.id === card.conceptId))
      .map((card) => card.dueAt);
    return future.length === 0 ? null : Math.min(...future);
  }, [cards, concepts, now]);

  const evidenceOf = (conceptId: string): ConceptEvidence[] =>
    evidence.filter((entry) => entry.conceptId === conceptId).slice(0, 2);

  return (
    <section className="review-page" aria-labelledby="review-title">
      <header className="library-head">
        <h1 id="review-title" className="library-title">
          复习
        </h1>
        <span className="library-count">
          {queue.length > 0
            ? session === null
              ? `到期 ${String(queue.length)} 张`
              : `本次还剩 ${String(order.length)} 张`
            : concepts.length > 0
              ? '没有到期的卡片'
              : '还没有可复习的概念'}
        </span>
      </header>

      {current === null ? (
        <div className="review-empty">
          <GraduationCap size={28} aria-hidden="true" />
          <p>
            {concepts.length === 0
              ? '在阅读时把关键想法保存为概念并确认后，它们会出现在这里。'
              : nextDueAt === null
                ? `共 ${String(concepts.length)} 个概念在复习计划里。回答一次卡片后，会按记忆曲线安排下一次。`
                : `共 ${String(concepts.length)} 个概念在复习计划里，下一批${describeDueIn(nextDueAt, now)}到期。`}
          </p>
        </div>
      ) : (
        <article className="review-card-shell" aria-live="polite">
          <div className="review-card-front">
            <span className="review-card-label">概念</span>
            <h2 className="review-card-name">{current.name}</h2>
            {!revealed ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setRevealed(true);
                }}
              >
                显示答案
              </button>
            ) : (
              <div className="review-card-back">
                {current.summary.trim() !== '' && (
                  <p className="review-card-summary">{current.summary}</p>
                )}
                {evidenceOf(current.id).map((entry) => (
                  <blockquote key={entry.id} className="review-card-quote">
                    <p>{entry.quote}</p>
                    <footer>
                      {papers[entry.paperId]?.title ?? '未知论文'} · 第 {String(entry.page)} 页
                    </footer>
                  </blockquote>
                ))}
              </div>
            )}
          </div>
          {revealed && (
            <div className="review-grades" role="group" aria-label="回忆得怎么样">
              {REVIEW_GRADES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    grade(value);
                  }}
                >
                  {REVIEW_GRADE_LABEL[value]}
                </button>
              ))}
            </div>
          )}
        </article>
      )}
    </section>
  );
}

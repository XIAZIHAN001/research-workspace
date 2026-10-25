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

  const queue = useMemo(() => {
    const byId = new Map(concepts.map((concept) => [concept.id, concept]));
    const dueCards = Object.values(cards).filter(
      (card) => byId.has(card.conceptId) && isDue(card, now),
    );
    const scheduled = orderQueue(dueCards).map((card) => byId.get(card.conceptId) as Concept);
    // New confirmed concepts — no card yet — join after the overdue ones, in name order, so a
    // first session is not a wall of alphabet soup before the review proper.
    const fresh = concepts
      .filter((concept) => cards[concept.id] === undefined)
      .sort((one, other) => one.name.localeCompare(other.name, 'zh-Hans-CN'));
    return [...scheduled, ...fresh];
  }, [concepts, cards, now]);

  const current = queue[0] ?? null;

  const grade = (value: ReviewGrade): void => {
    if (current === null) return;
    onGrade(current.id, value);
    setRevealed(false);
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
            ? `到期 ${String(queue.length)} 张`
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

import { useEffect, useState } from 'react';
import { GLOSSARY_HOVER_DELAY, matchGlossary, type GlossaryEntry } from '../../domain/glossary';

interface GlossaryHoverProps {
  /** The terms defined for the paper being read. Empty disables every listener. */
  entries: readonly GlossaryEntry[];
}

/** Where a hover card may sit, so it never touches the window edges. */
const EDGE = 10;

/**
 * The floating definition card over the PDF.
 *
 * It listens to the text layer the browser already renders — no spans are added, moved or
 * styled, so nothing about the reading surface changes until the reader pauses on a word.
 * Matching is limited to a term wholly inside one span (see `matchGlossary`): that keeps this
 * feature clear of the reader's measurement chains, which nothing may touch.
 */
export function GlossaryHover({ entries }: GlossaryHoverProps) {
  const [card, setCard] = useState<{ term: GlossaryEntry; x: number; y: number } | null>(null);

  useEffect(() => {
    if (entries.length === 0) return;

    let timer: number | null = null;

    const hide = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      setCard(null);
    };

    const onOver = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest('.textLayer')) {
        return;
      }
      // The smallest text unit the layer offers is a span; the card follows whole spans.
      const span = target.closest('span');
      const text = span?.textContent ?? target.textContent;
      if (text === null || text === undefined) return;
      const match = matchGlossary(entries, text);
      if (match === null) {
        hide();
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setCard({ term: match, x: event.clientX, y: event.clientY });
      }, GLOSSARY_HOVER_DELAY);
    };

    window.addEventListener('mouseover', onOver);
    window.addEventListener('mouseout', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('mouseover', onOver);
      window.removeEventListener('mouseout', hide);
      window.removeEventListener('scroll', hide, true);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [entries]);

  // Render-gated rather than effect-reset: an empty list simply has nothing to show, and a
  // card left over from the previous paper is hidden by the same condition.
  if (entries.length === 0 || card === null) return null;

  const left = Math.min(
    Math.max(card.x + 14, EDGE),
    Math.max(EDGE, window.innerWidth - 280 - EDGE),
  );
  const top = Math.min(card.y + 16, Math.max(EDGE, window.innerHeight - 120));

  return (
    <div className="glossary-hover glass glass-strong" style={{ left, top }} role="tooltip">
      <strong className="glossary-hover-term">{card.term.term}</strong>
      {card.term.definition !== '' && (
        <p className="glossary-hover-definition">{card.term.definition}</p>
      )}
    </div>
  );
}

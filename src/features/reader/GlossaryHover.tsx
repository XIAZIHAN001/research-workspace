import { useEffect, useState } from 'react';
import {
  GLOSSARY_HOVER_DELAY,
  matchGlossary,
  matchGlossaryAt,
  type GlossaryEntry,
} from '../../domain/glossary';

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
 * The card follows the character under the pointer, not the whole span: where the caret API
 * exists the term must actually cover the pointer's offset, so a sentence that merely mentions
 * a term somewhere else does not open its card. Matching stays within one span (see
 * `matchGlossary`), which keeps this feature clear of the reader's measurement chains.
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

      const match = (() => {
        // Character-level precision where the platform offers it: the term must cover the
        // caret offset at the pointer. Without the API (older engines, jsdom) the span-level
        // match stands — still correct, only coarser.
        const owner = (event.target as HTMLElement | null)?.ownerDocument ?? null;
        const range =
          owner !== null && typeof owner.caretRangeFromPoint === 'function'
            ? owner.caretRangeFromPoint(event.clientX, event.clientY)
            : null;
        if (range !== null && range.startContainer.nodeType === Node.TEXT_NODE) {
          const data = range.startContainer.textContent ?? '';
          return matchGlossaryAt(entries, data, range.startOffset);
        }
        return matchGlossary(entries, text);
      })();

      if (match === null) {
        hide();
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setCard({ term: match, x: event.clientX, y: event.clientY });
      }, GLOSSARY_HOVER_DELAY);
    };

    const onOut = (event: MouseEvent): void => {
      // Only leave when the pointer has really left the text layer: hops between adjacent
      // spans fire mouseout too, and hiding on each would flicker the card away mid-hover.
      const to = event.relatedTarget;
      if (to instanceof HTMLElement && to.closest('.textLayer') !== null) return;
      hide();
    };

    window.addEventListener('mouseover', onOver);
    window.addEventListener('mouseout', onOut);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('mouseover', onOver);
      window.removeEventListener('mouseout', onOut);
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

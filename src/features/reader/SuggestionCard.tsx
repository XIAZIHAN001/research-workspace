import { BookOpenCheck, Lightbulb, MessageCircleQuestion, X } from 'lucide-react';
import { useEffect } from 'react';
import {
  DIFFICULTY_KIND_LABEL,
  LOCATION_LABEL,
  type DifficultySuggestion,
} from '../../domain/difficulty';

interface SuggestionCardProps {
  suggestion: DifficultySuggestion;
  /** Where the marker is, in viewport coordinates. */
  spot: { x: number; y: number };
  canSaveNote: boolean;
  onExplain: () => void;
  onSaveNote: () => void;
  onIgnore: () => void;
  onDismiss: () => void;
}

const WIDTH = 320;
const HEIGHT = 300;
const EDGE = 8;

/**
 * The short answer shown when a marker is clicked.
 *
 * Two sentences first, an offer to go deeper second. The card never opens with a lecture, and
 * it always says what it is: a suggestion from the assistant, anchored to a quotation that was
 * checked against the page — not the paper's own words and not a note the reader made.
 */
export function SuggestionCard({
  suggestion,
  spot,
  canSaveNote,
  onExplain,
  onSaveNote,
  onIgnore,
  onDismiss,
}: SuggestionCardProps) {
  const half = WIDTH / 2;
  const left = Math.min(
    Math.max(spot.x, half + EDGE),
    Math.max(half + EDGE, window.innerWidth - half - EDGE),
  );
  const top = Math.min(Math.max(spot.y + 14, 56), Math.max(56, window.innerHeight - HEIGHT - EDGE));

  // Escape closes it from anywhere: clicking a marker does not move focus into the card, so a
  // handler on the card itself would never fire.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);

  return (
    <div
      className="suggestion-card glass glass-strong"
      role="dialog"
      aria-label={`难点：${suggestion.title}`}
      style={{ left: `${String(left)}px`, top: `${String(top)}px`, width: `${String(WIDTH)}px` }}
    >
      <div className="suggestion-head">
        <span className="suggestion-kind">
          <Lightbulb size={12} aria-hidden="true" />
          {DIFFICULTY_KIND_LABEL[suggestion.kind]}
        </span>
        <button type="button" className="icon-btn" aria-label="关闭难点说明" onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <p className="suggestion-title">{suggestion.title}</p>
      <p className="suggestion-quick">{suggestion.quick}</p>
      <p className="suggestion-why">{suggestion.why}</p>

      {suggestion.location !== 'found' && (
        <p className="ai-warn">
          {LOCATION_LABEL[suggestion.location]}：这段引文没能在当前页面上唯一定位，所以没有画标记。
        </p>
      )}

      <div className="suggestion-actions">
        <button type="button" className="btn btn-quiet" onClick={onExplain}>
          <MessageCircleQuestion size={14} aria-hidden="true" />
          深入理解
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={!canSaveNote}
          title={canSaveNote ? undefined : '没有可锚定的原文，无法保存为笔记'}
          onClick={onSaveNote}
        >
          <BookOpenCheck size={14} aria-hidden="true" />
          存为笔记
        </button>
        <button type="button" className="btn btn-quiet" onClick={onIgnore}>
          忽略
        </button>
      </div>

      <p className="ai-caveat">AI 建议，不是原文；它的引文只保证逐字出现在这一页里。</p>
    </div>
  );
}

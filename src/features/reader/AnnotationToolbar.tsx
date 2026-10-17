import { Highlighter, MessageSquarePlus, Network, SendHorizontal, Sparkles, X } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import {
  ANNOTATION_KINDS,
  ANNOTATION_KIND_LABEL,
  MAX_NOTE_LENGTH,
  type AnnotationKind,
} from '../../domain/annotation';
import { AI_MODE_LABEL, type AiMode } from '../../services/ai/types';

interface AnnotationToolbarProps {
  /** Where to sit, in viewport coordinates: just above the selection. */
  spot: { x: number; y: number };
  /** Saves a highlight with nothing written on it yet. */
  onHighlight: () => void;
  /** Saves a highlight with a note and a kind. */
  onNote: (draft: { kind: AnnotationKind; note: string }) => void;
  /** Asks the assistant about the selection. */
  onAsk: (mode: AiMode, question: string) => void;
  /** Opens the local knowledge panel for this selection. Does not call a model. */
  onKnowledge: () => void;
  onDismiss: () => void;
}

/** Half the toolbar's widest state, used to keep the whole thing on screen. */
const HALF_WIDTH = { actions: 230, menu: 200 };
const EDGE = 8;
/**
 * Roughly how tall each state is, used to keep the bottom edge on screen.
 *
 * A selection near the foot of the page puts the toolbar near the foot of the window, and the
 * menu opens downwards — so without this the last items were rendered below the viewport where
 * they could not be clicked at all. Measured, not measured *precisely*: it only has to be close
 * enough to keep the buttons reachable, and the stylesheet caps the height as a backstop.
 */
const HEIGHT = { actions: 84, menu: 280 };

const AI_MODES: readonly AiMode[] = ['explain', 'walkthrough', 'formula', 'translate', 'ask'];

/**
 * The small toolbar that appears over a selection.
 *
 * Four actions, and none of them is a menu of menus: highlighting is one click, writing a note
 * opens a small editor in place, and the assistant opens a short list of the questions a reader
 * actually has about a passage. The selection is captured by the reader before this mounts, so
 * clicking here cannot lose it.
 */
export function AnnotationToolbar({
  spot,
  onHighlight,
  onNote,
  onAsk,
  onKnowledge,
  onDismiss,
}: AnnotationToolbarProps) {
  const [composing, setComposing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [kind, setKind] = useState<AnnotationKind>('question');
  const [note, setNote] = useState('');
  const [question, setQuestion] = useState('');

  const half = composing || asking ? HALF_WIDTH.menu : HALF_WIDTH.actions;
  const left = Math.min(
    Math.max(spot.x, half + EDGE),
    Math.max(half + EDGE, window.innerWidth - half - EDGE),
  );
  // Clamped on all four sides: horizontally so neither end runs off the window, vertically so
  // the menu that opens downwards still ends above the bottom edge.
  const estimatedHeight = composing || asking ? HEIGHT.menu : HEIGHT.actions;
  const top = Math.min(
    Math.max(spot.y - 12, 56),
    Math.max(56, window.innerHeight - estimatedHeight - EDGE),
  );

  const submitNote = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onNote({ kind, note });
  };

  const submitQuestion = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (question.trim() === '') return;
    onAsk('ask', question.trim());
  };

  return (
    <div
      className="annotation-toolbar glass glass-strong"
      role="toolbar"
      aria-label="批注"
      style={{ left: `${String(left)}px`, top: `${String(top)}px` }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss();
      }}
    >
      {composing ? (
        <form className="annotation-compose" onSubmit={submitNote}>
          <div className="annotation-kinds" role="group" aria-label="笔记类型">
            {ANNOTATION_KINDS.map((option) => (
              <button
                key={option}
                type="button"
                className="chip"
                aria-pressed={kind === option}
                onClick={() => {
                  setKind(option);
                }}
              >
                {ANNOTATION_KIND_LABEL[option]}
              </button>
            ))}
          </div>
          <label>
            <span className="sr-only">笔记内容</span>
            <textarea
              className="annotation-input"
              value={note}
              maxLength={MAX_NOTE_LENGTH}
              rows={3}
              autoFocus
              placeholder="写下疑问或理解…"
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </label>
          <div className="annotation-actions">
            <button type="button" className="btn btn-quiet" onClick={onDismiss}>
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              保存
            </button>
          </div>
        </form>
      ) : asking ? (
        <div className="ai-ask-menu" role="group" aria-label="向 AI 提问">
          {AI_MODES.filter((mode) => mode !== 'ask').map((mode) => (
            <button
              key={mode}
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                onAsk(mode, '');
              }}
            >
              {AI_MODE_LABEL[mode]}
            </button>
          ))}
          <form className="ai-ask-inline" onSubmit={submitQuestion}>
            <label>
              <span className="sr-only">针对这段原文提问</span>
              <input
                type="text"
                value={question}
                autoFocus
                placeholder="针对这段原文提问…"
                onChange={(event) => {
                  setQuestion(event.target.value);
                }}
              />
            </label>
            <button
              type="submit"
              className="icon-btn"
              aria-label="提问"
              disabled={question.trim() === ''}
            >
              <SendHorizontal size={14} aria-hidden="true" />
            </button>
          </form>
          <div className="annotation-actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setAsking(false);
              }}
            >
              返回
            </button>
          </div>
        </div>
      ) : (
        <div className="annotation-actions">
          <button type="button" className="btn btn-quiet" onClick={onHighlight}>
            <Highlighter size={14} aria-hidden="true" />
            高亮
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setComposing(true);
            }}
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
            笔记
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setAsking(true);
            }}
          >
            <Sparkles size={14} aria-hidden="true" />
            向这段文字提问
          </button>
          <button type="button" className="btn btn-quiet" onClick={onKnowledge}>
            <Network size={14} aria-hidden="true" />
            查看相关知识
          </button>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onDismiss}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

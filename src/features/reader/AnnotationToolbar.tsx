import { Highlighter, MessageSquarePlus, Network, SendHorizontal, Sparkles, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import {
  ANNOTATION_KINDS,
  ANNOTATION_KIND_LABEL,
  MAX_NOTE_LENGTH,
  type AnnotationKind,
} from '../../domain/annotation';
import { AI_MODE_LABEL, type AiMode } from '../../services/ai/types';
import { useViewportSize } from '../../ui/useViewportSize';

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

/** How close to a window edge the toolbar may get before it is pushed back in. */
const EDGE = 8;
/** Never above this, whatever the selection's y is: it would sit under the toolbar row. */
const TOP_GAP = 56;
/**
 * The size used for the very first placement, before the element has been measured.
 *
 * After mount the real size replaces this (see `measured` below), so this only decides where the
 * toolbar lands for one frame. It is deliberately an over-estimate: placing a frame too low and
 * then correcting is invisible, while placing it too high and correcting is a visible jump.
 */
const FIRST_FRAME = { width: 460, height: 300 };

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

  /*
   * The toolbar is placed against the window, so it needs the window — as a value it is told
   * about, not one it reaches for. `useViewportSize` re-renders on resize, which is what makes
   * the clamping below correct after the window changes rather than only on first open.
   */
  const viewport = useViewportSize();

  /*
   * Its own size, measured rather than guessed.
   *
   * The old constants (230×84, 200×280) were estimates of a toolbar whose contents change with
   * the locale, the number of AI modes and the width of a translated label — so they were
   * wrong whenever they were not exactly right, and the toolbar clipped or drifted. Measuring
   * the element removes the guess: the clamp is now correct by construction. `FIRST_FRAME`
   * covers the single render before this has run.
   */
  const ref = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState(FIRST_FRAME);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const box = entry.borderBoxSize?.[0];
      const width = box?.inlineSize ?? element.offsetWidth;
      const height = box?.blockSize ?? element.offsetHeight;
      if (width > 0 && height > 0)
        setMeasured((current) =>
          current.width === width && current.height === height ? current : { width, height },
        );
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const half = measured.width / 2;
  const width = viewport.width;
  const height = viewport.height;
  const left =
    width === 0
      ? spot.x
      : Math.min(Math.max(spot.x, half + EDGE), Math.max(half + EDGE, width - half - EDGE));

  /*
   * The element is anchored by its bottom edge (`transform: translate(-50%, -100%)`), so it
   * occupies [top − height, top]. With a measured height the clamp is exact: the floor is what
   * keeps the top of the toolbar on screen, and the ceiling is what keeps its bottom on screen.
   * The old estimate-based version had to leave a gap the size of the estimate at the bottom,
   * because being wrong meant the last row of buttons was unreachable.
   */
  const floor = Math.max(TOP_GAP, measured.height + EDGE);
  const ceiling = Math.max(floor, height - EDGE);
  const top =
    height === 0 ? Math.max(spot.y - 12, TOP_GAP) : Math.min(Math.max(spot.y - 12, floor), ceiling);

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
      ref={ref}
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

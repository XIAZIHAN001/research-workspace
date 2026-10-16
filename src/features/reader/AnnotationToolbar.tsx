import { Highlighter, MessageSquarePlus, X } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import {
  ANNOTATION_KINDS,
  ANNOTATION_KIND_LABEL,
  MAX_NOTE_LENGTH,
  type AnnotationKind,
} from '../../domain/annotation';

interface AnnotationToolbarProps {
  /** Where to sit, in viewport coordinates: just above the selection. */
  spot: { x: number; y: number };
  /** Saves a highlight with nothing written on it yet. */
  onHighlight: () => void;
  /** Saves a highlight with a note and a kind. */
  onNote: (draft: { kind: AnnotationKind; note: string }) => void;
  onDismiss: () => void;
}

const HALF_WIDTH = 130;
const EDGE = 8;

/**
 * The small toolbar that appears over a selection.
 *
 * Two actions only: highlighting is one click, writing a note opens a small editor in place.
 * The selection itself is already captured by the reader before this mounts, so clicking here
 * cannot lose it.
 */
export function AnnotationToolbar({
  spot,
  onHighlight,
  onNote,
  onDismiss,
}: AnnotationToolbarProps) {
  const [composing, setComposing] = useState(false);
  const [kind, setKind] = useState<AnnotationKind>('question');
  const [note, setNote] = useState('');

  const left = Math.min(Math.max(spot.x, HALF_WIDTH + EDGE), window.innerWidth - HALF_WIDTH - EDGE);
  const top = Math.max(spot.y - 12, 56);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onNote({ kind, note });
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
        <form className="annotation-compose" onSubmit={submit}>
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
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onDismiss}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

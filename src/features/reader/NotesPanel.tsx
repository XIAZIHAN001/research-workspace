import { Crosshair, Pencil, Trash2, X } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import {
  ANNOTATION_KINDS,
  ANNOTATION_KIND_LABEL,
  MAX_NOTE_LENGTH,
  sortAnnotations,
  type Annotation,
  type AnnotationEdit,
  type AnnotationKind,
} from '../../domain/annotation';

interface NotesPanelProps {
  /** Every highlight on this paper, whatever file it was made on. */
  annotations: readonly Annotation[];
  /** The file currently open; highlights made on another one are listed separately. */
  currentPdfSha256: string | null;
  activeId: string | null;
  /** False for a highlight made on another file: there is nowhere on this page to go. */
  onJump: (annotation: Annotation) => void;
  onEdit: (id: string, edit: AnnotationEdit) => void;
  onDelete: (annotation: Annotation) => void;
  onClose: () => void;
}

/**
 * The notes for the paper being read, beside it rather than instead of it.
 *
 * Highlights made on a different PDF file are kept and listed, but they are deliberately not
 * drawn on the page: the anchor describes text in one specific file, and applying it to another
 * would put the highlight wherever the text happened to land.
 */
export function NotesPanel({
  annotations,
  currentPdfSha256,
  activeId,
  onJump,
  onEdit,
  onDelete,
  onClose,
}: NotesPanelProps) {
  const ordered = sortAnnotations(annotations);
  const here =
    currentPdfSha256 === null ? [] : ordered.filter((a) => a.pdfSha256 === currentPdfSha256);
  const elsewhere =
    currentPdfSha256 === null ? ordered : ordered.filter((a) => a.pdfSha256 !== currentPdfSha256);

  return (
    <aside className="notes-panel" aria-label="论文笔记">
      <header className="notes-head">
        <h2 className="notes-title">笔记</h2>
        <span className="notes-count">{annotations.length}</span>
        <button type="button" className="icon-btn" aria-label="收起笔记" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      {annotations.length === 0 ? (
        <p className="notes-empty">在正文里选中文字，就能留下高亮和笔记。</p>
      ) : (
        <div className="notes-scroll">
          <ul className="notes-list">
            {here.map((annotation) => (
              <NoteItem
                key={annotation.id}
                annotation={annotation}
                active={annotation.id === activeId}
                canJump
                onJump={onJump}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </ul>

          {elsewhere.length > 0 && (
            <section className="notes-elsewhere" aria-labelledby="notes-elsewhere-title">
              <h3 id="notes-elsewhere-title" className="notes-subtitle">
                另一份 PDF 上的笔记（{elsewhere.length}）
              </h3>
              <p className="notes-warning">
                这篇论文的 PDF 文件换过了，旧笔记不会画在新文件上——它们还在，只是位置对不上。
              </p>
              <ul className="notes-list">
                {elsewhere.map((annotation) => (
                  <NoteItem
                    key={annotation.id}
                    annotation={annotation}
                    active={annotation.id === activeId}
                    canJump={false}
                    onJump={onJump}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

interface NoteItemProps {
  annotation: Annotation;
  active: boolean;
  canJump: boolean;
  onJump: (annotation: Annotation) => void;
  onEdit: (id: string, edit: AnnotationEdit) => void;
  onDelete: (annotation: Annotation) => void;
}

function NoteItem({ annotation, active, canJump, onJump, onEdit, onDelete }: NoteItemProps) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(annotation.note);
  const [kind, setKind] = useState<AnnotationKind>(annotation.kind);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onEdit(annotation.id, { note, kind });
    setEditing(false);
  };

  return (
    <li className="note-item" data-active={active} data-kind={annotation.kind}>
      <div className="note-meta">
        <span className="note-kind">{ANNOTATION_KIND_LABEL[annotation.kind]}</span>
        <span className="note-page">第 {annotation.page} 页</span>
      </div>
      <p className="note-quote">{annotation.quote}</p>

      {editing ? (
        <form className="note-edit" onSubmit={submit}>
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
              rows={3}
              maxLength={MAX_NOTE_LENGTH}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </label>
          <div className="note-actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setNote(annotation.note);
                setKind(annotation.kind);
                setEditing(false);
              }}
            >
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              保存
            </button>
          </div>
        </form>
      ) : (
        <>
          {annotation.note !== '' && <p className="note-body">{annotation.note}</p>}
          <div className="note-actions">
            <button
              type="button"
              className="btn btn-quiet"
              disabled={!canJump}
              title={canJump ? undefined : '这条高亮做在另一份 PDF 文件上，回不到当前文件里的位置'}
              onClick={() => {
                onJump(annotation);
              }}
            >
              <Crosshair size={13} aria-hidden="true" />
              回到原文
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setEditing(true);
              }}
            >
              <Pencil size={13} aria-hidden="true" />
              {annotation.note === '' ? '写笔记' : '编辑'}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                onDelete(annotation);
              }}
            >
              <Trash2 size={13} aria-hidden="true" />
              删除
            </button>
          </div>
        </>
      )}
    </li>
  );
}

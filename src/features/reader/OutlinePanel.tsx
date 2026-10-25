import {
  Bookmark as BookmarkIcon,
  BookmarkPlus,
  Check,
  ChevronRight,
  CircleCheck,
  Download,
  Pencil,
  StickyNote,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { defaultBookmarkLabel, sortBookmarks, type Bookmark } from '../../domain/bookmark';
import { ANNOTATION_KIND_LABEL, type Annotation } from '../../domain/annotation';
import {
  activeOutlineId,
  countOutlineEntries,
  type OutlineEntry,
  type PdfOutlineState,
} from './usePdfOutline';

/** The reader's own marks that fall inside one chapter. */
interface OutlineMarks {
  bookmarks: readonly Bookmark[];
  notes: readonly Annotation[];
}

const NO_MARKS: OutlineMarks = { bookmarks: [], notes: [] };

interface OutlinePanelProps {
  outline: PdfOutlineState;
  currentPage: number;
  onJump: (page: number) => void;
  onClose: () => void;
  /**
   * The reader's marks. They live in the table of contents rather than in tabs of their own, so
   * a bookmark reads as "this chapter has a signpost" and a note as "something was written here".
   * Every one of these is optional so the panel still renders as a plain outline on its own.
   */
  bookmarks?: readonly Bookmark[];
  annotations?: readonly Annotation[];
  /** Notes of this paper that belong to an older file version: stored, but not drawn. */
  elsewhereNotes?: readonly Annotation[];
  activeNoteId?: string | null;
  onAddBookmark?: (label: string) => void;
  onRenameBookmark?: (id: string, label: string) => void;
  onDeleteBookmark?: (bookmark: Bookmark) => void;
  onJumpToNote?: (annotation: Annotation) => void;
  onEditNote?: (id: string, note: string) => void;
  onDeleteNote?: (annotation: Annotation) => void;
  /** Marks a question answered, or opens it again. Falls back to read-only when omitted. */
  onResolveNote?: (id: string, resolvedAt: number | null) => void;
  onExportNotes?: () => void;
}

/**
 * The PDF's own table of contents, with the reader's bookmarks and notes folded into it.
 *
 * The outline is a navigation aid, not a second rendering of the paper: entries whose destination
 * could not be resolved are shown but not clickable, and the chapter containing the current page
 * is marked. When a chapter is collapsed, the chapter itself carries the mark, so the reader can
 * still see where they are without expanding anything.
 *
 * Bookmarks and notes are attached to the deepest chapter whose start page is at or before their
 * own page. That keeps the index in reading order without inventing a second hierarchy: a mark on
 * page 3 of "1.2 方法" sits under that section, while a mark before the first chapter falls into a
 * small "未归入章节" group rather than disappearing. A bookmark is drawn as a signpost (accent
 * colour, page number); a note carries its kind, its excerpt and its own tint, so the two kinds of
 * mark never read as the same thing.
 */
export function OutlinePanel({
  outline,
  currentPage,
  onJump,
  onClose,
  bookmarks = [],
  annotations = [],
  elsewhereNotes = [],
  activeNoteId = null,
  onAddBookmark,
  onRenameBookmark,
  onDeleteBookmark,
  onJumpToNote,
  onEditNote,
  onDeleteNote,
  onResolveNote,
  onExportNotes,
}: OutlinePanelProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const activeId = useMemo(
    () => activeOutlineId(outline.items, currentPage),
    [outline.items, currentPage],
  );
  // Roots start open: a list of closed chapter titles is not a table of contents yet.
  const defaults = useMemo(() => new Set(outline.items.map((item) => item.id)), [outline.items]);
  const open = expanded ?? defaults;
  const total = useMemo(() => countOutlineEntries(outline.items), [outline.items]);

  const { byChapter, loose } = useMemo(
    () => groupMarks(outline.items, bookmarks, annotations),
    [outline.items, bookmarks, annotations],
  );

  const actions: MarkActions = {
    onJump,
    onJumpToNote: onJumpToNote ?? (() => undefined),
    onRenameBookmark: onRenameBookmark ?? (() => undefined),
    onDeleteBookmark: onDeleteBookmark ?? (() => undefined),
    onEditNote: onEditNote ?? (() => undefined),
    onDeleteNote: onDeleteNote ?? (() => undefined),
    onResolveNote: onResolveNote ?? (() => undefined),
    activeNoteId,
    readOnly: {
      bookmark: onRenameBookmark === undefined && onDeleteBookmark === undefined,
      note: onEditNote === undefined && onDeleteNote === undefined && onResolveNote === undefined,
    },
  };

  const counts = [
    outline.status === 'ready' && total > 0 ? `${String(total)} 章` : null,
    bookmarks.length > 0 ? `${String(bookmarks.length)} 书签` : null,
    annotations.length > 0 ? `${String(annotations.length)} 笔记` : null,
  ].filter((part): part is string => part !== null);

  const hasMarks = loose.bookmarks.length + loose.notes.length > 0;
  const showTree = outline.status === 'ready' && outline.items.length > 0;

  const toggle = (id: string): void => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <aside className="outline-panel" aria-label="论文目录">
      <div className="outline-head">
        <span className="outline-title">目录</span>
        {counts.length > 0 && <span className="outline-count">{counts.join(' · ')}</span>}
        {onAddBookmark !== undefined && (
          <button
            type="button"
            className="icon-btn"
            aria-label={`为第 ${String(currentPage)} 页添加书签`}
            title="为当前页添加书签"
            onClick={() => {
              onAddBookmark('');
            }}
          >
            <BookmarkPlus size={15} aria-hidden="true" />
          </button>
        )}
        {onExportNotes !== undefined && annotations.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            aria-label="导出笔记"
            title="导出笔记为 Markdown"
            onClick={onExportNotes}
          >
            <Download size={15} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="关闭目录" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="outline-scroll">
        {outline.status === 'loading' && <p className="outline-note">正在读取目录…</p>}
        {outline.status === 'error' && <p className="outline-note">目录读取失败。</p>}
        {outline.status === 'ready' && outline.items.length === 0 && (
          <p className="outline-note">
            {hasMarks ? '这份 PDF 没有目录，书签和笔记按位置列在下面。' : '这份 PDF 没有目录。'}
          </p>
        )}

        {hasMarks && (
          <div className="outline-loose">
            {showTree && <p className="outline-loose-title">未归入章节</p>}
            <OutlineMarkList marks={loose} depth={0} actions={actions} />
          </div>
        )}

        {showTree && (
          <OutlineNodes
            nodes={outline.items}
            depth={0}
            open={open}
            activeId={activeId}
            marks={byChapter}
            actions={actions}
            onToggle={toggle}
            onJump={onJump}
          />
        )}

        {elsewhereNotes.length > 0 && (
          <section className="outline-elsewhere" aria-label="另一份 PDF 上的笔记">
            <p className="outline-loose-title">另一份 PDF 上的笔记（{elsewhereNotes.length}）</p>
            <p className="outline-note">
              这篇论文的 PDF 文件换过了，旧笔记不会画在新文件上——它们还在，只是位置对不上。
            </p>
            <ul className="outline-marks">
              {elsewhereNotes.map((annotation) => {
                const excerpt = annotation.note.trim() === '' ? annotation.quote : annotation.note;
                return (
                  <li key={annotation.id} className="outline-mark" data-kind="note" data-stale>
                    <span className="outline-mark-main">
                      <StickyNote size={12} aria-hidden="true" />
                      <span className="outline-mark-text">{excerpt}</span>
                      <span className="outline-mark-kind">
                        {ANNOTATION_KIND_LABEL[annotation.kind]}
                      </span>
                      <span className="outline-mark-page">第 {annotation.page} 页</span>
                    </span>
                    {onDeleteNote !== undefined && (
                      <span className="outline-mark-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`删除第 ${String(annotation.page)} 页的笔记`}
                          onClick={() => {
                            onDeleteNote(annotation);
                          }}
                        >
                          <Trash2 size={11} aria-hidden="true" />
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}

interface MarkActions {
  onJump: (page: number) => void;
  onJumpToNote: (annotation: Annotation) => void;
  onRenameBookmark: (id: string, label: string) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onEditNote: (id: string, note: string) => void;
  onDeleteNote: (annotation: Annotation) => void;
  onResolveNote: (id: string, resolvedAt: number | null) => void;
  activeNoteId: string | null;
  readOnly: { bookmark: boolean; note: boolean };
}

interface OutlineNodesProps {
  nodes: readonly OutlineEntry[];
  depth: number;
  open: ReadonlySet<string>;
  activeId: string | null;
  marks: ReadonlyMap<string, OutlineMarks>;
  actions: MarkActions;
  onToggle: (id: string) => void;
  onJump: (page: number) => void;
}

function OutlineNodes({
  nodes,
  depth,
  open,
  activeId,
  marks,
  actions,
  onToggle,
  onJump,
}: OutlineNodesProps) {
  return (
    <ul className="outline-tree" data-depth={depth}>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isOpen = open.has(node.id);
        // A collapsed branch stays marked when the current page is somewhere inside it.
        const active = node.id === activeId || (!isOpen && containsId(node, activeId));
        return (
          <li key={node.id}>
            <div className="outline-row" style={{ paddingLeft: `${String(depth * 18 + 6)}px` }}>
              {hasChildren ? (
                <button
                  type="button"
                  className="outline-toggle"
                  aria-label={isOpen ? `收起「${node.title}」` : `展开「${node.title}」`}
                  aria-expanded={isOpen}
                  onClick={() => {
                    onToggle(node.id);
                  }}
                >
                  <ChevronRight size={13} aria-hidden="true" />
                </button>
              ) : (
                <span className="outline-toggle" aria-hidden="true" />
              )}
              <button
                type="button"
                className="outline-link"
                title={node.title}
                data-active={active}
                aria-current={active ? 'location' : undefined}
                disabled={node.page === null}
                onClick={() => {
                  if (node.page !== null) onJump(node.page);
                }}
              >
                <span className="outline-label">{node.title}</span>
                {node.page !== null && <span className="outline-page">{node.page}</span>}
              </button>
            </div>
            {/* The chapter's own marks sit directly under its title, before any subsections. */}
            <OutlineMarkList
              marks={marks.get(node.id) ?? NO_MARKS}
              depth={depth + 1}
              actions={actions}
            />
            {hasChildren && isOpen && (
              <OutlineNodes
                nodes={node.children}
                depth={depth + 1}
                open={open}
                activeId={activeId}
                marks={marks}
                actions={actions}
                onToggle={onToggle}
                onJump={onJump}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface OutlineMarkListProps {
  marks: OutlineMarks;
  depth: number;
  actions: MarkActions;
}

/**
 * One chapter's bookmarks and notes, drawn as index rows.
 *
 * Editing happens in place: a bookmark's name and a note's text are both just a field, and opening
 * a dialog for either would be heavier than the thing being edited.
 */
function OutlineMarkList({ marks, depth, actions }: OutlineMarkListProps) {
  const [editing, setEditing] = useState<{ kind: 'bookmark' | 'note'; id: string } | null>(null);
  const [draft, setDraft] = useState('');

  if (marks.bookmarks.length === 0 && marks.notes.length === 0) return null;

  const begin = (kind: 'bookmark' | 'note', id: string, value: string): void => {
    setEditing({ kind, id });
    setDraft(value);
  };
  const cancel = (): void => {
    setEditing(null);
    setDraft('');
  };
  const commitBookmark = (bookmark: Bookmark): void => {
    actions.onRenameBookmark(bookmark.id, draft);
    cancel();
  };
  const commitNote = (annotation: Annotation): void => {
    actions.onEditNote(annotation.id, draft);
    cancel();
  };

  return (
    <ul className="outline-marks" style={{ paddingLeft: `${String(depth * 18 + 18)}px` }}>
      {marks.bookmarks.map((bookmark) => {
        const isEditing = editing?.kind === 'bookmark' && editing.id === bookmark.id;
        return (
          <li key={bookmark.id} className="outline-mark" data-kind="bookmark">
            {isEditing ? (
              <form
                className="outline-mark-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  commitBookmark(bookmark);
                }}
              >
                <BookmarkIcon size={12} aria-hidden="true" />
                <input
                  // The field is the only thing that appeared; focusing it is the whole point.
                  autoFocus
                  value={draft}
                  placeholder={defaultBookmarkLabel(bookmark.page)}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') cancel();
                  }}
                />
                <button type="submit" className="icon-btn" aria-label="保存书签">
                  <Check size={12} aria-hidden="true" />
                </button>
                <button type="button" className="icon-btn" aria-label="取消编辑" onClick={cancel}>
                  <X size={12} aria-hidden="true" />
                </button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="outline-mark-main"
                  title={
                    bookmark.label === '' ? defaultBookmarkLabel(bookmark.page) : bookmark.label
                  }
                  onClick={() => {
                    actions.onJump(bookmark.page);
                  }}
                >
                  <BookmarkIcon size={12} aria-hidden="true" />
                  <span className="outline-mark-text">
                    {bookmark.label === '' ? defaultBookmarkLabel(bookmark.page) : bookmark.label}
                  </span>
                  {bookmark.label !== '' && (
                    <span className="outline-mark-page">第 {bookmark.page} 页</span>
                  )}
                </button>
                {!actions.readOnly.bookmark && (
                  <span className="outline-mark-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`重命名书签「${bookmark.label === '' ? defaultBookmarkLabel(bookmark.page) : bookmark.label}」`}
                      onClick={() => {
                        begin('bookmark', bookmark.id, bookmark.label);
                      }}
                    >
                      <Pencil size={11} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`删除书签「${bookmark.label === '' ? defaultBookmarkLabel(bookmark.page) : bookmark.label}」`}
                      onClick={() => {
                        actions.onDeleteBookmark(bookmark);
                      }}
                    >
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </>
            )}
          </li>
        );
      })}

      {marks.notes.map((annotation) => {
        const isEditing = editing?.kind === 'note' && editing.id === annotation.id;
        const excerpt = annotation.note.trim() === '' ? annotation.quote : annotation.note;
        return (
          <li
            key={annotation.id}
            className="outline-mark"
            data-kind="note"
            data-active={annotation.id === actions.activeNoteId}
          >
            {isEditing ? (
              <form
                className="outline-mark-edit outline-mark-edit--note"
                onSubmit={(event) => {
                  event.preventDefault();
                  commitNote(annotation);
                }}
              >
                <StickyNote size={12} aria-hidden="true" />
                <textarea
                  autoFocus
                  rows={3}
                  value={draft}
                  placeholder="写下这条笔记"
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') cancel();
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      commitNote(annotation);
                    }
                  }}
                />
                <button type="submit" className="icon-btn" aria-label="保存笔记">
                  <Check size={12} aria-hidden="true" />
                </button>
                <button type="button" className="icon-btn" aria-label="取消编辑" onClick={cancel}>
                  <X size={12} aria-hidden="true" />
                </button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="outline-mark-main"
                  title={excerpt}
                  onClick={() => {
                    actions.onJumpToNote(annotation);
                  }}
                >
                  <StickyNote size={12} aria-hidden="true" />
                  <span className="outline-mark-text">{excerpt}</span>
                  <span className="outline-mark-kind">
                    {ANNOTATION_KIND_LABEL[annotation.kind]}
                  </span>
                  {annotation.kind === 'question' && annotation.resolvedAt !== undefined && (
                    <span className="outline-mark-kind outline-mark-kind--resolved">已解决</span>
                  )}
                  <span className="outline-mark-page">第 {annotation.page} 页</span>
                </button>
                {!actions.readOnly.note && (
                  <span className="outline-mark-actions">
                    {annotation.kind === 'question' && (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={
                          annotation.resolvedAt === undefined
                            ? `标记第 ${String(annotation.page)} 页的疑问已解决`
                            : `重新打开第 ${String(annotation.page)} 页的疑问`
                        }
                        aria-pressed={annotation.resolvedAt !== undefined}
                        onClick={() => {
                          actions.onResolveNote(
                            annotation.id,
                            annotation.resolvedAt === undefined ? Date.now() : null,
                          );
                        }}
                      >
                        {annotation.resolvedAt === undefined ? (
                          <CircleCheck size={11} aria-hidden="true" />
                        ) : (
                          <Undo2 size={11} aria-hidden="true" />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`编辑第 ${String(annotation.page)} 页的笔记`}
                      onClick={() => {
                        begin('note', annotation.id, annotation.note);
                      }}
                    >
                      <Pencil size={11} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`删除第 ${String(annotation.page)} 页的笔记`}
                      onClick={() => {
                        actions.onDeleteNote(annotation);
                      }}
                    >
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Assigns every mark to the deepest chapter that has already started on its page.
 *
 * Page-based rather than text-based on purpose: a note can be re-anchored and a bookmark is only a
 * page, while an outline entry always knows where its chapter begins. Marks before the first
 * chapter go into the loose group; a mark after the last chapter belongs to the last chapter,
 * which is the section the reader was in.
 */
function groupMarks(
  items: readonly OutlineEntry[],
  bookmarks: readonly Bookmark[],
  annotations: readonly Annotation[],
): { byChapter: Map<string, OutlineMarks>; loose: OutlineMarks } {
  const map = new Map<string, { bookmarks: Bookmark[]; notes: Annotation[] }>();
  const loose = { bookmarks: [] as Bookmark[], notes: [] as Annotation[] };

  const put = (
    id: string | null,
    apply: (marks: { bookmarks: Bookmark[]; notes: Annotation[] }) => void,
  ) => {
    if (id === null) {
      apply(loose);
      return;
    }
    const existing = map.get(id);
    if (existing !== undefined) {
      apply(existing);
      return;
    }
    const created = { bookmarks: [] as Bookmark[], notes: [] as Annotation[] };
    map.set(id, created);
    apply(created);
  };

  for (const bookmark of sortBookmarks(bookmarks)) {
    put(chapterForPage(items, bookmark.page), (marks) => {
      marks.bookmarks.push(bookmark);
    });
  }
  for (const annotation of [...annotations].sort(
    (one, other) => one.page - other.page || one.createdAt - other.createdAt,
  )) {
    put(chapterForPage(items, annotation.page), (marks) => {
      marks.notes.push(annotation);
    });
  }

  return { byChapter: map, loose };
}

/** The deepest, latest-starting chapter at or before `page`; null before the first one. */
function chapterForPage(nodes: readonly OutlineEntry[], page: number): string | null {
  let best: { id: string; page: number; depth: number } | null = null;
  const walk = (list: readonly OutlineEntry[], depth: number): void => {
    for (const node of list) {
      if (node.page !== null && node.page <= page) {
        if (
          best === null ||
          node.page > best.page ||
          (node.page === best.page && depth >= best.depth)
        ) {
          best = { id: node.id, page: node.page, depth };
        }
      }
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return best === null ? null : (best as { id: string }).id;
}

function containsId(node: OutlineEntry, id: string | null): boolean {
  if (id === null) return false;
  return node.children.some((child) => child.id === id || containsId(child, id));
}

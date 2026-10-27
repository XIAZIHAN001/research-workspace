import {
  Bookmark as BookmarkIcon,
  BookmarkPlus,
  Check,
  ChevronRight,
  CircleCheck,
  BookMarked,
  FileText,
  Sparkles,
  Download,
  Pencil,
  StickyNote,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import type { PaperSummary } from '../../domain/papers';
import { defaultBookmarkLabel, sortBookmarks, type Bookmark } from '../../domain/bookmark';
import { ANNOTATION_KIND_LABEL, type Annotation } from '../../domain/annotation';
import {
  MAX_DEFINITION_LENGTH,
  MAX_TERM_LENGTH,
  sortGlossary,
  type GlossaryEdit,
  type GlossaryEntry,
} from '../../domain/glossary';
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
  /** The paper's own vocabulary, listed in its own section of this panel. */
  glossary?: readonly GlossaryEntry[];
  /** The AI summary card, when one has been generated for this paper. */
  summary?: PaperSummary;
  /** True while a summary request is in flight. */
  summaryBusy?: boolean;
  /** What a failed generation said, or a transient note; shown in the summary section. */
  summaryNotice?: string | null;
  /** How much of the paper a request would carry, for the confirmation line. */
  summaryScope?: { pagesSent: number; pagesTotal: number; truncated: boolean } | null;
  /**
   * Whether the service is an online provider, so the confirm line can name the cost.
   * Null means "not checked yet" and is worded as possibly billable, never as free.
   */
  summaryOnline?: boolean | null;
  /** Asks the host to look up the service before the confirm line states a cost. */
  onPrepareSummary?: () => void;
  /** True when the card was generated from a different PDF file than the paper now holds. */
  summaryStale?: boolean;
  onGenerateSummary?: () => void;
  onClearSummary?: () => void;
  onAddGlossaryTerm?: (draft: { term: string; definition: string }) => void;
  onEditGlossaryTerm?: (id: string, edit: GlossaryEdit) => void;
  onRemoveGlossaryTerm?: (id: string) => void;
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
  glossary = [],
  summary,
  summaryBusy = false,
  summaryNotice = null,
  summaryScope = null,
  summaryOnline = null,
  onPrepareSummary,
  summaryStale = false,
  onGenerateSummary,
  onClearSummary,
  onAddGlossaryTerm,
  onEditGlossaryTerm,
  onRemoveGlossaryTerm,
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
        {(onGenerateSummary !== undefined || summary !== undefined) && (
          <SummarySection
            summary={summary}
            busy={summaryBusy}
            notice={summaryNotice}
            scope={summaryScope}
            online={summaryOnline}
            stale={summaryStale}
            onGenerate={onGenerateSummary}
            onPrepare={onPrepareSummary}
            onClear={onClearSummary}
          />
        )}
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
        <GlossarySection
          entries={glossary}
          editable={onAddGlossaryTerm !== undefined}
          onAdd={onAddGlossaryTerm}
          onEdit={onEditGlossaryTerm}
          onRemove={onRemoveGlossaryTerm}
        />
      </div>
    </aside>
  );
}

interface GlossaryDraft {
  /** The entry being edited, or null while the row is a brand-new term. */
  id: string | null;
  term: string;
  definition: string;
}

/**
 * The paper's one-page summary card, and the (confirmed) action that generates it.
 *
 * Generation is two clicks, like every model call in this app: the first opens the disclosure —
 * what will be sent, and whether it costs — and only 开始生成 talks to the service.
 */
function SummarySection({
  summary,
  busy,
  notice,
  scope,
  online,
  stale,
  onGenerate,
  onPrepare,
  onClear,
}: {
  summary: PaperSummary | undefined;
  busy: boolean;
  notice: string | null;
  scope: { pagesSent: number; pagesTotal: number; truncated: boolean } | null;
  online: boolean | null;
  stale: boolean;
  onGenerate?: () => void;
  onPrepare?: () => void;
  onClear?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const scopeText =
    scope === null
      ? '整篇论文的文字'
      : `整篇论文 ${String(scope.pagesSent)}/${String(scope.pagesTotal)} 页的文字` +
        (scope.truncated ? '（超长部分不发送）' : '');
  // Only a mock provider may be called free. An unchecked service is not a free one: the
  // reader is about to send a whole paper, and silence here used to read as "no charge".
  const costText =
    online === true
      ? '将调用在线模型，可能产生费用。'
      : online === false
        ? '当前是本地模拟，不产生任何费用。'
        : '尚未确认 AI 服务状态；若为在线模式，将产生费用。';

  return (
    <section className="outline-summary" aria-label="摘要卡">
      <p className="outline-loose-title">
        <FileText size={12} aria-hidden="true" /> 摘要卡
      </p>
      {summary !== undefined && (
        <>
          <p className="outline-summary-text">{summary.text}</p>
          <p className="outline-summary-meta">
            {summary.providerLabel} · {summary.model} · {summary.online ? '在线' : '本地模拟'} ·
            生成于 {new Date(summary.createdAt).toLocaleDateString('zh-Hans-CN')}
          </p>
          {stale && (
            <p className="outline-summary-stale" role="status">
              这份摘要生成自另一个 PDF 版本；文件已更换，内容可能不再对应。重新生成即可更新。
            </p>
          )}
        </>
      )}
      {confirming ? (
        <div className="outline-summary-confirm">
          <p className="outline-note">
            将发送{scopeText}。{costText}
          </p>
          <div className="outline-mark-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onGenerate?.();
              }}
            >
              {busy ? '生成中…' : '开始生成'}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setConfirming(false);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : onGenerate !== undefined ? (
        summary === undefined ? (
          <div className="outline-summary-confirm">
            <p className="outline-note">一句话看懂这篇论文：问题、方法、结论。</p>
            <div className="outline-mark-actions">
              <button
                type="button"
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => {
                  onPrepare?.();
                  setConfirming(true);
                }}
              >
                <Sparkles size={12} aria-hidden="true" />
                生成摘要卡
              </button>
            </div>
          </div>
        ) : (
          <div className="outline-mark-actions outline-summary-actions">
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => {
                onPrepare?.();
                setConfirming(true);
              }}
            >
              <Sparkles size={12} aria-hidden="true" />
              重新生成
            </button>
            {onClear !== undefined && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setClearing(true);
                }}
              >
                移除
              </button>
            )}
          </div>
        )
      ) : null}
      {notice !== null && (
        <p className="outline-note" role="status">
          {notice}
        </p>
      )}
      {busy && summary === undefined && <p className="outline-note">正在生成，稍候…</p>}
      <ConfirmDialog
        open={clearing}
        title="移除摘要卡？"
        confirmLabel="确定移除"
        danger
        onConfirm={() => {
          setClearing(false);
          onClear?.();
        }}
        onClose={() => {
          setClearing(false);
        }}
      >
        <p>摘要卡会从这篇论文的记录里移除；重新生成需要再调用一次模型。</p>
      </ConfirmDialog>
    </section>
  );
}

/**
 * The paper's own vocabulary: terms the reader defined once and looks up while reading.
 *
 * Lives at the end of the outline panel because a term belongs to the whole paper, not to a
 * chapter — unlike bookmarks and notes, which are anchored to a place and belong in the tree.
 */
function GlossarySection({
  entries,
  editable,
  onAdd,
  onEdit,
  onRemove,
}: {
  entries: readonly GlossaryEntry[];
  editable: boolean;
  onAdd?: (draft: { term: string; definition: string }) => void;
  onEdit?: (id: string, edit: GlossaryEdit) => void;
  onRemove?: (id: string) => void;
}) {
  const [draft, setDraft] = useState<GlossaryDraft | null>(null);
  const sorted = sortGlossary(entries);
  if (!editable && sorted.length === 0) return null;

  const commit = (): void => {
    if (draft === null || draft.term.trim() === '') return;
    if (draft.id === null) onAdd?.({ term: draft.term, definition: draft.definition });
    else onEdit?.(draft.id, { term: draft.term, definition: draft.definition });
    setDraft(null);
  };

  const cancel = (): void => {
    setDraft(null);
  };

  const editingNew = draft !== null && draft.id === null;

  return (
    <section className="outline-glossary" aria-label="术语表">
      <p className="outline-loose-title">术语表（{String(sorted.length)}）</p>
      {sorted.length === 0 && !editingNew && (
        <p className="outline-note">阅读时选中一个缩写或名词，点「术语」，就能在这里查到它。</p>
      )}
      <ul className="outline-glossary-list">
        {sorted.map((entry) =>
          draft?.id === entry.id && draft !== null ? (
            <GlossaryEditRow
              key={entry.id}
              draft={draft}
              setDraft={setDraft}
              commit={commit}
              cancel={cancel}
            />
          ) : (
            <li key={entry.id} className="outline-glossary-item">
              <span className="outline-glossary-copy">
                <span className="outline-glossary-term">{entry.term}</span>
                {entry.definition !== '' && (
                  <span className="outline-glossary-definition">{entry.definition}</span>
                )}
              </span>
              {onEdit !== undefined && (
                <span className="outline-mark-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`编辑术语「${entry.term}」`}
                    onClick={() => {
                      setDraft({ id: entry.id, term: entry.term, definition: entry.definition });
                    }}
                  >
                    <Pencil size={11} aria-hidden="true" />
                  </button>
                  {onRemove !== undefined && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`删除术语「${entry.term}」`}
                      onClick={() => {
                        onRemove(entry.id);
                      }}
                    >
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  )}
                </span>
              )}
            </li>
          ),
        )}
        {editingNew && draft !== null && (
          <GlossaryEditRow
            key="new-term"
            draft={draft}
            setDraft={setDraft}
            commit={commit}
            cancel={cancel}
          />
        )}
      </ul>
      {onAdd !== undefined && !editingNew && (
        <button
          type="button"
          className="btn btn-quiet outline-glossary-add"
          onClick={() => {
            setDraft({ id: null, term: '', definition: '' });
          }}
        >
          <BookMarked size={12} aria-hidden="true" />
          添加术语
        </button>
      )}
    </section>
  );
}

function GlossaryEditRow({
  draft,
  setDraft,
  commit,
  cancel,
}: {
  draft: GlossaryDraft;
  setDraft: (next: GlossaryDraft) => void;
  commit: () => void;
  cancel: () => void;
}) {
  return (
    <li className="outline-glossary-edit">
      <input
        className="input"
        type="text"
        value={draft.term}
        maxLength={MAX_TERM_LENGTH}
        autoFocus
        aria-label="术语"
        placeholder="术语，如 KZG"
        onChange={(event) => {
          setDraft({ ...draft, term: event.target.value });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') cancel();
        }}
      />
      <textarea
        className="input outline-glossary-definition-input"
        value={draft.definition}
        maxLength={MAX_DEFINITION_LENGTH}
        rows={2}
        aria-label="含义"
        placeholder="它在这篇论文里是什么意思…"
        onChange={(event) => {
          setDraft({ ...draft, definition: event.target.value });
        }}
      />
      <span className="outline-mark-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label="保存术语"
          disabled={draft.term.trim() === ''}
          onClick={commit}
        >
          <Check size={11} aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" aria-label="取消编辑术语" onClick={cancel}>
          <X size={11} aria-hidden="true" />
        </button>
      </span>
    </li>
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

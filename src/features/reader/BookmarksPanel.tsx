import { Bookmark, Pencil, Trash2, X } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import {
  BOOKMARK_LABEL_MAX,
  defaultBookmarkLabel,
  sortBookmarks,
  type Bookmark as BookmarkEntry,
} from '../../domain/bookmark';

interface BookmarksPanelProps {
  /** Every saved place in this paper. */
  bookmarks: readonly BookmarkEntry[];
  currentPage: number;
  onJump: (bookmark: BookmarkEntry) => void;
  /** Saves the current page; an empty name is allowed and shown as the page number. */
  onAdd: (label: string) => void;
  onRename: (id: string, label: string) => void;
  onDelete: (bookmark: BookmarkEntry) => void;
  onClose: () => void;
}

/**
 * Saved places in the paper, in reading order.
 *
 * A bookmark is a signpost, not a history: it stays until the reader removes it, and it is
 * the page number that is saved — zoom, window size and re-rendering cannot move it.
 */
export function BookmarksPanel({
  bookmarks,
  currentPage,
  onJump,
  onAdd,
  onRename,
  onDelete,
  onClose,
}: BookmarksPanelProps) {
  const [name, setName] = useState('');
  const ordered = sortBookmarks(bookmarks);

  const add = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onAdd(name);
    setName('');
  };

  return (
    <aside className="outline-panel bookmarks-panel" aria-label="论文书签">
      <div className="outline-head">
        <span className="outline-title">书签</span>
        {bookmarks.length > 0 && <span className="outline-count">{bookmarks.length} 个</span>}
        <button type="button" className="icon-btn" aria-label="关闭书签" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <form className="bookmark-add" onSubmit={add}>
        <label className="bookmark-add-field">
          <span className="sr-only">书签名称</span>
          <input
            className="input"
            value={name}
            maxLength={BOOKMARK_LABEL_MAX}
            placeholder={`为第 ${String(currentPage)} 页添加书签（可留空）`}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <button type="submit" className="btn">
          <Bookmark size={14} aria-hidden="true" />
          添加
        </button>
      </form>

      <div className="outline-scroll">
        {ordered.length === 0 ? (
          <p className="outline-note">还没有书签。翻到想记住的页面，添加一个。</p>
        ) : (
          <ul className="bookmark-list">
            {ordered.map((bookmark) => (
              <BookmarkItem
                key={bookmark.id}
                bookmark={bookmark}
                current={bookmark.page === currentPage}
                onJump={onJump}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

interface BookmarkItemProps {
  bookmark: BookmarkEntry;
  current: boolean;
  onJump: (bookmark: BookmarkEntry) => void;
  onRename: (id: string, label: string) => void;
  onDelete: (bookmark: BookmarkEntry) => void;
}

function BookmarkItem({ bookmark, current, onJump, onRename, onDelete }: BookmarkItemProps) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(bookmark.label);
  const shown = bookmark.label === '' ? defaultBookmarkLabel(bookmark.page) : bookmark.label;

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onRename(bookmark.id, label);
    setEditing(false);
  };

  if (editing) {
    return (
      <li className="bookmark-item">
        <form className="bookmark-edit" onSubmit={submit}>
          <label className="bookmark-add-field">
            <span className="sr-only">书签名称</span>
            <input
              className="input"
              value={label}
              maxLength={BOOKMARK_LABEL_MAX}
              data-autofocus
              onChange={(event) => {
                setLabel(event.target.value);
              }}
            />
          </label>
          <div className="bookmark-edit-actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setLabel(bookmark.label);
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
      </li>
    );
  }

  return (
    <li className="bookmark-item" data-current={current}>
      <button
        type="button"
        className="bookmark-link"
        title={`跳到${shown}`}
        aria-current={current ? 'location' : undefined}
        onClick={() => {
          onJump(bookmark);
        }}
      >
        <span className="bookmark-label">{shown}</span>
        <span className="bookmark-page">第 {bookmark.page} 页</span>
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`重命名「${shown}」`}
        title="重命名"
        onClick={() => {
          setEditing(true);
        }}
      >
        <Pencil size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`删除「${shown}」`}
        title="删除书签"
        onClick={() => {
          onDelete(bookmark);
        }}
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </li>
  );
}

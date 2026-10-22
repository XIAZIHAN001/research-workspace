import { ChevronRight, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  activeOutlineId,
  countOutlineEntries,
  type OutlineEntry,
  type PdfOutlineState,
} from './usePdfOutline';

interface OutlinePanelProps {
  outline: PdfOutlineState;
  currentPage: number;
  onJump: (page: number) => void;
  onClose: () => void;
}

/**
 * The PDF's own table of contents, beside the page.
 *
 * The outline is a navigation aid, not a second rendering of the paper: entries whose
 * destination could not be resolved are shown but not clickable, and the chapter containing the
 * current page is marked. When a chapter is collapsed, the chapter itself carries the mark, so
 * the reader can still see where they are without expanding anything.
 */
export function OutlinePanel({ outline, currentPage, onJump, onClose }: OutlinePanelProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const activeId = useMemo(
    () => activeOutlineId(outline.items, currentPage),
    [outline.items, currentPage],
  );
  // Roots start open: a list of closed chapter titles is not a table of contents yet.
  const defaults = useMemo(() => new Set(outline.items.map((item) => item.id)), [outline.items]);
  const open = expanded ?? defaults;
  const total = useMemo(() => countOutlineEntries(outline.items), [outline.items]);

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
        {outline.status === 'ready' && total > 0 && (
          <span className="outline-count">{total} 项</span>
        )}
        <button type="button" className="icon-btn" aria-label="关闭目录" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="outline-scroll">
        {outline.status === 'loading' && <p className="outline-note">正在读取目录…</p>}
        {outline.status === 'error' && <p className="outline-note">目录读取失败。</p>}
        {outline.status === 'ready' && outline.items.length === 0 && (
          <p className="outline-note">这份 PDF 没有目录。</p>
        )}
        {outline.status === 'ready' && outline.items.length > 0 && (
          <OutlineNodes
            nodes={outline.items}
            depth={0}
            open={open}
            activeId={activeId}
            onToggle={toggle}
            onJump={onJump}
          />
        )}
      </div>
    </aside>
  );
}

interface OutlineNodesProps {
  nodes: readonly OutlineEntry[];
  depth: number;
  open: ReadonlySet<string>;
  activeId: string | null;
  onToggle: (id: string) => void;
  onJump: (page: number) => void;
}

function OutlineNodes({ nodes, depth, open, activeId, onToggle, onJump }: OutlineNodesProps) {
  return (
    <ul className="outline-tree" data-depth={depth}>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isOpen = open.has(node.id);
        // A collapsed branch stays marked when the current page is somewhere inside it.
        const active = node.id === activeId || (!isOpen && containsId(node, activeId));
        return (
          <li key={node.id}>
            <div className="outline-row" style={{ paddingLeft: `${String(depth * 14 + 6)}px` }}>
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
            {hasChildren && isOpen && (
              <OutlineNodes
                nodes={node.children}
                depth={depth + 1}
                open={open}
                activeId={activeId}
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

function containsId(node: OutlineEntry, id: string | null): boolean {
  if (id === null) return false;
  return node.children.some((child) => child.id === id || containsId(child, id));
}

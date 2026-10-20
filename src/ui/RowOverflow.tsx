import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The overflow menu for a dense row.
 *
 * A row in this app carries one thing the reader came for and three things they might. Showing
 * all four as buttons gives every row the same visual weight and, once the labels are Chinese,
 * a wide band of text on the right that pulls the eye away from the title on the left. So the
 * row keeps its one primary action and the rest live behind a single icon button.
 *
 * Children are a function of `close`, because every entry is a command: running one has to
 * dismiss the menu, or the reader is left looking at a menu for a row they just acted on.
 *
 * The panel is plain absolutely-positioned markup rather than a popover library: it closes on
 * outside pointerdown and on Escape (returning focus to the trigger), which is all a row-level
 * menu needs.
 */
export function RowOverflow({
  label = '更多操作',
  children,
}: {
  label?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="row-overflow" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="row-overflow-pop" role="menu" aria-label={label}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** One command inside a `RowOverflow`. */
export function RowOverflowItem({
  icon,
  label,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" role="menuitem" className="row-overflow-item" onClick={onSelect}>
      {icon}
      {label}
    </button>
  );
}
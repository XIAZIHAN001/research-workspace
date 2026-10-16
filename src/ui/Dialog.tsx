import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Modal built on the native <dialog>: the browser traps focus, inerts the page behind it
 * and restores focus on close. Children mount only while open, so forms start fresh.
 */
export function Dialog({ open, title, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Layout effect: the native dialog opens and closes in the same frame as its content
  // mounts and unmounts, so an empty glass box can never be painted.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (open && !element.open) {
      element.showModal();
      // showModal() focuses the first control (the close button); prefer the marked one.
      element.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog glass glass-strong"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}

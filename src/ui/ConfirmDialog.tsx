import type { ReactNode } from 'react';
import { Dialog } from './Dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}

/** Cancel gets the initial focus, so a stray Enter never confirms a destructive action. */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <div className="dialog-text">{children}</div>
      <div className="dialog-actions">
        <button type="button" className="btn" data-autofocus onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

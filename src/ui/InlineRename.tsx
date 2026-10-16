import { useRef, useState } from 'react';
import { MAX_NAME_LENGTH, normalizeName } from '../domain/normalize';

interface InlineRenameProps {
  initial: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/** Text field that edits in place. Enter or blur commits, Escape cancels. */
export function InlineRename({ initial, label, onCommit, onCancel }: InlineRenameProps) {
  const [draft, setDraft] = useState(initial);
  const finished = useRef(false);

  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const name = normalizeName(draft);
    if (commit && name !== null && name !== initial) onCommit(name);
    else onCancel();
  };

  return (
    <input
      className="inline-input"
      aria-label={label}
      value={draft}
      maxLength={MAX_NAME_LENGTH * 2}
      autoFocus
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          // Keep Escape from also closing a surrounding dialog or the mobile sidebar.
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => {
        finish(true);
      }}
    />
  );
}

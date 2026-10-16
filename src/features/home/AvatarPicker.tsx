import { ImagePlus, RotateCcw } from 'lucide-react';
import { useRef, type ChangeEvent } from 'react';
import { AVATAR_ACCEPTED_TYPES } from '../../app/config';
import type { AvatarProblem } from '../../services/avatar';
import { glowProps } from '../../ui/glow';
import { AVATAR_PROBLEM_TEXT } from './useAvatar';

const ACCEPT = [...AVATAR_ACCEPTED_TYPES].join(',');

interface AvatarPickerProps {
  src: string;
  isCustom: boolean;
  problem: AvatarProblem | null;
  onUpload: (file: File) => Promise<void>;
  onReset: () => void;
  /** Called when the picker is opened again, so the last attempt's problem is cleared first. */
  onDismissProblem: () => void;
}

/** The user's figure. The picture lives in a rim-lit ring; replacing it is one click away. */
export function AvatarPicker({
  src,
  isCustom,
  problem,
  onUpload,
  onReset,
  onDismissProblem,
}: AvatarPickerProps) {
  const input = useRef<HTMLInputElement>(null);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file !== undefined) void onUpload(file);
  };

  return (
    <div className="avatar-block">
      <div className="avatar-ring glass" {...glowProps}>
        <button
          type="button"
          className="avatar-btn"
          aria-label="更换形象"
          onClick={() => {
            onDismissProblem();
            input.current?.click();
          }}
        >
          <img className="avatar-img" src={src} alt="" draggable={false} />
          <span className="avatar-hint">
            <ImagePlus size={15} aria-hidden="true" />
            更换
          </span>
        </button>
      </div>
      <input
        ref={input}
        type="file"
        className="sr-only"
        accept={ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={onChange}
      />
      {isCustom && (
        <button type="button" className="btn btn-quiet" onClick={onReset}>
          <RotateCcw size={13} aria-hidden="true" />
          恢复默认形象
        </button>
      )}
      {problem !== null && (
        <p className="hint hint-error" role="alert">
          {AVATAR_PROBLEM_TEXT[problem]}
        </p>
      )}
    </div>
  );
}

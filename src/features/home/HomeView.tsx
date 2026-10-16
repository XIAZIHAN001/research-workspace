import { Plus } from 'lucide-react';
import { useEffect } from 'react';
import type { Project } from '../../domain/project';
import { splitWelcome } from '../../services/welcome';
import { AvatarPicker } from './AvatarPicker';
import type { useAvatar } from './useAvatar';

/** A lead longer than this reads as a sentence rather than a greeting and is set smaller. */
const LONG_LEAD = 16;

interface HomeViewProps {
  avatar: ReturnType<typeof useAvatar>;
  welcome: { text: string | null; status: 'loading' | 'ready' | 'error' };
  selected: Project | null;
  onCreate: () => void;
  onOpenSelected: () => void;
}

export function HomeView({ avatar, welcome, selected, onCreate, onOpenSelected }: HomeViewProps) {
  const { dismiss } = avatar;
  // The cleanup runs when the page is left, so a stale upload problem is not shown again on return.
  useEffect(() => dismiss, [dismiss]);

  const { lead, stop, body } = splitWelcome(welcome.text ?? '');

  return (
    <section className="home" aria-label="首页">
      <AvatarPicker
        src={avatar.src}
        isCustom={avatar.isCustom}
        problem={avatar.problem}
        onUpload={avatar.upload}
        onReset={avatar.reset}
        onDismissProblem={dismiss}
      />
      <h1
        className="welcome"
        aria-live="polite"
        aria-busy={welcome.status === 'loading'}
        data-long={Array.from(lead).length > LONG_LEAD}
      >
        <span className="welcome-lead">{lead}</span>
        {stop !== '' && <span className="sr-only">{stop}</span>}
        {body !== '' && <span className="welcome-body">{body}</span>}
      </h1>
      {selected === null ? (
        <button type="button" className="btn btn-primary" onClick={onCreate}>
          <Plus size={15} aria-hidden="true" />
          新建项目
        </button>
      ) : (
        <button type="button" className="btn" title={selected.name} onClick={onOpenSelected}>
          <span className="btn-label">打开《{selected.name}》</span>
        </button>
      )}
    </section>
  );
}

import { useState, type SubmitEvent } from 'react';
import { MAX_NAME_LENGTH } from '../../domain/normalize';
import { Dialog } from '../../ui/Dialog';

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  /** Returns false when the title was unusable. */
  onCreate: (title: string) => boolean;
}

export function CreateProjectDialog({ open, onClose, onCreate }: CreateProjectDialogProps) {
  return (
    <Dialog open={open} title="新建项目" onClose={onClose}>
      <CreateForm onClose={onClose} onCreate={onCreate} />
    </Dialog>
  );
}

function CreateForm({ onClose, onCreate }: Pick<CreateProjectDialogProps, 'onClose' | 'onCreate'>) {
  const [title, setTitle] = useState('');
  const [failed, setFailed] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (onCreate(title)) onClose();
    else setFailed(true);
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <label className="field">
        <span className="field-label">核心论文标题</span>
        <input
          className="input"
          value={title}
          maxLength={MAX_NAME_LENGTH * 2}
          placeholder="例如 Attention Is All You Need"
          aria-invalid={failed}
          aria-describedby="create-hint"
          data-autofocus
          onChange={(event) => {
            setTitle(event.target.value);
            setFailed(false);
          }}
        />
      </label>
      <p
        id="create-hint"
        className={failed ? 'hint hint-error' : 'hint'}
        role={failed ? 'alert' : undefined}
      >
        {failed ? '请输入论文标题。' : '项目围绕这篇论文展开，之后可以再关联其他论文。'}
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="btn btn-primary">
          创建项目
        </button>
      </div>
    </form>
  );
}

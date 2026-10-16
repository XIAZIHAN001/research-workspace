import { FileText, Pencil, Trash2 } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { Project } from '../../domain/project';
import { glowProps } from '../../ui/glow';
import { InlineRename } from '../../ui/InlineRename';

interface ProjectRowProps {
  project: Project;
  selected: boolean;
  renaming: boolean;
  onSelect: (id: string) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (project: Project) => void;
}

/** One compact line. Click selects, double-click or F2 renames, the icons appear on hover/focus. */
export function ProjectRow({
  project,
  selected,
  renaming,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
}: ProjectRowProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'F2') {
      event.preventDefault();
      onStartRename(project.id);
    }
  };

  return (
    <li className="row" data-selected={selected}>
      {renaming ? (
        <div className="row-main">
          <FileText size={15} aria-hidden="true" />
          <InlineRename
            initial={project.name}
            label={`重命名项目 ${project.name}`}
            onCommit={(name) => {
              onCommitRename(project.id, name);
            }}
            onCancel={onCancelRename}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            {...glowProps}
            className="row-main spot"
            aria-current={selected ? 'true' : undefined}
            title={project.name}
            onClick={() => {
              onSelect(project.id);
            }}
            onDoubleClick={() => {
              onStartRename(project.id);
            }}
            onKeyDown={onKeyDown}
          >
            <FileText size={15} aria-hidden="true" />
            <span className="row-name">{project.name}</span>
          </button>
          <div className="row-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label={`重命名 ${project.name}`}
              title="重命名"
              onClick={() => {
                onStartRename(project.id);
              }}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`删除 ${project.name}`}
              title="删除"
              onClick={() => {
                onRequestDelete(project);
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </li>
  );
}

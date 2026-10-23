import { normalizeName } from './normalize';
import { createPaper, type Paper } from './papers';

/**
 * A project is built around one core paper and may link further papers.
 *
 * Papers are referenced by their knowledge-base id, never copied in: the same paper can
 * belong to several projects, and renaming it (or the project) leaves every link intact.
 * The `papers` registry in ProjectsState is the single source of truth for paper metadata.
 */
export interface Project {
  id: string;
  name: string;
  /** `Paper.id` of the paper the project is built around. */
  corePaperId: string;
  /** `Paper.id` of every linked paper, in the order they were added. */
  relatedPaperIds: string[];
  /** Epoch milliseconds. */
  createdAt: number;
  /** Last project-level activity (creation, rename, paper links, later reading sessions). */
  updatedAt: number;
}

/** Creates a project together with the paper it is built around. Null for a blank title. */
export function createProject(
  rawTitle: string,
  makeId: () => string,
  now: number,
): { project: Project; paper: Paper } | null {
  const name = normalizeName(rawTitle);
  if (name === null) return null;

  // The project keeps a name; the paper it is built around keeps the full title. They are the
  // same words at creation, but a title is allowed to be longer than a name.
  const paper = createPaper({ title: rawTitle }, makeId, now);
  // Unreachable: `name` is already normalized, so createPaper cannot reject it.
  if (paper === null) return null;

  return {
    project: {
      id: makeId(),
      name,
      corePaperId: paper.id,
      relatedPaperIds: [],
      createdAt: now,
      updatedAt: now,
    },
    paper,
  };
}

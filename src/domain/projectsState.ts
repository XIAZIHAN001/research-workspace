import { normalizeName } from './normalize';
import { applyPaperEdit, type Paper, type PaperEdit } from './papers';
import type { Project } from './project';

export interface ProjectsState {
  /** Newest first. Order is stable: selecting a project never reorders the list. */
  projects: Project[];
  /**
   * Knowledge-base registry of every paper, keyed by `Paper.id`. It is the single source
   * of truth for paper metadata; projects only hold ids. A paper stays here even when no
   * project references it any more, so nothing is lost by unlinking or deleting a project.
   */
  papers: Record<string, Paper>;
  selectedId: string | null;
}

export const EMPTY_STATE: ProjectsState = { projects: [], papers: {}, selectedId: null };

export type ProjectsAction =
  | { type: 'hydrate'; state: ProjectsState }
  /** Creates a project and registers the paper it is built around. */
  | { type: 'add'; project: Project; paper: Paper }
  /** Links a paper to a project. `paper` is registered when it is not known yet. */
  | { type: 'linkPaper'; projectId: string; paper: Paper; now: number }
  /** Adds a paper to the knowledge base without attaching it to any project. */
  | { type: 'registerPaper'; paper: Paper }
  | { type: 'unlinkPaper'; projectId: string; paperId: string; now: number }
  /**
   * Changes one paper's own metadata, PDF binding or reading position. Never creates,
   * merges or deletes anything, and refuses an edit that would take over an identifier
   * another paper already owns.
   */
  | { type: 'updatePaper'; paperId: string; edit: PaperEdit; now: number }
  | { type: 'rename'; id: string; name: string; now: number }
  | { type: 'remove'; id: string }
  | { type: 'select'; id: string };

/**
 * Registers a paper unless its id is already known. An id that is already in the registry
 * wins, so a stale copy handed in by a caller can never overwrite the current metadata.
 */
function withPaper(papers: Record<string, Paper>, paper: Paper): Record<string, Paper> {
  return papers[paper.id] === undefined ? { ...papers, [paper.id]: paper } : papers;
}

export function projectsReducer(state: ProjectsState, action: ProjectsAction): ProjectsState {
  switch (action.type) {
    case 'hydrate':
      return action.state;

    case 'add':
      return {
        projects: [action.project, ...state.projects],
        papers: withPaper(state.papers, action.paper),
        selectedId: action.project.id,
      };

    case 'linkPaper': {
      const target = state.projects.find((p) => p.id === action.projectId);
      if (target === undefined) return state;
      // The core paper is already the project's own reference; a repeat link changes nothing.
      if (target.corePaperId === action.paper.id) return state;
      if (target.relatedPaperIds.includes(action.paper.id)) return state;
      return {
        ...state,
        papers: withPaper(state.papers, action.paper),
        projects: state.projects.map((p) =>
          p === target
            ? {
                ...p,
                relatedPaperIds: [...p.relatedPaperIds, action.paper.id],
                updatedAt: action.now,
              }
            : p,
        ),
      };
    }

    case 'registerPaper': {
      const papers = withPaper(state.papers, action.paper);
      return papers === state.papers ? state : { ...state, papers };
    }

    case 'unlinkPaper': {
      const target = state.projects.find((p) => p.id === action.projectId);
      if (target === undefined || !target.relatedPaperIds.includes(action.paperId)) return state;
      // The paper itself stays in the registry: other projects may still reference it.
      return {
        ...state,
        projects: state.projects.map((p) =>
          p === target
            ? {
                ...p,
                relatedPaperIds: p.relatedPaperIds.filter((id) => id !== action.paperId),
                updatedAt: action.now,
              }
            : p,
        ),
      };
    }

    case 'updatePaper': {
      const result = applyPaperEdit(state.papers, action.paperId, action.edit, action.now);
      // A refused edit (unknown paper, identifier owned by someone else) changes nothing at
      // all: the caller has already been told why, and the registry stays as it was.
      if (!result.ok || result.paper === state.papers[action.paperId]) return state;
      return { ...state, papers: { ...state.papers, [action.paperId]: result.paper } };
    }

    case 'rename': {
      const name = normalizeName(action.name);
      const target = state.projects.find((p) => p.id === action.id);
      // No-ops keep the same reference, so the store skips the write and the re-render.
      if (name === null || target === undefined || target.name === name) return state;
      return {
        ...state,
        projects: state.projects.map((p) =>
          p === target ? { ...p, name, updatedAt: action.now } : p,
        ),
      };
    }

    case 'remove': {
      const index = state.projects.findIndex((p) => p.id === action.id);
      if (index === -1) return state;
      const projects = state.projects.filter((p) => p.id !== action.id);
      // Papers are deliberately not pruned: a paper shared with another project must
      // survive, and the registry entry is the only place its identity is recorded.
      if (state.selectedId !== action.id) return { ...state, projects };
      // Prefer the project that slides into the vacated slot, then the one above it.
      const next = projects[index] ?? projects[index - 1] ?? null;
      return { ...state, projects, selectedId: next?.id ?? null };
    }

    case 'select':
      if (state.selectedId === action.id || !state.projects.some((p) => p.id === action.id)) {
        return state;
      }
      return { ...state, selectedId: action.id };
  }
}

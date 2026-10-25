import { applyAnnotationEdit, type Annotation, type AnnotationEdit } from './annotation';
import type { Bookmark } from './bookmark';
import { applyGlossaryEdit, type GlossaryEdit, type GlossaryEntry } from './glossary';
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
  /**
   * Highlights and notes, in creation order. They belong to a paper rather than to a project,
   * so deleting a project never touches them — that is the whole reason they live here and not
   * inside `Project`.
   */
  annotations: Annotation[];
  /**
   * Saved places in papers. Like annotations they belong to a paper, not a project, and
   * survive the project that led the reader to them.
   */
  bookmarks: Bookmark[];
  /**
   * The terms a reader defined for a paper, like the annotations and bookmarks beside them:
   * paper-scoped, project-independent, and untouched by deleting a project.
   */
  glossary: GlossaryEntry[];
}

export const EMPTY_STATE: ProjectsState = {
  projects: [],
  papers: {},
  annotations: [],
  bookmarks: [],
  glossary: [],
  selectedId: null,
};

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
  /** Adds a highlight to a paper. */
  | { type: 'addAnnotation'; annotation: Annotation }
  /** Changes what the reader wrote about a passage, never where the passage is. */
  | { type: 'updateAnnotation'; id: string; edit: AnnotationEdit; now: number }
  | { type: 'removeAnnotation'; id: string }
  /** Saves a place in a paper. */
  | { type: 'addBookmark'; bookmark: Bookmark }
  | { type: 'addGlossary'; entry: GlossaryEntry }
  | { type: 'updateGlossary'; id: string; edit: GlossaryEdit; now: number }
  | { type: 'removeGlossary'; id: string }
  /** Changes the bookmark's name; where it points never moves. */
  | { type: 'renameBookmark'; id: string; label: string }
  | { type: 'removeBookmark'; id: string }
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
        ...state,
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

    case 'addAnnotation': {
      if (state.annotations.some((existing) => existing.id === action.annotation.id)) return state;
      return { ...state, annotations: [...state.annotations, action.annotation] };
    }

    case 'updateAnnotation': {
      const current = state.annotations.find((annotation) => annotation.id === action.id);
      if (current === undefined) return state;
      const updated = applyAnnotationEdit(current, action.edit, action.now);
      if (updated === current) return state;
      return {
        ...state,
        annotations: state.annotations.map((annotation) =>
          annotation === current ? updated : annotation,
        ),
      };
    }

    case 'removeAnnotation': {
      if (!state.annotations.some((annotation) => annotation.id === action.id)) return state;
      return {
        ...state,
        annotations: state.annotations.filter((annotation) => annotation.id !== action.id),
      };
    }

    case 'addBookmark': {
      if (state.bookmarks.some((bookmark) => bookmark.id === action.bookmark.id)) return state;
      return { ...state, bookmarks: [...state.bookmarks, action.bookmark] };
    }

    case 'addGlossary': {
      if (state.glossary.some((entry) => entry.id === action.entry.id)) return state;
      return { ...state, glossary: [...state.glossary, action.entry] };
    }

    case 'updateGlossary': {
      const current = state.glossary.find((entry) => entry.id === action.id);
      if (current === undefined) return state;
      // A blank term is refused by the domain, not silently trimmed into meaninglessness.
      const updated = applyGlossaryEdit(current, action.edit, action.now);
      if (updated === null || updated === current) return state;
      return {
        ...state,
        glossary: state.glossary.map((entry) => (entry === current ? updated : entry)),
      };
    }

    case 'removeGlossary': {
      if (!state.glossary.some((entry) => entry.id === action.id)) return state;
      return { ...state, glossary: state.glossary.filter((entry) => entry.id !== action.id) };
    }

    case 'renameBookmark': {
      const current = state.bookmarks.find((bookmark) => bookmark.id === action.id);
      if (current === undefined || current.label === action.label) return state;
      return {
        ...state,
        bookmarks: state.bookmarks.map((bookmark) =>
          bookmark === current ? { ...bookmark, label: action.label } : bookmark,
        ),
      };
    }

    case 'removeBookmark': {
      if (!state.bookmarks.some((bookmark) => bookmark.id === action.id)) return state;
      return {
        ...state,
        bookmarks: state.bookmarks.filter((bookmark) => bookmark.id !== action.id),
      };
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

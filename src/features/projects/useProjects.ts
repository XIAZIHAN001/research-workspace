import { useMemo, useSyncExternalStore } from 'react';
import type { Annotation, AnnotationEdit } from '../../domain/annotation';
import type { Bookmark } from '../../domain/bookmark';
import {
  applyPaperEdit,
  createPaper,
  resolvePaperIdentity,
  type AddPaperOutcome,
  type PaperEdit,
  type PaperEditResult,
  type PaperInput,
  type PaperReferenceOutcome,
} from '../../domain/papers';
import { createProject, type Project } from '../../domain/project';
import { makeId } from '../../services/ids';
import type { ProjectsStore } from '../../services/projectsStore';

/** Subscribes to the projects store and exposes intent-level actions. */
export function useProjects(store: ProjectsStore) {
  const { state, persisted, issue } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const selected = state.projects.find((p) => p.id === state.selectedId) ?? null;

  const actions = useMemo(
    () => ({
      /** Returns the new project, or null when the title is blank. */
      create(title: string): Project | null {
        const created = createProject(title, makeId, Date.now());
        if (created === null) return null;
        store.dispatch({ type: 'add', project: created.project, paper: created.paper });
        return created.project;
      },
      /**
       * Links a paper to a project, which is how one paper ends up in several projects.
       *
       * A DOI or arXiv id that matches a paper already in the knowledge base reuses that
       * paper (and its future notes); otherwise a new one is created. Titles are never
       * used to decide identity. Identifiers that point at different existing papers are
       * reported as a conflict and change nothing — the caller decides, we never guess.
       */
      referencePaper(projectId: string, input: PaperInput): PaperReferenceOutcome {
        // Read the registry now rather than closing over a render-time copy: the store is
        // the single source of truth, and an action must never link against stale papers.
        const { papers } = store.getSnapshot().state;
        const identity = resolvePaperIdentity(papers, input);
        if (identity.kind === 'conflict') return { status: 'conflict', papers: identity.papers };

        const paper =
          identity.kind === 'match' ? identity.paper : createPaper(input, makeId, Date.now());
        if (paper === null) return { status: 'invalid' };

        store.dispatch({ type: 'linkPaper', projectId, paper, now: Date.now() });
        return { status: 'linked', paper };
      },
      unlinkPaper(projectId: string, paperId: string): void {
        store.dispatch({ type: 'unlinkPaper', projectId, paperId, now: Date.now() });
      },
      /**
       * Links a paper that is already in the knowledge base to a project. Distinct from
       * `referencePaper`, which decides identity first: this one only adds a reference.
       */
      linkPaper(projectId: string, paperId: string): void {
        const { papers } = store.getSnapshot().state;
        const paper = papers[paperId];
        if (paper === undefined) return;
        store.dispatch({ type: 'linkPaper', projectId, paper, now: Date.now() });
      },
      /**
       * Adds a paper to the knowledge base on its own, without attaching it to a project.
       *
       * Returns the paper that now holds this identity: the existing one when a DOI or
       * arXiv id already identifies it, otherwise a new record. Identifiers that point at
       * different papers are reported as a conflict and nothing is written.
       */
      addPaper(input: PaperInput): AddPaperOutcome {
        const { papers } = store.getSnapshot().state;
        const identity = resolvePaperIdentity(papers, input);
        if (identity.kind === 'conflict') return { status: 'conflict', papers: identity.papers };
        if (identity.kind === 'match') return { status: 'added', paper: identity.paper };

        const paper = createPaper(input, makeId, Date.now());
        if (paper === null) return { status: 'invalid' };
        store.dispatch({ type: 'registerPaper', paper });
        return { status: 'added', paper };
      },
      /**
       * Changes one paper's metadata, PDF binding or reading position. Returns why an edit
       * was refused instead of applying part of it.
       */
      updatePaper(paperId: string, edit: PaperEdit): PaperEditResult {
        // Checked against the same rule the reducer applies, so the caller is told the
        // outcome while the store stays the single place that decides it.
        const result = applyPaperEdit(store.getSnapshot().state.papers, paperId, edit, Date.now());
        if (!result.ok) return result;
        store.dispatch({ type: 'updatePaper', paperId, edit, now: Date.now() });
        return result;
      },
      /** Saves a highlight (and whatever was written with it) onto its paper. */
      addAnnotation(annotation: Annotation): void {
        store.dispatch({ type: 'addAnnotation', annotation });
      },
      /** Edits the note or its kind; the anchor is not editable. */
      updateAnnotation(id: string, edit: AnnotationEdit): void {
        store.dispatch({ type: 'updateAnnotation', id, edit, now: Date.now() });
      },
      removeAnnotation(id: string): void {
        store.dispatch({ type: 'removeAnnotation', id });
      },
      /** Saves a place in a paper; the reader names it or leaves it as a page number. */
      addBookmark(bookmark: Bookmark): void {
        store.dispatch({ type: 'addBookmark', bookmark });
      },
      renameBookmark(id: string, label: string): void {
        store.dispatch({ type: 'renameBookmark', id, label });
      },
      removeBookmark(id: string): void {
        store.dispatch({ type: 'removeBookmark', id });
      },
      rename(id: string, name: string): void {
        store.dispatch({ type: 'rename', id, name, now: Date.now() });
      },
      remove(id: string): void {
        store.dispatch({ type: 'remove', id });
      },
      select(id: string): void {
        store.dispatch({ type: 'select', id });
      },
    }),
    [store],
  );

  return {
    projects: state.projects,
    papers: state.papers,
    annotations: state.annotations,
    bookmarks: state.bookmarks,
    selected,
    persisted,
    issue,
    actions,
  };
}

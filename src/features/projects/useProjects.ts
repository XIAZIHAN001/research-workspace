import { useMemo, useSyncExternalStore } from 'react';
import {
  createPaper,
  resolvePaperIdentity,
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

  return { projects: state.projects, papers: state.papers, selected, persisted, issue, actions };
}

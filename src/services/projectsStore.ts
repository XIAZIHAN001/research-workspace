import { projectsReducer, type ProjectsAction, type ProjectsState } from '../domain/projectsState';
import {
  defaultStore,
  loadProjectsWithReport,
  saveProjects,
  type KeyValueStore,
  type LoadIssue,
} from './storage';

export interface ProjectsSnapshot {
  state: ProjectsState;
  /** False after a write failed. The in-memory state is still right, but would be lost on exit. */
  persisted: boolean;
  /** Why the stored payload is not in use, or null after a clean load. */
  issue: LoadIssue | null;
}

/**
 * External store for useSyncExternalStore. Persistence happens inside `dispatch`
 * (an event), not in a render effect, so there is no render-time side effect to guard.
 */
export interface ProjectsStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ProjectsSnapshot;
  dispatch: (action: ProjectsAction) => void;
}

export function createProjectsStore(storage: KeyValueStore | null = defaultStore()): ProjectsStore {
  const loaded = loadProjectsWithReport(storage);
  let snapshot: ProjectsSnapshot = {
    state: loaded.state,
    persisted: loaded.persisted,
    issue: loaded.issue,
  };
  const listeners = new Set<() => void>();

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dispatch: (action) => {
      const state = projectsReducer(snapshot.state, action);
      if (state === snapshot.state) return;
      snapshot = {
        state,
        persisted: saveProjects(state, storage),
        issue: snapshot.issue,
      };
      listeners.forEach((notify) => {
        notify();
      });
    },
  };
}

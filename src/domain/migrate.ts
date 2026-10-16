import { parseLegacyState, parseProjectsState, type LegacyPaperRef } from './parse';
import type { Paper } from './papers';
import type { Project } from './project';
import type { ProjectsState } from './projectsState';

/**
 * The persisted schema this build reads and writes. Version 1 is the Phase 0 payload,
 * which carried no version field at all; every payload without one is treated as v1.
 */
export const SCHEMA_VERSION = 3;

export type MigrationFailure =
  /** Not JSON at all. */
  | { reason: 'unreadable'; detail: string }
  /** Valid JSON of the wrong shape, or of a shape this build cannot read. */
  | { reason: 'invalid'; detail: string }
  /** Written by a newer build: it may be perfectly good data, we just do not know it. */
  | { reason: 'unsupported-version'; detail: string; found: number }
  /** Our own migration code failed on a payload it accepted. Never the data's fault. */
  | { reason: 'migration-failed'; detail: string; from: number };

export type MigrationOutcome =
  | {
      ok: true;
      state: ProjectsState;
      /** Version the payload was stored at. Below SCHEMA_VERSION means it was migrated. */
      from: number;
    }
  | ({ ok: false } & MigrationFailure);

/** A payload transform keyed by the version it reads. Null means: not that shape. */
export type MigrationStep = (payload: Record<string, unknown>) => Record<string, unknown> | null;

/**
 * Phase 0 → 2: project-local `PaperRef` objects become a knowledge-base registry.
 *
 * Paper ids are carried over unchanged rather than regenerated, which is what makes this
 * migration deterministic: running it twice on the same payload produces byte-identical
 * output, so a failed write-back can be retried without inventing new identities. Papers
 * that only look alike (same title, no shared id) stay separate — the v1 data has no DOI
 * or arXiv id to justify merging them.
 *
 * A legacy id is a *project-local* identifier, so it is only evidence of identity when the
 * records under it agree exactly. When two records share an id but disagree on title,
 * authors or year, the id was reused (copied, hand-edited or partially restored data) and
 * merging them would silently delete one paper's metadata while pointing both projects at
 * the surviving record. Such records are split instead: the first keeps the legacy id, the
 * rest get a derived id that depends only on the legacy id and their position.
 */
function migrateV1ToV2(payload: Record<string, unknown>): Record<string, unknown> | null {
  const legacy = parseLegacyState(payload);
  if (legacy === null) return null;
  // An empty id cannot be carried over, and inventing one would break determinism.
  const degenerate = legacy.projects.some(
    (project) => project.corePaper.id === '' || project.relatedPapers.some((ref) => ref.id === ''),
  );
  if (degenerate) return null;
  // Two projects sharing an id cannot be represented: `Project.id` is the anchor every
  // note and annotation will point at, so the payload is quarantined rather than merged.
  if (new Set(legacy.projects.map((project) => project.id)).size !== legacy.projects.length) {
    return null;
  }

  const papers: Record<string, Paper> = {};
  /** Per legacy id: the distinct records seen under it, keyed by an exact-metadata fingerprint. */
  const records = new Map<string, Map<string, string>>();

  const register = (ref: LegacyPaperRef, since: number): string => {
    const seen = records.get(ref.id) ?? new Map<string, string>();
    records.set(ref.id, seen);

    const fingerprint = paperFingerprint(ref);
    const known = seen.get(fingerprint);
    if (known !== undefined) return known;

    const paperId = takePaperId(ref.id, seen.size, papers);
    seen.set(fingerprint, paperId);

    const paper: Paper = {
      id: paperId,
      title: ref.title,
      authors: [...ref.authors],
      // The paper was never stamped in v1; the project that introduced it is the
      // closest honest approximation, and it is stable across runs.
      createdAt: since,
      updatedAt: since,
    };
    if (typeof ref.year === 'number') paper.year = ref.year;
    papers[paperId] = paper;
    return paperId;
  };

  const projects: Project[] = legacy.projects.map((project) => {
    const corePaperId = register(project.corePaper, project.createdAt);
    const relatedPaperIds: string[] = [];
    for (const ref of project.relatedPapers) {
      const paperId = register(ref, project.createdAt);
      // A v1 payload may name the core paper again as a related one, or repeat an entry.
      // Both are contradictions the current schema forbids, and dropping them loses
      // nothing: the paper is still linked through the core or the first mention.
      if (paperId === corePaperId || relatedPaperIds.includes(paperId)) continue;
      relatedPaperIds.push(paperId);
    }
    return {
      id: project.id,
      name: project.name,
      corePaperId,
      relatedPaperIds,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  });

  return { version: 2, projects, papers, selectedId: legacy.selectedId };
}

/** The metadata a legacy record carries, in a form two records can be compared by. */
function paperFingerprint(ref: LegacyPaperRef): string {
  return JSON.stringify([ref.title, ref.authors, ref.year ?? null]);
}

/**
 * A free id for a record under `legacyId`: the legacy id itself for the first record under
 * it, and a derived id for the ones split off it. Both paths keep looking while the id is
 * taken, so a payload whose plain ids already look derived cannot make two records collide.
 * The result depends only on the legacy id, the record's position and the traversal order,
 * which is fixed — the same payload always produces the same ids.
 */
function takePaperId(legacyId: string, index: number, taken: Record<string, Paper>): string {
  let candidate = index === 0 ? legacyId : `${legacyId}#${index}`;
  while (taken[candidate] !== undefined) candidate = `${candidate}#`;
  return candidate;
}

/**
 * v2 → v3 added two optional paper fields: the local PDF binding (`Paper.pdf`) and the
 * reading position (`Paper.reading`). Nothing needs rewriting — a v2 payload already
 * satisfies the v3 shape — but the version is still bumped, so an older build refuses the
 * file (backing it up and leaving it alone) instead of quietly dropping the PDF binding on
 * its next write.
 */
function migrateV2ToV3(payload: Record<string, unknown>): Record<string, unknown> | null {
  // Validated first so a payload that is not really v2 is reported as bad data (`invalid`)
  // rather than as a migration bug.
  if (parseProjectsState(payload) === null) return null;
  return { ...payload, version: 3 };
}

const MIGRATIONS: Record<number, MigrationStep> = { 1: migrateV1ToV2, 2: migrateV2ToV3 };
/** The persisted envelope for a state: the single writer of the on-disk shape. */
export function serializeProjects(state: ProjectsState): string {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    projects: state.projects,
    papers: state.papers,
    selectedId: state.selectedId,
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The schema version a payload declares, or 1 when it declares none (Phase 0 data). */
function readVersion(payload: Record<string, unknown>): number | null {
  const { version } = payload;
  if (version === undefined) return 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a stored payload: detects its version, migrates it up to SCHEMA_VERSION and
 * validates the result. Pure — the caller decides what to do with the outcome.
 *
 * The loop is bounded by SCHEMA_VERSION and every step must strictly advance the version,
 * so a wrong migration table cannot spin here. `steps` defaults to the real table and is
 * only ever passed by tests that need a deliberately broken one.
 */
export function migrateStoredPayload(
  raw: string,
  steps: Record<number, MigrationStep> = MIGRATIONS,
): MigrationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: describe(error) };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'invalid', detail: 'payload is not an object' };
  }

  const detected = readVersion(parsed);
  if (detected === null) {
    return { ok: false, reason: 'invalid', detail: 'payload has no usable version field' };
  }
  if (detected > SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'unsupported-version',
      found: detected,
      detail: `payload was written by schema version ${detected}, this build reads ${SCHEMA_VERSION}`,
    };
  }

  const from = detected;
  let payload = parsed;
  let version = detected;
  while (version < SCHEMA_VERSION) {
    const step = steps[version];
    if (step === undefined) {
      return {
        ok: false,
        reason: 'migration-failed',
        from,
        detail: `no migration registered for schema version ${version}`,
      };
    }
    let migrated: Record<string, unknown> | null;
    try {
      migrated = step(payload);
    } catch (error) {
      return { ok: false, reason: 'migration-failed', from, detail: describe(error) };
    }
    if (migrated === null) {
      return {
        ok: false,
        reason: 'invalid',
        detail: `payload does not match the schema version ${version} shape`,
      };
    }
    const reached = readVersion(migrated);
    if (reached === null || reached <= version) {
      return {
        ok: false,
        reason: 'migration-failed',
        from,
        detail: `migration from version ${version} did not advance the schema version`,
      };
    }
    payload = migrated;
    version = reached;
  }

  if (version !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'migration-failed',
      from,
      detail: `migrating from version ${from} produced version ${version}`,
    };
  }

  const state = parseProjectsState(payload);
  if (state === null) {
    return version === from
      ? {
          ok: false,
          reason: 'invalid',
          detail: `payload does not match the schema version ${SCHEMA_VERSION} shape`,
        }
      : {
          ok: false,
          reason: 'migration-failed',
          from,
          detail: `migrating from version ${from} produced an invalid state`,
        };
  }

  return { ok: true, state, from };
}

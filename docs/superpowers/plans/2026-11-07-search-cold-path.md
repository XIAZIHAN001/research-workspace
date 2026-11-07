# Search Cold-Path and Benchmark Integrity Plan

> **Execution:** Measure the fixed baseline, implement each bounded stage with regression tests, obtain independent review, and preserve separately reversible commits.

**Goal:** Reduce the first performance checkpoint's search construction cost without losing repeated-query gains, and reject invalid benchmark comparisons.

**Architecture:** Keep the existing explicit, source-scoped search snapshot. Capture immutable values needed for matching and ranking, but defer presentation work until a result is displayed. Keep benchmark provenance checking separate from workload result comparison.

**Tech stack:** Existing TypeScript, React, Vitest and Node benchmark harness. No new dependencies.

**Baseline:** PR #3 at `05d7163f8ce34a32faf2cb694025a18dac33ced8`. The previous checkpoint is documented in `docs/performance/checkpoint-2026-11-06.md`.

## Constraints and review focus

- Preserve complete result values, totals, ordering, Unicode matching, snippets and limit behavior.
- A built index remains an immutable snapshot if the source objects or arrays later change. Results returned to callers must not mutate the index.
- A blank search dialog avoids construction, while clearing and retyping reuse an existing index. A new source must invalidate the old index.
- Benchmark source revisions and timestamps may differ; harness, dependencies, environment and sampling settings must be compatible. Missing provenance must fail closed.
- Do not change persistence, recovery, schema, PDF geometry, native credentials or security gates. Do not change main, force-push, merge or claim untested macOS support.

## Stage 1: Strict benchmark comparison

Files: `scripts/performance/run.mjs`, a small comparison helper and its tests, and `docs/performance/README.md`.

- [x] Add a failing CLI regression proving incompatible provenance is currently accepted.
- [x] Add focused tests for mismatched or missing schema, checksums, runtime/CPU metadata and sample counts; allow different source commits, timestamps, timings and implementation modes.
- [x] Validate provenance before full result comparison and before writing a candidate report; include the helper in the harness fingerprint.
- [x] Run focused tests and independent review, then create a checkpoint commit.

## Stage 2: Lower search cold-path cost

Files: `src/features/search/searchWorkspace.ts`, `GlobalSearchDialog.tsx` and their existing tests.

- [x] Add failing tests for unnecessary presentation work, blank dialog construction, repeated queries, source replacement and mutable-source isolation.
- [x] Defer presentation work to bounded displayed candidates using index-owned value snapshots. Retain matching and ranking behavior.
- [x] Preserve lazy index reuse within each dialog source lifetime and release it when that lifetime ends.
- [x] Run the existing golden-result snapshots, focused structural tests and independent differential checks.
- [x] Commit the candidate and rerun baseline and candidate sequentially with the same finalized harness, dependencies, environment and sample settings. Require all 34 workload outputs to match; report both cold and warm distributions and memory costs.

## Release gate

- [x] Run `npm run check` and `npm run build` on the final candidate; report every failure or skipped stage.
- [x] Obtain an independent review of the combined diff and measurements. Fix important findings and recheck.
- [x] Record results, tradeoffs and deferred work in a dated checkpoint report.
- [x] Recheck the remote head before publishing the current construction branch. Preserve prior commits and confirm published trees match tested trees.
- [ ] Verify the new CI run against the published source, keeping Linux browser and Windows/macOS native acceptance distinct.

Full PDF component virtualization and persistence architecture changes remain outside this bounded checkpoint. macOS availability is assessed separately from platform implementation: source-level portability does not prove native builds, installable artifacts or real Mac runtime acceptance.

## Checkpoint outcome

Code, correctness review and same-environment measurements are complete. See `docs/performance/checkpoint-2026-11-07.md` for cold/warm timing, lifecycle memory regressions, reproducible artifacts and platform limits. Publication and exact-source CI status are recorded in the PR.

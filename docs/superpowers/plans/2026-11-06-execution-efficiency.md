# Execution Efficiency Implementation Plan

> **Execution:** Implement each stage with a measured baseline, regression tests, independent review, and a separately reversible commit.

**Goal:** Reduce repeated computation and allocation in existing research workflows without changing data, citation, durability, or authorization semantics.

**Architecture:** Build deterministic synthetic benchmarks around the existing algorithms, then optimize independent search and import paths. Reuse bounded document-scoped text work, examine long-document rendering, and only change persistence after evidence justifies the additional migration and crash-safety risk.

**Tech Stack:** TypeScript, React 19, PDF.js 6, Vitest 5, Vite 8, Node.js 22.13+/24.

**Spec:** The user approved continuing the prior inspect → fix → verify → independently review cycle for the proposed performance sequence. Baseline is PR #3 HEAD `2536305d86d520955358d1bcae6aea8fe78bb62b`. No merge, main changes, real credentials, paid AI requests, or weakened safety gates.

## Global Constraints

- Work on `perf/execution-efficiency-20261106`, based on the verified clean PR HEAD. Integrate to the authorized PR branch only after verification and a fresh remote comparison.
- Do not add dependencies, change data schemas, skip hash verification, relax stale-result checks, or replace durable restoration with delayed writes.
- Preserve deterministic result ordering, CJK matching and source offsets, identifier-conflict behavior, document replacement/closure behavior, mixed page dimensions and reading anchors.
- Benchmark synthetic data only. Record environment, workload, warm-up, sample count, median/p95 and memory limitations; do not turn noisy timing thresholds into flaky correctness tests.
- Portable tests and Chromium results are not Windows WebView2 or installer acceptance. Report each unavailable stage explicitly.

## Review Focus

- Search snippets, rank ties, exact total counts, invalid limits, Unicode/CJK offsets and source replacement must remain correct.
- DOI/arXiv conflicts, existing duplicate identifiers, within-batch aliases and prototype-looking paper IDs must not silently collapse identities.
- Shared PDF work must not retain unbounded documents, poison retries, leak stale results or let one consumer cancel another consumer's useful work.
- Long-document optimization must preserve mixed-size positioning, off-screen anchors and jumps, zoom reflow, search/highlight targeting and teardown.
- Reading-position changes must not weaken write-failure reporting, multi-window exclusion or crash-recovery behavior.

## Stage 1: Reproducible baseline

- [x] Confirm local HEAD, remote PR HEAD, clean worktree and available environment.
- [x] Run the unchanged aggregate checks; retain full logs outside tracked source.
- [x] Add a repeatable synthetic benchmark harness for workspace search, batched identity resolution and PDF search. Compare the same workloads against the pinned baseline and candidate.
- [x] Report correctness checksums, cold construction and warm queries separately, latency distributions and the limits of heap measurements.

## Stage 2: Workspace search and BibTeX identity indexing

**Files:** `src/features/search/searchWorkspace.ts`, `GlobalSearchDialog.tsx`, related tests; `src/domain/papers.ts`, `src/features/projects/useProjects.ts`, BibTeX preview and related tests.

- [x] Add failing regression/operation-count tests before production changes.
- [x] Precompute immutable-source search fields and display-name lookup data. Bound result materialization while preserving total counts and stable ranking.
- [x] Index normalized DOI/arXiv identifiers for batch lookup and update the index as new papers are created. Preserve all conflict outcomes.
- [x] Run focused tests, benchmark before/after, aggregate checks and independent spec/code review.
- [x] Commit each independent change separately.

## Stage 3: PDF search and shared text extraction

**Files:** `src/features/reader/findText.ts`, `usePdfSearch.ts`, `useDocumentText.ts`, `paperRetrieval.ts`, `useKnowledgeAnalysis.ts`, a focused shared extraction module and tests.

- [x] Add tests for reused folded text/offset maps, one extraction across simultaneous consumers, bounded cache, failed extraction retry and document changes.
- [x] Cache normalized find text once per indexed page and preserve the raw-text mapping.
- [x] Share document-scoped in-flight extraction while keeping AI/search normalization distinct. Retain bounded work, cancellation and stale-result guards.
- [x] Compare extraction count and synthetic search performance, run aggregate checks and independent review, then commit.

## Stage 4: Long PDF rendering

**Files:** `ReaderView.tsx`, `PdfPage.tsx`, reader layout/helpers and tests.

- [ ] Measure mounted-page count and height-map update work with a long synthetic document.
- [ ] Test mixed-size page jumps, zoom/resize anchors, offscreen search/citation jumps and cleanup before changing the render window.
- [ ] Implement only a change that can be validated without weakening the reader's geometry contract. Batch or bound measurement work; preserve reliable unmeasured-page estimates.
- [ ] Run focused and aggregate tests plus available real-browser acceptance. If browser validation is blocked, retain an isolated experimental checkpoint rather than publish an unverified rendering change.

## Stage 5: Persistence assessment and final integration

- [ ] Measure high-frequency reading updates and derived list recomputation. Prefer narrow memo/index changes over storage migrations.
- [ ] Do not change persistence architecture unless equivalent recovery and crash behavior can be demonstrated; document a measured deferral if not.
- [ ] Obtain whole-branch independent review; fix important findings with regression tests.
- [ ] Re-run check/build and benchmark on final content, inspect current remote HEAD, then fast-forward the authorized PR branch without force only if still safe.
- [ ] Update PR #3 with actual commits, measurements and explicit Windows/browser limitations. Preserve its no-merge status.

## Checkpoint outcome

Stages 1–3 are implemented and verified. Stage 4 delivered the separately tested logarithmic scroll lookup only; full DOM windowing remains deferred. Persistence is unchanged. The measurements, tradeoffs, exact completed checks and remaining acceptance are recorded in [the checkpoint report](../../performance/checkpoint-2026-11-06.md).

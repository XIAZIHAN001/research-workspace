# Synthetic execution benchmarks

Run from the repository root with the already-installed dependencies and supported Node
version (no installs, network, PDF files, credentials, or paid AI required):

```sh
node scripts/performance/run.mjs --out /tmp/baseline.json
node scripts/performance/run.mjs --ref <candidate-commit> --out /tmp/candidate.json --compare /tmp/baseline.json
npx vitest run scripts/performance/metrics.test.mjs
```

The default baseline is the immutable commit
`2536305d86d520955358d1bcae6aea8fe78bb62b`. Each run uses `git archive` to extract
that exact revision's production TypeScript, then the installed Vite SSR builder to
compile it together with this harness. Nothing is hand-translated. A fresh Node process
executes the bundle; temporary archives and bundles are removed afterward. Uncommitted
production edits do not affect results. Commit the candidate before measuring it. The
harness itself is taken from the working tree, so use the same harness version for both
runs. Source commits, environment and sample counts are recorded in JSON. Git and tar
must be available, and the output parent directory must already exist.

## Workloads and correctness

- Workspace: 1,000 and 10,000 total records, evenly split among papers, annotations,
  concepts and evidence. No-hit, high-hit and CJK queries exercise total counts, stable
  rank order, metadata and snippets. Default display limit is six per group.
- Identity: registries of 1,000 and 10,000 papers; each batch resolves 500 imports with
  normalized identifiers, conflicts, existing matches and repeated new aliases. The
  registry is copied per batch. Newly created papers are inserted into both the batch
  and the candidate index. A separate 500-lookup sequence measures reuse without
  mutating the registry. New IDs and timestamps are deterministic.
- PDF find: 20, 200 and 1,000 pages, approximately 1,300 characters per page. No-hit
  queries scan all pages; mixed sequences cover English, spaced CJK, expanding Unicode
  lowercase and no-hit. Default hit limit is 300. This measures text matching, not
  PDF.js extraction, browser rendering, IO or document-cache lifecycle.
- Scroll lookup: 512 sequential or deterministically permuted offsets over 1,000,
  10,000 and 65,536 mixed-height pages. This isolates page lookup, not DOM layout,
  virtualization, scroll event dispatch or geometry acceptance.

Full output objects and SHA-256 checksums are recorded, including result order,
metadata, snippets, offsets, totals and conflict paper order. `--compare` requires the
same ordered workload keys and deep-equal results; it fails before writing an output
report if any differ. Every timed operation's final result is also checked against the
revision's compatibility API outside the timed region. These synthetic cases supplement,
not replace, the production regression suite.

## Timing and memory interpretation

Defaults: two warmups and seven measured samples per operation. Override with
`--warmups 3 --samples 15` for longer characterization. JSON contains every sample,
conventional median and nearest-rank p95. At seven samples, p95 is the maximum and is
particularly noisy. There are deliberately no timing assertions in correctness tests.

Workspace cold queries include index construction; warm queries reuse one index across
queries. Identity batch timing includes registry cloning, index construction and inserts;
warm lookups reuse one index. PDF cold sequences create one fresh index for the sequence,
while warm sequences reuse an index across samples. PDF folding is lazy, so constructor
timing alone is not the cost of populating the cache. A bounded cache can make the
1,000-page no-hit case behave differently from short documents; inspect that row rather
than assuming all warm scans are cached. Baseline `scan-repeat` rows have no index.
Construction-only timing is attached to applicable warm records separately and excludes
synthetic input generation. Production module loading, compilation, fixture generation,
correctness comparison, hashing and explicit garbage collection are not timed.

Forced GC runs before/after each measurement group, outside timed samples. The reported
heap delta includes the final result and any retained cache changes, not peak allocation.
Indexes populated before the group can have near-zero warm heap deltas despite retaining
memory. GC behavior, object lifetimes, JIT compilation and other machine activity can
produce negative or noisy deltas. Do not interpret these numbers as a memory bound, leak
test, browser/WebView2 measurement or user-facing latency guarantee. Repeat on a quiet
machine with identical dependencies and sample counts before drawing conclusions.

## Recorded baseline

`baseline-2536305.json` contains the pinned baseline measured in this environment. The
same source and harness should be rerun alongside each candidate rather than relying on
an older baseline's timing. Timing distributions are observations, not acceptance gates.

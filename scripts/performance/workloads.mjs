import * as workspace from '@performance-source/features/search/searchWorkspace.ts';
import * as papers from '@performance-source/domain/papers.ts';
import * as pdf from '@performance-source/features/reader/findText.ts';
import { pageAtOffset } from '@performance-source/features/reader/readerMath.ts';
import { performance } from 'node:perf_hooks';
import { deepStrictEqual } from 'node:assert';
import { checksum, summarize } from './metrics.mjs';

const warmups = Number(process.env.PERF_WARMUPS);
const samples = Number(process.env.PERF_SAMPLES);
const records = [];
function measure(operation) {
  for (let i = 0; i < warmups; i++) operation();
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const times = [];
  let result;
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    result = operation();
    times.push(performance.now() - start);
  }
  globalThis.gc?.();
  return {
    ...summarize(times),
    sampleMs: times,
    retainedHeapDeltaBytes: process.memoryUsage().heapUsed - before,
    result,
  };
}
function record(key, mode, operation, expected, construction) {
  const measured = measure(operation);
  deepStrictEqual(measured.result, expected, key);
  records.push({
    key,
    mode,
    ...measured,
    checksum: checksum(measured.result),
    ...(construction ? { construction } : {}),
  });
}
function paper(i) {
  return {
    id: `paper-${i}`,
    title: `Shared research ${i} ${i % 7 === 0 ? '机器学习' : 'methods'}`,
    authors: ['Synthetic Author'],
    year: 2020 + (i % 6),
    doi: `10.1000/item-${i}`,
    arxivId: `2401.${String(i).padStart(5, '0')}`,
    createdAt: 0,
    updatedAt: 0,
  };
}
function source(size) {
  const data = { papers: [], annotations: [], concepts: [], evidence: [] };
  for (let i = 0; i < size / 4; i++) {
    const title = `Shared research ${i} ${i % 7 === 0 ? '机器学习' : 'methods'}`;
    data.papers.push(paper(i));
    data.annotations.push({
      id: `note-${i}`,
      paperId: `paper-${i}`,
      page: (i % 20) + 1,
      kind: 'note',
      note: `${i % 2 ? 'Context ' : ''}${title}`,
      quote: `${'background '.repeat(12)}${title}`,
    });
    data.concepts.push({
      id: `concept-${i}`,
      name: i % 2 ? `Topic ${i}` : title,
      aliases: [title],
      summary: title,
      status: 'confirmed',
      projectIds: ['synthetic-project'],
    });
    data.evidence.push({
      id: `evidence-${i}`,
      conceptId: `concept-${i}`,
      paperId: `paper-${i}`,
      page: (i % 20) + 1,
      quote: title,
      note: `Synthetic ${title}`,
    });
  }
  return data;
}
for (const size of [1000, 10000]) {
  const data = source(size);
  const create = workspace['createWorkspaceSearchIndex'];
  const query = workspace['searchWorkspaceIndex'];
  let indexed;
  let construction;
  if (create && query) {
    const built = measure(() => create(data));
    indexed = built.result;
    const { result: discarded, ...stats } = built;
    void discarded;
    construction = stats;
  }
  for (const [label, text] of [
    ['no-hit', 'absent-needle-xyz'],
    ['high-hit', 'shared research'],
    ['cjk', '机器学习'],
  ]) {
    const expected = workspace.searchWorkspace(data, text);
    record(
      `workspace/${size}/${label}/cold`,
      'cold-query',
      () => (create && query ? query(create(data), text) : workspace.searchWorkspace(data, text)),
      expected,
    );
    record(
      `workspace/${size}/${label}/warm`,
      indexed ? 'indexed-warm' : 'scan-repeat',
      () => (indexed ? query(indexed, text) : workspace.searchWorkspace(data, text)),
      expected,
      construction,
    );
  }
}
for (const size of [1000, 10000]) {
  const registry = Object.fromEntries(
    Array.from({ length: size }, (_, i) => {
      const p = paper(i);
      return [p.id, p];
    }),
  );
  // Repeated new aliases, DOI/arXiv conflicts, normalization, and existing matches.
  const imports = Array.from({ length: 500 }, (_, i) =>
    i % 5 === 0
      ? { doi: `10.1000/new-${Math.floor(i / 10)}` }
      : {
          doi: `https://doi.org/10.1000/ITEM-${i % size}`,
          arxivId: `2401.${String((i + (i % 5 === 1 ? 1 : 0)) % size).padStart(5, '0')}`,
        },
  );
  const create = papers['createPaperIdentityIndex'];
  const run = () => {
    const batch = { ...registry };
    const index = create?.(batch);
    return imports.map((ids, i) => {
      const result = index ? index.resolve(ids) : papers.resolvePaperIdentity(batch, ids);
      if (result.kind === 'none') {
        const created = papers.createPaper(
          { title: `Imported ${i}`, ...ids },
          () => `import-${i}`,
          0,
        );
        batch[created.id] = created;
        index?.add(created);
      }
      return result;
    });
  };
  const expected = run();
  record(`identity/${size}/500-imports`, create ? 'indexed-batch' : 'batch-scan', run, expected);
  const built = create ? measure(() => create(registry)) : null;
  const index = built?.result;
  const construction = built
    ? Object.fromEntries(Object.entries(built).filter(([key]) => key !== 'result'))
    : undefined;
  const lookup = () =>
    imports.map((ids) => (index ? index.resolve(ids) : papers.resolvePaperIdentity(registry, ids)));
  record(
    `identity/${size}/500-lookups`,
    index ? 'indexed-warm' : 'scan-repeat',
    lookup,
    imports.map((ids) => papers.resolvePaperIdentity(registry, ids)),
    construction,
  );
}
for (const count of [20, 200, 1000]) {
  const pages = Array.from(
    { length: count },
    (_, i) =>
      `${'Synthetic text without target words. '.repeat(35)}${i % 7 === 0 ? ' Neural NETWORK and 机 器 学 习. İ Unicode.' : ''}`,
  );
  for (const [label, queries] of [
    ['no-hit', ['absent-needle-xyz']],
    ['mixed', ['neural network', '机器学习', 'i̇', 'absent-needle-xyz']],
  ]) {
    const create = pdf['createFindIndex'];
    const queryIndex = pdf['findIndexedMatches'];
    const expected = queries.map((query) => pdf.findMatches(pages, query));
    const cold = () => {
      const index = create?.(pages);
      return queries.map((query) =>
        index ? queryIndex(index, query) : pdf.findMatches(pages, query),
      );
    };
    const built = create ? measure(() => create(pages)) : null;
    const index = built?.result;
    const construction = built
      ? Object.fromEntries(Object.entries(built).filter(([key]) => key !== 'result'))
      : undefined;
    const warm = () =>
      queries.map((query) => (index ? queryIndex(index, query) : pdf.findMatches(pages, query)));
    record(`pdf/${count}/${label}/cold`, 'cold-query', cold, expected);
    record(
      `pdf/${count}/${label}/warm`,
      index ? 'indexed-warm' : 'scan-repeat',
      warm,
      expected,
      construction,
    );
  }
}
for (const count of [1000, 10000, 65536]) {
  // Mixed page heights; deterministic offsets cover early/late pages and boundaries.
  const tops = [];
  let top = 16;
  for (let i = 0; i < count; i++) {
    tops.push(top);
    top += 800 + (i % 5) * 100 + 16;
  }
  for (const pattern of ['sequential', 'permuted']) {
    const offsets = Array.from({ length: 512 }, (_, i) => {
      const fraction = (pattern === 'sequential' ? i : (i * 137) % 512) / 511;
      return fraction * top - (i % 3) * 0.25;
    });
    const run = () => offsets.map((offset) => pageAtOffset(tops, offset));
    record(`scroll/${count}/${pattern}`, '512-lookups', run, run());
  }
}
console.log(JSON.stringify(records));

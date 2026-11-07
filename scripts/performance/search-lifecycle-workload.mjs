import {
  createWorkspaceSearchIndex,
  searchWorkspaceIndex,
} from '@lifecycle-source/features/search/searchWorkspace.ts';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';

const size = Number(process.env.LIFECYCLE_SIZE ?? 10000);
const cycles = Number(process.env.LIFECYCLE_CYCLES ?? 3);
if (!Number.isInteger(size) || size < 4 || size % 4 !== 0)
  throw new Error('Size must be a positive multiple of four');
if (!Number.isInteger(cycles) || cycles < 1) throw new Error('Invalid cycle count');
if (typeof globalThis.gc !== 'function') throw new Error('Run with --expose-gc');
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// Same generated records as scripts/performance/workloads.mjs; this is a fixture, not a
// reimplementation of the search algorithm. The production functions are bundled from git.
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

function materializeAll(index, size) {
  const results = searchWorkspaceIndex(index, 'shared research', Infinity);
  deepStrictEqual(
    results.map((group) => [group.kind, group.total, group.results.length]),
    [
      ['paper', size / 4, size / 4],
      ['note', size / 4, size / 4],
      ['concept', size / 4, size / 4],
      ['evidence', size / 4, size / 4],
    ],
  );
  // Only a fixed-length checksum escapes this scope. The returned result arrays and JSON
  // string are gone before the following event-loop boundary and retained-heap reading.
  return createHash('sha256').update(JSON.stringify(results)).digest('hex');
}

async function retainedHeap() {
  await nextTurn();
  for (let i = 0; i < 3; i++) globalThis.gc();
  return process.memoryUsage().heapUsed;
}

// Warm module code, formatting and hashing before retaining the measured source. Warmup
// records and indexes are scoped away; this reduces one-time code-cache residuals.
for (let i = 0; i < 3; i++) {
  materializeAll(createWorkspaceSearchIndex(source(1000)), 1000);
}
await retainedHeap();
globalThis.__lifecycleSource = source(size);
const initialSourceOnlyBytes = await retainedHeap();
const records = [];
for (let cycle = 0; cycle < cycles; cycle++) {
  const sourceOnlyBytes = await retainedHeap();
  globalThis.__lifecycleIndex = createWorkspaceSearchIndex(globalThis.__lifecycleSource);
  const builtBytes = await retainedHeap();
  const resultChecksum = materializeAll(globalThis.__lifecycleIndex, size);
  const fullyMaterializedBytes = await retainedHeap();
  const indexReference = new WeakRef(globalThis.__lifecycleIndex);
  delete globalThis.__lifecycleIndex;
  const releasedBytes = await retainedHeap();
  const indexCollected = indexReference.deref() === undefined;
  strictEqual(globalThis.__lifecycleSource.papers.length, size / 4);
  strictEqual(
    indexCollected,
    true,
    'Index collection was not observed during this sample; this alone does not prove a strong reference or leak.',
  );
  records.push({
    cycle: cycle + 1,
    sourceOnlyBytes,
    builtBytes,
    fullyMaterializedBytes,
    releasedBytes,
    builtDeltaBytes: builtBytes - sourceOnlyBytes,
    fullyMaterializedDeltaBytes: fullyMaterializedBytes - sourceOnlyBytes,
    materializationGrowthBytes: fullyMaterializedBytes - builtBytes,
    releasedDeltaBytes: releasedBytes - sourceOnlyBytes,
    releasedVersusInitialBytes: releasedBytes - initialSourceOnlyBytes,
    indexCollected,
    resultChecksum,
  });
}
console.log(JSON.stringify({ size, initialSourceOnlyBytes, records }));

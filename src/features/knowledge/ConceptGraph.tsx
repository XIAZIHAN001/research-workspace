import { Minus, Plus, Scan } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Concept, ConceptRelation } from '../../domain/knowledge';

interface ConceptGraphProps {
  concepts: readonly Concept[];
  relations: readonly ConceptRelation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const COLUMN = 220;
const ROW = 64;
const PADDING = 32;
const NODE_WIDTH = 168;
const NODE_HEIGHT = 36;
const LABEL = 14;

/**
 * The dependency graph, drawn as layers.
 *
 * The layout is not decorative: a concept sits one column to the right of the deepest
 * prerequisite it has inside this project, so reading left to right is reading the dependency
 * order. Nothing is positioned to look impressive, and an edge is drawn only where a relation
 * record exists — no line is inferred from co-occurrence.
 *
 * Only confirmed prerequisite edges decide the columns. A suggestion is drawn, faded, where it
 * would be, without moving anything: an unconfirmed claim must not reshape what the reader
 * already knows.
 */
export function ConceptGraph({ concepts, relations, selectedId, onSelect }: ConceptGraphProps) {
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Arriving back from the paper should land on the concept you left from, not at the top.
  useEffect(() => {
    if (selectedId === null) return;
    const node = scrollRef.current?.querySelector(`[data-concept-id="${selectedId}"]`);
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);

  const ids = new Set(concepts.map((concept) => concept.id));
  const edges = relations.filter((relation) => ids.has(relation.from) && ids.has(relation.to));

  const confirmedPrerequisites = edges.filter(
    (relation) => relation.kind === 'prerequisite' && relation.status === 'confirmed',
  );

  // Longest path from a root, iterated to a fixed point. The graph is small (a project's
  // concepts), and cycles are refused when a relation is created, so this terminates.
  const depth = new Map<string, number>(concepts.map((concept) => [concept.id, 0]));
  for (let pass = 0; pass < concepts.length; pass += 1) {
    let changed = false;
    for (const relation of confirmedPrerequisites) {
      const next = (depth.get(relation.to) ?? 0) + 1;
      if (next > (depth.get(relation.from) ?? 0)) {
        depth.set(relation.from, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = new Map<number, Concept[]>();
  for (const concept of concepts) {
    const level = depth.get(concept.id) ?? 0;
    const list = columns.get(level) ?? [];
    list.push(concept);
    columns.set(level, list);
  }
  for (const list of columns.values()) {
    list.sort((one, other) => one.name.localeCompare(other.name, 'zh-Hans-CN'));
  }

  const levels = [...columns.keys()].sort((one, other) => one - other);
  const width = PADDING * 2 + Math.max(1, levels.length) * COLUMN;
  const rows = Math.max(1, ...levels.map((level) => columns.get(level)?.length ?? 0));
  const height = PADDING * 2 + rows * ROW;

  const position = new Map<string, { x: number; y: number }>();
  for (const [column, level] of levels.entries()) {
    const list = columns.get(level) ?? [];
    list.forEach((concept, index) => {
      position.set(concept.id, {
        x: PADDING + column * COLUMN,
        y: PADDING + index * ROW + (rows * ROW) / 2 - (list.length * ROW) / 2 + ROW / 2,
      });
    });
  }

  if (concepts.length === 0) {
    return <p className="knowledge-empty">还没有概念。先从阅读记录整理，或手动新建一个。</p>;
  }

  return (
    <div className="concept-graph" role="group" aria-label="概念关系图">
      <div className="concept-graph-tools" role="group" aria-label="图谱导航">
        <button
          type="button"
          className="icon-btn"
          aria-label="放大图谱"
          title="放大"
          disabled={zoom >= 1.8}
          onClick={() => {
            setZoom((value) => Math.min(1.8, Math.round((value + 0.2) * 10) / 10));
          }}
        >
          <Plus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="缩小图谱"
          title="缩小"
          disabled={zoom <= 0.6}
          onClick={() => {
            setZoom((value) => Math.max(0.6, Math.round((value - 0.2) * 10) / 10));
          }}
        >
          <Minus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="适应视图"
          title="回到 100%"
          onClick={() => {
            setZoom(1);
          }}
        >
          <Scan size={15} aria-hidden="true" />
        </button>
        <span className="concept-graph-legend" aria-hidden="true">
          <span data-kind="prerequisite" /> 确认的前置
          <span data-kind="suggested" /> 建议
        </span>
      </div>
      <div className="concept-graph-scroll" ref={scrollRef}>
        <svg
          width={width * zoom}
          height={height * zoom}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          role="img"
          aria-label={`${String(concepts.length)} 个概念，${String(edges.length)} 条关系`}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>

          {edges.map((relation) => {
            const from = position.get(relation.from);
            const to = position.get(relation.to);
            if (from === undefined || to === undefined) return null;
            // Relations run right-to-left on purpose: "A needs B" points from A to B, and B is
            // the earlier column.
            const x1 = from.x;
            const x2 = to.x + NODE_WIDTH;
            const y1 = from.y;
            const y2 = to.y;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={relation.id}
                className="concept-edge"
                data-kind={relation.kind}
                data-status={relation.status}
                d={`M ${String(x1)} ${String(y1)} C ${String(mid)} ${String(y1)}, ${String(mid)} ${String(y2)}, ${String(x2)} ${String(y2)}`}
                markerEnd={relation.kind === 'prerequisite' ? 'url(#arrow)' : undefined}
              />
            );
          })}

          {concepts.map((concept) => {
            const spot = position.get(concept.id);
            if (spot === undefined) return null;
            const label =
              concept.name.length > LABEL ? `${concept.name.slice(0, LABEL - 1)}…` : concept.name;
            return (
              <g
                key={concept.id}
                className="concept-node"
                data-concept-id={concept.id}
                data-selected={concept.id === selectedId}
                data-status={concept.status}
                transform={`translate(${String(spot.x)}, ${String(spot.y - NODE_HEIGHT / 2)})`}
                onClick={() => {
                  onSelect(concept.id);
                }}
                role="button"
                tabIndex={0}
                aria-label={concept.name}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(concept.id);
                  }
                }}
              >
                <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={8} />
                <text x={NODE_WIDTH / 2} y={NODE_HEIGHT / 2 + 5} textAnchor="middle">
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

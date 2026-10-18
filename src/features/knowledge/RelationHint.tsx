import { TriangleAlert } from 'lucide-react';
import {
  RELATION_KIND_LABEL,
  relationSemanticHint,
  type ConceptRelation,
  type RelationKind,
} from '../../domain/knowledge';
import type { KnowledgeApi } from './useKnowledgeApi';

interface RelationHintProps {
  relation: ConceptRelation;
  api: KnowledgeApi;
  onNotice: (text: string | null) => void;
}

/**
 * An advisory check on a relation's explanation, never an automatic reclassification.
 *
 * The reader decides whether the hint is right. Applying it is one explicit click and goes
 * through the same checked `updateRelationKind` path as any other manual change; if the new
 * kind would duplicate or loop, the change is refused with the reason.
 */
export function RelationHint({ relation, api, onNotice }: RelationHintProps) {
  const hint = relationSemanticHint(relation);
  if (hint === null) return null;

  const suggested: RelationKind | null = hint.suggestedKind;
  return (
    <div className="relation-hint">
      <TriangleAlert size={13} aria-hidden="true" />
      <p>{hint.message}</p>
      {suggested !== null && suggested !== relation.kind && (
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            const result = api.updateRelationKind(relation.id, suggested);
            onNotice(
              result.ok
                ? `关系类型已改为「${RELATION_KIND_LABEL[suggested]}」。`
                : (result.reason ?? '无法修改关系类型。'),
            );
          }}
        >
          改为「{RELATION_KIND_LABEL[suggested]}」
        </button>
      )}
    </div>
  );
}

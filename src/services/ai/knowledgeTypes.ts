/**
 * The shapes the browser and the local service exchange for knowledge analysis.
 *
 * The model's reply is deliberately narrower than a knowledge graph: names, quotations, a
 * support classification and an explanation. It has no ids, no page numbers and no confirmation
 * state, because those are the things the application owns. The browser maps names onto stable
 * concept ids and stores everything it receives as a *suggestion*.
 */

import type { RelationKind, RelationSupport } from '../../domain/knowledge';
import type { AiUsage } from './types';

export type KnowledgePassageRole =
  'selection' | 'context' | 'definition' | 'term' | 'neighbor' | 'annotation' | 'difficulty';

export interface KnowledgePassage {
  id: string;
  page: number;
  text: string;
  selection: boolean;
  role: KnowledgePassageRole;
  label: string;
}

export interface KnowledgeExistingConcept {
  name: string;
  aliases: string[];
  summary: string;
}

export interface KnowledgeExistingRelation {
  from: string;
  to: string;
  kind: RelationKind;
  status: 'confirmed';
}

export interface KnowledgeRequest {
  paper: {
    id: string;
    title: string;
    page: number;
    pdfSha256: string;
  };
  focus: string;
  scope: 'selection' | 'page';
  passages: KnowledgePassage[];
  existingConcepts: KnowledgeExistingConcept[];
  existingRelations: KnowledgeExistingRelation[];
}

export interface KnowledgeEvidence {
  passageId: string;
  page: number;
  quote: string;
}

export type KnowledgeEvidenceStatus = 'verified' | 'none';

export interface KnowledgeConceptSuggestion {
  name: string;
  aliases: string[];
  summary: string;
  support: RelationSupport;
  evidence: KnowledgeEvidence[];
  evidenceStatus: KnowledgeEvidenceStatus;
  /**
   * True when the reader already has this concept. It is not proposed again; the entry exists
   * so that new evidence from this paper can be attached to the existing stable id.
   */
  existing?: boolean;
}

export interface KnowledgeRelationSuggestion {
  from: string;
  to: string;
  kind: RelationKind;
  direction: 'from-first' | 'undirected';
  support: RelationSupport;
  explanation: string;
  evidence: KnowledgeEvidence[];
  evidenceStatus: KnowledgeEvidenceStatus;
}

export interface KnowledgeRejection {
  code: string;
  label: string;
  message: string;
}

export interface KnowledgeDiagnostics {
  rawChars: number;
  contextChars: number;
  smallContext: boolean;
  smallContextLimited: number;
  conceptsKept: number;
  relationsKept: number;
  evidenceKept: number;
  rejected: number;
  matchedExisting: number;
  nameNotVerbatim: number;
  ambiguousExistingNames: number;
  ambiguousConceptsSkipped: number;
  ambiguousRelationsSkipped: number;
  directionDefaulted: number;
  supportDefaulted: number;
  ignoredIdentityFields: number;
  ignoredProvenanceFields: number;
  pageMismatches: number;
  truncated: boolean;
  finishReason: string | null;
}

export type KnowledgeOutputStatus = 'valid' | 'recovered' | 'malformed' | 'incomplete';

export interface KnowledgeAnalysis {
  provider: string;
  providerLabel: string;
  model: string;
  online: boolean;
  rulesVersion: string;
  status: KnowledgeOutputStatus;
  /** The model's own claim about whether the passages sufficed. Null when it said nothing. */
  groundedInText: boolean | null;
  concepts: KnowledgeConceptSuggestion[];
  relations: KnowledgeRelationSuggestion[];
  rejected: number;
  rejectedDetails: KnowledgeRejection[];
  warnings: string[];
  diagnostics: KnowledgeDiagnostics | null;
  usage: AiUsage | null;
}

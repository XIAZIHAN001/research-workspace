import {
  ArrowRight,
  Check,
  CircleDot,
  Loader2,
  Network,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { AiHealth } from '../../services/ai/types';
import type {
  KnowledgeAnalysis,
  KnowledgeConceptSuggestion,
  KnowledgeEvidence,
  KnowledgeRelationSuggestion,
} from '../../services/ai/knowledgeTypes';
import type { Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
import {
  RELATION_KIND_LABEL,
  RELATION_SUPPORT_LABEL,
  conceptIdForName,
  evidenceForRelation,
  isStaleEvidence,
  learningPath,
  relationDirectionText,
  type Concept,
  type ConceptEvidence,
  type ConceptRelation,
  type RelationKind,
  type RelationSupport,
} from '../../domain/knowledge';
import type { KnowledgeApi } from '../knowledge/useKnowledgeApi';
import type { LocalConceptMatch } from '../knowledge/localKnowledge';
import { RelationHint } from '../knowledge/RelationHint';
import type { KnowledgeAnalysisState } from './useKnowledgeAnalysis';
import { describePlan } from './paperRetrieval';
import type { RetrievalPlan } from './paperRetrieval';

interface KnowledgePanelProps {
  paper: Paper;
  projectId: string | null;
  projects: readonly Project[];
  knowledge: KnowledgeApi;
  analysis: KnowledgeAnalysisState;
  health: AiHealth | null;
  onClose: () => void;
  onJumpToQuote: (page: number, quote: string) => void;
  onOpenConceptInProject: (conceptId: string, projectId: string) => void;
  onNotice: (text: string | null) => void;
}

const SUPPORT_CLASS: Record<RelationSupport, string> = {
  direct: 'kb-support-direct',
  inferred: 'kb-support-inferred',
  external: 'kb-support-external',
};

const EVIDENCE_STATUS_LABEL = {
  verified: '有逐字引文',
  none: '待验证：无逐字引文',
} as const;

const MATCH_LABEL = {
  selection: '选中文字里出现',
  page: '这一页出现',
  evidence: '这篇论文里有出处',
} as const;

function relationText(kind: RelationKind, from: string, to: string): string {
  return relationDirectionText(kind, from, to);
}

function EvidenceList({
  entries,
  paper,
  onJump,
  limit = 3,
}: {
  entries: readonly KnowledgeEvidence[] | readonly ConceptEvidence[];
  paper: Paper;
  onJump: (page: number, quote: string) => void;
  limit?: number;
}) {
  if (entries.length === 0) return null;
  return (
    <ul className="knowledge-evidence-list">
      {entries.slice(0, limit).map((entry, index) => {
        const stored = 'pdfSha256' in entry;
        const stale = stored && isStaleEvidence(entry, paper.pdf?.sha256);
        return (
          <li key={`${String(entry.page)}-${String(index)}`}>
            <div className="knowledge-evidence-head">
              <span
                className="kb-kind"
                title={stored ? `文件 ${entry.pdfSha256.slice(0, 12)}…` : '本次发送的原文'}
              >
                第 {entry.page} 页
              </span>
              <span className="knowledge-evidence-paper">{paper.title}</span>
              {'verification' in entry && entry.verification !== undefined && (
                <span className="knowledge-evidence-verification">
                  {entry.verification === 'located'
                    ? '位置已核实'
                    : entry.verification === 'verbatim'
                      ? '引文逐字校验'
                      : '位置未核实'}
                </span>
              )}
              {stale && <span className="knowledge-evidence-stale">来自另一个文件版本</span>}
            </div>
            <p className="knowledge-evidence-quote">“{entry.quote}”</p>
            <button
              type="button"
              className="link-btn"
              disabled={stale}
              title={stale ? '文件已经不同，无法定位到原文' : '回到这句话'}
              onClick={() => {
                onJump(entry.page, entry.quote);
              }}
            >
              回到原文
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SupportBadge({ support }: { support: RelationSupport }) {
  return (
    <span className={`kb-support ${SUPPORT_CLASS[support]}`}>
      {RELATION_SUPPORT_LABEL[support]}
    </span>
  );
}

function PendingRelationRow({
  relation,
  state,
  api,
  paper,
  onJump,
  onNotice,
}: {
  relation: ConceptRelation;
  state: KnowledgeApi['state'];
  api: KnowledgeApi;
  paper: Paper;
  onJump: (page: number, quote: string) => void;
  onNotice: (text: string | null) => void;
}) {
  const nameOf = (id: string): string =>
    state.concepts.find((concept) => concept.id === id)?.name ?? '（已删除）';
  const from = nameOf(relation.from);
  const to = nameOf(relation.to);
  const evidence = evidenceForRelation(state, relation.id);
  return (
    <li className="knowledge-suggestion-row" data-kind={relation.kind}>
      <div className="knowledge-suggestion-head">
        <span className="kb-kind">{RELATION_KIND_LABEL[relation.kind]}</span>
        {relation.support !== undefined && <SupportBadge support={relation.support} />}
        <span className="knowledge-suggestion-direction">
          {relationText(relation.kind, from, to)}
        </span>
      </div>
      {relation.rationale !== undefined && relation.rationale !== '' && (
        <p className="knowledge-suggestion-why">
          <span className="knowledge-label">模型解释</span>
          {relation.rationale}
        </p>
      )}
      <EvidenceList entries={evidence} paper={paper} onJump={onJump} limit={2} />
      <RelationHint relation={relation} api={api} onNotice={onNotice} />
      <div className="knowledge-suggestion-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            const result = api.confirmRelation(relation.id);
            onNotice(result.ok ? `已采纳「${from} → ${to}」。` : (result.reason ?? '无法采纳。'));
          }}
        >
          <Check size={13} aria-hidden="true" />
          采纳
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            api.deleteRelation(relation.id);
            onNotice('已忽略这条关系建议。');
          }}
        >
          忽略
        </button>
        <label className="knowledge-kind-edit">
          <span className="sr-only">改为哪种关系</span>
          <select
            className="kb-select"
            value={relation.kind}
            onChange={(event) => {
              const result = api.updateRelationKind(
                relation.id,
                event.target.value as RelationKind,
              );
              onNotice(result.ok ? '关系类型已修改。' : (result.reason ?? '无法修改。'));
            }}
          >
            {(Object.keys(RELATION_KIND_LABEL) as RelationKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {RELATION_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </li>
  );
}

function ConceptCard({
  match,
  state,
  api,
  projectId,
  paper,
  onJump,
  onOpenConceptInProject,
  onNotice,
}: {
  match: LocalConceptMatch;
  state: KnowledgeApi['state'];
  api: KnowledgeApi;
  projectId: string | null;
  paper: Paper;
  onJump: (page: number, quote: string) => void;
  onOpenConceptInProject: (conceptId: string, projectId: string) => void;
  onNotice: (text: string | null) => void;
}) {
  const concept = match.concept;
  const path = learningPath(state, concept.id);
  return (
    <li className="knowledge-concept" data-concept-id={concept.id}>
      <div className="knowledge-concept-head">
        <span className="knowledge-concept-name">{concept.name}</span>
        <span className="knowledge-match-kind">{MATCH_LABEL[match.matchedBy]}</span>
        {concept.status === 'suggested' && <span className="kb-badge">待确认</span>}
        {concept.origin === 'ai' && <span className="kb-badge kb-badge-ai">AI 提出</span>}
      </div>
      {concept.summary !== '' && <p className="knowledge-concept-summary">{concept.summary}</p>}
      <p className="knowledge-concept-meta">
        出处 {match.evidence.length} · 本页 {match.pageEvidence.length} · 前置{' '}
        {match.prerequisites.length}
      </p>

      {path.length > 1 && (
        <div className="knowledge-path" role="group" aria-label="学习路径">
          <span className="knowledge-label">学习路径</span>
          {path.map((entry, index) => (
            <span key={entry.id} className="knowledge-path-step">
              {index > 0 && <ArrowRight size={11} aria-hidden="true" />}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  if (projectId !== null) onOpenConceptInProject(entry.id, projectId);
                  else onNotice('先在项目里打开这篇论文，才能跳到知识视图。');
                }}
              >
                {entry.name}
              </button>
            </span>
          ))}
          <span className="knowledge-path-note">仅来自你确认过的前置关系</span>
        </div>
      )}

      {match.evidence.length > 0 && (
        <EvidenceList entries={match.evidence} paper={paper} onJump={onJump} />
      )}

      {match.pendingRelations.length > 0 && (
        <div className="knowledge-pending">
          <p className="knowledge-label">待确认的建议</p>
          <ul>
            {match.pendingRelations.map((relation) => (
              <PendingRelationRow
                key={relation.id}
                relation={relation}
                state={state}
                api={api}
                paper={paper}
                onJump={onJump}
                onNotice={onNotice}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="knowledge-concept-actions">
        {concept.status === 'suggested' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              api.confirmConcept(concept.id);
              onNotice(`已确认「${concept.name}」为正式知识。`);
            }}
          >
            确认这个建议概念
          </button>
        )}
        {projectId !== null && !concept.projectIds.includes(projectId) && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              api.linkProject(concept.id, projectId);
              onNotice(`已把「${concept.name}」加入当前项目。`);
            }}
          >
            加入当前项目
          </button>
        )}
        {projectId !== null && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              onOpenConceptInProject(concept.id, projectId);
            }}
          >
            在知识视图中打开
          </button>
        )}
      </div>
    </li>
  );
}

function PlanDetails({
  plan,
  health,
  phase,
  onStart,
  onCancel,
}: {
  plan: RetrievalPlan;
  health: AiHealth | null;
  phase: KnowledgeAnalysisState['phase'];
  onStart: () => void;
  onCancel: () => void;
}) {
  const online = health?.online === true;
  return (
    <section className="knowledge-plan" aria-label="上下文计划">
      <div className="knowledge-plan-head">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>发送前确认</span>
      </div>
      <p className="knowledge-plan-summary">{describePlan(plan)}</p>
      <ul className="knowledge-plan-list">
        {plan.segments.map((segment) => (
          <li key={segment.id} data-role={segment.role}>
            <div className="knowledge-plan-row">
              <span className="kb-kind">第 {segment.page} 页</span>
              <span className="knowledge-plan-label">{segment.label}</span>
              <span className="knowledge-plan-chars">{segment.text.length} 字</span>
              {segment.truncated && <span className="knowledge-plan-truncated">已截断</span>}
              {segment.fragmented && <span className="knowledge-plan-truncated">文字碎片化</span>}
            </div>
            <p className="knowledge-plan-reason">{segment.reason}</p>
          </li>
        ))}
      </ul>
      <p className="knowledge-plan-cost" data-online={online}>
        {health === null
          ? '还没有连上本地 AI 服务（npm run ai:serve）；现在开始不会得到结果。'
          : online
            ? `将把以上 ${String(plan.totalChars)} 字发送到 ${health.label}，会调用在线模型，可能产生费用。`
            : `将把以上 ${String(plan.totalChars)} 字发送到 ${health.label}，不会发起在线调用，也不产生费用。`}
      </p>
      {plan.notices.map((notice) => (
        <p className="knowledge-plan-notice" key={notice}>
          <TriangleAlert size={12} aria-hidden="true" />
          {notice}
        </p>
      ))}
      <div className="knowledge-plan-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onStart}
          disabled={health === null}
        >
          开始分析
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          取消
        </button>
        <span className="knowledge-plan-hint">
          {phase === 'planning' ? '正在提取…' : '只有点击「开始分析」才会调用模型。'}
        </span>
      </div>
    </section>
  );
}

function AnalysisSuggestions({
  analysis,
  report,
  state,
  api,
  projectId,
  paper,
  onJump,
  onNotice,
  onOpenConceptInProject,
}: {
  analysis: KnowledgeAnalysis;
  report: KnowledgeAnalysisState['report'];
  state: KnowledgeApi['state'];
  api: KnowledgeApi;
  projectId: string | null;
  paper: Paper;
  onJump: (page: number, quote: string) => void;
  onNotice: (text: string | null) => void;
  onOpenConceptInProject: (conceptId: string, projectId: string) => void;
}) {
  const conceptFor = (name: string): Concept | null => {
    const id = conceptIdForName(state, name);
    return id === null ? null : (state.concepts.find((concept) => concept.id === id) ?? null);
  };
  const relationFor = (suggestion: KnowledgeRelationSuggestion): ConceptRelation | null => {
    const from = conceptIdForName(state, suggestion.from);
    const to = conceptIdForName(state, suggestion.to);
    // The explanation is the one field that survives every other remapping: the reader may
    // change the kind, and a reused concept keeps its reader-chosen name (a Chinese analysis can
    // refer to an English concept the reader already has). Matching on it first keeps the row
    // visible even when the model's endpoint wording no longer resolves to the stored name.
    const sameExplanation = state.relations.find(
      (relation) =>
        relation.origin === 'ai' && (relation.rationale ?? '') === suggestion.explanation,
    );
    if (sameExplanation !== undefined) return sameExplanation;
    if (from === null || to === null) return null;
    // Match by direction, not by the analysis's original kind: the reader may have changed the
    // kind while the suggestion was pending, and the row must stay visible so it can be adopted
    // or dismissed. Exact direction wins; a `related` edge may be stored in either direction.
    const exact = state.relations.filter(
      (relation) => relation.origin === 'ai' && relation.from === from && relation.to === to,
    );
    const reversed =
      suggestion.kind === 'related'
        ? state.relations.filter(
            (relation) => relation.origin === 'ai' && relation.from === to && relation.to === from,
          )
        : [];
    const candidates = [...exact, ...reversed];
    return (
      candidates.find(
        (relation) =>
          relation.kind === suggestion.kind && relation.from === from && relation.to === to,
      ) ?? null
    );
  };
  const storedName = (id: string): string =>
    state.concepts.find((concept) => concept.id === id)?.name ?? id;

  const newConcepts = analysis.concepts
    .map((suggestion) => ({ suggestion, stored: conceptFor(suggestion.name) }))
    .filter(
      (entry): entry is { suggestion: KnowledgeConceptSuggestion; stored: Concept } =>
        entry.stored !== null && entry.suggestion.existing !== true,
    );
  const existingEvidence = analysis.concepts.filter(
    (suggestion) => suggestion.existing === true && suggestion.evidence.length > 0,
  );
  const relations = analysis.relations
    .map((suggestion) => ({ suggestion, stored: relationFor(suggestion) }))
    .filter(
      (entry): entry is { suggestion: KnowledgeRelationSuggestion; stored: ConceptRelation } =>
        entry.stored !== null,
    );
  const projectConceptIds = new Set(
    state.concepts
      .filter((concept) => projectId === null || concept.projectIds.includes(projectId))
      .map((concept) => concept.id),
  );
  const rejectedHere = state.rejections
    .filter(
      (rejection) => projectConceptIds.has(rejection.from) && projectConceptIds.has(rejection.to),
    )
    .sort((one, other) => other.createdAt - one.createdAt);

  return (
    <section className="knowledge-results" aria-label="AI 知识建议">
      <div className="knowledge-results-head">
        <Network size={15} aria-hidden="true" />
        <span>
          模型提出 {analysis.concepts.length} 个概念、{analysis.relations.length} 条关系；
          已作为建议加入 {report?.addedConcepts ?? 0} 个概念、{report?.addedRelations ?? 0} 条关系。
        </span>
      </div>
      {analysis.provider === 'mock' && (
        <p className="knowledge-mock-warning" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          这次结果来自本地模拟（mock
          provider），只用于验证数据流，不是真实模型的学术判断，也不能当作论文结论。
        </p>
      )}
      {analysis.status === 'incomplete' && (
        <p className="knowledge-warn" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          模型的返回被截断了，下面只是它已经写出的部分。
        </p>
      )}
      {analysis.groundedInText === false && (
        <p className="knowledge-warn" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          模型自己认为提供的原文不足以支撑完整分析；这是它的自述，不是被核对过的事实。
        </p>
      )}
      {analysis.warnings.map((warning) => (
        <p className="knowledge-warn" key={warning}>
          <TriangleAlert size={13} aria-hidden="true" />
          {warning}
        </p>
      ))}
      <p className="knowledge-caveat">
        逐字引文只证明这些文字确实来自本次发送的原文，不证明关系在学术上成立；是否采纳由你决定。
        模型补写的公式是模型解释，不是 PDF 原文。
      </p>
      <p className="knowledge-source">
        来源：{analysis.providerLabel} · {analysis.model === '' ? '未知模型' : analysis.model} ·
        规则 {analysis.rulesVersion === '' ? '未标注' : analysis.rulesVersion}
      </p>

      {report !== null && report.skipped.length > 0 && (
        <details className="knowledge-skipped">
          <summary>
            有 {report.skipped.length} 条内容没有加入知识库（重复、循环或引用不成立）
          </summary>
          <ul>
            {report.skipped.map((entry, index) => (
              <li key={`${entry.kind}-${String(index)}`}>
                <span className="kb-kind">{entry.kind}</span>
                {entry.label}：{entry.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="knowledge-suggestion-block">
        <h4>概念建议</h4>
        {newConcepts.length === 0 ? (
          <p className="concept-hint">这次没有新的概念建议。</p>
        ) : (
          <ul className="knowledge-suggestion-list">
            {newConcepts.map(({ suggestion, stored }) => {
              const confirmedRelations = state.relations.filter(
                (relation) =>
                  relation.status === 'confirmed' &&
                  (relation.from === stored.id || relation.to === stored.id),
              );
              return (
                <li
                  key={stored.id}
                  className="knowledge-suggestion-row"
                  data-status={stored.status}
                >
                  <div className="knowledge-suggestion-head">
                    <span className="knowledge-concept-name">{stored.name}</span>
                    <SupportBadge support={suggestion.support} />
                    <span className="kb-badge">
                      {EVIDENCE_STATUS_LABEL[suggestion.evidenceStatus]}
                    </span>
                    {stored.status === 'confirmed' && <span className="kb-badge">已确认</span>}
                  </div>
                  {stored.summary !== '' && (
                    <p className="knowledge-concept-summary">{stored.summary}</p>
                  )}
                  <EvidenceList entries={suggestion.evidence} paper={paper} onJump={onJump} />
                  {confirmedRelations.length > 0 && stored.status === 'suggested' && (
                    <p className="concept-hint">
                      这个概念已经用于确认过的关系；要忽略它，请先处理那些关系，否则它们会一起被删除。
                    </p>
                  )}
                  <div className="knowledge-suggestion-actions">
                    {stored.status === 'suggested' && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          api.confirmConcept(stored.id);
                          onNotice(`已确认「${stored.name}」为正式知识。`);
                        }}
                      >
                        <Check size={13} aria-hidden="true" />
                        确认概念
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={confirmedRelations.length > 0}
                      title={
                        confirmedRelations.length > 0
                          ? '这个概念已经在确认过的关系里使用；忽略它会连带删除那些关系。'
                          : undefined
                      }
                      onClick={() => {
                        api.deleteConcept(stored.id);
                        onNotice('已忽略这个概念建议及其关联建议。');
                      }}
                    >
                      忽略
                    </button>
                    {projectId !== null && !stored.projectIds.includes(projectId) && (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => {
                          api.linkProject(stored.id, projectId);
                          onNotice(`已把「${stored.name}」加入当前项目。`);
                        }}
                      >
                        加入当前项目
                      </button>
                    )}
                    {projectId !== null && (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => {
                          onOpenConceptInProject(stored.id, projectId);
                        }}
                      >
                        在知识视图中打开
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {existingEvidence.length > 0 && (
        <div className="knowledge-suggestion-block">
          <h4>已有概念的新出处</h4>
          <ul className="knowledge-suggestion-list">
            {existingEvidence.map((suggestion) => {
              const stored = conceptFor(suggestion.name);
              return (
                <li
                  key={suggestion.name}
                  className="knowledge-suggestion-row"
                  data-status={stored?.status ?? 'missing'}
                >
                  <div className="knowledge-suggestion-head">
                    <span className="knowledge-concept-name">{suggestion.name}</span>
                    <SupportBadge support={suggestion.support} />
                    <span className="kb-badge">
                      {EVIDENCE_STATUS_LABEL[suggestion.evidenceStatus]}
                    </span>
                  </div>
                  <p className="concept-hint">
                    这个概念已经存在；下面这次分析找到的原文出处会加入它的出处列表，不会覆盖你已有的内容。
                  </p>
                  <EvidenceList entries={suggestion.evidence} paper={paper} onJump={onJump} />
                  {projectId !== null && stored !== null && (
                    <div className="knowledge-suggestion-actions">
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => {
                          onOpenConceptInProject(stored.id, projectId);
                        }}
                      >
                        在知识视图中打开
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="knowledge-suggestion-block">
        <h4>关系建议</h4>
        {relations.length === 0 ? (
          <p className="concept-hint">这次没有新的关系建议。</p>
        ) : (
          <ul className="knowledge-suggestion-list">
            {relations.map(({ suggestion, stored }) => (
              <li
                key={stored.id}
                className="knowledge-suggestion-row"
                data-kind={stored.kind}
                data-status={stored.status}
              >
                <div className="knowledge-suggestion-head">
                  <span className="kb-kind">{RELATION_KIND_LABEL[stored.kind]}</span>
                  <SupportBadge support={suggestion.support} />
                  <span className="kb-badge">
                    {EVIDENCE_STATUS_LABEL[suggestion.evidenceStatus]}
                  </span>
                  {stored.status === 'confirmed' && <span className="kb-badge">已采纳</span>}
                </div>
                <p className="knowledge-suggestion-direction">
                  {relationText(stored.kind, storedName(stored.from), storedName(stored.to))}
                </p>
                <p className="knowledge-suggestion-why">
                  <span className="knowledge-label">模型解释</span>
                  {suggestion.explanation}
                </p>
                <EvidenceList entries={suggestion.evidence} paper={paper} onJump={onJump} />
                <RelationHint relation={stored} api={api} onNotice={onNotice} />
                <div className="knowledge-suggestion-actions">
                  {stored.status === 'suggested' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        const result = api.confirmRelation(stored.id);
                        onNotice(result.ok ? '已采纳这条关系。' : (result.reason ?? '无法采纳。'));
                      }}
                    >
                      <Check size={13} aria-hidden="true" />
                      采纳
                    </button>
                  )}
                  {stored.status === 'suggested' && (
                    <>
                      <button
                        type="button"
                        className="btn btn-quiet"
                        title="记录为明确拒绝；同一条主张不会在下次分析时自动恢复"
                        onClick={() => {
                          const result = api.rejectRelation(stored.id);
                          onNotice(
                            result.ok
                              ? '已拒绝这条关系建议；撤销前，同一主张不会自动恢复。'
                              : (result.reason ?? '无法拒绝这条关系建议。'),
                          );
                        }}
                      >
                        拒绝该关系
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet"
                        title="只移除本次建议；下次分析可能再次出现"
                        onClick={() => {
                          api.deleteRelation(stored.id);
                          onNotice('已暂时忽略这条关系建议；下次分析可能再次出现。');
                        }}
                      >
                        暂时忽略
                      </button>
                    </>
                  )}
                  <label className="knowledge-kind-edit">
                    <span className="sr-only">改为哪种关系</span>
                    <select
                      className="kb-select"
                      value={stored.kind}
                      onChange={(event) => {
                        const result = api.updateRelationKind(
                          stored.id,
                          event.target.value as RelationKind,
                        );
                        onNotice(result.ok ? '关系类型已修改。' : (result.reason ?? '无法修改。'));
                      }}
                    >
                      {(Object.keys(RELATION_KIND_LABEL) as RelationKind[]).map((kind) => (
                        <option key={kind} value={kind}>
                          {RELATION_KIND_LABEL[kind]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {rejectedHere.length > 0 && (
        <div className="knowledge-suggestion-block">
          <h4>已拒绝的关系建议</h4>
          <p className="concept-hint">
            拒绝会记住这两个概念、关系类型、解释和引文；重新分析不会自动恢复同一主张。不同解释、不同证据或不同类型会被当作新建议。
          </p>
          <ul className="knowledge-suggestion-list">
            {rejectedHere.map((rejection) => (
              <li key={rejection.id} className="knowledge-suggestion-row" data-status="rejected">
                <div className="knowledge-suggestion-head">
                  <span className="kb-kind">{RELATION_KIND_LABEL[rejection.kind]}</span>
                  <span className="kb-badge">已拒绝</span>
                </div>
                <p className="knowledge-suggestion-direction">
                  {relationText(
                    rejection.kind,
                    storedName(rejection.from),
                    storedName(rejection.to),
                  )}
                </p>
                {rejection.rationale !== '' && (
                  <p className="knowledge-suggestion-why">
                    <span className="knowledge-label">当时的解释</span>
                    {rejection.rationale}
                  </p>
                )}
                <p className="concept-hint">拒绝时带有 {rejection.evidence.length} 条引文。</p>
                <div className="knowledge-suggestion-actions">
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      api.undoRejection(rejection.id);
                      onNotice('已撤销拒绝；下一次分析可能再次提出这条关系。');
                    }}
                  >
                    撤销拒绝
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.rejectedDetails.length > 0 && (
        <details className="knowledge-rejected">
          <summary>模型输出中被服务端拒绝的 {analysis.rejected} 条内容</summary>
          <ul>
            {analysis.rejectedDetails.map((entry, index) => (
              <li key={`${entry.code}-${String(index)}`}>
                <span className="kb-kind">{entry.code}</span>
                {entry.label}：{entry.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * The reader's knowledge entry: quiet by default, explicit before any model call.
 *
 * The panel opens on local knowledge alone. The context plan is built locally and shown in
 * full; only the second explicit click ("开始分析") sends anything. Every returned item stays a
 * suggestion until the reader accepts it, and the source of the classification is on the badge.
 */
export function KnowledgePanel({
  paper,
  projectId,
  projects,
  knowledge,
  analysis,
  health,
  onClose,
  onJumpToQuote,
  onOpenConceptInProject,
  onNotice,
}: KnowledgePanelProps) {
  const { context, local, phase, plan, analysis: result, report, error } = analysis;
  const state = knowledge.state;
  const project =
    projectId === null ? null : (projects.find((entry) => entry.id === projectId) ?? null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  // The local half comes first by design; once the model has answered, take the reader to the
  // result rather than leaving them at the top of a long panel wondering what changed.
  useEffect(() => {
    if (phase === 'done') {
      resultsRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [phase]);

  if (context === null) {
    return (
      <aside className="knowledge-panel" aria-label="相关知识">
        <div className="knowledge-panel-head">
          <h2>
            <Network size={15} aria-hidden="true" />
            相关知识
          </h2>
          <button type="button" className="icon-btn" aria-label="关闭相关知识" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <p className="concept-hint">先在原文里选中一段文字，再点「查看相关知识」。</p>
      </aside>
    );
  }

  return (
    <aside className="knowledge-panel" aria-label="相关知识">
      <div className="knowledge-panel-head">
        <h2>
          <Network size={15} aria-hidden="true" />
          相关知识
        </h2>
        <div className="knowledge-panel-actions">
          <button type="button" className="icon-btn" aria-label="关闭相关知识" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <p className="knowledge-panel-source">
        第 {context.currentPage} 页
        {context.selection !== null
          ? ` · 选中 ${String(context.selection.quote.length)} 字`
          : ' · 整页'}
        {project !== null ? ` · 项目「${project.name}」` : ' · 还没有选择项目'}
      </p>
      {context.selection !== null && (
        <p className="knowledge-panel-quote">“{context.selection.quote}”</p>
      )}
      {projectId === null && (
        <p className="knowledge-warn" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          这篇论文不是从项目打开的。建议会保存在知识库里，但不会出现在任何项目，直到你把它加入一个项目。
        </p>
      )}

      <div className="knowledge-panel-scroll">
        <section className="knowledge-panel-block" aria-label="本地已有知识">
          <h3>本地已有知识</h3>
          <p className="concept-hint">这一部分是本地知识库里的内容，打开面板不会调用模型。</p>
          {local === null || local.matches.length === 0 ? (
            <p className="concept-hint">还没有与这段文字直接相关的概念。</p>
          ) : (
            <ul className="knowledge-concept-list">
              {local.matches.map((match) => (
                <ConceptCard
                  key={match.concept.id}
                  match={match}
                  state={state}
                  api={knowledge}
                  projectId={projectId}
                  paper={paper}
                  onJump={onJumpToQuote}
                  onOpenConceptInProject={onOpenConceptInProject}
                  onNotice={onNotice}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="knowledge-panel-block" aria-label="分析知识关联">
          <h3>分析知识关联</h3>
          {phase === 'idle' && (
            <>
              <p className="concept-hint">
                需要模型参与时，先在这里生成上下文计划：它会列出要发送的段落、页码和字数。
                生成计划不会调用模型；你确认之后才会。
              </p>
              <button type="button" className="btn btn-primary" onClick={analysis.prepare}>
                <CircleDot size={14} aria-hidden="true" />
                分析知识关联
              </button>
            </>
          )}

          {phase === 'planning' && (
            <p className="knowledge-panel-busy" role="status">
              <Loader2 size={14} className="spin" aria-hidden="true" />
              正在提取论文文字并生成上下文计划…
            </p>
          )}

          {(phase === 'ready' || phase === 'running' || phase === 'error') && plan !== null && (
            <PlanDetails
              plan={plan}
              health={health}
              phase={phase}
              onStart={analysis.run}
              onCancel={analysis.reset}
            />
          )}

          {phase === 'running' && (
            <p className="knowledge-panel-busy" role="status">
              <Loader2 size={14} className="spin" aria-hidden="true" />
              正在请求模型分析…
              <button type="button" className="btn btn-quiet" onClick={analysis.cancel}>
                取消
              </button>
            </p>
          )}

          {error !== null && (
            <div className="knowledge-panel-error" role="alert">
              <p>{error}</p>
              {plan !== null && phase === 'error' && (
                <button type="button" className="btn" onClick={analysis.run}>
                  重试
                </button>
              )}
            </div>
          )}

          {phase === 'done' && result !== null && (
            <>
              {plan !== null && (
                <details className="knowledge-plan-done">
                  <summary>
                    本次发送的上下文：第 {plan.pagesUsed.join('、')} 页 · {plan.segments.length} 段
                    · {plan.totalChars} 字{plan.truncated ? '（已截断）' : ''}
                  </summary>
                  <ul>
                    {plan.segments.map((segment) => (
                      <li key={segment.id}>
                        <span className="kb-kind">第 {segment.page} 页</span>
                        {segment.label} · {segment.text.length} 字
                      </li>
                    ))}
                  </ul>
                  {plan.notices.map((notice) => (
                    <p className="knowledge-plan-notice" key={notice}>
                      <TriangleAlert size={12} aria-hidden="true" />
                      {notice}
                    </p>
                  ))}
                </details>
              )}
              <div ref={resultsRef}>
                <AnalysisSuggestions
                  analysis={result}
                  report={report}
                  state={state}
                  api={knowledge}
                  projectId={projectId}
                  paper={paper}
                  onJump={onJumpToQuote}
                  onNotice={onNotice}
                  onOpenConceptInProject={onOpenConceptInProject}
                />
              </div>
              <div className="knowledge-panel-again">
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    analysis.prepare();
                  }}
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  重新分析
                </button>
                <span className="concept-hint">
                  已确认的内容不会被下一次分析覆盖；新的建议仍以「待确认」出现。
                </span>
              </div>
            </>
          )}

          {phase === 'done' && result === null && (
            <p className="concept-hint">这次没有得到可用的建议。</p>
          )}
        </section>
      </div>
    </aside>
  );
}

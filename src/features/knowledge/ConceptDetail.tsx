import { useState } from 'react';
import type { Annotation } from '../../domain/annotation';
import type { Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
import {
  ACADEMIC_RELATION_KINDS,
  EVIDENCE_SOURCE_LABEL,
  RELATION_KIND_LABEL,
  RELATION_SUPPORT_LABEL,
  evidenceForRelation,
  relationDirectionText,
  isStaleEvidence,
  learningPath,
  papersOf,
  relationsFor,
  suggestionsFor,
  type Concept,
  type ConceptEvidence,
  type ConceptRelation,
  type RelationKind,
} from '../../domain/knowledge';
import type { KnowledgeApi } from './useKnowledgeApi';
import { RelationHint } from './RelationHint';

interface ConceptDetailProps {
  concept: Concept;
  projectId: string;
  papers: Record<string, Paper>;
  /** Every project, so the concept's own project links can be read and changed. */
  projects: readonly Project[];
  annotations: readonly Annotation[];
  api: KnowledgeApi;
  onOpenReader: (paperId: string, focus?: { page: number; quote: string }) => void;
  /** Switch to another project that shares this concept. */
  onOpenProject: (projectId: string) => void;
  onSelect: (id: string) => void;
  onRequestDelete: () => void;
  onNotice: (text: string | null) => void;
}

const RELATION_HINT: Record<RelationKind, string> = {
  prerequisite: '要理解这个概念，需要先理解…（只用于学习顺序）',
  definition: '这个概念的定义或核心刻画依赖…',
  approximates: '这个概念是…的近似实现或近似计算',
  replaces: '这个概念替代、取代或对照…',
  related: '与这个概念相关的另一个概念…',
  extends: '这个概念扩展了…（在原有基础上增加能力）',
};

/**
 * Everything about one concept, and every way to change it.
 *
 * The order of the sections is the order a reader needs them: what it is, what it stands on,
 * what stands on it, and where it was read. Evidence comes last because it is the proof, not
 * the introduction — but it is the only thing that can take the reader back to the paper.
 */
export function ConceptDetail({
  concept,
  projectId,
  papers,
  projects,
  annotations,
  api,
  onOpenReader,
  onOpenProject,
  onSelect,
  onRequestDelete,
  onNotice,
}: ConceptDetailProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(concept.name);
  const [summary, setSummary] = useState(concept.summary);
  const [relationKind, setRelationKind] = useState<RelationKind>('prerequisite');
  const [relationTarget, setRelationTarget] = useState('');
  const [addingEvidence, setAddingEvidence] = useState(false);
  const [projectToJoin, setProjectToJoin] = useState('');

  const state = api.state;
  const projectConcepts = state.concepts.filter((entry) => entry.projectIds.includes(projectId));
  const evidence = state.evidence
    .filter((entry) => entry.conceptId === concept.id && entry.relationId === undefined)
    // Grouped by paper, then in the paper's own page order: the interesting question about a
    // shared concept is how the *other* papers phrase it, and that comparison only reads when
    // each paper's quotations sit together. Newest-first interleaved the papers instead.
    .sort((one, other) => {
      const oneTitle = papers[one.paperId]?.title ?? '￿';
      const otherTitle = papers[other.paperId]?.title ?? '￿';
      return (
        oneTitle.localeCompare(otherTitle, 'zh-Hans-CN') ||
        one.page - other.page ||
        one.createdAt - other.createdAt
      );
    });
  const relations = relationsFor(state, concept.id);
  const suggested = suggestionsFor(state, concept.id);
  const usedPapers = papersOf(state, concept.id);
  const linkedProjects = concept.projectIds
    .map((id) => projects.find((project) => project.id === id))
    .filter((project): project is Project => project !== undefined);
  const joinable = projects.filter((project) => !concept.projectIds.includes(project.id));
  const path = learningPath(state, concept.id);

  const nameOf = (id: string): string =>
    state.concepts.find((entry) => entry.id === id)?.name ?? '（已删除）';

  const prerequisites = relations.filter(
    (relation) =>
      relation.kind === 'prerequisite' &&
      relation.from === concept.id &&
      relation.status === 'confirmed',
  );
  const dependents = relations.filter(
    (relation) =>
      relation.kind === 'prerequisite' &&
      relation.to === concept.id &&
      relation.status === 'confirmed',
  );
  const related = relations.filter(
    (relation) =>
      relation.kind === 'related' &&
      relation.status === 'confirmed' &&
      (relation.from === concept.id || relation.to === concept.id),
  );
  const extendsEdges = relations.filter(
    (relation) =>
      relation.kind === 'extends' &&
      relation.from === concept.id &&
      relation.status === 'confirmed',
  );
  const academicEdges = relations.filter(
    (relation) =>
      relation.status === 'confirmed' &&
      ACADEMIC_RELATION_KINDS.includes(relation.kind) &&
      (relation.from === concept.id || relation.to === concept.id),
  );
  const rejectedHere = state.rejections
    .filter((rejection) => rejection.from === concept.id || rejection.to === concept.id)
    .sort((one, other) => other.createdAt - one.createdAt);

  /** Annotations of this project's papers that are not already attached to this concept. */
  const attachable = annotations.filter((annotation) => {
    if (annotation.page < 1) return false;
    const already = evidence.some((entry) => entry.annotationId === annotation.id);
    return !already;
  });

  const addRelation = (): void => {
    if (relationTarget === '') return;
    const result = api.createRelation({
      from: concept.id,
      to: relationTarget,
      kind: relationKind,
    });
    if (!result.ok) {
      onNotice(result.reason ?? '这条关系无法添加。');
      return;
    }
    onNotice(null);
    setRelationTarget('');
  };

  return (
    <section className="concept-detail" aria-label={`概念：${concept.name}`}>
      <header className="concept-head">
        {editing ? (
          <div className="concept-edit">
            <label>
              <span className="sr-only">概念名称</span>
              <input
                className="kb-input"
                value={name}
                maxLength={80}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </label>
            <label>
              <span className="sr-only">简短概述</span>
              <textarea
                className="kb-input"
                rows={3}
                value={summary}
                maxLength={600}
                onChange={(event) => {
                  setSummary(event.target.value);
                }}
              />
            </label>
            <div className="concept-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  api.updateConcept(concept.id, { name, summary });
                  setEditing(false);
                }}
              >
                保存
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setName(concept.name);
                  setSummary(concept.summary);
                  setEditing(false);
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <h3 className="concept-name">
              {concept.name}
              {concept.status === 'suggested' && <span className="kb-badge">待确认</span>}
              {concept.origin === 'ai' && <span className="kb-badge kb-badge-ai">AI 提出</span>}
            </h3>
            <div className="concept-actions">
              {concept.status === 'suggested' && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    api.confirmConcept(concept.id);
                  }}
                >
                  确认这个概念
                </button>
              )}
              {!concept.projectIds.includes(projectId) && (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    api.linkProject(concept.id, projectId);
                  }}
                >
                  加入本项目
                </button>
              )}
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setEditing(true);
                }}
              >
                编辑
              </button>
              <button type="button" className="btn btn-quiet" onClick={onRequestDelete}>
                删除
              </button>
            </div>
          </>
        )}
      </header>

      {concept.summary !== '' && <p className="concept-summary">{concept.summary}</p>}
      <p className="concept-meta">
        出现在 {usedPapers.length} 篇论文里 · {evidence.length} 处出处 · 本项目共{' '}
        {projectConcepts.length} 个概念
        {evidence.length === 0 && ' · 尚无原文出处'}
      </p>

      <section className="concept-block" aria-labelledby={`projects-${concept.id}`}>
        <h4 id={`projects-${concept.id}`}>所属项目</h4>
        {linkedProjects.length === 0 ? (
          <p className="concept-hint">
            这个概念还没有加入任何项目；它仍保存在知识库里，加入项目后就会出现在那个项目的「知识」里。
          </p>
        ) : (
          <ul className="concept-links">
            {linkedProjects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className="link-btn"
                  title="打开这个项目"
                  onClick={() => {
                    onOpenProject(project.id);
                  }}
                >
                  {project.name}
                </button>
                {project.id === projectId && <span className="kb-kind">当前</span>}
                <button
                  type="button"
                  className="link-remove"
                  aria-label={`从《${project.name}》移出这个概念`}
                  onClick={() => {
                    api.unlinkProject(concept.id, project.id);
                    onNotice(
                      `已从《${project.name}》移出「${concept.name}」。概念、出处与其他项目都不受影响。`,
                    );
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {joinable.length > 0 && (
          <div className="concept-relation-form">
            <select
              className="kb-select"
              aria-label="加入项目"
              value={projectToJoin}
              onChange={(event) => {
                setProjectToJoin(event.target.value);
              }}
            >
              <option value="">加入其他项目…</option>
              {joinable.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={projectToJoin === ''}
              aria-label="加入项目"
              onClick={() => {
                const target = projects.find((project) => project.id === projectToJoin);
                if (target === undefined) return;
                api.linkProject(concept.id, target.id);
                onNotice(`已把「${concept.name}」加入《${target.name}》。`);
                setProjectToJoin('');
              }}
            >
              加入
            </button>
          </div>
        )}
        <p className="concept-hint">
          移出项目只改变它出现在哪个项目里，不删除概念、出处或任何笔记。
        </p>
      </section>

      <section className="concept-block" aria-labelledby={`prereq-${concept.id}`}>
        <h4 id={`prereq-${concept.id}`}>前置知识</h4>
        {prerequisites.length === 0 ? (
          <p className="concept-hint">还没有记录它依赖什么。</p>
        ) : (
          <ul className="concept-links">
            {prerequisites.map((relation) => {
              const evidence = evidenceForRelation(state, relation.id);
              return (
                <li key={relation.id} className="confirmed-relation">
                  <div className="suggested-relation-head">
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => onSelect(relation.to)}
                    >
                      {nameOf(relation.to)}
                    </button>
                    {relation.support !== undefined && (
                      <span className={`kb-support kb-support-${relation.support}`}>
                        {RELATION_SUPPORT_LABEL[relation.support]}
                      </span>
                    )}
                    <select
                      className="kb-select kb-select-kind"
                      aria-label={`把与 ${nameOf(relation.to)} 的关系改为`}
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
                    <button
                      type="button"
                      className="link-remove"
                      aria-label={`删除指向 ${nameOf(relation.to)} 的前置关系`}
                      onClick={() => {
                        api.deleteRelation(relation.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {relation.rationale !== undefined && relation.rationale !== '' && (
                    <p className="suggested-relation-why">
                      <span className="knowledge-label">模型解释</span>
                      {relation.rationale}
                    </p>
                  )}
                  {evidence.length > 0 && (
                    <ul className="suggested-relation-evidence">
                      {evidence.map((entry) => (
                        <li key={entry.id}>
                          <span
                            className="evidence-paper"
                            title={`文件 ${entry.pdfSha256.slice(0, 12)}…`}
                          >
                            {papers[entry.paperId]?.title ?? '（论文已不在库中）'}
                          </span>
                          <span className="kb-kind">第 {entry.page} 页</span>
                          <span className="evidence-quote">“{entry.quote}”</span>
                          <button
                            type="button"
                            className="link-btn"
                            disabled={papers[entry.paperId]?.pdf?.sha256 !== entry.pdfSha256}
                            onClick={() => {
                              onOpenReader(entry.paperId, {
                                page: entry.page,
                                quote: entry.quote,
                              });
                            }}
                          >
                            回到原文
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <RelationHint relation={relation} api={api} onNotice={onNotice} />
                </li>
              );
            })}
          </ul>
        )}
        <p className="concept-hint">
          「前置知识」只表示学习顺序；定义、近似、替代关系不是前置，请使用对应类型。
        </p>
        {dependents.length > 0 && (
          <p className="concept-hint">
            被这些概念依赖：
            {dependents.map((relation, index) => (
              <span key={relation.id}>
                {index > 0 && '、'}
                <button type="button" className="link-btn" onClick={() => onSelect(relation.from)}>
                  {nameOf(relation.from)}
                </button>
              </span>
            ))}
          </p>
        )}
      </section>

      {path.length > 1 && (
        <section className="concept-block" aria-labelledby={`path-${concept.id}`}>
          <h4 id={`path-${concept.id}`}>学习路径</h4>
          <ol className="learning-path">
            {path.map((entry, index) => (
              <li key={entry.id} data-current={entry.id === concept.id}>
                <span className="learning-path-index">{index + 1}</span>
                <button
                  type="button"
                  className="link-btn"
                  disabled={entry.id === concept.id}
                  onClick={() => {
                    onSelect(entry.id);
                  }}
                >
                  {entry.name}
                </button>
                {entry.id === concept.id && <span className="kb-kind">当前</span>}
              </li>
            ))}
          </ol>
          <p className="concept-hint">
            从基础到当前概念，只使用你确认过的前置关系；同层分支按名称排序，不代表唯一正确的学习顺序。
          </p>
        </section>
      )}

      {(related.length > 0 || extendsEdges.length > 0) && (
        <section className="concept-block" aria-labelledby={`related-${concept.id}`}>
          <h4 id={`related-${concept.id}`}>相关与扩展</h4>
          <ul className="concept-links">
            {[...related, ...extendsEdges].map((relation) => {
              const other = relation.from === concept.id ? relation.to : relation.from;
              const evidence = evidenceForRelation(state, relation.id);
              return (
                <li key={relation.id} className="confirmed-relation">
                  <div className="suggested-relation-head">
                    <span className="kb-kind">{RELATION_KIND_LABEL[relation.kind]}</span>
                    <button type="button" className="link-btn" onClick={() => onSelect(other)}>
                      {nameOf(other)}
                    </button>
                    {relation.support !== undefined && (
                      <span className={`kb-support kb-support-${relation.support}`}>
                        {RELATION_SUPPORT_LABEL[relation.support]}
                      </span>
                    )}
                    <select
                      className="kb-select kb-select-kind"
                      aria-label={`把与 ${nameOf(other)} 的关系改为`}
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
                    <button
                      type="button"
                      className="link-remove"
                      aria-label={`删除与 ${nameOf(other)} 的关系`}
                      onClick={() => {
                        api.deleteRelation(relation.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {relation.rationale !== undefined && relation.rationale !== '' && (
                    <p className="suggested-relation-why">
                      <span className="knowledge-label">模型解释</span>
                      {relation.rationale}
                    </p>
                  )}
                  {evidence.length > 0 && (
                    <ul className="suggested-relation-evidence">
                      {evidence.map((entry) => (
                        <li key={entry.id}>
                          <span
                            className="evidence-paper"
                            title={`文件 ${entry.pdfSha256.slice(0, 12)}…`}
                          >
                            {papers[entry.paperId]?.title ?? '（论文已不在库中）'}
                          </span>
                          <span className="kb-kind">第 {entry.page} 页</span>
                          <span className="evidence-quote">“{entry.quote}”</span>
                          <button
                            type="button"
                            className="link-btn"
                            disabled={papers[entry.paperId]?.pdf?.sha256 !== entry.pdfSha256}
                            onClick={() => {
                              onOpenReader(entry.paperId, {
                                page: entry.page,
                                quote: entry.quote,
                              });
                            }}
                          >
                            回到原文
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <RelationHint relation={relation} api={api} onNotice={onNotice} />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {academicEdges.length > 0 && (
        <section className="concept-block" aria-labelledby={`academic-${concept.id}`}>
          <h4 id={`academic-${concept.id}`}>定义、近似与替代</h4>
          <ul className="concept-links">
            {academicEdges.map((relation) => {
              const other = relation.from === concept.id ? relation.to : relation.from;
              const evidence = evidenceForRelation(state, relation.id);
              return (
                <li key={relation.id} className="confirmed-relation">
                  <div className="suggested-relation-head">
                    <span className="kb-kind">{RELATION_KIND_LABEL[relation.kind]}</span>
                    <button type="button" className="link-btn" onClick={() => onSelect(other)}>
                      {nameOf(other)}
                    </button>
                    {relation.support !== undefined && (
                      <span className={`kb-support kb-support-${relation.support}`}>
                        {RELATION_SUPPORT_LABEL[relation.support]}
                      </span>
                    )}
                    <select
                      className="kb-select kb-select-kind"
                      aria-label={`把与 ${nameOf(other)} 的关系改为`}
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
                    <button
                      type="button"
                      className="link-remove"
                      aria-label={`删除与 ${nameOf(other)} 的关系`}
                      onClick={() => {
                        api.deleteRelation(relation.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <p className="concept-hint">
                    {relationDirectionText(
                      relation.kind,
                      nameOf(relation.from),
                      nameOf(relation.to),
                    )}
                  </p>
                  {relation.rationale !== undefined && relation.rationale !== '' && (
                    <p className="suggested-relation-why">
                      <span className="knowledge-label">模型解释</span>
                      {relation.rationale}
                    </p>
                  )}
                  {evidence.length > 0 && (
                    <ul className="suggested-relation-evidence">
                      {evidence.map((entry) => (
                        <li key={entry.id}>
                          <span
                            className="evidence-paper"
                            title={`文件 ${entry.pdfSha256.slice(0, 12)}…`}
                          >
                            {papers[entry.paperId]?.title ?? '（论文已不在库中）'}
                          </span>
                          <span className="kb-kind">第 {entry.page} 页</span>
                          <span className="evidence-quote">“{entry.quote}”</span>
                          <button
                            type="button"
                            className="link-btn"
                            disabled={papers[entry.paperId]?.pdf?.sha256 !== entry.pdfSha256}
                            onClick={() => {
                              onOpenReader(entry.paperId, {
                                page: entry.page,
                                quote: entry.quote,
                              });
                            }}
                          >
                            回到原文
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <RelationHint relation={relation} api={api} onNotice={onNotice} />
                </li>
              );
            })}
          </ul>
          <p className="concept-hint">
            这些是学术关系，不会进入「前置知识」学习路径；只有「前置知识」才决定学习顺序。
          </p>
        </section>
      )}

      {suggested.relations.length > 0 && (
        <section className="concept-block" aria-labelledby={`suggested-${concept.id}`}>
          <h4 id={`suggested-${concept.id}`}>AI 建议的关系（尚未确认）</h4>
          <ul className="concept-links">
            {suggested.relations.map((relation: ConceptRelation) => {
              const other = relation.from === concept.id ? relation.to : relation.from;
              const evidence = evidenceForRelation(state, relation.id);
              return (
                <li key={relation.id} className="suggested-relation">
                  <div className="suggested-relation-head">
                    <span className="kb-kind">{RELATION_KIND_LABEL[relation.kind]}</span>
                    <span>{nameOf(other)}</span>
                    {relation.support !== undefined && (
                      <span className={`kb-support kb-support-${relation.support}`}>
                        {RELATION_SUPPORT_LABEL[relation.support]}
                      </span>
                    )}
                    {evidence.length === 0 && <span className="kb-badge">待验证：无逐字引文</span>}
                  </div>
                  {relation.rationale !== undefined && relation.rationale !== '' && (
                    <p className="suggested-relation-why">
                      <span className="knowledge-label">模型解释</span>
                      {relation.rationale}
                    </p>
                  )}
                  {evidence.length > 0 && (
                    <ul className="suggested-relation-evidence">
                      {evidence.map((entry) => (
                        <li key={entry.id}>
                          <span
                            className="evidence-paper"
                            title={`文件 ${entry.pdfSha256.slice(0, 12)}…`}
                          >
                            {papers[entry.paperId]?.title ?? '（论文已不在库中）'}
                          </span>
                          <span className="kb-kind">第 {entry.page} 页</span>
                          <span className="evidence-quote">“{entry.quote}”</span>
                          <button
                            type="button"
                            className="link-btn"
                            disabled={papers[entry.paperId]?.pdf?.sha256 !== entry.pdfSha256}
                            onClick={() => {
                              onOpenReader(entry.paperId, {
                                page: entry.page,
                                quote: entry.quote,
                              });
                            }}
                          >
                            回到原文
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <RelationHint relation={relation} api={api} onNotice={onNotice} />
                  <div className="concept-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        const result = api.confirmRelation(relation.id);
                        onNotice(
                          result.ok ? '已采纳这条关系。' : (result.reason ?? '无法采纳这条关系。'),
                        );
                      }}
                    >
                      采纳
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      title="记录为明确拒绝；同一条主张不会在下次分析时自动恢复"
                      onClick={() => {
                        const result = api.rejectRelation(relation.id);
                        onNotice(
                          result.ok
                            ? '已拒绝这条关系建议；撤销前，同一主张不会自动恢复。'
                            : (result.reason ?? '无法拒绝这条关系建议。'),
                        );
                      }}
                    >
                      拒绝该关系
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
                          onNotice(
                            result.ok ? '关系类型已修改。' : (result.reason ?? '无法修改。'),
                          );
                        }}
                      >
                        {(Object.keys(RELATION_KIND_LABEL) as RelationKind[]).map((kind) => (
                          <option key={kind} value={kind}>
                            {RELATION_KIND_LABEL[kind]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="link-remove"
                      title="只移除本次建议；下次分析可能再次出现"
                      aria-label="暂时忽略这条建议"
                      onClick={() => {
                        api.deleteRelation(relation.id);
                        onNotice('已暂时忽略这条关系建议；下次分析可能再次出现。');
                      }}
                    >
                      ×
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {rejectedHere.length > 0 && (
        <section className="concept-block" aria-labelledby={`rejected-${concept.id}`}>
          <h4 id={`rejected-${concept.id}`}>已拒绝的关系建议</h4>
          <p className="concept-hint">
            这些是明确的拒绝，不会在重新分析时自动恢复；只有你在这里撤销后，同一主张才可能再次出现。
          </p>
          <ul className="concept-links">
            {rejectedHere.map((rejection) => {
              const other = rejection.from === concept.id ? rejection.to : rejection.from;
              return (
                <li key={rejection.id} className="confirmed-relation">
                  <div className="suggested-relation-head">
                    <span className="kb-kind">{RELATION_KIND_LABEL[rejection.kind]}</span>
                    <span>{nameOf(other)}</span>
                    <span className="kb-badge">已拒绝</span>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        api.undoRejection(rejection.id);
                        onNotice('已撤销拒绝；下一次分析可能再次提出这条关系。');
                      }}
                    >
                      撤销拒绝
                    </button>
                  </div>
                  {rejection.rationale !== '' && (
                    <p className="suggested-relation-why">
                      <span className="knowledge-label">当时的解释</span>
                      {rejection.rationale}
                    </p>
                  )}
                  {rejection.evidence.length > 0 && (
                    <p className="concept-hint">
                      拒绝时带着 {rejection.evidence.length}{' '}
                      条引文；重新分析若给出不同解释或证据，会作为新建议出现。
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="concept-block">
        <h4>添加关系</h4>
        <div className="concept-relation-form">
          <select
            className="kb-select"
            aria-label="关系类型"
            value={relationKind}
            onChange={(event) => {
              setRelationKind(event.target.value as RelationKind);
            }}
          >
            {(Object.keys(RELATION_KIND_LABEL) as RelationKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {RELATION_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
          <select
            className="kb-select"
            aria-label="关系对象"
            value={relationTarget}
            onChange={(event) => {
              setRelationTarget(event.target.value);
            }}
          >
            <option value="">选择另一个概念…</option>
            {state.concepts
              .filter((entry) => entry.id !== concept.id)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={relationTarget === ''}
            title={RELATION_HINT[relationKind]}
            aria-label="添加关系"
            onClick={addRelation}
          >
            添加
          </button>
        </div>
        <p className="concept-hint">{RELATION_HINT[relationKind]}</p>
      </section>

      {usedPapers.length > 0 && (
        <section className="concept-block" aria-labelledby={`papers-${concept.id}`}>
          <h4 id={`papers-${concept.id}`}>涉及论文</h4>
          <ul className="concept-papers">
            {usedPapers.map(({ paperId, count }) => {
              const paper = papers[paperId];
              return (
                <li key={paperId}>
                  <span className="concept-paper-title">
                    {paper?.title ?? '（论文已不在库中）'}
                  </span>
                  <span className="concept-card-meta">{count} 处出处</span>
                  {paper !== undefined && paper.pdf !== undefined && (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => {
                        onOpenReader(paperId);
                      }}
                    >
                      打开论文
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="concept-block" aria-labelledby={`evidence-${concept.id}`}>
        <h4 id={`evidence-${concept.id}`}>论文与出处</h4>
        {evidence.length === 0 ? (
          <p className="concept-hint">还没有原文出处。下面可以从你的笔记里挑一条。</p>
        ) : (
          <ul className="evidence-list">
            {evidence.map((entry) => (
              <EvidenceRow
                key={entry.id}
                entry={entry}
                paper={papers[entry.paperId]}
                onOpen={onOpenReader}
                onRemove={() => {
                  api.removeEvidence(entry.id);
                }}
              />
            ))}
          </ul>
        )}

        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            setAddingEvidence((value) => !value);
          }}
        >
          {addingEvidence ? '收起' : '从笔记里添加出处'}
        </button>
        {addingEvidence && (
          <ul className="evidence-picker">
            {attachable.length === 0 && <li className="concept-hint">没有可添加的笔记。</li>}
            {attachable.map((annotation) => (
              <li key={annotation.id}>
                <span className="evidence-page">第 {annotation.page} 页</span>
                <span className="evidence-quote">{annotation.quote.slice(0, 60)}</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    api.addEvidence({
                      conceptId: concept.id,
                      paperId: annotation.paperId,
                      pdfSha256: annotation.pdfSha256,
                      page: annotation.page,
                      quote: annotation.quote,
                      prefix: annotation.prefix,
                      suffix: annotation.suffix,
                      rects: annotation.rects,
                      source: 'annotation',
                      annotationId: annotation.id,
                      note: annotation.note,
                    });
                    onNotice(null);
                  }}
                >
                  添加
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function EvidenceRow({
  entry,
  paper,
  onOpen,
  onRemove,
}: {
  entry: ConceptEvidence;
  paper: Paper | undefined;
  onOpen: (paperId: string, focus?: { page: number; quote: string }) => void;
  onRemove: () => void;
}) {
  const stale = paper === undefined || isStaleEvidence(entry, paper.pdf?.sha256);
  return (
    <li className="evidence-row" data-stale={stale}>
      <div className="evidence-head">
        <span className="evidence-paper">{paper?.title ?? '（论文已不在库中）'}</span>
        <span className="evidence-page">第 {entry.page} 页</span>
        <span className="kb-kind">{EVIDENCE_SOURCE_LABEL[entry.source]}</span>
      </div>
      <p className="evidence-quote">“{entry.quote}”</p>
      {entry.note !== '' && <p className="evidence-note">{entry.note}</p>}
      {stale && (
        <p className="evidence-stale">这条出处来自另一个文件版本，原文位置不再可靠，不会跳转。</p>
      )}
      <div className="concept-actions">
        <button
          type="button"
          className="btn btn-quiet"
          disabled={stale}
          title={stale ? '文件已经不同，无法定位到原文' : '打开这篇论文并标出这句话'}
          onClick={() => {
            onOpen(entry.paperId, { page: entry.page, quote: entry.quote });
          }}
        >
          打开原文
        </button>
        <button type="button" className="btn btn-quiet" onClick={onRemove}>
          移除出处
        </button>
      </div>
    </li>
  );
}

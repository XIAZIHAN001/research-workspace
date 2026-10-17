import { Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Annotation } from '../../domain/annotation';
import { conceptsInProject, normalizeConceptName, type Concept } from '../../domain/knowledge';
import type { Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { ConceptDetail } from './ConceptDetail';
import { ConceptGraph } from './ConceptGraph';
import type { ConceptCandidate, KnowledgeApi } from './useKnowledgeApi';

interface KnowledgeViewProps {
  project: Project;
  papers: Record<string, Paper>;
  annotations: readonly Annotation[];
  api: KnowledgeApi;
  onOpenReader: (paperId: string, focus?: { page: number; quote: string }) => void;
}

/** Papers this project is about, whose reading records can seed concepts. */
function projectPapers(project: Project, papers: Record<string, Paper>): Paper[] {
  return [project.corePaperId, ...project.relatedPaperIds]
    .map((id) => papers[id])
    .filter((paper): paper is Paper => paper !== undefined);
}

/**
 * The project's knowledge, as a list and as a graph.
 *
 * The zone belongs to the project — it is a second view of the same page, not a separate
 * workspace — and it shows one thing at a time: the concepts this project is made of, with the
 * evidence behind them. Nothing here is invented: every node is a record the reader created or
 * confirmed, and every line is a relation they asserted.
 */
export function KnowledgeView({
  project,
  papers,
  annotations,
  api,
  onOpenReader,
}: KnowledgeViewProps) {
  const [mode, setMode] = useState<'list' | 'graph'>('list');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Concept | null>(null);
  const [candidates, setCandidates] = useState<ConceptCandidate[] | null>(null);

  const state = api.state;
  const concepts = useMemo(() => conceptsInProject(state, project.id), [state, project.id]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return concepts;
    return concepts.filter(
      (concept) =>
        concept.name.toLowerCase().includes(needle) ||
        concept.summary.toLowerCase().includes(needle) ||
        concept.aliases.some((alias) => alias.toLowerCase().includes(needle)),
    );
  }, [concepts, query]);

  const selected = concepts.find((concept) => concept.id === selectedId) ?? visible[0] ?? null;
  const projectAnnotations = annotations.filter((annotation) =>
    projectPapers(project, papers).some((paper) => paper.id === annotation.paperId),
  );

  const create = (): void => {
    const name = newName.trim();
    if (name === '') return;
    const id = api.createConcept({ name, summary: newSummary, projectIds: [project.id] });
    setNewName('');
    setNewSummary('');
    setCreating(false);
    setSelectedId(id);
    setNotice(null);
  };

  const organize = (): void => {
    const shas = projectPapers(project, papers)
      .map((paper) => paper.pdf?.sha256)
      .filter((sha): sha is string => typeof sha === 'string');
    const found = api.candidatesFromDifficulties(shas);
    setCandidates(found);
    if (found.length === 0) {
      setNotice('这些论文还没有已缓存的难点分析；在读的时候打开「智能难点」即可积累。');
    } else {
      setNotice(null);
    }
  };

  const acceptCandidate = (candidate: ConceptCandidate): void => {
    const id = api.createConcept({
      name: candidate.name,
      summary: candidate.summary,
      projectIds: [project.id],
      origin: 'ai',
      status: 'suggested',
    });
    for (const entry of candidate.evidence) {
      api.addEvidence({ ...entry, conceptId: id });
    }
    setSelectedId(id);
    setCandidates((current) =>
      current === null ? null : current.filter((entry) => entry !== candidate),
    );
  };

  const storageWarning =
    api.persisted === false
      ? '这次改动没有保存到本地存储：内容还在当前页面里，关闭后会丢失。'
      : api.issue === 'unreadable' || api.issue === 'wrong-shape'
        ? '本地知识数据有一部分无法读取，已保留副本并从可读的部分继续。'
        : null;

  return (
    <section className="knowledge" aria-labelledby="knowledge-heading">
      <div className="knowledge-head">
        <h2 id="knowledge-heading" className="section-title">
          知识
        </h2>
        <div className="knowledge-modes" role="group" aria-label="呈现方式">
          <button
            type="button"
            className="chip"
            aria-pressed={mode === 'list'}
            onClick={() => {
              setMode('list');
            }}
          >
            列表
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={mode === 'graph'}
            onClick={() => {
              setMode('graph');
            }}
          >
            关系图
          </button>
        </div>
        <label className="knowledge-search">
          <Search size={14} aria-hidden="true" />
          <span className="sr-only">搜索概念</span>
          <input
            type="search"
            value={query}
            placeholder="搜索概念…"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            setCreating((value) => !value);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          新建概念
        </button>
        <button type="button" className="btn btn-quiet" onClick={organize}>
          <Sparkles size={14} aria-hidden="true" />
          从阅读记录整理
        </button>
      </div>

      {(notice !== null || storageWarning !== null) && (
        <p className="knowledge-notice" role="status">
          {notice ?? storageWarning}
        </p>
      )}

      {creating && (
        <div className="knowledge-create">
          <label>
            <span className="sr-only">概念名称</span>
            <input
              className="kb-input"
              value={newName}
              maxLength={80}
              placeholder="概念名称，例如 KZG commitment"
              autoFocus
              onChange={(event) => {
                setNewName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') create();
              }}
            />
          </label>
          <label>
            <span className="sr-only">简短概述</span>
            <textarea
              className="kb-input"
              rows={2}
              value={newSummary}
              maxLength={600}
              placeholder="一两句话说明它是什么（可稍后补）"
              onChange={(event) => {
                setNewSummary(event.target.value);
              }}
            />
          </label>
          <div className="concept-actions">
            <button type="button" className="btn btn-primary" onClick={create}>
              创建
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setCreating(false);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {candidates !== null && candidates.length > 0 && (
        <div className="knowledge-candidates" role="group" aria-label="概念建议">
          <p className="knowledge-candidates-head">
            从阅读记录里找到 {candidates.length}{' '}
            个概念候选。它们会成为「待确认」的概念，确认前不算正式知识。
          </p>
          <ul>
            {candidates.map((candidate) => {
              const duplicate = state.concepts.find(
                (concept) =>
                  normalizeConceptName(concept.name) === normalizeConceptName(candidate.name),
              );
              return (
                <li key={candidate.name}>
                  <span className="candidate-name">{candidate.name}</span>
                  <span className="candidate-meta">
                    {candidate.evidence.length} 处出处
                    {duplicate !== undefined &&
                      ` · 已有同名概念《${duplicate.name}》，不会自动合并`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      acceptCandidate(candidate);
                    }}
                  >
                    添加为待确认概念
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setCandidates(null);
            }}
          >
            收起
          </button>
        </div>
      )}

      {concepts.length === 0 ? (
        <p className="knowledge-empty">
          这个项目还没有概念。可以新建一个，或从已经读过的难点标注里整理。
        </p>
      ) : (
        <div className="knowledge-body" data-mode={mode}>
          <div
            className={mode === 'graph' ? 'knowledge-list knowledge-graph-pane' : 'knowledge-list'}
            aria-label="概念列表"
          >
            {mode === 'graph' ? (
              <ConceptGraph
                concepts={concepts}
                relations={state.relations}
                selectedId={selected?.id ?? null}
                onSelect={setSelectedId}
              />
            ) : visible.length === 0 ? (
              <p className="knowledge-empty">没有匹配的概念。</p>
            ) : (
              <ul>
                {visible.map((concept) => {
                  const evidenceCount = state.evidence.filter(
                    (entry) => entry.conceptId === concept.id,
                  ).length;
                  const prerequisites = state.relations.filter(
                    (relation) =>
                      relation.kind === 'prerequisite' &&
                      relation.from === concept.id &&
                      relation.status === 'confirmed',
                  ).length;
                  return (
                    <li key={concept.id}>
                      <button
                        type="button"
                        className="concept-card"
                        data-selected={concept.id === selected?.id}
                        aria-pressed={concept.id === selected?.id}
                        onClick={() => {
                          setSelectedId(concept.id);
                        }}
                      >
                        <span className="concept-card-name">
                          {concept.name}
                          {concept.status === 'suggested' && (
                            <span className="kb-badge">待确认</span>
                          )}
                        </span>
                        {concept.summary !== '' && (
                          <span className="concept-card-summary">{concept.summary}</span>
                        )}
                        <span className="concept-card-meta">
                          前置 {prerequisites} · 出处 {evidenceCount}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {selected !== null && (
            <ConceptDetail
              key={selected.id}
              concept={selected}
              projectId={project.id}
              papers={papers}
              annotations={projectAnnotations}
              api={api}
              onOpenReader={onOpenReader}
              onSelect={setSelectedId}
              onRequestDelete={() => {
                setPendingDelete(selected);
              }}
              onNotice={setNotice}
            />
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除概念"
        confirmLabel="删除"
        danger
        onConfirm={() => {
          if (pendingDelete !== null) api.deleteConcept(pendingDelete.id);
          setPendingDelete(null);
          setSelectedId(null);
        }}
        onClose={() => {
          setPendingDelete(null);
        }}
      >
        <p>
          删除《{pendingDelete?.name ?? ''}
          》会同时删除它的出处记录和与它相连的关系。论文和你的笔记不受影响。
        </p>
        <p className="dialog-note">
          <Trash2 size={12} aria-hidden="true" />{' '}
          如果只是不想在这个项目里看到它，可以先把它移出本项目。
        </p>
      </ConfirmDialog>
    </section>
  );
}

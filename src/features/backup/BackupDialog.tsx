import { Download, FileUp, ShieldCheck, Upload } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { KnowledgeState } from '../../domain/knowledge';
import type { ProjectsState } from '../../domain/projectsState';
import {
  DEFAULT_RESTORE_CHOICE,
  type RestoreChoice,
  type RestoreConflict,
} from '../../domain/backupPlan';
import type { PdfBlobStore } from '../../services/pdfStore';
import {
  availableBytes,
  buildBackup,
  executeRestore,
  inspectBackupFile,
  presentPdfHashes,
  readBackupPreferences,
  readBackupSource,
  readRecoveryCopies,
  type BackupInspection,
  type RestoreResult,
  type RestoreStage,
} from '../../services/backupService';
import { backupFileName, downloadBackup } from '../../services/backupFormat';
import { createIndexedDbJournal } from '../../services/restoreJournal';
import { defaultStore } from '../../services/storage';
import { Dialog } from '../../ui/Dialog';

interface BackupDialogProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectsState;
  knowledge: KnowledgeState;
  blobs: PdfBlobStore;
  /** Called after a successful restore: the page must reload to show the restored stores. */
  onReload: () => void;
}

type Note = { kind: 'success' | 'warning' | 'error'; text: string };

const STAGE_LABEL: Record<RestoreStage, string> = {
  journal: '正在建立恢复日志…',
  pdfs: '正在写入 PDF 文件…',
  data: '正在写入项目、笔记与知识…',
  verify: '正在从本地存储回读校验…',
};

const CONFLICT_LABEL: Record<RestoreConflict['kind'], string> = {
  project: '项目',
  paper: '论文',
  annotation: '笔记',
  bookmark: '书签',
  glossary: '术语',
  concept: '概念',
  evidence: '出处',
  relation: '关系',
};

const MB = 1024 * 1024;

function describeBytes(bytes: number): string {
  if (bytes < MB) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

function conflictCounts(conflicts: readonly RestoreConflict[]): string {
  const counts = new Map<RestoreConflict['kind'], number>();
  for (const conflict of conflicts) counts.set(conflict.kind, (counts.get(conflict.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => `${CONFLICT_LABEL[kind]} ${String(count)}`)
    .join(' · ');
}

/**
 * Export and restore, with the whole safety story visible before anything is written.
 *
 * The dialog has four states — choose, inspect, confirm, result — and it never skips one. A
 * file that fails inspection never reaches the commit button; a file with a missing PDF or an
 * identity conflict cannot be confirmed until the reader has answered the question it raises;
 * and the result screen repeats what was verified rather than claiming success in general.
 */
export function BackupDialog({
  open,
  onClose,
  projects,
  knowledge,
  blobs,
  onReload,
}: BackupDialogProps) {
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<Note | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [choice, setChoice] = useState<RestoreChoice>(DEFAULT_RESTORE_CHOICE);
  const [policyChosen, setPolicyChosen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<'inspecting' | 'restoring' | null>(null);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const journal = useMemo(() => createIndexedDbJournal(), []);

  const handleClose = useCallback(() => {
    // A successful restore leaves the running React stores behind the persisted values. Closing
    // this dialog and continuing to edit would write the old state back over the restored data.
    if (busy !== null || result?.status === 'restored') return;
    onClose();
  }, [busy, onClose, result]);

  const runExport = async (): Promise<void> => {
    setExporting(true);
    setExportNote(null);
    try {
      const built = await buildBackup({
        source: readBackupSource({ projects, knowledge }),
        preferences: readBackupPreferences(),
        recovery: readRecoveryCopies(),
        blobs,
        now: new Date(),
      });
      downloadBackup(built.blob, backupFileName(new Date()));
      const counts = built.header.counts;
      setExportNote(
        built.missingFiles.length > 0
          ? {
              kind: 'warning',
              text: `备份已下载，但 ${String(built.missingFiles.length)} 个 PDF 在本机已经找不到，没有放进备份：${built.missingPapers.join('、') || '（未命名论文）'}。论文、笔记与知识仍然完整。`,
            }
          : {
              kind: 'success',
              text: `备份已下载：${String(counts.projects ?? 0)} 个项目、${String(counts.papers ?? 0)} 篇论文、${String(counts.annotations ?? 0)} 条笔记、${String(counts.concepts ?? 0)} 个概念、${String(counts.reviewCards ?? 0)} 张复习卡、${String(built.header.files.length)} 个 PDF。`,
            },
      );
    } catch (error) {
      setExportNote({
        kind: 'error',
        text: `导出没有完成：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setExporting(false);
    }
  };

  const inspectPicked = async (picked: File): Promise<void> => {
    setFile(picked);
    setInspection(null);
    setResult(null);
    setPickError(null);
    setAcknowledged(false);
    setPolicyChosen(false);
    setChoice(DEFAULT_RESTORE_CHOICE);
    setBusy('inspecting');
    setProgress('正在检查备份…');
    try {
      const current = readBackupSource({ projects, knowledge });
      const [present, available] = await Promise.all([
        presentPdfHashes(projects.papers, blobs),
        availableBytes(blobs),
      ]);
      const next = await inspectBackupFile(picked, {
        current,
        currentPreferences: readBackupPreferences(),
        presentPdfHashes: present,
        availableBytes: available,
        onProgress: (done, total) => {
          setProgress(
            total === 0 ? '正在检查备份…' : `正在校验 PDF ${String(done)} / ${String(total)}…`,
          );
        },
      });
      setInspection(next);
      setAcknowledged(next.plan !== null && next.plan.missingPdfPapers.length === 0);
    } catch (error) {
      setPickError(`读取备份时出错：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
      setProgress('');
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (picked !== undefined) void inspectPicked(picked);
  };

  const runRestore = async (): Promise<void> => {
    if (file === null || inspection === null) return;
    setBusy('restoring');
    setProgress(STAGE_LABEL.journal);
    try {
      const current = readBackupSource({ projects, knowledge });
      const next = await executeRestore({
        file,
        inspection,
        choice,
        current,
        currentPreferences: readBackupPreferences(),
        storage: defaultStore(),
        blobs,
        journal,
        now: Date.now(),
        onStage: (stage) => {
          setProgress(STAGE_LABEL[stage]);
        },
      });
      setResult(next);
    } catch (error) {
      setResult({
        status: 'failed',
        stage: 'verify',
        message: `恢复过程意外中断：${error instanceof Error ? error.message : String(error)}`,
        rolledBack: false,
        problems: ['如果反复出现，可以在下次启动时检查恢复日志。'],
        pdfsCopied: 0,
      });
    } finally {
      setBusy(null);
      setProgress('');
    }
  };

  const plan = inspection?.plan ?? null;
  const rejected = inspection !== null && inspection.problems.length > 0;
  const needsPolicy = (plan?.conflicts.length ?? 0) > 0;
  const canRestore =
    !rejected &&
    plan !== null &&
    busy === null &&
    acknowledged &&
    (!needsPolicy || policyChosen) &&
    (plan?.blockers.length ?? 0) === 0 &&
    (plan?.storageSufficient ?? true);

  return (
    <Dialog open={open} title="备份与恢复" onClose={handleClose}>
      <section className="backup-section" aria-labelledby="backup-export-heading">
        <h3 id="backup-export-heading">导出整个知识库</h3>
        <p className="backup-copy">
          一个文件包含全部项目、论文身份、PDF、批注、阅读位置、难点缓存、概念、关系、出处与本机偏好。
          PDF 按内容哈希去重，同一个文件只打包一次；备份里不含任何 API Key、环境变量或访问令牌。
        </p>
        <div className="backup-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={exporting}
            onClick={() => {
              void runExport();
            }}
          >
            <Download size={14} aria-hidden="true" />
            {exporting ? '正在打包…' : '导出备份文件'}
          </button>
        </div>
        {exportNote !== null && (
          <p
            className={`backup-message is-${exportNote.kind}`}
            role={exportNote.kind === 'error' ? 'alert' : 'status'}
          >
            {exportNote.text}
          </p>
        )}
      </section>

      <section className="backup-section" aria-labelledby="backup-import-heading">
        <h3 id="backup-import-heading">从备份恢复</h3>
        <p className="backup-copy">
          先检查、再预览、最后才写入。恢复是合并，不会删除本机已有的项目、笔记或知识；同一个备份导入两次不会产生重复内容。
        </p>
        <div className="backup-actions">
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            <Upload size={14} aria-hidden="true" />
            选择备份文件
          </button>
          <input
            ref={fileInput}
            className="backup-file-input"
            type="file"
            accept=".rwbackup,application/octet-stream"
            aria-label="选择备份文件"
            onChange={onFileChange}
          />
        </div>

        {busy === 'inspecting' && (
          <p className="backup-message is-info" role="status">
            {progress}
          </p>
        )}
        {pickError !== null && (
          <p className="backup-message is-error" role="alert">
            {pickError}
          </p>
        )}

        {inspection !== null && (
          <div className="backup-preview">
            <p className="backup-file-line">
              <FileUp size={14} aria-hidden="true" />
              <span>{inspection.fileName}</span>
              <span className="backup-file-size">{describeBytes(inspection.fileSize)}</span>
              {inspection.createdAt !== null && (
                <span className="backup-file-size">
                  导出于 {new Date(inspection.createdAt).toLocaleString('zh-CN')}
                </span>
              )}
            </p>

            {rejected && (
              <div className="backup-message is-error" role="alert">
                <p>这个备份不能恢复：</p>
                <ul>
                  {inspection.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}

            {!rejected && inspection.summary !== null && plan !== null && (
              <>
                <dl className="backup-counts">
                  {[
                    ['项目', inspection.summary.projects],
                    ['论文', inspection.summary.papers],
                    ['笔记', inspection.summary.annotations],
                    ['概念', inspection.summary.concepts],
                    ['出处', inspection.summary.evidence],
                    ['关系', inspection.summary.relations],
                    ['PDF', plan.pdfsToCopy.length + plan.pdfsPresent.length],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <dt>{String(label)}</dt>
                      <dd>{String(value ?? 0)}</dd>
                    </div>
                  ))}
                </dl>

                <p className="backup-summary">
                  本次会新增 {plan.additions.projects} 个项目、{plan.additions.papers} 篇论文、
                  {plan.additions.annotations} 条笔记、{plan.additions.concepts} 个概念、
                  {plan.additions.evidence} 条出处、{plan.additions.relations} 条关系
                  {plan.pdfsToCopy.length > 0 &&
                    `，并复制 ${String(plan.pdfsToCopy.length)} 个 PDF（${describeBytes(plan.neededBytes)}）`}
                  。已经存在且内容相同的记录会被跳过。
                </p>

                {plan.identifierMerges.length > 0 && (
                  <p className="backup-message is-info" role="status">
                    有 {plan.identifierMerges.length} 篇论文通过 DOI/arXiv ID
                    与本机已有论文识别为同一篇，将并入已有记录，并保留两边的笔记与出处。
                  </p>
                )}

                {needsPolicy && (
                  <fieldset className="backup-choice">
                    <legend>
                      有 {plan.conflicts.length} 个对象的 ID 与本机不同内容相同（
                      {conflictCounts(plan.conflicts)}）。请选择保留哪一边：
                    </legend>
                    <label>
                      <input
                        type="radio"
                        name="same-id-policy"
                        checked={policyChosen && choice.sameIdPolicy === 'keep-existing'}
                        onChange={() => {
                          setChoice({ ...choice, sameIdPolicy: 'keep-existing' });
                          setPolicyChosen(true);
                        }}
                      />
                      保留本机版本（推荐，不会覆盖你在这里的修改）
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="same-id-policy"
                        checked={policyChosen && choice.sameIdPolicy === 'prefer-backup'}
                        onChange={() => {
                          setChoice({ ...choice, sameIdPolicy: 'prefer-backup' });
                          setPolicyChosen(true);
                        }}
                      />
                      使用备份里的版本（会替换这些对象的当前内容）
                    </label>
                  </fieldset>
                )}

                {plan.missingPdfPapers.length > 0 && (
                  <label className="backup-acknowledge">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(event) => {
                        setAcknowledged(event.target.checked);
                        setChoice((current) => ({
                          ...current,
                          importMissingPdfs: event.target.checked,
                        }));
                      }}
                    />
                    <span>
                      {plan.missingPdfPapers.length} 篇论文的 PDF
                      不在备份里，也不在本机。仍然恢复这些论文记录（暂时无法阅读原文）。
                    </span>
                  </label>
                )}

                {!plan.storageSufficient && (
                  <p className="backup-message is-error" role="alert">
                    本机可用空间不足：需要约 {describeBytes(plan.neededBytes)}，可用约{' '}
                    {describeBytes(plan.availableBytes ?? 0)}。恢复不会开始。
                  </p>
                )}

                {plan.blockers.length > 0 && (
                  <div className="backup-message is-error" role="alert">
                    <ul>
                      {plan.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {plan.warnings.length > 0 && (
                  <div className="backup-message is-warning" role="status">
                    <ul>
                      {plan.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {busy === 'restoring' ? (
                  <p className="backup-message is-info" role="status">
                    {progress}
                  </p>
                ) : (
                  <div className="backup-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!canRestore}
                      onClick={() => {
                        void runRestore();
                      }}
                    >
                      {plan.additions.projects +
                        plan.additions.papers +
                        plan.additions.annotations +
                        plan.additions.concepts +
                        plan.additions.evidence +
                        plan.additions.relations ===
                      0
                        ? '校验并完成恢复'
                        : '开始恢复'}
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={handleClose}>
                      取消
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {result !== null && <RestoreResultView result={result} onReload={onReload} />}
      </section>

      <p className="backup-footnote">
        <ShieldCheck size={13} aria-hidden="true" />
        恢复写入前会留下恢复日志；任何一步失败都会把已经写入的内容还原。恢复成功后需要重新载入页面。
      </p>
    </Dialog>
  );
}

function RestoreResultView({ result, onReload }: { result: RestoreResult; onReload: () => void }) {
  if (result.status === 'restored') {
    const v = result.verification;
    return (
      <div className="backup-result" role="status">
        <p className="backup-message is-success">
          恢复完成，并已从本地存储回读校验：{v.projects} 个项目、{v.papers} 篇论文、
          {v.annotations} 条笔记、{v.concepts} 个概念、{v.evidence} 条出处、{v.relations} 条关系，
          {v.pdfs} 个 PDF 可用。
          {result.pdfsCopied > 0 && ` 本次写入了 ${String(result.pdfsCopied)} 个 PDF。`}
        </p>
        {result.warnings.length > 0 && (
          <ul className="backup-warning-list">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <div className="backup-actions">
          <button type="button" className="btn btn-primary" onClick={onReload}>
            重新载入以查看恢复后的内容
          </button>
        </div>
      </div>
    );
  }

  if (result.status === 'refused') {
    return (
      <div className="backup-result" role="alert">
        <p className="backup-message is-error">{result.reason}</p>
        {result.problems.length > 0 && (
          <ul className="backup-warning-list">
            {result.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="backup-result" role="alert">
      <p className="backup-message is-error">{result.message}</p>
      {result.problems.length > 0 && (
        <ul className="backup-warning-list">
          {result.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {result.rolledBack && (
        <p className="backup-message is-info">
          本次恢复写入的内容已经撤销；原有项目、笔记与知识没有丢失。
        </p>
      )}
    </div>
  );
}

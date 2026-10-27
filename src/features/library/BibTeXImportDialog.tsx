import { FileText } from 'lucide-react';
import { useState } from 'react';
import { parseBibtex, type BibtexEntry, type BibtexSkipped } from '../../domain/bibtexImport';
import type { Paper, PaperInput } from '../../domain/papers';
import { Dialog } from '../../ui/Dialog';

interface BibTeXImportDialogProps {
  open: boolean;
  /** The registry, so entries that already exist can be recognised before anything is written. */
  papers: Readonly<Record<string, Paper>>;
  onClose: () => void;
  /** Receives only the entries the reader left checked. */
  onImport: (inputs: PaperInput[]) => void;
}

/** One parsed entry beside the paper that already owns its identifier, if any. */
interface PreviewRow {
  entry: BibtexEntry;
  existing: Paper | null;
}

/** Bounds for one import: a whole library, not a reason to freeze the page for minutes. */
const MAX_BIB_BYTES = 5 * 1024 * 1024;
const MAX_BIB_ENTRIES = 500;

/**
 * Imports papers from a .bib file.
 *
 * Identity is decided before anything is written: an entry whose DOI or arXiv id already
 * belongs to a paper is shown as existing and left unchecked, because the alternative —
 * creating a second record — is exactly what the registry's identity rules refuse. Entries
 * without identifiers cannot be matched automatically and say "新条目" honestly.
 */
export function BibTeXImportDialog({ open, papers, onClose, onImport }: BibTeXImportDialogProps) {
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [skipped, setSkipped] = useState<BibtexSkipped[]>([]);
  const [fileName, setFileName] = useState('');
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // The dialog's body unmounts on close, but its preview state lives here. Every close path
  // goes through this reset, so a reopened dialog starts from the file picker rather than
  // from the last file's stale rows and checkmarks.
  const reset = (): void => {
    setRows(null);
    setSkipped([]);
    setFileName('');
    setChecked(new Set());
    setError(null);
  };
  const close = (): void => {
    reset();
    onClose();
  };

  const read = async (file: File): Promise<void> => {
    setError(null);
    setRows(null);
    setSkipped([]);
    setFileName('');
    setChecked(new Set());
    if (file.size > MAX_BIB_BYTES) {
      setError('这个文件超过 5 MB，无法一次导入；请拆分后再试。');
      return;
    }
    try {
      const text = await file.text();
      const result = parseBibtex(text);
      if (result.entries.length > MAX_BIB_ENTRIES) {
        setError(
          `这个文件有 ${String(result.entries.length)} 条记录，单次最多导入 ${String(MAX_BIB_ENTRIES)} 条；请拆分后再试。`,
        );
        return;
      }
      const nextRows = result.entries.map((entry) => ({
        entry,
        existing: findExisting(papers, entry),
      }));
      setRows(nextRows);
      setSkipped(result.skipped);
      setFileName(file.name);
      // Existing papers and within-file duplicates are both off by default: importing either
      // would either duplicate a record or fail the registry's identity rules.
      setChecked(
        new Set(
          nextRows
            .map((row, index) =>
              row.existing === null && row.entry.duplicate === undefined ? index : -1,
            )
            .filter((index) => index >= 0),
        ),
      );
    } catch {
      setError('这个文件读不出来，请确认它是一个文本格式的 .bib 文件。');
    }
  };

  const importable = rows ?? [];
  const selected = importable.filter((_, index) => checked.has(index));
  const toggle = (index: number): void => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const commit = (): void => {
    if (selected.length === 0) return;
    onImport(
      selected.map(({ entry }) => ({
        title: entry.title,
        authors: entry.authors,
        ...(entry.year === undefined ? {} : { year: entry.year }),
        doi: entry.doi ?? null,
        arxivId: entry.arxivId ?? null,
      })),
    );
    reset();
    onClose();
  };

  return (
    <Dialog open={open} title="从 BibTeX 导入" onClose={close}>
      <div className="bibtex-import">
        <label className="field">
          <span className="field-label">选择 .bib 文件</span>
          <input
            className="input"
            type="file"
            accept=".bib,.txt,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void read(file);
              // Re-selecting the same path must still fire: the value, not the file, is what
              // the browser remembers between picks.
              event.currentTarget.value = '';
            }}
          />
        </label>

        {error !== null && (
          <p className="hint hint-error" role="alert">
            {error}
          </p>
        )}

        {rows === null ? (
          <p className="hint">
            由 Zotero、EndNote
            或出版商导出的参考文献文件都可以。每一条会先列出，你勾选之后才写入论文库。
          </p>
        ) : (
          <>
            <p className="hint">
              {fileName}：{String(rows.length)} 条可导入
              {skipped.length > 0 ? `，${String(skipped.length)} 条无法解析（已跳过）` : ''}。
            </p>
            {skipped.length > 0 && (
              <ul className="bibtex-skipped">
                {skipped.map((item, index) => (
                  <li key={`${item.key}-${String(index)}`}>
                    「{item.key === '' ? '（无键）' : item.key}」：{item.reason}
                  </li>
                ))}
              </ul>
            )}
            {rows.length === 0 ? (
              <p className="hint">文件里没有可识别的条目。</p>
            ) : (
              <ul className="bibtex-list">
                {importable.map(({ entry, existing }, index) => (
                  <li key={`${entry.key}-${String(index)}`} className="bibtex-item">
                    <label className="bibtex-choice">
                      <input
                        type="checkbox"
                        checked={checked.has(index)}
                        disabled={existing !== null || entry.duplicate !== undefined}
                        onChange={() => {
                          toggle(index);
                        }}
                      />
                      <span className="bibtex-copy">
                        <span className="bibtex-title">{entry.title}</span>
                        <span className="bibtex-meta">
                          <FileText size={12} aria-hidden="true" />
                          {entry.authors.length > 0 ? `${entry.authors[0]} 等 · ` : ''}
                          {entry.year === undefined ? '年份未知' : String(entry.year)}
                          {existing !== null
                            ? ` · 库里已有《${existing.title}》`
                            : entry.duplicate !== undefined
                              ? ` · 与文件内「${entry.duplicate.ofKey}」的 ${entry.duplicate.field === 'doi' ? 'DOI' : 'arXiv ID'} 重复`
                              : ' · 新条目'}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.length === 0}
            onClick={commit}
          >
            导入 {selected.length > 0 ? `${String(selected.length)} 篇` : ''}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** The paper that already owns this entry's DOI or arXiv id, if any. */
function findExisting(papers: Readonly<Record<string, Paper>>, entry: BibtexEntry): Paper | null {
  const registered = Object.values(papers);
  if (entry.doi !== undefined) {
    const byDoi = registered.find((paper) => paper.doi === entry.doi);
    if (byDoi !== undefined) return byDoi;
  }
  if (entry.arxivId !== undefined) {
    const byArxiv = registered.find((paper) => paper.arxivId === entry.arxivId);
    if (byArxiv !== undefined) return byArxiv;
  }
  return null;
}

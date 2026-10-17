import katex from 'katex';
import { Copy } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * One formula, typeset by KaTeX.
 *
 * Three things this component is careful about:
 *
 * - **Nothing is executed.** KaTeX is handed a string and builds its own DOM from it with
 *   `trust: false`, which disables `\href`, `\includegraphics`, `\htmlClass` and the other
 *   commands that can reach outside a formula. The `dangerouslySetInnerHTML` below carries
 *   KaTeX's own output and nothing else; the model's text never becomes markup on its own.
 * - **Bad LaTeX degrades to text, not to an error box.** A formula KaTeX cannot read is shown as
 *   the LaTeX source in a `<code>` element, visibly un-typeset — the reader can still see what
 *   the model wrote.
 * - **The source is always available.** The LaTeX is the element's title, and a display formula
 *   carries a copy button, because the formula is often the part someone wants to take away.
 */
export function AiMath({ latex, display }: { latex: string; display: boolean }) {
  const [copied, setCopied] = useState(false);

  const rendered = useMemo(() => {
    try {
      return katex.renderToString(latex, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
      });
    } catch {
      return null;
    }
  }, [latex, display]);

  if (rendered === null) {
    return (
      <code className="ai-math-fallback" title="这段公式无法渲染，显示 LaTeX 原文">
        {display ? `$$${latex}$$` : `$${latex}$`}
      </code>
    );
  }

  const typeset = (
    <span
      className={display ? 'ai-math ai-math-display' : 'ai-math'}
      data-latex={latex}
      title={latex}
      // KaTeX's own output, generated from `latex` with `trust: false`. Never model HTML.
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  );

  if (!display) return typeset;

  return (
    <span className="ai-math-block">
      {typeset}
      <button
        type="button"
        className="ai-math-copy"
        aria-label="复制这段 LaTeX"
        title={copied ? '已复制' : '复制这段 LaTeX'}
        onClick={() => {
          void navigator.clipboard?.writeText(latex);
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        }}
      >
        <Copy size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

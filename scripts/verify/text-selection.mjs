/* global document, window */

/**
 * Driving text selection in a verification script.
 *
 * The reader's own text layer is the thing under test, so these helpers work on it directly:
 * they address text by span index and character offset (which is how the layer is built) rather
 * than by guessing pixel coordinates, and they report the browser's own geometry back.
 */

// Everything sent to `page.evaluate` has to be self-contained, so the DOM walking below is
// written out inside each evaluate rather than shared through a module-level helper.

export function pageTextOf(page, pageNumber) {
  return page.evaluate(
    ({ number }) => {
      const root = document.querySelector(`.pdf-page[data-page="${number}"]`);
      return root?.querySelector('.textLayer')?.textContent ?? '';
    },
    { number: pageNumber },
  );
}

export function spanTexts(page, pageNumber) {
  return page.evaluate(
    ({ number }) => {
      const root = document.querySelector(`.pdf-page[data-page="${number}"]`);
      if (root === null) return [];
      return [...root.querySelectorAll('.textLayer span')]
        .filter((span) => span.querySelector('span') === null)
        .map((span) => span.textContent ?? '');
    },
    { number: pageNumber },
  );
}

/**
 * Selects from one span/offset to another, the way a drag across lines would, and returns the
 * selected text and the boxes the browser reports for it.
 */
export function selectSpans(page, pageNumber, start, end) {
  return page.evaluate(
    ({ number, from, to }) => {
      const spans = pageSpansFor(number);
      const startSpan = spans[from.span];
      const endSpan = spans[to.span];
      if (startSpan === undefined || endSpan === undefined) return null;

      const pointInSpan = (span, offset) => {
        let remaining = offset;
        for (const node of span.childNodes) {
          const length = node.textContent?.length ?? 0;
          if (remaining <= length) return { node, offset: Math.max(0, remaining) };
          remaining -= length;
        }
        const last = span.lastChild;
        return last === null
          ? { node: span, offset: 0 }
          : { node: last, offset: last.textContent.length };
      };

      const range = document.createRange();
      const first = pointInSpan(startSpan, from.offset);
      const last = pointInSpan(endSpan, to.offset);
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const boxes = [...range.getClientRects()]
        .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
        .map((rect) => ({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        }));
      return { text: selection?.toString() ?? '', boxes };

      function pageSpansFor(number) {
        const root = document.querySelector(`.pdf-page[data-page="${number}"]`);
        if (root === null) return [];
        return [...root.querySelectorAll('.textLayer span')].filter(
          (span) => span.querySelector('span') === null,
        );
      }
    },
    { number: pageNumber, from: start, to: end },
  );
}

export function clearSelection(page) {
  return page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
  });
}

/** The union of a list of boxes, or null when there are none. */
export function unionBox(boxes) {
  if (boxes.length === 0) return null;
  return boxes.reduce(
    (union, box) => ({
      left: Math.min(union.left, box.left),
      top: Math.min(union.top, box.top),
      right: Math.max(union.right, box.right),
      bottom: Math.max(union.bottom, box.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

/** The boxes of the highlights the reader drew for one annotation. */
export function highlightBoxes(page, annotationId) {
  return page.evaluate((id) => {
    const elements = [...document.querySelectorAll(`.pdf-highlight[data-annotation="${id}"]`)];
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
  }, annotationId);
}

/** How far apart two boxes are at their worst edge, in pixels. */
export function boxDistance(one, other) {
  if (one === null || other === null) return Infinity;
  return Math.max(
    Math.abs(one.left - other.left),
    Math.abs(one.top - other.top),
    Math.abs(one.right - other.right),
    Math.abs(one.bottom - other.bottom),
  );
}

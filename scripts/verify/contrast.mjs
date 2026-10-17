/* global document, window, getComputedStyle, NodeFilter, OffscreenCanvas, createImageBitmap, requestAnimationFrame */

// Text is made transparent so the screenshot shows only what sits *behind* it: the real
// glass, blur and gradient pools. Transitions and animations are frozen at their end state.
const NEUTRALIZE = `
  *, *::before, *::after {
    color: transparent !important; text-shadow: none !important; caret-color: transparent !important;
    transition: none !important; animation: none !important;
  }
  ::placeholder { color: transparent !important; }
  svg, img { visibility: hidden !important; }`;

function collectTargets() {
  const targets = [];

  // An open modal dialog or the narrow-window scrim deliberately dims what sits behind it, and
  // WCAG does not ask dimmed content to meet contrast. Sampling it anyway would also report the
  // overlay's own pixels as the background — the welcome line behind the create dialog measures
  // against that dialog's teal primary button — which is not a ratio anyone sees. Skip covered
  // text, and pass the count back so the report can say how much was skipped.
  const modal = document.querySelector('dialog[open]');
  const scrim = document.querySelector('.scrim');
  const covered = (element) => {
    if (modal !== null && !modal.contains(element)) return 'modal';
    if (scrim !== null && element.closest('.sidebar') === null) return 'scrim';
    return null;
  };
  const skipped = { modal: 0, scrim: 0 };

  const label = (element, text) => {
    const name = String(element.className).split(' ')[0];
    return `${element.tagName.toLowerCase()}${name ? `.${name}` : ''} "${text.slice(0, 24)}"`;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    const element = node.parentElement;
    if (!text || !element) continue;
    if (element.closest('[inert], .sr-only, script, style, dialog:not([open])')) continue;
    const overlay = covered(element);
    if (overlay !== null) {
      skipped[overlay] += 1;
      continue;
    }
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || Number(style.opacity) < 0.05) continue;
    // Text painted in a fully transparent colour is not text anyone reads: pdf.js builds its
    // selectable text layer that way, with the glyphs drawn on the canvas underneath. There is
    // no foreground colour to measure, and measuring the r,g,b of "transparent" would invent a
    // black-on-the-background ratio for a layer that is deliberately invisible.
    const channels =
      /^rgba?\((.*)\)$/
        .exec(style.color)?.[1]
        .split(/[\s,/]+/)
        .filter(Boolean) ?? [];
    if (channels.length === 4 && Number(channels[3]) === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const text_ = range.getBoundingClientRect();
    const own = element.getBoundingClientRect();
    // A run that is partly scrolled out of its panel is measured only over the part a reader can
    // actually see. Measuring the clipped remainder samples whatever is behind the panel edge,
    // which is not a ratio anyone is looking at — and it reported a false failure once already.
    let left = Math.max(text_.left, own.left, 0);
    let top = Math.max(text_.top, own.top, 0);
    let right = Math.min(text_.right, own.right, window.innerWidth);
    let bottom = Math.min(text_.bottom, own.bottom, window.innerHeight);
    for (let node_ = element; node_ !== null; node_ = node_.parentElement) {
      const box = getComputedStyle(node_);
      if (!/(auto|scroll|hidden)/.test(box.overflowX + box.overflowY)) continue;
      const area = node_.getBoundingClientRect();
      left = Math.max(left, area.left);
      top = Math.max(top, area.top);
      right = Math.min(right, area.right);
      bottom = Math.min(bottom, area.bottom);
    }
    if (right - left < 1 || bottom - top < 1) continue;
    targets.push({
      label: label(element, text),
      x: left,
      y: top,
      w: right - left,
      h: bottom - top,
      color: style.color,
      size: parseFloat(style.fontSize),
      weight: Number(style.fontWeight),
    });
  }
  for (const input of document.querySelectorAll('input[placeholder]')) {
    if (input.value !== '' || input.closest('[inert], dialog:not([open])')) continue;
    const overlay = covered(input);
    if (overlay !== null) {
      skipped[overlay] += 1;
      continue;
    }
    const box = input.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    targets.push({
      label: label(input, `placeholder: ${input.placeholder}`),
      x: box.left + 10,
      y: box.top + 8,
      w: Math.max(1, box.width - 20),
      h: Math.max(1, box.height - 16),
      color: getComputedStyle(input, '::placeholder').color,
      size: parseFloat(getComputedStyle(input).fontSize),
      weight: 400,
    });
  }
  return { targets, skipped };
}

async function measure({ png, targets }) {
  const bitmap = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${png}`)).blob(),
  );
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const scale = bitmap.width / window.innerWidth;

  const linear = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (r, g, b) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const parse = (css) => {
    const nums = css.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number);
    const unit = css.startsWith('color(') ? 255 : 1;
    return { r: nums[0] * unit, g: nums[1] * unit, b: nums[2] * unit, alpha: nums[3] ?? 1 };
  };

  const results = [];
  for (const t of targets) {
    const x = Math.max(0, Math.floor(t.x * scale));
    const y = Math.max(0, Math.floor(t.y * scale));
    const w = Math.max(1, Math.min(bitmap.width - x, Math.ceil(t.w * scale)));
    const h = Math.max(1, Math.min(bitmap.height - y, Math.ceil(t.h * scale)));
    const { data } = context.getImageData(x, y, w, h);
    const lums = [];
    for (let i = 0; i < data.length; i += 4)
      lums.push(luminance(data[i], data[i + 1], data[i + 2]));
    lums.sort((a, b) => a - b);
    const darkest = lums[Math.floor(lums.length * 0.05)];
    const lightest = lums[Math.floor(lums.length * 0.95)];
    const fg = parse(t.color);
    const fgLum = luminance(fg.r, fg.g, fg.b);
    // Worst case over the box: the text can sit on either extreme of the background.
    const worst = Math.min(ratio(fgLum, darkest), ratio(fgLum, lightest));
    const large = t.size >= 24 || (t.size >= 18.66 && t.weight >= 700);
    results.push({
      label: `${t.label} @${String(Math.round(t.x))},${String(Math.round(t.y))}`,
      ratio: Math.round(worst * 100) / 100,
      need: large ? 3 : 4.5,
      translucent: fg.alpha < 1,
    });
  }
  results.sort((a, b) => a.ratio - b.ratio);
  return {
    checked: results.length,
    failures: results.filter((r) => r.ratio < r.need),
    lowest: results.slice(0, 4),
  };
}

/** Measures WCAG contrast of every visible, unobscured text run against the pixels behind it. */
export async function auditContrast(page) {
  const { targets, skipped } = await page.evaluate(collectTargets);
  const style = await page.addStyleTag({ content: NEUTRALIZE });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const png = await page.screenshot({ type: 'png' });
  await style.evaluate((node) => node.remove());
  const measured = await page.evaluate(measure, { png: png.toString('base64'), targets });
  return { ...measured, skipped };
}

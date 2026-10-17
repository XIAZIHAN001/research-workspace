/**
 * Recolouring a rendered PDF page for warm paper and dark reading.
 *
 * The rule this module refuses to break: **never invert the whole canvas.** A photographic
 * figure, a heat map and a line plot all carry meaning in their colours, and a global
 * `invert(1)` or a naive "dark pixels become light" pass rewrites that meaning silently.
 *
 * What it does instead is decide per pixel, by chroma:
 *
 * - a pixel that is close to neutral carries ink or paper — the two things that *should*
 *   change with the reading mode — so it is mapped through a curve from ink to paper;
 * - a pixel with real chroma belongs to a figure, so it is left exactly as the page drew it.
 *
 * That covers the ordinary research page well: black text, white paper, coloured plots. It does
 * not cover a greyscale photograph, whose pixels are neutral by definition — so the caller gets
 * a measurement back, and a page that is mostly dark is reported as image-heavy rather than
 * quietly turned into a negative.
 *
 * Nothing here touches the PDF bytes, the text layer, or the highlights drawn above the canvas.
 */

export type PaperMode = 'auto' | 'original' | 'warm' | 'dark';
export type PaperPalette = 'original' | 'warm' | 'dark';

export { PAPER_STORAGE_KEY } from '../../app/config';

export const PAPER_MODE_LABEL: Record<PaperMode, string> = {
  auto: '跟随外观',
  original: '原始',
  warm: '暖纸',
  dark: '深灰',
};

export function parsePaperMode(raw: string | null): PaperMode {
  return raw === 'original' || raw === 'warm' || raw === 'dark' ? raw : 'auto';
}

/**
 * Which palette to render with.
 *
 * `auto` follows the application theme, so a reader who switched the whole app to dark gets a
 * dark page instead of a white rectangle glowing in the middle of it. A manual choice wins and
 * is remembered.
 */
export function resolvePaperMode(pref: PaperMode, appTheme: 'light' | 'dark'): PaperPalette {
  if (pref === 'auto') return appTheme === 'dark' ? 'dark' : 'warm';
  return pref;
}

/** Ink and paper for each palette, in sRGB. `original` is handled by not running at all. */
export const PALETTES: Record<Exclude<PaperPalette, 'original'>, { ink: RGB; paper: RGB }> = {
  // A soft, low-saturation paper. Not a yellow filter: the temperature is in the paper only,
  // and the ink stays near-black so text keeps its contrast.
  warm: { ink: [26, 24, 22], paper: [246, 241, 230] },
  // Dark paper rather than a dark shell around white pages. The ink is a softened light grey:
  // white on dark at body size is the combination that glares.
  dark: { ink: [214, 217, 222], paper: [35, 38, 43] },
};

type RGB = readonly [number, number, number];

/**
 * Above this chroma (max − min, out of 255) a pixel is treated as colour and left alone.
 *
 * 24 is deliberately generous: anti-aliased black text on white has a chroma of a few units,
 * and the lightest tint of a coloured chart is far above 24. Measured on the two real papers
 * used in this project, the whole of the black text fell below 12.
 */
const CHROMA_THRESHOLD = 24;

/**
 * A page whose dark pixels cover more than this share is image-heavy.
 *
 * Text pages measure 3–15% dark; a page dominated by a photograph or a filled plot measures
 * far more. Passing the threshold means the neutral-pixel rule would be recolouring a picture,
 * so the page is left in its original colours and the interface says so.
 */
const IMAGE_HEAVY_DARK_SHARE = 0.35;

/**
 * Below this many pixels the buffer is not a page, so the image-heavy rule does not apply.
 *
 * A real page is at least ~13,000 pixels even at the smallest readable scale. The floor keeps
 * the judgement honest for tiny inputs (a swatch, a test buffer) instead of calling a two-pixel
 * sample a photograph.
 */
const MIN_PAGE_PIXELS = 4096;

const DARK_PIXEL = 96;

export interface RecolorReport {
  /** `recoloured`, or `image-heavy` when the page was left alone. */
  outcome: 'recoloured' | 'image-heavy';
  /** Share of pixels below `DARK_PIXEL` in luminance, before any change. */
  darkShare: number;
  /** Share of pixels above the chroma threshold. */
  colourShare: number;
  pixels: number;
}

/** Rec. 709 luminance, 0–255. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mix(ink: number, paper: number, t: number): number {
  return ink + (paper - ink) * t;
}

/**
 * The neutral ramp, as a 256-entry lookup table: index = luminance, value = the target level
 * for each channel. Built once per palette, so the per-pixel work is a few array reads.
 */
function buildRamp(palette: { ink: RGB; paper: RGB }): Uint8ClampedArray {
  const table = new Uint8ClampedArray(256 * 3);
  for (let level = 0; level < 256; level += 1) {
    // Snap the ends: a page background is rarely exactly 255, and a background that is five
    // units off the stylesheet colour shows as a seam wherever the canvas meets the page box.
    const t = level >= 250 ? 1 : level <= 5 ? 0 : Math.pow(1 - level / 255, 0.9);
    const towardInk = level >= 250 ? 0 : level <= 5 ? 1 : t;
    table[level * 3] = mix(palette.paper[0], palette.ink[0], towardInk);
    table[level * 3 + 1] = mix(palette.paper[1], palette.ink[1], towardInk);
    table[level * 3 + 2] = mix(palette.paper[2], palette.ink[2], towardInk);
  }
  return table;
}

const RAMPS = new Map<string, Uint8ClampedArray>();

function rampFor(palette: Exclude<PaperPalette, 'original'>): Uint8ClampedArray {
  const cached = RAMPS.get(palette);
  if (cached !== undefined) return cached;
  const built = buildRamp(PALETTES[palette]);
  RAMPS.set(palette, built);
  return built;
}

/**
 * Measures a page before deciding whether it can be recoloured.
 *
 * Kept separate from the transform so the caller can report why a page was left alone.
 */
export function measurePage(data: Uint8ClampedArray): {
  darkShare: number;
  colourShare: number;
  pixels: number;
} {
  const pixels = Math.floor(data.length / 4);
  if (pixels === 0) return { darkShare: 0, colourShare: 0, pixels: 0 };
  let dark = 0;
  let colour = 0;
  // Every 4th pixel is plenty for a share: sampling keeps a 5-megapixel page cheap to measure.
  const step = pixels > 250_000 ? 4 : 1;
  let sampled = 0;
  for (let index = 0; index < data.length; index += 4 * step) {
    const r = data[index] ?? 0;
    const g = data[index + 1] ?? 0;
    const b = data[index + 2] ?? 0;
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    if (high - low > CHROMA_THRESHOLD) colour += 1;
    else if (luminance(r, g, b) < DARK_PIXEL) dark += 1;
    sampled += 1;
  }
  return { darkShare: dark / sampled, colourShare: colour / sampled, pixels };
}

/**
 * Recolours the page in place. Returns what it did, including when it declined.
 *
 * Declining is the important half: a page that is mostly dark is a page with a picture on it,
 * and leaving it alone is the only answer that does not rewrite the picture's meaning.
 */
export function recolorImageData(data: Uint8ClampedArray, palette: PaperPalette): RecolorReport {
  const measured = measurePage(data);
  if (palette === 'original') return { outcome: 'recoloured', ...measured };
  if (measured.pixels >= MIN_PAGE_PIXELS && measured.darkShare > IMAGE_HEAVY_DARK_SHARE) {
    return { outcome: 'image-heavy', ...measured };
  }

  const ramp = rampFor(palette);
  for (let index = 0; index < data.length; index += 4) {
    // A transparent pixel only happens if the caller did not ask pdf.js to paint a background;
    // leave it transparent rather than inventing paper behind it.
    if ((data[index + 3] ?? 255) === 0) continue;
    const r = data[index] ?? 0;
    const g = data[index + 1] ?? 0;
    const b = data[index + 2] ?? 0;
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    // Colour belongs to a figure. Untouched, in both palettes.
    if (high - low > CHROMA_THRESHOLD) continue;
    const level = Math.round(luminance(r, g, b));
    data[index] = ramp[level * 3] ?? 0;
    data[index + 1] = ramp[level * 3 + 1] ?? 0;
    data[index + 2] = ramp[level * 3 + 2] ?? 0;
  }
  return { outcome: 'recoloured', ...measured };
}

/** The page background behind a recoloured canvas, so no white gutter shows at the edges. */
export function paperBackground(palette: PaperPalette): string {
  if (palette === 'original') return '#ffffff';
  const { paper } = PALETTES[palette];
  const hex = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${hex(paper[0])}${hex(paper[1])}${hex(paper[2])}`;
}

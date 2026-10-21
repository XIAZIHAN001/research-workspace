import { describe, expect, it } from 'vitest';
import {
  measurePage,
  PALETTES,
  paperBackground,
  parsePaperMode,
  recolorImageData,
  recolorImageDataAsync,
  resolvePaperMode,
} from './paperTheme';

/** A pixel buffer from [r,g,b,a] tuples. */
function buffer(
  pixels: readonly (readonly [number, number, number, number?])[],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((pixel, index) => {
    data[index * 4] = pixel[0];
    data[index * 4 + 1] = pixel[1];
    data[index * 4 + 2] = pixel[2];
    data[index * 4 + 3] = pixel[3] ?? 255;
  });
  return data;
}

const at = (data: Uint8ClampedArray, index: number): [number, number, number] => [
  data[index * 4] ?? 0,
  data[index * 4 + 1] ?? 0,
  data[index * 4 + 2] ?? 0,
];

/** A neutral page: mostly white with a few black pixels, like text on paper. */
function textPage(): Uint8ClampedArray {
  const pixels: [number, number, number][] = [];
  for (let index = 0; index < 5000; index += 1) pixels.push([255, 255, 255]);
  for (let index = 0; index < 500; index += 1) pixels.push([0, 0, 0]);
  return buffer(pixels);
}

describe('resolvePaperMode', () => {
  it('follows the app theme until the reader chooses', () => {
    expect(resolvePaperMode('auto', 'light')).toBe('warm');
    expect(resolvePaperMode('auto', 'dark')).toBe('dark');
  });

  it('lets a manual choice win over the app theme', () => {
    expect(resolvePaperMode('original', 'dark')).toBe('original');
    expect(resolvePaperMode('warm', 'dark')).toBe('warm');
    expect(resolvePaperMode('dark', 'light')).toBe('dark');
  });

  it('treats anything unrecognised as auto, so a stale value cannot pin a mode', () => {
    expect(parsePaperMode(null)).toBe('auto');
    expect(parsePaperMode('sepia')).toBe('auto');
    expect(parsePaperMode('dark')).toBe('dark');
  });
});

describe('recolorImageData: what changes', () => {
  it('turns paper into the palette paper and ink into the palette ink', () => {
    const data = buffer([
      [255, 255, 255],
      [0, 0, 0],
    ]);
    recolorImageData(data, 'dark');
    expect(at(data, 0)).toEqual(PALETTES.dark.paper);
    expect(at(data, 1)).toEqual(PALETTES.dark.ink);
  });

  it('keeps grey levels distinguishable instead of collapsing them', () => {
    // The tone is inverted — that is what dark paper means — but a grey table rule must not
    // land on the same level as the paper and disappear.
    const data = buffer([
      [128, 128, 128],
      [200, 200, 200],
      [60, 60, 60],
    ]);
    recolorImageData(data, 'dark');
    const mid = at(data, 0)[0];
    const lightGrey = at(data, 1)[0];
    const darkGrey = at(data, 2)[0];
    const paper = PALETTES.dark.paper[0];
    const ink = PALETTES.dark.ink[0];
    for (const level of [mid, lightGrey, darkGrey]) {
      expect(level).toBeGreaterThan(paper);
      expect(level).toBeLessThan(ink);
    }
    // Inverted order, and no two greys landing on the same level.
    expect(lightGrey).toBeLessThan(mid);
    expect(mid).toBeLessThan(darkGrey);
  });

  it('leaves a coloured pixel exactly as the page drew it', () => {
    // A saturated red curve and a saturated blue bar: both are data, not decoration.
    const data = buffer([
      [220, 30, 40],
      [40, 60, 200],
      [250, 200, 40],
    ]);
    recolorImageData(data, 'dark');
    expect(at(data, 0)).toEqual([220, 30, 40]);
    expect(at(data, 1)).toEqual([40, 60, 200]);
    expect(at(data, 2)).toEqual([250, 200, 40]);
  });

  it('keeps a faintly tinted paper as paper', () => {
    const data = buffer([[252, 250, 246]]);
    recolorImageData(data, 'dark');
    expect(at(data, 0)).toEqual(PALETTES.dark.paper);
  });

  it('never paints over a transparent pixel', () => {
    const data = buffer([[255, 255, 255, 0]]);
    recolorImageData(data, 'dark');
    expect(data[3]).toBe(0);
    expect(at(data, 0)).toEqual([255, 255, 255]);
  });

  it('maps an anti-aliased ink edge to ink while keeping its alpha', () => {
    // The recoloured modes render on a transparent canvas, so text edges arrive as black at
    // partial alpha. Mapping the colour but keeping the alpha is what makes recoloured text
    // as smooth as the original — the alpha does the blending, not the rgb.
    const data = buffer([[0, 0, 0, 128]]);
    recolorImageData(data, 'dark');
    expect(at(data, 0)).toEqual(PALETTES.dark.ink);
    expect(data[3]).toBe(128);
  });

  it('warms the paper without tinting the ink', () => {
    const data = buffer([
      [255, 255, 255],
      [10, 10, 10],
    ]);
    recolorImageData(data, 'warm');
    const paper = at(data, 0);
    const ink = at(data, 1);
    expect(paper).toEqual(PALETTES.warm.paper);
    // Warm means a warm paper, not a sepia photograph of text.
    expect(ink[0] - ink[2]).toBeLessThanOrEqual(6);
  });

  it('does nothing at all in the original mode', () => {
    const data = buffer([
      [18, 18, 18],
      [255, 255, 255],
    ]);
    const before = [...data];
    const report = recolorImageData(data, 'original');
    expect([...data]).toEqual(before);
    expect(report.outcome).toBe('recoloured');
  });
});

describe('recolorImageData: when it refuses', () => {
  it('declines a page that is mostly dark, because it has a picture on it', () => {
    // A greyscale photograph: neutral by definition, so the chroma rule cannot protect it.
    // Full page size, because the judgement is only made about buffers big enough to be a page.
    const pixels: [number, number, number][] = [];
    for (let index = 0; index < 4000; index += 1) pixels.push([40, 40, 40]);
    for (let index = 0; index < 1000; index += 1) pixels.push([240, 240, 240]);
    const data = buffer(pixels);
    const before = [...data];

    const report = recolorImageData(data, 'dark');
    expect(report.outcome).toBe('image-heavy');
    expect(report.darkShare).toBeCloseTo(0.8, 2);
    // The whole point: the page is left exactly as rendered.
    expect([...data]).toEqual(before);
  });

  it('recolours an ordinary text page', () => {
    const report = recolorImageData(textPage(), 'dark');
    expect(report.outcome).toBe('recoloured');
    expect(report.darkShare).toBeCloseTo(0.09, 2);
  });

  it('does not count a dark coloured pixel toward the image-heavy share twice', () => {
    // Dark blue is chroma, not ink: a page full of a dark navy background with coloured data
    // is still a figure page, and the colour share says so without the dark share deciding.
    const pixels: [number, number, number][] = [];
    for (let index = 0; index < 50; index += 1) pixels.push([20, 30, 90]);
    for (let index = 0; index < 50; index += 1) pixels.push([255, 255, 255]);
    const measured = measurePage(buffer(pixels));
    expect(measured.colourShare).toBeCloseTo(0.5, 2);
    expect(measured.darkShare).toBe(0);
  });
});

describe('recolorImageDataAsync', () => {
  it('reaches the same result as the synchronous pass', async () => {
    const sync = textPage();
    const async_ = textPage();
    expect(recolorImageData(sync, 'dark').outcome).toBe('recoloured');
    const report = await recolorImageDataAsync(async_, 'dark');
    expect(report.outcome).toBe('recoloured');
    expect([...async_]).toEqual([...sync]);
  });

  it('stops early and says so when the render was cancelled', async () => {
    const controller = new AbortController();
    // Big enough to need several batches, so the abort lands inside the loop rather than before it.
    const pixels: [number, number, number][] = [];
    for (let index = 0; index < 3_000_000; index += 1) pixels.push([255, 255, 255]);
    const data = buffer(pixels);
    controller.abort();
    const report = await recolorImageDataAsync(data, 'dark', controller.signal);
    expect(report.outcome).toBe('declined');
    // Nothing was drawn over, because the caller blits nothing for a declined page.
    expect(at(data, 0)).toEqual([255, 255, 255]);
  });

  it('still declines an image-heavy page without touching it', async () => {
    const pixels: [number, number, number][] = [];
    for (let index = 0; index < 4000; index += 1) pixels.push([40, 40, 40]);
    for (let index = 0; index < 1000; index += 1) pixels.push([240, 240, 240]);
    const data = buffer(pixels);
    const before = [...data];
    expect((await recolorImageDataAsync(data, 'dark')).outcome).toBe('image-heavy');
    expect([...data]).toEqual(before);
  });
});

describe('measurePage', () => {
  it('returns zeroes for an empty buffer rather than dividing by zero', () => {
    expect(measurePage(new Uint8ClampedArray(0))).toEqual({
      darkShare: 0,
      colourShare: 0,
      pixels: 0,
    });
  });

  it('reports shares that add up to what was measured', () => {
    const data = buffer([
      [255, 255, 255],
      [0, 0, 0],
      [200, 30, 30],
      [120, 120, 120],
    ]);
    const measured = measurePage(data);
    expect(measured.pixels).toBe(4);
    expect(measured.darkShare).toBeCloseTo(0.25, 2);
    expect(measured.colourShare).toBeCloseTo(0.25, 2);
  });

  it('ignores fully transparent pixels, which are paper and not ink', () => {
    // A transparent-rendered page is mostly transparent: if transparency counted as dark,
    // every such page would be judged image-heavy and never recoloured.
    const data = buffer([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [255, 255, 255],
    ]);
    const measured = measurePage(data);
    expect(measured.darkShare).toBe(0);
    expect(measured.colourShare).toBe(0);
  });
});

describe('paperBackground', () => {
  it('is the palette paper as a CSS colour, and pure white for original', () => {
    expect(paperBackground('original')).toBe('#ffffff');
    expect(paperBackground('dark')).toBe('#23262b');
    expect(paperBackground('warm')).toBe('#f6f1e6');
  });
});

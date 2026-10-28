// Biome colours that blend across the boundaries of the Whittaker grid, so a small change in rainfall or temperature
// gives a small change in colour instead of a hard edge. The land lookup grid is the classifier's own answer, blurred.

import { ALPINE_M, BIOMES, SHELF_DEPTH_M, SNOW_LINE_M, biomeIndex, classifyBiome } from '../sim/biomes';

type Rgb = readonly [number, number, number];

const T_MIN = -30, T_STEP = 0.5, T_COLS = 141; // -30 to 40 C
const P_MIN = 25, P_ROWS = 193, P_PER_OCTAVE = 24; // 25 to 6,400 mm, log scale
/** Blur widths: degrees C, and octaves of rainfall (the boundaries lie 1.2-1.5 octaves apart). */
const T_SIGMA = 3, P_SIGMA = 0.4;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const color = (key: Parameters<typeof biomeIndex>[0]): Rgb => BIOMES[biomeIndex(key)]!.color;

/** Gaussian-like blur along one axis by three box passes of the given radius (in cells). */
function blurAxis(src: Float32Array, w: number, h: number, channels: number, axis: 'x' | 'y', sigma: number): Float32Array {
  const radius = Math.max(1, Math.round(sigma * 1.2));
  let a: Float32Array = src, b: Float32Array = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < channels; c++) {
          let sum = 0, n = 0;
          for (let d = -radius; d <= radius; d++) {
            const xx = axis === 'x' ? clamp(x + d, 0, w - 1) : x, yy = axis === 'y' ? clamp(y + d, 0, h - 1) : y;
            sum += a[(yy * w + xx) * channels + c]!;
            n++;
          }
          b[(y * w + x) * channels + c] = sum / n;
        }
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

let grid: Float32Array<ArrayBufferLike> | null = null;
/** The blurred land colours over (temperature, log rainfall), built once. */
function landGrid(): Float32Array {
  if (grid) return grid;
  const raw = new Float32Array(T_COLS * P_ROWS * 3);
  for (let r = 0; r < P_ROWS; r++) {
    const rain = P_MIN * 2 ** (r / P_PER_OCTAVE);
    for (let c = 0; c < T_COLS; c++) {
      const biome = classifyBiome(T_MIN + c * T_STEP, rain, 100); // low land: the climate decides
      raw.set(BIOMES[biomeIndex(biome)]!.color, (r * T_COLS + c) * 3);
    }
  }
  let g = blurAxis(raw, T_COLS, P_ROWS, 3, 'x', T_SIGMA / T_STEP);
  g = blurAxis(g, T_COLS, P_ROWS, 3, 'y', P_SIGMA * P_PER_OCTAVE);
  grid = g;
  return g;
}

/** Biome colour at a climate and height (metres above sea level), blended smoothly across boundaries (the coastline stays sharp). */
export function blendedBiomeColor(temperatureC: number, precipitationMm: number, elevationM: number): Rgb {
  if (elevationM <= 0) return mix(color('deepSea'), color('shallowSea'), smooth(SHELF_DEPTH_M - 300, SHELF_DEPTH_M + 300, elevationM));
  const g = landGrid();
  const fx = clamp((temperatureC - T_MIN) / T_STEP, 0, T_COLS - 1);
  const fy = clamp((Math.log2(Math.max(precipitationMm, P_MIN) / P_MIN)) * P_PER_OCTAVE, 0, P_ROWS - 1);
  const x0 = Math.min(T_COLS - 2, Math.floor(fx)), y0 = Math.min(P_ROWS - 2, Math.floor(fy));
  const tx = fx - x0, ty = fy - y0;
  const at = (x: number, y: number, c: number) => g[(y * T_COLS + x) * 3 + c]!;
  let rgb: Rgb = [0, 0, 0];
  const px: number[] = [0, 0, 0];
  for (let c = 0; c < 3; c++) px[c] = (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty) + (at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx) * ty;
  rgb = [px[0]!, px[1]!, px[2]!];
  // Height overrides fade in over a few hundred metres: bare alpine ground where it is cool, then permanent ice above the snow line.
  const alpine = smooth(ALPINE_M - 400, ALPINE_M + 400, elevationM) * smooth(10, 6, temperatureC);
  rgb = mix(rgb, color('alpine'), alpine);
  return mix(rgb, color('ice'), smooth(SNOW_LINE_M - 500, SNOW_LINE_M + 500, elevationM));
}

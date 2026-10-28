import { blendedBiomeColor } from './biomeBlend';
import { ROCKS } from '../sim/crust';
import { elevationFromThickness } from '../sim/world';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const LAND_STOPS = [
  [0, 0.16, 0.5, 0.22], // lowland green
  [500, 0.4, 0.62, 0.25],
  [1200, 0.72, 0.7, 0.34], // dry plains
  [2200, 0.62, 0.48, 0.28], // hills
  [3500, 0.5, 0.36, 0.25], // mountains
  [5000, 0.6, 0.56, 0.52], // bare rock
  [6500, 0.85, 0.85, 0.88],
  [8500, 1, 1, 1], // snow
] as const;

/** Elevation palette: deep blue to shallow teal under the sea, then green lowlands to brown mountains and snow at 8.5 km. */
export function elevationColor(elevationM: number): [number, number, number] {
  if (elevationM <= 0) {
    const t = Math.min(1, -elevationM / 6000);
    return [lerp(0.2, 0.03, t), lerp(0.5, 0.12, t), lerp(0.62, 0.3, t)];
  }
  return ramp(LAND_STOPS, elevationM);
}

export function colorsFromThickness(thickness: ArrayLike<number>, seaLevel = 0): Float32Array {
  const out = new Float32Array(thickness.length * 3);
  for (let i = 0; i < thickness.length; i++) {
    const [r, g, b] = elevationColor(elevationFromThickness(thickness[i]!) - seaLevel);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/** One distinct colour per plate, spread around the hue wheel by the golden ratio. */
export function colorsFromPlates(plateOf: Int32Array): Float32Array {
  const palette = new Map<number, [number, number, number]>();
  const out = new Float32Array(plateOf.length * 3);
  for (let i = 0; i < plateOf.length; i++) {
    const id = plateOf[i]!;
    let c = palette.get(id);
    if (!c) {
      c = hslToRgb((id * 0.618033988749895) % 1, 0.55, 0.55);
      palette.set(id, c);
    }
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function ramp(stops: ReadonlyArray<readonly [number, number, number, number]>, x: number): [number, number, number] {
  if (x <= stops[0]![0]) return [stops[0]![1], stops[0]![2], stops[0]![3]];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    if (x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      return [lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
    }
  }
  const last = stops[stops.length - 1]!;
  return [last[1], last[2], last[3]];
}

const TEMPERATURE_STOPS = [
  [-30, 0.35, 0.2, 0.7], [-10, 0.25, 0.5, 0.9], [5, 0.55, 0.85, 0.9], [15, 0.9, 0.9, 0.5], [25, 0.95, 0.6, 0.2], [35, 0.8, 0.15, 0.1],
] as const;
const RAIN_STOPS = [
  [0, 0.85, 0.75, 0.5], [250, 0.85, 0.85, 0.45], [750, 0.45, 0.75, 0.35], [1500, 0.15, 0.6, 0.35], [3000, 0.1, 0.4, 0.75], [5000, 0.1, 0.15, 0.55],
] as const;

export function colorsFromTemperature(celsius: ArrayLike<number>): Float32Array {
  const out = new Float32Array(celsius.length * 3);
  for (let i = 0; i < celsius.length; i++) out.set(ramp(TEMPERATURE_STOPS, celsius[i]!), i * 3);
  return out;
}

export function colorsFromRainfall(mmPerYear: ArrayLike<number>): Float32Array {
  const out = new Float32Array(mmPerYear.length * 3);
  for (let i = 0; i < mmPerYear.length; i++) out.set(ramp(RAIN_STOPS, mmPerYear[i]!), i * 3);
  return out;
}

/** Biome colours from a frame's climate and crust thickness. */
export function colorsFromBiomes(temperature: ArrayLike<number>, precipitation: ArrayLike<number>, thickness: ArrayLike<number>, seaLevel = 0): Float32Array {
  const elevation = new Float64Array(thickness.length);
  for (let i = 0; i < elevation.length; i++) elevation[i] = elevationFromThickness(thickness[i]!) - seaLevel;
  const out = new Float32Array(elevation.length * 3);
  for (let i = 0; i < elevation.length; i++) out.set(blendedBiomeColor(temperature[i]!, precipitation[i]!, elevation[i]!), i * 3);
  return out;
}

/** Rock colours: which kind of rock lies under each point. */
export function colorsFromRock(rock: ArrayLike<number>): Float32Array {
  const out = new Float32Array(rock.length * 3);
  for (let i = 0; i < rock.length; i++) out.set(ROCKS[rock[i]!]!.color, i * 3);
  return out;
}

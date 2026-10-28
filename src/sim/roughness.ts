// Natural roughness for painted land.
//
// A painted continent is a smooth dome, so rivers run straight down it and every range looks the same.
// This adds seeded fractal noise to the crust thickness of land (more on mountains, none on seafloor).
// The noise is a function of position on the sphere, not of lattice cells, so the same world has the
// same hills at any detail. Only + - * / and integer maths are used.

import { hashSeed } from './rng';
import { MAX_THICKNESS, MIN_THICKNESS, SEA_LEVEL_THICKNESS, elevationFromThickness } from './crust';
import type { WorldState } from './world';


/** Roughest height (km of crust) added on high ground: about 0.9 km of surface. */
const AMPLITUDE_KM = 3.5;
/** Thickness above which the roughness is at full strength; below the floor there is none. */
const ROUGH_FROM = 18;
const ROUGH_FULL = 38;

const OCTAVE_FREQUENCY = [6, 12, 24, 48, 96] as const; // waves per unit of sphere
const OCTAVE_WEIGHT = [1, 0.55, 0.3, 0.16, 0.09] as const;
const WEIGHT_SUM = OCTAVE_WEIGHT.reduce((a, b) => a + b, 0);

/** A repeatable value in [-1, 1) for an integer grid corner. */
function corner(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smooth value noise in 3D: interpolates hashed corner values. Range [-1, 1]. */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const tx = fade(x - fx), ty = fade(y - fy), tz = fade(z - fz);
  const c = (dx: number, dy: number, dz: number) => corner(fx + dx, fy + dy, fz + dz, seed);
  return mix(
    mix(mix(c(0, 0, 0), c(1, 0, 0), tx), mix(c(0, 1, 0), c(1, 1, 0), tx), ty),
    mix(mix(c(0, 0, 1), c(1, 0, 1), tx), mix(c(0, 1, 1), c(1, 1, 1), tx), ty),
    tz,
  );
}

/** Fractal noise at a point on the unit sphere, in about [-1, 1]. */
export function fractalNoise(x: number, y: number, z: number, seed: number): number {
  let sum = 0;
  for (let o = 0; o < OCTAVE_FREQUENCY.length; o++) {
    const f = OCTAVE_FREQUENCY[o]!;
    // A different offset per octave stops the octaves lining up at the origin.
    sum += OCTAVE_WEIGHT[o]! * valueNoise3(x * f + o * 17.3, y * f + o * 31.7, z * f + o * 5.9, seed + o);
  }
  return sum / WEIGHT_SUM;
}

/** Fractal noise with a chosen set of frequencies (waves per unit of sphere) and weights, in about [-1, 1]. */
export function fractalNoiseBands(x: number, y: number, z: number, seed: number, frequencies: readonly number[], weights: readonly number[]): number {
  let sum = 0;
  let total = 0;
  for (let o = 0; o < frequencies.length; o++) {
    const f = frequencies[o]!;
    sum += weights[o]! * valueNoise3(x * f + o * 17.3, y * f + o * 31.7, z * f + o * 5.9, seed + o);
    total += weights[o]!;
  }
  return sum / total;
}

/** The world with rough land: a copy, leaving the input alone. */
export function addRoughness(world: WorldState, seed: string): WorldState {
  const { lattice } = world;
  const noiseSeed = hashSeed(`${seed}/rough`) | 0;
  const thickness = Float64Array.from(world.thickness);
  for (let v = 0; v < lattice.vertexCount; v++) {
    const t = thickness[v]!;
    const strength = Math.min(1, Math.max(0, (t - ROUGH_FROM) / (ROUGH_FULL - ROUGH_FROM)));
    if (strength === 0) continue;
    const n = fractalNoise(lattice.positions[v * 3]!, lattice.positions[v * 3 + 1]!, lattice.positions[v * 3 + 2]!, noiseSeed);
    thickness[v] = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, t + n * AMPLITUDE_KM * strength));
  }
  return { lattice, thickness };
}

/** Exposed for tests and tuning: how rough the land is, in metres of surface. */
export const ROUGHNESS_SURFACE_M = elevationFromThickness(SEA_LEVEL_THICKNESS + AMPLITUDE_KM) - elevationFromThickness(SEA_LEVEL_THICKNESS);

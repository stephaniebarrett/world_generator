// Terrain for generated land: relief built from what the plates are doing at their boundaries.
//
//  - Two continents colliding raise a high range (Himalaya, 70+ km crust).
//  - Sea floor sliding under a continent raises a coastal range with volcanoes (Andes) and cuts a trench offshore.
//  - Sea floor sliding under sea floor builds a volcanic island arc beside a trench.
//  - Plates pulling apart open a rift valley on land and raise a mid-ocean ridge at sea.
//  - Plates sliding past each other leave a low ridge along the fault.
//  - How hard each of these builds depends on how fast the plates are closing, opening or sliding there.
//  - Ridged fractal noise breaks the ranges into peaks and spurs; old worn-down belts and broad swells and basins
//    fill continental interiors, where no plate boundary reaches.
//  - A short erosion pass carves valleys, harder where the rock is soft, so rivers have real basins.
//
// Positions only, plus the plates' own kinematics: the same world gives the same terrain at any detail.
// Only + - * / sqrt are used, with fixed iteration order.

import { analyzeBoundaries } from './boundaries';
import { MAX_THICKNESS, MIN_THICKNESS, ROCKS, SEA_LEVEL_THICKNESS } from './crust';
import { DEFAULT_EROSION, erosionDelta } from './erosion';
import { assignGeology } from './geology';
import type { Plate } from './plates';
import { hashSeed } from './rng';
import { fractalNoiseBands } from './roughness';
import type { WorldState } from './world';

/** Closing speed (rad/My) that counts as full strength: about 4.5 cm/yr, India into Asia. */
const CLOSING_REF = 0.009;
const MAX_STRENGTH = 1.7;
/** Terrain further than this (km) from a boundary gets no boundary relief. */
const REACH_KM = 1500;

/** Thickness (km) above which crust compresses toward `MAX_THICKNESS - 4` instead of climbing on. */
const SOFT_FROM = 52;
function softCeiling(t: number): number {
  if (t <= SOFT_FROM) return t;
  const room = MAX_THICKNESS - 4 - SOFT_FROM;
  const x = t - SOFT_FROM;
  return SOFT_FROM + (room * x) / (x + room);
}

/** A smooth hump: 1 at distance d0 from a boundary, falling to 0 at d0 +- w. */
function profile(d: number, d0: number, w: number): number {
  const x = (d - d0) / w;
  if (x <= -1 || x >= 1) return 0;
  const k = 1 - x * x;
  return k * k;
}

/** A broader hump with gentler flanks, for mountain ranges and plateaus: 1 at d0, falling to 0 at d0 +- w. */
function broad(d: number, d0: number, w: number): number {
  const x = (d - d0) / w;
  return x <= -1 || x >= 1 ? 0 : 1 - x * x;
}

/** Old, worn-down mountain belts across continental interiors: the contour lines of a smooth noise field. */
function ancientBelt(x: number, y: number, z: number, seed: number): number {
  const n = fractalNoiseBands(x, y, z, seed, [1.5, 3, 6], [1, 0.5, 0.25]);
  const line = 1 - Math.abs(n) * 5; // 1 on the contour, 0 a little way either side
  const skirt = 1 - Math.abs(n) * 1.8; // a much wider, low apron around it: the foothills
  return (line > 0 ? line * line : 0) + (skirt > 0 ? 0.15 * skirt * skirt : 0);
}

export interface TerrainOptions {
  /** Years of erosion applied to carve valleys, in million years (default 10). */
  readonly erosionMy?: number;
}

/** Add relief to `state.thickness` in place. */
export function buildTerrain(state: WorldState, plateOf: Int32Array, plates: readonly Plate[], seed: string, options: TerrainOptions = {}): void {
  const { lattice, thickness } = state;
  const n = lattice.vertexCount;
  const { positions } = lattice;
  const info = analyzeBoundaries(lattice, plateOf, plates, thickness);
  const alongSeed = hashSeed(`${seed}/along`) | 0;
  const ridgeSeed = hashSeed(`${seed}/ridges`) | 0;
  const beltSeed = hashSeed(`${seed}/belts`) | 0;
  const swellSeed = hashSeed(`${seed}/swells`) | 0;

  const add = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    const ownLandHere = thickness[v]! > SEA_LEVEL_THICKNESS;
    let sum = 0;

    // Relief at plate boundaries.
    const s = info.source[v]!;
    const d = info.distanceKm[v]!;
    if (s >= 0 && d < REACH_KM) {
      const closing = info.closing[s]! / CLOSING_REF;
      const shear = Math.min(MAX_STRENGTH, info.shear[s]! / CLOSING_REF);
      const ownLand = thickness[s]! > SEA_LEVEL_THICKNESS; // the kind of crust at the boundary on this side
      const otherLand = info.otherLand[s]! > 0.5;
      // Ranges come and go along a boundary: some stretches rise high, some barely rise at all, and the high ones break into peaks.
      const alongNoise = fractalNoiseBands(positions[s * 3]!, positions[s * 3 + 1]!, positions[s * 3 + 2]!, alongSeed, [2.5, 5, 10], [1, 0.6, 0.3]);
      const along = Math.min(1, Math.max(0, 0.55 + 2.0 * alongNoise));
      const ridged = 1 - Math.abs(fractalNoiseBands(x, y, z, ridgeSeed, [4, 8, 16, 32], [1, 0.6, 0.4, 0.25]));
      const peaks = 0.6 + 0.8 * ridged * ridged;
      const spurs = 0.5 + 0.5 * ridged; // foothills are ridged too, only lower

      if (closing > 0.08) {
        const c = Math.min(MAX_STRENGTH, closing);
        // Each range is a high core with long foothills and plateaus falling away from it.
        if (ownLand && otherLand) sum += along * c * (48 * peaks * profile(d, 110, 520) + 9 * spurs * broad(d, 350, 1350)); // continental collision
        else if (ownLand) sum += along * c * (15 * peaks * profile(d, 150, 280) + 5 * spurs * broad(d, 330, 950)); // Andean coast range
        else if (otherLand) sum -= 4 * c * profile(d, 0, 100); // trench off a continent
        else if (plateOf[v]! < info.otherPlate[s]!) sum += along * 28 * c * profile(d, 120, 100); // island arc on the overriding plate
        else sum -= 3 * c * profile(d, 0, 100); // trench beside an arc
      } else if (closing < -0.08) {
        const g = Math.min(MAX_STRENGTH, -closing);
        if (ownLand) sum += -8 * g * profile(d, 0, 130) + 3 * g * profile(d, 260, 150); // rift valley with raised shoulders
        else sum += 6.5 * g * profile(d, 0, 1400); // mid-ocean ridge
      }
      if (shear > 0.05) sum += 3 * shear * profile(d, 0, 100) * (ownLand ? peaks : 1); // fault ridge
    }

    // Continental interiors: old fold belts, and broad swells and basins.
    if (ownLandHere) {
      const inland = Math.min(1, (thickness[v]! - SEA_LEVEL_THICKNESS) / 6);
      const bump = Math.min(1, Math.max(0, 0.45 + 1.5 * fractalNoiseBands(x, y, z, beltSeed + 11, [1.5, 3], [1, 0.5])));
      sum += inland * (5 + 24 * bump * bump) * ancientBelt(x, y, z, beltSeed) * (0.5 + 0.5 * (1 + fractalNoiseBands(x, y, z, ridgeSeed + 7, [8, 16], [1, 0.5])) / 1.5);
      sum += inland * 3 * fractalNoiseBands(x, y, z, swellSeed, [1.5, 3, 6], [1, 0.6, 0.3]);
      // Hill country: some regions are rolling or rugged, others plain.
      const region = Math.min(1, Math.max(0, 0.5 + 1.4 * fractalNoiseBands(x, y, z, swellSeed + 5, [2, 4], [1, 0.5])));
      const rugged = 1 - Math.abs(fractalNoiseBands(x, y, z, ridgeSeed + 3, [10, 20, 40], [1, 0.6, 0.35]));
      sum += inland * 1.2 * region * rugged * rugged;
    }
    add[v] = sum;
  }
  // Thick crust piles up ever harder (the highest ranges are only a little above high ones), so peaks level off smoothly
  // instead of all hitting the same ceiling.
  for (let v = 0; v < n; v++) thickness[v] = Math.max(MIN_THICKNESS, softCeiling(thickness[v]! + add[v]!));

  // A short spell of erosion cuts valleys into the new relief, faster in soft rock.
  const erosionMy = options.erosionMy ?? 10;
  if (erosionMy > 0) {
    const rock = assignGeology(lattice, thickness, plateOf, plates, seed);
    const erodibility = Float64Array.from(rock, (r) => ROCKS[r]!.erodibility);
    const steps = Math.max(1, Math.round(erosionMy / 2));
    // Fresh relief is rougher than old, graded ground, so it wears faster than the long-run rate the simulation uses.
    const params = { ...DEFAULT_EROSION, incision: 45000 };
    for (let i = 0; i < steps; i++) {
      const delta = erosionDelta(lattice, thickness, erosionMy / steps, params, erodibility);
      for (let v = 0; v < n; v++) thickness[v] = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, thickness[v]! + delta[v]!));
    }
  }
}

// Building terrain is the costly part of generating land, and the replay rebuilds the world after every edit,
// so remember the last few results. The key is everything the terrain depends on.
const cache = new Map<string, Float64Array>();

function fingerprint(state: WorldState, plateOf: Int32Array, plates: readonly Plate[], seed: string, options: TerrainOptions): string {
  let h = 2166136261;
  const mix = (x: number) => { h = Math.imul(h ^ (x | 0), 16777619); };
  for (let v = 0; v < state.lattice.vertexCount; v++) {
    mix(Math.round(state.thickness[v]! * 40));
    mix(plateOf[v]!);
  }
  for (const p of plates) {
    mix(p.id);
    mix(Math.round(p.angularSpeed * 1e7));
    for (const a of p.axis) mix(Math.round(a * 1e6));
  }
  return `${seed}|${options.erosionMy ?? 10}|${state.lattice.vertexCount}|${h >>> 0}`;
}

/** buildTerrain, remembering recent results. */
export function buildTerrainCached(state: WorldState, plateOf: Int32Array, plates: readonly Plate[], seed: string, options: TerrainOptions = {}): void {
  const key = fingerprint(state, plateOf, plates, seed, options);
  const hit = cache.get(key);
  if (hit) {
    state.thickness.set(hit);
    return;
  }
  buildTerrain(state, plateOf, plates, seed, options);
  cache.set(key, Float64Array.from(state.thickness));
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
}

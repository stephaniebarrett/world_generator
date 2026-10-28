// Generated land: a few large blobs for the continents, bent into natural coastlines by fractal noise,
// with the land cover set to a chosen share of the globe.
//
// Everything is a function of position on the sphere, so the same edit makes the same land at any detail.
// Only + - * / sqrt are used (no trigonometry), so results are identical on every machine.

import { cellKm } from './climate';
import type { Plate } from './plates';
import { buildTerrainCached } from './terrain';
import type { Lattice } from './lattice';
import { createRng, hashSeed, type Rng } from './rng';
import { fractalNoiseBands } from './roughness';
import { LAND_THICKNESS, OCEAN_THICKNESS, SEA_LEVEL_THICKNESS } from './crust';
import type { GenerateEdit, WorldState } from './world';

type Style = GenerateEdit['style'];

export const LAND_STYLES: ReadonlyArray<{ key: Style; name: string }> = [
  { key: 'continents', name: 'Continents' },
  { key: 'pangaea', name: 'Pangaea' },
  { key: 'two', name: 'Two supercontinents' },
  { key: 'archipelago', name: 'Archipelago' },
];

interface Blob {
  readonly c: readonly [number, number, number];
  /** Share of the globe's area the blob's core covers (the sphere's cap area fraction). */
  readonly r: number;
  readonly weight: number;
}

const COAST_FREQUENCIES = [2, 4, 8, 16, 32] as const;
const COAST_WEIGHTS = [1, 0.6, 0.4, 0.25, 0.15] as const;
/** How strongly the coastline noise bends the blobs. */
const NOISE_AMPLITUDE: Record<Style, number> = { continents: 0.45, pangaea: 0.3, two: 0.45, archipelago: 0.5 };
/** Domain warp: how far the shape of each continent is bent before it is drawn, which gives peninsulas, bays and elongated shapes. */
const WARP_STRENGTH: Record<Style, number> = { continents: 0.5, pangaea: 0.08, two: 0.45, archipelago: 0.35 };
const WARP_FREQUENCIES = [1.5, 3, 6] as const;
const WARP_WEIGHTS = [1, 0.5, 0.25] as const;
/** Width of the shelf, in potential units: land rises from the sea floor across this. */
const SHELF_WIDTH = 0.14;
/** Crust thickness inland: lowlands and hills, before the roughness that is added when the world is set up. */
const INTERIOR_THICKNESS = LAND_THICKNESS + 1;
/** How strongly land prefers plate interiors, and how far in from a boundary counts as fully inside. */
const INTERIOR_BIAS = 0;
const INTERIOR_REACH_KM = 700;

function randomPoint(rng: Rng): [number, number, number] {
  let x = 0, y = 0, z = 0, len2 = 0;
  do {
    x = rng.next() * 2 - 1;
    y = rng.next() * 2 - 1;
    z = rng.next() * 2 - 1;
    len2 = x * x + y * y + z * z;
  } while (len2 === 0 || len2 > 1);
  const len = Math.sqrt(len2);
  return [x / len, y / len, z / len];
}

/** Spread the blob centres out: of several random candidates take the one farthest from those already placed. */
function spreadCentres(count: number, rng: Rng): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < count; i++) {
    let best = randomPoint(rng);
    let bestGap = -1;
    for (let k = 0; k < 24; k++) {
      const cand = randomPoint(rng);
      let gap = Infinity;
      for (const o of out) gap = Math.min(gap, (cand[0] - o[0]) ** 2 + (cand[1] - o[1]) ** 2 + (cand[2] - o[2]) ** 2);
      if (out.length === 0) gap = 0;
      if (gap > bestGap) {
        bestGap = gap;
        best = cand;
      }
    }
    out.push(best);
  }
  return out;
}

/** What the generator needs to know about the plates: how deep inside its plate each point is, and where each plate's heart is. */
interface PlateInfo {
  /** Distance in km from the nearest plate boundary. */
  readonly depthKm: Float64Array;
  /** Per plate id: share of the globe it covers (0 for a plate with no ground left). */
  readonly area: Float64Array;
  /** Per plate id: its deepest-inside vertex, or -1. */
  readonly heart: Int32Array;
  /** Per plate id: all its vertices. */
  readonly members: readonly (readonly number[])[];
}

function plateInfo(lattice: Lattice, plateOf: Int32Array): PlateInfo {
  const n = lattice.vertexCount;
  const hops = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (let v = 0; v < n; v++) {
    for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
      if (plateOf[lattice.neighbors[k]!] !== plateOf[v]) {
        hops[v] = 0;
        queue.push(v);
        break;
      }
    }
  }
  for (let h = 0; h < queue.length; h++) {
    const v = queue[h]!;
    for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
      const w = lattice.neighbors[k]!;
      if (hops[w]! < 0 && plateOf[w] === plateOf[v]) {
        hops[w] = hops[v]! + 1;
        queue.push(w);
      }
    }
  }
  const km = cellKm(lattice);
  const depthKm = new Float64Array(n);
  let ids = 0;
  for (let v = 0; v < n; v++) {
    // A single plate covering the whole globe has no boundary at all: call everything deep.
    depthKm[v] = hops[v]! < 0 ? 5000 : hops[v]! * km;
    ids = Math.max(ids, plateOf[v]! + 1);
  }
  const area = new Float64Array(ids);
  const heart = new Int32Array(ids).fill(-1);
  const members: number[][] = Array.from({ length: ids }, () => []);
  for (let v = 0; v < n; v++) {
    const id = plateOf[v]!;
    members[id]!.push(v);
    area[id] = area[id]! + 1 / n;
    if (heart[id]! < 0 || depthKm[v]! > depthKm[heart[id]!]!) heart[id] = v;
  }
  return { depthKm, area, heart, members };
}

/** Choose `count` plates, favouring big ones, without repeats. */
function pickPlates(info: PlateInfo, count: number, rng: Rng): number[] {
  const ids = [...info.area.keys()].filter((id) => info.heart[id]! >= 0);
  const chosen: number[] = [];
  while (chosen.length < count && ids.length > 0) {
    let total = 0;
    for (const id of ids) total += info.area[id]!;
    let roll = rng.next() * total;
    let at = 0;
    for (let i = 0; i < ids.length; i++) {
      roll -= info.area[ids[i]!]!;
      if (roll <= 0) { at = i; break; }
    }
    chosen.push(ids[at]!);
    ids.splice(at, 1);
  }
  return chosen;
}

function makeBlobs(style: Style, landFraction: number, rng: Rng, lattice?: Lattice, info?: PlateInfo): Blob[] {
  if (lattice && info) return makePlateBlobs(style, landFraction, rng, lattice, info);
  const blobs: Blob[] = [];
  const add = (centres: Array<[number, number, number]>, sizeOf: (i: number) => number) =>
    centres.forEach((c, i) => blobs.push({ c, r: sizeOf(i) * landFraction, weight: 0.75 + 0.25 * rng.next() }));
  switch (style) {
    case 'pangaea':
      // One supercontinent holding most of the land, with a few satellites.
      add(spreadCentres(4, rng), (i) => (i === 0 ? 0.85 : 0.04 + 0.04 * rng.next()));
      break;
    case 'two':
      add(spreadCentres(2, rng), () => 0.42);
      break;
    case 'archipelago': {
      // A scatter of small islands and a few larger ones.
      const n = 28;
      add(spreadCentres(n, rng), (i) => (i < 4 ? 0.09 : 0.012 + 0.03 * rng.next()));
      break;
    }
    default: {
      // Continents of unequal size, like a real map.
      const n = 6;
      add(spreadCentres(n, rng), (i) => 0.34 / (1 + i * 0.7));
    }
  }
  return blobs;
}


/** Continents placed inside the plates: each sits at the heart of a plate and is sized to fit within it. */
function makePlateBlobs(style: Style, landFraction: number, rng: Rng, lattice: Lattice, info: PlateInfo): Blob[] {
  const at = (v: number): [number, number, number] => [lattice.positions[v * 3]!, lattice.positions[v * 3 + 1]!, lattice.positions[v * 3 + 2]!];
  const blobs: Blob[] = [];
  // Land need not sit neatly in the middle of a plate: half the time it is pushed toward one edge of the plate, and it
  // may spill over the boundary (continents do straddle plates).
  const anchor = (plate: number): number => {
    const all = info.members[plate]!;
    // Of several tries, take the spot farthest from the land already placed, so continents do not run into each other.
    const gap = (v: number) => {
      let g = Infinity;
      for (const b of blobs) g = Math.min(g, (b.c[0] - lattice.positions[v * 3]!) ** 2 + (b.c[1] - lattice.positions[v * 3 + 1]!) ** 2 + (b.c[2] - lattice.positions[v * 3 + 2]!) ** 2);
      return g;
    };
    const tries = [info.heart[plate]!];
    if (all.length > 0) {
      const edgeward = rng.next() < 0.5;
      for (let i = 0; i < 8; i++) {
        let c = all[rng.int(all.length)]!;
        if (edgeward) { const d = all[rng.int(all.length)]!; if (info.depthKm[d]! < info.depthKm[c]!) c = d; }
        tries.push(c);
      }
    }
    let best = tries[0]!, bestGap = gap(best);
    for (const c of tries) { const g = gap(c); if (g > bestGap) { best = c; bestGap = g; } }
    return best;
  };
  const add = (_v: number, r: number, plate: number) =>
    blobs.push({ c: at(anchor(plate)), r: Math.min(r, 0.9 * info.area[plate]!), weight: 0.75 + 0.25 * rng.next() });
  const byArea = [...info.area.keys()].filter((id) => info.heart[id]! >= 0).sort((a, b) => info.area[b]! - info.area[a]! || a - b);

  switch (style) {
    case 'pangaea': {
      // One supercontinent on the biggest plate, big enough to spill across its neighbours, plus a few satellites.
      const main = byArea[0]!;
      blobs.push({ c: at(anchor(main)), r: 0.85 * landFraction, weight: 1 });
      for (const id of pickPlates(info, 3, rng)) if (id !== main) add(info.heart[id]!, 0.05 * landFraction, id);
      break;
    }
    case 'two': {
      // The biggest plate, and the plate far from it.
      const first = byArea[0]!;
      const a = at(info.heart[first]!);
      let far = byArea[1] ?? first;
      let farGap = -1;
      for (const id of byArea.slice(0, Math.max(2, Math.ceil(byArea.length / 2)))) {
        const c = at(info.heart[id]!);
        const gap = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2 + (c[2] - a[2]) ** 2;
        if (id !== first && gap > farGap) { far = id; farGap = gap; }
      }
      add(info.heart[first]!, 0.45 * landFraction, first);
      add(info.heart[far]!, 0.45 * landFraction, far);
      break;
    }
    case 'archipelago': {
      // Islands scattered over the globe, whatever the plates.
      const pool = Array.from({ length: lattice.vertexCount }, (_, v) => v);
      const centres: Array<[number, number, number]> = [];
      for (let i = 0; i < 28; i++) {
        let best = pool[rng.int(pool.length)]!;
        let bestGap = -1;
        for (let k = 0; k < 24; k++) {
          const cand = pool[rng.int(pool.length)]!;
          const c = at(cand);
          let gap = Infinity;
          for (const o of centres) gap = Math.min(gap, (c[0] - o[0]) ** 2 + (c[1] - o[1]) ** 2 + (c[2] - o[2]) ** 2);
          if (centres.length === 0) gap = 0;
          if (gap > bestGap) { bestGap = gap; best = cand; }
        }
        centres.push(at(best));
        blobs.push({ c: at(best), r: i < 4 ? 0.09 * landFraction : (0.012 + 0.03 * rng.next()) * landFraction, weight: 0.75 + 0.25 * rng.next() });
      }
      break;
    }
    default: {
      // Continents of unequal size, one on each of several plates.
      const chosen = pickPlates(info, Math.min(6, byArea.length), rng);
      chosen.forEach((id, i) => add(info.heart[id]!, (0.34 / (1 + i * 0.7)) * landFraction * 3, id));
    }
  }
  return blobs;
}

/** Smoothstep inverse by bisection: the x in [0, 1] where 3x^2 - 2x^3 equals s. */
function inverseSmoothstep(s: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (3 * mid * mid - 2 * mid * mid * mid < s) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** How land-like each lattice point is: high inland, low at sea. */
export function landPotential(
  positions: Float64Array, vertexCount: number, edit: Pick<GenerateEdit, 'style' | 'landFraction' | 'seed'>, plates?: { lattice: Lattice; info: PlateInfo },
): Float64Array {
  const rng = createRng(`${edit.seed}/land`);
  const blobs = makeBlobs(edit.style, edit.landFraction, rng, plates?.lattice, plates?.info);
  const noiseSeed = hashSeed(`${edit.seed}/coast`) | 0;
  const warpSeed = hashSeed(`${edit.seed}/warp`) | 0;
  const amplitude = NOISE_AMPLITUDE[edit.style];
  const warp = WARP_STRENGTH[edit.style];
  const out = new Float64Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    // Bend the point by smooth noise before measuring it against the blobs, so no continent stays a disc.
    let wx = x + warp * fractalNoiseBands(x, y, z, warpSeed, WARP_FREQUENCIES, WARP_WEIGHTS);
    let wy = y + warp * fractalNoiseBands(x, y, z, warpSeed + 101, WARP_FREQUENCIES, WARP_WEIGHTS);
    let wz = z + warp * fractalNoiseBands(x, y, z, warpSeed + 202, WARP_FREQUENCIES, WARP_WEIGHTS);
    const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
    wx /= wl; wy /= wl; wz /= wl;
    let best = 0;
    for (const b of blobs) {
      // g is the share of the globe's area between this point and the blob's centre: 0 at the centre, 1 opposite.
      const g = (1 - (wx * b.c[0] + wy * b.c[1] + wz * b.c[2])) / 2;
      const k = 1 - g / b.r;
      if (k > 0) best = Math.max(best, b.weight * k * k);
    }
    // With plates known, the continents are strengthened inside plates and weakened near their boundaries.
    // (Only the continents' own potential is scaled, so no land appears where there is no continent.)
    if (plates) best *= 1 - INTERIOR_BIAS + INTERIOR_BIAS * Math.min(1, plates.info.depthKm[v]! / INTERIOR_REACH_KM);
    out[v] = best + amplitude * fractalNoiseBands(x, y, z, noiseSeed, COAST_FREQUENCIES, COAST_WEIGHTS);
  }
  return out;
}

/** Add generated land to the world: nothing already there is lowered. */
export function applyGenerate(state: WorldState, edit: GenerateEdit, plateOf?: Int32Array, plates?: readonly Plate[]): void {
  const { lattice, thickness } = state;
  const n = lattice.vertexCount;
  // Given the plates as they are now, the land is laid out to suit them.
  const plateContext = plateOf ? { lattice, info: plateInfo(lattice, plateOf) } : undefined;
  const potential = landPotential(lattice.positions, n, edit, plateContext);

  // The land cover is set exactly: sea level goes where the chosen share of points lies above it.
  const sorted = Float64Array.from(potential).sort();
  const cut = sorted[Math.min(n - 1, Math.max(0, Math.floor((1 - edit.landFraction) * n)))]!;

  // Thickness rises smoothly from sea floor to inland over the shelf width, crossing sea level at `cut`.
  const crossing = inverseSmoothstep((SEA_LEVEL_THICKNESS - OCEAN_THICKNESS) / (INTERIOR_THICKNESS - OCEAN_THICKNESS));
  const start = cut - crossing * SHELF_WIDTH;
  for (let v = 0; v < n; v++) {
    const x = Math.min(1, Math.max(0, (potential[v]! - start) / SHELF_WIDTH));
    const generated = OCEAN_THICKNESS + (INTERIOR_THICKNESS - OCEAN_THICKNESS) * (x * x * (3 - 2 * x));
    if (generated > thickness[v]!) thickness[v] = generated;
  }

  // Given the plates and how they move, the land also gets terrain: ranges at collisions, rifts, arcs, valleys.
  if (plateOf && plates) buildTerrainCached(state, plateOf, plates, edit.seed);
}

// Erosion on the analysis grid (the lattice).
//
//  - Stream-power incision: rivers cut down in proportion to sqrt(drainage area) x slope.
//  - Hillslope diffusion: steep ground slumps toward its lower neighbours.
//  - Sediment: everything eroded travels downhill with the water and is
//    deposited where it reaches the sea or a pit.
//
// Material is conserved exactly: total removed equals total deposited.
// Only + - * / sqrt are used, with fixed iteration order.

import type { Lattice } from './lattice';
import { cellKm } from './climate';
import { MAX_THICKNESS, METRES_PER_KM, MIN_THICKNESS, elevationFromThickness } from './crust';

const EARTH_RADIUS_KM = 6371;
/**
 * All quantities below are metres of ROCK removed or added, because erosion moves rock. Crust
 * floats, so the surface moves less than the rock does: the isostatic factor (about 173 m of
 * elevation per km of crust), i.e. 0.173 m of surface per 1 m of rock. Elevation is only used to find slopes and flow directions.
 */
const SURFACE_PER_ROCK = METRES_PER_KM / 1000;

export interface ErosionParams {
  /** Stream-power coefficient (m per My at unit area and slope). */
  readonly incision: number;
  /** Hillslope diffusivity on land (km^2 per My); moves rock down the surface gradient. */
  readonly diffusion: number;
  /** Diffusivity involving ocean floor (km^2 per My); slow, so shelves only slowly smooth out. */
  readonly seaDiffusion: number;
  /**
   * Basin area (km^2) at which a river starts to build a delta, and at which it keeps all its sediment. Smaller rivers
   * carry their sediment out to sea, where it spreads too thinly to build land. (The Mississippi, Nile, Ganges and
   * Mekong drain 0.8-3 million km^2 and have large deltas.) [0, 0] keeps everything, which conserves material exactly.
   */
  readonly deltaBasinKm2: readonly [number, number];
}

/**
 * Calibrated against real ranges: a steep 8 km range loses roughly 50 m of surface per My
 * (a few hundred metres of rock per My, within the 0.1-1 mm/yr measured for real mountains),
 * and the rate barely changes with lattice detail. Slopes are small on a coarse lattice, hence
 * the large coefficient.
 */
export const DEFAULT_EROSION: ErosionParams = { incision: 5000, diffusion: 4000, seaDiffusion: 100, deltaBasinKm2: [60000, 500000] };

/** Depth (m) of the continental shelf edge: below this, the deep sea floor does not pull on the coast. */
const SHELF_DEPTH = -200;

/** Rainfall (mm/yr) that counts as typical: the global mean on Earth is about 990. */
const REFERENCE_RAIN_MM = 1000;
/** Bounds on a place's wetness relative to typical, so a desert still erodes a little (flash floods, wind) and a monsoon coast not absurdly fast. */
const MIN_WETNESS = 0.15;
const MAX_WETNESS = 3;

/** Largest fraction of a height difference one neighbour pair may exchange per step (explicit-scheme stability). */
const MAX_DIFFUSION_FRACTION = 0.12;

/**
 * Change in crust thickness (km) at every lattice vertex for one erosion step.
 * `thickness` is the lattice field; the result sums to zero.
 */
export function erosionDelta(
  lattice: Lattice,
  thickness: ArrayLike<number>,
  dt: number,
  params: ErosionParams = DEFAULT_EROSION,
  /** Per point: how easily the rock there wears (1 = typical; see ROCKS). Hard rock stands up, soft rock wears into valleys. */
  erodibility?: ArrayLike<number>,
  /** Per point: annual rainfall (mm/yr). Wet ground carries bigger rivers and weathers faster; deserts barely erode. Omit to treat every place as typical. */
  precipitation?: ArrayLike<number>,
): Float64Array {
  const n = lattice.vertexCount;
  const { positions, offsets, neighbors } = lattice;

  const km0 = cellKm(lattice);
  const cellAreaKm2 = 0.866 * km0 * km0;
  const elev = new Float64Array(n);
  for (let v = 0; v < n; v++) elev[v] = elevationFromThickness(thickness[v]!);

  const chordKm = (a: number, b: number): number => {
    const dx = positions[a * 3]! - positions[b * 3]!, dy = positions[a * 3 + 1]! - positions[b * 3 + 1]!, dz = positions[a * 3 + 2]! - positions[b * 3 + 2]!;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) * EARTH_RADIUS_KM;
  };

  // Steepest-descent receiver for every vertex; -1 for pits and the sea.
  const receiver = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    if (elev[v]! <= 0) continue;
    let best = -1;
    let bestElev = elev[v]!;
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const w = neighbors[k]!;
      if (elev[w]! < bestElev) {
        bestElev = elev[w]!;
        best = w;
      }
    }
    receiver[v] = best;
  }

  // Highest first; ties by index so the order never depends on the sort implementation.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => elev[b]! - elev[a]! || a - b);

  // Drainage area, accumulated downstream. `flow` is the same sum weighted by rainfall (1 = the world's average rain):
  // it is the water a river carries, so it sets cutting power, while `area` still sets what size of delta a basin can build.
  const area = new Float64Array(n).fill(1);
  const wet = new Float64Array(n).fill(1);
  if (precipitation) for (let v = 0; v < n; v++) wet[v] = Math.min(MAX_WETNESS, Math.max(MIN_WETNESS, precipitation[v]! / REFERENCE_RAIN_MM));
  const flow = Float64Array.from(wet);
  for (const v of order) {
    const r = receiver[v]!;
    if (r >= 0) {
      area[r] = area[r]! + area[v]!;
      flow[r] = flow[r]! + flow[v]!;
    }
  }

  // Metres removed (negative) or added (positive) at each vertex.
  const change = new Float64Array(n);
  const removed = new Float64Array(n);

  // Stream-power incision, never cutting below the receiver.
  for (let v = 0; v < n; v++) {
    const r = receiver[v]!;
    if (r < 0) continue;
    // A river's base level is the sea: it cannot cut a coast down because the sea floor beyond is deep.
    const drop = elev[v]! - Math.max(elev[r]!, 0);
    if (drop <= 0) continue;
    const slope = drop / (chordKm(v, r) * 1000);
    const hardness = erodibility ? erodibility[v]! : 1;
    const cut = Math.min(params.incision * hardness * Math.sqrt(flow[v]!) * slope * dt, (drop * 0.5) / SURFACE_PER_ROCK);
    removed[v] = removed[v]! + cut;
    change[v] = change[v]! - cut;
  }

  // Hillslope diffusion between neighbouring vertices (symmetric, so it conserves material).
  for (let v = 0; v < n; v++) {
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const w = neighbors[k]!;
      if (w < v) continue;
      const d = chordKm(v, w);
      const soft = erodibility ? (erodibility[v]! + erodibility[w]!) / 2 : 1; // the same for both ends of the pair, so material is conserved
      // Frost, roots and rain break rock down faster where it is wet (and the pair shares one value, so material is still conserved).
      const weathering = 0.6 + 0.4 * ((wet[v]! + wet[w]!) / 2);
      const coef = elev[v]! > 0 && elev[w]! > 0 ? params.diffusion * soft * weathering : params.seaDiffusion * soft;
      // Between land and sea, the sea side counts only down to the edge of the continental shelf.
      const shelfV = elev[v]! <= 0 && elev[w]! > 0 ? Math.max(elev[v]!, SHELF_DEPTH) : elev[v]!;
      const shelfW = elev[w]! <= 0 && elev[v]! > 0 ? Math.max(elev[w]!, SHELF_DEPTH) : elev[w]!;
      const flow = Math.min(MAX_DIFFUSION_FRACTION, (coef * dt) / (d * d)) * (shelfW - shelfV);
      change[v] = change[v]! + flow;
      change[w] = change[w]! - flow;
    }
  }

  // Carry incised material downstream. At a sink (the sea, or a pit in the land) it settles, but only
  // up to the level the water could hold it: sea level for the sea, the spill height for a pit.
  const load = new Float64Array(n);
  for (const v of order) {
    const carried = removed[v]! + load[v]!;
    if (carried === 0) continue;
    const r = receiver[v]!;
    if (r >= 0) {
      load[r] = load[r]! + carried;
      continue;
    }
    if (elev[v]! <= 0) {
      // At the sea: only a big river builds a delta (up to the waterline); the rest of the sediment is carried away.
      const [small, big] = params.deltaBasinKm2;
      const basin = area[v]! * cellAreaKm2;
      const keep = big <= small ? (basin >= small ? 1 : 0) : Math.min(1, Math.max(0, (basin - small) / (big - small)));
      const retained = carried * keep; // the rest is exported: carried off and spread too thinly to build land
      const room = Math.max(0, 0 - elev[v]!) / SURFACE_PER_ROCK;
      const settled = Math.min(retained, room);
      change[v] = change[v]! + settled;
      if (retained > settled) {
        // A delta that has filled to the waterline builds out seaward: the overflow slumps to the lowest neighbour.
        let lowest = -1;
        for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
          const w = neighbors[k]!;
          if (lowest < 0 || elev[w]! < elev[lowest]! || (elev[w] === elev[lowest] && w < lowest)) lowest = w;
        }
        // Only downhill: an enclosed bay with no lower neighbour has nowhere to send it, and the overflow is lost.
        // It joins that cell's load, so that cell settles what fits and passes the rest on in turn (it is processed later, being lower).
        if (lowest >= 0 && elev[lowest]! < elev[v]!) load[lowest] = load[lowest]! + (retained - settled);
      }
      continue;
    }
    // A basin inland fills to its spill height; what does not fit bypasses it.
    let lowestNeighbour = Infinity;
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) lowestNeighbour = Math.min(lowestNeighbour, elev[neighbors[k]!]!);
    // Room in rock metres: the surface rises SURFACE_PER_ROCK per metre of rock added.
    const room = Math.max(0, lowestNeighbour - elev[v]!) / SURFACE_PER_ROCK;
    const settled = Math.min(carried, room);
    change[v] = change[v]! + settled;
    // A full basin overflows through its lowest outlet and the sediment carries on downstream, out of this reckoning:
    // it never piles up on the rim (which could build a point above the highest ground in the region).
  }

  const delta = new Float64Array(n);
  for (let v = 0; v < n; v++) delta[v] = change[v]! / 1000; // rock metres to km of crust
  return delta;
}

/** Erode a thickness field in place for `my` million years, in 1 My steps. */
export function erodeThickness(
  lattice: Lattice,
  thickness: Float64Array,
  my: number,
  params: ErosionParams = DEFAULT_EROSION,
  erodibility?: ArrayLike<number>,
  precipitation?: ArrayLike<number>,
): void {
  const steps = Math.max(1, Math.round(my));
  for (let i = 0; i < steps; i++) {
    const delta = erosionDelta(lattice, thickness, my / steps, params, erodibility, precipitation);
    for (let v = 0; v < thickness.length; v++) thickness[v] = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, thickness[v]! + delta[v]!));
  }
}

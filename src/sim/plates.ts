// Initial plate layout. Derived from the world state and the seed, so it is
// reproducible and never stored in the edit log.
//
//  1. Find connected landmasses.
//  2. Landmasses over a quarter of the globe are split into 2-3 plates; small
//     landmasses are merged into shared plates when there are too many.
//  3. Land points are labelled first, so every landmass sits wholly in one plate.
//  4. Ocean plate seeds fill up to the target plate count.
//  5. Remaining ocean is claimed by noisy nearest-plate growth, giving
//     irregular boundaries.
//
// Only + - * / sqrt and integer ops are used, with fixed iteration order.

import { buildLattice, type Lattice } from './lattice';
import { LatticeIndex } from './latticeIndex';
import { createRng, type Rng } from './rng';
import { elevationFromThickness } from './crust';
import { plateOmega } from './motion';
import { fractalNoiseBands } from './roughness';
import { randomMember } from './sample';
import type { WorldState } from './world';

export interface Plate {
  readonly id: number;
  /** A point the plate was grown from (a land point for land plates). */
  readonly seedVertex: number;
  /** Rotation axis (unit vector) and speed in radians per million years. */
  readonly axis: readonly [number, number, number];
  readonly angularSpeed: number;
}

export interface PlateSetup {
  readonly plateOf: Int32Array;
  readonly plates: readonly Plate[];
}

export interface PlateOptions {
  /** Number of major plates; defaults to a seeded pick in 8..12. */
  readonly targetCount?: number;
  /** Number of minor plates wedged between the major ones; defaults to a seeded pick in 6..10. */
  readonly minorCount?: number;
  /** Landmasses larger than this fraction of the globe are split. */
  readonly splitFraction?: number;
}

const DEFAULT_SPLIT_FRACTION = 0.06;

interface Landmass {
  points: number[];
  /** Normalised mean position. */
  centre: [number, number, number];
}

function isLand(state: WorldState, v: number): boolean {
  return elevationFromThickness(state.thickness[v]!) > 0;
}

function findLandmasses(state: WorldState): Landmass[] {
  const { lattice } = state;
  const seen = new Uint8Array(lattice.vertexCount);
  const out: Landmass[] = [];
  for (let s = 0; s < lattice.vertexCount; s++) {
    if (seen[s] || !isLand(state, s)) continue;
    const points: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length > 0) {
      const v = stack.pop()!;
      points.push(v);
      for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
        const w = lattice.neighbors[k]!;
        if (!seen[w] && isLand(state, w)) {
          seen[w] = 1;
          stack.push(w);
        }
      }
    }
    out.push({ points, centre: meanDirection(lattice, points) });
  }
  return out;
}

function meanDirection(lattice: Lattice, points: readonly number[]): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (const v of points) {
    x += lattice.positions[v * 3]!;
    y += lattice.positions[v * 3 + 1]!;
    z += lattice.positions[v * 3 + 2]!;
  }
  const len = Math.sqrt(x * x + y * y + z * z);
  // A landmass that wraps the whole globe has no meaningful centre; fall back to a pole.
  return len < 1e-9 ? [0, 0, 1] : [x / len, y / len, z / len];
}

function chord2(lattice: Lattice, a: number, b: number): number {
  const p = lattice.positions;
  const dx = p[a * 3]! - p[b * 3]!, dy = p[a * 3 + 1]! - p[b * 3 + 1]!, dz = p[a * 3 + 2]! - p[b * 3 + 2]!;
  return dx * dx + dy * dy + dz * dz;
}

function nearestTo(lattice: Lattice, points: readonly number[], dir: readonly [number, number, number]): number {
  let best = points[0]!;
  let bestDot = -Infinity;
  for (const v of points) {
    const d = lattice.positions[v * 3]! * dir[0] + lattice.positions[v * 3 + 1]! * dir[1] + lattice.positions[v * 3 + 2]! * dir[2];
    if (d > bestDot) {
      bestDot = d;
      best = v;
    }
  }
  return best;
}

/** Best-candidate sampling: of several random candidates, take the one farthest from existing seeds. */
function farthestCandidate(
  lattice: Lattice,
  pool: readonly number[],
  seeds: readonly number[],
  rng: Rng,
  /** Extra points to keep away from, such as existing land. */
  avoid: readonly number[] = [],
  tries = 32,
): number {
  let best = -1;
  let bestDist = -1;
  for (let i = 0; i < tries; i++) {
    const c = randomMember(lattice, pool, rng);
    let nearest = Infinity;
    for (const s of seeds) nearest = Math.min(nearest, chord2(lattice, c, s));
    for (const a of avoid) nearest = Math.min(nearest, chord2(lattice, c, a));
    if (seeds.length === 0 && avoid.length === 0) nearest = 0;
    if (nearest > bestDist) {
      bestDist = nearest;
      best = c;
    }
  }
  return best;
}

// --- priority queue with deterministic tie-breaking ------------------------

export class Heap {
  private d: number[] = [];
  private v: number[] = [];
  private l: number[] = [];

  get size(): number {
    return this.d.length;
  }

  private less(i: number, j: number): boolean {
    if (this.d[i] !== this.d[j]) return this.d[i]! < this.d[j]!;
    if (this.v[i] !== this.v[j]) return this.v[i]! < this.v[j]!;
    return this.l[i]! < this.l[j]!;
  }

  private swap(i: number, j: number): void {
    [this.d[i], this.d[j]] = [this.d[j]!, this.d[i]!];
    [this.v[i], this.v[j]] = [this.v[j]!, this.v[i]!];
    [this.l[i], this.l[j]] = [this.l[j]!, this.l[i]!];
  }

  push(dist: number, vertex: number, label: number): void {
    this.d.push(dist);
    this.v.push(vertex);
    this.l.push(label);
    let i = this.d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, number, number] {
    const top: [number, number, number] = [this.d[0]!, this.v[0]!, this.l[0]!];
    const last = this.d.length - 1;
    this.swap(0, last);
    this.d.pop();
    this.v.pop();
    this.l.pop();
    let i = 0;
    for (;;) {
      const a = 2 * i + 1;
      const b = a + 1;
      let m = i;
      if (a < this.d.length && this.less(a, m)) m = a;
      if (b < this.d.length && this.less(b, m)) m = b;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/**
 * Noisy multi-source growth. Points with label >= 0 are sources; `mask` marks
 * the points that may take part (sources and claimable points).
 */
function grow(lattice: Lattice, label: Int32Array, mask: Uint8Array, noise: Float64Array, fine?: Float64Array, weight?: readonly number[]): void {
  const dist = new Float64Array(lattice.vertexCount).fill(Infinity);
  const heap = new Heap();
  // Broad and fine noise both bend the borders; a plate's weight is how readily it spreads (big and small plates).
  const cost = (b: number) => (fine ? 0.2 + 1.1 * noise[b]! + 0.9 * fine[b]! : 0.3 + 1.4 * noise[b]!);

  const relax = (v: number, base: number, lab: number) => {
    for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
      const w = lattice.neighbors[k]!;
      if (!mask[w] || label[w]! >= 0) continue;
      const nd = base + Math.sqrt(chord2(lattice, v, w)) * cost(w) / (weight ? weight[lab]! : 1);
      if (nd < dist[w]!) {
        dist[w] = nd;
        heap.push(nd, w, lab);
      }
    }
  };

  for (let v = 0; v < lattice.vertexCount; v++) {
    if (mask[v] && label[v]! >= 0) relax(v, 0, label[v]!);
  }
  while (heap.size > 0) {
    const [d, w, lab] = heap.pop();
    if (label[w]! >= 0) continue;
    label[w] = lab;
    relax(w, d, lab);
  }
}

/**
 * A smooth random field, mostly within [0, 1], that depends only on where a point is on the sphere (waves of the given frequencies, per
 * unit of radius, and weights). The same seed gives the same field on a coarse lattice and a fine one, unlike noise that is blurred
 * across the lattice, whose features shrink as the lattice gets finer.
 */
export function positionNoise(lattice: Lattice, rng: Rng, frequencies: readonly number[], weights: readonly number[]): Float64Array {
  const seed = rng.int(0x40000000);
  const out = new Float64Array(lattice.vertexCount);
  for (let v = 0; v < out.length; v++) {
    const n = fractalNoiseBands(lattice.positions[v * 3]!, lattice.positions[v * 3 + 1]!, lattice.positions[v * 3 + 2]!, seed, frequencies, weights);
    out[v] = Math.min(1, Math.max(0, 0.5 + 0.75 * n));
  }
  return out;
}

/** The plates are always laid out on a lattice of this frequency (about 40,000 points), whatever detail the world is simulated at. */
export const PLATE_LAYOUT_FREQUENCY = 63;
const layouts = new Map<string, PlateSetup>();

/**
 * The plates of a world: where they are, how many there are and how each moves. These come from the seed alone and are the same at
 * every simulation detail: the layout is worked out once on a fixed lattice and then handed to the lattice in use, which only
 * decides how finely the borders are drawn. (A finer lattice does not throw the dice again, and a coarser one only loses a plate
 * if it is smaller than a cell.)
 */
export function layoutPlates(lattice: Lattice, seed: string, options: PlateOptions = {}): PlateSetup {
  const reference = buildLattice(PLATE_LAYOUT_FREQUENCY);
  const key = `${seed}|${options.targetCount ?? ''}|${options.minorCount ?? ''}`;
  let base = layouts.get(key);
  if (!base) {
    base = layoutPlatesOn(reference, seed, options);
    if (layouts.size >= 6) layouts.delete(layouts.keys().next().value!);
    layouts.set(key, base);
  }
  if (lattice.frequency === PLATE_LAYOUT_FREQUENCY) return { plateOf: Int32Array.from(base.plateOf), plates: [...base.plates] };
  // Each point takes the plate at the same spot on the reference lattice.
  const from = new LatticeIndex(reference);
  const plateOf = new Int32Array(lattice.vertexCount);
  for (let v = 0; v < plateOf.length; v++) plateOf[v] = base.plateOf[from.nearest(lattice.positions[v * 3]!, lattice.positions[v * 3 + 1]!, lattice.positions[v * 3 + 2]!)]!;
  const here = new LatticeIndex(lattice);
  const plates = base.plates.map((p) => ({
    ...p,
    seedVertex: here.nearest(reference.positions[p.seedVertex * 3]!, reference.positions[p.seedVertex * 3 + 1]!, reference.positions[p.seedVertex * 3 + 2]!),
  }));
  // A coarse lattice can leave a cell cut off from its plate, or four plates meeting at a point; tidy the borders for this lattice.
  removeFourWayJunctions(lattice, plateOf);
  joinStrays(lattice, plateOf);
  return dropEmpty(plateOf, plates);
}

/**
 * Lay out plates from the seed alone, whatever land there is: seeds spread over the globe and grown into
 * irregular regions, each with its own rotation. Land does not move the plates; painting a continent leaves
 * the layout as it was.
 */
function layoutPlatesOn(lattice: Lattice, seed: string, options: PlateOptions): PlateSetup {
  const n = lattice.vertexCount;
  const rng = createRng(seed).fork('plates');
  const target = options.targetCount ?? 8 + rng.int(5);
  const noise = positionNoise(lattice, rng.fork('boundary-noise'), [3, 6], [1, 0.5]);

  const label = new Int32Array(n).fill(-1);
  const seedVertex: number[] = [];
  const everywhere = Array.from({ length: n }, (_, v) => v);
  while (seedVertex.length < target) {
    const free = everywhere.filter((v) => label[v]! < 0);
    if (free.length === 0) break;
    const s = farthestCandidate(lattice, free, seedVertex, rng, [], 5); // few candidates: uneven spacing, so uneven plates
    label[s] = seedVertex.length;
    seedVertex.push(s);
  }
  const fineNoise = positionNoise(lattice, rng.fork('fine-noise'), [7, 14], [1, 0.5]);
  const weights = rng.fork('weights');
  const weight = seedVertex.map(() => 0.5 + 1.5 * weights.next() * weights.next() + 0.5 * weights.next());
  grow(lattice, label, new Uint8Array(n).fill(1), noise, fineNoise, weight);

  // Kinematics, drawn in plate order so they never depend on layout details.
  const motion = rng.fork('motion');
  // Where the plates start out: major plates drift slowly and mostly east or west (not always), with little spin; minor plates
  // drift and spin faster and are free to go any way. Only the starting motion differs: once a run begins every plate is the same.
  const randomMotion = (id: number, sv: number, minor: boolean): Plate => {
    const centre: [number, number, number] = [lattice.positions[sv * 3]!, lattice.positions[sv * 3 + 1]!, lattice.positions[sv * 3 + 2]!];
    // The same draws for every plate, so the motion never depends on which kind it is.
    const speedDraw = motion.next(), horizontalDraw = motion.next(), signDraw = motion.next(), tiltDraw = motion.next();
    const xDraw = motion.next(), yDraw = motion.next(), spinDraw = motion.next();
    const speed = minor ? 0.005 + 0.013 * speedDraw : 0.002 + 0.0055 * speedDraw;
    const free: [number, number] = [xDraw * 2 - 1, yDraw * 2 - 1];
    const horizontal: [number, number] = [signDraw < 0.5 ? -1 : 1, (tiltDraw * 2 - 1) * 0.55];
    const heading = !minor && horizontalDraw < 0.8 ? horizontal : free;
    const spin = (spinDraw * 2 - 1) * (minor ? 0.008 : 0.002);
    const w = plateOmega(centre, heading, speed, spin);
    const len = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
    return { id, seedVertex: sv, axis: len > 0 ? [w[0] / len, w[1] / len, w[2] / len] : [0, 0, 1], angularSpeed: Math.max(len, 0.0015) };
  };
  const majors = seedVertex.map((sv, id) => randomMotion(id, sv, false));
  // Major plates first (one enclosed by another is merged away), then minor plates in the gaps between them.
  const layout = removeEnclaves(lattice, label, majors);
  removeFourWayJunctions(lattice, layout.plateOf);
  const minorCount = options.minorCount ?? 6 + rng.fork('minor-count').int(5);
  const minorSeeds = addMinorPlates(lattice, layout.plateOf, layout.plates.length, minorCount, rng.fork('minor'));
  const plates = [...layout.plates, ...minorSeeds.map((sv, i) => randomMotion(layout.plates.length + i, sv, true))];
  joinStrays(lattice, layout.plateOf); // a minor plate can cut a corner off a major one; the bit rejoins its neighbour
  return dropEmpty(layout.plateOf, plates);
}

/** Renumber plates so that every id has ground (a plate can lose all its points to a minor plate or a rejoined piece). */
export function dropEmpty(plateOf: Int32Array, plates: readonly Plate[]): PlateSetup {
  const used = new Set(plateOf);
  if (used.size === plates.length) return { plateOf, plates };
  const renumber = new Map<number, number>();
  const kept: Plate[] = [];
  for (const p of plates) if (used.has(p.id)) { renumber.set(p.id, kept.length); kept.push({ ...p, id: kept.length }); }
  for (let v = 0; v < plateOf.length; v++) plateOf[v] = renumber.get(plateOf[v]!)!;
  return { plateOf, plates: kept };
}

/**
 * Four plates never meet at a point (real triple junctions are three-way): where four different plates come within
 * two rings of one point, the plate with the least ground there hands it to the neighbour it touches most there.
 */
function removeFourWayJunctions(lattice: Lattice, plateOf: Int32Array): void {
  const n = lattice.vertexCount;
  const window = (v: number): number[] => {
    const out = [v];
    const seen = new Set<number>([v]);
    let frontier = [v];
    for (let ring = 0; ring < 2; ring++) {
      const next: number[] = [];
      for (const u of frontier) {
        for (let k = lattice.offsets[u]!; k < lattice.offsets[u + 1]!; k++) {
          const w = lattice.neighbors[k]!;
          if (!seen.has(w)) { seen.add(w); out.push(w); next.push(w); }
        }
      }
      frontier = next;
    }
    return out;
  };
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let v = 0; v < n; v++) {
      const cells = window(v);
      const count = new Map<number, number>();
      for (const u of cells) count.set(plateOf[u]!, (count.get(plateOf[u]!) ?? 0) + 1);
      if (count.size < 4) continue;
      let least = -1;
      for (const [id, c] of count) if (least < 0 || c < count.get(least)! || (c === count.get(least) && id < least)) least = id;
      // The plate it joins is the one it touches most inside the window.
      const touch = new Map<number, number>();
      for (const u of cells) {
        if (plateOf[u] !== least) continue;
        for (let k = lattice.offsets[u]!; k < lattice.offsets[u + 1]!; k++) {
          const o = plateOf[lattice.neighbors[k]!]!;
          if (o !== least) touch.set(o, (touch.get(o) ?? 0) + 1);
        }
      }
      let heir = -1, most = 0;
      for (const [id, c] of touch) if (c > most || (c === most && id < heir)) { heir = id; most = c; }
      if (heir < 0) continue;
      for (const u of cells) if (plateOf[u] === least) plateOf[u] = heir;
      changed = true;
    }
    if (!changed) break;
  }
}

/**
 * Minor plates: small plates wedged where two or three major plates meet (Caribbean, Juan de Fuca, Philippine Sea).
 * Each is a rough disc centred on a boundary and taken from the plates around it. Returns each one's seed vertex and
 * relabels `plateOf` in place (minor plate ids start at `firstId`).
 */
function addMinorPlates(lattice: Lattice, plateOf: Int32Array, firstId: number, count: number, rng: Rng): number[] {
  const n = lattice.vertexCount;
  const { positions } = lattice;
  // Candidate sites: boundary vertices, scored by how many different plates meet within a few rings (junctions score 3).
  const reach = (v: number): number => {
    const seen = new Set<number>([plateOf[v]!]);
    let frontier = [v];
    const visited = new Set<number>([v]);
    for (let ring = 0; ring < 4; ring++) {
      const next: number[] = [];
      for (const u of frontier) {
        for (let k = lattice.offsets[u]!; k < lattice.offsets[u + 1]!; k++) {
          const w = lattice.neighbors[k]!;
          if (visited.has(w)) continue;
          visited.add(w);
          seen.add(plateOf[w]!);
          next.push(w);
        }
      }
      frontier = next;
    }
    return seen.size;
  };
  const sites: number[] = [];
  const triple: number[] = [];
  for (let v = 0; v < n; v++) {
    const c = reach(v);
    if (c >= 3) triple.push(v);
    if (c >= 2) sites.push(v);
  }
  if (sites.length === 0) return [];
  const noise = positionNoise(lattice, rng.fork('shape'), [5, 10], [1, 0.5]);
  const chosen: number[] = [];
  const chord = (a: number, b: number) => {
    const dx = positions[a * 3]! - positions[b * 3]!, dy = positions[a * 3 + 1]! - positions[b * 3 + 1]!, dz = positions[a * 3 + 2]! - positions[b * 3 + 2]!;
    return dx * dx + dy * dy + dz * dz;
  };
  for (let i = 0; i < count; i++) {
    // Prefer three-way junctions for about half of them; otherwise any two-plate border. Keep clear of earlier minors.
    const pool = triple.length > 0 && rng.next() < 0.5 ? triple : sites;
    let best = -1, bestGap = -1;
    for (let k = 0; k < 12; k++) {
      const cand = randomMember(lattice, pool, rng);
      let gap = Infinity;
      for (const o of chosen) gap = Math.min(gap, chord(cand, o));
      if (chosen.length === 0) gap = 1;
      if (gap > bestGap) { bestGap = gap; best = cand; }
    }
    if (best >= 0 && bestGap > 0.02) chosen.push(best); // about 900 km apart at least
  }
  // Each minor plate is an irregular, elongated patch around its centre (nearest centre wins): stretched along a random
  // direction, with its edge bent by noise at two scales, so none comes out round.
  const label = Int32Array.from(plateOf);
  const coarse = positionNoise(lattice, rng.fork('shape-coarse'), [3.5, 7], [1, 0.5]);
  const fine = positionNoise(lattice, rng.fork('shape-fine'), [10, 20], [1, 0.5]);
  const shape = chosen.map(() => {
    const angle = rng.next() * 3.141592653589793;
    return { ux: Math.cos(angle), uy: Math.sin(angle), long: 0.11 + 0.05 * rng.next(), stretch: 1.7 + 1.0 * rng.next() };
  });
  for (let v = 0; v < n; v++) {
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i]!;
      const sh = shape[i]!;
      // Offset from the centre in a local frame on the sphere (east/north at the centre).
      const cx = positions[c * 3]!, cy = positions[c * 3 + 1]!, cz = positions[c * 3 + 2]!;
      const dx = positions[v * 3]! - cx, dy = positions[v * 3 + 1]! - cy, dz = positions[v * 3 + 2]! - cz;
      if (dx * dx + dy * dy + dz * dz > 0.5) continue;
      let ex = -cy, ey = cx, ez = 0; // east
      const el = Math.sqrt(ex * ex + ey * ey) || 1;
      ex /= el; ey /= el;
      const nx = cy * ez - cz * ey, ny = cz * ex - cx * ez, nz = cx * ey - cy * ex; // north = centre x east (up to sign)
      const e = dx * ex + dy * ey + dz * ez, no = dx * nx + dy * ny + dz * nz;
      const along = e * sh.ux + no * sh.uy, across = -e * sh.uy + no * sh.ux;
      const score = Math.sqrt((along / sh.stretch) ** 2 + across ** 2) / (sh.long * (0.45 + 0.8 * coarse[v]! + 0.35 * fine[v]!));
      if (score < 1 && score < bestScore) { best = i; bestScore = score; }
    }
    if (best >= 0) label[v] = firstId + best;
  }
  // A minor plate must sit between at least two major plates (minor plates may touch one another); otherwise it is dropped.
  for (let i = 0; i < chosen.length; i++) {
    const id = firstId + i;
    const majors = new Set<number>();
    const touch = new Map<number, number>();
    for (let v = 0; v < n; v++) {
      if (label[v] !== id) continue;
      for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
        const o = label[lattice.neighbors[k]!]!;
        if (o === id) continue;
        if (o < firstId) majors.add(o);
        touch.set(o, (touch.get(o) ?? 0) + 1);
      }
    }
    if (majors.size >= 2) continue;
    let heir = -1, most = 0;
    for (const [o, c] of touch) if (c > most || (c === most && o < heir)) { heir = o; most = c; }
    if (heir >= 0) for (let v = 0; v < n; v++) if (label[v] === id) label[v] = heir;
  }
  plateOf.set(label);
  return chosen;
}

/** Share of the globe below which a plate that is nearly all enclosed by one other plate counts as an enclave. */
const ENCLAVE_SHARE = 0.03;
/** Share of a plate's border that must face one plate for it to count as enclosed. */
const ENCLAVE_BORDER = 0.85;

/**
 * A plate wholly (or, if small, almost wholly) inside another is not a plate the layout should start with: it joins the
 * plate around it, and the remaining plates are renumbered.
 */
function removeEnclaves(lattice: Lattice, plateOf: Int32Array, plates: readonly Plate[]): PlateSetup {
  const n = lattice.vertexCount;
  const gone = new Set<number>();
  for (;;) {
    const size = new Map<number, number>();
    const border = new Map<number, Map<number, number>>();
    for (let v = 0; v < n; v++) {
      const a = plateOf[v]!;
      size.set(a, (size.get(a) ?? 0) + 1);
      for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
        const b = plateOf[lattice.neighbors[k]!]!;
        if (b === a) continue;
        let m = border.get(a);
        if (!m) border.set(a, (m = new Map()));
        m.set(b, (m.get(b) ?? 0) + 1);
      }
    }
    let victim = -1, heir = -1;
    for (const id of [...size.keys()].sort((a, b) => a - b)) {
      const m = border.get(id);
      if (!m) continue;
      let total = 0, best = -1, bestCount = 0;
      for (const [o, c] of m) { total += c; if (c > bestCount || (c === bestCount && o < best)) { best = o; bestCount = c; } }
      const enclosed = m.size === 1 || (size.get(id)! / n < ENCLAVE_SHARE && bestCount / total >= ENCLAVE_BORDER);
      if (enclosed && (victim < 0 || size.get(id)! < size.get(victim)!)) { victim = id; heir = best; }
    }
    if (victim < 0 || size.size <= 2) break;
    for (let v = 0; v < n; v++) if (plateOf[v] === victim) plateOf[v] = heir;
    gone.add(victim);
  }
  if (gone.size === 0) return { plateOf, plates };
  const renumber = new Map<number, number>();
  const kept: Plate[] = [];
  for (const p of plates) if (!gone.has(p.id)) { renumber.set(p.id, kept.length); kept.push({ ...p, id: kept.length }); }
  for (let v = 0; v < n; v++) plateOf[v] = renumber.get(plateOf[v]!)!;
  return { plateOf, plates: kept };
}

/**
 * Keep each landmass wholly on one plate: a landmass a boundary cuts through goes to the plate that holds most
 * of it. Landmasses over `splitFraction` of the globe are left alone, since a supercontinent really does
 * span several plates. Changes `plateOf` in place.
 */
export function keepLandmassesWhole(world: WorldState, plateOf: Int32Array, splitFraction = DEFAULT_SPLIT_FRACTION): void {
  const n = world.lattice.vertexCount;
  for (const mass of findLandmasses(world)) {
    if (mass.points.length / n > splitFraction) continue;
    const counts = new Map<number, number>();
    for (const v of mass.points) counts.set(plateOf[v]!, (counts.get(plateOf[v]!) ?? 0) + 1);
    if (counts.size < 2) continue;
    let heir = -1;
    let most = 0;
    for (const [id, c] of counts) if (c > most || (c === most && id < heir)) { heir = id; most = c; }
    for (const v of mass.points) plateOf[v] = heir;
  }
  joinStrays(world.lattice, plateOf);
}

/** Reassigning landmasses can cut a few cells off from the rest of their plate: give each such piece to the plate it touches most. */
function joinStrays(lattice: Lattice, plateOf: Int32Array): void {
  const n = lattice.vertexCount;
  const piece = new Int32Array(n).fill(-1);
  const pieces: { plate: number; points: number[] }[] = [];
  for (let s = 0; s < n; s++) {
    if (piece[s]! >= 0) continue;
    const members: number[] = [];
    const stack = [s];
    piece[s] = pieces.length;
    while (stack.length > 0) {
      const v = stack.pop()!;
      members.push(v);
      for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
        const w = lattice.neighbors[k]!;
        if (piece[w]! < 0 && plateOf[w] === plateOf[s]) { piece[w] = pieces.length; stack.push(w); }
      }
    }
    pieces.push({ plate: plateOf[s]!, points: members });
  }
  const biggest = new Map<number, number>();
  for (let i = 0; i < pieces.length; i++) {
    const cur = biggest.get(pieces[i]!.plate);
    if (cur === undefined || pieces[i]!.points.length > pieces[cur]!.points.length) biggest.set(pieces[i]!.plate, i);
  }
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (biggest.get(p.plate) === i) continue;
    const touching = new Map<number, number>();
    for (const v of p.points) {
      for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
        const other = plateOf[lattice.neighbors[k]!]!;
        if (other !== p.plate) touching.set(other, (touching.get(other) ?? 0) + 1);
      }
    }
    let best = -1, bestCount = 0;
    for (const [id, c] of touching) if (c > bestCount || (c === bestCount && id < best)) { best = id; bestCount = c; }
    if (best >= 0) for (const v of p.points) plateOf[v] = best;
  }
}

/** Plates for a world: the seed's layout, with small landmasses kept whole. */
export function generatePlates(world: WorldState, seed: string, options: PlateOptions = {}): PlateSetup {
  const layout = layoutPlates(world.lattice, seed, options);
  const plateOf = Int32Array.from(layout.plateOf);
  keepLandmassesWhole(world, plateOf, options.splitFraction);
  return { plateOf, plates: layout.plates };
}

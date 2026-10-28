// Plate edits: add a plate, remove one, drag one. They act on the plates generated from the painted land,
// at the start of the run, and are described by positions on the sphere so they replay at any detail.
//
// Only + - * / sqrt are used, with fixed iteration order.

import type { Lattice } from './lattice';
import { MAX_THICKNESS, MIN_THICKNESS } from './crust';
import { LatticeIndex } from './latticeIndex';
import { eastNorth, plateOmega } from './motion';
import { smoothedNoise, type Plate, type PlateSetup } from './plates';
import { createRng } from './rng';
import { OCEAN_THICKNESS, type AddPlateEdit, type DragPlateEdit, type PaintPlateEdit, type PlateEdit, type PlateMotionEdit, type RemovePlateEdit, type SplitPlateEdit, type WorldState } from './world';

/** Amplitude (km) of the seeded noise laid over crust filled in from the surroundings. */
const FILL_NOISE_KM = 1.5;

export interface Prepared {
  readonly world: WorldState;
  readonly setup: PlateSetup;
}

type Vec = readonly [number, number, number];

/**
 * Applies plate edits one at a time to a working copy of the world and its plates. The working copy's
 * `state` and `plateOf` keep their identity, so other edits (painting, generating land) can act on them
 * between plate edits and everything replays in the order it happened.
 */
export class PlateEditor {
  /** Lattice and crust thickness; thickness is changed in place. */
  readonly state: WorldState;
  readonly plateOf: Int32Array;
  readonly plates: Plate[];
  private readonly lattice: Lattice;
  private readonly index: LatticeIndex;
  private readonly fillNoise: Float64Array;
  private splitNoise: Float64Array | null = null;
  private readonly seed: string;

  constructor(world: WorldState, setup: PlateSetup, seed: string) {
    this.lattice = world.lattice;
    this.state = { lattice: world.lattice, thickness: Float64Array.from(world.thickness) };
    this.plateOf = Int32Array.from(setup.plateOf);
    this.plates = [...setup.plates];
    this.seed = seed;
    this.index = new LatticeIndex(world.lattice);
    this.fillNoise = smoothedNoise(world.lattice, createRng(seed).fork('fill-noise'));
  }

  apply(edit: PlateEdit): void {
    const { lattice, index, plateOf, plates, fillNoise } = this;
    const thickness = this.state.thickness;
    if (edit.kind === 'addPlate') {
      addPlate(lattice, edit, plateOf, plates);
    } else if (edit.kind === 'paintPlate') {
      paintPlate(lattice, index, edit, plateOf);
    } else if (edit.kind === 'splitPlate') {
      this.splitNoise ??= smoothedNoise(lattice, createRng(this.seed).fork('split-noise'), 6);
      splitPlate(lattice, index, edit, plateOf, plates, this.splitNoise);
    } else if (edit.kind === 'plateMotion') {
      const id = plateOf[index.nearest(edit.at[0], edit.at[1], edit.at[2])]!;
      plates[id] = setPlateMotion(lattice, plateOf, plates[id]!, edit);
    } else if (edit.kind === 'removePlate') {
      const at = index.nearest(edit.at[0], edit.at[1], edit.at[2]);
      removePlate(lattice, plateOf[at]!, edit, plateOf, thickness, fillNoise);
    } else {
      const moved = dragPlate(lattice, index, edit, plateOf, thickness, fillNoise);
      if (moved) {
        plateOf.set(moved.plateOf);
        thickness.set(moved.thickness);
      }
    }
  }

  result(): Prepared {
    return { world: this.state, setup: { plateOf: this.plateOf, plates: this.plates } };
  }
}

export function applyPlateEdits(world: WorldState, setup: PlateSetup, edits: readonly PlateEdit[], seed: string): Prepared {
  const editor = new PlateEditor(world, setup, seed);
  for (const edit of edits) editor.apply(edit);
  return editor.result();
}

/** The middle of a plate: the mean direction of its points (a pole if it somehow wraps the globe). */
export function plateCentroid(lattice: Lattice, plateOf: ArrayLike<number>, id: number): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (let v = 0; v < lattice.vertexCount; v++) {
    if (plateOf[v] !== id) continue;
    x += lattice.positions[v * 3]!; y += lattice.positions[v * 3 + 1]!; z += lattice.positions[v * 3 + 2]!;
  }
  const l = Math.sqrt(x * x + y * y + z * z);
  return l > 1e-9 ? [x / l, y / l, z / l] : [0, 0, 1];
}

/** The plate with its drift speed and spin set, keeping the way it was heading (east if it was not going anywhere). */
function setPlateMotion(lattice: Lattice, plateOf: ArrayLike<number>, plate: Plate, edit: PlateMotionEdit): Plate {
  const c = plateCentroid(lattice, plateOf, plate.id);
  const w: [number, number, number] = [plate.axis[0] * plate.angularSpeed, plate.axis[1] * plate.angularSpeed, plate.axis[2] * plate.angularSpeed];
  // The drift velocity of the centre is omega x centre; its east and north parts give the heading.
  const vx = w[1] * c[2] - w[2] * c[1], vy = w[2] * c[0] - w[0] * c[2], vz = w[0] * c[1] - w[1] * c[0];
  const { east, north } = eastNorth(c);
  const heading: [number, number] = [vx * east[0] + vy * east[1] + vz * east[2], vx * north[0] + vy * north[1] + vz * north[2]];
  const moving = heading[0] * heading[0] + heading[1] * heading[1] > 1e-14;
  const next = plateOmega(c, moving ? heading : [1, 0], edit.speed, edit.spin);
  const len = Math.sqrt(next[0] * next[0] + next[1] * next[1] + next[2] * next[2]);
  return { ...plate, axis: len > 0 ? [next[0] / len, next[1] / len, next[2] / len] : plate.axis, angularSpeed: len };
}

function paintPlate(lattice: Lattice, index: LatticeIndex, edit: PaintPlateEdit, plateOf: Int32Array): void {
  const id = plateOf[index.nearest(edit.from[0], edit.from[1], edit.from[2])]!;
  const r2 = edit.radius * edit.radius;
  const { positions } = lattice;
  for (let i = 0; i + 2 < edit.dabs.length; i += 3) {
    const cx = edit.dabs[i]!, cy = edit.dabs[i + 1]!, cz = edit.dabs[i + 2]!;
    for (let v = 0; v < lattice.vertexCount; v++) {
      const dx = positions[v * 3]! - cx, dy = positions[v * 3 + 1]! - cy, dz = positions[v * 3 + 2]! - cz;
      if (dx * dx + dy * dy + dz * dz < r2) plateOf[v] = id;
    }
  }
}

function addPlate(lattice: Lattice, edit: AddPlateEdit, plateOf: Int32Array, plates: Plate[]): void {
  const id = plates.length;
  const r2 = edit.radius * edit.radius;
  let seed = -1;
  let seedD = Infinity;
  const { positions } = lattice;
  for (let v = 0; v < lattice.vertexCount; v++) {
    const dx = positions[v * 3]! - edit.center[0], dy = positions[v * 3 + 1]! - edit.center[1], dz = positions[v * 3 + 2]! - edit.center[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < r2) plateOf[v] = id;
    if (d2 < seedD) {
      seedD = d2;
      seed = v;
    }
  }
  // The drift the arrow gave, plus any spin about the new plate's own centre.
  const spin = edit.spin ?? 0;
  const wx = edit.axis[0] * edit.angularSpeed + edit.center[0] * spin;
  const wy = edit.axis[1] * edit.angularSpeed + edit.center[1] * spin;
  const wz = edit.axis[2] * edit.angularSpeed + edit.center[2] * spin;
  const total = Math.sqrt(wx * wx + wy * wy + wz * wz);
  plates.push({ id, seedVertex: seed, axis: spin === 0 || total === 0 ? [edit.axis[0], edit.axis[1], edit.axis[2]] : [wx / total, wy / total, wz / total], angularSpeed: spin === 0 || total === 0 ? edit.angularSpeed : total });
}

/**
 * Fill the unknown vertices' crust from the known ones around them: wave by wave inward, each new vertex
 * the mean of its known neighbours, plus a little seeded noise. Seafloor stays seafloor and land edges slope off.
 */
function blendFill(lattice: Lattice, thickness: Float64Array, unknown: Uint8Array, noise: Float64Array): void {
  const left = new Uint8Array(unknown);
  let remaining = left.reduce((a, b) => a + b, 0);
  const filled: number[] = [];
  while (remaining > 0) {
    const wave: number[] = [];
    const values: number[] = [];
    for (let v = 0; v < lattice.vertexCount; v++) {
      if (!left[v]) continue;
      let sum = 0, known = 0;
      for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
        const w = lattice.neighbors[k]!;
        if (!left[w]) { sum += thickness[w]!; known++; }
      }
      if (known > 0) { wave.push(v); values.push(sum / known); }
    }
    if (wave.length === 0) {
      // Nothing known to blend from (the whole world was unknown): fall back to seafloor.
      for (let v = 0; v < lattice.vertexCount; v++) if (left[v]) { thickness[v] = OCEAN_THICKNESS; left[v] = 0; filled.push(v); }
      break;
    }
    wave.forEach((v, i) => { thickness[v] = values[i]!; left[v] = 0; filled.push(v); });
    remaining -= wave.length;
  }
  for (const v of filled) {
    thickness[v] = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, thickness[v]! + (noise[v]! - 0.5) * 2 * FILL_NOISE_KM));
  }
}

/**
 * Hands a removed plate's vertices to its neighbours by growing them inward from the border, a ring at a time,
 * each vertex joining the plate most of its already-claimed neighbours belong to. Each neighbour ends up with
 * a share about as big as the border it has with the removed plate. False if there was nobody to give them to.
 */
function shareOut(lattice: Lattice, plateOf: Int32Array, members: Uint8Array, id: number): boolean {
  const n = lattice.vertexCount;
  const claimed = new Uint8Array(n);
  let remaining = 0;
  for (let v = 0; v < n; v++) { if (members[v]) remaining++; else claimed[v] = 1; }
  const heirs = new Int32Array(n).fill(-1);
  while (remaining > 0) {
    const wave: number[] = [];
    const winners: number[] = [];
    for (let v = 0; v < n; v++) {
      if (!members[v] || claimed[v]) continue;
      const votes = new Map<number, number>();
      for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
        const w = lattice.neighbors[k]!;
        if (!claimed[w]) continue;
        const q = members[w] ? heirs[w]! : plateOf[w]!;
        votes.set(q, (votes.get(q) ?? 0) + 1);
      }
      let best = -1, bestVotes = 0;
      for (const [q, c] of votes) if (c > bestVotes || (c === bestVotes && q < best)) { best = q; bestVotes = c; }
      if (best >= 0) { wave.push(v); winners.push(best); }
    }
    if (wave.length === 0) return false; // no other plate to give it to
    wave.forEach((v, i) => { heirs[v] = winners[i]!; claimed[v] = 1; });
    remaining -= wave.length;
  }
  for (let v = 0; v < n; v++) if (members[v]) plateOf[v] = heirs[v]!;
  return true;
}

/** Pulls apart the two halves a split makes, as a rift would: each gets a nudge of rotation away from the other. */
const SPLIT_DRIFT = 0.4;

function splitPlate(lattice: Lattice, index: LatticeIndex, edit: SplitPlateEdit, plateOf: Int32Array, plates: Plate[], noise: Float64Array): void {
  const id = plateOf[index.nearest(edit.at[0], edit.at[1], edit.at[2])]!;
  const { positions } = lattice;
  const members: number[] = [];
  for (let v = 0; v < lattice.vertexCount; v++) if (plateOf[v] === id) members.push(v);
  if (members.length < 2) return;

  // Centre of the plate.
  let cx = 0, cy = 0, cz = 0;
  for (const v of members) { cx += positions[v * 3]!; cy += positions[v * 3 + 1]!; cz += positions[v * 3 + 2]!; }
  let len = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (len < 1e-9) return;
  cx /= len; cy /= len; cz /= len;

  // Its long axis: the main direction of spread, over the surface around the centre (power iteration on the covariance).
  let sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
  for (const v of members) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    const d = x * cx + y * cy + z * cz;
    const qx = x - d * cx, qy = y - d * cy, qz = z - d * cz;
    sxx += qx * qx; sxy += qx * qy; sxz += qx * qz; syy += qy * qy; syz += qy * qz; szz += qz * qz;
  }
  // Start from a direction across the centre vector.
  let dx = cy, dy = -cx, dz = 0;
  if (dx * dx + dy * dy < 1e-6) { dx = 1; dy = 0; dz = 0; }
  for (let i = 0; i < 40; i++) {
    let nx = sxx * dx + sxy * dy + sxz * dz, ny = sxy * dx + syy * dy + syz * dz, nz = sxz * dx + syz * dy + szz * dz;
    const dot = nx * cx + ny * cy + nz * cz;
    nx -= dot * cx; ny -= dot * cy; nz -= dot * cz;
    len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) break;
    dx = nx / len; dy = ny / len; dz = nz / len;
  }

  // Distance along the long axis, wobbled by smooth noise so the edge wanders; the median splits it in half.
  const along = new Float64Array(members.length);
  let sq = 0;
  members.forEach((v, i) => {
    along[i] = positions[v * 3]! * dx + positions[v * 3 + 1]! * dy + positions[v * 3 + 2]! * dz;
    sq += along[i]! * along[i]!;
  });
  const wobble = Math.sqrt(sq / members.length) * 1.6;
  const warped = new Float64Array(members.length);
  members.forEach((v, i) => { warped[i] = along[i]! + (noise[v]! - 0.5) * wobble; });
  const median = Float64Array.from(warped).sort()[members.length >> 1]!;

  const other = plates.length;
  let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
  let nA = 0, nB = 0;
  members.forEach((v, i) => {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    if (warped[i]! > median) { plateOf[v] = other; bx += x; by += y; bz += z; nB++; } else { ax += x; ay += y; az += z; nA++; }
  });
  if (nA === 0 || nB === 0) { for (const v of members) plateOf[v] = id; return; }
  const unit = (x: number, y: number, z: number): [number, number, number] => {
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  };
  const cA = unit(ax, ay, az), cB = unit(bx, by, bz);

  // Each half keeps the old rotation, plus a nudge that moves it away from the other along the long axis.
  const old = plates[id]!;
  const drift = (c: readonly [number, number, number], sign: number): Plate => {
    const k = old.angularSpeed * SPLIT_DRIFT * sign;
    const wx = old.axis[0] * old.angularSpeed + (c[1] * dz - c[2] * dy) * k;
    const wy = old.axis[1] * old.angularSpeed + (c[2] * dx - c[0] * dz) * k;
    const wz = old.axis[2] * old.angularSpeed + (c[0] * dy - c[1] * dx) * k;
    const speed = Math.sqrt(wx * wx + wy * wy + wz * wz);
    return { ...old, axis: speed > 0 ? [wx / speed, wy / speed, wz / speed] : old.axis, angularSpeed: Math.max(speed, 0.0025) };
  };
  const nearestTo = (c: readonly [number, number, number], side: number): number => {
    let best = -1, bestDot = -Infinity;
    for (const v of members) {
      if (plateOf[v] !== side) continue;
      const d = positions[v * 3]! * c[0] + positions[v * 3 + 1]! * c[1] + positions[v * 3 + 2]! * c[2];
      if (d > bestDot) { bestDot = d; best = v; }
    }
    return best;
  };
  plates[id] = { ...drift(cA, -1), seedVertex: nearestTo(cA, id) };
  plates.push({ ...drift(cB, 1), id: other, seedVertex: nearestTo(cB, other) });
}

function removePlate(lattice: Lattice, id: number, edit: RemovePlateEdit, plateOf: Int32Array, thickness: Float64Array, noise: Float64Array): void {
  const members = new Uint8Array(lattice.vertexCount);
  let count = 0;
  for (let v = 0; v < lattice.vertexCount; v++) if (plateOf[v] === id) { members[v] = 1; count++; }
  if (count === 0) return;
  if (!shareOut(lattice, plateOf, members, id)) return; // the only plate: nothing to give it to
  if (edit.mode === 'reset') blendFill(lattice, thickness, members, noise);
}

function dragPlate(
  lattice: Lattice, index: LatticeIndex, edit: DragPlateEdit, plateOf: Int32Array, thickness: Float64Array, noise: Float64Array,
): { plateOf: Int32Array; thickness: Float64Array } | null {
  const [ax, ay, az] = edit.from, [bx, by, bz] = edit.to;
  // Rotation taking from to to: axis = from x to, cos = from . to, sin = |from x to|. No trigonometry needed.
  let kx = ay * bz - az * by, ky = az * bx - ax * bz, kz = ax * by - ay * bx;
  const sin = Math.sqrt(kx * kx + ky * ky + kz * kz);
  if (sin < 1e-9) return null;
  kx /= sin; ky /= sin; kz /= sin;
  const cos = ax * bx + ay * by + az * bz;

  const id = plateOf[index.nearest(ax, ay, az)]!;
  const { positions } = lattice;
  const n = lattice.vertexCount;
  const nextPlate = Int32Array.from(plateOf);
  const nextThickness = Float64Array.from(thickness);
  const covered = new Uint8Array(n);

  for (let v = 0; v < n; v++) {
    // Where did this spot come from? Rotate it back by the same angle the other way.
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    const dot = kx * x + ky * y + kz * z;
    const cx = ky * z - kz * y, cy = kz * x - kx * z, cz = kx * y - ky * x;
    const px = x * cos - cx * sin + kx * dot * (1 - cos);
    const py = y * cos - cy * sin + ky * dot * (1 - cos);
    const pz = z * cos - cz * sin + kz * dot * (1 - cos);
    const from = index.nearest(px, py, pz);
    if (plateOf[from] === id) {
      covered[v] = 1;
      nextPlate[v] = id;
      nextThickness[v] = thickness[from]!;
    }
  }

  // Ground the plate left behind goes to the neighbours that border it, with crust blended in from them.
  const vacated = new Uint8Array(n);
  for (let v = 0; v < n; v++) if (plateOf[v] === id && !covered[v]) vacated[v] = 1;
  if (vacated.some((x) => x === 1)) {
    const heirs = new Int32Array(n).fill(-1);
    // Each vacated vertex joins the nearest-by-wave surviving plate: grow outward from what is still owned.
    const owned = new Uint8Array(n);
    for (let v = 0; v < n; v++) if (!vacated[v]) owned[v] = 1;
    let remaining = vacated.reduce((a, b) => a + b, 0);
    while (remaining > 0) {
      const wave: number[] = [];
      const winners: number[] = [];
      for (let v = 0; v < n; v++) {
        if (!vacated[v] || owned[v]) continue;
        const votes = new Map<number, number>();
        for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
          const w = lattice.neighbors[k]!;
          if (!owned[w]) continue;
          const q = heirs[w]! >= 0 ? heirs[w]! : nextPlate[w]!;
          if (q !== id || heirs[w]! >= 0) votes.set(q, (votes.get(q) ?? 0) + 1);
        }
        let best = -1, bestVotes = 0;
        for (const [q, c] of votes) if (c > bestVotes || (c === bestVotes && q < best)) { best = q; bestVotes = c; }
        if (best >= 0) { wave.push(v); winners.push(best); }
      }
      if (wave.length === 0) break;
      wave.forEach((v, i) => { heirs[v] = winners[i]!; owned[v] = 1; });
      remaining -= wave.length;
    }
    for (let v = 0; v < n; v++) if (vacated[v] && heirs[v]! >= 0) nextPlate[v] = heirs[v]!;
    blendFill(lattice, nextThickness, vacated, noise);
  }
  return { plateOf: nextPlate, thickness: nextThickness };
}

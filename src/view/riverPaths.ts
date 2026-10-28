// Turns the river network (each vertex pointing at the one it drains to) into smooth, winding lines.
//
// Each hop between vertices becomes a curve through its neighbours (so a river flows smoothly through a junction rather
// than kinking at every vertex), with a meander added on top. Meanders follow the ground: steep rivers cut straight
// through hard rock, while rivers on flat, soft ground wander across their floodplain.

import type { Lattice } from '../sim/lattice';

export interface RiverHop {
  /** The vertex the hop starts at and the one it flows to. */
  readonly from: number;
  readonly to: number;
  /** River flow (m^3/s) leaving `from`. */
  readonly discharge: number;
  /** Points along the hop as unit-sphere x, y, z triples, the first at `from` and the last at `to`. */
  readonly points: Float64Array;
}

const EARTH_RADIUS_M = 6371000;
/** Sideways wander as a share of hop length, for a river on level, soft ground. */
const MAX_MEANDER = 0.4;
/** Gradient (drop per distance) at which a river's meander has halved. */
const GRADIENT_HALF = 0.0006;
const SAMPLES = 6;

const hash = (v: number, salt: number): number => (Math.imul(v + salt * 7919, 2654435761) >>> 0) / 4294967296;

/** How freely a river wanders on this rock: 0.1 on hard crystalline rock, 1 on soft sediment. */
export function meanderSoftness(erodibility: number): number {
  return Math.min(1, Math.max(0.1, (erodibility - 0.25) / 1.6));
}

/**
 * The winding path of every hop whose flow is at least `threshold`.
 * `elevation` is metres above sea level (used for the gradient); `erodibility` is optional per-vertex rock softness.
 */
export function riverPaths(
  lattice: Lattice,
  flowTo: ArrayLike<number>,
  discharge: ArrayLike<number>,
  elevation: ArrayLike<number>,
  threshold: number,
  erodibility?: ArrayLike<number>,
): RiverHop[] {
  const n = lattice.vertexCount;
  const { positions } = lattice;
  const at = (v: number): [number, number, number] => [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];

  // The biggest tributary into each vertex: the river's upstream direction there.
  const upstream = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    const to = flowTo[v]!;
    if (to < 0 || discharge[v]! < threshold) continue;
    if (upstream[to]! < 0 || discharge[v]! > discharge[upstream[to]!]!) upstream[to] = v;
  }

  const hops: RiverHop[] = [];
  for (let v = 0; v < n; v++) {
    const to = flowTo[v]!;
    if (to < 0 || discharge[v]! < threshold) continue;
    const p1 = at(v), p2 = at(to);
    const p0 = upstream[v]! >= 0 ? at(upstream[v]!) : ([2 * p1[0] - p2[0], 2 * p1[1] - p2[1], 2 * p1[2] - p2[2]] as [number, number, number]);
    const next = flowTo[to]!;
    const p3 = next >= 0 ? at(next) : ([2 * p2[0] - p1[0], 2 * p2[1] - p1[1], 2 * p2[2] - p1[2]] as [number, number, number]);

    const dx = p2[0] - p1[0], dy = p2[1] - p1[1], dz = p2[2] - p1[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const drop = Math.max(0, elevation[v]! - Math.max(elevation[to]!, 0));
    const gradient = len > 0 ? drop / (len * EARTH_RADIUS_M) : 0;
    const flat = 1 / (1 + gradient / GRADIENT_HALF);
    const soft = erodibility ? meanderSoftness((erodibility[v]! + erodibility[to]!) / 2) : 0.6;
    const amplitude = len * MAX_MEANDER * flat * soft;
    const sign1 = hash(v, 1) < 0.5 ? -1 : 1;
    const sign2 = hash(v, 2) < 0.5 ? -1 : 1;

    const points = new Float64Array((SAMPLES + 1) * 3);
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const t2 = t * t, t3 = t2 * t;
      const c: number[] = [0, 0, 0];
      // Catmull-Rom through p1 and p2, guided by p0 and p3.
      for (let k = 0; k < 3; k++) c[k] = 0.5 * (2 * p1[k]! + (-p0[k]! + p2[k]!) * t + (2 * p0[k]! - 5 * p1[k]! + 4 * p2[k]! - p3[k]!) * t2 + (-p0[k]! + 3 * p1[k]! - 3 * p2[k]! + p3[k]!) * t3);
      // Meander: zero at both ends so hops join up, a main bend plus a smaller counter-bend.
      const offset = amplitude * (sign1 * Math.sin(Math.PI * t) + 0.4 * sign2 * Math.sin(2 * Math.PI * t));
      const cl = Math.sqrt(c[0]! * c[0]! + c[1]! * c[1]! + c[2]! * c[2]!);
      const cx = c[0]! / cl, cy = c[1]! / cl, cz = c[2]! / cl;
      // Sideways = hop direction crossed with the local up.
      let sx = dy * cz - dz * cy, sy = dz * cx - dx * cz, sz = dx * cy - dy * cx;
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      sx /= sl; sy /= sl; sz /= sl;
      const x = cx + sx * offset, y = cy + sy * offset, z = cz + sz * offset;
      const l = Math.sqrt(x * x + y * y + z * z);
      points[i * 3] = x / l;
      points[i * 3 + 1] = y / l;
      points[i * 3 + 2] = z / l;
    }
    hops.push({ from: v, to, discharge: discharge[v]!, points });
  }
  return hops;
}

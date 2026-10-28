// What the plate boundaries are doing, and how far every point is from them.
//
// For each boundary point: how fast the two plates are closing or opening there and how fast they slide past
// each other, from the plates' own rotations. Each point then takes the values of the nearest boundary point on
// its own plate, and its distance to it. Terrain building and geology both read this.
//
// Only + - * / sqrt are used, with fixed iteration order.

import { SEA_LEVEL_THICKNESS } from './crust';
import type { Lattice } from './lattice';
import { Heap, type Plate } from './plates';

const EARTH_RADIUS_KM = 6371;

export interface BoundaryInfo {
  /** Distance in km from each point to the nearest boundary of its own plate (5000 where the plate has none). */
  readonly distanceKm: Float64Array;
  /** The boundary point each point is nearest to, or -1. */
  readonly source: Int32Array;
  /** At boundary points: closing speed (rad/My, positive where the plates converge, negative where they part). */
  readonly closing: Float64Array;
  /** At boundary points: speed of the plates sliding past each other (rad/My). */
  readonly shear: Float64Array;
  /** At boundary points: share of the neighbours across the boundary that are land. */
  readonly otherLand: Float64Array;
  /** At boundary points: the plate on the other side (the one with most neighbours), or -1. */
  readonly otherPlate: Int32Array;
}

export function analyzeBoundaries(lattice: Lattice, plateOf: Int32Array, plates: readonly Plate[], thickness: ArrayLike<number>): BoundaryInfo {
  const n = lattice.vertexCount;
  const { positions, offsets, neighbors } = lattice;

  const omega = new Float64Array(plates.length * 3);
  for (const p of plates) {
    omega[p.id * 3] = p.axis[0] * p.angularSpeed;
    omega[p.id * 3 + 1] = p.axis[1] * p.angularSpeed;
    omega[p.id * 3 + 2] = p.axis[2] * p.angularSpeed;
  }

  const closing = new Float64Array(n);
  const shear = new Float64Array(n);
  const otherLand = new Float64Array(n);
  const otherPlate = new Int32Array(n).fill(-1);
  const isBoundary = new Uint8Array(n);

  for (let v = 0; v < n; v++) {
    const a = plateOf[v]!;
    const px = positions[v * 3]!, py = positions[v * 3 + 1]!, pz = positions[v * 3 + 2]!;
    let count = 0, closeSum = 0, shearSum = 0, landSum = 0;
    const votes = new Map<number, number>();
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const u = neighbors[k]!;
      const b = plateOf[u]!;
      if (b === a) continue;
      // Relative velocity of plate a against plate b at the middle of this pair.
      let mx = px + positions[u * 3]!, my = py + positions[u * 3 + 1]!, mz = pz + positions[u * 3 + 2]!;
      const ml = Math.sqrt(mx * mx + my * my + mz * mz);
      mx /= ml; my /= ml; mz /= ml;
      const wx = omega[a * 3]! - omega[b * 3]!, wy = omega[a * 3 + 1]! - omega[b * 3 + 1]!, wz = omega[a * 3 + 2]! - omega[b * 3 + 2]!;
      const rx = wy * mz - wz * my, ry = wz * mx - wx * mz, rz = wx * my - wy * mx;
      // Direction from a toward b along the surface.
      let dx = positions[u * 3]! - px, dy = positions[u * 3 + 1]! - py, dz = positions[u * 3 + 2]! - pz;
      const radial = dx * mx + dy * my + dz * mz;
      dx -= radial * mx; dy -= radial * my; dz -= radial * mz;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dl === 0) continue;
      const c = (rx * dx + ry * dy + rz * dz) / dl;
      const r2 = rx * rx + ry * ry + rz * rz;
      closeSum += c;
      shearSum += Math.sqrt(Math.max(0, r2 - c * c));
      landSum += thickness[u]! > SEA_LEVEL_THICKNESS ? 1 : 0;
      votes.set(b, (votes.get(b) ?? 0) + 1);
      count++;
    }
    if (count === 0) continue;
    isBoundary[v] = 1;
    closing[v] = closeSum / count;
    shear[v] = shearSum / count;
    otherLand[v] = landSum / count;
    let best = -1, bestVotes = 0;
    for (const [b, c] of votes) if (c > bestVotes || (c === bestVotes && b < best)) { best = b; bestVotes = c; }
    otherPlate[v] = best;
  }

  // Distance to the nearest boundary of the same plate, by Dijkstra over the lattice.
  const distanceKm = new Float64Array(n).fill(Infinity);
  const source = new Int32Array(n).fill(-1);
  const heap = new Heap();
  for (let v = 0; v < n; v++) {
    if (!isBoundary[v]) continue;
    distanceKm[v] = 0;
    source[v] = v;
    heap.push(0, v, 0);
  }
  while (heap.size > 0) {
    const [d, v] = heap.pop();
    if (d > distanceKm[v]!) continue;
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const w = neighbors[k]!;
      if (plateOf[w] !== plateOf[v]) continue;
      const dx = positions[v * 3]! - positions[w * 3]!, dy = positions[v * 3 + 1]! - positions[w * 3 + 1]!, dz = positions[v * 3 + 2]! - positions[w * 3 + 2]!;
      const nd = d + Math.sqrt(dx * dx + dy * dy + dz * dz) * EARTH_RADIUS_KM;
      if (nd < distanceKm[w]!) {
        distanceKm[w] = nd;
        source[w] = source[v]!;
        heap.push(nd, w, 0);
      }
    }
  }
  for (let v = 0; v < n; v++) if (source[v]! < 0) distanceKm[v] = 5000;

  return { distanceKm, source, closing, shear, otherLand, otherPlate };
}

// A single cell of sea with land all round it is not a believable sea: it is a bay's worth of noise. Raise such cells
// to the height of the land around them (a real depression this small would be a lake, which the water layer draws).
//
// Only + - * / are used, with fixed iteration order.

import { SEA_LEVEL_THICKNESS } from './crust';
import type { Lattice } from './lattice';

/** Raise every sea cell with at most one non-land neighbour to the mean thickness of its land neighbours. Returns how many. */
export function fillLoneWater(lattice: Lattice, thickness: { [index: number]: number; readonly length: number }): number {
  const { offsets, neighbors } = lattice;
  let filled = 0;
  for (let pass = 0; pass < 2; pass++) {
    const raise: number[] = [];
    const to: number[] = [];
    for (let v = 0; v < lattice.vertexCount; v++) {
      if (thickness[v]! > SEA_LEVEL_THICKNESS) continue;
      let land = 0, total = 0, sum = 0;
      for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
        total++;
        const t = thickness[neighbors[k]!]!;
        if (t > SEA_LEVEL_THICKNESS) { land++; sum += t; }
      }
      if (land >= total - 1 && land > 0) { raise.push(v); to.push(Math.max(SEA_LEVEL_THICKNESS + 0.2, sum / land)); }
    }
    if (raise.length === 0) break;
    for (let i = 0; i < raise.length; i++) thickness[raise[i]!] = to[i]!;
    filled += raise.length;
  }
  return filled;
}

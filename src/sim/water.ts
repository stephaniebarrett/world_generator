// Rivers and lakes on the lattice.
//
// Priority-flood fills every depression up to its spill height (those fills are the lakes) and
// leaves each vertex pointing downstream toward the sea. Rainfall becomes runoff, and runoff is
// summed downstream into river discharge. Deterministic: ties break by vertex index.

import { cellKm } from './climate';
import { ROCK } from './crust';
import type { Lattice } from './lattice';
import { Heap } from './plates';

export interface Water {
  /** Vertex that water leaves each vertex toward; -1 for the sea (and for an outlet with no lower neighbour). */
  readonly flowTo: Int32Array;
  /** River discharge in cubic metres per second: runoff from everything upstream. */
  readonly discharge: Float32Array;
  /** 1 where a depression holds a lake. */
  readonly lake: Uint8Array;
}

/** Shallowest filled depression (metres) that counts as a lake; smaller ones are just damp ground. */
const MIN_LAKE_DEPTH = 5;
/** Metres added per hop so flat filled areas still drain in a definite direction. */
const FLAT_EPSILON = 1e-3;
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/**
 * Fraction of rain that runs off (the rest evaporates or soaks in): none in deserts, more where it is wet.
 * Fitted so that about 38% of the rain that falls on land reaches the sea, as on Earth (270 of 715 mm/yr).
 */
export function runoffFraction(precipitationMm: number): number {
  return Math.min(0.5, Math.max(0, (precipitationMm - 250) / 2400));
}

/**
 * Share of rain that runs off limestone ground: the rest sinks into sinkholes and caves (karst), so rivers there are small or
 * vanish underground and rise again as springs farther down.
 */
export const KARST_RUNOFF = 0.35;

/** `rock` (optional, per vertex) lets limestone swallow part of its rain. */
export function computeWater(lattice: Lattice, elevation: ArrayLike<number>, precipitation: ArrayLike<number>, rock?: ArrayLike<number>): Water {
  const n = lattice.vertexCount;
  const { offsets, neighbors } = lattice;

  const filled = new Float64Array(n);
  const flowTo = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const order: number[] = []; // vertices in the order the flood reached them
  const heap = new Heap();

  for (let v = 0; v < n; v++) {
    if (elevation[v]! <= 0) {
      seen[v] = 1;
      filled[v] = elevation[v]!;
      heap.push(filled[v]!, v, 0);
    }
  }
  if (heap.size === 0) {
    // A planet with no sea: let the lowest point drain the world, like an inland sea.
    let low = 0;
    for (let v = 1; v < n; v++) if (elevation[v]! < elevation[low]!) low = v;
    seen[low] = 1;
    filled[low] = elevation[low]!;
    heap.push(filled[low]!, low, 0);
  }

  while (heap.size > 0) {
    const [, v] = heap.pop();
    order.push(v);
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const w = neighbors[k]!;
      if (seen[w]) continue;
      seen[w] = 1;
      filled[w] = Math.max(elevation[w]!, filled[v]! + FLAT_EPSILON);
      flowTo[w] = v;
      heap.push(filled[w]!, w, 0);
    }
  }

  const lake = new Uint8Array(n);
  for (let v = 0; v < n; v++) if (elevation[v]! > 0 && filled[v]! - elevation[v]! > MIN_LAKE_DEPTH) lake[v] = 1;

  // Runoff per cell, as a flow in cubic metres per second.
  const km = cellKm(lattice);
  const areaKm2 = 0.866 * km * km;
  const discharge = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    if (elevation[v]! <= 0) continue;
    const mm = precipitation[v]! * runoffFraction(precipitation[v]!) * (rock && rock[v] === ROCK.limestone ? KARST_RUNOFF : 1);
    discharge[v] = (mm * areaKm2 * 1000) / SECONDS_PER_YEAR; // mm x km^2 = 1000 m^3
  }
  // Furthest from the sea first, so every vertex has everything upstream before it passes its flow on.
  for (let i = order.length - 1; i >= 0; i--) {
    const v = order[i]!;
    const to = flowTo[v]!;
    if (to >= 0) discharge[to] = discharge[to]! + discharge[v]!;
  }

  return { flowTo, discharge: Float32Array.from(discharge), lake };
}

// Random choices that come out the same at every detail level. Picking a random vertex by number lands somewhere different on a finer
// lattice, so a seed would give a different world at each detail. Picking a random direction and snapping to the nearest candidate
// lands in the same place whatever the lattice, to within a cell.
//
// Only + - * / sqrt are used, with a fixed order.

import type { Lattice } from './lattice';
import type { Rng } from './rng';

/** A random direction, uniform over the sphere. */
export function randomDirection(rng: Rng): [number, number, number] {
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

/** The member of `pool` closest to a direction (ties go to the lower vertex). */
export function nearestInPool(lattice: Lattice, pool: readonly number[], dir: readonly [number, number, number]): number {
  const p = lattice.positions;
  let best = pool[0]!;
  let bestDot = -Infinity;
  for (const v of pool) {
    const d = p[v * 3]! * dir[0] + p[v * 3 + 1]! * dir[1] + p[v * 3 + 2]! * dir[2];
    if (d > bestDot) { bestDot = d; best = v; }
  }
  return best;
}

/** A random member of `pool`, chosen by where it is on the globe rather than by its number. */
export function randomMember(lattice: Lattice, pool: readonly number[], rng: Rng): number {
  return nearestInPool(lattice, pool, randomDirection(rng));
}

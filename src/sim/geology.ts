// Starting geology: what rock lies at each point, worked out from the land and the plates it sits on.
//
//  - Sea floor is basalt; the thick crust of continental shelves is sedimentary; island arcs are volcanic.
//  - Land far from any plate boundary is the old crystalline core of a continent (craton) where its noise map says so,
//    and sedimentary cover elsewhere (basins, margins, rifts).
//  - Squeezed crust (over 48 km) is metamorphic; land beside a subduction zone is volcanic arc.
//
// During a run the rock then changes as the plates act on it (see tectonics.ts).

import { analyzeBoundaries } from './boundaries';
import { METAMORPHIC_THICKNESS, ROCK, SEA_LEVEL_THICKNESS } from './crust';
import type { Lattice } from './lattice';
import type { Plate } from './plates';
import { hashSeed } from './rng';
import { fractalNoiseBands } from './roughness';

const SHELF_THICKNESS = 15;
/** Beyond this distance (km) from every boundary, land can be old craton. */
const CRATON_DISTANCE_KM = 800;
/** Land within this distance of a converging boundary, with sea on the other side, is volcanic arc. */
const ARC_DISTANCE_KM = 220;

/**
 * Limestone forms in warm shallow seas, so a patchy share of the sedimentary cover (about a third, more toward the tropics) is
 * carbonate. Such ground dissolves in rain, so it becomes karst (see water.ts and erosion in tectonics.ts).
 */
function isCarbonate(x: number, y: number, z: number, noiseSeed: number): boolean {
  const warm = 1 - Math.min(1, Math.abs(z) / 0.75);
  return fractalNoiseBands(x, y, z, noiseSeed + 31, [3, 6, 12], [1, 0.6, 0.3]) + 0.5 * warm > 0.45;
}

export function assignGeology(lattice: Lattice, thickness: ArrayLike<number>, plateOf: Int32Array, plates: readonly Plate[], seed: string): Uint8Array {
  const n = lattice.vertexCount;
  const info = analyzeBoundaries(lattice, plateOf, plates, thickness);
  const noiseSeed = hashSeed(`${seed}/geology`) | 0;
  const rock = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    const t = thickness[v]!;
    const x = lattice.positions[v * 3]!, y = lattice.positions[v * 3 + 1]!, z = lattice.positions[v * 3 + 2]!;
    const s = info.source[v]!;
    const d = info.distanceKm[v]!;
    const convergent = s >= 0 && info.closing[s]! > 0.002;

    if (t <= SEA_LEVEL_THICKNESS) {
      if (convergent && d < ARC_DISTANCE_KM && t > 12) rock[v] = ROCK.volcanic;
      else rock[v] = t > SHELF_THICKNESS ? (isCarbonate(x, y, z, noiseSeed) ? ROCK.limestone : ROCK.sedimentary) : ROCK.basalt;
      continue;
    }
    if (t > METAMORPHIC_THICKNESS) rock[v] = ROCK.metamorphic;
    else if (convergent && d < ARC_DISTANCE_KM && info.otherLand[s]! < 0.5) rock[v] = ROCK.volcanic;
    else if (d > CRATON_DISTANCE_KM && fractalNoiseBands(x, y, z, noiseSeed, [2, 4, 8], [1, 0.6, 0.3]) > -0.05) rock[v] = ROCK.craton;
    else rock[v] = isCarbonate(x, y, z, noiseSeed) ? ROCK.limestone : ROCK.sedimentary;
  }
  return rock;
}

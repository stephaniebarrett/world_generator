import { describe, expect, it } from 'vitest';
import { buildLattice } from '../sim/lattice';
import { riverPaths } from './riverPaths';

const lattice = buildLattice(12);
const n = lattice.vertexCount;
const from = 100;
const to = lattice.neighbors[lattice.offsets[from]!]!;
const flowTo = new Int32Array(n).fill(-1);
flowTo[from] = to;
const discharge = new Float32Array(n);
discharge[from] = 50;

/** Greatest sideways distance (unit sphere) of a hop from the straight line between its ends. */
function wander(elev: number, erod: number): number {
  const elevation = new Float64Array(n).fill(0);
  elevation[from] = elev;
  const [hop] = riverPaths(lattice, flowTo, discharge, elevation, 1, new Float64Array(n).fill(erod));
  const p = hop!.points;
  const ax = p[0]!, ay = p[1]!, az = p[2]!, bx = p[p.length - 3]!, by = p[p.length - 2]!, bz = p[p.length - 1]!;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let worst = 0;
  for (let i = 0; i < p.length; i += 3) {
    const rx = p[i]! - ax, ry = p[i + 1]! - ay, rz = p[i + 2]! - az;
    const cx = ry * dz - rz * dy, cy = rz * dx - rx * dz, cz = rx * dy - ry * dx;
    worst = Math.max(worst, Math.sqrt(cx * cx + cy * cy + cz * cz) / len);
  }
  return worst;
}

describe('river paths', () => {
  it('start and end exactly at the vertices, on the unit sphere, only for rivers above the threshold', () => {
    const elevation = new Float64Array(n).fill(50);
    const hops = riverPaths(lattice, flowTo, discharge, elevation, 1);
    expect(hops.length).toBe(1);
    const p = hops[0]!.points;
    for (let k = 0; k < 3; k++) {
      expect(p[k]).toBeCloseTo(lattice.positions[from * 3 + k]!, 12);
      expect(p[p.length - 3 + k]).toBeCloseTo(lattice.positions[to * 3 + k]!, 12);
    }
    for (let i = 0; i < p.length; i += 3) expect(Math.abs(Math.hypot(p[i]!, p[i + 1]!, p[i + 2]!) - 1)).toBeLessThan(1e-9);
    expect(riverPaths(lattice, flowTo, discharge, elevation, 100).length).toBe(0);
  });

  it('wanders far on flat, soft ground and runs nearly straight down a steep slope or over hard rock', () => {
    const floodplain = wander(5, 2.2);
    expect(floodplain).toBeGreaterThan(wander(3000, 2.2) * 3); // steep
    expect(floodplain).toBeGreaterThan(wander(5, 0.3) * 3); // hard rock
    expect(floodplain).toBeGreaterThan(0.01);
  });

  it('is deterministic', () => {
    const elevation = new Float64Array(n).fill(20);
    expect(Array.from(riverPaths(lattice, flowTo, discharge, elevation, 1)[0]!.points)).toEqual(Array.from(riverPaths(lattice, flowTo, discharge, elevation, 1)[0]!.points));
  });
});

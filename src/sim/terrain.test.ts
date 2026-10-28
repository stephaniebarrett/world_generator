import { describe, expect, it } from 'vitest';
import { analyzeBoundaries } from './boundaries';
import { MAX_THICKNESS, OCEAN_THICKNESS, SEA_LEVEL_THICKNESS } from './crust';
import { buildLattice } from './lattice';
import type { Plate } from './plates';
import { buildTerrain } from './terrain';
import { createState, type WorldState } from './world';

const lattice = buildLattice(44); // about 19,000 points
const N = lattice.vertexCount;
const z = (v: number) => lattice.positions[v * 3 + 2]!;
const LAND = 35;

/** Two hemispheres (plate 0 is z > 0). Rotating about +x, so the boundary closes where it opens at the other end. */
function twoPlates(speed0: number, speed1: number): { plateOf: Int32Array; plates: Plate[] } {
  const plateOf = new Int32Array(N);
  for (let v = 0; v < N; v++) plateOf[v] = z(v) > 0 ? 0 : 1;
  return {
    plateOf,
    plates: [
      { id: 0, seedVertex: 0, axis: [1, 0, 0], angularSpeed: speed0 },
      { id: 1, seedVertex: 0, axis: [1, 0, 0], angularSpeed: speed1 },
    ],
  };
}

function world(north: number, south: number): WorldState {
  const w = createState(lattice);
  for (let v = 0; v < N; v++) w.thickness[v] = z(v) > 0 ? north : south;
  return w;
}

const CLOSING_REF = 0.007;
const KM = 6371;

/** Mean thickness of points on a plate within a distance band from the boundary, where the boundary is closing (or opening) fast. */
function band(w: WorldState, plateOf: Int32Array, plates: Plate[], plate: number, from: number, to: number, mode: 'closing' | 'opening'): number {
  const info = analyzeBoundaries(lattice, plateOf, plates, w.thickness);
  let sum = 0, count = 0;
  for (let v = 0; v < N; v++) {
    if (plateOf[v] !== plate) continue;
    const s = info.source[v]!;
    if (s < 0) continue;
    const c = info.closing[s]! / CLOSING_REF;
    if (mode === 'closing' ? c < 1 : c > -1) continue;
    const d = info.distanceKm[v]!;
    if (d >= from && d < to) { sum += w.thickness[v]!; count++; }
  }
  return count ? sum / count : NaN;
}

function terrainFor(north: number, south: number, a: number, b: number) {
  const { plateOf, plates } = twoPlates(a, b);
  const before = world(north, south);
  const after = world(north, south);
  buildTerrain(after, plateOf, plates, 'terrain-test', { erosionMy: 0 });
  return { plateOf, plates, before, after };
}

describe('terrain from plate motion', () => {
  // With these speeds the boundary is closing in one half and opening in the other (a rotation about x).
  const SPEEDS: [number, number] = [-0.005, 0.005];

  it('two continents colliding raise a high range along the boundary', () => {
    const { plateOf, plates, after } = terrainFor(LAND, LAND, ...SPEEDS);
    const near = band(after, plateOf, plates, 0, 60, 400, 'closing');
    const far = band(after, plateOf, plates, 0, 1500, 4000, 'closing');
    expect(near - far).toBeGreaterThan(10);
    expect(Math.max(...after.thickness)).toBeLessThanOrEqual(MAX_THICKNESS);
    expect(Math.max(...after.thickness)).toBeGreaterThan(55); // Himalayan crust
  });

  it('sea floor under a continent raises a coast range on land and cuts a trench offshore', () => {
    const { plateOf, plates, after } = terrainFor(LAND, OCEAN_THICKNESS, ...SPEEDS);
    const range = band(after, plateOf, plates, 0, 80, 350, 'closing');
    const inland = band(after, plateOf, plates, 0, 1500, 4000, 'closing');
    expect(range - inland).toBeGreaterThan(6);
    const trench = band(after, plateOf, plates, 1, 0, 80, 'closing');
    const abyss = band(after, plateOf, plates, 1, 1000, 4000, 'closing');
    expect(trench).toBeLessThan(abyss - 1.5);
  });

  it('sea floor under sea floor builds an island arc beside a trench', () => {
    const { plateOf, plates, after } = terrainFor(OCEAN_THICKNESS, OCEAN_THICKNESS, ...SPEEDS);
    // Plate 0 has the lower id, so it overrides.
    const arc = band(after, plateOf, plates, 0, 60, 220, 'closing');
    const sea = band(after, plateOf, plates, 0, 1000, 4000, 'closing');
    expect(arc - sea).toBeGreaterThan(8);
    expect(Math.max(...after.thickness)).toBeGreaterThan(SEA_LEVEL_THICKNESS); // some arcs reach the surface as islands
  });

  it('plates pulling apart open a rift valley on land and raise a mid-ocean ridge at sea', () => {
    const land = terrainFor(LAND, LAND, ...SPEEDS);
    const valley = band(land.after, land.plateOf, land.plates, 0, 0, 90, 'opening');
    const plain = band(land.after, land.plateOf, land.plates, 0, 700, 4000, 'opening');
    expect(valley).toBeLessThan(plain - 3);

    const sea = terrainFor(OCEAN_THICKNESS, OCEAN_THICKNESS, ...SPEEDS);
    const ridge = band(sea.after, sea.plateOf, sea.plates, 0, 0, 300, 'opening');
    const deep = band(sea.after, sea.plateOf, sea.plates, 0, 1300, 4000, 'opening');
    expect(ridge).toBeGreaterThan(deep + 2);
  });

  it('builds relief in proportion to how fast the plates close', () => {
    const slow = terrainFor(LAND, LAND, -0.0015, 0.0015);
    const fast = terrainFor(LAND, LAND, -0.006, 0.006);
    expect(Math.max(...fast.after.thickness)).toBeGreaterThan(Math.max(...slow.after.thickness) + 5); // peaks level off smoothly, so the gap is modest
  });

  it('is deterministic, and different seeds give different mountains', () => {
    const { plateOf, plates } = twoPlates(...SPEEDS);
    const run = (seed: string) => { const w = world(LAND, LAND); buildTerrain(w, plateOf, plates, seed, { erosionMy: 4 }); return Array.from(w.thickness); };
    expect(run('a')).toEqual(run('a'));
    expect(run('a')).not.toEqual(run('b'));
  });

  it('erosion cuts valleys into the new relief without losing material it should keep', () => {
    const { plateOf, plates } = twoPlates(...SPEEDS);
    const raw = world(LAND, LAND);
    buildTerrain(raw, plateOf, plates, 'e', { erosionMy: 0 });
    const eroded = world(LAND, LAND);
    buildTerrain(eroded, plateOf, plates, 'e', { erosionMy: 10 });
    expect(Math.max(...eroded.thickness)).toBeLessThan(Math.max(...raw.thickness) + 1e-9);
    expect(Array.from(eroded.thickness)).not.toEqual(Array.from(raw.thickness));
  });

  it('gives continental interiors relief too, away from any boundary', () => {
    const w = world(LAND, LAND);
    const { plateOf, plates } = twoPlates(0, 0); // nothing moves, so no boundary relief at all
    buildTerrain(w, plateOf, plates, 'interior', { erosionMy: 0 });
    const spread = (xs: Float64Array) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
    expect(spread(w.thickness)).toBeGreaterThan(1.5); // belts, swells and basins: hills and plateaus on the plains
    expect(KM).toBe(6371);
  });
});

import { buildLattice as buildLatticeForWorld } from './lattice';
import { prepareWorld } from './setup';
import { elevationFromThickness } from './crust';
import { newRecipe, type Edit, type GenerateEdit } from './world';

describe('generated worlds have Earth-like relief', () => {
  // Heights of land on Earth: mean about 840 m; about 26% of land above 1 km, 10% above 2 km, 4% above 3 km, 0.5% above 5 km;
  // highest 8,849 m. Measured across four land styles and three seeds each.
  const l = buildLatticeForWorld(32);
  const sample = () => {
    const out = { mean: 0, over1: 0, over2: 0, over3: 0, highest: 0, worlds: 0 };
    for (const style of ['continents', 'pangaea', 'two', 'archipelago'] as const) {
      for (const seed of ['h1', 'h2', 'h3']) {
        const gen: GenerateEdit = { kind: 'generate', style, landFraction: style === 'archipelago' ? 0.12 : 0.29, seed, time: 0 };
        const p = prepareWorld({ ...newRecipe(seed, 32), edits: [gen as Edit] }, l);
        let land = 0, sum = 0, a = 0, b = 0, c = 0;
        for (let v = 0; v < l.vertexCount; v++) {
          const e = elevationFromThickness(p.world.thickness[v]!);
          if (e <= 0) continue;
          land++; sum += e;
          if (e > 1000) a++;
          if (e > 2000) b++;
          if (e > 3000) c++;
          out.highest = Math.max(out.highest, e);
        }
        out.mean += sum / land; out.over1 += a / land; out.over2 += b / land; out.over3 += c / land; out.worlds++;
      }
    }
    return { mean: out.mean / out.worlds, over1: out.over1 / out.worlds, over2: out.over2 / out.worlds, over3: out.over3 / out.worlds, highest: out.highest };
  };

  it('has Earth-like mean height and shares of high ground, with mountains that reach several km', () => {
    const h = sample();
    expect(h.mean).toBeGreaterThan(650);
    expect(h.mean).toBeLessThan(1050);
    expect(h.over1).toBeGreaterThan(0.15);
    expect(h.over1).toBeLessThan(0.38);
    expect(h.over2).toBeGreaterThan(0.04);
    expect(h.over2).toBeLessThan(0.16);
    expect(h.over3).toBeGreaterThan(0.015);
    expect(h.over3).toBeLessThan(0.09);
    expect(h.highest).toBeGreaterThan(6500);
    expect(h.highest).toBeLessThan(9800);
  }, 30000);
});

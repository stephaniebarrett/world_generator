import { describe, expect, it } from 'vitest';
import { buildLattice } from './lattice';
import { LatticeIndex } from './latticeIndex';
import { earthPlates, earthPotential, fromDegrees, isEarthSeed } from './earth';
import { layoutPlates } from './plates';
import { applyGenerate } from './landgen';
import { createState } from './world';
import { elevationFromThickness } from './crust';

const lattice = buildLattice(63);
const index = new LatticeIndex(lattice);
const at = (lat: number, lon: number) => { const d = fromDegrees(lat, lon); return index.nearest(d[0], d[1], d[2]); };

describe('the earth seed', () => {
  it('is recognised in any case, with or without the generated-land suffix', () => {
    expect(isEarthSeed('earth')).toBe(true);
    expect(isEarthSeed(' Earth ')).toBe(true);
    expect(isEarthSeed('earth#0')).toBe(true);
    expect(isEarthSeed('earthling')).toBe(false);
  });

  it('turns degrees into unit vectors', () => {
    const [x, y, z] = fromDegrees(0, 90);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(1, 12);
    expect(z).toBeCloseTo(0, 12);
    const [a, b, c] = fromDegrees(-45, -135);
    expect(a * a + b * b + c * c).toBeCloseTo(1, 12);
    expect(c).toBeCloseTo(-Math.SQRT1_2, 12);
  });

  it('puts land where the continents are and sea where the oceans are', () => {
    const pot = earthPotential(lattice);
    const land = [[40, -100], [-10, -60], [5, 20], [55, 80], [-25, 135], [-80, 0], [72, -40], [-19, 47], [35, 138]];
    const sea = [[0, -150], [-30, -20], [30, -45], [-20, 80], [60, -30], [0, 170], [43, 35], [43, 50]];
    for (const [lat, lon] of land) expect(pot[at(lat!, lon!)], `land at ${lat}, ${lon}`).toBeGreaterThan(0);
    for (const [lat, lon] of sea) expect(pot[at(lat!, lon!)], `sea at ${lat}, ${lon}`).toBeLessThan(0);
  });

  it('covers about the share of the globe that Earth has (29 percent)', () => {
    const pot = earthPotential(lattice);
    let land = 0;
    for (const p of pot) if (p > 0) land++;
    expect(land / pot.length).toBeGreaterThan(0.26);
    expect(land / pot.length).toBeLessThan(0.34);
  });

  it('lays out the real plates, whatever the detail', () => {
    const fine = buildLattice(89);
    const setup = layoutPlates(lattice, 'earth');
    expect(setup.plates.length).toBe(15);
    const names = [[35, -165, 0], [48, -95, 1], [55, 60, 2], [5, 20, 3], [-12, -58, 4], [-85, 20, 5], [-25, 135, 6], [22, 78, 7], [23, 45, 8], [-20, -85, 9]];
    for (const [lat, lon, id] of names) expect(setup.plateOf[at(lat!, lon!)], `plate at ${lat}, ${lon}`).toBe(id);
    const finer = layoutPlates(fine, 'earth');
    expect(finer.plates.length).toBe(setup.plates.length);
    const fineIndex = new LatticeIndex(fine);
    for (const [lat, lon, id] of names) { const d = fromDegrees(lat!, lon!); expect(finer.plateOf[fineIndex.nearest(d[0], d[1], d[2])]).toBe(id); }
  });

  it('moves the plates roughly as the real ones move', () => {
    const { plates } = earthPlates(lattice);
    const speed = (id: number) => plates[id]!.angularSpeed;
    // The Pacific, the Indian, and the Australian plates are fast; Eurasia and Antarctica are slow.
    expect(speed(0)).toBeGreaterThan(speed(2) * 3);
    expect(speed(6)).toBeGreaterThan(speed(5) * 2);
    expect(speed(7)).toBeGreaterThan(speed(3));
  });

  it('is drawn by Generate Land at any style or cover, the same every time', () => {
    const make = (style: 'continents' | 'archipelago', cover: number) => {
      const state = createState(lattice);
      applyGenerate(state, { kind: 'generate', style, landFraction: cover, seed: 'earth#0', time: 0 });
      return state.thickness;
    };
    const a = make('continents', 0.3), b = make('archipelago', 0.12);
    expect(Array.from(b)).toEqual(Array.from(a));
    let land = 0;
    for (const t of a) if (elevationFromThickness(t) > 0) land++;
    expect(land / a.length).toBeGreaterThan(0.26);
    expect(land / a.length).toBeLessThan(0.34);
  });
});

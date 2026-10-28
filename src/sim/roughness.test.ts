import { describe, expect, it } from 'vitest';
import { buildLattice } from './lattice';
import { ROUGHNESS_SURFACE_M, addRoughness, fractalNoise, valueNoise3 } from './roughness';
import { OCEAN_THICKNESS, createState, elevationFromThickness } from './world';

const stats = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, sd: Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length), min: Math.min(...xs), max: Math.max(...xs) };
};

describe('roughness', () => {
  it('noise is repeatable, bounded, and varies smoothly', () => {
    expect(valueNoise3(0.3, 0.7, 0.1, 5)).toBe(valueNoise3(0.3, 0.7, 0.1, 5));
    expect(valueNoise3(0.3, 0.7, 0.1, 5)).not.toBe(valueNoise3(0.3, 0.7, 0.1, 6));
    const values: number[] = [];
    for (let i = 0; i < 4000; i++) values.push(fractalNoise(Math.sin(i), Math.cos(i * 1.3), Math.sin(i * 0.7), 9));
    const s = stats(values);
    expect(s.min).toBeGreaterThan(-1.01);
    expect(s.max).toBeLessThan(1.01);
    expect(Math.abs(s.mean)).toBeLessThan(0.1);
    expect(s.sd).toBeGreaterThan(0.2); // real variation, not flat
    // Smooth: a tiny step changes the value only a little.
    for (let i = 0; i < 50; i++) {
      const x = Math.sin(i * 3), y = Math.cos(i * 2), z = Math.sin(i);
      expect(Math.abs(fractalNoise(x, y, z, 9) - fractalNoise(x + 1e-4, y, z, 9))).toBeLessThan(0.02);
    }
  });

  it('leaves seafloor alone, roughens land, and keeps thickness in range', () => {
    const lattice = buildLattice(30);
    const world = createState(lattice);
    // Southern half ocean, northern half continental crust.
    for (let v = 0; v < lattice.vertexCount; v++) if (lattice.positions[v * 3 + 2]! > 0) world.thickness[v] = 35;
    const out = addRoughness(world, 'seed');
    const land: number[] = [];
    for (let v = 0; v < lattice.vertexCount; v++) {
      if (lattice.positions[v * 3 + 2]! <= 0) expect(out.thickness[v]).toBe(OCEAN_THICKNESS);
      else land.push(elevationFromThickness(out.thickness[v]!));
    }
    const s = stats(land);
    expect(s.sd).toBeGreaterThan(100); // hills of a few hundred metres at least
    expect(s.min).toBeGreaterThan(-3000);
    expect(s.max - s.min).toBeLessThan(2 * ROUGHNESS_SURFACE_M + 1);
    expect(Array.from(world.thickness).every((t) => t === 7 || t === 35)).toBe(true); // input untouched
  });

  it('is the same at any detail: a given spot gets the same height', () => {
    const coarse = buildLattice(20);
    const fine = buildLattice(60);
    const flat = (l: typeof coarse) => { const w = createState(l); w.thickness.fill(35); return addRoughness(w, 'seed'); };
    const a = flat(coarse), b = flat(fine);
    // Compare vertices of the coarse lattice with the nearest fine vertex.
    let worst = 0;
    for (let v = 0; v < coarse.vertexCount; v += 7) {
      let best = 0, bestD = Infinity;
      for (let u = 0; u < fine.vertexCount; u++) {
        const d = (fine.positions[u * 3]! - coarse.positions[v * 3]!) ** 2 + (fine.positions[u * 3 + 1]! - coarse.positions[v * 3 + 1]!) ** 2 + (fine.positions[u * 3 + 2]! - coarse.positions[v * 3 + 2]!) ** 2;
        if (d < bestD) { bestD = d; best = u; }
      }
      worst = Math.max(worst, Math.abs(a.thickness[v]! - b.thickness[best]!));
    }
    // Nearest fine vertex is within about a coarse cell, so heights agree to within the roughness over that distance.
    expect(worst).toBeLessThan(2.5);
  });

  it('differs by seed and is deterministic', () => {
    const lattice = buildLattice(16);
    const w = createState(lattice);
    w.thickness.fill(35);
    const a = addRoughness(w, 's1'), a2 = addRoughness(w, 's1'), b = addRoughness(w, 's2');
    expect(Array.from(a.thickness)).toEqual(Array.from(a2.thickness));
    expect(Array.from(a.thickness)).not.toEqual(Array.from(b.thickness));
  });
});

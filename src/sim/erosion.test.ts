import { describe, expect, it } from 'vitest';
import { DEFAULT_EROSION, erosionDelta } from './erosion';
import { buildLattice } from './lattice';
import { LAND_THICKNESS, OCEAN_THICKNESS, SEA_LEVEL_THICKNESS, elevationFromThickness } from './world';

const lattice = buildLattice(20);
const sum = (a: Float64Array) => a.reduce((x, y) => x + y, 0);
/** Keeps all sediment, so material is conserved exactly (the default carries small rivers' sediment out to sea). */
const KEEP_ALL = { ...DEFAULT_EROSION, deltaBasinKm2: [0, 0] as const };

/** A mountain: thick crust near +z, falling off to ocean. */
function mountain(): Float64Array {
  const t = new Float64Array(lattice.vertexCount).fill(OCEAN_THICKNESS);
  for (let v = 0; v < lattice.vertexCount; v++) {
    const z = lattice.positions[v * 3 + 2]!;
    if (z > 0.8) t[v] = SEA_LEVEL_THICKNESS + (z - 0.8) * 5 * 40; // up to 64 km at the pole
  }
  return t;
}

describe('erosion', () => {
  it('does nothing on flat ground and flat seafloor', () => {
    const land = new Float64Array(lattice.vertexCount).fill(LAND_THICKNESS);
    const sea = new Float64Array(lattice.vertexCount).fill(OCEAN_THICKNESS);
    expect(erosionDelta(lattice, land, 1).every((x) => x === 0)).toBe(true);
    expect(erosionDelta(lattice, sea, 1).every((x) => x === 0)).toBe(true);
  });

  it('conserves material exactly', () => {
    const delta = erosionDelta(lattice, mountain(), 1, KEEP_ALL);
    expect(Math.abs(sum(delta))).toBeLessThan(1e-9);
    expect(delta.some((x) => x !== 0)).toBe(true);
  });

  it('lowers the peak and raises the ground and sea around it', () => {
    const t = mountain();
    const delta = erosionDelta(lattice, t, 1);
    let peak = 0;
    for (let v = 0; v < lattice.vertexCount; v++) if (t[v]! > t[peak]!) peak = v;
    expect(delta[peak]).toBeLessThan(0);
    // Some ocean vertex received sediment.
    let gained = 0;
    for (let v = 0; v < lattice.vertexCount; v++) if (elevationFromThickness(t[v]!) <= 0 && delta[v]! > 0) gained++;
    expect(gained).toBeGreaterThan(0);
  });

  it('erodes the same mountain faster when the rivers are stronger', () => {
    const t = mountain();
    const weak = erosionDelta(lattice, t, 1, { ...KEEP_ALL, incision: 20, diffusion: 0, seaDiffusion: 0 });
    const strong = erosionDelta(lattice, t, 1, { ...KEEP_ALL, incision: 200, diffusion: 0, seaDiffusion: 0 });
    expect(Math.min(...strong)).toBeLessThan(Math.min(...weak));
  });

  it('is deterministic', () => {
    const a = erosionDelta(lattice, mountain(), 1);
    const b = erosionDelta(lattice, mountain(), 1);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('wears a steep range down at a sensible rate without inventing material', () => {
    // A narrow range (about 600 km wide, 8 km high) like a real mountain belt.
    const fine = buildLattice(40);
    let t = new Float64Array(fine.vertexCount).fill(OCEAN_THICKNESS);
    for (let v = 0; v < fine.vertexCount; v++) {
      const z = fine.positions[v * 3 + 2]!;
      if (z > 0.97) t[v] = SEA_LEVEL_THICKNESS + Math.min(1, (z - 0.97) / 0.03) * 32;
    }
    const before = elevationFromThickness(Math.max(...t));
    for (let i = 0; i < 50; i++) {
      const d = erosionDelta(fine, t, 1);
      t = t.map((x, v) => x + d[v]!);
    }
    const lowered = before - elevationFromThickness(Math.max(...t));
    // Real ranges lose from tens to a few hundred metres of surface per My.
    expect(lowered).toBeGreaterThan(500);
    expect(lowered).toBeLessThan(5000);
    expect(Math.min(...t)).toBeGreaterThan(2.9);
  });

  it('never builds terrain higher than the original peak, at fine detail too', () => {
    const fine = buildLattice(40);
    let t = new Float64Array(fine.vertexCount).fill(OCEAN_THICKNESS);
    for (let v = 0; v < fine.vertexCount; v++) {
      const z = fine.positions[v * 3 + 2]!;
      if (z > 0.8) t[v] = SEA_LEVEL_THICKNESS + (z - 0.8) * 5 * 40;
    }
    const peak = Math.max(...t);
    let last = peak;
    for (let i = 0; i < 60; i++) {
      const d = erosionDelta(fine, t, 1);
      t = t.map((x, v) => x + d[v]!);
      const now = Math.max(...t);
      expect(now).toBeLessThanOrEqual(last + 1e-9);
      last = now;
    }
    expect(last).toBeLessThan(peak);
  });

  it('hard rock resists and soft rock wears: rock type, not just slope, sets the rate', () => {
    const t = mountain();
    const hard = new Float64Array(lattice.vertexCount).fill(0.35); // craton
    const soft = new Float64Array(lattice.vertexCount).fill(2.0); // sedimentary
    const removed = (e: Float64Array) => {
      const d = erosionDelta(lattice, t, 1, undefined, e);
      let loss = 0;
      for (const x of d) if (x < 0) loss -= x;
      return loss;
    };
    expect(removed(soft)).toBeGreaterThan(removed(hard) * 3);
    // Material is still conserved with uneven rock.
    const uneven = Float64Array.from({ length: lattice.vertexCount }, (_, v) => (v % 3 === 0 ? 2.0 : 0.35));
    expect(Math.abs(sum(erosionDelta(lattice, t, 1, KEEP_ALL, uneven)))).toBeLessThan(1e-9);
  });

  it('a hard band stands up as a ridge between soft ground', () => {
    // Gently sloping land with a hard band across the slope: it ends up higher than the soft rock either side.
    const l = buildLattice(40);
    let thickness = new Float64Array(l.vertexCount).fill(OCEAN_THICKNESS);
    const rock = new Float64Array(l.vertexCount).fill(2.0);
    for (let v = 0; v < l.vertexCount; v++) {
      const z = l.positions[v * 3 + 2]!;
      if (z > 0.6) thickness[v] = SEA_LEVEL_THICKNESS + 12 + (z - 0.6) * 20;
      if (z > 0.8 && z < 0.86) rock[v] = 0.3; // the hard band
    }
    const before = Float64Array.from(thickness);
    for (let i = 0; i < 20; i++) {
      const d = erosionDelta(l, thickness, 2, undefined, rock);
      thickness = thickness.map((x, v) => x + d[v]!);
    }
    const lowering = (pick: (z: number) => boolean) => {
      let total = 0, count = 0;
      for (let v = 0; v < l.vertexCount; v++) if (pick(l.positions[v * 3 + 2]!)) { total += before[v]! - thickness[v]!; count++; }
      return total / count;
    };
    expect(lowering((z) => z > 0.8 && z < 0.86)).toBeLessThan(lowering((z) => (z > 0.65 && z < 0.78) || (z > 0.88 && z < 0.97)));
  });

  it('carries small rivers sediment out to sea, and lets only big basins build deltas', () => {
    const t = mountain();
    // Every basin here is small next to a million-km^2 threshold, so the sediment leaves the system.
    const smallRivers = { ...DEFAULT_EROSION, deltaBasinKm2: [1e6, 2e6] as const };
    const exported = -sum(erosionDelta(lattice, t, 1, smallRivers));
    const kept = -sum(erosionDelta(lattice, t, 1, KEEP_ALL));
    expect(Math.abs(kept)).toBeLessThan(1e-9);
    expect(exported).toBeGreaterThan(0); // material left the system
    // A huge basin keeps its sediment and builds a delta.
    const bigBasin = { ...DEFAULT_EROSION, deltaBasinKm2: [1, 2] as const };
    expect(Math.abs(sum(erosionDelta(lattice, t, 1, bigBasin)))).toBeLessThan(1e-9);
  });

  it('wears wet ground faster than a desert, and still conserves material', () => {
    const t = mountain();
    const rain = (mm: number) => new Float64Array(lattice.vertexCount).fill(mm);
    const removed = (mm: number) => {
      let loss = 0;
      for (const x of erosionDelta(lattice, t, 1, KEEP_ALL, undefined, rain(mm))) if (x < 0) loss -= x;
      return loss;
    };
    expect(removed(2500)).toBeGreaterThan(removed(100) * 2);
    // Typical rain behaves like no rainfall data at all.
    expect(Array.from(erosionDelta(lattice, t, 1, KEEP_ALL, undefined, rain(1000)))).toEqual(Array.from(erosionDelta(lattice, t, 1, KEEP_ALL)));
    const uneven = Float64Array.from({ length: lattice.vertexCount }, (_, v) => (v % 2 === 0 ? 200 : 2000));
    expect(Math.abs(sum(erosionDelta(lattice, t, 1, KEEP_ALL, undefined, uneven)))).toBeLessThan(1e-9);
  });
});

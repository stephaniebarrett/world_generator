import { describe, expect, it } from 'vitest';
import { OCEAN_THICKNESS, ROCK, elevationFromThickness, oceanDepth, thermalThickness } from './crust';
import { assignGeology } from './geology';
import { buildLattice } from './lattice';
import type { Plate } from './plates';
import { createTectonics, resample, stepTectonics } from './tectonics';
import { computeWater, KARST_RUNOFF } from './water';
import { createState } from './world';

const lattice = buildLattice(40);
const N = lattice.vertexCount;
const px = (v: number) => lattice.positions[v * 3]!;
const pz = (v: number) => lattice.positions[v * 3 + 2]!;

describe('ocean age-depth', () => {
  it('starts near 2,500 m at a ridge and sinks, fast at first, to about 5,500 m on old sea floor', () => {
    expect(oceanDepth(0)).toBe(2500);
    let last = 0;
    for (const age of [0, 5, 20, 40, 80, 120, 180, 250]) {
      expect(oceanDepth(age)).toBeGreaterThanOrEqual(last);
      last = oceanDepth(age);
    }
    expect(oceanDepth(20) - oceanDepth(0)).toBeGreaterThan(oceanDepth(120) - oceanDepth(100));
    expect(oceanDepth(100)).toBeGreaterThan(5000);
    expect(oceanDepth(250)).toBeLessThan(5700);
  });

  it('gives sea floor the height its age implies, and leaves continents and thick arcs alone', () => {
    expect(elevationFromThickness(thermalThickness(OCEAN_THICKNESS, 0))).toBeCloseTo(-2500, 3);
    expect(elevationFromThickness(thermalThickness(OCEAN_THICKNESS, 150))).toBeLessThan(-5250);
    expect(thermalThickness(35, 400)).toBe(35);
    expect(thermalThickness(23, 10)).toBe(23);
    // A plateau on the sea floor keeps its extra height over the plain floor around it.
    expect(thermalThickness(OCEAN_THICKNESS + 6, 60) - thermalThickness(OCEAN_THICKNESS, 60)).toBeGreaterThan(4);
  });
});

describe('hotspots', () => {
  const oneSlowPlate = (hotspots: number) => {
    const plateOf = new Int32Array(N);
    const plates: Plate[] = [{ id: 0, seedVertex: 0, axis: [0, 0, 1], angularSpeed: 0.004 }];
    const w = createState(lattice);
    w.thickness.fill(OCEAN_THICKNESS);
    return createTectonics(w, { plateOf, plates }, { seed: 'h', hotspots });
  };

  it('build volcanic crust on the plate drifting over them, and none without hotspots', () => {
    const none = oneSlowPlate(0);
    const some = oneSlowPlate(10);
    for (let i = 0; i < 25; i++) { stepTectonics(none, 1); stepTectonics(some, 1); }
    const tall = (t: typeof none) => { let n = 0; for (let i = 0; i < t.crust.count; i++) if (t.crust.thickness[i]! > 14 && t.crust.rock[i] === ROCK.volcanic) n++; return n; };
    expect(tall(none)).toBe(0);
    expect(tall(some)).toBeGreaterThan(10);
  });

  it('are placed from the seed, and an unfed volcano sinks away', () => {
    expect(Array.from(oneSlowPlate(6).hotspots)).toEqual(Array.from(oneSlowPlate(6).hotspots));
    const t = oneSlowPlate(1);
    const hx = t.hotspots[0]!, hy = t.hotspots[1]!, hz = t.hotspots[2]!;
    const far = (i: number) => t.crust.pos[i * 3]! * hx + t.crust.pos[i * 3 + 1]! * hy + t.crust.pos[i * 3 + 2]! * hz < 0; // the far hemisphere, never over the plume
    for (let i = 0; i < t.crust.count; i++) if (far(i)) { t.crust.thickness[i] = 20; t.crust.rock[i] = ROCK.volcanic; }
    for (let s = 0; s < 20; s++) stepTectonics(t, 1);
    let sum = 0, count = 0;
    for (let i = 0; i < t.crust.count; i++) if (far(i)) { sum += t.crust.thickness[i]!; count++; }
    expect(sum / count).toBeLessThan(17);
  });
});

describe('faults', () => {
  it('scar the crust where plates slide past each other, and nowhere else', () => {
    const plateOf = new Int32Array(N);
    for (let v = 0; v < N; v++) plateOf[v] = pz(v) > 0 ? 0 : 1;
    const plates: Plate[] = [
      { id: 0, seedVertex: 0, axis: [0, 0, 1], angularSpeed: 0.006 },
      { id: 1, seedVertex: 0, axis: [0, 0, 1], angularSpeed: -0.006 },
    ];
    const w = createState(lattice);
    w.thickness.fill(OCEAN_THICKNESS);
    const t = createTectonics(w, { plateOf, plates });
    for (let i = 0; i < 12; i++) stepTectonics(t, 1);
    let near = 0, nearN = 0, far = 0;
    for (let i = 0; i < t.crust.count; i++) {
      if (Math.abs(t.crust.pos[i * 3 + 2]!) < 0.08) { near += t.crust.scar[i]!; nearN++; }
      else if (Math.abs(t.crust.pos[i * 3 + 2]!) > 0.5) far = Math.max(far, t.crust.scar[i]!);
    }
    expect(near / nearN).toBeGreaterThan(0.05);
    expect(far).toBe(0);
  });
});

describe('karst', () => {
  it('limestone is a patchy share of the sedimentary cover', () => {
    const plateOf = new Int32Array(N);
    const plates: Plate[] = [{ id: 0, seedVertex: 0, axis: [0, 0, 1], angularSpeed: 0 }];
    const rock = assignGeology(lattice, new Float64Array(N).fill(33), plateOf, plates, 'k');
    const lime = rock.filter((r) => r === ROCK.limestone).length;
    expect(lime / N).toBeGreaterThan(0.1);
    expect(lime / N).toBeLessThan(0.6);
  });

  it('swallows rain, so rivers over it are small', () => {
    const elevation = Float64Array.from({ length: N }, (_, v) => 10 + 500 * (pz(v) + 1));
    const rain = new Float32Array(N).fill(1500);
    const total = (rock?: Uint8Array) => computeWater(lattice, elevation, rain, rock).discharge.reduce((a, b) => a + b, 0);
    const wet = total();
    const lime = total(new Uint8Array(N).fill(ROCK.limestone));
    expect(lime / wet).toBeGreaterThan(KARST_RUNOFF * 0.8);
    expect(lime / wet).toBeLessThan(KARST_RUNOFF * 1.2 + 0.05);
  });

  it('dissolves in a wet climate faster than ordinary sedimentary rock', () => {
    const plateOf = new Int32Array(N);
    const plates: Plate[] = [{ id: 0, seedVertex: 0, axis: [0, 0, 1], angularSpeed: 0 }];
    const w = createState(lattice);
    const rock = new Uint8Array(N).fill(ROCK.sedimentary);
    for (let v = 0; v < N; v++) {
      if (Math.abs(px(v)) > 0.88) w.thickness[v] = 36 + (Math.abs(px(v)) - 0.88) * 70;
      if (px(v) > 0) rock[v] = ROCK.limestone;
    }
    const t = createTectonics(w, { plateOf, plates }, { erosion: true, rock, seed: 'k' });
    t.rainfall = new Float32Array(N).fill(1500);
    const peak = (th: ArrayLike<number>, sign: number) => { let m = 0; for (let v = 0; v < N; v++) if (sign * px(v) > 0.88) m = Math.max(m, th[v]!); return m; };
    const before = [peak(w.thickness, 1), peak(w.thickness, -1)];
    for (let i = 0; i < 15; i++) stepTectonics(t, 2);
    const r = resample(t);
    expect(before[0]! - peak(r.thickness, 1)).toBeGreaterThan((before[1]! - peak(r.thickness, -1)) * 1.03);
  });
});

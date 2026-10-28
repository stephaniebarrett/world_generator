import { describe, expect, it } from 'vitest';
import { METAMORPHIC_THICKNESS, OCEAN_THICKNESS, ROCK, ROCKS } from './crust';
import { assignGeology } from './geology';
import { buildLattice } from './lattice';
import type { Plate } from './plates';
import { createTectonics, resample, restore, snapshot, stepTectonics } from './tectonics';
import { createState } from './world';

const lattice = buildLattice(40);
const N = lattice.vertexCount;
const z = (v: number) => lattice.positions[v * 3 + 2]!;

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

describe('geology', () => {
  it('has a distinct colour, name and sensible properties for every rock', () => {
    expect(new Set(ROCKS.map((r) => r.key)).size).toBe(ROCKS.length);
    expect(new Set(ROCKS.map((r) => r.color.join(','))).size).toBe(ROCKS.length);
    const by = (k: keyof typeof ROCK) => ROCKS[ROCK[k]]!;
    // Hard crystalline rock resists wearing and deforming; soft sediment does neither.
    expect(by('craton').erodibility).toBeLessThan(by('sedimentary').erodibility);
    expect(by('craton').weakness).toBeLessThan(by('sedimentary').weakness);
    expect(by('sediment').erodibility).toBeGreaterThan(by('sedimentary').erodibility);
  });

  it('puts basalt on the sea floor, craton deep in continents, sedimentary cover elsewhere, and volcanic arcs at trenches', () => {
    const { plateOf, plates } = twoPlates(-0.005, 0.005);
    const t = new Float64Array(N);
    for (let v = 0; v < N; v++) t[v] = z(v) > 0 ? 35 : OCEAN_THICKNESS; // continent in the north, sea in the south: the coast is the plate boundary
    const rock = assignGeology(lattice, t, plateOf, plates, 'g');
    let basalt = 0, seaCount = 0, craton = 0, landCount = 0;
    for (let v = 0; v < N; v++) {
      if (t[v]! === OCEAN_THICKNESS) { seaCount++; if (rock[v] === ROCK.basalt) basalt++; }
      else { landCount++; if (rock[v] === ROCK.craton) craton++; }
    }
    expect(basalt / seaCount).toBeGreaterThan(0.85);
    expect(craton / landCount).toBeGreaterThan(0.05); // some old core
    expect(craton / landCount).toBeLessThan(0.8); // not all of it
    expect(rock.some((r) => r === ROCK.volcanic)).toBe(true); // an arc or coast range where the plates converge
    // Cratons only sit far from plate boundaries.
    for (let v = 0; v < N; v++) if (rock[v] === ROCK.craton) expect(Math.abs(z(v))).toBeGreaterThan(0.1);
  });

  it('turns very thick crust metamorphic', () => {
    const { plateOf, plates } = twoPlates(0, 0);
    const t = new Float64Array(N).fill(35);
    t[100] = METAMORPHIC_THICKNESS + 8;
    expect(assignGeology(lattice, t, plateOf, plates, 'g')[100]).toBe(ROCK.metamorphic);
  });

  it('is deterministic and varies with the seed', () => {
    const { plateOf, plates } = twoPlates(-0.005, 0.005);
    const t = new Float64Array(N).fill(35);
    expect(Array.from(assignGeology(lattice, t, plateOf, plates, 'a'))).toEqual(Array.from(assignGeology(lattice, t, plateOf, plates, 'a')));
    expect(Array.from(assignGeology(lattice, t, plateOf, plates, 'a'))).not.toEqual(Array.from(assignGeology(lattice, t, plateOf, plates, 'b')));
  });
});

describe('rock during a run', () => {
  it('turns squeezed crust metamorphic as plates collide', () => {
    const { plateOf, plates } = twoPlates(-0.006, 0.006);
    const w = createState(lattice);
    w.thickness.fill(35);
    const t = createTectonics(w, { plateOf, plates }, { seed: 'r' });
    for (let i = 0; i < 25; i++) stepTectonics(t, 1);
    let metamorphic = 0, thick = 0;
    for (let i = 0; i < t.crust.count; i++) {
      if (t.crust.thickness[i]! > METAMORPHIC_THICKNESS) { thick++; if (t.crust.rock[i] === ROCK.metamorphic) metamorphic++; }
    }
    expect(thick).toBeGreaterThan(20);
    expect(metamorphic).toBe(thick); // every point of that thick crust has become metamorphic
  });

  it('makes new sea floor out of basalt where plates part', () => {
    const { plateOf, plates } = twoPlates(0.006, -0.006);
    const w = createState(lattice);
    w.thickness.fill(35);
    const t = createTectonics(w, { plateOf, plates }, { seed: 'r' });
    for (let i = 0; i < 20; i++) stepTectonics(t, 1);
    let young = 0, basalt = 0;
    for (let i = 0; i < t.crust.count; i++) if (t.crust.age[i]! < 15) { young++; if (t.crust.rock[i] === ROCK.basalt) basalt++; }
    expect(young).toBeGreaterThan(20);
    // (A sliver beside a subduction zone can pick up arc magma and turn volcanic.)
    expect(basalt / young).toBeGreaterThan(0.98);
  });

  it('builds volcanic rock at subduction zones, and returns about a tenth of what goes down as new crust', () => {
    const { plateOf, plates } = twoPlates(-0.006, 0.006);
    const w = createState(lattice);
    w.thickness.fill(OCEAN_THICKNESS);
    const t = createTectonics(w, { plateOf, plates }, { seed: 'r' });
    for (let i = 0; i < 30; i++) stepTectonics(t, 1);
    expect([...t.crust.rock.slice(0, t.crust.count)].filter((r) => r === ROCK.volcanic).length).toBeGreaterThan(30);
    // The arc is thicker than plain sea floor: that is the returned magma.
    expect(Math.max(...t.crust.thickness.slice(0, t.crust.count))).toBeGreaterThan(OCEAN_THICKNESS + 5);
  });

  it('lays eroded material down as soft sediment, and reports rock when resampled', () => {
    const { plateOf, plates } = twoPlates(0, 0);
    const w = createState(lattice);
    for (let v = 0; v < N; v++) w.thickness[v] = z(v) > 0.6 ? 36 + (z(v) - 0.6) * 60 : OCEAN_THICKNESS; // a mountainous cap
    const t = createTectonics(w, { plateOf, plates }, { erosion: true, seed: 'r' });
    for (let i = 0; i < 20; i++) stepTectonics(t, 2);
    const r = resample(t);
    expect(r.rock.length).toBe(N);
    expect([...r.rock].some((x) => x === ROCK.sediment)).toBe(true);
  });

  it('is deformed less where the rock is old craton: in one collision the soft side rises more than the craton side', () => {
    const { plateOf, plates } = twoPlates(-0.006, 0.006);
    const w = createState(lattice);
    w.thickness.fill(35);
    const x = (v: number) => lattice.positions[v * 3]!;
    // The crust either side of x = 0 is the same, but one half is craton and the other soft sedimentary rock.
    const rock = Uint8Array.from({ length: N }, (_, v) => (x(v) > 0 ? ROCK.craton : ROCK.sedimentary));
    const t = createTectonics(w, { plateOf, plates }, { rock });
    for (let i = 0; i < 12; i++) stepTectonics(t, 1);
    let soft = 0, hard = 0;
    for (let i = 0; i < t.crust.count; i++) {
      if (t.crust.thickness[i]! <= 42) continue;
      if (t.crust.pos[i * 3]! > 0) hard++; else soft++;
    }
    expect(soft).toBeGreaterThan(20);
    expect(soft).toBeGreaterThan(hard);
  });

  it('erodes each place at the rate of the rock beneath it: identical hills on craton and on sedimentary rock wear differently', () => {
    // One plate, nothing moving: only erosion acts. Two identical hills, at opposite sides of the globe.
    const plateOf = new Int32Array(N);
    const plates: Plate[] = [{ id: 0, seedVertex: 0, axis: [0, 0, 1], angularSpeed: 0 }];
    const w = createState(lattice);
    const rock = new Uint8Array(N).fill(ROCK.sedimentary);
    const x = (v: number) => lattice.positions[v * 3]!;
    for (let v = 0; v < N; v++) {
      const cap = Math.abs(x(v)) > 0.88;
      if (cap) w.thickness[v] = 36 + (Math.abs(x(v)) - 0.88) * 70; // the same hill either side
      if (x(v) > 0) rock[v] = ROCK.craton; // the hill at +x is craton, the one at -x is sedimentary
    }
    const t = createTectonics(w, { plateOf, plates }, { erosion: true, rock, seed: 'r' });
    const peak = (th: ArrayLike<number>, sign: number) => { let m = 0; for (let v = 0; v < N; v++) if (sign * x(v) > 0.88) m = Math.max(m, th[v]!); return m; };
    const b = [peak(w.thickness, 1), peak(w.thickness, -1)];
    for (let i = 0; i < 20; i++) stepTectonics(t, 2);
    const r = resample(t);
    const lostCraton = b[0]! - peak(r.thickness, 1);
    const lostSoft = b[1]! - peak(r.thickness, -1);
    expect(lostSoft).toBeGreaterThan(0);
    expect(lostSoft).toBeGreaterThan(lostCraton * 2);
  });

  it('treats the pieces of a plate that has torn apart as plates of their own', () => {
    // One "plate" that is really two separate caps, with the rest of the globe a second plate.
    const plateOf = new Int32Array(N);
    for (let v = 0; v < N; v++) plateOf[v] = Math.abs(z(v)) > 0.6 ? 0 : 1;
    const plates: Plate[] = [
      { id: 0, seedVertex: 0, axis: [1, 0, 0], angularSpeed: 0.004 },
      { id: 1, seedVertex: 0, axis: [0, 1, 0], angularSpeed: 0.004 },
    ];
    const w = createState(lattice);
    w.thickness.fill(OCEAN_THICKNESS);
    const t = createTectonics(w, { plateOf, plates });
    for (let i = 0; i < 6; i++) stepTectonics(t, 1);
    expect(t.omega.length / 3).toBe(3); // the second cap became plate 2
    expect(new Set(resample(t).plate).size).toBe(3);
    // The new piece moves differently from the plate it broke from, so the two can drift apart.
    const wp = (id: number) => [t.omega[id * 3]!, t.omega[id * 3 + 1]!, t.omega[id * 3 + 2]!];
    expect(wp(2)).not.toEqual(wp(0));
    // A snapshot taken now restores the plates' motions along with the crust.
    const snap = snapshot(t);
    t.omega = new Float64Array(6);
    restore(t, snap);
    expect(t.omega.length / 3).toBe(3);
  });
});

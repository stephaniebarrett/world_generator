import { describe, expect, it } from 'vitest';
import { buildLattice } from './lattice';
import { LatticeIndex } from './latticeIndex';
import { driftAndSpin, plateOmega } from './motion';
import { plateCentroid } from './plateEdits';
import { generatePlates } from './plates';
import { prepareWorld } from './setup';
import { createTectonics, stepTectonics } from './tectonics';
import { createState, newRecipe } from './world';

describe('plate motion', () => {
  it('takes apart into the drift of the centre and the spin about it', () => {
    const centre = [0, 0, 1] as const;
    const w = plateOmega(centre, [1, 0], 0.01, 0.004);
    const { drift, spin } = driftAndSpin(centre, w);
    expect(drift).toBeCloseTo(0.01, 10);
    expect(spin).toBeCloseTo(0.004, 10);
    // The centre itself moves east at the drift speed: at the north pole east is undefined, so look at the equator instead.
    const eq = plateOmega([1, 0, 0], [1, 0], 0.01, 0);
    expect(eq[2]).toBeCloseTo(0.01, 10); // rotating about +z carries the point at (1, 0, 0) toward +y, which is east there
  });

  it('starts every generated plate with some drift, and gives some of them spin', () => {
    const lattice = buildLattice(30);
    let spun = 0, total = 0;
    for (const seed of ['a', 'b', 'c', 'd']) {
      const { plates } = generatePlates(createState(lattice), seed);
      for (const p of plates) {
        const c: [number, number, number] = [lattice.positions[p.seedVertex * 3]!, lattice.positions[p.seedVertex * 3 + 1]!, lattice.positions[p.seedVertex * 3 + 2]!];
        const { drift, spin } = driftAndSpin(c, [p.axis[0] * p.angularSpeed, p.axis[1] * p.angularSpeed, p.axis[2] * p.angularSpeed]);
        expect(drift).toBeGreaterThan(0.0015);
        expect(drift).toBeLessThan(0.02);
        if (Math.abs(spin) > 0.0005) spun++;
        total++;
      }
    }
    expect(spun).toBeGreaterThan(total / 4);
  });

  it('gives a plate the user adds the spin they chose', () => {
    const lattice = buildLattice(30);
    const centre = [0, 1, 0] as const;
    const edit = { kind: 'addPlate', center: centre, radius: 0.3, axis: [0, 0, 1], angularSpeed: 0.005, spin: -0.012, time: 0 } as const;
    const { setup } = prepareWorld({ ...newRecipe('spin', 30), edits: [edit] }, lattice);
    const plate = setup.plates[setup.plates.length - 1]!;
    const { drift, spin } = driftAndSpin(centre, [plate.axis[0] * plate.angularSpeed, plate.axis[1] * plate.angularSpeed, plate.axis[2] * plate.angularSpeed]);
    expect(spin).toBeCloseTo(-0.012, 8);
    expect(drift).toBeCloseTo(0.005, 8);
  });

  it('sets a plate\'s speed and spin from an edit, keeping the way it was heading', () => {
    const lattice = buildLattice(30);
    const base = prepareWorld(newRecipe('motion', 30), lattice);
    const at = [0, 0, 1] as const;
    const id = base.setup.plateOf[new LatticeIndex(lattice).nearest(at[0], at[1], at[2])]!;
    const before = base.setup.plates[id]!;
    const edit = { kind: 'plateMotion', at, speed: 0.012, spin: 0.003, time: 0 } as const;
    const after = prepareWorld({ ...newRecipe('motion', 30), edits: [edit] }, lattice).setup.plates[id]!;
    const centre = plateCentroid(lattice, base.setup.plateOf, id);
    const w = (p: typeof before) => [p.axis[0] * p.angularSpeed, p.axis[1] * p.angularSpeed, p.axis[2] * p.angularSpeed] as const;
    const got = driftAndSpin(centre, w(after));
    expect(got.drift).toBeCloseTo(0.012, 8);
    expect(got.spin).toBeCloseTo(0.003, 8);
    // Same heading: the drift velocities point the same way.
    const velocity = (p: typeof before) => { const [x, y, z] = w(p); return [y * centre[2] - z * centre[1], z * centre[0] - x * centre[2], x * centre[1] - y * centre[0]]; };
    const a = velocity(before), b = velocity(after);
    const cos = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(...a) * Math.hypot(...b));
    expect(cos).toBeGreaterThan(0.999);
  });

  it('lets neighbouring plates pull on each other, spin included, and keeps all plates alike', () => {
    const lattice = buildLattice(24);
    const plateOf = new Int32Array(lattice.vertexCount);
    for (let v = 0; v < lattice.vertexCount; v++) plateOf[v] = lattice.positions[v * 3 + 2]! > 0 ? 0 : 1;
    const world = createState(lattice);
    world.thickness.fill(7);
    // Both plates drift the same way but one also spins, and they share a long border.
    const setup = {
      plateOf,
      plates: [
        { id: 0, seedVertex: 0, axis: [1, 0, 0] as const, angularSpeed: 0.004 },
        { id: 1, seedVertex: 0, axis: [0.6, 0, 0.8] as const, angularSpeed: 0.02 },
      ],
    };
    const t = createTectonics(world, setup);
    const gap = () => Math.hypot(t.omega[0]! - t.omega[3]!, t.omega[1]! - t.omega[4]!, t.omega[2]! - t.omega[5]!);
    const before = gap();
    const driveGap = () => Math.hypot(t.omegaDrive[0]! - t.omegaDrive[3]!, t.omegaDrive[1]! - t.omegaDrive[4]!, t.omegaDrive[2]! - t.omegaDrive[5]!);
    const driveBefore = driveGap();
    for (let i = 0; i < 40; i++) stepTectonics(t, 1);
    expect(gap()).toBeLessThan(before);
    expect(driveGap()).toBeLessThan(driveBefore); // and the change lasts: what each is driven toward moves too
  });
});

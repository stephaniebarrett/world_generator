import { describe, expect, it } from 'vitest';
import { buildLattice } from './lattice';
import { generatePlates, type PlateSetup } from './plates';
import { createTectonics, densityOf, pileWeight, resample, restore, snapshot, stepTectonics, type TectonicState } from './tectonics';
import { prepareWorld } from './setup';
import { createState, newRecipe, type BrushEdit, type WorldState } from './world';

const lattice = buildLattice(24); // 5,762 points
const SPEED = 0.01; // rad per My

/** Two hemispheres split at z = 0; plate 0 is z > 0. Rotations about +x with the given signs. */
function hemispheres(speed0: number, speed1: number): PlateSetup {
  const plateOf = new Int32Array(lattice.vertexCount);
  for (let v = 0; v < lattice.vertexCount; v++) plateOf[v] = lattice.positions[v * 3 + 2]! > 0 ? 0 : 1;
  return {
    plateOf,
    plates: [
      { id: 0, seedVertex: 0, axis: [1, 0, 0], angularSpeed: speed0 },
      { id: 1, seedVertex: 0, axis: [1, 0, 0], angularSpeed: speed1 },
    ],
  };
}

function world(thickness: number): WorldState {
  const w = createState(lattice);
  w.thickness.fill(thickness);
  return w;
}

function run(t: TectonicState, steps: number, dt = 1): void {
  for (let i = 0; i < steps; i++) stepTectonics(t, dt);
}

/** Points near the fault where relative motion is greatest (|y| near 1, |z| near 0). */
function nearFault(t: TectonicState, halfWidth = 0.12): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.crust.count; i++) {
    if (Math.abs(t.crust.pos[i * 3 + 1]!) > 0.8 && Math.abs(t.crust.pos[i * 3 + 2]!) < halfWidth) out.push(i);
  }
  return out;
}

describe('tectonics', () => {
  it('moves points rigidly on the unit sphere', () => {
    // Plates that never touch: one plate, so nothing interacts.
    const setup: PlateSetup = {
      plateOf: new Int32Array(lattice.vertexCount),
      plates: [{ id: 0, seedVertex: 0, axis: [0, 1, 0], angularSpeed: 0.02 }],
    };
    const t = createTectonics(world(7), setup);
    const before = Float64Array.from(t.crust.pos.slice(0, 3 * 50));
    run(t, 10);
    expect(t.crust.count).toBe(lattice.vertexCount);
    for (let i = 0; i < t.crust.count; i++) {
      const x = t.crust.pos[i * 3]!, y = t.crust.pos[i * 3 + 1]!, z = t.crust.pos[i * 3 + 2]!;
      expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(1e-12);
    }
    // Pair distance is preserved.
    const d = (a: ArrayLike<number>, i: number, j: number) =>
      Math.hypot(a[i * 3]! - a[j * 3]!, a[i * 3 + 1]! - a[j * 3 + 1]!, a[i * 3 + 2]! - a[j * 3 + 2]!);
    expect(Math.abs(d(t.crust.pos, 3, 40) - d(before, 3, 40))).toBeLessThan(1e-10);
    // Rotation really happened: 10 My x 0.02 rad.
    const moved = Math.hypot(t.crust.pos[3]! - before[3]!, t.crust.pos[4]! - before[4]!, t.crust.pos[5]! - before[5]!);
    expect(moved).toBeGreaterThan(0.01);
  });

  it('is deterministic', () => {
    const make = () => createTectonics(world(7), hemispheres(-SPEED, SPEED));
    const a = make();
    const b = make();
    run(a, 15);
    run(b, 15);
    expect(a.crust.count).toBe(b.crust.count);
    expect(Array.from(a.crust.pos.slice(0, a.crust.count * 3))).toEqual(Array.from(b.crust.pos.slice(0, b.crust.count * 3)));
    expect(Array.from(a.crust.thickness.slice(0, a.crust.count))).toEqual(Array.from(b.crust.thickness.slice(0, b.crust.count)));
  });

  it('subducts seafloor where plates close, leaving only a modest island arc', () => {
    const t = createTectonics(world(7), hemispheres(-SPEED, SPEED));
    let consumed = 0;
    for (let i = 0; i < 20; i++) {
      stepTectonics(t, 1);
      consumed += t.lastDeaths;
    }
    expect(consumed).toBeGreaterThan(50); // crust really goes under (new seafloor elsewhere keeps the count steady)
    const fault = nearFault(t);
    const maxThickness = Math.max(...fault.map((i) => t.crust.thickness[i]!));
    // An arc thickens seafloor but stays well short of a continental collision (see next test).
    expect(maxThickness).toBeGreaterThan(7);
    expect(maxThickness).toBeLessThan(30);
  });

  it('piles up mountains where two continents collide', () => {
    const t = createTectonics(world(35), hemispheres(-SPEED, SPEED));
    run(t, 25);
    const fault = nearFault(t, 0.2);
    const maxThickness = Math.max(...fault.map((i) => t.crust.thickness[i]!));
    expect(maxThickness).toBeGreaterThan(45);
    // Squeezed crust is piled over a wide belt, but far from the collision (over 3,000 km) the crust is hardly touched.
    for (let i = 0; i < t.crust.count; i++) {
      if (Math.abs(t.crust.pos[i * 3 + 2]!) > 0.5) expect(Math.abs(t.crust.thickness[i]! - 35)).toBeLessThan(0.5);
    }
  });

  it('spreads a fast collision over a wider belt than a slow one', () => {
    // The same time for each, a fifth of the speed for the slow one.
    const beltWidth = (speed: number, steps: number): number => {
      const t = createTectonics(world(35), hemispheres(-speed, speed));
      run(t, steps);
      // How far from the fault, on average, the crust has been piled up or thinned (weighted by how much).
      let sum = 0, weight = 0;
      for (let i = 0; i < t.crust.count; i++) {
        const change = Math.abs(t.crust.thickness[i]! - 35);
        sum += change * Math.abs(t.crust.pos[i * 3 + 2]!);
        weight += change;
      }
      return sum / weight;
    };
    const slow = beltWidth(SPEED / 5, 25);
    const fast = beltWidth(SPEED, 25);
    expect(fast).toBeGreaterThan(slow * 1.15);
  });

  it('piles a collision up further forward and back than along the border', () => {
    const radius = 0.14, forward = 0.28;
    // Closing along z: the same distance ahead of, behind, and along the border from the collision.
    const ahead = pileWeight(0, 0, 0.2, 0, 0, 1, radius, forward);
    const behind = pileWeight(0, 0, -0.2, 0, 0, 1, radius, forward);
    const along = pileWeight(0.2, 0, 0, 0, 0, 1, radius, forward);
    expect(ahead).toBeGreaterThan(0);
    expect(behind).toBeCloseTo(ahead, 12);
    expect(along).toBe(0); // 0.2 is past the sideways reach of 0.14
    expect(pileWeight(0, 0, 0.3, 0, 0, 1, radius, forward)).toBe(0); // and the forward zone ends at 0.28
    expect(pileWeight(0, 0, 0, 0, 0, 1, radius, forward)).toBe(1);
  });

  it('slows the front of a colliding plate while its back keeps coming, so the plate is compressed', () => {
    const t = createTectonics(world(35), hemispheres(-SPEED, SPEED));
    run(t, 15);
    // Plate 0 (z > 0) moves toward the fault at z = 0; a point's deviation that opposes its plate's motion is a slowing.
    let front = 0, frontN = 0, back = 0, backN = 0;
    for (let i = 0; i < t.crust.count; i++) {
      if (t.crust.plate[i] !== 0 || Math.abs(t.crust.pos[i * 3 + 1]!) < 0.5) continue;
      const z = t.crust.pos[i * 3 + 2]!;
      const toward = -t.crust.vel[i * 3 + 2]!; // away from the fault is +z for plate 0, so a slowing has vel.z > 0 here
      const slowing = -toward;
      if (z < 0.15) { front += slowing; frontN++; } else if (z > 0.6) { back += slowing; backN++; }
    }
    expect(frontN).toBeGreaterThan(0);
    expect(backN).toBeGreaterThan(0);
    // The front is held back more than the far side of the plate, which has barely felt it.
    expect(front / frontN).toBeGreaterThan(back / backN);
    expect(front / frontN).toBeGreaterThan(1e-5);
  });

  it('pulls the edges of plates that are opening faster than the rest, so the plates are stretched', () => {
    const t = createTectonics(world(7), hemispheres(SPEED, -SPEED));
    run(t, 10);
    let edge = 0, edgeN = 0, far = 0, farN = 0;
    for (let i = 0; i < t.crust.count; i++) {
      if (t.crust.plate[i] !== 0 || Math.abs(t.crust.pos[i * 3 + 1]!) < 0.5) continue;
      const z = t.crust.pos[i * 3 + 2]!;
      const away = t.crust.vel[i * 3 + 2]!; // plate 0 lies at z > 0, so away from the other plate is +z
      if (z < 0.15) { edge += away; edgeN++; } else if (z > 0.6) { far += away; farN++; }
    }
    expect(edgeN).toBeGreaterThan(0);
    expect(edge / edgeN).toBeGreaterThan(far / farN);
  });

  it('leaves a plate that nothing presses on moving as one rigid block', () => {
    const setup: PlateSetup = {
      plateOf: new Int32Array(lattice.vertexCount),
      plates: [{ id: 0, seedVertex: 0, axis: [0, 1, 0], angularSpeed: 0.02 }],
    };
    const t = createTectonics(world(7), setup);
    run(t, 10);
    for (let i = 0; i < t.crust.count * 3; i++) expect(t.crust.vel[i]).toBe(0);
  });

  it('creates new seafloor where plates pull apart, with no holes left', () => {
    const t = createTectonics(world(35), hemispheres(SPEED, -SPEED));
    run(t, 25);
    let fresh = 0;
    for (let i = 0; i < t.crust.count; i++) if (t.crust.age[i]! < 25) fresh++;
    expect(fresh).toBeGreaterThan(30);
    // New crust is thin seafloor; the rift thinned the old crust beside it.
    const young = [...Array(t.crust.count).keys()].filter((i) => t.crust.age[i]! < 25);
    expect(Math.min(...young.map((i) => t.crust.thickness[i]!))).toBeLessThan(10);
    // Coverage: every lattice vertex has a crust point within 1.5 spacings (resample finds one).
    const r = resample(t);
    expect(r.thickness.every((x) => x > 0)).toBe(true);
  });

  it('keeps the point count roughly constant over a long run with mixed motion', () => {
    const t = createTectonics(world(7), hemispheres(-SPEED, SPEED));
    run(t, 60);
    expect(t.crust.count).toBeGreaterThan(lattice.vertexCount * 0.6);
    expect(t.crust.count).toBeLessThan(lattice.vertexCount * 1.4);
  });

  it('restores snapshots exactly', () => {
    const t = createTectonics(world(7), hemispheres(-SPEED, SPEED));
    run(t, 5);
    const snap = snapshot(t);
    run(t, 8);
    const after = Array.from(t.crust.pos.slice(0, t.crust.count * 3));
    restore(t, snap);
    run(t, 8);
    expect(Array.from(t.crust.pos.slice(0, t.crust.count * 3))).toEqual(after);
  });

  it('gives thick crust a lower density than seafloor, and old seafloor a higher one', () => {
    expect(densityOf(35, 100)).toBeLessThan(densityOf(7, 100));
    expect(densityOf(7, 150)).toBeGreaterThan(densityOf(7, 10));
  });

  it('keeps plates whole and the crust count steady over a long realistic run', () => {
    const l = buildLattice(32);
    const land = (dabs: number[]): BrushEdit => ({ kind: 'brush', mode: 'land', falloff: 'smooth', radius: 0.5, strength: 1, dabs, time: 0 });
    const prepared = prepareWorld({ ...newRecipe('outlines', 32), edits: [land([0.9, -0.3, 0.3, 0.8, -0.1, 0.55]), land([0.7, 0.5, 0.5])] }, l);
    const t = createTectonics(prepared.world, prepared.setup, { erosion: true });
    run(t, 100);

    // Plates tile the globe, so the number of crust points must not drift.
    expect(Math.abs(t.crust.count - l.vertexCount)).toBeLessThan(l.vertexCount * 0.02);

    // Coherence, measured on the lattice: how many separate large pieces each plate is in, and how much of the
    // globe is thin bands (pieces never more than 2 cells from another plate). Before the polarity fix a run like
    // this had 24 large pieces, 7 plates split and 6.6% thin bands by 100 My.
    const { plate } = resample(t);
    const n = l.vertexCount;
    const depth = new Int32Array(n).fill(-1);
    const queue: number[] = [];
    for (let v = 0; v < n; v++) {
      for (let k = l.offsets[v]!; k < l.offsets[v + 1]!; k++) if (plate[l.neighbors[k]!] !== plate[v]) { depth[v] = 0; queue.push(v); break; }
    }
    for (let h = 0; h < queue.length; h++) {
      const v = queue[h]!;
      for (let k = l.offsets[v]!; k < l.offsets[v + 1]!; k++) {
        const w = l.neighbors[k]!;
        if (depth[w]! < 0 && plate[w] === plate[v]) { depth[w] = depth[v]! + 1; queue.push(w); }
      }
    }
    const seen = new Uint8Array(n);
    const bigPerPlate = new Map<number, number>();
    let bigPieces = 0, bandCells = 0, stray = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (seen[s0]) continue;
      const id = plate[s0]!;
      let size = 0, thick = 0;
      const stack = [s0];
      seen[s0] = 1;
      while (stack.length) {
        const v = stack.pop()!;
        size++;
        thick = Math.max(thick, depth[v]! < 0 ? 99 : depth[v]!);
        for (let k = l.offsets[v]!; k < l.offsets[v + 1]!; k++) {
          const w = l.neighbors[k]!;
          if (!seen[w] && plate[w] === id) { seen[w] = 1; stack.push(w); }
        }
      }
      if (size < 12) { stray += size; continue; }
      bigPieces++;
      bigPerPlate.set(id, (bigPerPlate.get(id) ?? 0) + 1);
      if (thick <= 2) bandCells += size;
    }
    const plates = new Set(plate).size;
    const split = [...bigPerPlate.values()].filter((c) => c > 1).length;
    expect(bigPieces).toBeLessThanOrEqual(plates + 3);
    expect(split).toBeLessThanOrEqual(2);
    expect(bandCells / n).toBeLessThan(0.02);
    expect(stray / n).toBeLessThan(0.03);
  }, 30000);

  it('erosion smooths collision mountains, and leaves flat ground alone', () => {
    // This world is all land, so eroded rock has nowhere to go but the lowlands: erosion redistributes it and
    // reduces relief (the spread of thickness) rather than lowering the capped peaks.
    const relief = (erosion: boolean) => {
      const t = createTectonics(world(35), hemispheres(-SPEED, SPEED), { erosion });
      run(t, 40);
      let mean = 0;
      for (let i = 0; i < t.crust.count; i++) mean += t.crust.thickness[i]!;
      mean /= t.crust.count;
      let variance = 0;
      for (let i = 0; i < t.crust.count; i++) variance += (t.crust.thickness[i]! - mean) ** 2;
      return Math.sqrt(variance / t.crust.count);
    };
    expect(relief(true)).toBeLessThan(relief(false));

    const calm = createTectonics(world(35), { plateOf: new Int32Array(lattice.vertexCount), plates: [{ id: 0, seedVertex: 0, axis: [0, 1, 0], angularSpeed: 0.01 }] }, { erosion: true });
    run(calm, 10);
    for (let i = 0; i < calm.crust.count; i++) expect(calm.crust.thickness[i]).toBeCloseTo(35, 9);
  });
});

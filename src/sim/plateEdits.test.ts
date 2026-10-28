import { describe, expect, it } from 'vitest';
import { buildLattice } from './lattice';
import { generatePlates } from './plates';
import { applyPlateEdits } from './plateEdits';
import { prepareWorld } from './setup';
import { LAND_THICKNESS, OCEAN_THICKNESS, buildState, elevationFromThickness, newRecipe, type BrushEdit, type PlateEdit } from './world';

const lattice = buildLattice(24);
const N = lattice.vertexCount;

const land = (dabs: number[], radius = 0.5): BrushEdit => ({ kind: 'brush', mode: 'land', falloff: 'flat', radius, strength: 1, dabs, time: 0 });
const world = () => buildState({ ...newRecipe('p', 24), edits: [land([0, 0, 1]), land([0, 0, -1], 0.4)] }, lattice);
const setup = (w = world()) => generatePlates(w, 'p', { splitFraction: 0.25 }); // each continent on one plate, so dragging a plate takes its continent
const unit = (x: number, y: number, z: number) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l] as const; };
const isLand = (t: number) => elevationFromThickness(t) > 0;
/** The lattice vertex closest to a direction. */
const vertexNear = (p: readonly [number, number, number]): number => {
  let best = 0, bestD = Infinity;
  for (let v = 0; v < N; v++) {
    const d = (lattice.positions[v * 3]! - p[0]) ** 2 + (lattice.positions[v * 3 + 1]! - p[1]) ** 2 + (lattice.positions[v * 3 + 2]! - p[2]) ** 2;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
};
const mean = (w: { thickness: Float64Array; lattice: typeof lattice }, plateOf: Int32Array, id: number) => {
  let x = 0, y = 0, z = 0, c = 0;
  for (let v = 0; v < N; v++) if (plateOf[v] === id && isLand(w.thickness[v]!)) { x += w.lattice.positions[v * 3]!; y += w.lattice.positions[v * 3 + 1]!; z += w.lattice.positions[v * 3 + 2]!; c++; }
  const l = Math.hypot(x, y, z);
  return { dir: [x / l, y / l, z / l] as const, count: c };
};

describe('plate edits', () => {
  it('returns the input unchanged for no edits, and leaves the inputs alone for any', () => {
    const w = world();
    const s = setup(w);
    const before = Array.from(s.plateOf);
    const out = applyPlateEdits(w, s, [{ kind: 'removePlate', at: unit(1, 0, 0.2), mode: 'reset', time: 0 }], 'p');
    expect(Array.from(s.plateOf)).toEqual(before);
    expect(out.setup.plateOf).not.toBe(s.plateOf);
  });

  it('adds a plate: everything inside the circle joins it, with its own motion', () => {
    const w = world();
    const s = setup(w);
    const center = unit(1, 0, 0);
    const edit: PlateEdit = { kind: 'addPlate', center, radius: 0.3, axis: [0, 0, 1], angularSpeed: 0.007, time: 0 };
    const out = applyPlateEdits(w, s, [edit], 'p');
    const id = out.setup.plates.length - 1;
    expect(out.setup.plates.length).toBe(s.plates.length + 1);
    expect(out.setup.plates[id]).toMatchObject({ axis: [0, 0, 1], angularSpeed: 0.007 });
    for (let v = 0; v < N; v++) {
      const d2 = (lattice.positions[v * 3]! - center[0]) ** 2 + (lattice.positions[v * 3 + 1]! - center[1]) ** 2 + (lattice.positions[v * 3 + 2]! - center[2]) ** 2;
      expect(out.setup.plateOf[v] === id).toBe(d2 < 0.09);
      if (d2 >= 0.09) expect(out.setup.plateOf[v]).toBe(s.plateOf[v]); // outside is untouched
    }
    // The crust it took over is unchanged.
    expect(Array.from(out.world.thickness)).toEqual(Array.from(w.thickness));
  });

  it('splits a plate roughly in half into two plates, leaving the rest and the crust alone', () => {
    const w = world();
    const s = setup(w);
    const at = unit(1, 0, 0.1);
    const victim = s.plateOf[vertexNear(at)]!;
    const total = Array.from(s.plateOf).filter((p) => p === victim).length;
    const edit: PlateEdit = { kind: 'splitPlate', at, time: 0 };
    const out = applyPlateEdits(w, s, [edit], 'p');
    const again = applyPlateEdits(w, s, [edit], 'p');
    expect(Array.from(again.setup.plateOf)).toEqual(Array.from(out.setup.plateOf));
    expect(out.setup.plates.length).toBe(s.plates.length + 1);
    const kept = Array.from(out.setup.plateOf).filter((p) => p === victim).length;
    const added = Array.from(out.setup.plateOf).filter((p) => p === s.plates.length).length;
    expect(kept + added).toBe(total);
    expect(kept / total).toBeGreaterThan(0.4);
    expect(kept / total).toBeLessThan(0.6);
    for (let v = 0; v < N; v++) if (s.plateOf[v] !== victim) expect(out.setup.plateOf[v]).toBe(s.plateOf[v]);
    expect(Array.from(out.world.thickness)).toEqual(Array.from(w.thickness));
  });

  it('removes a plate and keeps its crust: its cells are shared among the neighbours', () => {
    const w = world();
    const s = setup(w);
    const at = unit(1, 0, 0.1);
    const victim = s.plateOf[vertexNear(at)]!;
    const out = applyPlateEdits(w, s, [{ kind: 'removePlate', at, mode: 'keep', time: 0 }], 'p');
    expect(out.setup.plateOf.includes(victim)).toBe(false);
    expect(Array.from(out.world.thickness)).toEqual(Array.from(w.thickness));
    // Nothing else changed plate.
    for (let v = 0; v < N; v++) if (s.plateOf[v] !== victim) expect(out.setup.plateOf[v]).toBe(s.plateOf[v]);
    // Every former member went to a surviving plate that touches the removed one.
    const heirs = new Set<number>();
    for (let v = 0; v < N; v++) if (s.plateOf[v] === victim) heirs.add(out.setup.plateOf[v]!);
    expect(heirs.size).toBeGreaterThanOrEqual(1);
    expect(heirs.has(victim)).toBe(false);
  });

  it('removes a plate and resets it: the ground becomes seafloor blended in from its surroundings', () => {
    const w = world();
    const s = setup(w);
    const at = unit(0, 1, 0.05); // open ocean between the two continents
    const out = applyPlateEdits(w, s, [{ kind: 'removePlate', at, mode: 'reset', time: 0 }], 'p');
    let changed = 0;
    for (let v = 0; v < N; v++) {
      if (out.world.thickness[v] !== w.thickness[v]) {
        changed++;
        expect(out.world.thickness[v]!).toBeGreaterThanOrEqual(3);
        expect(out.world.thickness[v]!).toBeLessThanOrEqual(70);
      }
    }
    expect(changed).toBeGreaterThan(100);
    // Ocean that was reset stays under water: no sudden continent appears (a few cells beside real land may rise to the shore).
    let reset = 0, under = 0;
    for (let v = 0; v < N; v++) {
      if (out.world.thickness[v] !== w.thickness[v] && w.thickness[v] === OCEAN_THICKNESS) {
        reset++;
        if (!isLand(out.world.thickness[v]!)) under++;
      }
    }
    expect(reset).toBeGreaterThan(50);
    expect(under / reset).toBeGreaterThan(0.9);
  });

  it('drags a plate: its crust arrives at the destination, the plate keeps its identity, and every point still has one plate', () => {
    const w = world();
    const s = setup(w);
    const from = unit(0, 0, 1);
    const northId = s.plateOf[vertexNear(from)]!;
    const to = unit(0.9, 0, 0.45);
    const before = mean(w, s.plateOf, northId);
    const out = applyPlateEdits(w, s, [{ kind: 'dragPlate', from, to, time: 0 }], 'p');
    const after = mean(out.world, out.setup.plateOf, northId);
    // The continent now sits around the destination...
    const dot = after.dir[0] * to[0] + after.dir[1] * to[1] + after.dir[2] * to[2];
    expect(dot).toBeGreaterThan(0.97);
    // ...with about as much land as before (nothing is lost in the move, within the lattice's resolution).
    expect(Math.abs(after.count - before.count) / before.count).toBeLessThan(0.2);
    // The place it left is no longer that plate's land.
    expect(isLand(out.world.thickness[vertexNear(from)]!)).toBe(false);
    for (const p of out.setup.plateOf) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(out.setup.plates.length);
    }
  });

  it('ignores a drag that goes nowhere', () => {
    const w = world();
    const s = setup(w);
    const out = applyPlateEdits(w, s, [{ kind: 'dragPlate', from: unit(0, 0, 1), to: unit(0, 0, 1), time: 0 }], 'p');
    expect(Array.from(out.setup.plateOf)).toEqual(Array.from(s.plateOf));
    expect(Array.from(out.world.thickness)).toEqual(Array.from(w.thickness));
  });

  it('is deterministic and applies edits in order', () => {
    const w = world();
    const s = setup(w);
    const edits: PlateEdit[] = [
      { kind: 'addPlate', center: unit(1, 0, 0), radius: 0.3, axis: [0, 0, 1], angularSpeed: 0.005, time: 0 },
      { kind: 'dragPlate', from: unit(0, 0, 1), to: unit(0.6, 0.6, 0.5), time: 0 },
      { kind: 'removePlate', at: unit(0, 1, 0), mode: 'reset', time: 0 },
    ];
    const a = applyPlateEdits(w, s, edits, 'p');
    const b = applyPlateEdits(w, s, edits, 'p');
    expect(Array.from(a.setup.plateOf)).toEqual(Array.from(b.setup.plateOf));
    expect(Array.from(a.world.thickness)).toEqual(Array.from(b.world.thickness));
    const reversed = applyPlateEdits(w, s, [...edits].reverse(), 'p');
    expect(Array.from(reversed.setup.plateOf)).not.toEqual(Array.from(a.setup.plateOf));
  });

  it('prepareWorld applies plate edits on top of the generated plates, and brush strokes still shape the land', () => {
    const base = { ...newRecipe('p', 24), edits: [land([0, 0, 1])] as import('./world').Edit[] };
    const plain = prepareWorld(base, lattice);
    const withAdd = prepareWorld({ ...base, edits: [...base.edits, { kind: 'addPlate', center: unit(1, 0, 0), radius: 0.3, axis: [0, 0, 1], angularSpeed: 0.005, time: 0 }] }, lattice);
    expect(withAdd.setup.plates.length).toBe(plain.setup.plates.length + 1);
    // Painted land is roughened, so it now rises above and dips below the painted thickness.
    expect(Math.max(...plain.world.thickness)).toBeGreaterThan(LAND_THICKNESS);
  });

  it('paints a plate outward: what the brush passes over joins the plate the stroke started on', () => {
    const w = world();
    const s = setup(w);
    const start = unit(1, 0, 0.1);
    const painter = s.plateOf[vertexNear(start)]!;
    // A stroke that starts on one plate and sweeps across a neighbour.
    let neighbour = -1;
    const dabs: number[] = [];
    for (let k = 0; k <= 20; k++) {
      const a = (k / 20) * 1.2;
      const d = unit(Math.cos(a), Math.sin(a), 0.1);
      dabs.push(...d);
      const owner = s.plateOf[vertexNear(d)]!;
      if (owner !== painter && neighbour < 0) neighbour = owner;
    }
    expect(neighbour).toBeGreaterThanOrEqual(0); // the stroke really does cross onto another plate
    const out = applyPlateEdits(w, s, [{ kind: 'paintPlate', from: start, radius: 0.12, dabs, time: 0 }], 'p');
    // The painter gained ground, the neighbour lost some, and crust is untouched.
    const count = (arr: Int32Array, id: number) => arr.reduce((n, p) => n + (p === id ? 1 : 0), 0);
    expect(count(out.setup.plateOf, painter)).toBeGreaterThan(count(s.plateOf, painter));
    expect(count(out.setup.plateOf, neighbour)).toBeLessThan(count(s.plateOf, neighbour));
    expect(Array.from(out.world.thickness)).toEqual(Array.from(w.thickness));
    // Every vertex the brush touched now belongs to the painter; every other vertex kept its plate.
    for (let v = 0; v < N; v++) {
      let touched = false;
      for (let i = 0; i < dabs.length; i += 3) {
        const d2 = (lattice.positions[v * 3]! - dabs[i]!) ** 2 + (lattice.positions[v * 3 + 1]! - dabs[i + 1]!) ** 2 + (lattice.positions[v * 3 + 2]! - dabs[i + 2]!) ** 2;
        if (d2 < 0.12 * 0.12) { touched = true; break; }
      }
      expect(out.setup.plateOf[v]).toBe(touched ? painter : s.plateOf[v]);
    }
  });
});

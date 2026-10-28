import { describe, expect, it } from 'vitest';
import { buildLattice } from './lattice';
import { applyGenerate } from './landgen';
import { layoutPlates } from './plates';
import { prepareWorld } from './setup';
import { LAND_THICKNESS, createState, elevationFromThickness, newRecipe, type GenerateEdit } from './world';

const lattice = buildLattice(36); // 12,962 points
const N = lattice.vertexCount;
const plates = layoutPlates(lattice, 'plates');
const isLand = (t: number) => elevationFromThickness(t) > 0;

const edit = (style: GenerateEdit['style'], landFraction = 0.3, seed = 'g'): GenerateEdit => ({ kind: 'generate', style, landFraction, seed, time: 0 });

function generate(e: GenerateEdit, withPlates = true, l = lattice, p = plates) {
  const state = createState(l);
  applyGenerate(state, e, withPlates ? p.plateOf : undefined);
  return state;
}

/** Sizes of the connected landmasses, largest first. */
function landmasses(l: typeof lattice, thickness: Float64Array): number[] {
  const seen = new Uint8Array(l.vertexCount);
  const sizes: number[] = [];
  for (let s = 0; s < l.vertexCount; s++) {
    if (seen[s] || !isLand(thickness[s]!)) continue;
    let size = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const v = stack.pop()!;
      size++;
      for (let k = l.offsets[v]!; k < l.offsets[v + 1]!; k++) {
        const w = l.neighbors[k]!;
        if (!seen[w] && isLand(thickness[w]!)) { seen[w] = 1; stack.push(w); }
      }
    }
    sizes.push(size);
  }
  return sizes.sort((a, b) => b - a);
}
const landShare = (t: Float64Array) => t.reduce((n, x) => n + (isLand(x) ? 1 : 0), 0) / t.length;

describe('generate land', () => {
  for (const style of ['continents', 'pangaea', 'two', 'archipelago'] as const) {
    it(`${style}: reaches the land cover that was asked for`, () => {
      for (const want of [0.15, 0.3, 0.45]) {
        const got = landShare(generate(edit(style, want)).thickness);
        expect(Math.abs(got - want)).toBeLessThan(0.03);
      }
    });
  }

  it('pangaea is mostly one landmass, across seeds', () => {
    const shares = ['a', 'b', 'c', 'd', 'e', 'f'].map((seed) => {
      const sizes = landmasses(lattice, generate(edit('pangaea', 0.3, seed)).thickness);
      return sizes[0]! / sizes.reduce((a, b) => a + b, 0);
    });
    expect(shares.reduce((a, b) => a + b, 0) / shares.length).toBeGreaterThan(0.62);
    for (const share of shares) expect(share).toBeGreaterThan(0.45);
  });

  it('coastlines are irregular, not discs: peninsulas and bays', () => {
    // Coast cells of the largest landmass against those of a perfect disc of the same area (about 3.6 sqrt(area) on this lattice).
    const irregularity = (style: GenerateEdit['style'], cover: number) => {
      let sum = 0;
      const seeds = ['a', 'b', 'c', 'd', 'e', 'f'];
      for (const seed of seeds) {
        const t = generate(edit(style, cover, seed)).thickness;
        const land = (v: number) => isLand(t[v]!);
        const seen = new Uint8Array(N);
        let best: number[] = [];
        for (let s = 0; s < N; s++) {
          if (seen[s] || !land(s)) continue;
          const comp: number[] = [];
          const stack = [s];
          seen[s] = 1;
          while (stack.length) {
            const v = stack.pop()!;
            comp.push(v);
            for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) {
              const w = lattice.neighbors[k]!;
              if (!seen[w] && land(w)) { seen[w] = 1; stack.push(w); }
            }
          }
          if (comp.length > best.length) best = comp;
        }
        let coast = 0;
        for (const v of best) for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) if (!land(lattice.neighbors[k]!)) { coast++; break; }
        sum += coast / (3.6 * Math.sqrt(best.length));
      }
      return sum / seeds.length;
    };
    expect(irregularity('continents', 0.3)).toBeGreaterThan(1.25);
    expect(irregularity('pangaea', 0.3)).toBeGreaterThan(1.35);
    expect(irregularity('two', 0.3)).toBeGreaterThan(1.2);
    expect(irregularity('archipelago', 0.12)).toBeGreaterThan(1.5);
  });

  it('continents make several large landmasses', () => {
    for (const seed of ['a', 'b', 'c']) {
      const sizes = landmasses(lattice, generate(edit('continents', 0.3, seed)).thickness);
      const total = sizes.reduce((a, b) => a + b, 0);
      expect(sizes.filter((s) => s / total > 0.06).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('two supercontinents make two large landmasses', () => {
    const sizes = landmasses(lattice, generate(edit('two')).thickness);
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(sizes[0]! / total).toBeGreaterThan(0.25);
    expect(sizes[1]! / total).toBeGreaterThan(0.2);
  });

  it('an archipelago is many islands, none dominant', () => {
    const sizes = landmasses(lattice, generate(edit('archipelago', 0.12)).thickness);
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(sizes.length).toBeGreaterThanOrEqual(8);
    expect(sizes[0]! / total).toBeLessThan(0.45);
  });

  it('is repeatable, and a different seed makes different land', () => {
    const a = generate(edit('continents', 0.3, 'x')).thickness;
    const b = generate(edit('continents', 0.3, 'x')).thickness;
    const c = generate(edit('continents', 0.3, 'y')).thickness;
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('adds to existing land and never lowers anything', () => {
    const state = createState(lattice);
    for (let v = 0; v < N; v++) if (lattice.positions[v * 3]! > 0.9) state.thickness[v] = 40; // a painted highland
    const before = Float64Array.from(state.thickness);
    applyGenerate(state, edit('continents'), plates.plateOf);
    for (let v = 0; v < N; v++) expect(state.thickness[v]!).toBeGreaterThanOrEqual(before[v]!);
    expect(landShare(state.thickness)).toBeGreaterThan(landShare(before));
  });

  it('makes the same kind of land at another detail', () => {
    const coarse = buildLattice(20);
    const fine = buildLattice(60);
    const cs = landShare(generate(edit('continents'), false, coarse).thickness);
    const fs = landShare(generate(edit('continents'), false, fine).thickness);
    expect(Math.abs(cs - fs)).toBeLessThan(0.04);
    // Without plates the layout depends only on position, so the large landmasses agree.
    const big = (l: typeof coarse) => landmasses(l, generate(edit('continents'), false, l).thickness).filter((s) => s / l.vertexCount > 0.03).length;
    expect(Math.abs(big(coarse) - big(fine))).toBeLessThanOrEqual(1);
  });

  it('keeps land away from plate boundaries more than plate-blind generation does', () => {
    const boundary = new Uint8Array(N);
    for (let v = 0; v < N; v++) {
      for (let k = lattice.offsets[v]!; k < lattice.offsets[v + 1]!; k++) if (plates.plateOf[lattice.neighbors[k]!] !== plates.plateOf[v]) { boundary[v] = 1; break; }
    }
    const onBoundary = (t: Float64Array) => {
      let land = 0, on = 0;
      for (let v = 0; v < N; v++) if (isLand(t[v]!)) { land++; on += boundary[v]!; }
      return on / land;
    };
    let aware = 0, blind = 0;
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'];
    for (const seed of seeds) {
      aware += onBoundary(generate(edit('continents', 0.3, seed), true).thickness);
      blind += onBoundary(generate(edit('continents', 0.3, seed), false).thickness);
    }
    expect(aware / seeds.length).toBeLessThan(blind / seeds.length);
  });

  it('works through a whole recipe, after plate edits, and the plates stay as they were', () => {
    const base = { ...newRecipe('flow', 30), edits: [] as import('./world').Edit[] };
    const paintPlate = { kind: 'paintPlate' as const, from: [1, 0, 0] as [number, number, number], radius: 0.2, dabs: [1, 0, 0, 0.9, 0.4, 0.1], time: 0 };
    const before = prepareWorld({ ...base, edits: [paintPlate] }, buildLattice(30));
    const after = prepareWorld({ ...base, edits: [paintPlate, edit('continents')] }, buildLattice(30));
    // Generating land adds land but does not move the plates (apart from keeping small landmasses whole).
    expect(landShare(after.world.thickness)).toBeGreaterThan(0.2);
    let moved = 0;
    for (let v = 0; v < after.setup.plateOf.length; v++) if (after.setup.plateOf[v] !== before.setup.plateOf[v]) moved++;
    expect(moved / after.setup.plateOf.length).toBeLessThan(0.15);
    expect(Math.max(...after.world.thickness)).toBeGreaterThan(LAND_THICKNESS);
  });
});

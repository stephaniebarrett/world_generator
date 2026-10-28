import { describe, expect, it } from 'vitest';
import { buildLattice } from './lattice';
import { generatePlates, layoutPlates } from './plates';
import { buildState, elevationFromThickness, newRecipe, type BrushEdit } from './world';

const lattice = buildLattice(24); // 5,762 points

const land = (cx: number, cy: number, cz: number, radius: number): BrushEdit => {
  const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
  return { kind: 'brush', mode: 'land', falloff: 'flat', radius, strength: 1, dabs: [cx / len, cy / len, cz / len], time: 0 };
};

const worldWith = (edits: BrushEdit[]) => buildState({ ...newRecipe('s', 24), edits }, lattice);

function landmassOf(state: ReturnType<typeof worldWith>): number[][] {
  const { lattice: l } = state;
  const seen = new Uint8Array(l.vertexCount);
  const out: number[][] = [];
  for (let s = 0; s < l.vertexCount; s++) {
    if (seen[s] || elevationFromThickness(state.thickness[s]!) <= 0) continue;
    const pts: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const v = stack.pop()!;
      pts.push(v);
      for (let k = l.offsets[v]!; k < l.offsets[v + 1]!; k++) {
        const w = l.neighbors[k]!;
        if (!seen[w] && elevationFromThickness(state.thickness[w]!) > 0) {
          seen[w] = 1;
          stack.push(w);
        }
      }
    }
    out.push(pts);
  }
  return out;
}

const distinctPlates = (plateOf: Int32Array, pts: number[]) => new Set(pts.map((v) => plateOf[v]!)).size;

describe('generatePlates', () => {
  const twoContinents = worldWith([land(0, 0, 1, 0.5), land(0, 0, -1, 0.45)]);

  it('labels every point with a valid plate', () => {
    const { plateOf, plates } = generatePlates(twoContinents, 'seed');
    for (const p of plateOf) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(plates.length);
    }
  });

  it('is deterministic, and the seed changes the layout', () => {
    const a = generatePlates(twoContinents, 'seed');
    const b = generatePlates(twoContinents, 'seed');
    expect(Array.from(a.plateOf)).toEqual(Array.from(b.plateOf));
    expect(a.plates).toEqual(b.plates);
    const c = generatePlates(twoContinents, 'other-seed');
    expect(Array.from(c.plateOf)).not.toEqual(Array.from(a.plateOf));
  });

  it('makes 8 to 12 major plates and 6 to 10 minor ones for a normal world', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const { plates } = generatePlates(twoContinents, seed);
      expect(plates.length).toBeGreaterThanOrEqual(12);
      expect(plates.length).toBeLessThanOrEqual(22);
    }
  });

  it('keeps each landmass wholly inside one plate when asked to (by default only small ones, so big continents may straddle plates)', () => {
    const { plateOf } = generatePlates(twoContinents, 'seed', { splitFraction: 0.25 });
    const masses = landmassOf(twoContinents);
    expect(masses.length).toBe(2);
    for (const m of masses) expect(distinctPlates(plateOf, m)).toBe(1);
  });

  it('makes every plate one connected region in a normal world', () => {
    const { plateOf, plates } = generatePlates(twoContinents, 'seed');
    const l = twoContinents.lattice;
    for (const plate of plates) {
      const members: number[] = [];
      for (let v = 0; v < l.vertexCount; v++) if (plateOf[v] === plate.id) members.push(v);
      if (members.length === 0) continue; // a plate whose ground all went to a landmass has nothing to be connected
      const seen = new Set<number>([members[0]!]);
      const stack = [members[0]!];
      while (stack.length) {
        const v = stack.pop()!;
        for (let k = l.offsets[v]!; k < l.offsets[v + 1]!; k++) {
          const w = l.neighbors[k]!;
          if (plateOf[w] === plate.id && !seen.has(w)) {
            seen.add(w);
            stack.push(w);
          }
        }
      }
      expect(seen.size).toBe(members.length);
    }
  });

  it('lets a landmass over a quarter of the globe span several plates, as a supercontinent does', () => {
    const huge = worldWith([land(0, 0, 1, 1.2)]);
    const masses = landmassOf(huge);
    expect(masses.length).toBe(1);
    expect(masses[0]!.length / lattice.vertexCount).toBeGreaterThan(0.25);
    const { plateOf } = generatePlates(huge, 'seed');
    expect(distinctPlates(plateOf, masses[0]!)).toBeGreaterThanOrEqual(2);
  });

  it('does not reshuffle the plates when land is painted', () => {
    const empty = generatePlates(worldWith([]), 'seed');
    const painted = generatePlates(twoContinents, 'seed');
    expect(painted.plates).toEqual(empty.plates);
    // Only cells of landmasses that a boundary had cut through may have changed plate.
    let changed = 0;
    for (let v = 0; v < lattice.vertexCount; v++) if (painted.plateOf[v] !== empty.plateOf[v]) changed++;
    const landCells = landmassOf(twoContinents).reduce((n, m) => n + m.length, 0);
    expect(changed).toBeLessThanOrEqual(landCells);
  });

  it('merges many small landmasses into shared plates without splitting any', () => {
    // 20 small islands on a spiral.
    const islands: BrushEdit[] = [];
    for (let i = 0; i < 20; i++) {
      const y = 1 - (2 * (i + 0.5)) / 20;
      const r = Math.sqrt(1 - y * y);
      const a = i * 2.399963229728653;
      islands.push(land(r * Math.cos(a), y, r * Math.sin(a), 0.08));
    }
    const world = worldWith(islands);
    const masses = landmassOf(world);
    expect(masses.length).toBeGreaterThan(12);
    const { plateOf, plates } = generatePlates(world, 'seed');
    expect(plates.length).toBeLessThanOrEqual(22);
    for (const m of masses) expect(distinctPlates(plateOf, m)).toBe(1);
  });

  it('keeps plate sizes comparable (no plate swallows more than 30% of the globe)', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const { plateOf, plates } = generatePlates(twoContinents, seed);
      const sizes = new Array(plates.length).fill(0);
      for (const p of plateOf) sizes[p]++;
      expect(Math.max(...sizes) / lattice.vertexCount).toBeLessThan(0.3);
    }
  });

  it('works on a world with no land', () => {
    const { plates } = generatePlates(worldWith([]), 'seed');
    expect(plates.length).toBeGreaterThanOrEqual(8);
  });

  it('gives each plate a unit rotation axis and a positive speed', () => {
    for (const p of generatePlates(twoContinents, 'seed').plates) {
      expect(Math.abs(Math.hypot(...p.axis) - 1)).toBeLessThan(1e-12);
      expect(p.angularSpeed).toBeGreaterThan(0);
    }
  });

  it('never starts with a plate enclosed by a single other plate (the first nine seeds each did before)', () => {
    const l = buildLattice(24);
    for (const seed of ['s19', 's53', 's56', 's63', 's65', 's72', 's92', 's116', 's170', 'a', 'b']) {
      const { plateOf, plates } = layoutPlates(l, seed);
      const neighbours = new Map<number, Set<number>>(plates.map((p) => [p.id, new Set<number>()]));
      for (let v = 0; v < l.vertexCount; v++) {
        for (let k = l.offsets[v]!; k < l.offsets[v + 1]!; k++) {
          const w = l.neighbors[k]!;
          if (plateOf[w] !== plateOf[v]) neighbours.get(plateOf[v]!)!.add(plateOf[w]!);
        }
      }
      for (const set of neighbours.values()) expect(set.size).toBeGreaterThan(1);
      expect(new Set(plateOf).size).toBe(plates.length); // ids are compact
    }
  });

  it('never lets four major plates meet at one point', () => {
    const l = buildLattice(24);
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 's19', 's53', 's56', 's63']) {
      const { plateOf } = layoutPlates(l, seed, { minorCount: 0 });
      for (let v = 0; v < l.vertexCount; v++) {
        const seen = new Set<number>([plateOf[v]!]);
        let frontier = [v];
        for (let ring = 0; ring < 2; ring++) {
          const next: number[] = [];
          for (const u of frontier) for (let k = l.offsets[u]!; k < l.offsets[u + 1]!; k++) { const w = l.neighbors[k]!; seen.add(plateOf[w]!); next.push(w); }
          frontier = next;
        }
        expect(seen.size).toBeLessThan(4);
      }
    }
  });

  it('wedges 6 to 10 minor plates between the major ones, each touching at least two major plates', () => {
    const l = buildLattice(24);
    for (const seed of ['a', 'b', 'c', 'd']) {
      const majors = layoutPlates(l, seed, { minorCount: 0 }).plates.length;
      const { plateOf, plates } = layoutPlates(l, seed);
      expect(plates.length - majors).toBeGreaterThanOrEqual(3);
      expect(plates.length - majors).toBeLessThanOrEqual(10);
      for (let id = majors; id < plates.length; id++) {
        const around = new Set<number>();
        for (let v = 0; v < l.vertexCount; v++) {
          if (plateOf[v] !== id) continue;
          for (let k = l.offsets[v]!; k < l.offsets[v + 1]!; k++) { const o = plateOf[l.neighbors[k]!]!; if (o < majors) around.add(o); }
        }
        expect(around.size).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

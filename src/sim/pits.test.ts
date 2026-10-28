import { describe, expect, it } from 'vitest';
import { SEA_LEVEL_THICKNESS } from './crust';
import { buildLattice } from './lattice';
import { fillLoneWater } from './pits';
import { prepareWorld } from './setup';
import { newRecipe, type Edit } from './world';

const lattice = buildLattice(20);

describe('lone water cells', () => {
  it('raises a single sea cell with land all round it, and leaves real bays and lakes of several cells alone', () => {
    const t = new Float64Array(lattice.vertexCount).fill(34);
    t[100] = 28; // a lone pond
    // A bay: a cell and its neighbours all low.
    t[900] = 20;
    for (let k = lattice.offsets[900]!; k < lattice.offsets[901]!; k++) t[lattice.neighbors[k]!] = 20;
    expect(fillLoneWater(lattice, t)).toBe(1);
    expect(t[100]).toBeGreaterThan(SEA_LEVEL_THICKNESS);
    expect(t[900]).toBe(20);
  });

  it('leaves no lone water cells in a generated world', () => {
    for (const seed of ['first-world', 'c']) {
      const edits: Edit[] = [{ kind: 'generate', style: 'continents', landFraction: 0.3, seed, time: 0 }];
      const { world } = prepareWorld({ ...newRecipe(seed, 30), edits }, buildLattice(30));
      const l = world.lattice;
      for (let v = 0; v < l.vertexCount; v++) {
        if (world.thickness[v]! > SEA_LEVEL_THICKNESS) continue;
        let land = 0, total = 0;
        for (let k = l.offsets[v]!; k < l.offsets[v + 1]!; k++) { total++; if (world.thickness[l.neighbors[k]!]! > SEA_LEVEL_THICKNESS) land++; }
        expect(land).toBeLessThan(total - 1);
      }
    }
  });
});

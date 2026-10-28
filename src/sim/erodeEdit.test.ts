import { describe, expect, it } from 'vitest';
import { buildLattice } from './lattice';
import { prepareWorld } from './setup';
import { newRecipe, type Edit } from './world';

const lattice = buildLattice(20);
const land: Edit = { kind: 'brush', mode: 'land', falloff: 'smooth', radius: 0.7, strength: 1, dabs: [0, 0, 1], time: 0 };
const erode: Edit = { kind: 'erode', my: 10, time: 0 };
const make = (edits: Edit[]) => prepareWorld({ ...newRecipe('erode', 20), edits }, lattice);

describe('hand-applied erosion before the run', () => {
  it('lowers the peaks, deterministically, and can be repeated', () => {
    const plain = make([land]).world.thickness;
    const once = make([land, erode]).world.thickness;
    const twice = make([land, erode, erode]).world.thickness;
    expect(Math.max(...once)).toBeLessThan(Math.max(...plain));
    expect(Math.max(...twice)).toBeLessThan(Math.max(...once));
    expect(Array.from(make([land, erode]).world.thickness)).toEqual(Array.from(once));
  });

  it('leaves the painted land that painting continues from untouched', () => {
    expect(Array.from(make([land, erode]).raw.thickness)).toEqual(Array.from(make([land]).raw.thickness));
  });
});

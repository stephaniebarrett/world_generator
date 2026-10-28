import { describe, expect, it } from 'vitest';
import { buildLattice } from './lattice';
import {
  LAND_THICKNESS,
  OCEAN_THICKNESS,
  buildState,
  elevationFromThickness,
  newRecipe,
  type BrushEdit,
} from './world';

const stroke = (over: Partial<BrushEdit> = {}): BrushEdit => ({
  kind: 'brush',
  mode: 'land',
  falloff: 'flat',
  radius: 0.5,
  strength: 1,
  dabs: [0, 0, 1],
  time: 0,
  ...over,
});

function landFraction(freq: number, edit: BrushEdit): number {
  const state = buildState({ ...newRecipe('s', freq), edits: [edit] });
  let land = 0;
  for (const t of state.thickness) if (elevationFromThickness(t) > 0) land++;
  return land / state.thickness.length;
}

describe('world', () => {
  it('starts as all ocean below sea level', () => {
    const state = buildState(newRecipe('s', 4));
    expect(state.thickness.every((t) => t === OCEAN_THICKNESS)).toBe(true);
    expect(elevationFromThickness(OCEAN_THICKNESS)).toBeLessThan(0);
    expect(elevationFromThickness(LAND_THICKNESS)).toBeGreaterThan(0);
  });

  it('paints land inside the radius only', () => {
    const state = buildState({ ...newRecipe('s', 8), edits: [stroke()] });
    const { positions } = state.lattice;
    for (let v = 0; v < state.lattice.vertexCount; v++) {
      const dx = positions[v * 3]!, dy = positions[v * 3 + 1]!, dz = positions[v * 3 + 2]! - 1;
      const inside = dx * dx + dy * dy + dz * dz < 0.25;
      expect(state.thickness[v]).toBe(inside ? LAND_THICKNESS : OCEAN_THICKNESS);
    }
  });

  it('replays to byte-identical state', () => {
    const recipe = { ...newRecipe('s', 10), edits: [stroke({ falloff: 'smooth', strength: 0.4, dabs: [0, 0, 1, 0, 1, 0] })] };
    const lattice = buildLattice(10);
    const a = buildState(recipe, lattice);
    const b = buildState(recipe, lattice);
    expect(Array.from(a.thickness)).toEqual(Array.from(b.thickness));
  });

  it('means the same thing at different detail (similar land fraction)', () => {
    const edit = stroke({ radius: 0.6 });
    const coarse = landFraction(16, edit);
    const fine = landFraction(48, edit);
    expect(Math.abs(coarse - fine)).toBeLessThan(0.02);
  });

  it('raise and lower move thickness and clamp', () => {
    const up = buildState({ ...newRecipe('s', 4), edits: [stroke({ mode: 'raise', strength: 5 })] });
    const down = buildState({ ...newRecipe('s', 4), edits: [stroke({ mode: 'lower', strength: 50 })] });
    expect(Math.max(...up.thickness)).toBe(OCEAN_THICKNESS + 5);
    expect(Math.min(...down.thickness)).toBe(3);
  });
});

// Everything a run starts from, built by replaying the edits in the order they were made.
//
// The plates are laid out from the seed alone. Painting, generating land and plate edits then replay in
// sequence, so generated land sees the plates as they are at that moment (and builds terrain from how they move),
// and painting never reshuffles plates. Finally the land is roughened, small landmasses a boundary cuts through are
// kept whole, and the rock at every point is worked out from the land and the plates.

import { assignGeology } from './geology';
import { DEFAULT_EROSION, erodeThickness } from './erosion';
import { ROCKS } from './crust';
import type { Lattice } from './lattice';
import { applyGenerate } from './landgen';
import { PlateEditor, type Prepared } from './plateEdits';
import { fillLoneWater } from './pits';
import { keepLandmassesWhole, layoutPlates } from './plates';
import { addRoughness } from './roughness';
import { applyBrush, createState, type Recipe, type WorldState } from './world';

export interface PreparedWorld extends Prepared {
  /** The land as the edits left it, before roughness: what painting continues from. */
  readonly raw: WorldState;
  /** Rock type at every point (see ROCKS). */
  readonly rock: Uint8Array;
}

export function prepareWorld(recipe: Recipe, lattice: Lattice): PreparedWorld {
  const editor = new PlateEditor(createState(lattice), layoutPlates(lattice, recipe.seed), recipe.seed);
  for (const edit of recipe.edits) {
    if (edit.kind === 'brush') applyBrush(editor.state, edit);
    else if (edit.kind === 'generate') applyGenerate(editor.state, edit, editor.plateOf, editor.plates);
    else if (edit.kind !== 'erode') editor.apply(edit);
  }
  const raw: WorldState = { lattice, thickness: Float64Array.from(editor.state.thickness) };
  const world = addRoughness(editor.state, recipe.seed);
  fillLoneWater(lattice, world.thickness);
  const plateOf = Int32Array.from(editor.plateOf);
  keepLandmassesWhole(world, plateOf);
  const plates = [...editor.plates];
  let rock = assignGeology(lattice, world.thickness, plateOf, plates, recipe.seed);
  // Hand-applied erosion before the run wears the finished relief; fresh relief wears faster than the long-run rate (as in terrain.ts).
  const erosions = recipe.edits.filter((e) => e.kind === 'erode' && e.time === 0);
  if (erosions.length > 0) {
    const erodibility = Float64Array.from(rock, (r) => ROCKS[r]!.erodibility);
    for (const e of erosions) if (e.kind === 'erode') erodeThickness(lattice, world.thickness, e.my, { ...DEFAULT_EROSION, incision: 45000 }, erodibility);
    fillLoneWater(lattice, world.thickness);
    rock = assignGeology(lattice, world.thickness, plateOf, plates, recipe.seed);
  }
  return { world, setup: { plateOf, plates }, raw, rock };
}

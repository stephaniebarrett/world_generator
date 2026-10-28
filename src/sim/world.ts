// World recipe and the state it produces. A world is fully described by its
// recipe; state is always rebuilt by replaying edits, so it is reproducible.

import { buildLattice, type Lattice } from './lattice';
import { LAND_THICKNESS, MAX_THICKNESS, MIN_THICKNESS, OCEAN_THICKNESS, SEA_LEVEL_THICKNESS, elevationFromThickness } from './crust';
import { applyGenerate } from './landgen';

// Re-exported so the rest of the code can keep importing them from here.
export { LAND_THICKNESS, OCEAN_THICKNESS, SEA_LEVEL_THICKNESS, elevationFromThickness };

/** Bump when any sim rule changes, so old recipes can replay with old rules. */
export const SIM_VERSION = 1;



export type Falloff = 'smooth' | 'linear' | 'flat';

/**
 * One brush stroke. Positions are unit vectors on the sphere and the radius
 * is a chord length on the unit sphere (about the angle in radians for small
 * radii), so the stroke means the same thing at any lattice detail and needs
 * no trigonometry to evaluate.
 */
export interface BrushEdit {
  readonly kind: 'brush';
  /** 'land'/'ocean' pull thickness toward a target; 'raise'/'lower' add or remove thickness. */
  readonly mode: 'land' | 'ocean' | 'raise' | 'lower';
  readonly falloff: Falloff;
  readonly radius: number;
  /** 0..1 for land/ocean (fraction moved toward the target per dab), km per dab for raise/lower. */
  readonly strength: number;
  /** Dab centres along the stroke, xyz interleaved. */
  readonly dabs: readonly number[];
  /** Sim time in million years at which the edit was made. */
  readonly time: number;
}

/** A new plate carved out of whatever plates lie under a circle, moving about its own axis. */
export interface AddPlateEdit {
  readonly kind: 'addPlate';
  /** Unit vector at the centre of the circle. */
  readonly center: readonly [number, number, number];
  /** Chord radius, as for brushes. */
  readonly radius: number;
  /** Rotation axis (unit vector) and speed in radians per million years. */
  readonly axis: readonly [number, number, number];
  readonly angularSpeed: number;
  readonly time: number;
}

/** Remove the plate under a point: its ground is shared among the neighbours that border it. */
export interface RemovePlateEdit {
  readonly kind: 'removePlate';
  readonly at: readonly [number, number, number];
  /** 'reset' replaces its crust with new seafloor blended in from the surroundings; 'keep' leaves the crust as it was. */
  readonly mode: 'reset' | 'keep';
  readonly time: number;
}

/**
 * Split the plate under a point roughly in half across its long axis, along a wandering edge. The new half
 * drifts away from the old one.
 */
export interface SplitPlateEdit {
  readonly kind: 'splitPlate';
  readonly at: readonly [number, number, number];
  readonly time: number;
}

/** Move the plate under `from` rigidly so that `from` lands on `to`; neighbours give way. */
export interface DragPlateEdit {
  readonly kind: 'dragPlate';
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  readonly time: number;
}

/**
 * Paint a plate's region outward: the plate under `from` takes over everything the brush passes over,
 * so dragging from one plate into another pushes the boundary. Crust is left as it was.
 */
export interface PaintPlateEdit {
  readonly kind: 'paintPlate';
  /** A point on the plate being painted (unit vector). */
  readonly from: readonly [number, number, number];
  /** Chord radius, as for brushes. */
  readonly radius: number;
  /** Dab centres along the stroke, xyz interleaved. */
  readonly dabs: readonly number[];
  readonly time: number;
}

export type PlateEdit = AddPlateEdit | RemovePlateEdit | SplitPlateEdit | DragPlateEdit | PaintPlateEdit;
/** Generated land: continents shaped by fractal coastlines, added to whatever is already there. */
export interface GenerateEdit {
  readonly kind: 'generate';
  readonly style: 'continents' | 'pangaea' | 'two' | 'archipelago';
  /** Share of the globe that should be land, between 0.02 and 0.8. */
  readonly landFraction: number;
  /** Seeds the layout, so the same edit always makes the same land. */
  readonly seed: string;
  readonly time: number;
}

export type Edit = BrushEdit | GenerateEdit | PlateEdit;

export const isPlateEdit = (e: Edit): e is PlateEdit =>
  e.kind === 'addPlate' || e.kind === 'removePlate' || e.kind === 'splitPlate' || e.kind === 'dragPlate' || e.kind === 'paintPlate';

export interface Recipe {
  readonly seed: string;
  readonly simVersion: number;
  /** Lattice frequency (simulation detail). */
  readonly frequency: number;
  readonly edits: readonly Edit[];
}

export interface WorldState {
  readonly lattice: Lattice;
  /** Crust thickness in km per lattice point. */
  readonly thickness: Float64Array;
}

export function newRecipe(seed: string, frequency: number): Recipe {
  return { seed, simVersion: SIM_VERSION, frequency, edits: [] };
}

export function createState(lattice: Lattice): WorldState {
  return { lattice, thickness: new Float64Array(lattice.vertexCount).fill(OCEAN_THICKNESS) };
}

function falloffWeight(kind: Falloff, d: number): number {
  // d is distance / radius, in [0, 1).
  switch (kind) {
    case 'flat':
      return 1;
    case 'linear':
      return 1 - d;
    case 'smooth': {
      const s = 1 - d;
      return s * s * (3 - 2 * s);
    }
  }
}

/** Apply every dab of a stroke to the state. Returns the indices of points touched? No: mutates in place. */
export function applyBrush(state: WorldState, edit: BrushEdit): void {
  const { positions, vertexCount } = state.lattice;
  const { thickness } = state;
  const r2 = edit.radius * edit.radius;
  const target = edit.mode === 'land' ? LAND_THICKNESS : OCEAN_THICKNESS;

  for (let i = 0; i + 2 < edit.dabs.length; i += 3) {
    const cx = edit.dabs[i]!;
    const cy = edit.dabs[i + 1]!;
    const cz = edit.dabs[i + 2]!;
    for (let v = 0; v < vertexCount; v++) {
      const dx = positions[v * 3]! - cx;
      const dy = positions[v * 3 + 1]! - cy;
      const dz = positions[v * 3 + 2]! - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const w = falloffWeight(edit.falloff, Math.sqrt(d2) / edit.radius);
      let t = thickness[v]!;
      if (edit.mode === 'land' || edit.mode === 'ocean') {
        t += (target - t) * Math.min(1, w * edit.strength);
      } else {
        t += (edit.mode === 'raise' ? 1 : -1) * edit.strength * w;
      }
      thickness[v] = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, t));
    }
  }
}

/** Painting edits change the land directly. Plate edits act later, on the plates generated from that land. */
export function applyEdit(state: WorldState, edit: Edit): void {
  if (edit.kind === 'brush') applyBrush(state, edit);
  else if (edit.kind === 'generate') applyGenerate(state, edit);
}

/** Rebuild state from a recipe by replaying its edits in order. */
export function buildState(recipe: Recipe, lattice: Lattice = buildLattice(recipe.frequency)): WorldState {
  const state = createState(lattice);
  for (const edit of recipe.edits) applyEdit(state, edit);
  return state;
}

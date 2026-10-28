// Runs a whole simulation from a recipe and reports keyframes as it goes.
// Pure (no DOM, no globals), so it runs in a worker and in tests alike.

import { DEFAULT_CLIMATE, computeClimate, type ClimateParams } from './climate';
import { buildLattice } from './lattice';
import { thermalThickness } from './crust';
import { fillLoneWater } from './pits';
import { prepareWorld } from './setup';
import { createTectonics, erodeCrust, resample, stepTectonics } from './tectonics';
import { computeWater } from './water';
import { SIM_VERSION, elevationFromThickness, type Edit } from './world';

export interface RunParams {
  readonly seed: string;
  readonly frequency: number;
  readonly edits: readonly Edit[];
  /** Total simulated time, step size and keyframe spacing, in million years. */
  readonly totalMy: number;
  readonly stepMy: number;
  readonly keyframeMy: number;
  /** Planet settings for the climate; defaults to an Earth-like planet. */
  readonly climate?: ClimateParams;
}

/** Mantle plumes in a run (Earth has about a dozen strong ones). */
const HOTSPOTS = 10;

export const DEFAULT_RUN = { totalMy: 200, stepMy: 1, keyframeMy: 10 } as const;

/** What the viewer needs to draw one moment: values on the lattice vertices. */
export interface Frame {
  readonly time: number;
  readonly thickness: Float32Array;
  readonly plate: Int32Array;
  /** Annual mean temperature (C) and precipitation (mm/yr). */
  readonly temperature: Float32Array;
  readonly precipitation: Float32Array;
  /** Rock type at each vertex (see ROCKS). */
  readonly rock: Uint8Array;
  /** Rivers and lakes: where each vertex's water goes, the river flow (m^3/s) and the lake mask. */
  readonly flowTo: Int32Array;
  readonly discharge: Float32Array;
  readonly lake: Uint8Array;
  /** Year-round mean wind, and the ocean current (zero on land, and everywhere when circulation is off), in local east and north directions. */
  readonly windEast: Float32Array;
  readonly windNorth: Float32Array;
  readonly currentEast: Float32Array;
  readonly currentNorth: Float32Array;
}

/** Annual climate for a thickness field on the lattice. */
export type ClimateAndWater = Pick<Frame, 'temperature' | 'precipitation' | 'flowTo' | 'discharge' | 'lake' | 'windEast' | 'windNorth' | 'currentEast' | 'currentNorth'>;

/** The arrays of a climate result, to hand to another thread without copying. */
export const climateBuffers = (c: ClimateAndWater): ArrayBuffer[] =>
  [c.temperature, c.precipitation, c.flowTo, c.discharge, c.lake, c.windEast, c.windNorth, c.currentEast, c.currentNorth].map((a) => a.buffer as ArrayBuffer);

export function climateForThickness(frequency: number, thickness: ArrayLike<number>, params: ClimateParams = DEFAULT_CLIMATE, rock?: ArrayLike<number>): ClimateAndWater {
  const lattice = buildLattice(frequency);
  const elevation = new Float64Array(lattice.vertexCount);
  const sea = params.seaLevel ?? 0;
  for (let v = 0; v < elevation.length; v++) elevation[v] = elevationFromThickness(thickness[v]!) - sea;
  const c = computeClimate(lattice, elevation, params);
  const water = computeWater(lattice, elevation, c.meanPrecipitation, rock);
  return { temperature: c.meanTemperature, precipitation: c.meanPrecipitation, windEast: c.meanWindEast, windNorth: c.meanWindNorth, currentEast: c.currentEast, currentNorth: c.currentNorth, ...water };
}

/** Progress report: simulated time so far, and whether a keyframe (climate and rivers) is being worked out. */
export type Progress = (time: number, keyframe: boolean) => void;

/** Where a run gets its climate worked out, and how it lets other work (such as that climate arriving) happen between steps. */
export interface ClimateHost {
  climate(thickness: Float32Array, rock: Uint8Array): Promise<ClimateAndWater>;
  /** Give pending messages a chance to be delivered. */
  yield(): Promise<void>;
}

/** Works the climate out in place, one keyframe at a time (used by tests, and when no second worker is available). */
export function inlineClimate(params: RunParams): ClimateHost {
  return {
    climate: async (thickness, rock) => climateForThickness(params.frequency, thickness, params.climate, rock),
    yield: async () => {},
  };
}

/**
 * Runs the simulation. The plates keep moving while a keyframe's climate is worked out elsewhere: rainfall from keyframe k
 * drives erosion from keyframe k+1 on (the first keyframe is waited for), so the result never depends on how fast the climate arrives.
 */
export async function runSimulation(params: RunParams, onFrame: (frame: Frame) => void, onProgress?: Progress, host: ClimateHost = inlineClimate(params)): Promise<void> {
  const lattice = buildLattice(params.frequency);
  const { world, setup, rock } = prepareWorld({ seed: params.seed, simVersion: SIM_VERSION, frequency: params.frequency, edits: params.edits }, lattice);
  const tectonics = createTectonics(world, setup, { erosion: true, rock, hotspots: HOTSPOTS, seed: params.seed });

  /** The climate of the previous keyframe, still being worked out; resolves once its frame has been delivered. */
  let pending: Promise<Float32Array> | null = null;

  const emit = async (waitForIt: boolean) => {
    onProgress?.(tectonics.time, true);
    const r = resample(tectonics);
    // The sea floor sinks as it ages: show each point at the depth its age implies.
    for (let v = 0; v < r.thickness.length; v++) r.thickness[v] = thermalThickness(r.thickness[v]!, r.nearest[v]! >= 0 ? tectonics.crust.age[r.nearest[v]!]! : 0);
    fillLoneWater(lattice, r.thickness); // a frame is a picture of the state, so tidy it for drawing and for climate
    const time = tectonics.time;
    const thickness = Float32Array.from(r.thickness);
    const plate = r.plate, rockNow = r.rock;
    // Frames go out in order: the previous one is delivered (and its rainfall taken up) before this one's climate starts.
    if (pending) tectonics.rainfall = await pending;
    const mine = host.climate(Float32Array.from(thickness), Uint8Array.from(rockNow)).then((c) => {
      const rain = Float32Array.from(c.precipitation); // a copy: the frame's own array is handed to the main thread
      onFrame({ time, thickness, plate, rock: rockNow, ...c });
      return rain;
    });
    pending = mine;
    if (waitForIt) tectonics.rainfall = await mine;
  };

  await emit(true);
  const stepsPerKeyframe = Math.max(1, Math.round(params.keyframeMy / params.stepMy));
  const steps = Math.round(params.totalMy / params.stepMy);
  for (let s = 1; s <= steps; s++) {
    stepTectonics(tectonics, params.stepMy);
    // Hand-applied erosion at this moment, before the frame is saved.
    for (const e of params.edits) if (e.kind === 'erode' && e.time > 0 && Math.round(e.time) === Math.round(tectonics.time)) erodeCrust(tectonics, e.my);
    onProgress?.(tectonics.time, false);
    if (s % stepsPerKeyframe === 0 || s === steps) await emit(false);
    else await host.yield();
  }
  if (pending) await pending;
}

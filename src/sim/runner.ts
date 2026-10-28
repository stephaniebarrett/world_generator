// Runs a whole simulation from a recipe and reports keyframes as it goes.
// Pure (no DOM, no globals), so it runs in a worker and in tests alike.

import { DEFAULT_CLIMATE, assembleClimate, circulationRounds, climateContext, climateWithLakes, computeClimate, currentsStage, heatStage, nextCirculation, seasonStage, windStage, type CirculationState, type ClimateParams, type CurrentsResult, type SeasonResult, type SeasonWind } from './climate';
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
  /** Each plate's angular velocity at this moment (xyz per plate, radians per million years): how it is drifting and turning. */
  readonly omega: Float32Array;
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

/** What a keyframe's climate leaves behind for the next keyframe's to start from. */
export interface KeyframeClimate {
  readonly climate: ClimateAndWater;
  readonly circulation: CirculationState | null;
}

/** Where each stage of a keyframe's climate runs: on this thread, or on helper threads that take them in parallel (see worker.ts). */
export interface ClimateStages {
  currents(elevation: Float64Array, params: ClimateParams, previous: CirculationState | null): Promise<CurrentsResult>;
  heat(elevation: Float64Array, params: ClimateParams, psi: Float64Array, previousWarmth: Float32Array | null): Promise<Float32Array>;
  winds(elevation: Float64Array, params: ClimateParams, warmth: Float32Array | null): Promise<SeasonWind[]>;
  season(elevation: Float64Array, params: ClimateParams, s: number, warmth: Float32Array | null, wind: SeasonWind, lake: Uint8Array | null): Promise<SeasonResult>;
}

/** The stages run right here, one call at a time. */
export function inlineStages(frequency: number): ClimateStages {
  const context = (elevation: Float64Array, params: ClimateParams) => climateContext(buildLattice(frequency), elevation, params);
  return {
    currents: async (elevation, params, previous) => currentsStage(context(elevation, params), previous),
    heat: async (elevation, params, psi, previousWarmth) => heatStage(context(elevation, params), psi, previousWarmth),
    winds: async (elevation, params, warmth) => windStage(context(elevation, params), warmth),
    season: async (elevation, params, s, warmth, wind, lake) => seasonStage(context(elevation, params), s, warmth, wind, lake ?? undefined),
  };
}

function elevationOf(frequency: number, thickness: ArrayLike<number>, params: ClimateParams): Float64Array {
  const elevation = new Float64Array(buildLattice(frequency).vertexCount);
  const sea = params.seaLevel ?? 0;
  for (let v = 0; v < elevation.length; v++) elevation[v] = elevationFromThickness(thickness[v]!) - sea;
  return elevation;
}

/**
 * The climate, rivers and lakes of a keyframe, with each stage handed to `stages`. The sea and the winds are worked out at the same
 * time, each from the state the last keyframe left (the plain belts if there is none, and then twice over so the first keyframe
 * is not left with them); then the four seasons at the same time; and if the rain fills lakes, the four seasons again with the lakes
 * in place. Whichever way the stages run, the answer is the same.
 */
export async function keyframeClimate(
  stages: ClimateStages,
  frequency: number,
  thickness: ArrayLike<number>,
  params: ClimateParams = DEFAULT_CLIMATE,
  rock?: ArrayLike<number>,
  previous: CirculationState | null = null,
): Promise<KeyframeClimate> {
  const lattice = buildLattice(frequency);
  const elevation = elevationOf(frequency, thickness, params);
  let state = previous;
  let currents: CurrentsResult | null = null;
  let warmth: Float32Array | null = null;
  let winds: SeasonWind[] | null = null;
  for (let round = 0, rounds = circulationRounds(params.circulation ?? 0, state); round < rounds; round++) {
    const from = state;
    // From a state, the currents, the warmth they carry and the winds are all worked out at the same time, each from that state. From
    // nothing, the heat has to follow the currents just found, so it waits for them.
    const sea = from
      ? Promise.all([stages.currents(elevation, params, from), stages.heat(elevation, params, from.psi, from.warmth)])
      : stages.currents(elevation, params, null).then(async (c) => [c, await stages.heat(elevation, params, c.psi, null)] as const);
    const [[c, w], air] = await Promise.all([sea, stages.winds(elevation, params, from?.warmth ?? null)]);
    currents = c;
    warmth = w;
    winds = air;
    state = nextCirculation({ psi: c.psi, warmth: w }, air);
  }
  winds ??= await stages.winds(elevation, params, null);
  const wind = winds;
  const ocean = currents;
  const seasons = (lake: Uint8Array | null) => Promise.all([0, 1, 2, 3].map((s) => stages.season(elevation, params, s, warmth, wind[s]!, lake)));
  const circulation = ocean ? state : null;
  let c = assembleClimate(await seasons(null), wind, ocean, circulation);
  let water = computeWater(lattice, elevation, c.meanPrecipitation, rock);
  // Lakes only exist once there is rain to fill them, and then they evaporate and soften the seasons around them: the seasons again,
  // with the lakes in place and the same sea and winds. The lakes this second pass finds are the ones kept.
  if (water.lake.some((l) => l !== 0)) {
    c = assembleClimate(await seasons(water.lake), wind, ocean, circulation);
    water = computeWater(lattice, elevation, c.meanPrecipitation, rock);
  }
  return {
    climate: { temperature: c.meanTemperature, precipitation: c.meanPrecipitation, windEast: c.meanWindEast, windNorth: c.meanWindNorth, currentEast: c.currentEast, currentNorth: c.currentNorth, ...water },
    circulation,
  };
}

/** The same, all on this thread and in order, for a climate wanted at once. `previous` is where the sea and air got to last time, if known. */
export function climateForThickness(frequency: number, thickness: ArrayLike<number>, params: ClimateParams = DEFAULT_CLIMATE, rock?: ArrayLike<number>, previous: CirculationState | null = null): ClimateAndWater {
  const lattice = buildLattice(frequency);
  const elevation = elevationOf(frequency, thickness, params);
  let c = computeClimate(lattice, elevation, params, { previous });
  let water = computeWater(lattice, elevation, c.meanPrecipitation, rock);
  if (water.lake.some((l) => l !== 0)) {
    // The lake pass starts from the sea and air the first pass settled to: no new rounds, so the sea is not solved again.
    c = climateWithLakes(lattice, elevation, params, c, water.lake);
    water = computeWater(lattice, elevation, c.meanPrecipitation, rock);
  }
  return { temperature: c.meanTemperature, precipitation: c.meanPrecipitation, windEast: c.meanWindEast, windNorth: c.meanWindNorth, currentEast: c.currentEast, currentNorth: c.currentNorth, ...water };
}

/** Progress report: simulated time so far, and whether a keyframe (climate and rivers) is being worked out. */
export type Progress = (time: number, keyframe: boolean) => void;

/** Where a run gets its climate worked out, and how it lets other work (such as that climate arriving) happen between steps. */
export interface ClimateHost {
  /** The climate of a keyframe, starting from the sea and air the last keyframe left. */
  climate(thickness: Float32Array, rock: Uint8Array, previous: CirculationState | null): Promise<KeyframeClimate>;
  /** Give pending messages a chance to be delivered. */
  yield(): Promise<void>;
}

/** Works the climate out in place (used by tests, and when no helper threads are available). */
export function inlineClimate(params: RunParams): ClimateHost {
  const stages = inlineStages(params.frequency);
  return {
    climate: (thickness, rock, previous) => keyframeClimate(stages, params.frequency, thickness, params.climate, rock, previous),
    yield: async () => {},
  };
}

/**
 * How many keyframes behind the rainfall that drives erosion is: erosion after keyframe k uses the rainfall of keyframe k - 1 (the first
 * keyframe's, until a later one exists). One is the least lag that lets the plates keep moving while a climate is worked out.
 */
const RAIN_LAG = 1;

/**
 * Runs the simulation. The plates keep moving while keyframes' climates are worked out elsewhere, and a keyframe's climate starts as soon
 * as the keyframe is reached, even while the previous one is finishing. Erosion uses the rainfall of keyframe k - RAIN_LAG, so the result
 * never depends on how fast the climate arrives. Frames are delivered in order.
 */
export async function runSimulation(params: RunParams, onFrame: (frame: Frame) => void, onProgress?: Progress, host: ClimateHost = inlineClimate(params)): Promise<void> {
  const lattice = buildLattice(params.frequency);
  const { world, setup, rock } = prepareWorld({ seed: params.seed, simVersion: SIM_VERSION, frequency: params.frequency, edits: params.edits }, lattice);
  const tectonics = createTectonics(world, setup, { erosion: true, rock, hotspots: HOTSPOTS, seed: params.seed });

  /** Each keyframe's climate as it is worked out, with a copy of its rainfall kept for erosion (the frame's own arrays go to the main thread). */
  const climates: Promise<{ climate: ClimateAndWater; circulation: CirculationState | null; rain: Float32Array }>[] = [];
  /** Delivery of frames, chained so they go out in order however the climates finish. */
  let delivered: Promise<void> = Promise.resolve();

  const emit = async () => {
    onProgress?.(tectonics.time, true);
    const r = resample(tectonics);
    // The sea floor sinks as it ages: show each point at the depth its age implies.
    for (let v = 0; v < r.thickness.length; v++) r.thickness[v] = thermalThickness(r.thickness[v]!, r.nearest[v]! >= 0 ? tectonics.crust.age[r.nearest[v]!]! : 0);
    fillLoneWater(lattice, r.thickness); // a frame is a picture of the state, so tidy it for drawing and for climate
    const time = tectonics.time;
    const thickness = Float32Array.from(r.thickness);
    const plate = r.plate, rockNow = r.rock;
    const omega = Float32Array.from(tectonics.omega);
    const index = climates.length;
    const forClimate = Float32Array.from(thickness), rockForClimate = Uint8Array.from(rockNow);
    // A keyframe's climate starts from the sea and air the last one left, so it waits for that one to finish.
    const before = index === 0 ? Promise.resolve<CirculationState | null>(null) : climates[index - 1]!.then((c) => c.circulation);
    const mine = before
      .then((state) => host.climate(forClimate, rockForClimate, state))
      .then(({ climate, circulation }) => ({ climate, circulation, rain: Float32Array.from(climate.precipitation) }));
    climates.push(mine);
    delivered = delivered.then(async () => {
      const { climate } = await mine;
      onFrame({ time, thickness, plate, omega, rock: rockNow, ...climate });
    });
    // Erosion follows the rainfall of an earlier keyframe, waited for here if it is not ready yet.
    tectonics.rainfall = (await climates[Math.max(0, index - RAIN_LAG)]!).rain;
  };

  await emit();
  const stepsPerKeyframe = Math.max(1, Math.round(params.keyframeMy / params.stepMy));
  const steps = Math.round(params.totalMy / params.stepMy);
  for (let s = 1; s <= steps; s++) {
    stepTectonics(tectonics, params.stepMy);
    // Hand-applied erosion at this moment, before the frame is saved.
    for (const e of params.edits) if (e.kind === 'erode' && e.time > 0 && Math.round(e.time) === Math.round(tectonics.time)) erodeCrust(tectonics, e.my);
    onProgress?.(tectonics.time, false);
    if (s % stepsPerKeyframe === 0 || s === steps) await emit();
    else await host.yield();
  }
  await delivered;
}

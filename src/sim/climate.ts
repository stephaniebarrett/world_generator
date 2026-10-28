// Plausible climate on the lattice: not a weather model, but the main structure of one.
//
//  - Temperature from sunlight by latitude and season, land swinging more than sea, cooling with height.
//  - Three wind belts per hemisphere (trades, westerlies, polar easterlies) that shift with the sun.
//  - Moisture picked up over warm ocean, carried downwind, and rained out in the tropical rain belt,
//    at mid-latitude fronts and on windward slopes (leaving rain shadows behind mountains).
//
// Latitude comes from z: the planet spins about the z axis. Only + - * / sqrt are used, plus a series
// for the small sun-declination angle, so results are identical on every machine.

import { bendWinds, currentsFromPsi, localFrame, oceanCurrents, oceanHeatAnomaly, type CirculationLevel, type Frame } from './circulation';
import type { Lattice } from './lattice';

export interface ClimateParams {
  /** Axial tilt in radians (Earth: 0.409). */
  readonly axialTilt: number;
  /** 1 turns the planet like Earth (winds blow from the west in mid-latitudes); -1 the other way. */
  readonly spin: 1 | -1;
  /** Sea level in metres above the default; the sea covers whatever lies below it. */
  readonly seaLevel?: number;
  /** How far to work out how land steers the sea and the air (see circulation.ts); 0 or missing leaves the plain wind belts. */
  readonly circulation?: CirculationLevel;
}

export const DEFAULT_CLIMATE: ClimateParams = { axialTilt: 0.409, spin: 1 };

export const SEASONS = 4; // equinox, northern summer, equinox, northern winter
export const SEASON_NAMES = ['Spring equinox', 'Northern summer', 'Autumn equinox', 'Northern winter'] as const;
const SUN_SIGN = [0, 1, 0, -1] as const;

export interface Climate {
  /** Per season, degrees C. */
  readonly temperature: readonly Float32Array[];
  /** Per season, millimetres per year at that season's rate. */
  readonly precipitation: readonly Float32Array[];
  /** Surface wind per season in local east and north directions, in [-1, 1] units. */
  readonly windEast: readonly Float32Array[];
  readonly windNorth: readonly Float32Array[];
  readonly meanTemperature: Float32Array;
  readonly meanPrecipitation: Float32Array;
  /** Year-round mean wind and surface ocean current in local east and north directions (current is zero on land and when circulation is off). */
  readonly meanWindEast: Float32Array;
  readonly meanWindNorth: Float32Array;
  readonly currentEast: Float32Array;
  readonly currentNorth: Float32Array;
  /** What the sea and the air settled to, to start the next climate from (null when circulation is off). */
  readonly circulation: CirculationState | null;
}

/**
 * Where the sea and the air have got to. The next keyframe's climate starts from this instead of from nothing: the ocean solve is
 * already nearly right (the continents have moved a little), and the winds and the sea steer each other with a keyframe's delay,
 * which is what lets the ocean and the winds be worked out at the same time.
 */
export interface CirculationState {
  /** The streamfunction of the surface currents. */
  readonly psi: Float64Array;
  /** How much warmer or cooler the sea is than sunlight alone makes it, in degrees C. */
  readonly warmth: Float32Array;
  /** The year-round mean wind after land and sea have bent it, in local east and north directions. */
  readonly windEast: Float32Array;
  readonly windNorth: Float32Array;
}

const EARTH_RADIUS_KM = 6371;
const LAPSE_PER_KM = 6.5;
const MAX_LOSS_PER_CELL = 0.25;

/**
 * Rain belts, as rain-out rates per 1000 km of travel. Fitted so the zonal mean over an ocean planet
 * approximates Earth's (see the 'rainfall by latitude' test). Exported only so a fitting script can search it.
 */
export const RAIN = {
  /** Rain everywhere, before subtracting where air sinks. */
  background: 0.05,
  /** Fraction of the background removed under the subtropical highs (around 30 degrees). */
  subsidence: 0.95,
  /** Equatorial belt strength. */
  itcz: 0.22,
  /** Mid-latitude front: strength, centre (sine of latitude) and half-width. */
  front: 0.7,
  frontCentre: 0.78,
  frontWidth: 0.14,
  /** Moisture lost over land beyond rain, per 1000 km travelled: air dries out crossing a continent. */
  landDecay: 0.15,
  /** Moisture condensed on rising ground: share per 1000 km per metre of rise per km travelled. */
  orographic: 0.1,
};

/**
 * Surface wind at height z (sine of latitude), with the wind belts shifted by `shift`: [east, north] in [-1, 1] units.
 * Trades (easterly, toward the equator) in the tropics, westerlies (toward the pole) in mid-latitudes, polar easterlies beyond.
 */
function windBelts(z: number, shift: number, spin: 1 | -1): [number, number] {
  const zEff = z - shift;
  const a = Math.abs(zEff);
  const sign = zEff >= 0 ? 1 : -1;
  const f1 = smoothstep(0.43, 0.57, a);
  const f2 = smoothstep(0.796, 0.936, a);
  return [(-1 + 2 * f1 - 2 * f2) * spin, sign * (-0.5 + f1 - f2)];
}

/** The prevailing (year-round mean) wind at height z (sine of latitude): [east, north]. The belts follow the sun, so this averages the seasons. */
export function prevailingWind(z: number, params: ClimateParams): [number, number] {
  let east = 0, north = 0;
  for (let s = 0; s < SEASONS; s++) {
    const [u, m] = windBelts(z, 0.5 * sinSeries(params.axialTilt * SUN_SIGN[s]!), params.spin);
    east += u;
    north += m;
  }
  return [east / SEASONS, north / SEASONS];
}

function sinSeries(x: number): number {
  const x2 = x * x;
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - x2 / 110)))));
}
function cosSeries(x: number): number {
  const x2 = x * x;
  return 1 - (x2 / 2) * (1 - (x2 / 12) * (1 - (x2 / 30) * (1 - (x2 / 56) * (1 - x2 / 90))));
}
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Mean spacing between neighbouring lattice points, in km. */
export function cellKm(lattice: Lattice): number {
  return 1.0746 * Math.sqrt((4 * Math.PI) / lattice.vertexCount) * EARTH_RADIUS_KM;
}

/**
 * Soften rainfall across neighbouring points. A cell is a few hundred km across at low detail, so one steep slope or belt edge
 * would otherwise step the rainfall (and the biomes drawn from it) sharply from cell to cell. The number of passes follows the
 * cell size, so the softening is about the same distance (a few hundred km) at every detail level.
 */
function smoothRain(lattice: Lattice, rain: Float32Array, km: number): void {
  const { offsets, neighbors } = lattice;
  const passes = clamp(Math.round((300 / km) * (300 / km)), 1, 6);
  let from = Float64Array.from(rain), to = new Float64Array(rain.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < rain.length; v++) {
      let sum = 0;
      for (let k = offsets[v]!; k < offsets[v + 1]!; k++) sum += from[neighbors[k]!]!;
      to[v] = 0.5 * from[v]! + (0.5 * sum) / (offsets[v + 1]! - offsets[v]!);
    }
    [from, to] = [to, from];
  }
  for (let v = 0; v < rain.length; v++) rain[v] = from[v]!;
}

/** Everything the stages of a climate share: the lattice, the land, the planet, and the sunlight by season. Cheap to build, so each stage can build its own. */
export interface ClimateContext {
  readonly lattice: Lattice;
  readonly elevation: ArrayLike<number>;
  readonly params: ClimateParams;
  readonly km: number;
  readonly level: CirculationLevel;
  readonly frame: Frame;
  readonly sunlight: readonly Float32Array[];
  readonly sunMean: Float32Array;
  readonly declSin: readonly number[];
}

export function climateContext(lattice: Lattice, elevation: ArrayLike<number>, params: ClimateParams = DEFAULT_CLIMATE): ClimateContext {
  const n = lattice.vertexCount;
  const { positions } = lattice;
  // Sunlight index per season, and the seasonal mean it is measured against.
  const sunlight: Float32Array[] = [];
  const declSin: number[] = [];
  for (let s = 0; s < SEASONS; s++) {
    const decl = params.axialTilt * SUN_SIGN[s]!;
    const sd = sinSeries(decl), cd = cosSeries(decl);
    declSin.push(sd);
    const arr = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      const z = positions[v * 3 + 2]!;
      const cosLat = Math.sqrt(Math.max(0, 1 - z * z));
      const noonSun = z * sd + cosLat * cd;
      // Steeper than linear (x^1.25, via sqrt only) so high latitudes get properly little warmth.
      const lin = clamp((noonSun + 0.1) / 1.1, 0, 1);
      arr[v] = lin * Math.sqrt(Math.sqrt(lin));
    }
    sunlight.push(arr);
  }
  const sunMean = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    let sum = 0;
    for (let s = 0; s < SEASONS; s++) sum += sunlight[s]![v]!;
    sunMean[v] = sum / SEASONS;
  }
  return { lattice, elevation, params, km: cellKm(lattice), level: params.circulation ?? 0, frame: localFrame(lattice), sunlight, sunMean, declSin };
}

// --- stages: the sea ---------------------------------------------------------

export interface CurrentsResult {
  readonly psi: Float64Array;
  readonly currentEast: Float32Array;
  readonly currentNorth: Float32Array;
}

/**
 * The surface currents, driven by the winds of the state they start from (the plain belts if there is none) and starting from that
 * state's currents, so they need few sweeps when the state is close.
 */
export function currentsStage(ctx: ClimateContext, previous: CirculationState | null): CurrentsResult {
  const { lattice, elevation, params, km, level, frame } = ctx;
  const n = lattice.vertexCount;
  let windEast = previous?.windEast, windNorth = previous?.windNorth;
  if (!windEast || !windNorth) {
    windEast = new Float32Array(n);
    windNorth = new Float32Array(n);
    for (let v = 0; v < n; v++) [windEast[v], windNorth[v]] = prevailingWind(lattice.positions[v * 3 + 2]!, params);
  }
  const { velocity: u, psi } = oceanCurrents(lattice, elevation, frame, windEast, windNorth, level, km, previous?.psi);
  const currentEast = new Float32Array(n), currentNorth = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    currentEast[v] = u[v * 3]! * frame.east[v * 3]! + u[v * 3 + 1]! * frame.east[v * 3 + 1]! + u[v * 3 + 2]! * frame.east[v * 3 + 2]!;
    currentNorth[v] = u[v * 3]! * frame.north[v * 3]! + u[v * 3 + 1]! * frame.north[v * 3 + 1]! + u[v * 3 + 2]! * frame.north[v * 3 + 2]!;
  }
  return { psi, currentEast, currentNorth };
}

/**
 * How much warmer or cooler the sea is than sunlight alone makes it, carried by the currents of `psi` (the last keyframe's when the
 * sea is worked out at the same time as the currents) and starting from the last keyframe's warmth, so it needs few sweeps.
 */
export function heatStage(ctx: ClimateContext, psi: Float64Array, previousWarmth: Float32Array | null): Float32Array {
  const { lattice, elevation, km, level, sunMean } = ctx;
  const equilibrium = new Float64Array(lattice.vertexCount);
  for (let v = 0; v < equilibrium.length; v++) equilibrium[v] = -28 + 58 * sunMean[v]!;
  return oceanHeatAnomaly(lattice, elevation, currentsFromPsi(lattice, elevation, psi), equilibrium, level, km, previousWarmth ?? undefined);
}

// --- stage: the winds ------------------------------------------------------

export interface SeasonWind {
  readonly east: Float32Array;
  readonly north: Float32Array;
}

/** The plain wind belts of a season, shifted with the sun, as local east and north. */
function beltWind(ctx: ClimateContext, s: number): SeasonWind & { wx: Float64Array; wy: Float64Array; wz: Float64Array } {
  const { lattice, params, declSin, frame } = ctx;
  const n = lattice.vertexCount;
  const shift = 0.5 * declSin[s]!; // belts follow the sun
  const east = new Float32Array(n), north = new Float32Array(n);
  const wx = new Float64Array(n), wy = new Float64Array(n), wz = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    const [u, m] = windBelts(lattice.positions[v * 3 + 2]!, shift, params.spin);
    east[v] = u;
    north[v] = m;
    wx[v] = u * frame.east[v * 3]! + m * frame.north[v * 3]!;
    wy[v] = u * frame.east[v * 3 + 1]! + m * frame.north[v * 3 + 1]!;
    wz[v] = u * frame.east[v * 3 + 2]! + m * frame.north[v * 3 + 2]!;
  }
  return { east, north, wx, wy, wz };
}

/**
 * The winds of all four seasons: the belts, bent by land heating and cooling (monsoons), by warm or cold sea (taken from `warmth`, the
 * state's, if there is one) and by mountains, when circulation is on.
 */
export function windStage(ctx: ClimateContext, warmth: Float32Array | null): SeasonWind[] {
  const { lattice, elevation, km, level, frame, sunlight, sunMean } = ctx;
  const n = lattice.vertexCount;
  const out: SeasonWind[] = [];
  for (let s = 0; s < SEASONS; s++) {
    const w = beltWind(ctx, s);
    if (level > 0) {
      const heat = new Float64Array(n);
      for (let v = 0; v < n; v++) {
        if (elevation[v]! > 0) heat[v] = 58 * (sunlight[s]![v]! - sunMean[v]!) * (1.35 - 0.55);
        else if (warmth) heat[v] = 0.5 * warmth[v]!;
      }
      bendWinds(lattice, elevation, frame, heat, w.wx, w.wy, w.wz, km);
      for (let v = 0; v < n; v++) {
        w.east[v] = w.wx[v]! * frame.east[v * 3]! + w.wy[v]! * frame.east[v * 3 + 1]! + w.wz[v]! * frame.east[v * 3 + 2]!;
        w.north[v] = w.wx[v]! * frame.north[v * 3]! + w.wy[v]! * frame.north[v * 3 + 1]! + w.wz[v]! * frame.north[v * 3 + 2]!;
      }
    }
    out.push({ east: w.east, north: w.north });
  }
  return out;
}

/** The year-round mean of the four seasons' winds. */
export function meanWind(winds: readonly SeasonWind[]): SeasonWind {
  const n = winds[0]!.east.length;
  const east = new Float32Array(n), north = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    let e = 0, m = 0;
    for (let s = 0; s < SEASONS; s++) { e += winds[s]!.east[v]!; m += winds[s]!.north[v]!; }
    east[v] = e / SEASONS;
    north[v] = m / SEASONS;
  }
  return { east, north };
}

// --- stage: a season's temperature and rain --------------------------------

export interface SeasonResult {
  readonly temperature: Float32Array;
  readonly precipitation: Float32Array;
}

/**
 * One season's temperature and rainfall, given the sea's warmth and that season's winds (and the lakes, if any). The seasons do not
 * depend on one another, so they can be worked out at the same time.
 */
export function seasonStage(ctx: ClimateContext, s: number, seaWarmth: Float32Array | null, wind: SeasonWind, lake?: ArrayLike<number>): SeasonResult {
  const { lattice, elevation, km, frame, sunlight, sunMean, declSin } = ctx;
  const n = lattice.vertexCount;
  const { positions, offsets, neighbors } = lattice;
  const isWater = (v: number): boolean => elevation[v]! <= 0 || (lake !== undefined && lake[v]! !== 0);

  // --- temperature -------------------------------------------------------
  const temp = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const e = elevation[v]!;
    const sea = -28 + 58 * sunMean[v]!;
    const swing = 58 * (sunlight[s]![v]! - sunMean[v]!);
    let t = sea + swing * (isWater(v) ? 0.55 : 1.35); // open water, lakes included, keeps the seasons mild
    if (e > 0) t -= (LAPSE_PER_KM * e) / 1000;
    else if (seaWarmth) t += seaWarmth[v]!; // warm and cold currents
    temp[v] = t;
  }

  // --- the wind as xyz, and the rain belts that go with the season ------------
  const shift = 0.5 * declSin[s]!;
  const wx = new Float64Array(n), wy = new Float64Array(n), wz = new Float64Array(n);
  const convective = new Float64Array(n); // rain rate per 1000 km from belts of rising air
  for (let v = 0; v < n; v++) {
    const z = positions[v * 3 + 2]!;
    const a = Math.abs(z - shift);
    const u = wind.east[v]!, m = wind.north[v]!;
    wx[v] = u * frame.east[v * 3]! + m * frame.north[v * 3]!;
    wy[v] = u * frame.east[v * 3 + 1]! + m * frame.north[v * 3 + 1]!;
    wz[v] = u * frame.east[v * 3 + 2]! + m * frame.north[v * 3 + 2]!;
    // Rising air at the equatorial belt and at the polar front.
    const itcz = Math.max(0, 1 - (a / 0.2) * (a / 0.2));
    const dFront = (a - RAIN.frontCentre) / RAIN.frontWidth;
    const front = Math.max(0, 1 - dFront * dFront);
    // Weak background rain everywhere, except where air sinks around 30 degrees; a wet equatorial
    // belt; and the polar front.
    const dSub = (a - 0.5) / 0.14;
    const sinking = Math.max(0, 1 - dSub * dSub);
    convective[v] = RAIN.background * (1 - RAIN.subsidence * sinking) + RAIN.itcz * itcz + RAIN.front * front;
  }

  // --- moisture ------------------------------------------------------------
  const rate = km / 1000; // fraction per sweep for a rate given per 1000 km
  const evapRelax = Math.min(1, 1.5 * rate);
  const sweeps = clamp(Math.round(9000 / km), 60, 300);
  const q = new Float64Array(n);
  const rain = new Float64Array(n);
  const qsat = new Float64Array(n);
  // How much each neighbour lies upwind of each point depends only on the wind, which is fixed for the season,
  // and so is the terrain. Everything that follows from those alone (the upwind ground, the lift over it, how much
  // moisture is lost and how hard it rains) is worked out once, not on every sweep; only the moisture itself changes.
  const upwind = new Float64Array(neighbors.length);
  const wsums = new Float64Array(n);
  const rainRate = new Float64Array(n); // loss / rate
  const keepShare = new Float64Array(n); // 1 - loss
  const rainSpeed = new Float64Array(n);
  const landKeep = 1 - Math.min(0.5, RAIN.landDecay * rate);
  for (let v = 0; v < n; v++) {
    const px = positions[v * 3]!, py = positions[v * 3 + 1]!, pz = positions[v * 3 + 2]!;
    const wlen = Math.sqrt(wx[v]! * wx[v]! + wy[v]! * wy[v]! + wz[v]! * wz[v]!);
    let eUp = 0, wsum = 0, eAvg = 0;
    const deg = offsets[v + 1]! - offsets[v]!;
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const w = neighbors[k]!;
      const cx = px - positions[w * 3]!, cy = py - positions[w * 3 + 1]!, cz = pz - positions[w * 3 + 2]!;
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const along = wlen > 1e-9 ? (cx * wx[v]! + cy * wy[v]! + cz * wz[v]!) / (cl * wlen) : 0;
      const weight = along > 0 ? along : 0;
      const eW = Math.max(0, elevation[w]!);
      upwind[k] = weight;
      eUp += weight * eW;
      wsum += weight;
      eAvg += eW;
    }
    wsums[v] = wsum;
    const eIn = wsum > 1e-6 ? eUp / wsum : eAvg / deg;
    const e = Math.max(0, elevation[v]!);
    const lift = Math.max(0, e - eIn) / km; // metres of rise per km travelled
    rainSpeed[v] = 0.35 + (0.65 * Math.min(1.12, wlen)) / 1.12;
    let loss = (RAIN.orographic * lift + convective[v]!) * rate;
    if (isWater(v)) loss = convective[v]! * rate; // no orographic lift over open water
    // A slope or front takes at most about a quarter of the moisture per cell (100-200 km): the wettest place on
    // Earth gets ~12,000 mm/yr, not tens of thousands.
    loss = Math.min(MAX_LOSS_PER_CELL, loss);
    rainRate[v] = loss / rate;
    keepShare[v] = 1 - loss;
  }
  // Sea air carries the warmth or chill of the water inland, fading as it crosses the land.
  if (seaWarmth) {
    const warmth = new Float64Array(n);
    const heatKeep = 1 - Math.min(0.5, 0.3 * rate);
    for (let v = 0; v < n; v++) warmth[v] = elevation[v]! <= 0 ? seaWarmth[v]! : 0;
    for (let pass = 0, passes = clamp(Math.round(4000 / km), 20, 150); pass < passes; pass++) {
      for (let v = 0; v < n; v++) {
        if (elevation[v]! <= 0) continue;
        let inflow = 0;
        if (wsums[v]! > 1e-6) {
          for (let k = offsets[v]!; k < offsets[v + 1]!; k++) inflow += upwind[k]! * warmth[neighbors[k]!]!;
          inflow /= wsums[v]!;
        } else {
          for (let k = offsets[v]!; k < offsets[v + 1]!; k++) inflow += warmth[neighbors[k]!]!;
          inflow /= offsets[v + 1]! - offsets[v]!;
        }
        warmth[v] = inflow * heatKeep;
      }
    }
    for (let v = 0; v < n; v++) if (elevation[v]! > 0) temp[v] = temp[v]! + 0.7 * warmth[v]!;
  }
  // The air can hold more moisture where it is warm: sea air starts full.
  for (let v = 0; v < n; v++) {
    const warm = Math.max(0.03, (temp[v]! + 10) / 40);
    qsat[v] = 120 * warm * warm;
    if (isWater(v)) q[v] = qsat[v]!;
  }
  for (let pass = 0; pass < sweeps; pass++) {
    for (let v = 0; v < n; v++) {
      let qIn: number;
      if (wsums[v]! > 1e-6) {
        let qUp = 0;
        for (let k = offsets[v]!; k < offsets[v + 1]!; k++) qUp += upwind[k]! * q[neighbors[k]!]!;
        qIn = qUp / wsums[v]!;
      } else {
        let qAvg = 0;
        for (let k = offsets[v]!; k < offsets[v + 1]!; k++) qAvg += q[neighbors[k]!]!;
        qIn = qAvg / (offsets[v + 1]! - offsets[v]!);
      }
      rain[v] = qIn * rainRate[v]! * 157 * rainSpeed[v]!;
      let out = qIn * keepShare[v]!;
      if (isWater(v)) out += (qsat[v]! - out) * evapRelax;
      else out *= landKeep;
      q[v] = out;
    }
  }
  const precip = new Float32Array(n);
  for (let v = 0; v < n; v++) precip[v] = rain[v]!;
  smoothRain(lattice, precip, km);
  return { temperature: temp, precipitation: precip };
}

// --- putting the stages together ----------------------------------------------

/** The sea and air of the state a stage starts from, advanced one round: ocean and winds each worked out from the same state. */
export function nextCirculation(ocean: { psi: Float64Array; warmth: Float32Array }, winds: readonly SeasonWind[]): CirculationState {
  const mean = meanWind(winds);
  return { psi: ocean.psi, warmth: ocean.warmth, windEast: mean.east, windNorth: mean.north };
}

/** Rounds of sea-and-air to run: one from a known state, two from nothing (so the first keyframe is not left with the plain belts). */
export const circulationRounds = (level: CirculationLevel, previous: CirculationState | null): number => (level === 0 ? 0 : previous ? 1 : 2);

/** Combine the four seasons into the annual means a frame keeps. */
export function assembleClimate(
  seasons: readonly SeasonResult[],
  winds: readonly SeasonWind[],
  ocean: Pick<CurrentsResult, 'currentEast' | 'currentNorth'> | null,
  circulation: CirculationState | null,
): Climate {
  const n = seasons[0]!.temperature.length;
  const meanTemperature = new Float32Array(n), meanPrecipitation = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    let t = 0, p = 0;
    for (let s = 0; s < SEASONS; s++) { t += seasons[s]!.temperature[v]!; p += seasons[s]!.precipitation[v]!; }
    meanTemperature[v] = t / SEASONS;
    meanPrecipitation[v] = p / SEASONS;
  }
  const mean = meanWind(winds);
  return {
    temperature: seasons.map((x) => x.temperature),
    precipitation: seasons.map((x) => x.precipitation),
    windEast: winds.map((w) => w.east),
    windNorth: winds.map((w) => w.north),
    meanTemperature,
    meanPrecipitation,
    meanWindEast: mean.east,
    meanWindNorth: mean.north,
    currentEast: ocean?.currentEast ?? new Float32Array(n),
    currentNorth: ocean?.currentNorth ?? new Float32Array(n),
    circulation,
  };
}

export interface ClimateExtras {
  /** Lake mask (nonzero on lakes): water that evaporates and evens out the seasons like the sea, but is not the ocean. */
  readonly lake?: ArrayLike<number>;
  /** Where the sea and the air got to at the last keyframe, to start from. */
  readonly previous?: CirculationState | null;
}

/**
 * The whole climate, one stage after another on this thread. A keyframe run on several threads does the same stages in the same
 * order (see runner.ts), with the ocean and the winds worked out at the same time and the four seasons at the same time, and gets
 * the same answer.
 */
export function computeClimate(lattice: Lattice, elevation: ArrayLike<number>, params: ClimateParams = DEFAULT_CLIMATE, extras: ClimateExtras = {}): Climate {
  const ctx = climateContext(lattice, elevation, params);
  let state = extras.previous ?? null;
  let currents: CurrentsResult | null = null;
  let warmth: Float32Array | null = null;
  let winds: SeasonWind[] | null = null;
  for (let round = 0, rounds = circulationRounds(ctx.level, state); round < rounds; round++) {
    // From nothing, the heat follows the currents just found; from a state, it follows that state's, so the stages need not wait for each other.
    currents = currentsStage(ctx, state);
    warmth = heatStage(ctx, state ? state.psi : currents.psi, state?.warmth ?? null);
    winds = windStage(ctx, state?.warmth ?? null);
    state = nextCirculation({ psi: currents.psi, warmth }, winds);
  }
  winds ??= windStage(ctx, null);
  const seasons = [0, 1, 2, 3].map((s) => seasonStage(ctx, s, warmth, winds![s]!, extras.lake));
  return assembleClimate(seasons, winds, currents, currents ? state : null);
}

/** The seasons again with lakes in place, over the same sea and winds as `first` (which was worked out without them), so the sea is not solved again. */
export function climateWithLakes(lattice: Lattice, elevation: ArrayLike<number>, params: ClimateParams, first: Climate, lake: ArrayLike<number>): Climate {
  const ctx = climateContext(lattice, elevation, params);
  const winds = first.windEast.map((east, s) => ({ east, north: first.windNorth[s]! }));
  const seasons = [0, 1, 2, 3].map((s) => seasonStage(ctx, s, first.circulation?.warmth ?? null, winds[s]!, lake));
  return assembleClimate(seasons, winds, first, first.circulation);
}

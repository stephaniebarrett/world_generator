// How landmasses steer the air and the sea. Added to the climate pass at a chosen Circulation Detail.
//
//  - Ocean currents: the wind drags the surface water; coastlines stop it, so it turns and forms gyres. The currents then
//    carry warm or cold water along the coasts, which warms or cools the air that blows in from the sea.
//  - Monsoons: land heats and cools more than sea, so air flows toward hot land and away from cold land, bending the wind belts.
//  - Mountains: high ground turns the wind aside rather than letting it blow straight through.
//
// Not a fluid simulation: a steady, simplified balance relaxed by repeated sweeps over the lattice, so how far it gets (and
// what it costs) is what the detail level sets. Only + - * / sqrt are used, in a fixed order, so results are identical everywhere.

import type { Lattice } from './lattice';

/** Circulation detail: 0 turns it off (the plain wind belts), then more sweeps and so a better-settled answer. */
export type CirculationLevel = 0 | 1 | 2 | 3 | 4 | 5;
export const CIRCULATION_LEVELS = ['Off', 'Low', 'Medium', 'High', 'Very high', 'Ultra'] as const;
/** How many times over the sweeps run, relative to the resolution (2 is a rough answer; 4 is settled enough; above that the currents sharpen). */
const EFFORT = [0, 2.2, 4, 7, 12, 20] as const;

const EARTH_RADIUS_KM = 6371;
/** Fastest current, in the same units as the wind (1 is a strong trade wind). */
const MAX_CURRENT = 1.2;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Unit east and north vectors at each point (xyz interleaved), for turning local wind and current into 3D vectors and back. */
export interface Frame {
  readonly east: Float64Array;
  readonly north: Float64Array;
}

export function localFrame(lattice: Lattice): Frame {
  const n = lattice.vertexCount;
  const east = new Float64Array(n * 3), north = new Float64Array(n * 3);
  const p = lattice.positions;
  for (let v = 0; v < n; v++) {
    const x = p[v * 3]!, y = p[v * 3 + 1]!, z = p[v * 3 + 2]!;
    const ex = -y, ey = x;
    const eLen = Math.sqrt(ex * ex + ey * ey);
    if (eLen > 1e-9) { east[v * 3] = ex / eLen; east[v * 3 + 1] = ey / eLen; } else east[v * 3] = 1;
    let nx = -z * x, ny = -z * y, nz = 1 - z * z;
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen > 1e-9) { nx /= nLen; ny /= nLen; nz /= nLen; } else { nx = 0; ny = 0; nz = 1; }
    north[v * 3] = nx; north[v * 3 + 1] = ny; north[v * 3 + 2] = nz;
  }
  return { east, north };
}

/** Slope of a field per km over the surface (xyz per point), by neighbour differences. */
export function gradient(lattice: Lattice, f: ArrayLike<number>): Float64Array {
  const { positions: p, offsets, neighbors } = lattice;
  const n = lattice.vertexCount;
  const out = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) {
    let gx = 0, gy = 0, gz = 0;
    for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
      const w = neighbors[k]!;
      const dx = p[w * 3]! - p[v * 3]!, dy = p[w * 3 + 1]! - p[v * 3 + 1]!, dz = p[w * 3 + 2]! - p[v * 3 + 2]!;
      const s = (f[w]! - f[v]!) / (dx * dx + dy * dy + dz * dz);
      gx += s * dx; gy += s * dy; gz += s * dz;
    }
    const scale = 2 / (offsets[v + 1]! - offsets[v]!) / EARTH_RADIUS_KM;
    gx *= scale; gy *= scale; gz *= scale;
    const radial = gx * p[v * 3]! + gy * p[v * 3 + 1]! + gz * p[v * 3 + 2]!;
    out[v * 3] = gx - radial * p[v * 3]!;
    out[v * 3 + 1] = gy - radial * p[v * 3 + 1]!;
    out[v * 3 + 2] = gz - radial * p[v * 3 + 2]!;
  }
  return out;
}

/** Spread a field into its neighbours: each pass averages every point half-and-half with the mean of its neighbours. */
export function smoothField(lattice: Lattice, f: ArrayLike<number>, passes: number): Float64Array {
  const { offsets, neighbors } = lattice;
  let from = Float64Array.from(f), to = new Float64Array(from.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < from.length; v++) {
      let sum = 0;
      for (let k = offsets[v]!; k < offsets[v + 1]!; k++) sum += from[neighbors[k]!]!;
      to[v] = 0.5 * from[v]! + (0.5 * sum) / (offsets[v + 1]! - offsets[v]!);
    }
    [from, to] = [to, from];
  }
  return from;
}

/**
 * Surface currents, found the way the ocean's large gyres are explained (Stommel's model): the wind does not push the water
 * along directly, it spins it. Where the wind's curl is, water piles up or drains and the sea turns, balanced by the planet's
 * spin growing with latitude and a little friction. Land is solid, so the water goes round every coast rather than into it,
 * which squeezes the return flow into fast narrow currents on the western side of each basin. Solved as a streamfunction
 * (flow runs along its contours, zero on land), so nothing can pour into a bay or run through a shore.
 * Returns the velocity (xyz per point, zero on land) and the streamfunction, which can start a later, refined solve.
 */
export interface Currents {
  readonly velocity: Float64Array;
  readonly psi: Float64Array;
}

export function oceanCurrents(
  lattice: Lattice,
  elevation: ArrayLike<number>,
  frame: Frame,
  windEast: ArrayLike<number>,
  windNorth: ArrayLike<number>,
  level: CirculationLevel,
  km: number,
  /** A solve this one refines (the winds changed a little): it starts from there and needs fewer sweeps. */
  previous?: Currents,
): Currents {
  const { positions: p, offsets, neighbors } = lattice;
  const n = lattice.vertexCount;
  const h = km / EARTH_RADIUS_KM; // spacing on the unit sphere
  const sea = (v: number) => elevation[v]! <= 0;

  // What drives it: the curl of the wind, fading toward the poles where the spin's effect vanishes.
  const dEast = gradient(lattice, windEast), dNorth = gradient(lattice, windNorth);
  const drive = new Float64Array(n);
  const beta = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    const z = p[v * 3 + 2]!;
    const cosLat = Math.sqrt(Math.max(1e-6, 1 - z * z));
    const dTauNorthDEast = dNorth[v * 3]! * frame.east[v * 3]! + dNorth[v * 3 + 1]! * frame.east[v * 3 + 1]! + dNorth[v * 3 + 2]! * frame.east[v * 3 + 2]!;
    const dTauEastDNorth = dEast[v * 3]! * frame.north[v * 3]! + dEast[v * 3 + 1]! * frame.north[v * 3 + 1]! + dEast[v * 3 + 2]! * frame.north[v * 3 + 2]!;
    const curl = (dTauNorthDEast - dTauEastDNorth) * EARTH_RADIUS_KM + (z / cosLat) * windEast[v]!;
    const t = clamp((Math.abs(z) - 0.8) / 0.15, 0, 1);
    drive[v] = curl * (1 - t * t * (3 - 2 * t));
    beta[v] = cosLat;
  }

  // friction * laplacian(psi) + beta * d(psi)/d(east) = drive, with psi zero on land, by successive over-relaxation.
  const friction = 1.5 * h; // the western boundary current is about a cell and a half wide
  const psi = previous ? Float64Array.from(previous.psi) : new Float64Array(n);
  const sweeps = Math.min(2000, Math.max(40, Math.round(((previous ? 0.5 : 1) * EFFORT[level] * 4) / h)));
  for (let pass = 0; pass < sweeps; pass++) {
    for (let v = 0; v < n; v++) {
      if (!sea(v)) continue;
      const deg = offsets[v + 1]! - offsets[v]!;
      let lap = 0, dEastPsi = 0, diag = 0;
      for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
        const w = neighbors[k]!;
        const dx = p[w * 3]! - p[v * 3]!, dy = p[w * 3 + 1]! - p[v * 3 + 1]!, dz = p[w * 3 + 2]! - p[v * 3 + 2]!;
        const len2 = dx * dx + dy * dy + dz * dz;
        const diff = (sea(w) ? psi[w]! : 0) - psi[v]!;
        lap += diff / len2;
        dEastPsi += (diff * (dx * frame.east[v * 3]! + dy * frame.east[v * 3 + 1]! + dz * frame.east[v * 3 + 2]!)) / len2;
        diag += 1 / len2;
      }
      lap *= 4 / deg;
      dEastPsi *= 2 / deg;
      diag *= 4 / deg;
      psi[v] = psi[v]! + (1.3 * (friction * lap + beta[v]! * dEastPsi - drive[v]!)) / (friction * diag);
    }
  }

  // Flow runs along the contours of psi: velocity = (position) x (gradient of psi).
  const slope = gradient(lattice, psi);
  const u = new Float64Array(n * 3);
  const speeds: number[] = [];
  for (let v = 0; v < n; v++) {
    if (!sea(v)) continue;
    const x = p[v * 3]!, y = p[v * 3 + 1]!, z = p[v * 3 + 2]!;
    const gx = slope[v * 3]!, gy = slope[v * 3 + 1]!, gz = slope[v * 3 + 2]!;
    u[v * 3] = y * gz - z * gy;
    u[v * 3 + 1] = z * gx - x * gz;
    u[v * 3 + 2] = x * gy - y * gx;
    speeds.push(Math.sqrt(u[v * 3]! * u[v * 3]! + u[v * 3 + 1]! * u[v * 3 + 1]! + u[v * 3 + 2]! * u[v * 3 + 2]!));
  }
  // The answer is only known up to a scale; fix it so a typical strong current (the 95th percentile) is half the top speed.
  speeds.sort((a, b) => a - b);
  const typical = speeds.length > 0 ? speeds[Math.floor(0.95 * (speeds.length - 1))]! : 0;
  const scale = typical > 1e-12 ? 0.5 / typical : 0;
  for (let v = 0; v < n; v++) {
    if (!sea(v)) continue;
    let sx = u[v * 3]! * scale, sy = u[v * 3 + 1]! * scale, sz = u[v * 3 + 2]! * scale;
    const speed = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (speed > MAX_CURRENT) { const k = MAX_CURRENT / speed; sx *= k; sy *= k; sz *= k; }
    u[v * 3] = sx; u[v * 3 + 1] = sy; u[v * 3 + 2] = sz;
  }
  return { velocity: u, psi };
}

/**
 * How much warmer or cooler (degrees C) the sea is than it would be with no currents, because the currents move water about.
 * `equilibrium` is the temperature the sunlight alone would give each point; water drifts toward it while the current carries it away.
 */
export function oceanHeatAnomaly(
  lattice: Lattice,
  elevation: ArrayLike<number>,
  currents: Float64Array,
  equilibrium: ArrayLike<number>,
  level: CirculationLevel,
  km: number,
  /** The anomaly from an earlier solve to start from (the currents changed a little), which then needs fewer sweeps. */
  previous?: Float32Array,
): Float32Array {
  const { positions: p, offsets, neighbors } = lattice;
  const n = lattice.vertexCount;
  const relax = Math.max(km * 4e-5, 0.01); // so warm water travels a few thousand km before it has cooled
  const sweeps = Math.min(600, Math.max(12, Math.round(((previous ? 0.5 : 1) * EFFORT[level] * 2) / relax)));
  let t = Float64Array.from(equilibrium, (e, v) => e + (previous ? previous[v]! : 0)), next = new Float64Array(n);
  for (let pass = 0; pass < sweeps; pass++) {
    for (let v = 0; v < n; v++) {
      if (elevation[v]! > 0) { next[v] = t[v]!; continue; }
      let gain = 0;
      for (let k = offsets[v]!; k < offsets[v + 1]!; k++) {
        const w = neighbors[k]!;
        if (elevation[w]! > 0) continue;
        const dx = p[w * 3]! - p[v * 3]!, dy = p[w * 3 + 1]! - p[v * 3 + 1]!, dz = p[w * 3 + 2]! - p[v * 3 + 2]!;
        const len2 = dx * dx + dy * dy + dz * dz;
        // Water arrives from a neighbour when the current there points at this point.
        const toward = -(currents[v * 3]! * dx + currents[v * 3 + 1]! * dy + currents[v * 3 + 2]! * dz) / Math.sqrt(len2);
        if (toward > 0) gain += 0.2 * toward * (t[w]! - t[v]!);
      }
      next[v] = t[v]! + gain + relax * (equilibrium[v]! - t[v]!);
    }
    [t, next] = [next, t];
  }
  const out = new Float32Array(n);
  for (let v = 0; v < n; v++) if (elevation[v]! <= 0) out[v] = clamp(t[v]! - equilibrium[v]!, -12, 12);
  return out;
}

/**
 * Bend the wind (xyz per point, edited in place) for the land: a monsoon pull toward hot land and away from cold land, and
 * a turn aside where the ground rises ahead. `heat` is how much hotter each point is than its surroundings would make it this season:
 * land that is warmer than the sea, or sea made warm or cold by currents.
 */
export function bendWinds(
  lattice: Lattice,
  elevation: ArrayLike<number>,
  frame: Frame,
  heat: ArrayLike<number>,
  wx: Float64Array,
  wy: Float64Array,
  wz: Float64Array,
  km: number,
): void {
  const { positions: p } = lattice;
  const n = lattice.vertexCount;
  const pull = gradient(lattice, smoothField(lattice, heat, clamp(Math.round((600 / km) * (600 / km)), 2, 12)));
  for (let v = 0; v < n; v++) {
    const gx = pull[v * 3]!, gy = pull[v * 3 + 1]!, gz = pull[v * 3 + 2]!;
    const mag = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (mag < 1e-12) continue;
    // Air flows toward the heat, turned by the spin of the planet (right in the north, left in the south).
    const s = 0.6 * clamp(p[v * 3 + 2]! / 0.3, -1, 1);
    const c = Math.sqrt(1 - s * s);
    const e = gx * frame.east[v * 3]! + gy * frame.east[v * 3 + 1]! + gz * frame.east[v * 3 + 2]!;
    const m = gx * frame.north[v * 3]! + gy * frame.north[v * 3 + 1]! + gz * frame.north[v * 3 + 2]!;
    const k = Math.min(0.9, 80 * mag) / mag; // 6 C per 1000 km is a strong monsoon wind
    const pe = (e * c + m * s) * k, pn = (-e * s + m * c) * k;
    wx[v] = wx[v]! + pe * frame.east[v * 3]! + pn * frame.north[v * 3]!;
    wy[v] = wy[v]! + pe * frame.east[v * 3 + 1]! + pn * frame.north[v * 3 + 1]!;
    wz[v] = wz[v]! + pe * frame.east[v * 3 + 2]! + pn * frame.north[v * 3 + 2]!;
  }
  // Mountains: take out part of the wind that blows up a slope, so it goes along the range instead.
  const height = new Float64Array(n);
  for (let v = 0; v < n; v++) height[v] = Math.max(0, elevation[v]!);
  const slope = gradient(lattice, smoothField(lattice, height, clamp(Math.round((250 / km) * (250 / km)), 1, 6)));
  for (let v = 0; v < n; v++) {
    const sx = slope[v * 3]!, sy = slope[v * 3 + 1]!, sz = slope[v * 3 + 2]!;
    const steep = Math.sqrt(sx * sx + sy * sy + sz * sz); // metres of rise per km
    if (steep < 1e-9) continue;
    const up = (wx[v]! * sx + wy[v]! * sy + wz[v]! * sz) / steep; // wind speed up the slope
    if (up <= 0) continue;
    const block = Math.min(0.8, (up * steep) / 8);
    const take = (block * up) / steep;
    wx[v] = wx[v]! - take * sx;
    wy[v] = wy[v]! - take * sy;
    wz[v] = wz[v]! - take * sz;
  }
}

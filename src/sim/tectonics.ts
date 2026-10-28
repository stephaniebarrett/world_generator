// Plate tectonics on travelling crust points.
//
// Every crust point belongs to one plate and moves with it by rigid rotation
// about the plate's axis. Where plates meet, the plates' relative motion is
// split into a part across the border (closing or opening) and a part along
// it (shear), and each part acts in proportion, fading with distance:
//   closing  -> the denser crust goes under; two buoyant sides pile up into mountains
//   opening  -> crust thins; gaps are filled with new seafloor
//   shear    -> a rippled fault zone
//
// Determinism: only + - * / sqrt, polynomial sin/cos for tiny angles, fixed
// iteration order, grids built in index order.

import { METAMORPHIC_THICKNESS, MAX_THICKNESS, MIN_THICKNESS, ROCK, ROCKS } from './crust';
import { createRng } from './rng';
import { assignGeology } from './geology';
import { fractalNoiseBands } from './roughness';
import { DEFAULT_EROSION, erosionDelta, type ErosionParams } from './erosion';
import type { Lattice } from './lattice';
import type { PlateSetup } from './plates';
import { elevationFromThickness, type WorldState } from './world';

// --- tuning (placeholders until the model is calibrated) -------------------

const OCEAN_FLOOR_THICKNESS = 7;
/** Crust lighter than this (g/cm^3) is buoyant and will not subduct under another buoyant crust. */
const BUOYANT_DENSITY = 2.85;
/** Thickness gained per My per unit of closing speed (rad/My) x edge weight. */
const COLLISION_UPLIFT = 300;
/**
 * Arc volcanism: a share of the crust that goes down a subduction zone comes back up as magma on the overriding plate
 * (about 10% of the volume on Earth). This is how continents grow and replace what collisions and subduction use up.
 */
const ARC_RETURN = 0.12;
const ARC_UPLIFT = 20;
/**
 * Crust is not rigid near a collision: shortening is spread across hundreds of km (Tibet is 1,500 km across, the Andes 300-700).
 * Continental crust consumed at a collision is conserved and piled over a zone this wide (km, to either side of the point where it went).
 */
const COLLISION_REACH_KM = 900;
/** Arc magma from a subducted slab rises across a zone this wide on the overriding plate (km). */
const ARC_REACH_KM = 160;
const EARTH_RADIUS_KM = 6371;
/** Thickness lost per My per unit of opening speed x edge weight. */
const RIFT_THINNING = 150;
const RIPPLE = 60;
const RIPPLE_FREQUENCY = 40;
/** Effect reach and overlap/hole distances, in multiples of the mean point spacing. */
const REACH = 1.6;
const OVERLAP = 0.45;
/**
 * Continental collisions: buoyant crust cannot subduct, so convergence slows as the plates lock together (India's speed
 * roughly halved after it met Asia). Colliding plates relax toward a shared velocity at this rate per My, so a collision
 * ends in a suture and a mountain belt instead of consuming the continents. A rate of 0.06 is a time constant of ~17 My.
 */
const COLLISION_COUPLING = 0.15;
/** Collision contacts (crust points in contact per step) at which the coupling is at full strength. */
const COUPLING_CONTACTS = 4;
/** Share of a plate's slab pull lost while it is held in a continental collision. */
const SLAB_BREAKOFF = 0.9;
/**
 * Plates are driven by sea floor sinking at trenches (slab pull), which continues after continents collide: each plate
 * relaxes back toward its own driving velocity at this rate per My, scaled by how much of it is sea floor.
 */
/** Net thickness gained in one step (km) above which erosion's deposit counts as fresh sediment. */
const DEPOSIT_THRESHOLD = 0.03;
const PLATE_DRIVE = 0.12;
/** A lattice vertex counts as a hole when no crust point is closer than this. */
const HOLE = 0.7;
/** Neighbour search cell, in multiples of spacing (must be >= REACH and >= the spawn search radius). */
const CELL = 2.5;
/**
 * Plate borders resist forming fingers and islands: a point whose surroundings (within this many point spacings) belong
 * mostly to another plate joins that plate, like surface tension on the border. A plate that really tears apart is handled by splitPlates.
 */
const SMOOTH_KM = 500;
/** Crust points of one plate closer than this many spacings are joined; a plate in several large pieces has split. */
const LINK_RADIUS = 1.8;
/** A piece smaller than this share of the globe's points is not a plate of its own (border smoothing tidies it away). */
const PIECE_SHARE = 0.004;
const MAX_PLATES = 40;
/** A new piece drifts away from the plate it broke from at this share of that plate's speed (at least MIN_SPLIT_SPEED rad/My). */
const SPLIT_PUSH = 0.3;
const MIN_SPLIT_SPEED = 0.002;
/** A point joins the neighbouring plate when less than this share of its surroundings is its own plate (and one other plate holds the majority). */
const SMOOTH_OWN_SHARE = 0.42;
/**
 * Thick crust is weak and flows sideways (a mountain belt spreads into broad ranges and plateaus rather than standing as spikes).
 * Each step, crust points within the reach exchange thickness across any pair where either side is above this (km), at this
 * share of the difference, across plate borders too, so both sides of a collision rise.
 */
const FLOW_FROM = 36;
const FLOW_RATE = 0.1;
/** Crust thinner than this (km) is oceanic and neither gives nor takes thickness by flow. */
const FLOW_MIN = 20;
/** How far thick crust exchanges thickness (km). A length in km, not in point spacings, so the world does not depend on detail. */
const FLOW_REACH_KM = 600;

/**
 * Faults. Crust that has been sheared or squeezed keeps a scar: broken, weaker rock that later deformation and erosion
 * concentrate in (old sutures and transform faults are where new mountains and rifts tend to form). A scar builds with the
 * slip and squeezing a point has seen, and heals over hundreds of My.
 */
const SCAR_RATE = 8;
const SCAR_DECAY = 0.003;
/** How many times weaker fully scarred rock is (1 + this), to deformation; erosion gains half of it. */
const SCAR_WEAKENING = 1.5;
/**
 * Hotspots: plumes of hot mantle that stay put while plates drift over them, building a chain of volcanoes (Hawaii, Yellowstone).
 * Crust within this distance of a plume gains this thickness per My (at the centre), until it stands about this thick.
 */
const HOTSPOT_RADIUS_KM = 220;
const HOTSPOT_RATE = 5;
const HOTSPOT_CAP = 42;
/**
 * A volcano that is no longer fed sinks and wears away: oceanic volcanic crust thinner than this (km) loses this share of its
 * height above plain sea floor per My, becoming basalt again once low. Island arcs are fed continually by subduction, so they stay.
 */
const SUBSIDE_BELOW = 28;
const SUBSIDE_RATE = 0.03;
/** Extra erosion of limestone in a wet climate (up to this much more at 1,500 mm/yr). */
const KARST_DISSOLUTION = 0.8;

export interface Crust {
  count: number;
  readonly capacity: number;
  pos: Float64Array;
  plate: Int32Array;
  thickness: Float64Array;
  /** Million years since the crust formed. */
  age: Float64Array;
  /** Rock type (see ROCKS): sets how easily it erodes and how readily plates deform it. */
  rock: Uint8Array;
  /** Fault scarring, 0 (intact) to 1 (heavily broken). */
  scar: Float64Array;
}

export interface TectonicState {
  readonly lattice: Lattice;
  readonly crust: Crust;
  /** Angular velocity vector per plate, xyz interleaved (axis x speed, rad/My). Changes as colliding plates lock together. */
  omega: Float64Array;
  /** Each plate's driving velocity, which it relaxes back toward. */
  omegaDrive: Float64Array;
  /** Mean lattice spacing. */
  readonly spacing: number;
  /** Elapsed simulated time in million years. */
  time: number;
  /** Erosion settings, or null to simulate tectonics alone. */
  readonly erosion: ErosionParams | null;
  /** Annual rainfall (mm/yr) at each lattice vertex, from the latest climate; erosion works harder where it is wet. Null treats everywhere as typical. */
  rainfall: Float32Array | null;
  /** Hotspot positions (unit vectors, xyz interleaved); fixed in space. Empty for none. */
  readonly hotspots: Float64Array;
  /** Points consumed and created in the most recent step (diagnostics). */
  lastDeaths: number;
  lastSpawns: number;
}

/** Crust density from thickness and age (g/cm^3): thick crust is light; old seafloor gets denser. */
export function densityOf(thickness: number, age: number): number {
  const base = 3.0 - ((thickness - OCEAN_FLOOR_THICKNESS) / 28) * 0.3;
  const aged = base + Math.min(age, 200) * 0.0004;
  return Math.min(3.3, Math.max(2.65, aged));
}

export interface TectonicOptions {
  /** Run erosion every step (default off, so tectonics can be tested alone). */
  readonly erosion?: boolean | ErosionParams;
  /** Rock at each lattice point to start from; worked out from the land and plates if not given. */
  readonly rock?: Uint8Array;
  /** Seed for working out the rock when it is not given, and for placing hotspots. */
  readonly seed?: string;
  /** Number of mantle hotspots (default 0: none, so tectonics can be tested alone). Earth has about a dozen strong ones. */
  readonly hotspots?: number;
}

function placeHotspots(count: number, seed: string): Float64Array {
  const rng = createRng(`${seed}/hotspots`);
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere by rejection: a random point in the unit ball, pushed out to its surface.
    for (;;) {
      const x = 2 * rng.next() - 1, y = 2 * rng.next() - 1, z = 2 * rng.next() - 1;
      const r2 = x * x + y * y + z * z;
      if (r2 > 1 || r2 < 0.01) continue;
      const r = Math.sqrt(r2);
      out[i * 3] = x / r;
      out[i * 3 + 1] = y / r;
      out[i * 3 + 2] = z / r;
      break;
    }
  }
  return out;
}

export function createTectonics(world: WorldState, setup: PlateSetup, options: TectonicOptions = {}): TectonicState {
  const { lattice } = world;
  const n = lattice.vertexCount;
  const capacity = Math.ceil(n * 2);
  const crust: Crust = {
    count: n,
    capacity,
    pos: new Float64Array(capacity * 3),
    plate: new Int32Array(capacity),
    thickness: new Float64Array(capacity),
    age: new Float64Array(capacity),
    rock: new Uint8Array(capacity),
    scar: new Float64Array(capacity),
  };
  crust.pos.set(lattice.positions);
  crust.plate.set(setup.plateOf);
  crust.thickness.set(world.thickness);
  crust.rock.set(options.rock ?? assignGeology(lattice, world.thickness, setup.plateOf, setup.plates, options.seed ?? 'rock'));
  // Sea floor starts with the age spread of the real ocean: young near ridges, up to about 180 My old, with the
  // area at each age falling off linearly (so a median of about 50 My). Position decides who is young or old.
  for (let i = 0; i < n; i++) {
    if (elevationFromThickness(world.thickness[i]!) > 0) {
      crust.age[i] = 400;
      continue;
    }
    const u = Math.min(0.999, Math.max(0, 0.5 + 0.9 * fractalNoiseBands(lattice.positions[i * 3]!, lattice.positions[i * 3 + 1]!, lattice.positions[i * 3 + 2]!, 7919, [1.5, 3, 6, 12], [1, 0.8, 0.6, 0.4])));
    crust.age[i] = 180 * (1 - Math.sqrt(1 - u));
  }

  const omega = new Float64Array(setup.plates.length * 3);
  for (const p of setup.plates) {
    omega[p.id * 3] = p.axis[0] * p.angularSpeed;
    omega[p.id * 3 + 1] = p.axis[1] * p.angularSpeed;
    omega[p.id * 3 + 2] = p.axis[2] * p.angularSpeed;
  }
  // Hex lattice: area per point = (sqrt(3)/2) a^2, so a = 1.0746 sqrt(4 pi / N).
  const spacing = 1.0746 * Math.sqrt((4 * Math.PI) / n);
  const erosion = options.erosion === true ? DEFAULT_EROSION : options.erosion || null;
  return { lattice, crust, omega, omegaDrive: Float64Array.from(omega), spacing, erosion, rainfall: null, hotspots: placeHotspots(options.hotspots ?? 0, options.seed ?? 'rock'), time: 0, lastDeaths: 0, lastSpawns: 0 };
}

// --- helpers ---------------------------------------------------------------

/** sin and cos by series for small angles (|x| < 0.3), exact on every engine. */
function sinSmall(x: number): number {
  const x2 = x * x;
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - x2 / 72))));
}
function cosSmall(x: number): number {
  const x2 = x * x;
  return 1 - (x2 / 2) * (1 - (x2 / 12) * (1 - (x2 / 30) * (1 - x2 / 56)));
}

/** Triangle wave in [-1, 1] with period 1 (no trigonometry). */
function triangle(x: number): number {
  const f = x - Math.floor(x);
  return 4 * Math.abs(f - 0.5) - 1;
}

interface Grid {
  readonly dims: number;
  readonly cell: number;
  readonly head: Int32Array;
  readonly next: Int32Array;
  /** Per cell: the plate of every point in it, -1 if empty, -2 if the cell holds more than one plate. Set when built with plates. */
  readonly cellPlate: Int32Array | null;
  /** Per cell: how many points it holds (only with plates). */
  readonly cellCount: Int32Array | null;
}

const GRID_EXTENT = 1.1;

function buildGrid(pos: Float64Array, count: number, cell: number, plate?: Int32Array, keep?: (i: number) => boolean): Grid {
  const dims = Math.ceil((2 * GRID_EXTENT) / cell);
  const head = new Int32Array(dims * dims * dims).fill(-1);
  const next = new Int32Array(count);
  const cellPlate = plate ? new Int32Array(dims * dims * dims).fill(-1) : null;
  const cellCount = plate ? new Int32Array(dims * dims * dims) : null;
  for (let i = 0; i < count; i++) {
    if (keep && !keep(i)) continue;
    const c = cellIndex(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!, cell, dims);
    next[i] = head[c]!;
    head[c] = i;
    if (cellPlate) {
      cellCount![c] = cellCount![c]! + 1;
      const cp = cellPlate[c]!;
      cellPlate[c] = cp === -1 ? plate![i]! : cp === plate![i]! ? cp : -2;
    }
  }
  return { dims, cell, head, next, cellPlate, cellCount };
}

/** True when every point in the 27 cells around (x, y, z) belongs to `own` (so there is no border here). Needs a grid built with plates. */
function onlyPlateNear(grid: Grid, x: number, y: number, z: number, own: number): boolean {
  const { dims, cell, cellPlate } = grid;
  const cx = coord(x, cell, dims), cy = coord(y, cell, dims), cz = coord(z, cell, dims);
  for (let a = Math.max(0, cx - 1); a <= Math.min(dims - 1, cx + 1); a++) {
    for (let b = Math.max(0, cy - 1); b <= Math.min(dims - 1, cy + 1); b++) {
      for (let c = Math.max(0, cz - 1); c <= Math.min(dims - 1, cz + 1); c++) {
        const cp = cellPlate![(a * dims + b) * dims + c]!;
        if (cp !== -1 && cp !== own) return false;
      }
    }
  }
  return true;
}

function coord(v: number, cell: number, dims: number): number {
  const c = Math.floor((v + GRID_EXTENT) / cell);
  return c < 0 ? 0 : c >= dims ? dims - 1 : c;
}

function cellIndex(x: number, y: number, z: number, cell: number, dims: number): number {
  return (coord(x, cell, dims) * dims + coord(y, cell, dims)) * dims + coord(z, cell, dims);
}

/** Visit every point in the 27 cells around (x, y, z). */
function forEachNear(grid: Grid, x: number, y: number, z: number, visit: (j: number) => void): void {
  const { dims, cell, head, next } = grid;
  const cx = coord(x, cell, dims), cy = coord(y, cell, dims), cz = coord(z, cell, dims);
  for (let a = Math.max(0, cx - 1); a <= Math.min(dims - 1, cx + 1); a++) {
    for (let b = Math.max(0, cy - 1); b <= Math.min(dims - 1, cy + 1); b++) {
      for (let c = Math.max(0, cz - 1); c <= Math.min(dims - 1, cz + 1); c++) {
        for (let j = head[(a * dims + b) * dims + c]!; j >= 0; j = next[j]!) visit(j);
      }
    }
  }
}

/** True if any point lies within sqrt(r2) of (x, y, z). Stops at the first one found. */
function anyWithin(grid: Grid, pos: Float64Array, x: number, y: number, z: number, r2: number): boolean {
  const { dims, cell, head, next } = grid;
  const cx = coord(x, cell, dims), cy = coord(y, cell, dims), cz = coord(z, cell, dims);
  for (let a = Math.max(0, cx - 1); a <= Math.min(dims - 1, cx + 1); a++) {
    for (let b = Math.max(0, cy - 1); b <= Math.min(dims - 1, cy + 1); b++) {
      for (let c = Math.max(0, cz - 1); c <= Math.min(dims - 1, cz + 1); c++) {
        for (let j = head[(a * dims + b) * dims + c]!; j >= 0; j = next[j]!) {
          const dx = pos[j * 3]! - x, dy = pos[j * 3 + 1]! - y, dz = pos[j * 3 + 2]! - z;
          if (dx * dx + dy * dy + dz * dz < r2) return true;
        }
      }
    }
  }
  return false;
}

/** The point nearest (x, y, z) among the 27 cells around it (lowest index on a tie), or -1. */
function nearestNear(grid: Grid, pos: Float64Array, x: number, y: number, z: number): number {
  const { dims, cell, head, next } = grid;
  const cx = coord(x, cell, dims), cy = coord(y, cell, dims), cz = coord(z, cell, dims);
  let best = -1, bestD = Infinity;
  for (let a = Math.max(0, cx - 1); a <= Math.min(dims - 1, cx + 1); a++) {
    for (let b = Math.max(0, cy - 1); b <= Math.min(dims - 1, cy + 1); b++) {
      for (let c = Math.max(0, cz - 1); c <= Math.min(dims - 1, cz + 1); c++) {
        for (let j = head[(a * dims + b) * dims + c]!; j >= 0; j = next[j]!) {
          const dx = pos[j * 3]! - x, dy = pos[j * 3 + 1]! - y, dz = pos[j * 3 + 2]! - z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestD || (d2 === bestD && j < best)) { bestD = d2; best = j; }
        }
      }
    }
  }
  return best;
}

// --- one step --------------------------------------------------------------

export function stepTectonics(t: TectonicState, dt: number): void {
  const { crust, omega, omegaDrive, spacing } = t;
  const n = crust.count;
  const { pos, plate, thickness, age } = crust;

  // 1. Age and move: rigid rotation about each plate's axis (Rodrigues, small angle).
  for (let i = 0; i < n; i++) {
    age[i] = age[i]! + dt;
    const p = plate[i]!;
    const wx = omega[p * 3]!, wy = omega[p * 3 + 1]!, wz = omega[p * 3 + 2]!;
    const speed = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (speed === 0) continue;
    const theta = speed * dt;
    const kx = wx / speed, ky = wy / speed, kz = wz / speed;
    const s = sinSmall(theta), c = cosSmall(theta);
    const x = pos[i * 3]!, y = pos[i * 3 + 1]!, z = pos[i * 3 + 2]!;
    const dot = kx * x + ky * y + kz * z;
    const cx = ky * z - kz * y, cy = kz * x - kx * z, cz = kx * y - ky * x;
    const nx = x * c + cx * s + kx * dot * (1 - c);
    const ny = y * c + cy * s + ky * dot * (1 - c);
    const nz = z * c + cz * s + kz * dot * (1 - c);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    pos[i * 3] = nx / len;
    pos[i * 3 + 1] = ny / len;
    pos[i * 3 + 2] = nz / len;
  }

  // 2. Border interactions.
  // Which plate goes under at a border is a property of the two plates, not of each cell: seafloor spreading
  // leaves stripes of young and old crust, and deciding cell by cell makes the winner flip stripe by stripe,
  // which interlocks the plates like fingers. So compare the plates' mean densities.
  const plateCount = omega.length / 3;
  const densSum = new Float64Array(plateCount);
  const densN = new Int32Array(plateCount);
  const seaN = new Int32Array(plateCount); // sea-floor points per plate
  for (let i = 0; i < n; i++) {
    densSum[plate[i]!] = densSum[plate[i]!]! + densityOf(thickness[i]!, age[i]!);
    densN[plate[i]!] = densN[plate[i]!]! + 1;
    if (densityOf(thickness[i]!, age[i]!) >= BUOYANT_DENSITY) seaN[plate[i]!] = seaN[plate[i]!]! + 1;
  }
  const contacts = new Int32Array(plateCount * plateCount); // continent-continent contacts per plate pair
  const plateDensity = new Float64Array(plateCount);
  for (let p = 0; p < plateCount; p++) plateDensity[p] = densN[p] ? densSum[p]! / densN[p]! : 0;
  const reach = REACH * spacing;
  const reach2 = reach * reach;
  const overlap = OVERLAP * spacing;
  const grid = buildGrid(pos, n, CELL * spacing, plate);
  const dead = new Uint8Array(n);
  const delta = new Float64Array(n);
  const scarGain = new Float64Array(n);
  const erupted = new Uint8Array(n); // points that received arc magma this step
  const deadKind = new Uint8Array(n); // how a consumed point's crust is handled: 1 continental collision, 2 subduction
  const deadTo = new Int32Array(n); // for subduction: the plate that overrides it

  for (let i = 0; i < n; i++) {
    const pi = plate[i]!;
    const px = pos[i * 3]!, py = pos[i * 3 + 1]!, pz = pos[i * 3 + 2]!;
    const dens = densityOf(thickness[i]!, age[i]!);
    // Velocity of this point: omega x p.
    const wix = omega[pi * 3]!, wiy = omega[pi * 3 + 1]!, wiz = omega[pi * 3 + 2]!;
    const vix = wiy * pz - wiz * py, viy = wiz * px - wix * pz, viz = wix * py - wiy * px;

    let collide = 0, arc = 0, rift = 0, ripple = 0, slip = 0;

    // Well inside a plate nothing is near enough to interact with (every neighbour is skipped as the same plate).
    if (onlyPlateNear(grid, px, py, pz, pi)) {
      scarGain[i] = SCAR_RATE * dt * (slip + collide);
      continue;
    }
    forEachNear(grid, px, py, pz, (j) => {
      if (j === i) return;
      const pj = plate[j]!;
      if (pj === pi) return;
      const qx = pos[j * 3]!, qy = pos[j * 3 + 1]!, qz = pos[j * 3 + 2]!;
      const dx = qx - px, dy = qy - py, dz = qz - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= reach2 || d2 === 0) return;
      const dist = Math.sqrt(d2);

      // Direction toward j along the surface at i.
      const radial = dx * px + dy * py + dz * pz;
      let tx = dx - radial * px, ty = dy - radial * py, tz = dz - radial * pz;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl === 0) return;
      tx /= tl; ty /= tl; tz /= tl;

      const wjx = omega[pj * 3]!, wjy = omega[pj * 3 + 1]!, wjz = omega[pj * 3 + 2]!;
      const vjx = wjy * qz - wjz * qy, vjy = wjz * qx - wjx * qz, vjz = wjx * qy - wjy * qx;
      const rx = vix - vjx, ry = viy - vjy, rz = viz - vjz;
      const closing = rx * tx + ry * ty + rz * tz;
      // Tangential part of the relative velocity gives the along-fault shear.
      const rn = rx * px + ry * py + rz * pz;
      const rtx = rx - rn * px, rty = ry - rn * py, rtz = rz - rn * pz;
      const rt2 = rtx * rtx + rty * rty + rtz * rtz;
      const along = Math.sqrt(Math.max(0, rt2 - closing * closing));

      const f = 1 - dist / reach;
      const w = f * f;
      const densJ = densityOf(thickness[j]!, age[j]!);
      const bothBuoyant = dens < BUOYANT_DENSITY && densJ < BUOYANT_DENSITY;

      // Which side gives way where two plates overlap? Denser crust goes under. When both sides are buoyant
      // (a continental collision) density is too close to call and flips from cell to cell as the crust thickens,
      // which interleaves the plates, so the lower-numbered plate simply wins the whole border.
      // Buoyant continental crust does not subduct: where it meets sea floor, the sea floor goes under, whichever plate
      // each belongs to. Between crust of the same kind, the plates' mean densities decide (see above).
      const iBuoyant = dens < BUOYANT_DENSITY;
      const jBuoyant = densJ < BUOYANT_DENSITY;
      const loses =
        iBuoyant !== jBuoyant
          ? !iBuoyant
          : plateDensity[pi]! !== plateDensity[pj]!
            ? plateDensity[pi]! > plateDensity[pj]!
            : pi > pj;
      const approach = closing > 0 ? closing * dt : 0;
      if (loses && dist - approach < overlap) {
        // Overlapping, or about to be: this point is consumed, whichever way the plates are moving.
        dead[i] = 1;
        // What happens to the crust that goes is settled below, once the whole border is known.
        if (deadKind[i] === 0) { deadKind[i] = bothBuoyant ? 1 : 2; deadTo[i] = pj; }
      }
      if (bothBuoyant && closing > 0 && dist < reach) {
        const lo = Math.min(pi, pj), hi = Math.max(pi, pj);
        contacts[lo * plateCount + hi] = contacts[lo * plateCount + hi]! + 1;
      }
      if (closing > 0) {
        if (!loses) {
          if (bothBuoyant) collide += closing * w;
          else arc += closing * w;
        } else if (bothBuoyant) {
          collide += closing * w;
        }
      } else if (closing < 0) {
        rift += -closing * w;
      }

      if (along > 0) {
        const rl = Math.sqrt(rt2);
        const phase = (px * rtx + py * rty + pz * rtz) / rl;
        ripple += along * w * triangle(phase * RIPPLE_FREQUENCY);
        slip += along * w;
      }
    });

    // Weak crust (sediment, young belts) deforms readily; old cratons resist, so mountains rise at their margins, not through them.
    const weak = ROCKS[crust.rock[i]!]!.weakness * (1 + SCAR_WEAKENING * crust.scar[i]!);
    scarGain[i] = SCAR_RATE * dt * (slip + collide);
    delta[i] = delta[i]! + dt * ((COLLISION_UPLIFT * collide + ARC_UPLIFT * arc - RIFT_THINNING * rift) * weak + RIPPLE * ripple);
  }

  // Hotspots: plumes fixed in the mantle build volcanoes on whatever crust drifts over them.
  const plumes = t.hotspots.length / 3;
  if (plumes > 0) {
    const radius = HOTSPOT_RADIUS_KM / EARTH_RADIUS_KM;
    for (let i = 0; i < n; i++) {
      for (let h = 0; h < plumes; h++) {
        const dx = pos[i * 3]! - t.hotspots[h * 3]!, dy = pos[i * 3 + 1]! - t.hotspots[h * 3 + 1]!, dz = pos[i * 3 + 2]! - t.hotspots[h * 3 + 2]!;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= radius * radius) continue;
        const f = 1 - Math.sqrt(d2) / radius;
        const gain = dt * HOTSPOT_RATE * f * f * Math.max(0, 1 - thickness[i]! / HOTSPOT_CAP);
        delta[i] = delta[i]! + gain;
        if (gain > 0.02 * dt) erupted[i] = 1;
      }
    }
  }

  // Spread the consumed crust. Continental crust that is squeezed out piles into a broad belt on both sides of the collision;
  // the share of a slab that returns as magma builds a volcanic belt on the overriding plate.
  const nearReach = Math.max(COLLISION_REACH_KM, ARC_REACH_KM) / EARTH_RADIUS_KM;
  const wide = buildGrid(pos, n, nearReach);
  for (let i = 0; i < n; i++) {
    const kind = deadKind[i]!;
    if (kind === 0) continue;
    const radius = (kind === 1 ? COLLISION_REACH_KM : ARC_REACH_KM) / EARTH_RADIUS_KM;
    const r2 = radius * radius;
    const px = pos[i * 3]!, py = pos[i * 3 + 1]!, pz = pos[i * 3 + 2]!;
    const target = deadTo[i]!;
    const weigh = (k: number): number => {
      if (dead[k]) return 0;
      if (kind === 2 && plate[k] !== target) return 0;
      if (kind === 1 && thickness[k]! < FLOW_MIN) return 0; // only continental crust takes part
      const dx = pos[k * 3]! - px, dy = pos[k * 3 + 1]! - py, dz = pos[k * 3 + 2]! - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) return 0;
      const f = 1 - Math.sqrt(d2) / radius;
      return f * f * (kind === 1 ? ROCKS[crust.rock[k]!]!.weakness : 1);
    };
    let total = 0;
    forEachNear(wide, px, py, pz, (k) => { total += weigh(k); });
    if (total === 0) continue;
    const mass = (kind === 1 ? 1 : ARC_RETURN) * thickness[i]!;
    forEachNear(wide, px, py, pz, (k) => {
      const w = weigh(k);
      if (w === 0) return;
      const add = (mass * w) / total;
      delta[k] = delta[k]! + add;
      if (kind === 2 && add > 0.02) erupted[k] = 1;
    });
  }

  // Colliding continents lock together: relax the plates' angular velocities toward each other, weighted by size.
  const locked = new Float64Array(plateCount); // how firmly each plate is held by a collision, 0 to 1
  for (let a = 0; a < plateCount; a++) {
    for (let b = a + 1; b < plateCount; b++) {
      const contact = contacts[a * plateCount + b]!;
      if (contact === 0) continue;
      const grip = Math.min(1, contact / COUPLING_CONTACTS);
      locked[a] = Math.max(locked[a]!, grip);
      locked[b] = Math.max(locked[b]!, grip);
      const strength = grip * COLLISION_COUPLING * dt;
      const ma = densN[a]!, mb = densN[b]!;
      if (ma + mb === 0) continue;
      for (let k = 0; k < 3; k++) {
        const wa = omega[a * 3 + k]!, wb = omega[b * 3 + k]!;
        omega[a * 3 + k] = wa + strength * (mb / (ma + mb)) * (wb - wa);
        omega[b * 3 + k] = wb + strength * (ma / (ma + mb)) * (wa - wb);
      }
    }
  }

  // Slab pull keeps sea-floor plates moving: relax each toward its driving velocity, in proportion to its sea floor.
  for (let p = 0; p < plateCount; p++) {
    if (densN[p] === 0) continue;
    // A slab that has met a continent breaks off: a plate held in a collision loses most of its pull.
    const pull = PLATE_DRIVE * dt * (seaN[p]! / densN[p]!) * (1 - SLAB_BREAKOFF * locked[p]!);
    for (let k = 0; k < 3; k++) omega[p * 3 + k] = omega[p * 3 + k]! + pull * (omegaDrive[p * 3 + k]! - omega[p * 3 + k]!);
  }

  // 3. Apply thickness changes and drop consumed points (stable compaction).
  let out = 0;
  for (let i = 0; i < n; i++) {
    if (dead[i]) continue;
    const th = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, thickness[i]! + delta[i]!));
    if (out !== i) {
      pos[out * 3] = pos[i * 3]!;
      pos[out * 3 + 1] = pos[i * 3 + 1]!;
      pos[out * 3 + 2] = pos[i * 3 + 2]!;
      plate[out] = plate[i]!;
      age[out] = age[i]!;
    }
    crust.scar[out] = Math.min(1, crust.scar[i]! * (1 - SCAR_DECAY * dt) + scarGain[i]!);
    // Rock changes as the plates work on it: squeezed crust turns metamorphic, and arc magma makes volcanic rock.
    let kind = crust.rock[i]!;
    if (th > METAMORPHIC_THICKNESS) kind = ROCK.metamorphic;
    else if (erupted[i] && kind !== ROCK.metamorphic && kind !== ROCK.craton) kind = ROCK.volcanic;
    let height = th;
    if (plumes > 0 && kind === ROCK.volcanic && !erupted[i] && th < SUBSIDE_BELOW && th > OCEAN_FLOOR_THICKNESS) {
      // An unfed volcano sinks and wears away.
      height = th - (th - OCEAN_FLOOR_THICKNESS) * SUBSIDE_RATE * dt;
      if (height < OCEAN_FLOOR_THICKNESS + 2) kind = ROCK.basalt;
    }
    crust.rock[out] = kind;
    thickness[out] = height;
    out++;
  }
  crust.count = out;
  t.lastDeaths = n - out;

  flowCrust(t, dt);
  // Borders only need tidying every other step.
  if (Math.round(t.time / dt) % 2 === 1) smoothBorders(t);

  // 4. Fill holes (rifts and gaps) with new seafloor, shared between the two nearest plates.
  const beforeFill = crust.count;
  // Plates tile the globe, so the point count should stay at its starting value: replace what was consumed.
  fillHoles(t, Math.max(0, t.lattice.vertexCount - crust.count));
  t.lastSpawns = crust.count - beforeFill;
  if (Math.round(t.time / dt) % 4 === 3) splitPlates(t);
  if (t.erosion) applyErosion(t, dt);
  t.time += dt;
}

/**
 * A plate that has torn into separate large pieces is several plates now: each piece after the biggest becomes a plate
 * of its own, moving off a little from where it broke away, so it can evolve with its new neighbours.
 */
function splitPlates(t: TectonicState): void {
  const { crust, spacing } = t;
  const n = crust.count;
  const { pos, plate } = crust;
  const link2 = LINK_RADIUS * spacing * (LINK_RADIUS * spacing);
  const grid = buildGrid(pos, n, CELL * spacing);
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; }
    return a;
  };
  for (let i = 0; i < n; i++) {
    const px = pos[i * 3]!, py = pos[i * 3 + 1]!, pz = pos[i * 3 + 2]!;
    forEachNear(grid, px, py, pz, (j) => {
      if (j <= i || plate[j] !== plate[i]) return;
      const dx = pos[j * 3]! - px, dy = pos[j * 3 + 1]! - py, dz = pos[j * 3 + 2]! - pz;
      if (dx * dx + dy * dy + dz * dz > link2) return;
      const a = find(i), b = find(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    });
  }
  const size = new Int32Array(n);
  for (let i = 0; i < n; i++) size[find(i)] = size[find(i)]! + 1;
  const minPiece = Math.max(12, Math.round(PIECE_SHARE * t.lattice.vertexCount));
  // Pieces per plate, biggest first (ties by lowest root, so the order is fixed).
  const byPlate = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (find(i) !== i || size[i]! < minPiece) continue;
    const list = byPlate.get(plate[i]!);
    if (list) list.push(i); else byPlate.set(plate[i]!, [i]);
  }
  const plateCount = t.omega.length / 3;
  let total = plateCount;
  const fresh: { root: number; from: number; id: number }[] = [];
  for (const id of [...byPlate.keys()].sort((a, b) => a - b)) {
    const pieces = byPlate.get(id)!.sort((a, b) => size[b]! - size[a]! || a - b);
    for (let k = 1; k < pieces.length && total < MAX_PLATES; k++) fresh.push({ root: pieces[k]!, from: id, id: total++ });
  }
  if (fresh.length === 0) return;

  const omega = new Float64Array(total * 3), drive = new Float64Array(total * 3);
  omega.set(t.omega);
  drive.set(t.omegaDrive);
  const centre = (root: number): [number, number, number] => {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) if (find(i) === root) { x += pos[i * 3]!; y += pos[i * 3 + 1]!; z += pos[i * 3 + 2]!; }
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  };
  for (const f of fresh) {
    const main = byPlate.get(f.from)![0]!;
    const cm = centre(main), cp = centre(f.root);
    // Surface direction from the main body toward the new piece, and the rotation that carries the piece along it.
    const dot = cm[0] * cp[0] + cm[1] * cp[1] + cm[2] * cp[2];
    let dx = cp[0] - dot * cm[0], dy = cp[1] - dot * cm[1], dz = cp[2] - dot * cm[2];
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl === 0) { dx = 1; dy = 0; dz = 0; } else { dx /= dl; dy /= dl; dz /= dl; }
    const base = f.from * 3;
    const speed = Math.sqrt(omega[base]! ** 2 + omega[base + 1]! ** 2 + omega[base + 2]! ** 2);
    const push = Math.max(MIN_SPLIT_SPEED, SPLIT_PUSH * speed);
    const wx = cp[1] * dz - cp[2] * dy, wy = cp[2] * dx - cp[0] * dz, wz = cp[0] * dy - cp[1] * dx;
    omega[f.id * 3] = omega[base]! + push * wx;
    omega[f.id * 3 + 1] = omega[base + 1]! + push * wy;
    omega[f.id * 3 + 2] = omega[base + 2]! + push * wz;
    drive[f.id * 3] = t.omegaDrive[base]! + push * wx;
    drive[f.id * 3 + 1] = t.omegaDrive[base + 1]! + push * wy;
    drive[f.id * 3 + 2] = t.omegaDrive[base + 2]! + push * wz;
  }
  const newId = new Map<number, number>();
  for (const f of fresh) newId.set(f.root, f.id);
  for (let i = 0; i < n; i++) {
    const id = newId.get(find(i));
    if (id !== undefined) plate[i] = id;
  }
  t.omega = omega;
  t.omegaDrive = drive;
}

/** Thick crust spreads: neighbouring points even out their thickness where either is mountainous. Conserves crust exactly. */
function flowCrust(t: TectonicState, dt: number): void {
  const { crust } = t;
  const n = crust.count;
  const { pos, thickness } = crust;
  const reach = FLOW_REACH_KM / EARTH_RADIUS_KM;
  const reach2 = reach * reach;
  const grid = buildGrid(pos, n, Math.max(CELL * t.spacing, reach), undefined, (i) => thickness[i]! >= FLOW_MIN); // only continental crust flows
  const change = new Float64Array(n);
  // Weights are normalised by what a point would collect from evenly spread neighbours (density x kernel area), so the
  // spreading is the same at any detail.
  const norm = (n * reach2) / 12;
  const rate = Math.min(0.5, FLOW_RATE * dt) / norm;
  // Crust only moves between a thick point (above FLOW_FROM) and a neighbour, so those are the ones to start from. A pair of two thick
  // points is taken from the lower-numbered one.
  for (let i = 0; i < n; i++) {
    const ti = thickness[i]!;
    if (ti <= FLOW_FROM) continue;
    const px = pos[i * 3]!, py = pos[i * 3 + 1]!, pz = pos[i * 3 + 2]!;
    forEachNear(grid, px, py, pz, (j) => {
      if (j === i) return;
      const tj = thickness[j]!;
      if (j < i && tj > FLOW_FROM) return; // already done from j's side
      const dx = pos[j * 3]! - px, dy = pos[j * 3 + 1]! - py, dz = pos[j * 3 + 2]! - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= reach2) return;
      const f = 1 - Math.sqrt(d2) / reach;
      // Weak rock flows readily; a strong craton barely does.
      const weak = 0.5 * (ROCKS[crust.rock[i]!]!.weakness + ROCKS[crust.rock[j]!]!.weakness);
      const flux = rate * f * weak * (tj - ti);
      change[i] = change[i]! + flux;
      change[j] = change[j]! - flux;
    });
  }
  for (let i = 0; i < n; i++) {
    thickness[i] = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, thickness[i]! + change[i]!));
    if (thickness[i]! > METAMORPHIC_THICKNESS) crust.rock[i] = ROCK.metamorphic;
  }
}

/** Hand isolated fingers, islands and slivers of one plate over to the plate that surrounds them. */
function smoothBorders(t: TectonicState): void {
  const { crust } = t;
  const n = crust.count;
  const { pos, plate } = crust;
  const radius = SMOOTH_KM / EARTH_RADIUS_KM;
  const r2 = radius * radius;
  // Cells half the radius across, so the disc around a point spans two cells each way. A cell holding one plate that lies
  // wholly inside the disc is counted in one go; only cells on the disc's edge or at a plate border are searched point by point.
  const side = radius / 2;
  const grid = buildGrid(pos, n, side, plate);
  const { dims, head, next, cellPlate, cellCount } = grid;
  const plateCount = t.omega.length / 3;
  const tally = new Int32Array(plateCount);
  const touched: number[] = [];
  const nextPlate = Int32Array.from(plate.subarray(0, n));
  // For each cell (found on first use): the one plate that owns every point within two cells, or -2 if the window is mixed.
  // A point in a window of its own plate alone has nothing to hand over.
  const windowPlate = new Int32Array(dims * dims * dims).fill(-3);
  const windowOf = (cx: number, cy: number, cz: number): number => {
    let only = -1;
    for (let a = Math.max(0, cx - 2); a <= Math.min(dims - 1, cx + 2); a++) {
      for (let b = Math.max(0, cy - 2); b <= Math.min(dims - 1, cy + 2); b++) {
        for (let c = Math.max(0, cz - 2); c <= Math.min(dims - 1, cz + 2); c++) {
          const cp = cellPlate![(a * dims + b) * dims + c]!;
          if (cp === -1) continue;
          if (cp === -2 || (only !== -1 && cp !== only)) return -2;
          only = cp;
        }
      }
    }
    return only;
  };
  for (let i = 0; i < n; i++) {
    const own = plate[i]!;
    const px = pos[i * 3]!, py = pos[i * 3 + 1]!, pz = pos[i * 3 + 2]!;
    const cx = coord(px, side, dims), cy = coord(py, side, dims), cz = coord(pz, side, dims);
    const home = (cx * dims + cy) * dims + cz;
    if (windowPlate[home] === -3) windowPlate[home] = windowOf(cx, cy, cz);
    if (windowPlate[home] === own) continue;
    let total = 0;
    for (let a = Math.max(0, cx - 2); a <= Math.min(dims - 1, cx + 2); a++) {
      const fx = Math.max(px - (a * side - GRID_EXTENT), (a + 1) * side - GRID_EXTENT - px);
      for (let b = Math.max(0, cy - 2); b <= Math.min(dims - 1, cy + 2); b++) {
        const fy = Math.max(py - (b * side - GRID_EXTENT), (b + 1) * side - GRID_EXTENT - py);
        for (let c = Math.max(0, cz - 2); c <= Math.min(dims - 1, cz + 2); c++) {
          const cell = (a * dims + b) * dims + c;
          const cp = cellPlate![cell]!;
          if (cp === -1) continue;
          if (cp >= 0) {
            const fz = Math.max(pz - (c * side - GRID_EXTENT), (c + 1) * side - GRID_EXTENT - pz);
            if (fx * fx + fy * fy + fz * fz <= r2) {
              // Every point of the cell is within reach.
              if (tally[cp] === 0) touched.push(cp);
              tally[cp] = tally[cp]! + cellCount![cell]!;
              total += cellCount![cell]!;
              continue;
            }
          }
          for (let j = head[cell]!; j >= 0; j = next[j]!) {
            const dx = pos[j * 3]! - px, dy = pos[j * 3 + 1]! - py, dz = pos[j * 3 + 2]! - pz;
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            const pj = plate[j]!;
            if (tally[pj] === 0) touched.push(pj);
            tally[pj] = tally[pj]! + 1;
            total++;
          }
        }
      }
    }
    let best = own, bestCount = tally[own]!;
    const ownCount = bestCount;
    for (const p of touched) if (tally[p]! > bestCount || (tally[p] === bestCount && p < best && p !== own)) { best = p; bestCount = tally[p]!; }
    for (const p of touched) tally[p] = 0;
    touched.length = 0;
    if (best !== own && ownCount < SMOOTH_OWN_SHARE * total && bestCount > total / 2) nextPlate[i] = best;
  }
  for (let i = 0; i < n; i++) plate[i] = nextPlate[i]!;
}

function fillHoles(t: TectonicState, quota: number): void {
  if (quota === 0) return;
  const { crust, lattice, spacing } = t;
  const { pos, plate, thickness, age } = crust;
  const grid = buildGrid(pos, crust.count, CELL * spacing);
  const hole2 = HOLE * spacing * (HOLE * spacing);
  const search2 = CELL * spacing * (CELL * spacing);

  interface Candidate {
    vertex: number;
    gap: number;
    plate: number;
    /** Nearest crust point, and the mean thickness of the crust around the hole. */
    near: number;
    around: number;
    /** True where the plates on either side of the hole are pulling apart (so new sea floor belongs there). */
    opening: boolean;
  }
  const candidates: Candidate[] = [];

  for (let v = 0; v < lattice.vertexCount; v++) {
    const qx = lattice.positions[v * 3]!, qy = lattice.positions[v * 3 + 1]!, qz = lattice.positions[v * 3 + 2]!;
    // Almost every vertex has crust right on it: only the few holes need the full survey below.
    if (anyWithin(grid, pos, qx, qy, qz, hole2)) continue;
    let nearest = Infinity;
    // The two closest distinct plates, as (plate, squared distance) with first <= second.
    let firstPlate = -1, firstD = Infinity, firstJ = -1;
    let secondPlate = -1, secondD = Infinity, secondJ = -1;
    let nearJ = -1, thickSum = 0, thickN = 0;
    forEachNear(grid, qx, qy, qz, (j) => {
      const dx = pos[j * 3]! - qx, dy = pos[j * 3 + 1]! - qy, dz = pos[j * 3 + 2]! - qz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < nearest) { nearest = d2; nearJ = j; }
      if (d2 >= search2) return;
      thickSum += thickness[j]!;
      thickN++;
      const p = plate[j]!;
      if (p === firstPlate) {
        if (d2 < firstD) { firstD = d2; firstJ = j; }
      } else if (p === secondPlate) {
        if (d2 < secondD) { secondD = d2; secondJ = j; }
      } else if (d2 < firstD) {
        secondPlate = firstPlate; secondD = firstD; secondJ = firstJ;
        firstPlate = p; firstD = d2; firstJ = j;
      } else if (d2 < secondD) {
        secondPlate = p; secondD = d2; secondJ = j;
      }
      if (secondD < firstD) {
        [firstPlate, secondPlate] = [secondPlate, firstPlate];
        [firstD, secondD] = [secondD, firstD];
        [firstJ, secondJ] = [secondJ, firstJ];
      }
    });
    if (nearest < hole2 || firstPlate < 0) continue;
    // Are the plates either side moving apart here? Their relative velocity along the line between them.
    let opening = secondPlate >= 0;
    if (opening) {
      const { omega } = t;
      const ax = pos[firstJ * 3]!, ay = pos[firstJ * 3 + 1]!, az = pos[firstJ * 3 + 2]!;
      const bx = pos[secondJ * 3]! - ax, by = pos[secondJ * 3 + 1]! - ay, bz = pos[secondJ * 3 + 2]! - az;
      const wx = omega[firstPlate * 3]! - omega[secondPlate * 3]!, wy = omega[firstPlate * 3 + 1]! - omega[secondPlate * 3 + 1]!, wz = omega[firstPlate * 3 + 2]! - omega[secondPlate * 3 + 2]!;
      const rx = wy * qz - wz * qy, ry = wz * qx - wx * qz, rz = wx * qy - wy * qx;
      opening = rx * bx + ry * by + rz * bz <= 0; // first moving away from second
    }
    // New crust goes to the nearest plate, so a rift splits down its midline: each side grows its own half.
    candidates.push({ vertex: v, gap: nearest, plate: firstPlate, near: nearJ, around: thickN > 0 ? thickSum / thickN : OCEAN_FLOOR_THICKNESS, opening });
  }

  // Fill the biggest holes first, and never two adjacent lattice vertices, so new crust has even spacing.
  candidates.sort((a, b) => b.gap - a.gap || a.vertex - b.vertex);
  const blocked = new Uint8Array(lattice.vertexCount);
  let made = 0;
  for (const c of candidates) {
    if (made >= quota || crust.count >= crust.capacity) break;
    if (blocked[c.vertex]) continue;
    blocked[c.vertex] = 1;
    for (let k = lattice.offsets[c.vertex]!; k < lattice.offsets[c.vertex + 1]!; k++) blocked[lattice.neighbors[k]!] = 1;
    const i = crust.count++;
    pos[i * 3] = lattice.positions[c.vertex * 3]!;
    pos[i * 3 + 1] = lattice.positions[c.vertex * 3 + 1]!;
    pos[i * 3 + 2] = lattice.positions[c.vertex * 3 + 2]!;
    plate[i] = c.plate;
      if (!c.opening && c.around > FLOW_MIN) {
      // A gap inside a belt of continental crust that is being squeezed (not pulled apart): it is filled with the crust
      // around it, not with sea floor, so mountain belts do not get holes in them.
      thickness[i] = c.around;
      age[i] = crust.age[c.near]!;
      crust.rock[i] = crust.rock[c.near]!;
      crust.scar[i] = 0;
    } else {
      thickness[i] = OCEAN_FLOOR_THICKNESS;
      age[i] = 0;
      crust.rock[i] = ROCK.basalt; // new sea floor is basalt
      crust.scar[i] = 0;
    }
    made++;
  }
}

// --- reading the result back onto the lattice -------------------------------

export interface Resampled {
  readonly thickness: Float64Array;
  readonly plate: Int32Array;
  /** Index of the crust point each lattice vertex read from (-1 if none). */
  readonly nearest: Int32Array;
  /** Rock type at each lattice vertex. */
  readonly rock: Uint8Array;
}

/** Nearest crust point for every lattice vertex (used to draw the simulation on the view mesh). */
export function resample(t: TectonicState): Resampled {
  const { crust, lattice, spacing } = t;
  const grid = buildGrid(crust.pos, crust.count, CELL * spacing);
  const n = lattice.vertexCount;
  const thickness = new Float64Array(n);
  const plate = new Int32Array(n);
  const nearest = new Int32Array(n);
  const rock = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    const qx = lattice.positions[v * 3]!, qy = lattice.positions[v * 3 + 1]!, qz = lattice.positions[v * 3 + 2]!;
    const best = nearestNear(grid, crust.pos, qx, qy, qz);
    thickness[v] = best >= 0 ? crust.thickness[best]! : OCEAN_FLOOR_THICKNESS;
    plate[v] = best >= 0 ? crust.plate[best]! : 0;
    nearest[v] = best;
    rock[v] = best >= 0 ? crust.rock[best]! : ROCK.basalt;
  }
  return { thickness, plate, nearest, rock };
}

/** Erode the lattice field, then hand each change back to the crust point that vertex reads from. */
function applyErosion(t: TectonicState, dt: number): void {
  if (!t.erosion) return;
  const { crust, lattice } = t;
  const field = resample(t);
  // Rock decides how fast each spot wears: hard crystalline rock stands, soft sediment is stripped.
  // Faulted rock is shattered and wears faster; limestone dissolves in rain (karst), the wetter the faster.
  const erodibility = Float64Array.from(field.rock, (r, v) => {
    const j = field.nearest[v]!;
    let e = ROCKS[r]!.erodibility * (1 + 0.5 * SCAR_WEAKENING * (j >= 0 ? crust.scar[j]! : 0));
    if (r === ROCK.limestone && t.rainfall) e *= 1 + KARST_DISSOLUTION * Math.min(1, t.rainfall[v]! / 1500);
    return e;
  });
  const delta = erosionDelta(lattice, field.thickness, dt, t.erosion, erodibility, t.rainfall ?? undefined);
  const sum = new Float64Array(crust.count);
  const owned = new Int32Array(crust.count);
  for (let v = 0; v < lattice.vertexCount; v++) {
    const j = field.nearest[v]!;
    if (j < 0) continue;
    sum[j] = sum[j]! + delta[v]!;
    owned[j] = owned[j]! + 1;
  }
  for (let j = 0; j < crust.count; j++) {
    if (owned[j] === 0) continue;
    const change = sum[j]! / owned[j]!;
    crust.thickness[j] = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, crust.thickness[j]! + change));
    // Where erosion lays material down, the ground becomes fresh sediment (soft, until buried and squeezed).
    if (change > DEPOSIT_THRESHOLD && crust.thickness[j]! <= METAMORPHIC_THICKNESS && crust.rock[j] !== ROCK.craton) crust.rock[j] = ROCK.sediment;
  }
}

/** Extra erosion at the current moment, `my` million years of it in 1 My steps. */
export function erodeCrust(t: TectonicState, my: number): void {
  const steps = Math.max(1, Math.round(my));
  for (let i = 0; i < steps; i++) applyErosion(t, my / steps);
}

// --- snapshots for keyframes -------------------------------------------------

export interface Snapshot {
  readonly time: number;
  readonly count: number;
  readonly pos: Float64Array;
  readonly plate: Int32Array;
  readonly thickness: Float64Array;
  readonly age: Float64Array;
  readonly rock: Uint8Array;
  readonly scar: Float64Array;
  readonly omega: Float64Array;
  readonly omegaDrive: Float64Array;
}

export function snapshot(t: TectonicState): Snapshot {
  const c = t.crust;
  const n = c.count;
  return {
    time: t.time,
    count: n,
    pos: c.pos.slice(0, n * 3),
    plate: c.plate.slice(0, n),
    thickness: c.thickness.slice(0, n),
    age: c.age.slice(0, n),
    rock: c.rock.slice(0, n),
    scar: c.scar.slice(0, n),
    omega: t.omega.slice(),
    omegaDrive: t.omegaDrive.slice(),
  };
}

export function restore(t: TectonicState, s: Snapshot): void {
  const c = t.crust;
  c.count = s.count;
  c.pos.set(s.pos);
  c.plate.set(s.plate);
  c.thickness.set(s.thickness);
  c.age.set(s.age);
  c.rock.set(s.rock);
  c.scar.set(s.scar);
  t.omega = s.omega.slice();
  t.omegaDrive = s.omegaDrive.slice();
  t.time = s.time;
}

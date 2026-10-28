// The saved form of a world: its recipe plus planet settings, as JSON.
// Parsing validates everything, because the file may come from anywhere.

import type { CirculationLevel } from './sim/circulation';
import { SIM_VERSION, type Edit, type Falloff, type Recipe } from './sim/world';

export const FILE_FORMAT = 'world-generator';
export const FILE_VERSION = 1;

export interface PlanetSettings {
  /** Axial tilt in degrees. */
  readonly tiltDegrees: number;
  readonly spin: 1 | -1;
  /** Sea level in metres above the default (negative lowers the sea and exposes more land). */
  readonly seaLevel: number;
  /** Circulation detail, 0 (off) to 3: how far land is allowed to steer the sea and the air. */
  readonly circulation: CirculationLevel;
}

export interface WorldFile {
  readonly format: typeof FILE_FORMAT;
  readonly version: number;
  readonly recipe: Recipe;
  readonly planet: PlanetSettings;
}

export const DEFAULT_PLANET: PlanetSettings = { tiltDegrees: 23, spin: 1, seaLevel: 0, circulation: 2 };

export function toWorldFile(recipe: Recipe, planet: PlanetSettings): WorldFile {
  return { format: FILE_FORMAT, version: FILE_VERSION, recipe, planet };
}

export function serializeWorld(file: WorldFile): string {
  return JSON.stringify(file);
}

const MODES = ['land', 'ocean', 'raise', 'lower'] as const;
const FALLOFFS: readonly Falloff[] = ['smooth', 'linear', 'flat'];

const isFinite_ = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

type Vec3 = readonly [number, number, number];

function parseUnit(v: unknown, what: string, fail: (why: string) => never): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isFinite_)) return fail(`${what} must be three numbers`);
  const [x, y, z] = v as [number, number, number];
  if (Math.abs(Math.hypot(x, y, z) - 1) > 0.05) return fail(`${what} must be a unit vector`);
  return [x, y, z];
}

function parseEdit(raw: unknown, index: number): Edit {
  const e = raw as Record<string, unknown> | null;
  const fail = (why: string): never => {
    throw new Error(`edit ${index}: ${why}`);
  };
  if (!e || typeof e !== 'object') return fail('not an object');
  if (!isFinite_(e.time)) return fail('time is not a number');
  if (e.kind === 'addPlate') {
    if (!isFinite_(e.radius) || e.radius <= 0 || e.radius > 2) return fail('radius out of range');
    if (!isFinite_(e.angularSpeed) || e.angularSpeed <= 0 || e.angularSpeed > 0.1) return fail('angularSpeed out of range');
    return { kind: 'addPlate', center: parseUnit(e.center, 'center', fail), radius: e.radius, axis: parseUnit(e.axis, 'axis', fail), angularSpeed: e.angularSpeed, time: e.time };
  }
  if (e.kind === 'removePlate') {
    if (e.mode !== 'reset' && e.mode !== 'keep') return fail(`unknown mode ${String(e.mode)}`);
    return { kind: 'removePlate', at: parseUnit(e.at, 'at', fail), mode: e.mode, time: e.time };
  }
  if (e.kind === 'erode') {
    if (!isFinite_(e.my) || e.my <= 0 || e.my > 200) return fail('my out of range');
    if (e.time < 0) return fail('time out of range');
    return { kind: 'erode', my: e.my, time: e.time };
  }
  if (e.kind === 'splitPlate') return { kind: 'splitPlate', at: parseUnit(e.at, 'at', fail), time: e.time };
  if (e.kind === 'generate') {
    const styles = ['continents', 'pangaea', 'two', 'archipelago'] as const;
    if (!styles.includes(e.style as (typeof styles)[number])) return fail(`unknown style ${String(e.style)}`);
    if (!isFinite_(e.landFraction) || e.landFraction < 0.02 || e.landFraction > 0.8) return fail('landFraction out of range');
    if (typeof e.seed !== 'string' || e.seed.length > 200) return fail('seed must be text');
    return { kind: 'generate', style: e.style as (typeof styles)[number], landFraction: e.landFraction, seed: e.seed, time: e.time };
  }
  if (e.kind === 'paintPlate') {
    if (!isFinite_(e.radius) || e.radius <= 0 || e.radius > 2) return fail('radius out of range');
    if (!Array.isArray(e.dabs) || e.dabs.length % 3 !== 0 || !e.dabs.every(isFinite_)) return fail('dabs must be a list of x, y, z numbers');
    return { kind: 'paintPlate', from: parseUnit(e.from, 'from', fail), radius: e.radius, dabs: e.dabs as number[], time: e.time };
  }
  if (e.kind === 'dragPlate') return { kind: 'dragPlate', from: parseUnit(e.from, 'from', fail), to: parseUnit(e.to, 'to', fail), time: e.time };
  if (e.kind !== 'brush') return fail(`unknown kind ${String(e.kind)}`);
  if (!MODES.includes(e.mode as (typeof MODES)[number])) return fail(`unknown mode ${String(e.mode)}`);
  if (!FALLOFFS.includes(e.falloff as Falloff)) return fail(`unknown falloff ${String(e.falloff)}`);
  if (!isFinite_(e.radius) || e.radius <= 0 || e.radius > 2) return fail('radius out of range');
  if (!isFinite_(e.strength)) return fail('strength is not a number');
  if (!isFinite_(e.time)) return fail('time is not a number');
  if (!Array.isArray(e.dabs) || e.dabs.length % 3 !== 0 || !e.dabs.every(isFinite_)) return fail('dabs must be a list of x, y, z numbers');
  return {
    kind: 'brush',
    mode: e.mode as (typeof MODES)[number],
    falloff: e.falloff as Falloff,
    radius: e.radius,
    strength: e.strength,
    dabs: e.dabs as number[],
    time: e.time,
  };
}

/** Parse and validate a saved world. Throws an Error with a plain-language reason. */
export function parseWorld(text: string): WorldFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This is not valid JSON.');
  }
  const f = raw as Record<string, unknown> | null;
  if (!f || typeof f !== 'object' || f.format !== FILE_FORMAT) throw new Error('This is not a world-generator file.');
  if (!isFinite_(f.version) || f.version > FILE_VERSION) throw new Error(`This file is from a newer version (${String(f.version)}).`);

  const r = f.recipe as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') throw new Error('The file has no recipe.');
  if (typeof r.seed !== 'string') throw new Error('The recipe has no seed.');
  if (!isFinite_(r.frequency) || !Number.isInteger(r.frequency) || r.frequency < 1 || r.frequency > 400) throw new Error('The recipe has an invalid detail level.');
  if (!isFinite_(r.simVersion) || r.simVersion > SIM_VERSION) throw new Error(`The recipe needs a newer simulation (version ${String(r.simVersion)}).`);
  if (!Array.isArray(r.edits)) throw new Error('The recipe has no edit list.');
  const edits = r.edits.map(parseEdit);

  const p = f.planet as Record<string, unknown> | null;
  const planet: PlanetSettings =
    p && isFinite_(p.tiltDegrees) && (p.spin === 1 || p.spin === -1) && p.tiltDegrees >= 0 && p.tiltDegrees <= 90
      ? { tiltDegrees: p.tiltDegrees, spin: p.spin, seaLevel: isFinite_(p.seaLevel) && p.seaLevel >= -3000 && p.seaLevel <= 6000 ? p.seaLevel : 0, circulation: isFinite_(p.circulation) && Number.isInteger(p.circulation) && p.circulation >= 0 && p.circulation <= 5 ? (p.circulation as CirculationLevel) : DEFAULT_PLANET.circulation }
      : DEFAULT_PLANET;

  return { format: FILE_FORMAT, version: FILE_VERSION, recipe: { seed: r.seed, simVersion: r.simVersion, frequency: r.frequency, edits }, planet };
}

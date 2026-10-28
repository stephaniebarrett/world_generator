import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIMATE, computeClimate } from './climate';
import { buildLattice } from './lattice';

const lattice = buildLattice(40); // 16,002 points
const N = lattice.vertexCount;
const z = (v: number) => lattice.positions[v * 3 + 2]!;
const lon = (v: number) => (Math.atan2(lattice.positions[v * 3 + 1]!, lattice.positions[v * 3]!) * 180) / Math.PI;

const flat = (e: number) => new Float64Array(N).fill(e);
const mean = (arr: ArrayLike<number>, pick: (v: number) => boolean) => {
  let s = 0, c = 0;
  for (let v = 0; v < N; v++) if (pick(v)) { s += arr[v]!; c++; }
  return s / c;
};

describe('climate', () => {
  const ocean = computeClimate(lattice, flat(-3000));

  it('is warm at the equator and cold at the poles', () => {
    const eq = mean(ocean.meanTemperature, (v) => Math.abs(z(v)) < 0.1);
    const pole = mean(ocean.meanTemperature, (v) => Math.abs(z(v)) > 0.9);
    expect(eq).toBeGreaterThan(22);
    expect(pole).toBeLessThan(-5);
  });

  it('puts the wet belt at the equator, deserts in the subtropics, and rain again in mid-latitudes', () => {
    const band = (lo: number, hi: number) => mean(ocean.meanPrecipitation, (v) => Math.abs(z(v)) >= lo && Math.abs(z(v)) < hi);
    const equator = band(0, 0.12);
    const subtropics = band(0.4, 0.55);
    const midLatitudes = band(0.72, 0.9);
    expect(equator).toBeGreaterThan(subtropics * 1.8);
    expect(midLatitudes).toBeGreaterThan(subtropics * 1.2);
  });

  it('has Earth-like rainfall by latitude over an ocean planet, at a different detail than it was fitted at', () => {
    // Rough zonal means for Earth's oceans (mm/yr) at 0, 10, ... 80 degrees.
    const target = [2800, 2000, 900, 500, 900, 1100, 800, 400, 150];
    for (let i = 0; i < target.length; i++) {
      const lat = i * 10;
      const lo = Math.max(0, Math.sin(((lat - 5) * Math.PI) / 180));
      const hi = Math.sin(((lat + 5) * Math.PI) / 180);
      const got = mean(ocean.meanPrecipitation, (v) => Math.abs(z(v)) >= lo && Math.abs(z(v)) < hi);
      // Within a factor of 2 either way, and the shape tests above pin the ordering. The polar band is
      // genuinely uncertain on Earth (about 50 mm/yr in Antarctica to 300 on Arctic coasts, because cold
      // air holds so little vapour), so it gets that whole range.
      const [lowBound, highBound] = lat >= 80 ? [50, 300] : [target[i]! / 2, target[i]! * 2];
      expect(got).toBeGreaterThan(lowBound);
      expect(got).toBeLessThan(highBound);
    }
  });

  it('rains less in the lee of a mountain range than on its windward side', () => {
    const e = flat(-3000);
    for (let v = 0; v < N; v++) {
      const inBlock = Math.abs(lon(v)) < 40 && z(v) > 0.5 && z(v) < 0.85;
      if (inBlock) e[v] = Math.abs(lon(v)) < 5 ? 5000 : 200;
    }
    const c = computeClimate(lattice, e);
    const windward = mean(c.meanPrecipitation, (v) => e[v]! > 0 && lon(v) < -10 && lon(v) > -30);
    const lee = mean(c.meanPrecipitation, (v) => e[v]! > 0 && lon(v) > 10 && lon(v) < 30);
    expect(windward).toBeGreaterThan(lee * 1.4);
  });

  it('has seasons that follow the axial tilt, and none without tilt', () => {
    const land = flat(100);
    const tilted = computeClimate(lattice, land);
    const north = (v: number) => z(v) > 0.5 && z(v) < 0.7;
    // Season 1 is northern summer, season 3 northern winter.
    expect(mean(tilted.temperature[1]!, north) - mean(tilted.temperature[3]!, north)).toBeGreaterThan(12);
    const upright = computeClimate(lattice, land, { ...DEFAULT_CLIMATE, axialTilt: 0 });
    expect(Math.abs(mean(upright.temperature[1]!, north) - mean(upright.temperature[3]!, north))).toBeLessThan(0.01);
  });

  it('is colder on high ground, about 6.5 C per km', () => {
    const low = computeClimate(lattice, flat(100)).meanTemperature;
    const high = computeClimate(lattice, flat(3100)).meanTemperature;
    expect(mean(low, () => true) - mean(high, () => true)).toBeCloseTo(19.5, 0);
  });

  it('blows trades from the east and westerlies from the west, and reverses with spin', () => {
    const u = (c: typeof ocean, lo: number, hi: number) => mean(c.windEast[0]!, (v) => Math.abs(z(v)) >= lo && Math.abs(z(v)) < hi);
    expect(u(ocean, 0.05, 0.35)).toBeLessThan(-0.5);
    expect(u(ocean, 0.6, 0.8)).toBeGreaterThan(0.5);
    const retro = computeClimate(lattice, flat(-3000), { ...DEFAULT_CLIMATE, spin: -1 });
    expect(u(retro, 0.6, 0.8)).toBeLessThan(-0.5);
  });

  it('is deterministic and finite', () => {
    const a = computeClimate(lattice, flat(-3000));
    const b = computeClimate(lattice, flat(-3000));
    expect(Array.from(a.meanPrecipitation)).toEqual(Array.from(b.meanPrecipitation));
    for (const x of a.meanPrecipitation) expect(Number.isFinite(x)).toBe(true);
    for (const x of a.meanTemperature) expect(Number.isFinite(x)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIMATE, computeClimate } from './climate';
import { buildLattice } from './lattice';

const lattice = buildLattice(40);
const N = lattice.vertexCount;
const lon = (v: number) => (Math.atan2(lattice.positions[v * 3 + 1]!, lattice.positions[v * 3]!) * 180) / Math.PI;
const lat = (v: number) => (Math.asin(lattice.positions[v * 3 + 2]!) * 180) / Math.PI;
const mean = (arr: ArrayLike<number>, pick: (v: number) => boolean) => {
  let s = 0, c = 0;
  for (let v = 0; v < N; v++) if (pick(v)) { s += arr[v]!; c++; }
  return s / c;
};

// One north-south continent from 60S to 60N, between 20 and 60 degrees east, in an otherwise open ocean.
const elevation = new Float64Array(N);
for (let v = 0; v < N; v++) elevation[v] = Math.abs(lat(v)) < 60 && lon(v) > 20 && lon(v) < 60 ? 500 : -3000;
const on = { ...DEFAULT_CLIMATE, circulation: 2 as const };

describe('circulation', () => {
  it('leaves the climate exactly as it was when off', () => {
    const plain = computeClimate(lattice, elevation, DEFAULT_CLIMATE);
    const off = computeClimate(lattice, elevation, { ...DEFAULT_CLIMATE, circulation: 0 });
    expect(Array.from(off.meanPrecipitation)).toEqual(Array.from(plain.meanPrecipitation));
    expect(Array.from(plain.currentEast).every((x) => x === 0)).toBe(true);
  });

  it('is deterministic and finite', () => {
    const a = computeClimate(lattice, elevation, on);
    const b = computeClimate(lattice, elevation, on);
    expect(Array.from(a.meanTemperature)).toEqual(Array.from(b.meanTemperature));
    for (const f of [a.meanTemperature, a.meanPrecipitation, a.currentEast, a.currentNorth, a.meanWindEast, a.meanWindNorth]) expect(f.every(Number.isFinite)).toBe(true);
  });

  it('drives currents only in the sea, and none runs into the coast', () => {
    const c = computeClimate(lattice, elevation, on);
    let fastest = 0;
    for (let v = 0; v < N; v++) {
      const speed = Math.hypot(c.currentEast[v]!, c.currentNorth[v]!);
      if (elevation[v]! > 0) expect(speed).toBe(0);
      fastest = Math.max(fastest, speed);
    }
    expect(fastest).toBeGreaterThan(0.1);
    expect(fastest).toBeLessThan(2);
  });

  it('keeps the water calm in a bay and turns the gyres the right way round', () => {
    // The same continent with an inlet cut into its west coast.
    const bay = Float64Array.from(elevation);
    const inlet = (v: number) => bay[v]! > 0 && lat(v) > 5 && lat(v) < 15 && lon(v) < 45;
    for (let v = 0; v < N; v++) if (inlet(v)) bay[v] = -3000;
    const c = computeClimate(lattice, bay, on);
    const speed = (v: number) => Math.hypot(c.currentEast[v]!, c.currentNorth[v]!);
    const inBay = (v: number) => bay[v]! < 0 && lat(v) > 5 && lat(v) < 15 && lon(v) > 25 && lon(v) < 45;
    const open = (v: number) => bay[v]! < 0 && Math.abs(lat(v)) < 60 && (lon(v) < 0 || lon(v) > 80);
    expect(mean(c.currentEast, inBay) ** 2 + mean(c.currentNorth, inBay) ** 2).toBeLessThan(0.05);
    expect(mean(Float64Array.from({ length: N }, (_, v) => speed(v)), inBay)).toBeLessThan(0.3 * mean(Float64Array.from({ length: N }, (_, v) => speed(v)), open));
    // Subtropical gyre in the north: westward in the tropics, eastward in mid-latitudes, poleward along the western side of the basin.
    const sea = (lo: number, hi: number, a: number, b: number) => (v: number) => bay[v]! < 0 && lat(v) > lo && lat(v) < hi && lon(v) > a && lon(v) < b;
    expect(mean(c.currentEast, sea(5, 25, 100, 170))).toBeLessThan(-0.1);
    expect(mean(c.currentEast, sea(35, 55, 100, 170))).toBeGreaterThan(0.1);
    expect(mean(c.currentNorth, sea(30, 50, 60, 70))).toBeGreaterThan(0.1);
  });

  it('carries warm water poleward along a western coast, so the sea there is warmer than the same latitude with no land', () => {
    const open = computeClimate(lattice, new Float64Array(N).fill(-3000), on);
    const land = computeClimate(lattice, elevation, on);
    // Sea just off the continent's two coasts, in the mid-latitudes of the north: currents make one side differ from the open sea.
    const west = (v: number) => lat(v) > 25 && lat(v) < 50 && lon(v) > 0 && lon(v) < 20;
    const east = (v: number) => lat(v) > 25 && lat(v) < 50 && lon(v) > 60 && lon(v) < 80;
    const diff = Math.abs(mean(land.meanTemperature, west) - mean(open.meanTemperature, west)) + Math.abs(mean(land.meanTemperature, east) - mean(open.meanTemperature, east));
    expect(diff).toBeGreaterThan(0.3);
  });
});

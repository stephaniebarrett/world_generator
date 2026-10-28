import { describe, expect, it } from 'vitest';
import { cellKm } from './climate';
import { buildLattice } from './lattice';
import { computeWater, runoffFraction } from './water';

const lattice = buildLattice(24);
const N = lattice.vertexCount;
const z = (v: number) => lattice.positions[v * 3 + 2]!;

/** A dome of land over the north pole that falls to the sea; a gentle cone with no depressions. */
function cone(): Float64Array {
  const e = new Float64Array(N).fill(-3000);
  for (let v = 0; v < N; v++) if (z(v) > 0.6) e[v] = (z(v) - 0.6) * 5000 + 10;
  return e;
}
const wet = (p: number) => new Float64Array(N).fill(p);

describe('water', () => {
  it('sends every land vertex to the sea along a path that always goes down or stays level', () => {
    const e = cone();
    const w = computeWater(lattice, e, wet(1500));
    for (let v = 0; v < N; v++) {
      if (e[v]! <= 0) continue;
      let at = v;
      let hops = 0;
      while (e[at]! > 0) {
        const next = w.flowTo[at]!;
        expect(next).toBeGreaterThanOrEqual(0);
        at = next;
        expect(++hops).toBeLessThan(N);
      }
    }
  });

  it('delivers all the runoff to the sea: nothing is lost or invented', () => {
    const e = cone();
    const w = computeWater(lattice, e, wet(1500));
    const landCells = [...e].filter((x) => x > 0).length;
    // Every land cell makes the same runoff: depth x area, as cubic metres per second.
    const perCell = (1500 * runoffFraction(1500) * 0.866 * cellKm(lattice) ** 2 * 1000) / (365.25 * 24 * 3600);
    let arriving = 0;
    for (let v = 0; v < N; v++) if (e[v]! <= 0) arriving += w.discharge[v]!;
    expect(arriving / (landCells * perCell)).toBeCloseTo(1, 4);
  });

  it('grows rivers downstream: discharge never falls along a flow path', () => {
    const e = cone();
    const w = computeWater(lattice, e, wet(1500));
    for (let v = 0; v < N; v++) {
      const to = w.flowTo[v]!;
      if (e[v]! > 0 && to >= 0) expect(w.discharge[to]!).toBeGreaterThanOrEqual(w.discharge[v]! - 1e-6);
    }
    // The biggest river is much bigger than a headwater.
    const land = [...e.keys()].filter((v) => e[v]! > 0);
    expect(Math.max(...land.map((v) => w.discharge[v]!))).toBeGreaterThan(5 * Math.min(...land.map((v) => w.discharge[v]!)));
  });

  it('puts a lake in a depression and spills it over the lowest rim', () => {
    const e = cone();
    // Dig a pit in the middle of the slope: an unlucky vertex ringed by higher ground.
    let pit = -1;
    for (let v = 0; v < N; v++) if (z(v) > 0.75 && z(v) < 0.8) { pit = v; break; }
    const rim = [...e];
    rim[pit] = e[pit]! - 400;
    const w = computeWater(lattice, Float64Array.from(rim), wet(1500));
    expect(w.lake[pit]).toBe(1);
    // It still drains to the sea.
    let at = pit;
    let hops = 0;
    while (rim[at]! > 0 && hops++ < N) at = w.flowTo[at]!;
    expect(rim[at]!).toBeLessThanOrEqual(0);
    // Without the pit there is no lake there.
    expect(computeWater(lattice, e, wet(1500)).lake[pit]).toBe(0);
  });

  it('makes no rivers in a desert and some in the wet', () => {
    const e = cone();
    const dry = computeWater(lattice, e, wet(100));
    expect(Math.max(...dry.discharge)).toBe(0);
    expect(Math.max(...computeWater(lattice, e, wet(1500)).discharge)).toBeGreaterThan(0);
    expect(runoffFraction(100)).toBe(0);
    expect(runoffFraction(5000)).toBe(0.5);
  });

  it('drains a world with no sea toward its lowest point', () => {
    const e = new Float64Array(N);
    for (let v = 0; v < N; v++) e[v] = 1000 + z(v) * 500; // all land, nothing below sea level
    const w = computeWater(lattice, e, wet(1000));
    expect(w.flowTo.filter((x) => x < 0).length).toBe(1);
  });

  it('is deterministic', () => {
    const a = computeWater(lattice, cone(), wet(1200));
    const b = computeWater(lattice, cone(), wet(1200));
    expect(Array.from(a.flowTo)).toEqual(Array.from(b.flowTo));
    expect(Array.from(a.discharge)).toEqual(Array.from(b.discharge));
  });
});

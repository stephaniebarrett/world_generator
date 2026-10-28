import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { buildLattice, vertexCountFor } from './lattice';

describe('rng', () => {
  it('repeats exactly for the same seed', () => {
    const a = createRng('world-1');
    const b = createRng('world-1');
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('differs between seeds', () => {
    expect(createRng('a').next()).not.toBe(createRng('b').next());
  });

  it('forks are stable and independent of draws on the parent', () => {
    const p1 = createRng('s');
    p1.next();
    p1.next();
    const p2 = createRng('s');
    expect(p1.fork('plates').next()).toBe(p2.fork('plates').next());
  });

  it('stays in range', () => {
    const r = createRng('range');
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(r.int(7)).toBeLessThan(7);
    }
  });

  it('has a pinned first output so accidental changes are caught', () => {
    // If this fails the algorithm changed: bump the sim version.
    expect(createRng('pin').next()).toMatchInlineSnapshot(`0.7834718669764698`);
  });
});

describe('lattice', () => {
  for (const n of [1, 2, 5, 12]) {
    it(`frequency ${n} has the expected counts`, () => {
      const l = buildLattice(n);
      expect(l.vertexCount).toBe(vertexCountFor(n));
      expect(l.triangles.length).toBe(20 * n * n * 3);
    });
  }

  it('puts every vertex on the unit sphere', () => {
    const l = buildLattice(8);
    for (let v = 0; v < l.vertexCount; v++) {
      const x = l.positions[v * 3]!;
      const y = l.positions[v * 3 + 1]!;
      const z = l.positions[v * 3 + 2]!;
      expect(Math.abs(Math.sqrt(x * x + y * y + z * z) - 1)).toBeLessThan(1e-12);
    }
  });

  it('has 12 five-neighbour vertices and the rest six', () => {
    const l = buildLattice(6);
    let five = 0;
    for (let v = 0; v < l.vertexCount; v++) {
      const deg = l.offsets[v + 1]! - l.offsets[v]!;
      if (deg === 5) five++;
      else expect(deg).toBe(6);
    }
    expect(five).toBe(12);
  });

  it('winds all triangles outward', () => {
    const l = buildLattice(4);
    for (let t = 0; t < l.triangles.length; t += 3) {
      const [a, b, c] = [l.triangles[t]!, l.triangles[t + 1]!, l.triangles[t + 2]!];
      const p = (i: number) => [l.positions[i * 3]!, l.positions[i * 3 + 1]!, l.positions[i * 3 + 2]!] as const;
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
      const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
      const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      expect(nx * pa[0] + ny * pa[1] + nz * pa[2]).toBeGreaterThan(0);
    }
  });

  it('is identical when built twice', () => {
    const a = buildLattice(10);
    const b = buildLattice(10);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.triangles)).toEqual(Array.from(b.triangles));
  });
});

import { describe, expect, it } from 'vitest';
import { buildLattice } from '../sim/lattice';
import { LatticeIndex, renderProjection } from './render';
import { PROJECTIONS, orthographic } from './projections';

const lattice = buildLattice(12);
// Colour encodes position: red = x, green = y, blue = z, each mapped from [-1, 1] to [0, 1].
const colors = new Float32Array(lattice.vertexCount * 3);
for (let v = 0; v < lattice.vertexCount; v++) for (let k = 0; k < 3; k++) colors[v * 3 + k] = (lattice.positions[v * 3 + k]! + 1) / 2;

describe('LatticeIndex', () => {
  it('finds exactly the nearest vertex, as brute force does', () => {
    const index = new LatticeIndex(lattice);
    const dirs = [[1, 0, 0], [0, 1, 0], [0, 0, -1], [0.3, -0.5, 0.81], [-0.7, 0.1, 0.7]];
    for (const d of dirs) {
      const len = Math.hypot(...d);
      const [x, y, z] = d.map((c) => c! / len) as [number, number, number];
      let best = 0;
      let bestD = Infinity;
      for (let v = 0; v < lattice.vertexCount; v++) {
        const dd = (lattice.positions[v * 3]! - x) ** 2 + (lattice.positions[v * 3 + 1]! - y) ** 2 + (lattice.positions[v * 3 + 2]! - z) ** 2;
        if (dd < bestD) { bestD = dd; best = v; }
      }
      expect(index.nearest(x, y, z)).toBe(best);
    }
  });
});

describe('renderProjection', () => {
  const px = (img: ReturnType<typeof renderProjection>, i: number, j: number) => {
    const o = (j * img.width + i) * 4;
    return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!, img.data[o + 3]!];
  };

  it('draws the equirectangular map with north up and east to the right', () => {
    const img = renderProjection(lattice, colors, PROJECTIONS[0]!, 128);
    expect(img.height).toBe(64);
    const [, , blueTop] = px(img, 64, 0);
    const [, , blueBottom] = px(img, 64, 63);
    expect(blueTop).toBeGreaterThan(200); // north pole: z = +1
    expect(blueBottom).toBeLessThan(55);
    const [redCentre] = px(img, 64, 32);
    expect(redCentre).toBeGreaterThan(200); // lon 0, lat 0 is (1, 0, 0)
    const [, greenRight] = px(img, 96, 32); // 90 degrees east: (0, 1, 0)
    expect(greenRight).toBeGreaterThan(200);
    // Every pixel of a full-world map is filled.
    for (let k = 3; k < img.data.length; k += 4) expect(img.data[k]).toBe(255);
  });

  it('leaves the corners of the globe view transparent', () => {
    const img = renderProjection(lattice, colors, orthographic({ lat: 0, lon: 0 }), 64);
    expect(px(img, 0, 0)[3]).toBe(0);
    expect(px(img, 63, 63)[3]).toBe(0);
    expect(px(img, 32, 32)[3]).toBe(255);
  });

  it('fills the pole of each polar view with that pole colour', () => {
    const north = renderProjection(lattice, colors, PROJECTIONS.find((p) => p.key === 'polar-north')!, 64);
    const south = renderProjection(lattice, colors, PROJECTIONS.find((p) => p.key === 'polar-south')!, 64);
    expect(px(north, 32, 32)[2]).toBeGreaterThan(200);
    expect(px(south, 32, 32)[2]).toBeLessThan(55);
  });

  it('renders every projection without leaving holes inside the map', () => {
    for (const p of PROJECTIONS) {
      const img = renderProjection(lattice, colors, p, 96);
      let filled = 0;
      for (let k = 3; k < img.data.length; k += 4) if (img.data[k] === 255) filled++;
      expect(filled).toBeGreaterThan(img.width * img.height * 0.3);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { buildLattice } from '../sim/lattice';
import { buildCellBorders, buildCellMesh } from './cells';

describe('cell mesh', () => {
  const lattice = buildLattice(6);
  const mesh = buildCellMesh(lattice);

  it('has one cell per lattice point, 12 pentagons and the rest hexagons', () => {
    expect(mesh.cellCount).toBe(lattice.vertexCount);
    let pentagons = 0;
    for (let c = 0; c < mesh.cellCount; c++) {
      const n = mesh.offsets[c + 1]! - mesh.offsets[c]!;
      if (n === 5) pentagons++;
      else expect(n).toBe(6);
    }
    expect(pentagons).toBe(12);
  });

  it('lists corners counter-clockwise seen from outside', () => {
    const { corners, offsets, cornerIds } = mesh;
    for (let c = 0; c < mesh.cellCount; c++) {
      const cx = lattice.positions[c * 3]!;
      const cy = lattice.positions[c * 3 + 1]!;
      const cz = lattice.positions[c * 3 + 2]!;
      const n = offsets[c + 1]! - offsets[c]!;
      for (let i = 0; i < n; i++) {
        const p = cornerIds[offsets[c]! + i]!;
        const q = cornerIds[offsets[c]! + ((i + 1) % n)]!;
        // (p - centre) x (q - centre) should point away from the globe's centre.
        const ax = corners[p * 3]! - cx, ay = corners[p * 3 + 1]! - cy, az = corners[p * 3 + 2]! - cz;
        const bx = corners[q * 3]! - cx, by = corners[q * 3 + 1]! - cy, bz = corners[q * 3 + 2]! - cz;
        const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        expect(nx * cx + ny * cy + nz * cz).toBeGreaterThan(0);
      }
    }
  });

  it('uses every corner exactly three times (each corner touches three cells)', () => {
    const uses = new Uint8Array(mesh.corners.length / 3);
    for (const id of mesh.cornerIds) uses[id]!++;
    expect(uses.every((u) => u === 3)).toBe(true);
  });

  it('finds every border between neighbouring cells, with its two end corners belonging to both cells', () => {
    const borders = buildCellBorders(lattice);
    // A triangulated sphere has 3V - 6 edges.
    expect(borders.count).toBe(3 * lattice.vertexCount - 6);
    const inCell = (cell: number, corner: number) => {
      for (let k = mesh.offsets[cell]!; k < mesh.offsets[cell + 1]!; k++) if (mesh.cornerIds[k] === corner) return true;
      return false;
    };
    const uses = new Uint8Array(mesh.corners.length / 3);
    for (let e = 0; e < borders.count; e++) {
      expect(borders.cornerA[e]).not.toBe(borders.cornerB[e]);
      for (const c of [borders.cornerA[e]!, borders.cornerB[e]!]) {
        expect(inCell(borders.a[e]!, c)).toBe(true);
        expect(inCell(borders.b[e]!, c)).toBe(true);
        uses[c]!++;
      }
    }
    // Each corner is the end of exactly three borders.
    expect(uses.every((u) => u === 3)).toBe(true);
  });
});

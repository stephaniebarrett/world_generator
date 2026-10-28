// Dual of the lattice: one hex (or pentagon) cell per lattice point, whose
// corners are the normalised centres of the triangles around that point.
// Render-only; the simulation reads and writes the lattice points directly.

import type { Lattice } from '../sim/lattice';

export interface CellMesh {
  /** Cell count, equal to the lattice vertex count. */
  readonly cellCount: number;
  /** Unit-sphere corner positions, one per lattice triangle, xyz interleaved. */
  readonly corners: Float64Array;
  /** CSR: corner (triangle) ids of cell c are cornerIds[offsets[c] .. offsets[c+1]), counter-clockwise from outside. */
  readonly offsets: Uint32Array;
  readonly cornerIds: Uint32Array;
}

export function buildCellMesh(lattice: Lattice): CellMesh {
  const { positions, triangles, vertexCount } = lattice;
  const triCount = triangles.length / 3;

  // Corner per triangle: centroid pushed out to the sphere.
  const corners = new Float64Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = triangles[t * 3]!;
    const b = triangles[t * 3 + 1]!;
    const c = triangles[t * 3 + 2]!;
    const x = positions[a * 3]! + positions[b * 3]! + positions[c * 3]!;
    const y = positions[a * 3 + 1]! + positions[b * 3 + 1]! + positions[c * 3 + 1]!;
    const z = positions[a * 3 + 2]! + positions[b * 3 + 2]! + positions[c * 3 + 2]!;
    const len = Math.sqrt(x * x + y * y + z * z);
    corners[t * 3] = x / len;
    corners[t * 3 + 1] = y / len;
    corners[t * 3 + 2] = z / len;
  }

  // Triangle that owns each directed edge (from -> to). Winding is consistent,
  // so every directed edge belongs to exactly one triangle. Ordering corners by
  // walking these edges avoids angle maths, so it is exact and engine-independent.
  const owner = new Map<number, number>();
  const key = (from: number, to: number) => from * vertexCount + to;
  const firstTri = new Int32Array(vertexCount).fill(-1);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const from = triangles[t * 3 + k]!;
      const to = triangles[t * 3 + ((k + 1) % 3)]!;
      owner.set(key(from, to), t);
      if (firstTri[from]! < 0) firstTri[from] = t;
    }
  }

  const offsets = new Uint32Array(vertexCount + 1);
  const ids: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    const start = firstTri[v]!;
    let t = start;
    do {
      ids.push(t);
      // In triangle t, rotate so v is first: (v, a, b). The next triangle
      // counter-clockwise around v owns the directed edge v -> b.
      const base = t * 3;
      let k = 0;
      while (triangles[base + k] !== v) k++;
      const b = triangles[base + ((k + 2) % 3)]!;
      t = owner.get(key(v, b))!;
    } while (t !== start);
    offsets[v + 1] = ids.length;
  }

  return { cellCount: vertexCount, corners, offsets, cornerIds: Uint32Array.from(ids) };
}

/** For every pair of neighbouring cells, the two corners at the ends of the edge they share. */
export interface CellBorders {
  readonly count: number;
  /** The two lattice points (cells) either side of the edge. */
  readonly a: Int32Array;
  readonly b: Int32Array;
  /** The corner ids (triangle ids) at the two ends of the shared edge. */
  readonly cornerA: Int32Array;
  readonly cornerB: Int32Array;
}

export function buildCellBorders(lattice: Lattice): CellBorders {
  const { triangles, vertexCount } = lattice;
  const triCount = triangles.length / 3;
  const first = new Map<number, number>();
  const a: number[] = [], b: number[] = [], ca: number[] = [], cb: number[] = [];
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const p = triangles[t * 3 + k]!;
      const q = triangles[t * 3 + ((k + 1) % 3)]!;
      const key = Math.min(p, q) * vertexCount + Math.max(p, q);
      const other = first.get(key);
      if (other === undefined) {
        first.set(key, t);
      } else {
        // The second triangle on this edge: the cells at its two ends are separated by the line between the two corners.
        a.push(Math.min(p, q));
        b.push(Math.max(p, q));
        ca.push(other);
        cb.push(t);
      }
    }
  }
  return { count: a.length, a: Int32Array.from(a), b: Int32Array.from(b), cornerA: Int32Array.from(ca), cornerB: Int32Array.from(cb) };
}

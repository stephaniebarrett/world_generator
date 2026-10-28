// Subdivided icosahedron: the shared point lattice for the simulation
// (crust sample points) and, later, the dual view mesh.
//
// Determinism: positions use only + - * / and sqrt (all correctly rounded in
// IEEE 754), and vertices are deduplicated with exact integer keys, never by
// comparing floats.

export interface Lattice {
  /** Subdivision frequency n. Vertex count is 10 n^2 + 2. */
  readonly frequency: number;
  /** Unit-sphere positions, xyz interleaved. */
  readonly positions: Float64Array;
  /** Triangle vertex indices, 3 per triangle, outward-facing winding. */
  readonly triangles: Uint32Array;
  /** CSR adjacency: neighbours of vertex v are neighbors[offsets[v] .. offsets[v+1]). */
  readonly offsets: Uint32Array;
  readonly neighbors: Uint32Array;
  readonly vertexCount: number;
}

/** Detail presets, in approximate sample points (10 n^2 + 2). */
export const DETAIL_PRESETS = {
  draft: 32, // 10,242 points
  default: 63, // 39,692 points
  detailed: 126, // 158,762 points
  fine: 180, // 324,002 points
  ultra: 240, // 576,002 points
} as const;

export type DetailPreset = keyof typeof DETAIL_PRESETS;

export function vertexCountFor(frequency: number): number {
  return 10 * frequency * frequency + 2;
}

const ICO_FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

function baseIcosahedron(): Float64Array {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ] as const;
  const out = new Float64Array(raw.length * 3);
  raw.forEach(([x, y, z], i) => {
    const len = Math.sqrt(x * x + y * y + z * z);
    out[i * 3] = x / len;
    out[i * 3 + 1] = y / len;
    out[i * 3 + 2] = z / len;
  });
  return out;
}

const latticeCache = new Map<number, Lattice>();

/** A lattice is never modified after it is built, so recent ones are kept: a run asks for its lattice at every keyframe. */
export function buildLattice(frequency: number): Lattice {
  const known = latticeCache.get(frequency);
  if (known) return known;
  const lattice = makeLattice(frequency);
  if (latticeCache.size >= 3) latticeCache.delete(latticeCache.keys().next().value!);
  latticeCache.set(frequency, lattice);
  return lattice;
}

function makeLattice(frequency: number): Lattice {
  if (!Number.isInteger(frequency) || frequency < 1) {
    throw new Error(`lattice frequency must be a positive integer, got ${frequency}`);
  }
  const n = frequency;
  const base = baseIcosahedron();

  const positions = new Float64Array(vertexCountFor(n) * 3);
  const triangles = new Uint32Array(20 * n * n * 3);
  const index = new Map<string, number>();
  let vertexCount = 0;
  let triCount = 0;

  // A point on a face is (wa, wb, wc) integer weights summing to n over the
  // face's three corner vertices. Its key lists only non-zero weights, sorted
  // by corner vertex id, so points shared by neighbouring faces (edges and
  // corners) get the same key from both sides.
  const vertexAt = (face: readonly [number, number, number], wa: number, wb: number, wc: number): number => {
    const parts: Array<[number, number]> = [];
    if (wa > 0) parts.push([face[0], wa]);
    if (wb > 0) parts.push([face[1], wb]);
    if (wc > 0) parts.push([face[2], wc]);
    parts.sort((p, q) => p[0] - q[0]);
    const key = parts.map(([v, w]) => `${v}:${w}`).join(',');

    const existing = index.get(key);
    if (existing !== undefined) return existing;

    let x = 0;
    let y = 0;
    let z = 0;
    for (const [v, w] of parts) {
      x += base[v * 3]! * w;
      y += base[v * 3 + 1]! * w;
      z += base[v * 3 + 2]! * w;
    }
    const len = Math.sqrt(x * x + y * y + z * z);
    const id = vertexCount++;
    positions[id * 3] = x / len;
    positions[id * 3 + 1] = y / len;
    positions[id * 3 + 2] = z / len;
    index.set(key, id);
    return id;
  };

  for (const face of ICO_FACES) {
    // Grid point (i, j): i steps toward corner b, j toward corner c.
    const at = (i: number, j: number) => vertexAt(face, n - i - j, i, j);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        const p = at(i, j);
        const q = at(i + 1, j);
        const r = at(i, j + 1);
        triangles[triCount++] = p;
        triangles[triCount++] = q;
        triangles[triCount++] = r;
        if (i + j < n - 1) {
          const s = at(i + 1, j + 1);
          triangles[triCount++] = q;
          triangles[triCount++] = s;
          triangles[triCount++] = r;
        }
      }
    }
  }

  // CSR adjacency from triangle edges.
  const sets: Array<Set<number>> = Array.from({ length: vertexCount }, () => new Set());
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t]!;
    const b = triangles[t + 1]!;
    const c = triangles[t + 2]!;
    sets[a]!.add(b).add(c);
    sets[b]!.add(a).add(c);
    sets[c]!.add(a).add(b);
  }
  const offsets = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] = offsets[v]! + sets[v]!.size;
  const neighbors = new Uint32Array(offsets[vertexCount]!);
  for (let v = 0; v < vertexCount; v++) {
    // Sorted so iteration order never depends on insertion order.
    const sorted = [...sets[v]!].sort((p, q) => p - q);
    neighbors.set(sorted, offsets[v]!);
  }

  return { frequency: n, positions, triangles, offsets, neighbors, vertexCount };
}

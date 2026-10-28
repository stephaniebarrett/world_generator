import * as THREE from 'three';
import type { Lattice } from '../sim/lattice';
import type { CellMesh } from './cells';

/** Triangle fan per cell (centre + corners), corners duplicated per cell so each cell takes one flat colour. */
export function buildCellGeometry(lattice: Lattice, cells: CellMesh, cellColors: Float32Array, radius = 1): THREE.BufferGeometry {
  const { offsets, cornerIds, corners } = cells;
  const vertTotal = cells.cellCount + cornerIds.length;
  const pos = new Float32Array(vertTotal * 3);
  const col = new Float32Array(vertTotal * 3);
  const index = new Uint32Array(cornerIds.length * 3);

  let vi = 0;
  let ii = 0;
  for (let c = 0; c < cells.cellCount; c++) {
    const r = cellColors[c * 3]!, g = cellColors[c * 3 + 1]!, b = cellColors[c * 3 + 2]!;
    const centre = vi++;
    pos[centre * 3] = lattice.positions[c * 3]! * radius;
    pos[centre * 3 + 1] = lattice.positions[c * 3 + 1]! * radius;
    pos[centre * 3 + 2] = lattice.positions[c * 3 + 2]! * radius;
    col.set([r, g, b], centre * 3);

    const start = offsets[c]!;
    const n = offsets[c + 1]! - start;
    const first = vi;
    for (let k = 0; k < n; k++) {
      const id = cornerIds[start + k]!;
      pos[vi * 3] = corners[id * 3]! * radius;
      pos[vi * 3 + 1] = corners[id * 3 + 1]! * radius;
      pos[vi * 3 + 2] = corners[id * 3 + 2]! * radius;
      col.set([r, g, b], vi * 3);
      vi++;
    }
    for (let k = 0; k < n; k++) {
      index[ii++] = centre;
      index[ii++] = first + k;
      index[ii++] = first + ((k + 1) % n);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/** Rewrite per-cell colours in place (same fan layout as buildCellGeometry). */
export function updateCellColors(geometry: THREE.BufferGeometry, cells: CellMesh, cellColors: Float32Array): void {
  const attr = geometry.getAttribute('color') as THREE.BufferAttribute;
  const col = attr.array as Float32Array;
  let vi = 0;
  for (let c = 0; c < cells.cellCount; c++) {
    const r = cellColors[c * 3]!, g = cellColors[c * 3 + 1]!, b = cellColors[c * 3 + 2]!;
    const count = 1 + (cells.offsets[c + 1]! - cells.offsets[c]!);
    for (let k = 0; k < count; k++, vi++) {
      col[vi * 3] = r;
      col[vi * 3 + 1] = g;
      col[vi * 3 + 2] = b;
    }
  }
  attr.needsUpdate = true;
}

// --- relief: lifting the cells by elevation ---------------------------------------------

const EARTH_RADIUS_M = 6371000;
/** The sea floor is shown less dramatically than land, so basins show without the globe looking dented. */
const SEA_FLOOR_SCALE = 0.3;

/** Distance from the globe's centre for a given elevation, with height exaggerated by `exaggeration` times. */
export function surfaceRadius(elevationM: number, exaggeration: number): number {
  const k = exaggeration / EARTH_RADIUS_M;
  return 1 + (elevationM > 0 ? elevationM * k : elevationM * k * SEA_FLOOR_SCALE);
}

/**
 * Move every cell to its elevation. Each corner takes the mean of the three cells that meet there, and
 * neighbouring cells share their corners, so the surface has no cracks.
 */
export function updateCellHeights(
  geometry: THREE.BufferGeometry, lattice: Lattice, cells: CellMesh, elevationM: ArrayLike<number>, exaggeration: number, withNormals: boolean,
): Float64Array {
  const { triangles } = lattice;
  const cornerRadius = new Float64Array(cells.corners.length / 3);
  for (let t = 0; t < cornerRadius.length; t++) {
    const mean = (elevationM[triangles[t * 3]!]! + elevationM[triangles[t * 3 + 1]!]! + elevationM[triangles[t * 3 + 2]!]!) / 3;
    cornerRadius[t] = surfaceRadius(mean, exaggeration);
  }
  const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const pos = attr.array as Float32Array;
  let vi = 0;
  for (let c = 0; c < cells.cellCount; c++) {
    const r = surfaceRadius(elevationM[c]!, exaggeration);
    pos[vi * 3] = lattice.positions[c * 3]! * r;
    pos[vi * 3 + 1] = lattice.positions[c * 3 + 1]! * r;
    pos[vi * 3 + 2] = lattice.positions[c * 3 + 2]! * r;
    vi++;
    for (let k = cells.offsets[c]!; k < cells.offsets[c + 1]!; k++, vi++) {
      const id = cells.cornerIds[k]!;
      const cr = cornerRadius[id]!;
      pos[vi * 3] = cells.corners[id * 3]! * cr;
      pos[vi * 3 + 1] = cells.corners[id * 3 + 1]! * cr;
      pos[vi * 3 + 2] = cells.corners[id * 3 + 2]! * cr;
    }
  }
  attr.needsUpdate = true;
  if (withNormals) geometry.computeVertexNormals();
  return cornerRadius;
}

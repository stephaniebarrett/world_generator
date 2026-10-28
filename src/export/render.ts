// Render per-vertex colours into a flat map image through a projection. Pure: returns pixels.

import type { Lattice } from '../sim/lattice';
import { LatticeIndex } from '../sim/latticeIndex';
import type { Projection } from './projections';

export { LatticeIndex };

export interface MapImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, row by row from the top. Pixels outside the map are fully transparent. */
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

export function renderProjection(lattice: Lattice, colors: Float32Array, projection: Projection, width: number): MapImage {
  const height = Math.max(1, Math.round(width / projection.aspect));
  const data = new Uint8ClampedArray(width * height * 4);
  const index = new LatticeIndex(lattice);
  for (let j = 0; j < height; j++) {
    const y = 1 - ((j + 0.5) / height) * 2;
    for (let i = 0; i < width; i++) {
      const x = ((i + 0.5) / width) * 2 - 1;
      const ll = projection.inverse(x, y);
      if (!ll) continue;
      const [lat, lon] = ll;
      const cl = Math.cos(lat);
      const v = index.nearest(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat));
      const o = (j * width + i) * 4;
      data[o] = colors[v * 3]! * 255;
      data[o + 1] = colors[v * 3 + 1]! * 255;
      data[o + 2] = colors[v * 3 + 2]! * 255;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

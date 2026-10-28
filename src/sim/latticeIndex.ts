import type { Lattice } from './lattice';

/** Finds the lattice vertex nearest to a direction, using a uniform grid. */
export class LatticeIndex {
  private readonly dims: number;
  private readonly cell: number;
  private readonly head: Int32Array;
  private readonly next: Int32Array;

  constructor(private readonly lattice: Lattice) {
    const spacing = Math.sqrt((4 * Math.PI) / lattice.vertexCount);
    this.cell = 2 * spacing;
    this.dims = Math.ceil(2.2 / this.cell);
    this.head = new Int32Array(this.dims ** 3).fill(-1);
    this.next = new Int32Array(lattice.vertexCount);
    for (let v = 0; v < lattice.vertexCount; v++) {
      const c = this.cellOf(lattice.positions[v * 3]!, lattice.positions[v * 3 + 1]!, lattice.positions[v * 3 + 2]!);
      this.next[v] = this.head[c]!;
      this.head[c] = v;
    }
  }

  private coord(v: number): number {
    const c = Math.floor((v + 1.1) / this.cell);
    return c < 0 ? 0 : c >= this.dims ? this.dims - 1 : c;
  }

  private cellOf(x: number, y: number, z: number): number {
    return (this.coord(x) * this.dims + this.coord(y)) * this.dims + this.coord(z);
  }

  nearest(x: number, y: number, z: number): number {
    const { dims, head, next } = this;
    const cx = this.coord(x), cy = this.coord(y), cz = this.coord(z);
    const { positions } = this.lattice;
    let best = -1;
    let bestD = Infinity;
    // Grow the search ring until it finds something; usually the first ring does.
    for (let ring = 1; best < 0 && ring <= dims; ring++) {
      for (let a = Math.max(0, cx - ring); a <= Math.min(dims - 1, cx + ring); a++) {
        for (let b = Math.max(0, cy - ring); b <= Math.min(dims - 1, cy + ring); b++) {
          for (let c = Math.max(0, cz - ring); c <= Math.min(dims - 1, cz + ring); c++) {
            for (let v = head[(a * dims + b) * dims + c]!; v >= 0; v = next[v]!) {
              const dx = positions[v * 3]! - x, dy = positions[v * 3 + 1]! - y, dz = positions[v * 3 + 2]! - z;
              const d = dx * dx + dy * dy + dz * dz;
              if (d < bestD || (d === bestD && v < best)) {
                bestD = d;
                best = v;
              }
            }
          }
        }
      }
    }
    return best;
  }
}

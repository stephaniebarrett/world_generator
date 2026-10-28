// Arrows for the wind and ocean-current layers: a grid of small arrows along the flow, longer and warmer-coloured where it is faster.

/** Speed (in wind units, where 1 is a strong trade wind) at which the colour reaches its end. */
export const FLOW_TOP_SPEED = 1.2;
/** Arrow length at full speed, and the shortest an arrow gets, as a share of the spacing between arrows (so they never overlap). */
const ARROW_LENGTH = 0.95;
const MIN_LENGTH = 0.35;
/** Flow slower than this is left out. */
const CALM = 0.04;

/** Still to fast: blue, green, yellow, red. */
export const FLOW_STOPS = [
  [0, 0.25, 0.45, 0.95],
  [0.33, 0.2, 0.8, 0.55],
  [0.66, 0.98, 0.85, 0.2],
  [1, 0.95, 0.25, 0.15],
] as const;

export function flowColor(speed: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, speed / FLOW_TOP_SPEED));
  for (let i = 1; i < FLOW_STOPS.length; i++) {
    const a = FLOW_STOPS[i - 1]!, b = FLOW_STOPS[i]!;
    if (x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  const last = FLOW_STOPS[FLOW_STOPS.length - 1]!;
  return [last[1], last[2], last[3]];
}

/** The flow at a point on the unit sphere: [east, north], or null where there is none to draw (such as wind over no sea). */
export type FlowAt = (x: number, y: number, z: number) => readonly [number, number] | null;

/**
 * Line segments for the arrows, each a shaft and two barbs, with a colour for every point. `radiusAt` gives the surface radius
 * for a unit direction, so the arrows sit on the terrain; they are lifted by `lift`.
 */
export function flowArrowLines(
  flowAt: FlowAt,
  radiusAt: (x: number, y: number, z: number) => number,
  /** Degrees between arrows: smaller is denser, with smaller arrows. */
  stepDeg = 6,
  lift = 0.008,
): { positions: number[]; colors: number[] } {
  const spacing = (stepDeg * Math.PI) / 180;
  const positions: number[] = [], colors: number[] = [];
  let rgb: [number, number, number] = [1, 1, 1];
  const push = (x: number, y: number, z: number) => {
    const len = Math.sqrt(x * x + y * y + z * z);
    const r = radiusAt(x / len, y / len, z / len) + lift;
    positions.push((x / len) * r, (y / len) * r, (z / len) * r);
    colors.push(...rgb);
  };
  for (let latDeg = -90 + stepDeg / 2; latDeg < 90; latDeg += stepDeg) {
    const lat = (latDeg * Math.PI) / 180;
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const count = Math.max(3, Math.round((360 * cosLat) / stepDeg));
    for (let i = 0; i < count; i++) {
      const lon = ((i + (Math.round((latDeg + 90 - stepDeg / 2) / stepDeg) % 2 === 0 ? 0 : 0.5)) / count) * 2 * Math.PI;
      const cosLon = Math.cos(lon), sinLon = Math.sin(lon);
      const px = cosLat * cosLon, py = cosLat * sinLon, pz = sinLat;
      const flow = flowAt(px, py, pz);
      if (!flow) continue;
      const [east, north] = flow;
      const speed = Math.sqrt(east * east + north * north);
      if (speed < CALM) continue;
      const ex = -sinLon, ey = cosLon;
      const nx = -sinLat * cosLon, ny = -sinLat * sinLon, nz = cosLat;
      const hx = (east * ex + north * nx) / speed, hy = (east * ey + north * ny) / speed, hz = (north * nz) / speed;
      const sx = py * hz - pz * hy, sy = pz * hx - px * hz, sz = px * hy - py * hx;
      const arc = spacing * (MIN_LENGTH + (ARROW_LENGTH - MIN_LENGTH) * Math.min(1, speed / FLOW_TOP_SPEED));
      const along = (t: number, side = 0): [number, number, number] => [px + hx * t + sx * side, py + hy * t + sy * side, pz + hz * t + sz * side];
      const tail = along(-arc / 2), tip = along(arc / 2);
      const barbBack = arc / 2 - arc * 0.3, barb = arc * 0.2;
      const left = along(barbBack, barb), right = along(barbBack, -barb);
      rgb = flowColor(speed);
      for (const [a, b] of [[tail, tip], [tip, left], [tip, right]] as const) {
        push(...a);
        push(...b);
      }
    }
  }
  return { positions, colors };
}

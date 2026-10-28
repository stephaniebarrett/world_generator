// Prevailing-wind arrows drawn over the globe: a grid of small arrows along the year-round mean surface wind.

import { prevailingWind, type ClimateParams } from '../sim/climate';

const LATITUDE_STEP_DEG = 12;
const LONGITUDE_STEP_DEG = 16;
/** Arrow length (radians of arc) at full wind speed. */
const ARROW_ARC = 0.09;
/** Winds weaker than this are left out: the calm belts at the horse latitudes and doldrums. */
const CALM = 0.12;

/**
 * Line segments (pairs of points) for the wind arrows: shaft plus two barbs each. `radiusAt` gives the surface radius
 * for a unit direction, so the arrows sit on the terrain; they are lifted by `lift`.
 */
export function windArrowLines(params: ClimateParams, radiusAt: (x: number, y: number, z: number) => number, lift = 0.012): number[] {
  const out: number[] = [];
  const push = (x: number, y: number, z: number) => {
    const len = Math.sqrt(x * x + y * y + z * z);
    const r = radiusAt(x / len, y / len, z / len) + lift;
    out.push((x / len) * r, (y / len) * r, (z / len) * r);
  };
  for (let latDeg = -78; latDeg <= 78; latDeg += LATITUDE_STEP_DEG) {
    const lat = (latDeg * Math.PI) / 180;
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const [east, north] = prevailingWind(sinLat, params);
    const speed = Math.sqrt(east * east + north * north);
    if (speed < CALM) continue;
    const count = Math.max(3, Math.round((360 * cosLat) / LONGITUDE_STEP_DEG));
    for (let i = 0; i < count; i++) {
      const lon = ((i + (latDeg % 24 === 0 ? 0 : 0.5)) / count) * 2 * Math.PI;
      const cosLon = Math.cos(lon), sinLon = Math.sin(lon);
      const px = cosLat * cosLon, py = cosLat * sinLon, pz = sinLat;
      // Local east and north directions at this point.
      const ex = -sinLon, ey = cosLon;
      const nx = -sinLat * cosLon, ny = -sinLat * sinLon, nz = cosLat;
      // Unit heading of the wind in the tangent plane, and the side direction for the barbs.
      const hx = (east * ex + north * nx) / speed, hy = (east * ey + north * ny) / speed, hz = (north * nz) / speed;
      const sx = py * hz - pz * hy, sy = pz * hx - px * hz, sz = px * hy - py * hx;
      const arc = ARROW_ARC * (0.5 + 0.5 * Math.min(1, speed));
      const along = (t: number, side = 0): [number, number, number] => [px + hx * t + sx * side, py + hy * t + sy * side, pz + hz * t + sz * side];
      const tail = along(-arc / 2), tip = along(arc / 2);
      const barbBack = arc / 2 - arc * 0.3, barb = arc * 0.2;
      const left = along(barbBack, barb), right = along(barbBack, -barb);
      for (const [a, b] of [[tail, tip], [tip, left], [tip, right]] as const) {
        push(...a);
        push(...b);
      }
    }
  }
  return out;
}

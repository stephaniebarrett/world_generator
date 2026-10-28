// Map projections for PNG export. Each maps between the sphere and a flat image.
//
// Image coordinates are normalised: x in [-1, 1] across the image width and y in [-1, 1] up the
// image height, so any output size just scales them. `aspect` is width / height.
// Latitude and longitude are in radians. This is view-side code (exports), not simulation code.

export interface Projection {
  readonly key: string;
  readonly name: string;
  readonly aspect: number;
  /** Image point to [latitude, longitude], or null if the point is off the map. */
  inverse(x: number, y: number): [number, number] | null;
  /** [latitude, longitude] to image point, or null if the point is not shown. */
  forward(lat: number, lon: number): [number, number] | null;
}

const PI = Math.PI;
const HALF_PI = PI / 2;

export interface ViewPoint {
  /** Centre of the orthographic view, radians. */
  readonly lat: number;
  readonly lon: number;
}

const equirectangular: Projection = {
  key: 'equirectangular',
  name: 'Equirectangular',
  aspect: 2,
  forward: (lat, lon) => [lon / PI, lat / HALF_PI],
  inverse: (x, y) => [y * HALF_PI, x * PI],
};

const MERCATOR_LAT = 1.4844; // 85.05 degrees: the limit that makes the map square
const mercatorY = (lat: number) => Math.log(Math.tan(PI / 4 + lat / 2));
const MERCATOR_EXTENT = mercatorY(MERCATOR_LAT);
const mercator: Projection = {
  key: 'mercator',
  name: 'Mercator',
  aspect: 1,
  forward: (lat, lon) => (Math.abs(lat) > MERCATOR_LAT ? null : [lon / PI, mercatorY(lat) / MERCATOR_EXTENT]),
  inverse: (x, y) => [2 * Math.atan(Math.exp(y * MERCATOR_EXTENT)) - HALF_PI, x * PI],
};

const GALL_STANDARD = PI / 4;
const gallPeters: Projection = {
  key: 'gall-peters',
  name: 'Gall-Peters (equal area)',
  aspect: (2 * PI * Math.cos(GALL_STANDARD)) / (2 / Math.cos(GALL_STANDARD)),
  forward: (lat, lon) => [lon / PI, Math.sin(lat)],
  inverse: (x, y) => [Math.asin(y), x * PI],
};

const mollweide: Projection = {
  key: 'mollweide',
  name: 'Mollweide (equal area)',
  aspect: 2,
  forward: (lat, lon) => {
    let theta = lat;
    for (let i = 0; i < 12 && Math.abs(lat) < HALF_PI - 1e-9; i++) {
      theta -= (2 * theta + Math.sin(2 * theta) - PI * Math.sin(lat)) / (2 + 2 * Math.cos(2 * theta));
    }
    if (Math.abs(lat) >= HALF_PI - 1e-9) theta = Math.sign(lat) * HALF_PI;
    return [(lon / PI) * Math.cos(theta), Math.sin(theta)];
  },
  inverse: (x, y) => {
    if (Math.abs(y) > 1) return null;
    const theta = Math.asin(y);
    const c = Math.cos(theta);
    if (Math.abs(x) > c) return null;
    const lat = Math.asin((2 * theta + Math.sin(2 * theta)) / PI);
    return [lat, c < 1e-9 ? 0 : (PI * x) / c];
  },
};

// Robinson: published table at 5 degree steps, interpolated.
const ROBINSON_LENGTH = [1.0, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216, 0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722, 0.5322];
const ROBINSON_Y = [0.0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761, 1.0];
const ROBINSON_X_SCALE = 0.8487;
const ROBINSON_Y_SCALE = 1.3523;

function tableAt(table: readonly number[], latDeg: number): number {
  const i = Math.min(17, Math.floor(latDeg / 5));
  const t = (latDeg - i * 5) / 5;
  return table[i]! + (table[i + 1]! - table[i]!) * t;
}
const ROBINSON_WIDTH = ROBINSON_X_SCALE * ROBINSON_LENGTH[0]! * PI;
const ROBINSON_HEIGHT = ROBINSON_Y_SCALE;
const robinson: Projection = {
  key: 'robinson',
  name: 'Robinson',
  aspect: ROBINSON_WIDTH / ROBINSON_HEIGHT,
  forward: (lat, lon) => {
    const deg = (Math.abs(lat) * 180) / PI;
    const x = ROBINSON_X_SCALE * tableAt(ROBINSON_LENGTH, deg) * lon;
    const y = Math.sign(lat) * ROBINSON_Y_SCALE * tableAt(ROBINSON_Y, deg);
    return [x / ROBINSON_WIDTH, y / ROBINSON_HEIGHT];
  },
  inverse: (x, y) => {
    const yy = Math.abs(y) * ROBINSON_HEIGHT / ROBINSON_Y_SCALE;
    if (yy > 1) return null;
    let i = 0;
    while (i < 17 && ROBINSON_Y[i + 1]! < yy) i++;
    const t = (yy - ROBINSON_Y[i]!) / (ROBINSON_Y[i + 1]! - ROBINSON_Y[i]!);
    const deg = i * 5 + t * 5;
    const lon = (x * ROBINSON_WIDTH) / (ROBINSON_X_SCALE * tableAt(ROBINSON_LENGTH, deg));
    if (Math.abs(lon) > PI) return null;
    return [Math.sign(y) * (deg * PI) / 180, lon];
  },
};

// Winkel tripel: no closed-form inverse, so Newton's method on the forward map.
const WINKEL_PHI1 = Math.acos(2 / PI);
function winkelForward(lat: number, lon: number): [number, number] {
  const a = Math.acos(Math.cos(lat) * Math.cos(lon / 2));
  const sinc = a < 1e-9 ? 1 : Math.sin(a) / a;
  return [0.5 * (lon * Math.cos(WINKEL_PHI1) + (2 * Math.cos(lat) * Math.sin(lon / 2)) / sinc), 0.5 * (lat + Math.sin(lat) / sinc)];
}
const WINKEL_WIDTH = winkelForward(0, PI)[0];
const WINKEL_HEIGHT = winkelForward(HALF_PI, 0)[1];
const winkel: Projection = {
  key: 'winkel-tripel',
  name: 'Winkel tripel',
  aspect: WINKEL_WIDTH / WINKEL_HEIGHT,
  forward: (lat, lon) => {
    const [x, y] = winkelForward(lat, lon);
    return [x / WINKEL_WIDTH, y / WINKEL_HEIGHT];
  },
  inverse: (x, y) => {
    const tx = x * WINKEL_WIDTH, ty = y * WINKEL_HEIGHT;
    let lat = (y * HALF_PI), lon = x * PI;
    const h = 1e-6;
    for (let i = 0; i < 30; i++) {
      const [fx, fy] = winkelForward(lat, lon);
      const ex = fx - tx, ey = fy - ty;
      if (ex * ex + ey * ey < 1e-14) break;
      const [ax, ay] = winkelForward(lat + h, lon);
      const [bx, by] = winkelForward(lat, lon + h);
      const j11 = (ax - fx) / h, j21 = (ay - fy) / h, j12 = (bx - fx) / h, j22 = (by - fy) / h;
      const det = j11 * j22 - j12 * j21;
      if (Math.abs(det) < 1e-12) return null;
      // Damped Newton step keeps the iterate inside the sphere's range.
      lat -= (ex * j22 - ey * j12) / det;
      lon -= (-ex * j21 + ey * j11) / det;
      lat = Math.max(-HALF_PI, Math.min(HALF_PI, lat));
      lon = Math.max(-PI, Math.min(PI, lon));
    }
    const [fx, fy] = winkelForward(lat, lon);
    if ((fx - tx) ** 2 + (fy - ty) ** 2 > 1e-8) return null;
    return [lat, lon];
  },
};

/** Orthographic globe seen from a chosen point. */
export function orthographic(view: ViewPoint = { lat: 0.4, lon: 0 }): Projection {
  const sinLat0 = Math.sin(view.lat), cosLat0 = Math.cos(view.lat);
  return {
    key: 'orthographic',
    name: 'Globe view',
    aspect: 1,
    forward: (lat, lon) => {
      const dl = lon - view.lon;
      const cosC = sinLat0 * Math.sin(lat) + cosLat0 * Math.cos(lat) * Math.cos(dl);
      if (cosC < 0) return null;
      return [Math.cos(lat) * Math.sin(dl), cosLat0 * Math.sin(lat) - sinLat0 * Math.cos(lat) * Math.cos(dl)];
    },
    inverse: (x, y) => {
      const rho = Math.hypot(x, y);
      if (rho > 1) return null;
      if (rho < 1e-12) return [view.lat, view.lon];
      const c = Math.asin(rho);
      const lat = Math.asin(Math.cos(c) * sinLat0 + (y * Math.sin(c) * cosLat0) / rho);
      const lon = view.lon + Math.atan2(x * Math.sin(c), rho * cosLat0 * Math.cos(c) - y * sinLat0 * Math.sin(c));
      return [lat, lon];
    },
  };
}

/** A polar view of one hemisphere (azimuthal equidistant): the pole in the middle, the equator at the edge. */
function polar(north: boolean): Projection {
  const s = north ? 1 : -1;
  return {
    key: north ? 'polar-north' : 'polar-south',
    name: north ? 'North pole view' : 'South pole view',
    aspect: 1,
    forward: (lat, lon) => {
      if (lat * s < 0) return null;
      const r = (HALF_PI - Math.abs(lat)) / HALF_PI;
      return [r * Math.sin(lon), -s * r * Math.cos(lon)];
    },
    inverse: (x, y) => {
      const r = Math.hypot(x, y);
      if (r > 1) return null;
      return [s * (HALF_PI - r * HALF_PI), Math.atan2(x, -s * y)];
    },
  };
}

export const PROJECTIONS: readonly Projection[] = [
  equirectangular,
  mercator,
  robinson,
  winkel,
  mollweide,
  gallPeters,
  orthographic(),
  polar(true),
  polar(false),
];

/** A longitude brought into [-pi, pi). */
function wrapLon(lon: number): number {
  let x = lon;
  while (x >= PI) x -= 2 * PI;
  while (x < -PI) x += 2 * PI;
  return x;
}

/** The same map centred on another meridian (so the seam can be moved off a continent). */
export function withCentralMeridian(p: Projection, lon: number): Projection {
  if (lon === 0) return p;
  return {
    ...p,
    forward: (la, lo) => p.forward(la, wrapLon(lo - lon)),
    inverse: (x, y) => {
      const r = p.inverse(x, y);
      return r ? [r[0], wrapLon(r[1] + lon)] : null;
    },
  };
}

/**
 * A projection by key, centred where asked: the globe view looks at `centre`; flat maps and polar maps are turned to put
 * the centre's meridian in the middle.
 */
export function projectionByKey(key: string, centre?: ViewPoint): Projection {
  const base = PROJECTIONS.find((p) => p.key === key) ?? equirectangular;
  if (!centre) return base;
  if (key === 'orthographic') return orthographic(centre);
  return withCentralMeridian(base, centre.lon);
}

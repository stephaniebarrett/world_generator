// The "earth" seed: a world laid out like the real one, for fun. Its plates sit where Earth's do and move the way they do, and
// Generate Land draws Earth's continents instead of invented ones. Coastlines are coarse (a few degrees), which is about what the
// simulation lattice resolves anyway; the usual coast noise roughens them.
//
// Everything is a function of position on the sphere, so the Earth is the same at every detail. Degrees become unit vectors
// with a series instead of Math.sin and Math.cos (which can differ in the last bit between engines), and only + - * / sqrt are used.

import type { Lattice } from './lattice';
import { plateOmega, type Vec3 } from './motion';
import type { Plate, PlateSetup } from './plates';

/** True for the seed "earth" (any case), including the suffixed seeds generated land is drawn with (`earth#0`). */
export function isEarthSeed(seed: string): boolean {
  return seed.replace(/#\d+$/, '').trim().toLowerCase() === 'earth';
}

const PI = 3.141592653589793;
const RAD = PI / 180;

function sin(x: number): number {
  // Taylor series; the argument is within a half turn of zero for every angle used here.
  let term = x, sum = x;
  for (let k = 1; k <= 12; k++) {
    term = (-term * x * x) / ((2 * k) * (2 * k + 1));
    sum += term;
  }
  return sum;
}

function cos(x: number): number {
  let term = 1, sum = 1;
  for (let k = 1; k <= 12; k++) {
    term = (-term * x * x) / ((2 * k - 1) * (2 * k));
    sum += term;
  }
  return sum;
}

/** Unit vector for a latitude and longitude in degrees (x toward lon 0, y toward lon 90 east, z north). */
export function fromDegrees(lat: number, lon: number): [number, number, number] {
  const a = lat * RAD, b = lon * RAD;
  const c = cos(a);
  return [c * cos(b), c * sin(b), sin(a)];
}

// ---- Land ----

/** A ring of [lat, lon] pairs in degrees. */
type Ring = ReadonlyArray<readonly [number, number]>;

const NORTH_AMERICA: Ring = [
  [71, -156], [70, -143], [69, -133], [68, -115], [68, -108], [69, -96], [66, -90], [63, -91], [59, -94], [57, -92], [55, -82],
  [52, -80], [52, -79], [55, -77], [58, -78], [62, -78], [62, -72], [60, -69], [58, -65], [55, -60], [52, -56], [50, -60],
  [48, -65], [46, -60], [45, -61], [44, -66], [43, -70], [42, -70], [40.5, -74], [38, -75], [35, -75.5], [32, -80], [30, -81],
  [27, -80], [25.3, -80.5], [26, -82], [29.5, -83.5], [30, -86], [30.3, -88.5], [29, -90], [29.5, -93.5], [28, -96.5],
  [26, -97.2], [22, -97.8], [19, -96], [18.5, -93], [21, -90.5], [21.5, -87], [18, -88], [16, -88.5], [15.8, -85], [15, -83.3],
  [11, -83.5], [9.5, -82], [9.3, -79.8], [9, -77.5], [7.5, -78.5], [7.3, -80.5], [8, -82.8], [8.5, -83.2], [9, -84],
  [10, -85.7], [12, -86.8], [13.3, -88.5], [14, -91], [15.5, -93.5], [16, -95], [15.8, -97], [17, -101], [19, -105],
  [21, -105.5], [23.5, -106.5], [25.5, -109.5], [27.5, -110.8], [30, -113], [31.5, -114.7], [28, -112.8], [25, -111],
  [23, -109.5], [24.5, -112.3], [27, -114.5], [29.5, -115.8], [32.5, -117.1], [34.4, -120.5], [36.7, -121.9], [38, -123],
  [40.4, -124.4], [43, -124.5], [46.2, -124], [48.4, -124.7], [49, -123.2], [50.5, -127.5], [54, -130.5], [57, -135],
  [59, -139.5], [60, -146], [59.5, -151], [57.5, -156], [55, -163], [56, -160], [58.5, -157], [59, -162], [61, -165.5],
  [63.5, -161], [64.5, -166], [65.6, -168], [66.5, -163], [68, -166], [69, -163], [71.3, -156.5],
];

const SOUTH_AMERICA: Ring = [
  [9, -77.5], [11, -74], [12.3, -71.5], [10.7, -68], [10.7, -64], [10.3, -62], [8.5, -60], [6.5, -57.5], [5.8, -53],
  [4.5, -51.5], [2, -50], [0, -50], [-1, -47], [-2.5, -44], [-3, -41], [-5, -36], [-8, -34.8], [-12, -37.5], [-15, -39],
  [-18, -39.5], [-22, -41], [-23, -44], [-24.5, -47], [-26.5, -48.5], [-29, -49.5], [-32, -52], [-34.5, -54], [-35, -57],
  [-36.5, -57], [-39, -62], [-41, -63], [-42.5, -64.5], [-45, -65.5], [-47.5, -66], [-50, -68.5], [-52, -69], [-53.5, -68],
  [-55, -66.5], [-55.5, -69], [-54, -71], [-52, -74.5], [-50, -75.5], [-46, -75.5], [-42, -73.7], [-37, -73.5], [-33, -71.6],
  [-30, -71.4], [-26, -70.6], [-23, -70.4], [-18.5, -70.3], [-16, -73], [-13, -76.3], [-8, -79.3], [-5.5, -81.2], [-3, -80.2],
  [-2, -80.8], [0, -80], [1.5, -79], [4, -77.3], [7, -77.8],
];

const AFRICA: Ring = [
  [37, 10], [36.8, 3], [36.5, -1.5], [35.8, -5.5], [33.5, -7.7], [31, -9.8], [28, -12.5], [24, -16], [21, -17], [17, -16.3],
  [14.7, -17.5], [12, -16.7], [10, -14], [7.5, -12.5], [5, -9], [4.5, -7.5], [5, -2], [5.5, 0], [6.2, 2.5], [6.3, 4.5],
  [4.3, 6.3], [4, 9], [2, 9.7], [0, 9.3], [-3, 10.5], [-5, 12], [-9, 13], [-12, 13.7], [-16, 12], [-18, 11.8], [-22.5, 14.4],
  [-26, 15], [-29, 16.7], [-31.5, 18], [-34.3, 18.5], [-34.8, 20], [-34, 22.5], [-33.8, 25.7], [-32, 28.5], [-29, 31.2],
  [-26, 32.9], [-24, 35.4], [-20, 35.5], [-17.5, 37.5], [-15, 40.7], [-11, 40.5], [-6.5, 39.4], [-4, 39.7], [-1, 41],
  [2, 45.5], [5, 48], [8, 50.5], [11.8, 51.2], [11.7, 43.2], [13, 42.5], [15, 40], [18, 38.3], [22, 36.8], [25, 35.2],
  [28, 33.5], [30, 32.6], [31.3, 32.3], [31.1, 29.9], [31.6, 27], [32.2, 24.5], [32.9, 22], [31.8, 20], [30.3, 19.2],
  [31, 16.5], [32.5, 15.3], [32.9, 13], [33.5, 11], [35, 11],
];

const EURASIA: Ring = [
  [30, 32.6], [28, 34.3], [29.5, 35], [27, 35.6], [24, 38], [21, 39.5], [18, 41.5], [15, 42.6], [12.7, 43.5], [12.8, 45],
  [14, 48.5], [16, 52.5], [19, 57], [22.5, 59.8], [24, 57], [25.5, 56.5], [24, 54], [24.2, 52], [25.5, 51.5], [26, 50.2],
  [28, 48.8], [30, 48.5], [30, 50], [28, 51], [27, 53], [26.5, 56], [25.5, 57], [25.3, 61.5], [25, 66.5], [23, 68.5],
  [21, 72.5], [15, 73.7], [12, 75], [8, 77.2], [9, 79], [10, 79.8], [13, 80.3], [16, 82], [19, 84.8], [21.5, 87], [22, 89],
  [21.5, 91.5], [19, 94.5], [16, 94.4], [16.5, 97.5], [13, 98.5], [9, 98.3], [6, 100], [2, 102], [1.3, 103.8], [2.5, 104.3],
  [6.5, 101.8], [9, 100], [12.5, 99.5], [13.5, 100.5], [12.5, 102.3], [10.5, 104], [9, 105], [10.5, 107], [12, 109.3],
  [16, 108.3], [20, 106.5], [21.5, 108], [21.5, 111], [23, 116], [25, 119.5], [28, 121.5], [30.5, 122], [32.5, 121.5],
  [35, 119.5], [37, 122.5], [38.5, 118], [39, 121], [40, 124], [37.5, 126.5], [34.5, 126.3], [35, 129], [38, 128.5],
  [40, 129.7], [42.5, 130.8], [43, 133], [45, 136], [48, 140], [51.5, 141.5], [54, 140], [55, 135.5], [59, 143], [59.5, 152],
  [61.5, 160], [59.5, 163], [57, 156], [54, 155.5], [51, 156.5], [53, 160], [56, 162.5], [58, 163], [60, 166.5], [62, 170],
  [64, 178], [65.5, 180], [69, 180], [69.5, 170], [70.5, 160], [72, 150], [71.5, 140], [72.5, 129], [73.5, 119], [75.5, 113],
  [77.5, 104], [76, 100], [75, 90], [73.5, 80.5], [72, 72], [68.5, 67], [68.5, 60], [68, 54], [68.5, 44], [69.5, 41], [69.7, 33],
  [71, 28], [70.5, 23], [69.5, 18], [67.5, 14.5], [65, 12], [63, 8], [62, 5], [60, 5], [58.5, 6], [58, 8], [59, 10.5], [58, 11.5],
  [56, 12.8], [55.5, 14], [56, 16], [58, 16.8], [60, 18.5], [62, 17.5], [63.5, 19.5], [65.8, 24], [65, 25.5], [63, 21],
  [61, 21.3], [60, 22.5], [60.2, 25], [60, 29.5], [59.5, 28], [59.4, 24], [58, 23.5], [57.5, 22], [57, 21], [55.5, 21],
  [54.6, 19.5], [54.5, 18.5], [54, 16], [54.2, 12], [54.3, 10.3], [57.5, 10.5], [57.5, 8.2], [55.5, 8.2], [53.6, 8.7],
  [53.5, 6.5], [52, 4.3], [51.2, 2.6], [49.5, 0.2], [49.7, -1.5], [48.7, -2.5], [48.4, -4.7], [47.5, -3], [46, -1.3],
  [43.5, -1.5], [43.4, -3], [43.6, -6], [43.5, -8], [42, -8.9], [39, -9.4], [37, -8.9], [36.9, -6.3], [36, -5.6], [36.7, -4],
  [37, -2], [38.7, 0], [40.5, 0.7], [41.3, 2], [42.3, 3.2], [43.3, 3.5], [43.3, 5], [43.1, 6], [43.7, 7.4], [44.2, 8.5],
  [44.4, 9], [43.5, 10.3], [42, 11], [41.2, 13.2], [40, 15.5], [38.5, 16], [38, 15.7], [37.9, 16], [39.5, 17.1], [40.4, 18.5],
  [41.2, 16], [42, 15], [42.5, 14], [44, 12.5], [45.2, 12.3], [45.7, 13.5], [45.4, 13.8], [43.5, 16], [42.5, 18], [41.5, 19.4],
  [40, 19.5], [39.5, 20], [38.3, 21.3], [37.5, 21.5], [36.5, 22.8], [36.4, 23], [38, 24], [39, 23], [40.5, 23], [40.8, 24.5],
  [41, 26], [40.3, 26.3], [39.3, 26.5], [38, 26.5], [36.8, 28], [36.3, 30], [36.5, 32], [36.2, 34], [36.8, 36], [35.5, 35.8],
  [33.5, 35.2], [32, 34.5], [31.3, 34.2], [31.1, 33], [31.3, 32.3],
];

/** The far tip of Siberia, across the date line. */
const CHUKOTKA: Ring = [[65.5, -180], [69, -180], [69.5, -175], [67, -170], [65.6, -168.5], [64.5, -172], [65, -178]];

const ANTARCTIC_COAST: Ring = [
  [-78, -180], [-77, -160], [-74, -130], [-73.5, -100], [-72, -75], [-67, -68], [-65, -64], [-63.5, -60], [-63.5, -57],
  [-66, -55], [-72, -50], [-77, -45], [-78, -30], [-72, -20], [-70, 0], [-69, 30], [-67, 50], [-68.5, 70], [-66, 90],
  [-66.5, 110], [-66, 130], [-69, 150], [-71, 165], [-77, 175], [-78, 180],
];
/** Joined to the pole so the coast becomes a closed shape. */
const ANTARCTICA: Ring = [[-90, -180], ...ANTARCTIC_COAST, [-90, 180]];

const ISLANDS: ReadonlyArray<Ring> = [
  // Greenland, the Canadian Arctic, and Newfoundland
  [[83.5, -35], [82, -20], [78, -18], [76, -19], [72, -22], [70, -22], [68, -32], [65.5, -40], [62, -42.5], [60, -44], [61, -48],
    [64, -51], [68, -53], [70, -54], [72, -56], [76, -68], [78, -73], [80, -64], [82, -62], [83.5, -45]],
  [[73.5, -80], [72.5, -73], [70, -68], [67, -62], [64.5, -64.5], [62, -66], [63.5, -72], [65, -74], [66, -82], [69, -82], [70, -88], [73, -90]],
  [[73, -116], [71, -118], [69.5, -115], [69, -104], [70.5, -102], [73, -105]],
  [[83, -75], [82.5, -62], [80, -62], [78, -75], [77, -86], [80, -92], [82, -87]],
  [[76.5, -92], [75, -80], [74.5, -92]],
  [[51.5, -56], [49.5, -53], [47.5, -52.7], [47.5, -59], [49, -58]],
  // The Caribbean
  [[23, -82], [22, -77], [20, -74], [19.9, -77.5], [21.8, -84]],
  [[19.8, -73], [19.5, -69], [18.3, -68.5], [18, -74.3]],
  // Northern Europe
  [[80, 12], [79, 20], [77, 20], [77, 15]],
  [[66.3, -23], [66, -15], [64.2, -14], [63.4, -19], [64.3, -22.5]],
  [[58.6, -5], [58.5, -3], [57, -2], [55, -1.5], [53, 0.3], [52.8, 1.7], [51.3, 1.4], [50.7, 0.3], [50, -5.5], [51.5, -4.5],
    [51.7, -5.2], [53.3, -4.5], [54.7, -3.4], [55.8, -5.4], [57.5, -6]],
  [[55.2, -6.5], [54, -6], [52, -6.3], [51.5, -9.8], [53, -10], [54.3, -9.9], [55.2, -7.6]],
  [[76.8, 68.5], [75, 58], [73.5, 54], [71, 52], [72, 55], [74.5, 60], [75.5, 68]],
  // East Asia
  [[41.5, 141.5], [39.5, 142], [37, 141], [35.5, 140.8], [34.7, 139.8], [34.5, 137], [33.5, 135.8], [34.5, 133], [34, 131],
    [35.5, 133], [36.8, 136.8], [38.5, 139.5], [40.5, 140]],
  [[45.4, 141.9], [43.3, 145.5], [42.3, 143.3], [41.8, 140.5], [43, 140.3]],
  [[33.8, 130.8], [31, 131], [31.2, 130.2], [33, 129.7]],
  [[34, 134], [33.5, 134.5], [33, 133], [34, 132.8]],
  [[54, 142.7], [50, 143.2], [46, 143.5], [46, 142], [50, 142], [53.5, 141.8]],
  [[25.2, 121.5], [23, 121.5], [22, 120.8], [24, 120.2]],
  [[20, 110.5], [19, 111], [18.3, 109.7], [19.8, 108.7]],
  [[9.8, 80.2], [7, 81.8], [6, 80.5], [8, 79.8]],
  // The Philippines, Indonesia, and New Guinea
  [[18.5, 122], [14, 124], [13.8, 121], [16, 120]],
  [[9.8, 125.5], [6.5, 126.2], [7, 122], [8.5, 123.5]],
  [[7, 117], [4.5, 118.5], [1, 119], [-2.5, 116.5], [-4, 114.5], [-3, 110.3], [1.8, 109.3], [4, 113], [5, 115.5]],
  [[5.6, 95.3], [2.5, 99.5], [-0.5, 103.5], [-2.5, 106], [-5.9, 105.8], [-5, 104], [-2, 101], [1, 98], [3.5, 96]],
  [[-6, 106], [-6.5, 108.5], [-6.8, 111], [-6.8, 114.5], [-8.5, 114.4], [-8, 111], [-7.6, 108], [-7, 105.5]],
  [[1.5, 125], [1, 120.5], [-1, 120.5], [-0.5, 123], [-2.5, 121.5], [-5.5, 122], [-5.5, 120.2], [-3, 119.5], [-0.5, 119.8], [0.5, 119.8], [1.2, 124.5]],
  [[-2.5, 141], [-1, 134], [-3, 132.5], [-4.2, 133.5], [-3.5, 135.5], [-4.5, 138], [-8, 138.2], [-9, 141], [-8.5, 143.5],
    [-10.5, 148.5], [-9, 150.5], [-6, 147.5], [-5.5, 145.5], [-4, 144]],
  // Australia and New Zealand
  [[-10.7, 142.5], [-12.5, 141.7], [-15, 141.5], [-17.5, 140.5], [-17, 139], [-12, 136.8], [-12, 132], [-14.5, 129.5], [-14, 127],
    [-16, 124], [-18.5, 122], [-22, 114], [-26, 113.2], [-30, 115], [-34.5, 115], [-35, 118], [-33.9, 123.5], [-32, 128],
    [-31.5, 131.5], [-34, 135.5], [-33, 137.8], [-35.3, 138], [-36.5, 140], [-38.5, 141.5], [-38.5, 146], [-37.5, 149.8],
    [-34, 151.2], [-28.5, 153.6], [-24, 151.8], [-20, 148.7], [-16, 145.5], [-13, 143.7]],
  [[-40.7, 144.7], [-40.8, 148], [-43.5, 147], [-43.5, 145.5]],
  [[-34.5, 173], [-37.5, 178.5], [-41.5, 175.5], [-39.5, 173.8], [-37, 174.5]],
  [[-41.5, 172.5], [-41.2, 174.2], [-43.5, 173], [-46.5, 169], [-46, 166.5], [-44, 168], [-42, 171.5]],
  // Madagascar
  [[-12, 49.3], [-15.5, 50.5], [-19, 49], [-23.5, 47.5], [-25.5, 45], [-23.5, 43.7], [-21, 44], [-17, 44], [-15.5, 46.5], [-13.5, 48]],
];

const LAND_RINGS: ReadonlyArray<Ring> = [NORTH_AMERICA, SOUTH_AMERICA, AFRICA, EURASIA, CHUKOTKA, ANTARCTICA, ...ISLANDS];

/** Seas the outlines above leave as land: the Black Sea and the Caspian. */
const SEA_RINGS: ReadonlyArray<Ring> = [
  [[41.2, 29], [42, 27.8], [44, 28.7], [45.2, 29.7], [46.5, 31], [46, 33.5], [45.3, 35.5], [45.3, 36.7], [44.5, 37.7], [43.5, 39.8],
    [42, 41.5], [41.2, 41.7], [41, 39], [41.5, 35], [42, 33], [41.3, 31]],
  [[46.5, 48.5], [46.8, 52], [45, 53], [42, 52.7], [40, 53.2], [37, 54], [37, 50], [39, 49], [41, 49], [42.5, 47.8], [44.5, 47]],
];

/** How far from a coast the distance is measured; beyond it the land or sea is just "far". */
const REACH = 0.105; // radians, about 6 degrees

interface Edge {
  readonly a: Vec3;
  readonly b: Vec3;
  /** Midpoint direction and the cosine bound beyond which no point can be within REACH of the edge. */
  readonly mid: Vec3;
  readonly nearCos: number;
}

interface Shape {
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  /** The edges that are real coast (not the join to a pole or a cut along the date line). */
  readonly edges: Edge[];
  readonly centre: Vec3;
  /** Cosine of the angle beyond which a point is further than REACH from the whole shape. */
  readonly nearCos: number;
}

function buildShape(ring: Ring): Shape {
  const n = ring.length;
  const lat = new Float64Array(n), lon = new Float64Array(n);
  const pts: Vec3[] = [];
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    lat[i] = ring[i]![0];
    lon[i] = ring[i]![1];
    const p = fromDegrees(lat[i]!, lon[i]!);
    pts.push(p);
    cx += p[0]; cy += p[1]; cz += p[2];
  }
  const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const centre: Vec3 = cl > 1e-6 ? [cx / cl, cy / cl, cz / cl] : [0, 0, 1];
  const edges: Edge[] = [];
  let widest = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = pts[i]!, b = pts[j]!;
    const dot = (p: Vec3) => p[0] * centre[0] + p[1] * centre[1] + p[2] * centre[2];
    // The angle from the centre to a vertex, from its cosine (an arc length is close enough to the chord for the culling bound).
    const d = Math.sqrt(Math.max(0, 2 - 2 * dot(a)));
    if (d > widest) widest = d;
    const pole = Math.abs(lat[i]!) === 90 || Math.abs(lat[j]!) === 90;
    const seam = Math.abs(lon[i]!) === 180 && Math.abs(lon[j]!) === 180;
    if (pole || seam) continue;
    let mx = a[0] + b[0], my = a[1] + b[1], mz = a[2] + b[2];
    const ml = Math.sqrt(mx * mx + my * my + mz * mz);
    if (ml > 1e-9) { mx /= ml; my /= ml; mz /= ml; }
    const half = Math.sqrt(Math.max(0, 2 - 2 * (a[0] * mx + a[1] * my + a[2] * mz)));
    edges.push({ a, b, mid: [mx, my, mz], nearCos: cos(half + REACH + 0.02) });
  }
  return { lat, lon, edges, centre, nearCos: cos(widest * 1.01 + REACH + 0.02) };
}

let shapes: { land: Shape[]; sea: Shape[] } | null = null;
function loadShapes() {
  return (shapes ??= { land: LAND_RINGS.map(buildShape), sea: SEA_RINGS.map(buildShape) });
}

/** Ray casting in latitude and longitude: no ring crosses the date line, so the plane is enough. */
function inside(shape: Shape, lat: number, lon: number): boolean {
  let hit = false;
  const n = shape.lat.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const la = shape.lat[i]!, lb = shape.lat[j]!;
    if ((la > lat) === (lb > lat)) continue;
    const lo = shape.lon[i]! + ((lat - la) / (lb - la)) * (shape.lon[j]! - shape.lon[i]!);
    if (lo > lon) hit = !hit;
  }
  return hit;
}

/** Distance (in radians, approximately) from a unit vector to the chord a-b. */
function distanceToEdge(x: number, y: number, z: number, e: Edge): number {
  const ax = e.a[0], ay = e.a[1], az = e.a[2];
  const dx = e.b[0] - ax, dy = e.b[1] - ay, dz = e.b[2] - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x - (ax + t * dx), py = y - (ay + t * dy), pz = z - (az + t * dz);
  return Math.sqrt(px * px + py * py + pz * pz);
}

/** Signed distance to a shape's coast: positive inside, negative outside, held to ±REACH. */
function signedDistance(shape: Shape, x: number, y: number, z: number, lat: number, lon: number): number {
  const c = shape.centre;
  if (x * c[0] + y * c[1] + z * c[2] < shape.nearCos) return -REACH;
  let best = REACH;
  for (const e of shape.edges) {
    const m = e.mid;
    if (x * m[0] + y * m[1] + z * m[2] < e.nearCos) continue;
    const d = distanceToEdge(x, y, z, e);
    if (d < best) best = d;
  }
  return inside(shape, lat, lon) ? best : -best;
}

/** Latitude and longitude (degrees) of a unit vector, found with the series above so no engine-dependent function is involved. */
function latLon(x: number, y: number, z: number): [number, number] {
  return [asinDeg(z), atan2Deg(y, x)];
}

/** Arc-sine in degrees: Newton's method on sin, using the series above. */
function asinDeg(s: number): number {
  const c = Math.min(1, Math.max(-1, s));
  let a = c; // radians
  for (let i = 0; i < 30; i++) {
    const f = sin(a) - c;
    const d = cos(a);
    if (d < 1e-9) break;
    a -= f / d;
    if (a > PI / 2) a = PI / 2;
    if (a < -PI / 2) a = -PI / 2;
  }
  return a / RAD;
}

/** Longitude in degrees from (x, y): bisection on the turn, which needs only comparisons and the series above. */
function atan2Deg(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const r = Math.sqrt(x * x + y * y);
  const ux = x / r, uy = y / r;
  // Find angle a in [-pi, pi] with cos a = ux and sin a sign = uy: Newton from a start, then bisect on the half-turn.
  let lo = uy >= 0 ? 0 : -PI, hi = uy >= 0 ? PI : 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    // cos falls from 1 to -1 across [0, pi] and rises across [-pi, 0].
    if (uy >= 0 ? cos(mid) > ux : cos(mid) < ux) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) / RAD;
}

const distances = new WeakMap<Lattice, Float64Array>();

/**
 * How land-like each lattice point is on Earth: signed distance from the nearest coast in potential units (the coast is zero, land
 * is positive), so Generate Land's usual shelf draws the continents where they are. Lakes and seas inside the outlines are cut out.
 */
export function earthPotential(lattice: Lattice): Float64Array {
  const cached = distances.get(lattice);
  if (cached) return Float64Array.from(cached);
  const { land, sea } = loadShapes();
  const out = new Float64Array(lattice.vertexCount);
  const p = lattice.positions;
  for (let v = 0; v < out.length; v++) {
    const x = p[v * 3]!, y = p[v * 3 + 1]!, z = p[v * 3 + 2]!;
    const [lat, lon] = latLon(x, y, z);
    let sd = -REACH;
    for (const s of land) sd = Math.max(sd, signedDistance(s, x, y, z, lat, lon));
    for (const s of sea) {
      if (sd <= -REACH) break;
      sd = Math.min(sd, -signedDistance(s, x, y, z, lat, lon));
    }
    out[v] = sd / POTENTIAL_UNIT;
  }
  distances.set(lattice, out);
  return Float64Array.from(out);
}

/** One potential unit in radians; the generated shelf (0.14 units) comes out about two and a half degrees wide. */
const POTENTIAL_UNIT = 0.31;

// ---- Plates ----

/** A place a plate reaches from, with how far its pull extends (a bigger weight claims more ground). */
type Site = readonly [lat: number, lon: number, weight: number];

interface EarthPlate {
  readonly name: string;
  readonly sites: ReadonlyArray<Site>;
  /** Compass bearing of the drift in degrees (0 north, 90 east), its speed in centimetres a year, and spin in 1e-3 radians per My. */
  readonly bearing: number;
  readonly speed: number;
  readonly spin: number;
}

const EARTH_PLATES: ReadonlyArray<EarthPlate> = [
  { name: 'Pacific', sites: [[0, -160, 1.6], [35, -165, 1.2], [-30, -135, 1.2], [-40, 180, 1], [20, -155, 1], [-15, -145, 1.2], [-55, -150, 0.8], [38, -135, 0.8], [50, -172, 0.8], [40, 165, 1], [-10, 175, 1]], bearing: 300, speed: 7, spin: 1.5 },
  { name: 'North America', sites: [[48, -95, 1.2], [60, -60, 1], [65, -100, 1], [35, -55, 0.8], [62, 150, 0.8], [75, -50, 0.8]], bearing: 245, speed: 1.5, spin: -0.5 },
  { name: 'Eurasia', sites: [[55, 60, 1.6], [45, 110, 1.4], [50, 15, 1.1], [62, 100, 1.4], [35, 60, 0.9], [25, 108, 1.1], [66, 8, 0.8]], bearing: 100, speed: 0.8, spin: -0.3 },
  { name: 'Africa', sites: [[5, 20, 1.5], [-10, 22, 1.4], [27, 12, 1.4], [-30, 22, 1.1], [-25, -5, 0.8], [10, -15, 0.7]], bearing: 40, speed: 2.2, spin: 0.3 },
  { name: 'South America', sites: [[-12, -58, 1.4], [-35, -66, 1], [3, -62, 0.9], [-25, -40, 0.8]], bearing: 280, speed: 2, spin: 0 },
  { name: 'Antarctica', sites: [[-90, 0, 1.6], [-72, 0, 1.2], [-72, 90, 1.2], [-72, 180, 1.2], [-72, -90, 1.2]], bearing: 150, speed: 1, spin: 0 },
  { name: 'Australia', sites: [[-25, 135, 1.2], [-12, 150, 0.9], [-35, 165, 0.8]], bearing: 20, speed: 6.5, spin: 0.6 },
  { name: 'India', sites: [[22, 78, 0.8], [-10, 72, 0.55]], bearing: 25, speed: 5, spin: 0.3 },
  { name: 'Arabia', sites: [[23, 45, 0.8]], bearing: 20, speed: 3, spin: 0.4 },
  { name: 'Nazca', sites: [[-20, -85, 0.9], [-38, -90, 0.8]], bearing: 85, speed: 5.5, spin: -0.4 },
  { name: 'Cocos', sites: [[8, -100, 0.7]], bearing: 40, speed: 7, spin: 0 },
  { name: 'Caribbean', sites: [[14, -76, 0.55]], bearing: 80, speed: 1.5, spin: 0 },
  { name: 'Scotia', sites: [[-57, -45, 0.45]], bearing: 90, speed: 2, spin: 0 },
  { name: 'Philippine Sea', sites: [[22, 135, 0.5]], bearing: 310, speed: 6, spin: -0.5 },
  { name: 'Juan de Fuca', sites: [[44, -130, 0.35]], bearing: 50, speed: 3, spin: 0 },
];

const CM_PER_YEAR = 0.00157; // radians per million years per centimetre a year, on the unit sphere (10 km/My over 6371 km)

/**
 * Earth's plates on `lattice`: each point goes to the plate whose nearest site pulls hardest (distance over weight), which gives
 * the plates their real sizes and rough outlines. The plates drift the way the real ones do, in a frame where the sea floor
 * spreads and the oceans close the way they are said to.
 */
export function earthPlates(lattice: Lattice): PlateSetup {
  const sites = EARTH_PLATES.map((p) => p.sites.map(([lat, lon, w]) => ({ dir: fromDegrees(lat, lon), w })));
  const n = lattice.vertexCount;
  const plateOf = new Int32Array(n);
  const pos = lattice.positions;
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!;
    let best = 0, bestScore = Infinity;
    for (let k = 0; k < sites.length; k++) {
      for (const s of sites[k]!) {
        const chord = Math.sqrt(Math.max(0, 2 - 2 * (x * s.dir[0] + y * s.dir[1] + z * s.dir[2])));
        const score = chord / s.w;
        if (score < bestScore) { bestScore = score; best = k; }
      }
    }
    plateOf[v] = best;
  }
  // Each plate's drift is about its middle: the member nearest the mean position.
  const sum = new Float64Array(EARTH_PLATES.length * 3);
  for (let v = 0; v < n; v++) {
    const k = plateOf[v]! * 3;
    sum[k] = sum[k]! + pos[v * 3]!;
    sum[k + 1] = sum[k + 1]! + pos[v * 3 + 1]!;
    sum[k + 2] = sum[k + 2]! + pos[v * 3 + 2]!;
  }
  const heart = new Int32Array(EARTH_PLATES.length).fill(-1);
  const heartDot = new Float64Array(EARTH_PLATES.length).fill(-Infinity);
  for (let k = 0; k < EARTH_PLATES.length; k++) {
    const sx = sum[k * 3]!, sy = sum[k * 3 + 1]!, sz = sum[k * 3 + 2]!;
    const l = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (l > 0) { sum[k * 3] = sx / l; sum[k * 3 + 1] = sy / l; sum[k * 3 + 2] = sz / l; }
  }
  for (let v = 0; v < n; v++) {
    const k = plateOf[v]!;
    const d = pos[v * 3]! * sum[k * 3]! + pos[v * 3 + 1]! * sum[k * 3 + 1]! + pos[v * 3 + 2]! * sum[k * 3 + 2]!;
    if (d > heartDot[k]!) { heartDot[k] = d; heart[k] = v; }
  }
  const plates: Plate[] = [];
  for (let k = 0; k < EARTH_PLATES.length; k++) {
    const e = EARTH_PLATES[k]!;
    const sv = heart[k]!;
    if (sv < 0) {
      plates.push({ id: k, seedVertex: 0, axis: [0, 0, 1], angularSpeed: 0.0015 }); // lost to a coarse lattice; dropped below
      continue;
    }
    const centre: Vec3 = [pos[sv * 3]!, pos[sv * 3 + 1]!, pos[sv * 3 + 2]!];
    const b = e.bearing * RAD;
    const w = plateOmega(centre, [sin(b), cos(b)], e.speed * CM_PER_YEAR, e.spin * 0.001);
    const len = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
    plates.push({ id: k, seedVertex: sv, axis: len > 0 ? [w[0] / len, w[1] / len, w[2] / len] : [0, 0, 1], angularSpeed: Math.max(len, 0.0015) });
  }
  return { plateOf, plates };
}

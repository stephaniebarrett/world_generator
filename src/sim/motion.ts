// A plate's motion on the sphere as the two things a person thinks of: how fast and which way its middle is drifting, and how
// fast it is turning about its own middle. Underneath it is one angular velocity (a rotation about an axis through the planet),
// which is all the simulation needs: the drift is the part of it at right angles to the plate's centre, the spin the part along it.
//
// Only + - * / sqrt, so results are identical everywhere.

export type Vec3 = readonly [number, number, number];

const unit = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.sqrt(x * x + y * y + z * z);
  return l > 0 ? [x / l, y / l, z / l] : [0, 0, 1];
};

/** Unit vectors pointing east and north at a point on the sphere. */
export function eastNorth(centre: Vec3): { east: [number, number, number]; north: [number, number, number] } {
  const [x, y, z] = centre;
  const eLen = Math.sqrt(x * x + y * y);
  const east: [number, number, number] = eLen > 1e-9 ? [-y / eLen, x / eLen, 0] : [1, 0, 0];
  const north = unit(-z * x, -z * y, 1 - z * z);
  return { east, north: eLen > 1e-9 ? north : [0, 1, 0] };
}

/**
 * Angular velocity (xyz, radians per million years) of a plate centred at `centre` that drifts at `speed` toward `heading`
 * (a direction in the surface there, given as a vector in the plane of east and north) while turning `spin` about its centre
 * (positive is counter-clockwise seen from above).
 */
export function plateOmega(centre: Vec3, heading: readonly [number, number], speed: number, spin: number): [number, number, number] {
  const { east, north } = eastNorth(centre);
  const h = unit(heading[0], heading[1], 0);
  const v: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) v[a] = speed * (h[0] * east[a]! + h[1] * north[a]!);
  const [cx, cy, cz] = centre;
  // omega = centre x velocity moves the centre along the velocity; spin * centre turns the plate about its middle.
  return [cy * v[2] - cz * v[1] + spin * cx, cz * v[0] - cx * v[2] + spin * cy, cx * v[1] - cy * v[0] + spin * cz];
}

/** The same motion taken apart again: the drift speed of the plate's centre and how fast it spins about it. */
export function driftAndSpin(centre: Vec3, omega: Vec3): { drift: number; spin: number } {
  const spin = omega[0] * centre[0] + omega[1] * centre[1] + omega[2] * centre[2];
  const px = omega[0] - spin * centre[0], py = omega[1] - spin * centre[1], pz = omega[2] - spin * centre[2];
  return { drift: Math.sqrt(px * px + py * py + pz * pz), spin };
}

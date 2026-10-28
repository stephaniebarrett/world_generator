// Arrows showing how each plate moves: one for the drift of its centre, and a curved one around the centre for its spin.

import * as THREE from 'three';

/** Line segments for an arrow lying on the globe from `a` to `b`, with a small head, lifted to radius `lift`. */
export function arrowSegments(a: THREE.Vector3, b: THREE.Vector3, lift: number): number[] {
  const dir = b.clone().sub(a);
  const length = dir.length();
  if (length < 1e-6) return [];
  dir.divideScalar(length);
  const side = a.clone().cross(dir).normalize();
  const head = Math.min(0.06, length * 0.35);
  const left = b.clone().addScaledVector(dir, -head).addScaledVector(side, head * 0.5);
  const right = b.clone().addScaledVector(dir, -head).addScaledVector(side, -head * 0.5);
  const out: number[] = [];
  for (const [p, q] of [[a, b], [b, left], [b, right]] as const) out.push(...p.clone().multiplyScalar(lift).toArray(), ...q.clone().multiplyScalar(lift).toArray());
  return out;
}

const COLOR = [0.07, 0.07, 0.07] as const;
const LIFT = 1.035;
/** The turn drawn is this many times the turn the plate's centre truly makes over the arrow's length, which on a whole planet is tiny. */
const TURN_EXAGGERATION = 6;
const MAX_TURN = 2.5;
/** Spins slower than this (rad/My) are drawn straight. */
const MIN_SPIN = 0.0003;
/** A plate that is spinning but not drifting gets a short curl of this length (rad on the globe) turning by this much. */
const CURL_LENGTH = 0.08;
const CURL_TURN = 2.2;

/**
 * One arrow per plate, along the way its centre is drifting, as long as the drift is fast. The path bends the way the plate is
 * turning (to the left for counter-clockwise spin) and more the faster it spins relative to its drift. `omega` is a plate's
 * angular velocity (xyz, radians per million years).
 */
export function plateMotionLines(
  positions: ArrayLike<number>,
  plateOf: ArrayLike<number>,
  plateCount: number,
  omega: (id: number) => readonly [number, number, number],
): { positions: number[]; colors: number[] } {
  const sums = new Float64Array(plateCount * 3);
  const counts = new Int32Array(plateCount);
  for (let v = 0; v < plateOf.length; v++) {
    const id = plateOf[v]!;
    sums[id * 3] = sums[id * 3]! + positions[v * 3]!;
    sums[id * 3 + 1] = sums[id * 3 + 1]! + positions[v * 3 + 1]!;
    sums[id * 3 + 2] = sums[id * 3 + 2]! + positions[v * 3 + 2]!;
    counts[id] = counts[id]! + 1;
  }
  const out: number[] = [], colors: number[] = [];
  for (let id = 0; id < plateCount; id++) {
    if (!counts[id]) continue;
    const c = new THREE.Vector3(sums[id * 3], sums[id * 3 + 1], sums[id * 3 + 2]);
    if (c.lengthSq() < 1e-9) continue;
    c.normalize();
    const w = new THREE.Vector3(...omega(id));
    const velocity = w.clone().cross(c);
    const speed = velocity.length();
    const spin = Math.abs(w.dot(c)) >= MIN_SPIN ? w.dot(c) : 0;
    let segments: number[];
    if (speed > 0) {
      const length = 0.05 + speed * 10;
      // The centre's own path turns by spin / speed per unit of length; exaggerated so it can be seen.
      const turn = Math.max(-MAX_TURN, Math.min(MAX_TURN, (spin / speed) * length * TURN_EXAGGERATION));
      segments = curvedArrow(c, velocity.divideScalar(speed), length, turn);
    } else if (spin !== 0) {
      segments = curvedArrow(c, new THREE.Vector3(0, 0, 1).cross(c).normalize(), CURL_LENGTH, spin > 0 ? CURL_TURN : -CURL_TURN);
    } else continue;
    out.push(...segments);
    for (let i = 0; i < segments.length; i += 3) colors.push(...COLOR);
  }
  return { positions: out, colors };
}

/**
 * An arrow on the globe that starts at `from` heading `heading` (a unit vector along the surface), covers `length` of arc, and
 * turns by `turn` radians as it goes (positive is counter-clockwise seen from above), with a small head.
 */
function curvedArrow(from: THREE.Vector3, heading: THREE.Vector3, length: number, turn: number): number[] {
  const steps = Math.max(1, Math.ceil(Math.abs(turn) / 0.25));
  const ds = length / steps, dTurn = turn / steps;
  const cos = Math.cos(dTurn), sin = Math.sin(dTurn);
  const path = [from.clone()];
  let p = from.clone();
  let h = heading.clone();
  for (let i = 0; i < steps; i++) {
    p = p.clone().addScaledVector(h, ds).normalize();
    h.addScaledVector(p, -h.dot(p)).normalize(); // stay in the surface at the new point
    h = h.clone().multiplyScalar(cos).addScaledVector(p.clone().cross(h), sin).normalize();
    path.push(p);
  }
  const out: number[] = [];
  for (let i = 1; i < path.length; i++) out.push(...path[i - 1]!.clone().multiplyScalar(LIFT).toArray(), ...path[i]!.clone().multiplyScalar(LIFT).toArray());
  const tip = path[path.length - 1]!;
  const side = tip.clone().cross(h).normalize();
  const head = Math.min(0.06, length * 0.35);
  for (const s of [1, -1]) {
    const barb = tip.clone().addScaledVector(h, -head).addScaledVector(side, s * head * 0.5).normalize();
    out.push(...tip.clone().multiplyScalar(LIFT).toArray(), ...barb.multiplyScalar(LIFT).toArray());
  }
  return out;
}

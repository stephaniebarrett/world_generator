// Seeded integer PRNG. Only integer ops (Math.imul, shifts) and one exact
// division by 2^32, so results are identical on every engine and machine.

/** xmur3: hash a string seed into a stream of 32-bit integers. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** A 32-bit integer from a string, for seeding position-based noise. */
export function hashSeed(seed: string): number {
  return xmur3(seed)();
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Independent child generator, stable for a given label. */
  fork(label: string): Rng;
}

/** sfc32 generator seeded from a string. */
export function createRng(seed: string): Rng {
  const seedFn = xmur3(seed);
  let a = seedFn();
  let b = seedFn();
  let c = seedFn();
  let d = seedFn();

  const nextU32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };

  // Warm up so similar seeds diverge.
  for (let i = 0; i < 15; i++) nextU32();

  return {
    next: () => nextU32() / 4294967296,
    int: (n) => Math.floor((nextU32() / 4294967296) * n),
    fork: (label) => createRng(`${seed}/${label}`),
  };
}

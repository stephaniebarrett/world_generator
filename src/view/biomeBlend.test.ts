import { describe, expect, it } from 'vitest';
import { BIOMES, biomeIndex } from '../sim/biomes';
import { blendedBiomeColor } from './biomeBlend';

const dist = (a: readonly number[], b: readonly number[]) => Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));

describe('blended biome colours', () => {
  it('change gently across a rainfall boundary, never jumping', () => {
    // The temperate grassland / forest boundary is at 700 mm; step through it 5% at a time.
    let worst = 0;
    let last = blendedBiomeColor(12, 400, 200);
    for (let rain = 420; rain <= 1200; rain *= 1.02) {
      const c = blendedBiomeColor(12, rain, 200);
      worst = Math.max(worst, dist(c, last));
      last = c;
    }
    expect(worst).toBeLessThan(0.02);
    // ...but the two ends are still recognisably different biomes.
    expect(dist(blendedBiomeColor(12, 400, 200), blendedBiomeColor(12, 1200, 200))).toBeGreaterThan(0.2);
  });

  it('also blends across temperature, and agrees with the plain biome well inside a zone', () => {
    expect(dist(blendedBiomeColor(24.9, 600, 100), blendedBiomeColor(25.1, 600, 100))).toBeLessThan(0.02);
    const rain = BIOMES[biomeIndex('rainforest')]!.color;
    expect(dist(blendedBiomeColor(27, 4500, 100), rain)).toBeLessThan(0.05);
    const desert = BIOMES[biomeIndex('hotDesert')]!.color;
    expect(dist(blendedBiomeColor(30, 60, 100), desert)).toBeLessThan(0.1);
  });

  it('fades alpine ground and ice in with height, and keeps the coast sharp', () => {
    expect(dist(blendedBiomeColor(5, 800, 3190), blendedBiomeColor(5, 800, 3210))).toBeLessThan(0.02);
    expect(dist(blendedBiomeColor(-8, 300, 6500), BIOMES[biomeIndex('ice')]!.color)).toBeLessThan(0.02);
    expect(dist(blendedBiomeColor(20, 1000, -1), blendedBiomeColor(20, 1000, 1))).toBeGreaterThan(0.2);
  });
});

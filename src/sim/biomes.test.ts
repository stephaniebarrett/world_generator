import { describe, expect, it } from 'vitest';
import { BIOMES, classifyAll, classifyBiome, biomeIndex } from './biomes';

describe('biomes', () => {
  it.each([
    // [T C, P mm, elevation m, expected]
    [27, 3000, 100, 'rainforest'],
    [26, 1400, 200, 'tropicalForest'],
    [25, 600, 300, 'savanna'],
    [28, 80, 400, 'hotDesert'],
    [12, 1000, 200, 'temperateForest'],
    [10, 2200, 200, 'temperateRainforest'],
    [11, 450, 300, 'grassland'],
    [10, 120, 800, 'coldDesert'],
    [0, 600, 300, 'boreal'],
    [-10, 300, 100, 'tundra'],
    [-25, 100, 50, 'ice'],
    [4, 800, 4000, 'alpine'],
    [-2, 400, 6000, 'ice'],
    [20, 900, -200, 'shallowSea'],
    [15, 900, -3500, 'deepSea'],
  ] as const)('T=%d C, P=%d mm, %d m is %s', (t, p, e, expected) => {
    expect(classifyBiome(t, p, e)).toBe(expected);
  });

  it('gives every biome a distinct colour and a unique key', () => {
    expect(new Set(BIOMES.map((b) => b.key)).size).toBe(BIOMES.length);
    expect(new Set(BIOMES.map((b) => b.color.join(','))).size).toBe(BIOMES.length);
  });

  it('classifies a whole field', () => {
    const idx = classifyAll([27, -25], [3000, 100], [100, 100]);
    expect(Array.from(idx)).toEqual([biomeIndex('rainforest'), biomeIndex('ice')]);
  });
});

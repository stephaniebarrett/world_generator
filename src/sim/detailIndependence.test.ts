import { describe, expect, it, vi } from 'vitest';
import { buildLattice } from './lattice';
import { LatticeIndex } from './latticeIndex';
import { prepareWorld } from './setup';
import { SEA_LEVEL_THICKNESS } from './crust';
import { newRecipe, type Edit } from './world';

// Laying out plates and generating land are slow at the finer detail, and the suite runs many tests at once.
vi.setConfig({ testTimeout: 120000 });

/**
 * How often two worlds agree about land and sea at points spread over the globe, and about which points share a plate (plate numbers
 * can differ between levels, so plates are compared by who is grouped with whom).
 */
function agreement(coarse: number, fine: number, seed: string, style: 'continents' | 'archipelago' | 'pangaea' | 'two') {
  const edits: Edit[] = [{ kind: 'generate', style, landFraction: 0.3, seed, time: 0 }];
  const a = prepareWorld({ ...newRecipe(seed, coarse), edits }, buildLattice(coarse));
  const b = prepareWorld({ ...newRecipe(seed, fine), edits }, buildLattice(fine));
  const lb = buildLattice(fine), la = buildLattice(coarse);
  const index = new LatticeIndex(la);
  const points: number[] = [];
  for (let v = 0; v < lb.vertexCount; v += 7) points.push(v);
  const coarseOf = points.map((v) => index.nearest(lb.positions[v * 3]!, lb.positions[v * 3 + 1]!, lb.positions[v * 3 + 2]!));
  let land = 0;
  points.forEach((v, i) => {
    if ((a.world.thickness[coarseOf[i]!]! > SEA_LEVEL_THICKNESS) === (b.world.thickness[v]! > SEA_LEVEL_THICKNESS)) land++;
  });
  let plate = 0, pairs = 0;
  for (let i = 0; i < points.length; i += 3) {
    for (let j = i + 1; j < points.length; j += 41) {
      pairs++;
      if ((a.setup.plateOf[coarseOf[i]!] === a.setup.plateOf[coarseOf[j]!]) === (b.setup.plateOf[points[i]!] === b.setup.plateOf[points[j]!])) plate++;
    }
  }
  return { land: land / points.length, plate: plate / pairs };
}

describe('the same seed at different detail levels', () => {
  it.each(['first-world', 'island', 'timing'])('has the same plates, only drawn more finely (%s)', (seed) => {
    const counts = [32, 63, 89].map((f) => prepareWorld(newRecipe(seed, f), buildLattice(f)).setup.plates.length);
    expect(new Set(counts).size).toBe(1);
    expect(agreement(63, 89, seed, 'continents').plate).toBeGreaterThan(0.97);
  });

  it.each(['first-world', 'island', 'delta', 'timing'])('puts the continents in the same place at medium and high detail (%s)', (seed) => {
    for (const style of ['continents', 'pangaea', 'two'] as const) expect(agreement(63, 89, seed, style).land).toBeGreaterThan(0.9);
  });

  it.each(['island', 'delta', 'timing'])('puts the continents in much the same place at low and medium detail (%s)', (seed) => {
    const { land, plate } = agreement(32, 63, seed, 'continents');
    expect(plate).toBeGreaterThan(0.9);
    expect(land).toBeGreaterThan(0.7); // two unrelated maps with 30% land would agree about 58% of the time
  });

  it('scatters the same islands', () => {
    expect(agreement(24, 48, 'first-world', 'archipelago').land).toBeGreaterThan(0.85);
  });
});

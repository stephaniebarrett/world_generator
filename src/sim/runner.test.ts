import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIMATE } from './climate';
import { buildLattice } from './lattice';
import { climateForThickness, runSimulation, type Frame } from './runner';
import type { BrushEdit } from './world';

const land: BrushEdit = { kind: 'brush', mode: 'land', falloff: 'smooth', radius: 0.7, strength: 1, dabs: [0, 0, 1], time: 0 };
const params = { seed: 'run', frequency: 14, edits: [land], totalMy: 30, stepMy: 1, keyframeMy: 10 };

const collect = async (): Promise<Frame[]> => {
  const frames: Frame[] = [];
  await runSimulation(params, (f) => frames.push(f));
  return frames;
};

describe('runSimulation', () => {
  it('emits a keyframe at t=0 and every keyframe interval', async () => {
    expect((await collect()).map((f) => f.time)).toEqual([0, 10, 20, 30]);
  });

  it('is deterministic', async () => {
    const a = await collect();
    const b = await collect();
    for (let i = 0; i < a.length; i++) {
      expect(Array.from(a[i]!.thickness)).toEqual(Array.from(b[i]!.thickness));
      expect(Array.from(a[i]!.plate)).toEqual(Array.from(b[i]!.plate));
    }
  });

  it('starts from the painted world and then changes it', async () => {
    const frames = await collect();
    const first = frames[0]!.thickness;
    const last = frames[frames.length - 1]!.thickness;
    expect(Math.max(...first)).toBeGreaterThan(24); // the painted land: crust thick enough to stand above sea level
    expect(Array.from(first)).not.toEqual(Array.from(last)); // tectonics moved things
  });

  it('measures height from the chosen sea level: a hill is warmer when the sea is higher', () => {
    const l = buildLattice(params.frequency);
    const thickness = new Float32Array(l.vertexCount).fill(7);
    let hill = 0;
    for (let v = 0; v < l.vertexCount; v++) if (l.positions[v * 3 + 2]! > l.positions[hill * 3 + 2]!) hill = v;
    thickness[hill] = 45; // about 2.6 km above the default sea level
    const at = (seaLevel: number) => climateForThickness(params.frequency, thickness, { ...DEFAULT_CLIMATE, seaLevel }).temperature[hill]!;
    // The lapse rate is 6.5 C per km, so 1 km less height is about 6.5 C warmer.
    expect(at(1000) - at(0)).toBeGreaterThan(4);
    expect(at(0) - at(-1000)).toBeGreaterThan(4);
  });
});

describe('runSimulation with climate elsewhere', () => {
  it('gives the same result however late the climate arrives', async () => {
    const slow = {
      climate: async (thickness: Float32Array, rock: Uint8Array) => {
        await new Promise((r) => setTimeout(r, 30)); // arrives well after the next steps have run
        return climateForThickness(params.frequency, thickness, undefined, rock);
      },
      yield: () => new Promise<void>((r) => setTimeout(r, 1)),
    };
    const frames: Frame[] = [];
    await runSimulation(params, (f) => frames.push(f), undefined, slow);
    const reference = await collect();
    expect(frames.map((f) => f.time)).toEqual([0, 10, 20, 30]);
    for (let i = 0; i < frames.length; i++) expect(Array.from(frames[i]!.thickness)).toEqual(Array.from(reference[i]!.thickness));
  });
});

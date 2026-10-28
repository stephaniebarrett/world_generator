import { describe, expect, it } from 'vitest';
import { DEFAULT_PLANET, parseWorld, serializeWorld, toWorldFile } from './world-file';
import { SIM_VERSION, newRecipe, type BrushEdit } from './sim/world';

const edit: BrushEdit = { kind: 'brush', mode: 'land', falloff: 'smooth', radius: 0.3, strength: 0.6, dabs: [0, 0, 1, 0, 1, 0], time: 0 };
const recipe = { ...newRecipe('my seed', 32), edits: [edit] };

describe('world file', () => {
  it('round-trips a recipe and planet settings exactly', () => {
    const file = toWorldFile(recipe, { tiltDegrees: 12, spin: -1, seaLevel: 350 });
    expect(parseWorld(serializeWorld(file))).toEqual(file);
  });

  it('falls back to default planet settings when they are missing or bad', () => {
    const file = JSON.parse(serializeWorld(toWorldFile(recipe, DEFAULT_PLANET)));
    delete file.planet;
    expect(parseWorld(JSON.stringify(file)).planet).toEqual(DEFAULT_PLANET);
    file.planet = { tiltDegrees: 400, spin: 3 };
    expect(parseWorld(JSON.stringify(file)).planet).toEqual(DEFAULT_PLANET);
  });

  it('reads files saved before sea level existed, and ignores an absurd sea level', () => {
    const file = JSON.parse(serializeWorld(toWorldFile(recipe, { tiltDegrees: 30, spin: 1, seaLevel: 0 })));
    delete file.planet.seaLevel;
    expect(parseWorld(JSON.stringify(file)).planet).toEqual({ tiltDegrees: 30, spin: 1, seaLevel: 0 });
    file.planet.seaLevel = 99999;
    expect(parseWorld(JSON.stringify(file)).planet.seaLevel).toBe(0);
  });

  it.each([
    ['not json', 'nope{', /not valid JSON/],
    ['wrong format', JSON.stringify({ format: 'other' }), /not a world-generator file/],
    ['future file version', JSON.stringify({ format: 'world-generator', version: 99 }), /newer version/],
    ['no recipe', JSON.stringify({ format: 'world-generator', version: 1 }), /no recipe/],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseWorld(text)).toThrow(message);
  });

  const withRecipe = (patch: Record<string, unknown>) => JSON.stringify({ format: 'world-generator', version: 1, recipe: { ...recipe, ...patch } });

  it('rejects a bad detail level, a future simulation, and malformed edits', () => {
    expect(() => parseWorld(withRecipe({ frequency: 0 }))).toThrow(/detail/);
    expect(() => parseWorld(withRecipe({ frequency: 2.5 }))).toThrow(/detail/);
    expect(() => parseWorld(withRecipe({ simVersion: SIM_VERSION + 1 }))).toThrow(/newer simulation/);
    expect(() => parseWorld(withRecipe({ edits: [{ ...edit, mode: 'explode' }] }))).toThrow(/edit 0: unknown mode/);
    expect(() => parseWorld(withRecipe({ edits: [edit, { ...edit, dabs: [1, 2] }] }))).toThrow(/edit 1: dabs/);
    expect(() => parseWorld(withRecipe({ edits: [{ ...edit, radius: -1 }] }))).toThrow(/radius/);
    expect(() => parseWorld(withRecipe({ edits: [{ ...edit, strength: 'x' }] }))).toThrow(/strength/);
    expect(() => parseWorld(withRecipe({ edits: [null] }))).toThrow(/not an object/);
  });

  it('drops unknown extra fields rather than passing them through', () => {
    const file = JSON.parse(serializeWorld(toWorldFile(recipe, DEFAULT_PLANET)));
    file.recipe.edits[0].evil = '<script>';
    expect(JSON.stringify(parseWorld(JSON.stringify(file)))).not.toContain('evil');
  });

  it('round-trips plate edits and rejects malformed ones', () => {
    const edits = [
      { kind: 'addPlate', center: [1, 0, 0], radius: 0.3, axis: [0, 0, 1], angularSpeed: 0.006, time: 0 },
      { kind: 'removePlate', at: [0, 1, 0], mode: 'reset', time: 0 },
      { kind: 'dragPlate', from: [0, 0, 1], to: [1, 0, 0], time: 0 },
      { kind: 'paintPlate', from: [1, 0, 0], radius: 0.1, dabs: [1, 0, 0, 0, 1, 0], time: 0 },
      { kind: 'splitPlate', at: [0, 1, 0], time: 0 },
      { kind: 'erode', my: 10, time: 30 },
    ] as const;
    const file = toWorldFile({ ...recipe, edits: [...edits] }, DEFAULT_PLANET);
    expect(parseWorld(serializeWorld(file))).toEqual(file);

    const bad = (patch: object) => JSON.stringify({ format: 'world-generator', version: 1, recipe: { ...recipe, edits: [patch] } });
    expect(() => parseWorld(bad({ ...edits[0], center: [1, 0] }))).toThrow(/center must be three numbers/);
    expect(() => parseWorld(bad({ ...edits[0], axis: [5, 5, 5] }))).toThrow(/axis must be a unit vector/);
    expect(() => parseWorld(bad({ ...edits[0], angularSpeed: 3 }))).toThrow(/angularSpeed/);
    expect(() => parseWorld(bad({ ...edits[1], mode: 'delete' }))).toThrow(/unknown mode/);
    expect(() => parseWorld(bad({ ...edits[2], to: 'x' }))).toThrow(/to must be three numbers/);
    expect(() => parseWorld(bad({ ...edits[3], dabs: [1, 2] }))).toThrow(/dabs must be/);
    expect(() => parseWorld(bad({ ...edits[3], radius: 9 }))).toThrow(/radius/);
    expect(() => parseWorld(bad({ kind: 'erode', my: -1, time: 0 }))).toThrow(/my out of range/);
    expect(() => parseWorld(bad({ kind: 'nuke', time: 0 }))).toThrow(/unknown kind/);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIMATE, prevailingWind } from '../sim/climate';
import { windArrowLines } from './wind';

const sin = (deg: number) => Math.sin((deg * Math.PI) / 180);

describe('prevailing wind', () => {
  it('blows the way Earth\'s belts do: trades from the east, westerlies from the west, polar easterlies', () => {
    const [tradeE, tradeN] = prevailingWind(sin(15), DEFAULT_CLIMATE);
    expect(tradeE).toBeLessThan(-0.5);
    expect(tradeN).toBeLessThan(0); // toward the equator
    const [westE, westN] = prevailingWind(sin(45), DEFAULT_CLIMATE);
    expect(westE).toBeGreaterThan(0.25);
    expect(westN).toBeGreaterThan(0); // toward the pole
    expect(prevailingWind(sin(78), DEFAULT_CLIMATE)[0]).toBeLessThan(-0.3);
    // The southern hemisphere mirrors the north.
    expect(prevailingWind(sin(-15), DEFAULT_CLIMATE)[1]).toBeGreaterThan(0);
    expect(prevailingWind(sin(-45), DEFAULT_CLIMATE)[1]).toBeLessThan(0);
  });

  it('reverses with the planet\'s spin', () => {
    expect(prevailingWind(sin(45), { ...DEFAULT_CLIMATE, spin: -1 })[0]).toBeLessThan(-0.25);
  });
});

describe('wind arrows', () => {
  it('lie on the surface, in whole barbed arrows, leaving out calm belts', () => {
    const lines = windArrowLines(DEFAULT_CLIMATE, () => 1, 0);
    expect(lines.length).toBeGreaterThan(300);
    expect(lines.length % 18).toBe(0); // 3 segments x 2 ends x 3 numbers per arrow
    for (let i = 0; i < lines.length; i += 3) expect(Math.abs(Math.hypot(lines[i]!, lines[i + 1]!, lines[i + 2]!) - 1)).toBeLessThan(1e-9);
  });
});

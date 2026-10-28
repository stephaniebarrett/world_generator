import { describe, expect, it } from 'vitest';
import { MAX_SIDE_WIDTH, MIN_SIDE_WIDTH, clampSideWidth } from './sidePanel';

describe('clampSideWidth', () => {
  it('keeps the panel between its smallest and largest width', () => {
    expect(clampSideWidth(50, 1600)).toBe(MIN_SIDE_WIDTH);
    expect(clampSideWidth(2000, 2400)).toBe(MAX_SIDE_WIDTH);
    expect(clampSideWidth(300, 1600)).toBe(300);
  });
  it('leaves room for the globe on a narrow window', () => {
    expect(clampSideWidth(500, 700)).toBe(380);
    expect(clampSideWidth(500, 400)).toBe(MIN_SIDE_WIDTH);
  });
});

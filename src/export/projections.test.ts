import { describe, expect, it } from 'vitest';
import { PROJECTIONS, orthographic, projectionByKey } from './projections';

const DEG = Math.PI / 180;
const samples: Array<[number, number]> = [];
for (const lat of [-80, -45, -10, 0, 15, 40, 70]) for (const lon of [-170, -90, -20, 0, 35, 110, 175]) samples.push([lat * DEG, lon * DEG]);

describe('projections', () => {
  for (const p of PROJECTIONS) {
    it(`${p.name}: inverse undoes forward`, () => {
      let tested = 0;
      for (const [lat, lon] of samples) {
        const xy = p.forward(lat, lon);
        if (!xy) continue; // not shown (far side of the globe, wrong hemisphere, past Mercator's limit)
        expect(Math.abs(xy[0])).toBeLessThanOrEqual(1 + 1e-9);
        expect(Math.abs(xy[1])).toBeLessThanOrEqual(1 + 1e-9);
        const back = p.inverse(xy[0], xy[1]);
        expect(back).not.toBeNull();
        expect(back![0]).toBeCloseTo(lat, 4);
        // Longitude is meaningless at the poles.
        expect(Math.cos(back![1] - lon)).toBeCloseTo(1, 3);
        tested++;
      }
      expect(tested).toBeGreaterThan(8);
    });
  }

  it('puts the equator on the centre line and the date line at the edge on the flat maps', () => {
    for (const key of ['equirectangular', 'robinson', 'winkel-tripel', 'mollweide', 'gall-peters']) {
      const p = PROJECTIONS.find((q) => q.key === key)!;
      expect(p.forward(0, 0)![1]).toBeCloseTo(0, 9);
      expect(p.forward(0, Math.PI)![0]).toBeCloseTo(1, 4);
      expect(p.forward(0, -Math.PI)![0]).toBeCloseTo(-1, 4);
    }
  });

  it('is equal-area for Mollweide and Gall-Peters: a band at the pole and a band at the equator of the same sphere area take the same image area', () => {
    for (const key of ['mollweide', 'gall-peters']) {
      const p = PROJECTIONS.find((q) => q.key === key)!;
      // Image area of a latitude band, per unit of longitude, by numeric integration over the image.
      const bandArea = (lat0: number, lat1: number) => {
        let n = 0;
        const N = 400;
        for (let i = 0; i < N; i++)
          for (let j = 0; j < N; j++) {
            const x = -1 + (2 * (i + 0.5)) / N, y = -1 + (2 * (j + 0.5)) / N;
            const ll = p.inverse(x, y);
            if (ll && ll[0] >= lat0 && ll[0] < lat1) n++;
          }
        return n;
      };
      // Equal sphere area means equal height in sin(latitude): 0.25 for both the cap and this equatorial band.
      const equator = bandArea(Math.asin(-0.125), Math.asin(0.125));
      const polarBand = bandArea(Math.asin(0.75), Math.PI / 2 + 0.01);
      expect(polarBand / equator).toBeCloseTo(1, 1);
    }
  });

  it('shows only the near side in the globe view and respects the viewing point', () => {
    const p = orthographic({ lat: 0, lon: 0 });
    expect(p.forward(0, 0)).toEqual([0, 0]);
    expect(p.forward(0, Math.PI)).toBeNull();
    expect(p.inverse(1.2, 0)).toBeNull();
    const east = p.forward(0, 30 * DEG)!;
    expect(east[0]).toBeCloseTo(0.5, 6);
  });

  it('draws each pole in the middle of its polar view and only its own hemisphere', () => {
    const north = PROJECTIONS.find((q) => q.key === 'polar-north')!;
    const south = PROJECTIONS.find((q) => q.key === 'polar-south')!;
    expect(north.forward(Math.PI / 2, 1)).toEqual([0, -0]);
    expect(north.forward(-0.1, 0)).toBeNull();
    expect(south.forward(0.1, 0)).toBeNull();
    expect(south.forward(-Math.PI / 2, 0)![0]).toBeCloseTo(0, 9);
  });

  it('Robinson table is monotonic and hits its published end values', () => {
    const p = PROJECTIONS.find((q) => q.key === 'robinson')!;
    expect(p.forward(Math.PI / 2, 0)![1]).toBeCloseTo(1, 4);
    expect(p.forward(Math.PI / 2, Math.PI)![0]).toBeCloseTo(0.5322, 3);
    let last = -1;
    for (let d = 0; d <= 90; d += 5) {
      const y = p.forward(d * DEG, 0)![1];
      expect(y).toBeGreaterThan(last);
      last = y;
    }
  });
});

describe('map centre', () => {
  it('puts the chosen point in the middle of the globe view', () => {
    const p = projectionByKey('orthographic', { lat: 0.6, lon: -1.2 });
    const [x, y] = p.forward(0.6, -1.2)!;
    expect(Math.abs(x)).toBeLessThan(1e-9);
    expect(Math.abs(y)).toBeLessThan(1e-9);
  });

  it('turns a flat map to put the chosen meridian in the middle, and back again', () => {
    for (const key of ['equirectangular', 'mercator', 'robinson', 'winkel', 'mollweide']) {
      const base = projectionByKey(key);
      const turned = projectionByKey(key, { lat: 0, lon: 2 });
      const [x0, y0] = base.forward(0.3, 0)!;
      const [x1, y1] = turned.forward(0.3, 2)!;
      expect(x1).toBeCloseTo(x0, 9); // the meridian we turned to now sits where 0 degrees did
      expect(y1).toBeCloseTo(y0, 9);
      const back = turned.inverse(x1, y1)!;
      expect(back[1]).toBeCloseTo(2, 6);
      expect(back[0]).toBeCloseTo(0.3, 6);
    }
  });
});

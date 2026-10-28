// Whittaker-style biomes from annual mean temperature (C), annual precipitation (mm) and elevation (m).
// Ocean, ice and alpine are overrides; everything else is a lookup on the temperature and rainfall grid.

export const BIOMES = [
  { key: 'deepSea', name: 'Deep ocean', color: [0.05, 0.14, 0.32] },
  { key: 'shallowSea', name: 'Shallow sea', color: [0.2, 0.5, 0.62] },
  { key: 'ice', name: 'Ice cap', color: [0.93, 0.96, 0.98] },
  { key: 'tundra', name: 'Tundra', color: [0.67, 0.72, 0.62] },
  { key: 'boreal', name: 'Boreal forest', color: [0.2, 0.42, 0.33] },
  { key: 'coldDesert', name: 'Cold desert', color: [0.72, 0.68, 0.6] },
  { key: 'grassland', name: 'Temperate grassland', color: [0.68, 0.74, 0.38] },
  { key: 'temperateForest', name: 'Temperate forest', color: [0.25, 0.55, 0.25] },
  { key: 'temperateRainforest', name: 'Temperate rainforest', color: [0.1, 0.45, 0.35] },
  { key: 'hotDesert', name: 'Hot desert', color: [0.88, 0.76, 0.46] },
  { key: 'savanna', name: 'Savanna', color: [0.78, 0.7, 0.3] },
  { key: 'tropicalForest', name: 'Tropical seasonal forest', color: [0.35, 0.62, 0.2] },
  { key: 'rainforest', name: 'Tropical rainforest', color: [0.05, 0.4, 0.15] },
  { key: 'alpine', name: 'Alpine', color: [0.6, 0.58, 0.55] },
] as const;

export type BiomeKey = (typeof BIOMES)[number]['key'];
export const biomeIndex = (key: BiomeKey): number => BIOMES.findIndex((b) => b.key === key);

/** Shallow sea is the continental shelf; below this depth is deep ocean. */
export const SHELF_DEPTH_M = -1000;
/** Land above this is alpine, whatever the climate; above the snow line it is ice. */
export const ALPINE_M = 3200;
export const SNOW_LINE_M = 5200;

export function classifyBiome(temperatureC: number, precipitationMm: number, elevationM: number): BiomeKey {
  if (elevationM <= 0) return elevationM > SHELF_DEPTH_M ? 'shallowSea' : 'deepSea';
  if (temperatureC < -15 || elevationM > SNOW_LINE_M) return 'ice';
  if (elevationM > ALPINE_M && temperatureC < 8) return 'alpine';
  if (temperatureC < -5) return 'tundra';
  if (temperatureC < 5) return precipitationMm < 250 ? 'coldDesert' : 'boreal';
  if (temperatureC < 20) {
    if (precipitationMm < 250) return 'coldDesert';
    if (precipitationMm < 700) return 'grassland';
    if (precipitationMm < 1600) return 'temperateForest';
    return 'temperateRainforest';
  }
  if (precipitationMm < 300) return 'hotDesert';
  if (precipitationMm < 1000) return 'savanna';
  if (precipitationMm < 2000) return 'tropicalForest';
  return 'rainforest';
}

/** Biome index per lattice vertex. */
export function classifyAll(temperature: ArrayLike<number>, precipitation: ArrayLike<number>, elevation: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(elevation.length);
  for (let v = 0; v < out.length; v++) out[v] = biomeIndex(classifyBiome(temperature[v]!, precipitation[v]!, elevation[v]!));
  return out;
}

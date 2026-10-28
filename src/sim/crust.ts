// Crust constants and isostasy, kept in their own module so the other simulation files can share them
// without importing each other in a circle.
//
// Calibrated to two measured anchors: oceanic crust is about 7 km thick and sits near -4,000 m;
// continental crust is about 35 km thick and sits near +840 m (its mean height). Joining those
// gives about 173 m of surface per km of crust, with sea level at about 30 km thickness.
// (Airy isostasy gives 0.15-0.2: 1 - rho_crust / rho_mantle with 2.8 and 3.3 g/cm^3.)

/** Crust thickness (km): typical sea floor. */
export const OCEAN_THICKNESS = 7;
/** Painted land: broad lowlands at about +500 m; the Raise brush builds ranges above that. */
export const LAND_THICKNESS = 33;
/** Crust thickness (km) at which the surface sits at sea level. */
export const SEA_LEVEL_THICKNESS = 30.1;
/** Metres of surface height per km of crust thickness. */
export const METRES_PER_KM = 173;
/** Limits on crust thickness: the thinnest stretched crust, and the thickest orogens (Tibet and the Andes, 70-80 km). */
export const MIN_THICKNESS = 3;
export const MAX_THICKNESS = 80;

export function elevationFromThickness(thicknessKm: number): number {
  return (thicknessKm - SEA_LEVEL_THICKNESS) * METRES_PER_KM;
}

/**
 * Depth of the sea floor (m below sea level) by age in My: new crust at a ridge is hot and buoyant (about 2,500 m deep) and sinks
 * as it cools, 350 m x sqrt(age) at first, then flattening toward about 5,400 m (Parsons-Sclater and Stein and Stein, trimmed so the basin average matches the ocean's).
 * Written with only + - * / sqrt so it is identical on every machine.
 */
export function oceanDepth(ageMy: number): number {
  if (ageMy <= 20) return 2500 + 350 * Math.sqrt(Math.max(0, ageMy));
  const x = (ageMy - 20) / 35;
  return 5400 - 1335 / (1 + x * x);
}

/**
 * The thickness that gives sea floor its age-depth height: the sea floor is given the depth its age implies, and keeps whatever
 * it has beyond plain sea floor (a plateau or an arc is still higher than the floor around it). Crust above 22 km is unchanged.
 */
export function thermalThickness(thicknessKm: number, ageMy: number): number {
  const w = Math.min(1, Math.max(0, (22 - thicknessKm) / 10));
  if (w === 0) return thicknessKm;
  return thicknessKm + w * (SEA_LEVEL_THICKNESS - oceanDepth(ageMy) / METRES_PER_KM - OCEAN_THICKNESS);
}

// --- rock ------------------------------------------------------------------------------------

/**
 * Rock types. `erodibility` scales how fast rivers and slopes wear the rock. The values are scaled so that typical land
 * (about two-thirds sedimentary cover, a quarter craton, the rest other) averages about 1, which keeps the overall
 * erosion rate where it was calibrated; hard crystalline rock is several times more resistant than soft sediment. `weakness` scales how readily plate motion deforms it, so uplift and
 * rifting concentrate in weak crust and old cores (cratons) resist: mountains form at their margins, not through them.
 */
export const ROCKS = [
  { key: 'basalt', name: 'Oceanic basalt', erodibility: 0.7, weakness: 1.0, color: [0.2, 0.26, 0.34] },
  { key: 'craton', name: 'Craton (granite and gneiss)', erodibility: 0.3, weakness: 0.35, color: [0.66, 0.46, 0.46] },
  { key: 'sedimentary', name: 'Sedimentary rock', erodibility: 1.4, weakness: 1.4, color: [0.84, 0.74, 0.46] },
  { key: 'volcanic', name: 'Volcanic rock', erodibility: 1.1, weakness: 1.0, color: [0.6, 0.24, 0.18] },
  { key: 'metamorphic', name: 'Metamorphic (mountain roots)', erodibility: 0.45, weakness: 0.6, color: [0.5, 0.44, 0.64] },
  { key: 'sediment', name: 'Fresh sediment', erodibility: 2.2, weakness: 1.5, color: [0.92, 0.88, 0.64] },
  { key: 'limestone', name: 'Limestone (karst)', erodibility: 1.4, weakness: 1.4, color: [0.72, 0.8, 0.86] },
] as const;

export const ROCK = { basalt: 0, craton: 1, sedimentary: 2, volcanic: 3, metamorphic: 4, sediment: 5, limestone: 6 } as const;

/** Crust thicker than this (km) has been squeezed hard enough in a collision to turn metamorphic. */
export const METAMORPHIC_THICKNESS = 48;

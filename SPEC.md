# World Generator: Design Spec (v1)

A browser tool for building plausible, seed-reproducible planets for RPG and fantasy use. You rough out land, set up tectonic plates, and the tool simulates tectonics, erosion and climate into a physical world.

## Stack
- Client-only TypeScript + Vite + Three.js (WebGL). No backend.
- Simulation runs in a Web Worker.

## Determinism and the recipe
- The same recipe must give identical results on any browser, hardware and app version.
  - Seeded integer PRNG; no `Math.random`.
  - No reliance on engine-specific `sin/cos/exp` precision in the sim (plain arithmetic or own implementations).
  - Fixed iteration order. Versioned sim, so old recipes replay with old rules.
- A world is its recipe: `seed + sim version + simulation detail + ordered edit log + sim settings`.
- Every edit is stored by position on the sphere (lat/lon, radius, strength), never by id, so a recipe replays at any simulation detail. Different detail levels give similar but not identical worlds; each is reproducible.
- Each edit carries the sim time at which it was made. Undo/redo comes from the log. Raw snapshots are only a cache or export.
- Autosave the recipe to IndexedDB. Export/import as JSON. Share a bare seed by URL. No accounts.

## Data model
- **Crust sample points**: a fixed seeded set on the vertices of a subdivided icosahedron (adjustable detail, presets about 10k / 40k / 160k points, changeable later by replaying the recipe).
- Each point carries: plate id, thickness, density, age. No continental/oceanic label and no plate type. A plate can carry both land and seafloor.
- Elevation is derived from thickness and density. Sea level is only the threshold where elevation reads as land.
- Each plate has a rotation axis and speed and moves its points by rigid rotation, so drift and dragging move the terrain data itself.
- Every point belongs to exactly one plate, so the globe is always covered: new thin seafloor points are added where plates pull apart; points go under or pile up where plates converge.
- **View mesh**: the hex/Voronoi dual of a subdivided icosahedron, render-only. Drawn from the nearest sample points. Its detail is a separate viewing setting that changes instantly (defaults to follow simulation detail, with override).

## Rendering
- One sphere mesh displaced by elevation, vertex colours, smooth shading by default, cell-edge toggle, vertical exaggeration slider, ocean surface, simple atmosphere shading.
- Switchable layers: elevation, plates, temperature, rainfall, winds, biomes.

## Setup and editing
- Start by painting land on the globe (primary) or from a seeded random start. Importing an equirectangular image is deferred to a future version.
- The sim then makes 8 to 12 plates from the seed, shown as an editable overlay.
  - Plates are grown around landmasses first, so each connected landmass sits wholly in one plate (small ones may share). Remaining plates fill the ocean. Keeping landmasses whole wins over the plate count.
  - A landmass larger than about a quarter of the globe is split into two or three plates along a seeded, noisy boundary.
  - Painted land becomes thick buoyant crust, painted ocean thin dense crust.
- **Raise/lower brush**: radius, strength, falloff (smooth / linear / flat-top). It edits thickness; elevation follows. Smooth/flatten tool. One edit-log entry per stroke.
- **Add a plate**: click a spot, drag out a radius, drag an arrow for direction and speed. Points inside become the new plate, keeping their crust.
- **Remove a plate**: prompt with Reset (preselected) or Keep crust. Reset points are filled by blending outward from bordering plates (interpolated thickness/density/age with small seeded noise, ocean-floor-like unless neighbours are land-thick) and join the neighbour with the longest shared border.
- **Drag a plate**: only at time zero. The plate carries its points and shifts over the globe. Points it lands on are replaced; space it leaves is claimed by bordering neighbours via the blend fill. No gaps or overlaps. Mid-run, steer a plate by editing its direction and speed arrow instead.

## Simulation
- Run is one-shot with a timeline scrubber. Default 200 My, 1 My steps, keyframe every 10 My; all adjustable per world.
- An edit applies at the scrubbed time and replays forward from the nearest earlier keyframe; later keyframes are discarded.
- Tectonics and erosion run every step. Climate is recomputed at each keyframe and reused between, plus a **Recompute climate** button for the scrubbed time (not an edit-log entry).
- **Plate borders**: relative velocity is split into a part across the border (toward = convergent, away = divergent) and a part along it (transform). All three effects apply in proportion; the names label whichever part dominates.
  - Convergent: denser or older crust dives under (trench, volcanic arc); two thick buoyant sides collide and build mountains.
  - Divergent: rifting and thinning; new thin seafloor points fill the gap (rift valleys on land).
  - Transform: no crust made or destroyed; seeded wavy fault line shifts crust sideways, throws ripples along the fault, opens pull-apart basins at opening bends and pressure ridges at closing bends.
  - Effects fade smoothly with distance from the border, over a width growing with relative speed and crust thickness (a few hundred km for a fast collision, much less for a slow slide), and stack where borders are near.
- **Erosion**: stream-power river erosion, slope-based erosion, sediment deposition.
- **Climate** (plausible, not a full model): latitude sunlight, three wind bands per hemisphere bent by land, wind-carried moisture with rain shadows, simple ocean gyres, 2 to 4 seasons.
- **Planet settings**: sea level, axial tilt, spin direction. Radius stays Earth-sized.

## Outputs (v1: physical world only)
Elevation, temperature, precipitation, winds, ocean currents, rivers and lakes, biomes, tectonic hazards (volcanoes, quake zones). Export PNG maps (heightmap, biome map, several projections) and JSON. No civilization layers (borders, cities, resources, names) in v1.

## Deferred
- Importing an equirectangular image as the starting land (moved to a future version).
- Adaptive detail by terrain steepness.
- Pushing other plates aside when dragging.
- Civilization layers.

## Details settled after the first draft
- **Biomes**: Whittaker-style, about a dozen land biomes from temperature and precipitation; ocean, ice cap and alpine are overrides; elevation can force a biome.
- **Rivers and lakes**: fill terrain depressions for lakes; route runoff downhill to the sea or a lake for rivers; draw rivers as lines whose width follows flow; rivers carve terrain during erosion.
- **Export projections**: equirectangular (default), Mercator, Robinson, Winkel tripel, Mollweide, Gall-Peters, orthographic (from a chosen point), north and south polar azimuthal. All closed-form maths.
- **Layout**: full-window globe with orbit and zoom; left toolbar (paint, brush, add/remove plate, drag); bottom timeline scrubber; right panel for layers and settings.
- **Analysis grid**: erosion and climate run on a hidden grid on the same lattice, resampled from the crust points each step. Only the view mesh is purely for rendering.

---

# Status: what is built (as of this build)

Run it with `npm install && npm run dev`; tests with `npm test` (119 tests); `npm run build` makes a static site.
Scripts in `scripts/` drive the app in headless Chrome and save screenshots (they need the dev server running).

## Built and checked in a real browser
- Full-window globe on a hex/Voronoi view mesh, lifted by elevation (exaggeration slider, default 40x; sea floor shown at 30%),
  lit from beside the camera; overlay tool, settings and timeline panels; z-up camera.
- Plate outlines: a checkbox draws plate borders over any layer, before and after a simulation, following the scrubber.
- Reference lines you can switch on: rotation axis, equator, tropics (at the tilt), polar circles (at 90 degrees minus the tilt).
- Pointer readout: latitude, longitude, height, and temperature and rainfall once climate exists.
- Painting land, ocean, raise, lower with an adjustable Strength (default: about 255 m of height per pass); undo; plate tools: add (with motion arrow), remove (reset or keep crust), drag.
- Seeded plates grown around whole landmasses (huge ones split along noisy boundaries); plate motion arrows.
- Tectonics on travelling crust points: border interaction by closing / opening / shear, subduction, collision, rifting,
  transform ripples; crust count held steady; worker-based run with keyframes and a scrubber.
- Erosion (stream power, hillslope diffusion, sediment to sea or pits) on the lattice, in rock metres with isostasy.
- Climate: temperature, winds, rain belts and rain shadows, 4 seasons (annual means shown), planet tilt and spin,
  Recompute climate button. Rain belts fitted to Earth's zonal rainfall.
- Rivers and lakes; 14 Whittaker-style biomes.
- Autosave (IndexedDB), `?seed=` links, JSON save/open with validation, PNG export in 9 projections.

## Terrain notes
- Painted land starts at about 1,250 m (29 km of crust) and gets seeded fractal roughness (up to about 0.9 km of surface on high ground,
  none on sea floor). The roughness is a function of position, so the same hills appear at any detail.
  Worlds opened from older saves therefore look different from before.
- Height range: crust is limited to 3-80 km (-4,700 m to +8,600 m with the 30.1 km sea-level crust).
- Rivers: only those above a chosen percentile of land flow are drawn (slider, default top 4%), with a fixed sideways bend per hop.
  The bends are drawn, not simulated; the flow itself still follows the steepest descent.

## Differences from the plan above
- Density is derived from thickness and age, not stored.
- Plate edits (add / remove / drag) are applied after all painting, to the plates generated from the painted land.
- Edits clear the simulation (re-run to see their effect); edits at the scrubbed time with replay from keyframes
  are NOT built yet.

## Built since: planet and export settings
- Sea level (planet setting, -1000 to +2000 m, saved with the world): the sea covers whatever lies below it; the drawn heights, colours, hover readout, climate and
  rivers all measure height from it, and releasing the slider recomputes the climate. Old files open with sea level 0.
- Map centre for export: latitude and longitude boxes (and a button to take them from the current view). The globe view looks at that point; flat and polar maps are
  turned to put that meridian in the middle, so the seam can be moved off a continent.

## Not built yet
- Edits at a scrubbed time, replayed from keyframes; steering a plate mid-run by its arrow.
- Seasonal display (decided against for now: climate shows the annual mean).

## Built since: rain, wind and rivers
- Erosion follows the rain: each point's rainfall (annual mean, relative to 1000 mm) weights the water a river carries (so wet basins cut harder, deserts
  barely) and the speed of hillslope weathering. The simulation refreshes rainfall from its own climate at every keyframe (10 My). Land share and
  mean height stayed on target over 200 My (3 seeds: land 31-34%, mean land height 840-1130 m).
- Prevailing winds: a toggle draws arrows on a latitude grid along the year-round mean surface wind (trades, westerlies, polar easterlies), following tilt and spin.
- Rivers are drawn as smooth curves through the river network (Catmull-Rom through neighbouring vertices) with a meander on top. The meander is wide on
  flat, soft ground (floodplain) and nearly absent on steep slopes or hard rock (craton, metamorphic), so mountain streams run straight and lowland rivers wander.

## Built since: hotspots, ocean depth, faults, karst
- Ocean age-depth: sea floor sinks as it cools, from about 2,500 m at a ridge (350 m x sqrt(age)) to about 5,400 m when old. Frames show each sea-floor point at the
  depth its age implies (plateaus and arcs keep their extra height); the crust itself is unchanged, so the tectonics calibration is untouched. The painted world
  before a run still shows flat 4,000 m sea floor, so frame 0 differs from it. Mean ocean depth in runs: about 4,500-4,900 m (Earth's basins 4,000-4,500; no continental shelves are modelled).
- Hotspots: 10 mantle plumes per run, fixed in space (placed from the seed). Crust within 220 km of one gains up to 5 km/My, so a drifting plate grows a chain of volcanoes
  (volcanic rock). An unfed oceanic volcano sinks and wears at 3% of its height per My. Island arcs, fed by subduction, stay.
- Faults: each crust point carries a scar (0-1) that builds with the slip and squeezing it sees and heals over hundreds of My. Scarred rock deforms up to 2.5x more easily
  and erodes up to 1.75x faster, so old transforms and sutures are where later mountains and rifts concentrate.
- Karst: a patchy third of the sedimentary cover (more in the tropics) is limestone. In the simulation it dissolves up to 1.8x faster at 1,500 mm/yr; in the river model it
  sheds only 35% of its rain (the rest sinks underground), so rivers over it are small. Land share and heights were unchanged over 200 My on 3 seeds (land 31-34%).

## Built since: run and detail settings, smooth biomes
- Keyframe spacing (World panel): a run is saved to the timeline every 5, 10, 15 or 20 My (always including the last step); the timeline ticks follow the spacing the run was made with.
  The physics step stays 1 My, so a wider spacing only skips climate passes and saved frames, which makes runs faster.
- Two finer presets for both Simulation and Render detail: Fine (~324k points) and Ultra (~576k points). Fine loads and draws in about a minute in the browser; Ultra is untested there.
- Biome colours blend smoothly: the land climate grid is blurred (about 2.5 C and a quarter of a doubling of rainfall), and alpine ground and ice fade in over a few hundred metres of height. The coastline stays sharp.

## Terrain, geology and calibration (added since)
- Generate builds real terrain (collision ranges, Andean coasts, trenches, island arcs, rifts, ridges, ancient belts) from the plate boundaries.
- Every crust point carries a rock type (basalt, craton, sedimentary, volcanic, metamorphic, sediment) that travels with it. Rock sets how fast
  it erodes and how much it deforms; squeezed crust turns metamorphic, arc magma makes volcanic rock, deposits become soft sediment.
  Both erosion paths (terrain pre-pass and the simulation) use the local rock; a test checks identical hills on craton and sedimentary rock wear differently.
- Arc volcanism returns a share of subducted crust to the overriding plate; this fixed the steady land loss. Colliding plates lock together.
- Rivers keep sediment only for big basins (deltas); small rivers export it to sea.
- Over 200 My on generated worlds (4 seeds): land share about 29% -> 26.5% (Earth steady near 29%), mean land height 834 m (Earth 840),
  11% of land above 2 km (Earth ~10%), crust turnover 0.50%/My (Earth 0.67), global rain 1025 mm (Earth 990), mean temperature about 14 C.
- Hotspots, ocean age-depth, fault scars and karst are now modelled (see 'Built since: hotspots, ocean depth, faults, karst').

## Terrain shape and plate layout (revised)
- Ranges have a high core with long foothills and plateaus; thick crust levels off smoothly (no flat 80 km ceiling), so peaks differ in height.
- Ranges come and go along a boundary: about a third of any boundary raises little or nothing, and slow boundaries only raise low relief.
  Old fold belts vary from low worn hills to real ranges, each with a foothill apron; hill country is patchy (rolling in places, plain in others).
- Plate layout: uneven seed spacing, per-plate spreading weights and two scales of border noise, so plates differ a lot in size (about 3% to 25% of the globe) and borders wander.
  Landmass reassignment can no longer leave cut-off pieces of a plate.
- Border smoothing in the simulation: a point whose surroundings are mostly another plate joins it (every other step). This removes the fingers and
  enclaves that plate borders used to grow over 200 My. It does not try to keep plates in one piece: when a plate tears into separate large pieces (each over 0.4% of the globe's points, checked every 4 My),
  each piece after the biggest becomes a plate of its own, starting with the parent's motion plus a push away from where it broke off (up to 40 plates).
- Collisions act over hundreds of km, not one cell. Continental crust consumed at a collision is conserved and piled over a belt about 900 km either side
  (weak rock takes more, craton less); the share of a slab that returns as magma builds a volcanic belt about 450 km wide on the overriding plate.
  Total crust volume is conserved, so land share stays near its starting value.
- Colliding continents lock hard (about 7 My): the plates relax to a shared velocity and a locked plate loses 90% of its slab pull (the slab breaks off).
  Before this, collisions consumed about three quarters of the continental area in 200 My.
- Arc magma (12% of a subducted slab) rises across a belt about 160 km wide on the overriding plate, so island arcs reach land thickness and accrete.
- A gap in a squeezed continental belt is filled with the crust around it; new sea floor is made only where the plates are really pulling apart.
- Lone single-cell seas inside land are raised to the surrounding land (a lake, not a sea), both in the starting terrain and in every frame.
- Erosion: a river's base level is sea level (it cannot cut a coast down because the sea floor beyond is deep) and land-sea slope exchange counts the sea only
  down to the shelf edge (-200 m). Deltas form only for basins over about 60,000 km2 (full at 500,000 km2), a physical size, so coarse lattices do not turn every river into a delta.
  Incision 5000, hillslope diffusion 4000 (the generator's own short pre-pass uses incision 45000 for fresh relief).
- Crust flow and border smoothing are lengths in km (600 km and 500 km) and normalised, so they do not change with detail.
- Calibration at the default detail (63, 200 My, 'continents' at 30% land, three seeds): land stays at 31-32%; mean land height 650-1070 m (average ~870, Earth 840);
  share of land above 2 km 1.7%, 7.9% and 10.9% (Earth ~10%; some worlds are flat, as some real ones would be); highest peaks 3.7-8.5 km.
  Detail 28 and 45 give similar worlds (land 32-36%).
- Thick crust flows sideways during the simulation (within ~2.4 point spacings, across plate borders too, weak rock more than craton, never sea floor),
  so collision belts become broad ranges with foothills on both sides rather than one-cell walls. Border smoothing now works over ~4.5 spacings (~500 km).
  Plates may disappear entirely (subducted or tidied away).
- Plates come in two kinds, as on Earth: 8-12 major plates (uneven, 3-25% of the globe) and 6-10 minor plates, each a rough disc centred on a
  boundary (half at three-way junctions) and touching at least two major plates. Minor plates may touch each other. Four major plates never meet at a point
  (the smallest hands its ground to a neighbour). Majors are placed first, so they are a little larger than they would be in a 14-22 plate split.
- Generated land is placed with no preference for plate interiors: half the continents sit at a plate's heart, the rest toward an edge, spaced apart from each other,
  and they may straddle boundaries. Only small landmasses (under 6% of the globe) are kept on a single plate.
- The starting layout never contains an enclave: a plate wholly inside one other plate (or a small one almost wholly) joins it, and plates are renumbered.

## Known limits
- Small plates can be tidied away over 200 My (an 8-10 plate world often ends with 7-9), and a couple of large plates grow to hold much of the globe.
- Land share still drifts down a little over 200 My; the very high (>5 km) tail is fatter than Earth's; sea-floor age median is about 90 My (Earth ~60).
- Determinism is by construction (no engine-dependent maths in `src/sim`), tested in Node and Chrome only; Firefox and Safari not tried.
- Detailed (160k) detail is slow (about 0.4 s per step before climate) and has not been tried in the browser.
- PNG export runs on the main thread and briefly freezes the page.

## Built since: run speed

A 200 My run at the default detail went from about 60 s to about 26 s, and a 10 My step at Detailed from about 12 s to 7 s, with the same behaviour (land 30%, mean land height ~1100 m).
- Points deep inside a plate skip the border search; only points near a border scan their neighbours.
- Border smoothing counts whole same-plate cells at once instead of point by point, and skips points whose surroundings are one plate.
- Crust flow starts from thick continental crust only; hole filling stops at the first crust point close enough to a vertex.
- The climate sweeps work out wind weights, lift and rain-loss rates once per season instead of on every sweep.
- The lattice is built once per detail level and reused.
Still costly at high detail: climate (about 1.6 s per keyframe at Detailed, growing with detail^1.5) and the nearest-crust lookup done every step for erosion.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DETAIL_PRESETS, buildLattice, type DetailPreset, type Lattice } from './sim/lattice';
import { applyBrush, newRecipe, type BrushEdit, type GenerateEdit, type PlateEdit, type Recipe, type WorldState } from './sim/world';
import { buildCellBorders, buildCellMesh, type CellBorders, type CellMesh } from './view/cells';
import { buildCellEdges, buildCellGeometry, surfaceRadius, updateCellColors, updateCellHeights, updateEdgeHeights } from './view/cellGeometry';
import { colorsFromRock, colorsFromBiomes, colorsFromPlates, colorsFromRainfall, colorsFromTemperature, colorsFromThickness } from './view/colors';
import { prepareWorld, type PreparedWorld } from './sim/setup';
import { ROCKS } from './sim/crust';
import { BIOMES } from './sim/biomes';
import { DEFAULT_RUN, type ClimateAndWater, type Frame, type RunParams } from './sim/runner';
import type { WorkerMessage, WorkerRequest } from './sim/worker';
import type { ClimateParams } from './sim/climate';
import { PROJECTIONS, projectionByKey } from './export/projections';
import { renderProjection } from './export/render';
import { LatticeIndex } from './sim/latticeIndex';
import { windArrowLines } from './view/wind';
import { riverPaths } from './view/riverPaths';
import { elevationFromThickness } from './sim/world';
import { setupSidePanel } from './view/sidePanel';
import { loadCurrent, saveCurrent } from './storage';
import { parseWorld, serializeWorld, toWorldFile, type PlanetSettings, type WorldFile } from './world-file';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('globe');
const seedInput = $<HTMLInputElement>('seed');
const detailSelect = $<HTMLSelectElement>('detail');
const renderDetailSelect = $<HTMLSelectElement>('renderDetail');
const sizeReadout = $<HTMLSpanElement>('sizeReadout');
const regenButton = $<HTMLButtonElement>('regen');
const undoButton = $<HTMLButtonElement>('undo');
const radiusInput = $<HTMLInputElement>('radius');
const edgesToggle = $<HTMLInputElement>('edges');
const layerSelect = $<HTMLSelectElement>('layer');
const waterToggle = $<HTMLInputElement>('water');
const windToggle = $<HTMLInputElement>('winds');
const removeModeSelect = $<HTMLSelectElement>('removeMode');
const hint = $<HTMLDivElement>('hint');
const strengthInput = $<HTMLInputElement>('strength');
const strengthReadout = $<HTMLSpanElement>('strengthReadout');
const landStyleSelect = $<HTMLSelectElement>('landStyle');
const landCoverInput = $<HTMLInputElement>('landCover');
const coverReadout = $<HTMLSpanElement>('coverReadout');
const generateButton = $<HTMLButtonElement>('generate');
const exaggerationInput = $<HTMLInputElement>('exaggeration');
const exagReadout = $<HTMLSpanElement>('exagReadout');
const riverDensityInput = $<HTMLInputElement>('riverDensity');
const pointerInfo = $<HTMLDivElement>('pointerInfo');
const plateOutlinesToggle = $<HTMLInputElement>('plateOutlines');
const guideAxis = $<HTMLInputElement>('guideAxis');
const guideEquator = $<HTMLInputElement>('guideEquator');
const guideTropics = $<HTMLInputElement>('guideTropics');
const guidePolar = $<HTMLInputElement>('guidePolar');
const simulateButton = $<HTMLButtonElement>('simulate');
const scrub = $<HTMLInputElement>('scrub');
const timePosition = $<HTMLSpanElement>('timePosition');
const timeStatus = $<HTMLSpanElement>('timeStatus');
const keyframeSelect = $<HTMLSelectElement>('keyframe');
const ticks = $<HTMLDivElement>('ticks');
const tiltInput = $<HTMLInputElement>('tilt');
const tiltReadout = $<HTMLSpanElement>('tiltReadout');
const spinSelect = $<HTMLSelectElement>('spin');
const seaInput = $<HTMLInputElement>('seaLevel');
const seaReadout = $<HTMLSpanElement>('seaReadout');
const seaLevel = (): number => Number(seaInput.value);
const recomputeButton = $<HTMLButtonElement>('recompute');
const projectionSelect = $<HTMLSelectElement>('projection');
const centreLat = $<HTMLInputElement>('centreLat');
const centreLon = $<HTMLInputElement>('centreLon');
const centreReadout = $<HTMLSpanElement>('centreReadout');
const mapWidthSelect = $<HTMLSelectElement>('mapWidth');
const exportPngButton = $<HTMLButtonElement>('exportPng');
const saveWorldButton = $<HTMLButtonElement>('saveWorld');
const openWorldButton = $<HTMLButtonElement>('openWorld');
const openFile = $<HTMLInputElement>('openFile');
const info = $<HTMLDivElement>('info');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f17);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
// The planet spins about the z axis (latitude comes from z), so z is up.
camera.up.set(0, 0, 1);
camera.position.set(3.1, -0.6, 0.9);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 1.3;
controls.maxDistance = 8;

scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.2));
// The light rides with the camera, off to one side and above, so slopes catch it whichever way the globe is turned.
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(-2.2, 2.2, 1.2);
camera.add(sun);
scene.add(camera);

// --- world state -----------------------------------------------------------

let recipe: Recipe = newRecipe('first-world', DETAIL_PRESETS.default);
let lattice: Lattice;
/** The lattice the drawn mesh is built from: the simulation's, or a different one when render detail is set apart. */
let viewLattice: Lattice;
/** For each drawn cell, the simulation vertex whose values it shows; null when the two lattices are the same. */
let viewMap: Int32Array | null = null;
let cells: CellMesh;
let borders: CellBorders;
let cornerRadius: Float64Array | null = null;
let state: WorldState;
let prepared: PreparedWorld | null = null;
let latticeIndex: LatticeIndex | null = null;
let painting = false;

// Simulation results: one frame per keyframe, streamed in from the worker.
let frames: Frame[] = [];
let frameIndex = 0;
let follow = true;
let worker: Worker | null = null;
let globe: THREE.Mesh | null = null;
let edges: THREE.LineSegments | null = null;

function refreshInfo(): void {
  const plateText = prepared ? `, ${new Set(prepared.setup.plateOf).size} plates` : '';
  const drawn = viewMap ? `, drawn as ${viewLattice.vertexCount.toLocaleString()} cells` : '';
  info.textContent = `${lattice.vertexCount.toLocaleString()} simulation points${drawn}, ${recipe.edits.length} stroke${recipe.edits.length === 1 ? '' : 's'}${plateText}`;
}

/** Start a fresh world from the seed and detail boxes. `save` is false when a link opened it, so a link never overwrites saved work. */
function newWorld(save = true): void {
  startWorld(newRecipe(seedInput.value, DETAIL_PRESETS[detailSelect.value as DetailPreset]));
  history.replaceState(null, '', `?seed=${encodeURIComponent(recipe.seed)}&detail=${detailSelect.value}`);
  if (save) scheduleSave();
}

/** Build everything for a recipe: the lattice, view mesh and the state its edits produce. */
/** The land as the edits left it, as a working copy that painting changes live. */
function rawState(p: PreparedWorld): WorldState {
  return { lattice: p.raw.lattice, thickness: Float64Array.from(p.raw.thickness) };
}

function startWorld(next: Recipe): void {
  recipe = next;
  lattice = buildLattice(recipe.frequency);
  latticeIndex = new LatticeIndex(lattice);
  prepared = prepareWorld(recipe, lattice);
  state = rawState(prepared);
  staticClimate = null;
  layerSelect.value = 'elevation';

  rebuildView();
  clearSimulation();
  simulationOutdated = false; // a different world, not an edit of the one that was simulated
  refreshTimeline();
  refreshInfo();
  ensureClimateForLayer();
}

/** Which lattice the view mesh uses: the simulation's, or one at the chosen render detail. */
function renderFrequency(): number {
  const choice = renderDetailSelect.value;
  return choice === 'match' ? recipe.frequency : DETAIL_PRESETS[choice as DetailPreset];
}

/** Values per simulation vertex, spread onto the drawn cells that show them. */
function toViewColors(simColors: Float32Array): Float32Array {
  if (!viewMap) return simColors;
  const out = new Float32Array(viewMap.length * 3);
  for (let c = 0; c < viewMap.length; c++) {
    const v = viewMap[c]!;
    out[c * 3] = simColors[v * 3]!;
    out[c * 3 + 1] = simColors[v * 3 + 1]!;
    out[c * 3 + 2] = simColors[v * 3 + 2]!;
  }
  return out;
}

/** (Re)build what is drawn, at the chosen render detail, which need not match the simulation's. */
function rebuildView(): void {
  const frequency = renderFrequency();
  viewLattice = frequency === recipe.frequency ? lattice : buildLattice(frequency);
  cells = buildCellMesh(viewLattice);
  borders = buildCellBorders(viewLattice);
  if (viewLattice === lattice) {
    viewMap = null;
  } else {
    viewMap = new Int32Array(viewLattice.vertexCount);
    for (let c = 0; c < viewMap.length; c++) {
      viewMap[c] = latticeIndex!.nearest(viewLattice.positions[c * 3]!, viewLattice.positions[c * 3 + 1]!, viewLattice.positions[c * 3 + 2]!);
    }
  }
  for (const old of [globe, edges]) {
    if (old) {
      old.geometry.dispose();
      scene.remove(old);
    }
  }
  globe = new THREE.Mesh(
    buildCellGeometry(viewLattice, cells, toViewColors(colorsFromThickness(viewThickness(), seaLevel()))),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
  );
  scene.add(globe);
  edges = new THREE.LineSegments(buildCellEdges(cells), new THREE.LineBasicMaterial({ color: 0x0b0f17, transparent: true, opacity: 0.5 }));
  edges.visible = edgesToggle.checked;
  scene.add(edges);
  applyHeights(true);
}

// Climate for the world as painted (before any simulation), computed on demand in a helper worker.
let staticClimate: ClimateAndWater | null = null;
let climateWorker: Worker | null = null;
let climateRequest = 0;

function climateParams(): ClimateParams {
  return { axialTilt: (Number(tiltInput.value) * Math.PI) / 180, spin: Number(spinSelect.value) === -1 ? -1 : 1, seaLevel: seaLevel() };
}

/** Ask the helper worker for the climate of a thickness field; the callback only fires for the newest request. */
function requestClimate(thickness: Float32Array, rock: Uint8Array | undefined, done: (c: ClimateAndWater) => void): void {
  climateWorker ??= new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
  const id = ++climateRequest;
  const handler = (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data;
    if (msg.type !== 'climate' || msg.id !== id) return;
    climateWorker?.removeEventListener('message', handler);
    if (id === climateRequest) {
      const { temperature, precipitation, flowTo, discharge, lake } = msg;
      done({ temperature, precipitation, flowTo, discharge, lake });
    }
  };
  climateWorker.addEventListener('message', handler);
  climateWorker.postMessage({ type: 'climate', id, frequency: recipe.frequency, thickness, params: climateParams(), rock: rock?.slice() } satisfies WorkerRequest);
}

/** The land on show: the painted state while a stroke is under way, otherwise with plate edits applied. */
function viewThickness(): Float64Array {
  return painting || !prepared ? state.thickness : prepared.world.thickness;
}

/** The crust thickness on show: the simulation frame being viewed, or the painted world. */
function currentThickness(): ArrayLike<number> {
  return frames[frameIndex]?.thickness ?? viewThickness();
}

/** Lift the cells to their elevation. Normals are recomputed only when asked, since that is the costly part of painting. */
function applyHeights(withNormals: boolean): void {
  if (!globe) return;
  const thickness = currentThickness();
  const count = viewMap ? viewMap.length : thickness.length;
  const elevation = new Float64Array(count);
  for (let c = 0; c < count; c++) elevation[c] = elevationFromThickness(thickness[viewMap ? viewMap[c]! : c]!) - seaLevel();
  cornerRadius = updateCellHeights(globe.geometry, viewLattice, cells, elevation, Number(exaggerationInput.value), withNormals);
  if (edges) updateEdgeHeights(edges.geometry, cells, cornerRadius);
}

/** Radius of the surface above a lattice vertex, for laying lines on the terrain. */
function radiusAtVertex(v: number): number {
  return surfaceRadius(elevationFromThickness(currentThickness()[v]!) - seaLevel(), Number(exaggerationInput.value));
}

function baseColors(): Float32Array {
  const layer = layerSelect.value;
  const frame = frames[frameIndex];
  if (frame) {
    if (layer === 'plates') return colorsFromPlates(frame.plate);
    if (layer === 'temperature') return colorsFromTemperature(frame.temperature);
    if (layer === 'rainfall') return colorsFromRainfall(frame.precipitation);
    if (layer === 'biomes') return colorsFromBiomes(frame.temperature, frame.precipitation, frame.thickness, seaLevel());
    if (layer === 'geology') return colorsFromRock(frame.rock);
    return colorsFromThickness(frame.thickness, seaLevel());
  }
  if (layer === 'plates' && prepared) return colorsFromPlates(prepared.setup.plateOf);
  if (layer === 'geology' && prepared) return colorsFromRock(prepared.rock);
  if (layer === 'temperature' && staticClimate) return colorsFromTemperature(staticClimate.temperature);
  if (layer === 'rainfall' && staticClimate) return colorsFromRainfall(staticClimate.precipitation);
  if (layer === 'biomes' && staticClimate) return colorsFromBiomes(staticClimate.temperature, staticClimate.precipitation, viewThickness(), seaLevel());
  return colorsFromThickness(viewThickness(), seaLevel());
}

const LAKE_COLOR = [0.2, 0.45, 0.85] as const;

/** Water currently on show: the frame's, or the painted world's. */
function currentWater(): ClimateAndWater | null {
  return frames[frameIndex] ?? staticClimate;
}

/** What is drawn: the chosen layer, with lakes tinted on top when the overlay is on. */
function currentColors(): Float32Array {
  const colors = baseColors();
  const water = currentWater();
  if (water && waterToggle.checked) {
    for (let v = 0; v < water.lake.length; v++) {
      if (water.lake[v]) colors.set(LAKE_COLOR, v * 3);
    }
  }
  return colors;
}

let plateOutlineLines: THREE.LineSegments | null = null;

/**
 * Plate borders drawn over any layer: wherever two neighbouring cells are on different plates, the edge they
 * share. Follows the simulation frame being viewed. White over the colour layers, dark over the plate colours.
 */
function updatePlateOutlines(): void {
  if (plateOutlineLines) {
    plateOutlineLines.geometry.dispose();
    scene.remove(plateOutlineLines);
    plateOutlineLines = null;
  }
  const plateOf = frames[frameIndex]?.plate ?? prepared?.setup.plateOf;
  if (!plateOutlinesToggle.checked || !plateOf || !cornerRadius) return;
  const pos: number[] = [];
  const plateAt = (cell: number) => plateOf[viewMap ? viewMap[cell]! : cell]!;
  for (let e = 0; e < borders.count; e++) {
    if (plateAt(borders.a[e]!) === plateAt(borders.b[e]!)) continue;
    for (const c of [borders.cornerA[e]!, borders.cornerB[e]!]) {
      const r = cornerRadius[c]! + 0.0025;
      pos.push(cells.corners[c * 3]! * r, cells.corners[c * 3 + 1]! * r, cells.corners[c * 3 + 2]! * r);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const color = layerSelect.value === 'plates' ? 0x10151f : 0xffffff;
  plateOutlineLines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
  scene.add(plateOutlineLines);
}

plateOutlinesToggle.addEventListener('change', updatePlateOutlines);

let doomedLines: THREE.LineSegments | null = null;
let doomedPlate = -1;

/** Outlines one plate (red for Remove Plate, yellow for Split Plate) to show what a click would act on; -1 clears it. */
function highlightPlate(id: number): void {
  if (id === doomedPlate) return;
  doomedPlate = id;
  if (doomedLines) {
    doomedLines.geometry.dispose();
    scene.remove(doomedLines);
    doomedLines = null;
  }
  const plateOf = prepared?.setup.plateOf;
  if (id < 0 || !plateOf || !cornerRadius) return;
  const pos: number[] = [];
  const plateAt = (cell: number) => plateOf[viewMap ? viewMap[cell]! : cell]!;
  for (let e = 0; e < borders.count; e++) {
    const a = plateAt(borders.a[e]!) === id;
    if (a === (plateAt(borders.b[e]!) === id)) continue;
    for (const c of [borders.cornerA[e]!, borders.cornerB[e]!]) {
      const r = cornerRadius[c]! + 0.004;
      pos.push(cells.corners[c * 3]! * r, cells.corners[c * 3 + 1]! * r, cells.corners[c * 3 + 2]! * r);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  doomedLines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: tool === 'splitPlate' ? 0xffd02a : 0xff2a2a }));
  scene.add(doomedLines);
}

let riverLines: THREE.LineSegments | null = null;

/** Rivers as lines from each river vertex to the one it flows to. Only the larger flows are drawn. */
function updateRivers(): void {
  if (riverLines) {
    riverLines.geometry.dispose();
    scene.remove(riverLines);
    riverLines = null;
  }
  const water = currentWater();
  if (!water || !waterToggle.checked) return;

  // Show only the biggest rivers: those above a chosen percentile of all land flows, so the same setting works
  // at every detail level and in wet and dry worlds alike.
  const flows = Array.from(water.discharge).filter((q) => q > 0).sort((a, b) => a - b);
  if (flows.length === 0) return;
  const cut = Math.min(flows.length - 1, Math.floor(((100 - Number(riverDensityInput.value)) / 100) * flows.length));
  const threshold = Math.max(flows[cut]!, 1e-9);
  const biggest = flows[flows.length - 1]!;

  const pos: number[] = [];
  const col: number[] = [];
  // Smooth winding paths: flat soft ground meanders, steep or hard ground runs straight.
  const thickness = currentThickness();
  const elevation = new Float64Array(water.discharge.length);
  for (let v = 0; v < elevation.length; v++) elevation[v] = elevationFromThickness(thickness[v]!) - seaLevel();
  const rock = frames[frameIndex]?.rock ?? prepared?.rock;
  const erodibility = rock ? Float64Array.from(rock, (r) => ROCKS[r]!.erodibility) : undefined;
  for (const hop of riverPaths(lattice, water.flowTo, water.discharge, elevation, threshold, erodibility)) {
    const strength = 0.45 + 0.55 * (Math.log(hop.discharge / threshold) / Math.log(Math.max(biggest / threshold, 1.01)));
    const rA = radiusAtVertex(hop.from) + 0.0025, rB = radiusAtVertex(hop.to) + 0.0025;
    const count = hop.points.length / 3;
    for (let i = 0; i + 1 < count; i++) {
      for (const j of [i, i + 1]) {
        const r = rA + ((rB - rA) * j) / (count - 1);
        pos.push(hop.points[j * 3]! * r, hop.points[j * 3 + 1]! * r, hop.points[j * 3 + 2]! * r);
        col.push(0.15 * strength, 0.4 * strength + 0.2, 0.9 * strength + 0.1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  riverLines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
  scene.add(riverLines);
}

let windLines: THREE.LineSegments | null = null;

/** Prevailing-wind arrows over the globe, following the planet's tilt and spin. */
function updateWinds(): void {
  if (windLines) {
    windLines.geometry.dispose();
    scene.remove(windLines);
    windLines = null;
  }
  if (!windToggle.checked || !latticeIndex) return;
  const index = latticeIndex;
  const pos = windArrowLines(climateParams(), (x, y, z) => Math.max(1, radiusAtVertex(index.nearest(x, y, z))));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  windLines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xfff1b0 }));
  scene.add(windLines);
}
windToggle.addEventListener('change', updateWinds);

waterToggle.addEventListener('change', () => {
  ensureClimateForLayer();
  recolor();
});
/** The slider is the share of flows drawn as rivers, the largest first: further right means more rivers. */
function updateRiverReadout(): void {
  const share = Number(riverDensityInput.value);
  document.getElementById('riverReadout')!.textContent = `Largest ${Number.isInteger(share) ? share : share.toFixed(1)}% of flows`;
}
riverDensityInput.addEventListener('input', updateRiverReadout);
updateRiverReadout();
riverDensityInput.addEventListener('input', updateRivers);

/** The river slider only matters while rivers are drawn, so it is shown only then. */
function showRiverSlider(): void {
  riverDensityInput.closest('label')!.hidden = !waterToggle.checked;
}
waterToggle.addEventListener('change', showRiverSlider);
showRiverSlider();

let climateTimer: number | undefined;

/**
 * Make sure the climate for what is on screen exists; asks for it if not. Rivers and lakes need it
 * too, so with that overlay on it is wanted for every layer, after a short pause so a run of strokes
 * does not queue a recompute for each.
 */
function ensureClimateForLayer(): void {
  if (frames[frameIndex] || staticClimate) return;
  const layer = layerSelect.value;
  const needed = layer === 'temperature' || layer === 'rainfall' || layer === 'biomes' || waterToggle.checked;
  if (!needed) return;
  window.clearTimeout(climateTimer);
  climateTimer = window.setTimeout(() => {
    if (frames[frameIndex] || staticClimate) return;
    requestClimate(Float32Array.from(viewThickness()), prepared?.rock, (c) => {
      staticClimate = c;
      recolor();
    });
  }, 500);
}

recomputeButton.addEventListener('click', () => {
  const frame = frames[frameIndex];
  if (frame) {
    const index = frameIndex;
    requestClimate(Float32Array.from(frame.thickness), frame.rock, (c) => {
      frames[index] = { ...frame, ...c };
      recolor();
    });
  } else {
    staticClimate = null;
    requestClimate(Float32Array.from(viewThickness()), prepared?.rock, (c) => {
      staticClimate = c;
      recolor();
    });
  }
});

tiltInput.addEventListener('input', () => {
  tiltReadout.textContent = `${tiltInput.value}°`;
  updateWinds();
  rebuildGuides();
  scheduleSave();
});
spinSelect.addEventListener('change', () => {
  updateWinds();
  scheduleSave();
});
seaInput.addEventListener('input', () => {
  seaReadout.textContent = `${seaLevel() > 0 ? '+' : ''}${seaLevel()} m`;
  applyHeights(true);
  recolor();
  scheduleSave();
});
// The climate and rivers follow the sea, so they are worked out again once the slider is let go.
seaInput.addEventListener('change', () => $<HTMLButtonElement>('recompute').click());

function refreshTimeline(): void {
  const frame = frames[frameIndex];
  // The slider always spans the whole run; a tick marks each keyframe, lit once it has been simulated. A stopped or finished
  // run keeps the spacing it was made with, even if the setting has been changed since.
  const times = keyframeTimes(frames.length > 0 ? runSpacing : keyframeSpacing());
  keyframeSelect.disabled = worker !== null;
  scrub.min = '0';
  scrub.max = String(DEFAULT_RUN.totalMy);
  scrub.step = '1';
  scrub.value = String(frames[frameIndex]?.time ?? 0);
  scrub.disabled = frames.length < 2;
  if (ticks.childElementCount !== times.length) {
    ticks.replaceChildren(...times.map((time) => {
      const tick = document.createElement('i');
      // Positioned to line up with the slider thumb's centre, which stays half a thumb inside either end.
      tick.style.left = `calc(8px + (100% - 16px) * ${time / DEFAULT_RUN.totalMy})`;
      return tick;
    }));
  }
  times.forEach((time, i) => ticks.children[i]!.classList.toggle('done', frames.some((f) => f.time === time)));
  // The bar behind the ticks fills with every 1 My plate step of a running simulation.
  runBar.style.visibility = worker ? 'visible' : 'hidden';
  runBarFill.style.width = `${(100 * progress.time) / DEFAULT_RUN.totalMy}%`;
  // Where the timeline is (fixed width, so the status beside it stays put) and what the simulation is doing.
  timePosition.textContent = `${worker ? progress.time : (frame?.time ?? 0)} of ${DEFAULT_RUN.totalMy} million years`;
  const finished = frames.length > 0 && frames[frames.length - 1]!.time >= DEFAULT_RUN.totalMy;
  const [state, text] = worker
    ? ['running', progress.keyframe ? 'Running… saving keyframe' : 'Running…']
    : finished ? ['complete', 'Simulation complete']
    : frames.length > 0 ? ['stopped', 'Stopped before the end']
    : simulationOutdated ? ['outdated', 'World edited: simulate again to see the changes']
    : ['idle', 'Not simulated yet'];
  timeStatus.dataset.state = state;
  timeStatus.textContent = text;
  simulateButton.textContent = worker ? 'Stop' : 'Simulate';
}

const runBar = document.querySelector<HTMLElement>('#runBar')!;
const runBarFill = runBar.querySelector<HTMLElement>('i')!;

/** How far the running simulation has got (steps between keyframes included). */
let progress = { time: 0, keyframe: false };

/** The keyframe spacing chosen in the World panel, in My. */
function keyframeSpacing(): number {
  return Number(keyframeSelect.value) || DEFAULT_RUN.keyframeMy;
}

/** The spacing the frames on the timeline were made with. */
let runSpacing: number = DEFAULT_RUN.keyframeMy;

/** The times a run saves at: every `spacing` My, and the end. */
function keyframeTimes(spacing: number): number[] {
  const times: number[] = [];
  for (let t = 0; t < DEFAULT_RUN.totalMy; t += spacing) times.push(t);
  times.push(DEFAULT_RUN.totalMy);
  return times;
}

/** Throw away simulation results (any edit makes them stale) and stop a running simulation. */
/** True once a simulation has been thrown away by an edit, until the next run starts or a different world is loaded. */
let simulationOutdated = false;

function clearSimulation(): void {
  if (worker || frames.length > 0) simulationOutdated = true;
  worker?.terminate();
  worker = null;
  frames = [];
  frameIndex = 0;
  follow = true;
  refreshTimeline();
  recolor();
}

simulateButton.addEventListener('click', () => {
  if (worker) {
    // Stop keeps what has been simulated so far, so it can still be scrubbed and viewed.
    worker.terminate();
    worker = null;
    refreshTimeline();
    return;
  }
  clearSimulation();
  simulationOutdated = false;
  const params: RunParams = { seed: recipe.seed, frequency: recipe.frequency, edits: recipe.edits, climate: climateParams(), ...DEFAULT_RUN, keyframeMy: keyframeSpacing() };
  runSpacing = keyframeSpacing();
  progress = { time: 0, keyframe: true };
  worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      progress = { time: msg.time, keyframe: msg.keyframe };
      refreshTimeline();
      return;
    }
    if (msg.type === 'frame') {
      frames.push(msg.frame);
      if (follow) frameIndex = frames.length - 1;
      recolor();
    } else {
      worker?.terminate();
      worker = null;
      if (msg.type === 'error') info.textContent = `Simulation failed: ${msg.message}`;
    }
    refreshTimeline();
  });
  worker.postMessage({ type: 'run', params } satisfies WorkerRequest);
  refreshTimeline();
});

scrub.addEventListener('input', () => {
  // Only keyframes that exist can be shown: the slider snaps back from times not yet simulated.
  const time = Number(scrub.value);
  let index = 0;
  for (let i = 0; i < frames.length; i++) if (frames[i]!.time <= time) index = i;
  frameIndex = index;
  follow = frameIndex === frames.length - 1;
  recolor();
  refreshTimeline();
});

const legend = document.getElementById('legend') as HTMLDivElement;

/** A key to the colours, for the layers whose colours are categories. */
function updateLegend(): void {
  const layer = layerSelect.value;
  const items =
    layer === 'geology' ? ROCKS.map((r) => ({ name: r.name, color: r.color })) : layer === 'biomes' ? BIOMES.map((b) => ({ name: b.name, color: b.color })) : [];
  legend.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement('div');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `rgb(${item.color.map((c) => Math.round(c * 255)).join(',')})`;
      row.append(swatch, item.name);
      return row;
    }),
  );
}

/** Repaint the cells; `withRivers` is false while painting, when rebuilding the river lines on every dab would be wasteful. */
const openSection = setupSidePanel(document.querySelector<HTMLElement>('#side')!, ['Planet', 'Brush', 'View', 'Save and export']);

const epochLabel = document.querySelector<HTMLElement>('#epoch')!;

/** Name the moment on screen: how many million years into the simulation the drawn frame is. */
function updateEpoch(): void {
  const time = frames[frameIndex]?.time ?? 0;
  epochLabel.innerHTML = `<span class="full">${time} million years</span><span class="abbr">${time} My</span>`;
}

function recolor(withRivers = true): void {
  updateEpoch();
  if (globe) updateCellColors(globe.geometry, cells, toViewColors(currentColors()));
  applyHeights(withRivers); // while painting (withRivers false) skip the slow normals; they are refreshed when the stroke ends
  if (withRivers) {
    updateRivers();
    updateWinds();
    updatePlateOutlines();
  }
  updatePlateArrows();
}

/** Painting changes the land; plate edits change the plates made from it. Either makes what is derived from them stale. */
function refreshPrepared(): void {
  staticClimate = null;
  prepared = prepareWorld(recipe, lattice);
  state = rawState(prepared); // always derived from the recipe, so undo and redo can never drift
  ensureClimateForLayer();
  recolor();
  refreshInfo();
}

layerSelect.addEventListener('change', () => {
  updateLegend();
  ensureClimateForLayer();
  recolor();
  refreshInfo();
});

// --- tools -------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let stroke: { dabs: number[]; last: THREE.Vector3 } | null = null;
/** A plate tool's press-and-drag: from where it started to where the pointer is now. */
let gesture: { kind: 'addPlate' | 'dragPlate'; from: THREE.Vector3; to: THREE.Vector3 } | null = null;
/** A Paint Plate stroke under way: the plate it started on, and a working copy of the plates so the stroke shows as you drag. */
let plateStroke: { from: THREE.Vector3; id: number; dabs: number[]; last: THREE.Vector3; live: Int32Array } | null = null;

function dabPlate(point: THREE.Vector3): void {
  if (!plateStroke) return;
  plateStroke.dabs.push(point.x, point.y, point.z);
  plateStroke.last = point;
  const r = Number(radiusInput.value);
  const { live, id } = plateStroke;
  for (let v = 0; v < lattice.vertexCount; v++) {
    const dx = lattice.positions[v * 3]! - point.x, dy = lattice.positions[v * 3 + 1]! - point.y, dz = lattice.positions[v * 3 + 2]! - point.z;
    if (dx * dx + dy * dy + dz * dz < r * r) live[v] = id;
  }
  if (globe) updateCellColors(globe.geometry, cells, toViewColors(colorsFromPlates(live)));
}

const HINTS: Record<string, string> = {
  orbit: 'Drag to turn the globe, scroll to zoom.',
  land: 'Drag to paint land.',
  ocean: 'Drag to paint ocean.',
  raise: 'Drag to thicken the crust and raise mountains.',
  lower: 'Drag to thin the crust and deepen basins.',
  addPlate: 'Press on a spot and drag: the arrow is the new plate’s direction and speed, brush size its size.',
  splitPlate: 'Click a plate to split it roughly in half along a wandering edge. The new half drifts away from the old one. Undo if you do not like where the edge fell.',
  removePlate: 'Click a plate to remove it. The Brush section sets what happens to its ground.',
  dragPlate: 'Press on a plate and drag it somewhere else. Plates always cover the globe, so neighbours give way.',
  paintPlate: 'Press on a plate and drag: everything the brush passes over joins that plate, so you can push its boundary into a neighbour. Brush size sets the width.',
};

let tool = 'orbit';
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]'));
for (const b of toolButtons) {
  b.addEventListener('click', () => {
    tool = b.dataset.tool!;
    for (const o of toolButtons) o.classList.toggle('active', o === b);
    hint.textContent = HINTS[tool] ?? '';
    highlightPlate(-1);
    if (BRUSH_TOOLS.has(tool) || tool === 'removePlate') openSection('Brush'); // the tools that use its settings
    if (isPlateTool() && layerSelect.value !== 'plates') {
      layerSelect.value = 'plates'; // plate tools make no sense without seeing the plates
      layerSelect.dispatchEvent(new Event('change'));
    }
  });
}

function isPlateTool(): boolean {
  return tool === 'addPlate' || tool === 'removePlate' || tool === 'splitPlate' || tool === 'dragPlate' || tool === 'paintPlate';
}

function toolMode(): BrushEdit['mode'] | null {
  const t = tool;
  return t === 'land' || t === 'ocean' || t === 'raise' || t === 'lower' ? t : null;
}

function brushTemplate(mode: BrushEdit['mode'], dabs: number[]): BrushEdit {
  const isDelta = mode === 'raise' || mode === 'lower';
  return {
    kind: 'brush',
    mode,
    falloff: 'smooth',
    radius: Number(radiusInput.value),
    // Raise and lower add up to 1 km of crust (about 173 m of height) per dab at full strength; dabs overlap several times per stroke.
    strength: Number(strengthInput.value) * (isDelta ? 1 : 1.5),
    dabs,
    time: 0,
  };
}

const unitSphere = new THREE.Sphere(new THREE.Vector3(), 1);

/** The point on the globe under the pointer, by intersecting the ray with the unit sphere (exact, and fast at any detail). */
function pick(e: PointerEvent): THREE.Vector3 | null {
  if (!globe) return null;
  const rect = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.ray.intersectSphere(unitSphere, new THREE.Vector3());
  return hit ? hit.normalize() : null;
}

function dab(point: THREE.Vector3): void {
  const mode = toolMode();
  if (!mode || !stroke) return;
  const xyz = [point.x, point.y, point.z];
  stroke.dabs.push(...xyz);
  stroke.last = point;
  applyBrush(state, brushTemplate(mode, xyz));
  recolor(false);
}

const tuple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

function commitPlateEdit(edit: PlateEdit): void {
  recipe = { ...recipe, edits: [...recipe.edits, edit] };
  refreshPrepared();
  scheduleSave();
}

/** Line segments for an arrow lying on the globe from `a` to `b`, with a small head. */
function arrowSegments(a: THREE.Vector3, b: THREE.Vector3, lift: number): number[] {
  const dir = b.clone().sub(a);
  const length = dir.length();
  if (length < 1e-6) return [];
  dir.divideScalar(length);
  const side = a.clone().cross(dir).normalize();
  const head = Math.min(0.06, length * 0.35);
  const left = b.clone().addScaledVector(dir, -head).addScaledVector(side, head * 0.5);
  const right = b.clone().addScaledVector(dir, -head).addScaledVector(side, -head * 0.5);
  const out: number[] = [];
  for (const [p, q] of [[a, b], [b, left], [b, right]] as const) out.push(...p.clone().multiplyScalar(lift).toArray(), ...q.clone().multiplyScalar(lift).toArray());
  return out;
}

let previewLine: THREE.LineSegments | null = null;
function showPreview(from: THREE.Vector3, to: THREE.Vector3): void {
  hidePreview();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrowSegments(from, to, 1.035), 3));
  previewLine = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffe066 }));
  scene.add(previewLine);
}
function hidePreview(): void {
  if (!previewLine) return;
  previewLine.geometry.dispose();
  scene.remove(previewLine);
  previewLine = null;
}

let plateArrows: THREE.LineSegments | null = null;

/** An arrow per plate, showing which way it is heading, on the Plates layer before a simulation has run. */
function updatePlateArrows(): void {
  if (plateArrows) {
    plateArrows.geometry.dispose();
    scene.remove(plateArrows);
    plateArrows = null;
  }
  if (layerSelect.value !== 'plates' || frames[frameIndex] || !prepared) return;
  const { setup } = prepared;
  const sums = new Float64Array(setup.plates.length * 3);
  const counts = new Int32Array(setup.plates.length);
  for (let v = 0; v < lattice.vertexCount; v++) {
    const id = setup.plateOf[v]!;
    sums[id * 3] = sums[id * 3]! + lattice.positions[v * 3]!;
    sums[id * 3 + 1] = sums[id * 3 + 1]! + lattice.positions[v * 3 + 1]!;
    sums[id * 3 + 2] = sums[id * 3 + 2]! + lattice.positions[v * 3 + 2]!;
    counts[id] = counts[id]! + 1;
  }
  const pos: number[] = [];
  for (const plate of setup.plates) {
    if (!counts[plate.id]) continue;
    const c = new THREE.Vector3(sums[plate.id * 3], sums[plate.id * 3 + 1], sums[plate.id * 3 + 2]);
    if (c.lengthSq() < 1e-9) continue;
    c.normalize();
    const velocity = new THREE.Vector3(...plate.axis).multiplyScalar(plate.angularSpeed).cross(c);
    const speed = velocity.length();
    if (speed === 0) continue;
    const end = c.clone().addScaledVector(velocity.divideScalar(speed), 0.05 + speed * 10).normalize();
    pos.push(...arrowSegments(c, end, 1.035));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  plateArrows = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x111111 }));
  scene.add(plateArrows);
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const mode = toolMode();
  if (!mode && !isPlateTool()) return;
  const p = pick(e);
  if (!p) return;
  clearSimulation(); // edits make simulated results stale
  controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  if (mode) {
    painting = true;
    stroke = { dabs: [], last: p };
    dab(p);
  } else if (tool === 'paintPlate' && prepared && latticeIndex) {
    const live = Int32Array.from(prepared.setup.plateOf);
    plateStroke = { from: p, id: live[latticeIndex.nearest(p.x, p.y, p.z)]!, dabs: [], last: p, live };
    dabPlate(p);
  } else if (tool === 'splitPlate') {
    highlightPlate(-1);
    commitPlateEdit({ kind: 'splitPlate', at: tuple(p), time: 0 });
    controls.enabled = true;
  } else if (tool === 'removePlate') {
    highlightPlate(-1);
    commitPlateEdit({ kind: 'removePlate', at: tuple(p), mode: removeModeSelect.value === 'keep' ? 'keep' : 'reset', time: 0 });
    controls.enabled = true;
  } else {
    gesture = { kind: tool as 'addPlate' | 'dragPlate', from: p, to: p };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (stroke) {
    const p = pick(e);
    // Space dabs by a fraction of the brush so a stroke is stable and cheap.
    if (p && p.distanceTo(stroke.last) > Number(radiusInput.value) * 0.3) dab(p);
  } else if (plateStroke) {
    const p = pick(e);
    if (p && p.distanceTo(plateStroke.last) > Number(radiusInput.value) * 0.3) dabPlate(p);
  } else if (gesture) {
    const p = pick(e);
    if (p) {
      gesture.to = p;
      showPreview(gesture.from, p);
    }
  }
});

function endPointer(): void {
  const mode = toolMode();
  if (stroke && mode) {
    painting = false;
    recipe = { ...recipe, edits: [...recipe.edits, brushTemplate(mode, stroke.dabs)] };
    refreshPrepared();
    scheduleSave();
  } else if (plateStroke) {
    const { from, dabs } = plateStroke;
    commitPlateEdit({ kind: 'paintPlate', from: tuple(from), radius: Number(radiusInput.value), dabs, time: 0 });
  } else if (gesture) {
    const { kind, from, to } = gesture;
    hidePreview();
    if (from.distanceTo(to) >= 0.03) {
      if (kind === 'dragPlate') {
        commitPlateEdit({ kind: 'dragPlate', from: tuple(from), to: tuple(to), time: 0 });
      } else {
        // The arrow's direction at the start spot is the plate's velocity there; its rotation axis is from x direction.
        const dir = to.clone().sub(from);
        dir.addScaledVector(from, -dir.dot(from)).normalize();
        const axis = from.clone().cross(dir).normalize();
        const speed = Math.min(0.016, 0.002 + from.distanceTo(to) * 0.03);
        commitPlateEdit({ kind: 'addPlate', center: tuple(from), radius: Number(radiusInput.value), axis: tuple(axis), angularSpeed: speed, time: 0 });
      }
    }
  }
  stroke = null;
  gesture = null;
  plateStroke = null;
  painting = false;
  controls.enabled = true;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);


// --- the brush on the globe -------------------------------------------------------------

const BRUSH_TOOLS = new Set(['land', 'ocean', 'raise', 'lower', 'addPlate', 'paintPlate']);
const RING_POINTS = 72;
const ringPositions = new Float32Array(RING_POINTS * 3);
const ringGeometry = new THREE.BufferGeometry();
ringGeometry.setAttribute('position', new THREE.BufferAttribute(ringPositions, 3));
const brushRing = new THREE.LineLoop(ringGeometry, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
brushRing.renderOrder = 10;
brushRing.frustumCulled = false;
brushRing.visible = false;
scene.add(brushRing);
let lastPointer: THREE.Vector3 | null = null;

/** Size of the brush as an arc over the surface: the brush radius is a chord on the unit sphere. */
function brushArcRadians(): number {
  return 2 * Math.asin(Math.min(1, Number(radiusInput.value) / 2));
}

function updateBrushSize(): void {
  sizeReadout.textContent = `(Radius about ${Math.round(brushArcRadians() * 6371).toLocaleString()} km)`;
  updateBrushRing();
}

/** A ring on the globe, the exact size of what the brush will cover, following the pointer. */
function updateBrushRing(): void {
  if (!lastPointer || !BRUSH_TOOLS.has(tool)) {
    brushRing.visible = false;
    return;
  }
  const theta = brushArcRadians();
  const p = lastPointer;
  const up = Math.abs(p.z) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const u = new THREE.Vector3().crossVectors(p, up).normalize();
  const w = new THREE.Vector3().crossVectors(p, u);
  const lift = 1.02;
  for (let i = 0; i < RING_POINTS; i++) {
    const a = (i / RING_POINTS) * Math.PI * 2;
    const x = Math.cos(theta) * p.x + Math.sin(theta) * (Math.cos(a) * u.x + Math.sin(a) * w.x);
    const y = Math.cos(theta) * p.y + Math.sin(theta) * (Math.cos(a) * u.y + Math.sin(a) * w.y);
    const z = Math.cos(theta) * p.z + Math.sin(theta) * (Math.cos(a) * u.z + Math.sin(a) * w.z);
    ringPositions[i * 3] = x * lift;
    ringPositions[i * 3 + 1] = y * lift;
    ringPositions[i * 3 + 2] = z * lift;
  }
  (ringGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  brushRing.visible = true;
}

canvas.addEventListener('pointermove', (e) => {
  lastPointer = pick(e);
  updateBrushRing();
});
canvas.addEventListener('pointerleave', () => {
  lastPointer = null;
  updateBrushRing();
});
radiusInput.addEventListener('input', updateBrushSize);

/** Strength means a share of the way to the target for the paint tools, and kilometres of crust for raise and lower. */
function updateStrengthReadout(): void {
  const value = Number(strengthInput.value);
  const mode = toolMode();
  if (mode === 'raise' || mode === 'lower') strengthReadout.textContent = `${value.toFixed(2)} km per step`;
  else if (mode) strengthReadout.textContent = `${Math.min(100, Math.round(value * 150))}% per step`;
  else strengthReadout.textContent = '';
}
/** Like a tool options bar: each tool shows only the brush settings it uses. */
const SIZE_TOOLS = new Set(['land', 'ocean', 'raise', 'lower', 'addPlate', 'paintPlate']);
const STRENGTH_TOOLS = new Set(['land', 'ocean', 'raise', 'lower']);
function showBrushSettings(): void {
  const row = (input: HTMLElement) => input.closest('label')!;
  row(radiusInput).hidden = !SIZE_TOOLS.has(tool);
  row(strengthInput).hidden = !STRENGTH_TOOLS.has(tool);
  row(removeModeSelect).hidden = tool !== 'removePlate';
  $<HTMLDivElement>('brushNone').hidden = SIZE_TOOLS.has(tool) || tool === 'removePlate';
}
for (const b of toolButtons) b.addEventListener('click', showBrushSettings);
showBrushSettings();
strengthInput.addEventListener('input', updateStrengthReadout);
for (const b of toolButtons) b.addEventListener('click', updateStrengthReadout);
updateStrengthReadout();
for (const b of toolButtons) b.addEventListener('click', updateBrushRing);
updateBrushSize();

undoButton.addEventListener('click', () => {
  if (recipe.edits.length === 0) return;
  clearSimulation();
  recipe = { ...recipe, edits: recipe.edits.slice(0, -1) };
  refreshPrepared();
  scheduleSave();
});

exaggerationInput.addEventListener('input', () => {
  exagReadout.textContent = `${exaggerationInput.value}×`;
  applyHeights(true);
  updateRivers();
  updateWinds();
  updatePlateOutlines();
});

regenButton.addEventListener('click', () => newWorld());

landCoverInput.addEventListener('input', () => {
  coverReadout.textContent = `${landCoverInput.value}%`;
});

// Each style starts at a land cover that suits it: an archipelago is mostly sea. You can still change it.
landStyleSelect.addEventListener('change', () => {
  landCoverInput.value = landStyleSelect.value === 'archipelago' ? '12' : '30';
  coverReadout.textContent = `${landCoverInput.value}%`;
});

// Generate land: adds continents that suit the plates as they are now. Each click makes a new layout.
generateButton.addEventListener('click', () => {
  clearSimulation();
  const earlier = recipe.edits.filter((e) => e.kind === 'generate').length;
  const edit: GenerateEdit = {
    kind: 'generate',
    style: landStyleSelect.value as GenerateEdit['style'],
    landFraction: Number(landCoverInput.value) / 100,
    seed: `${recipe.seed}#${earlier}`,
    time: 0,
  };
  recipe = { ...recipe, edits: [...recipe.edits, edit] };
  refreshPrepared();
  scheduleSave();
});

// Simulation detail changes how finely the world is computed: the same seed and edits are replayed on the new lattice.
detailSelect.addEventListener('change', () => {
  startWorld({ ...recipe, frequency: DETAIL_PRESETS[detailSelect.value as DetailPreset] });
  history.replaceState(null, '', `?seed=${encodeURIComponent(recipe.seed)}&detail=${detailSelect.value}`);
  scheduleSave();
});

// Render detail only changes how finely it is drawn; the world itself is untouched.
renderDetailSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('world-generator.renderDetail', renderDetailSelect.value);
  } catch {
    // A convenience only.
  }
  rebuildView();
  recolor();
  refreshInfo();
});
edgesToggle.addEventListener('change', () => {
  if (edges) edges.visible = edgesToggle.checked;
});

function resize(): void {
  const { clientWidth: w, clientHeight: h } = canvas;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // The canvas fills the window under the docked panels, so shift the view to centre the globe in the space between them.
  const shift = ((document.getElementById('tools')?.offsetWidth ?? 0) - (document.getElementById('side')?.offsetWidth ?? 0)) / 2;
  camera.setViewOffset(w, h, -shift, 0, w, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
for (const id of ['tools', 'side']) new ResizeObserver(resize).observe(document.getElementById(id)!);
resize();

// --- saving, exporting and starting up --------------------------------------

let saveTimer: number | undefined;

function planetSettings(): PlanetSettings {
  return { tiltDegrees: Number(tiltInput.value), spin: Number(spinSelect.value) === -1 ? -1 : 1, seaLevel: seaLevel() };
}

function applyPlanet(p: PlanetSettings): void {
  tiltInput.value = String(p.tiltDegrees);
  tiltReadout.textContent = `${p.tiltDegrees}°`;
  spinSelect.value = String(p.spin);
  seaInput.value = String(p.seaLevel);
  seaReadout.textContent = `${p.seaLevel > 0 ? '+' : ''}${p.seaLevel} m`;
  rebuildGuides();
}

function worldFile(): WorldFile {
  return toWorldFile(recipe, planetSettings());
}

/** Autosave shortly after the last change. */
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveCurrent(worldFile()), 400);
}

function loadWorldFile(file: WorldFile): void {
  applyPlanet(file.planet);
  seedInput.value = file.recipe.seed;
  const preset = (Object.keys(DETAIL_PRESETS) as DetailPreset[]).find((k) => DETAIL_PRESETS[k] === file.recipe.frequency);
  if (preset) detailSelect.value = preset;
  startWorld(file.recipe);
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'world';

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const p of PROJECTIONS) projectionSelect.append(new Option(p.name, p.key));

/** Where the exported map is centred, from the two number boxes. */
function mapCentre(): { lat: number; lon: number } {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : 0));
  return { lat: (clamp(Number(centreLat.value), -90, 90) * Math.PI) / 180, lon: (clamp(Number(centreLon.value), -180, 180) * Math.PI) / 180 };
}

function showCentre(): void {
  const c = mapCentre();
  const lat = Math.round((c.lat * 180) / Math.PI), lon = Math.round((c.lon * 180) / Math.PI);
  centreReadout.textContent = `${Math.abs(lat)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon)}°${lon >= 0 ? 'E' : 'W'}`;
}
centreLat.addEventListener('input', showCentre);
centreLon.addEventListener('input', showCentre);
$<HTMLButtonElement>('centreFromView').addEventListener('click', () => {
  // The point of the globe the camera is looking down on.
  const { x, y, z } = camera.position;
  const r = Math.hypot(x, y, z) || 1;
  centreLat.value = String(Math.round((Math.asin(z / r) * 180) / Math.PI));
  centreLon.value = String(Math.round((Math.atan2(y, x) * 180) / Math.PI));
  showCentre();
});

exportPngButton.addEventListener('click', () => {
  // Draws whatever layer is on screen, so a map of the biomes is one click after choosing Biomes.
  const projection = projectionByKey(projectionSelect.value, mapCentre());
  const img = renderProjection(lattice, currentColors(), projection, Number(mapWidthSelect.value));
  const out = document.createElement('canvas');
  out.width = img.width;
  out.height = img.height;
  out.getContext('2d')!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  out.toBlob((blob) => blob && download(blob, `${slug(recipe.seed)}-${layerSelect.value}-${projection.key}.png`));
});

saveWorldButton.addEventListener('click', () => {
  download(new Blob([serializeWorld(worldFile())], { type: 'application/json' }), `${slug(recipe.seed)}.world.json`);
});

openWorldButton.addEventListener('click', () => openFile.click());
openFile.addEventListener('change', async () => {
  const file = openFile.files?.[0];
  openFile.value = '';
  if (!file) return;
  try {
    loadWorldFile(parseWorld(await file.text()));
    scheduleSave();
  } catch (e) {
    info.textContent = `Could not open that file: ${e instanceof Error ? e.message : String(e)}`;
  }
});

async function boot(): Promise<void> {
  try {
    const saved = localStorage.getItem('world-generator.renderDetail');
    if (saved && [...renderDetailSelect.options].some((o) => o.value === saved)) renderDetailSelect.value = saved;
  } catch {
    // Storage can be blocked.
  }
  const params = new URLSearchParams(location.search);
  const urlSeed = params.get('seed');
  if (urlSeed) {
    // A shared link carries just a seed (and detail), so it opens a fresh world.
    seedInput.value = urlSeed;
    const detail = params.get('detail');
    if (detail && detail in DETAIL_PRESETS) detailSelect.value = detail;
    newWorld(false); // saved only once the person edits it
    return;
  }
  const saved = await loadCurrent();
  if (saved) loadWorldFile(saved);
  else newWorld();
}
void boot();


// --- reference lines: rotation axis, equator, tropics, polar circles ---------------------

const guides = new THREE.Group();
scene.add(guides);

/** A circle of latitude as a line loop, just above the surface. */
function latitudeCircle(latitude: number, color: number): THREE.LineLoop {
  const points: number[] = [];
  const r = Math.cos(latitude) * 1.004;
  for (let i = 0; i < 180; i++) {
    const lon = (i / 180) * Math.PI * 2;
    points.push(r * Math.cos(lon), r * Math.sin(lon), Math.sin(latitude) * 1.004);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color }));
}

/** Rebuild the lines that depend on the axial tilt: the tropics sit at the tilt, the polar circles at 90 degrees minus it. */
function rebuildGuides(): void {
  for (const child of [...guides.children]) {
    (child as THREE.Line).geometry.dispose();
    guides.remove(child);
  }
  const tilt = (Number(tiltInput.value) * Math.PI) / 180;
  if (guideAxis.checked) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -1.4, 0, 0, 1.4], 3));
    guides.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffe066 })));
  }
  if (guideEquator.checked) guides.add(latitudeCircle(0, 0xff5a5a));
  if (guideTropics.checked && tilt > 0.01) for (const sign of [1, -1]) guides.add(latitudeCircle(sign * tilt, 0xffa24a));
  if (guidePolar.checked && tilt > 0.01 && tilt < Math.PI / 2 - 0.01) for (const sign of [1, -1]) guides.add(latitudeCircle(sign * (Math.PI / 2 - tilt), 0x5ad1ff));
}
for (const box of [guideAxis, guideEquator, guideTropics, guidePolar]) box.addEventListener('change', rebuildGuides);

// --- what is under the pointer ---------------------------------------------------------------

canvas.addEventListener('pointerleave', () => highlightPlate(-1));

let hoverBusy = false;
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0 || hoverBusy) return;
  hoverBusy = true;
  requestAnimationFrame(() => {
    hoverBusy = false;
    const p = pick(e);
    if (!p || !latticeIndex) {
      pointerInfo.textContent = 'Hover the globe for latitude and height.';
      highlightPlate(-1);
      return;
    }
    const v = latticeIndex.nearest(p.x, p.y, p.z);
    highlightPlate((tool === 'removePlate' || tool === 'splitPlate') && prepared ? prepared.setup.plateOf[v]! : -1);
    const frame = frames[frameIndex];
    const thickness = frame ? frame.thickness[v]! : viewThickness()[v]!;
    const elevation = Math.round(elevationFromThickness(thickness) - seaLevel());
    const lat = (Math.asin(p.z) * 180) / Math.PI;
    const lon = (Math.atan2(p.y, p.x) * 180) / Math.PI;
    const climate = currentWater();
    const weather = climate ? `, ${climate.temperature[v]!.toFixed(0)} °C, ${Math.round(climate.precipitation[v]!)} mm/yr` : '';
    pointerInfo.textContent = `${Math.abs(lat).toFixed(0)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(0)}°${lon >= 0 ? 'E' : 'W'}: ${elevation.toLocaleString()} m${weather}`;
  });
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

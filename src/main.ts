import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DETAIL_PRESETS, buildLattice, type DetailPreset, type Lattice } from './sim/lattice';
import { applyBrush, newRecipe, type BrushEdit, type GenerateEdit, type PlateEdit, type Recipe, type WorldState } from './sim/world';
import { buildCellBorders, buildCellMesh, type CellBorders, type CellMesh } from './view/cells';
import { buildCellGeometry, surfaceRadius, updateCellColors, updateCellHeights } from './view/cellGeometry';
import { colorsFromRock, colorsFromBiomes, colorsFromPlates, colorsFromRainfall, colorsFromTemperature, colorsFromThickness } from './view/colors';
import { prepareWorld, type PreparedWorld } from './sim/setup';
import { plateCentroid } from './sim/plateEdits';
import { driftAndSpin } from './sim/motion';
import { ROCKS } from './sim/crust';
import { DEFAULT_EROSION, erodeThickness } from './sim/erosion';
import { fillLoneWater } from './sim/pits';
import { BIOMES } from './sim/biomes';
import { DEFAULT_RUN, type ClimateAndWater, type Frame, type RunParams } from './sim/runner';
import type { WorkerMessage, WorkerRequest } from './sim/worker';
import type { ClimateParams } from './sim/climate';
import { PROJECTIONS, projectionByKey } from './export/projections';
import { renderProjection } from './export/render';
import { LatticeIndex } from './sim/latticeIndex';
import type { CirculationLevel } from './sim/circulation';
import { flowArrowLines } from './view/flowArrows';
import { arrowSegments, plateMotionLines } from './view/plateArrows';
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
const layerSelect = $<HTMLSelectElement>('layer');
const waterToggle = $<HTMLInputElement>('water');
const windToggle = $<HTMLInputElement>('winds');
const removeModeSelect = $<HTMLSelectElement>('removeMode');
const hint = $<HTMLDivElement>('hint');
const strengthInput = $<HTMLInputElement>('strength');
const plateSpinInput = $<HTMLInputElement>('plateSpin');
const plateSpeedInput = $<HTMLInputElement>('plateSpeed');
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
const circulationSelect = $<HTMLSelectElement>('circulation');
const erodeButton = $<HTMLButtonElement>('erode');
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
  if (globe) {
    globe.geometry.dispose();
    scene.remove(globe);
  }
  globe = new THREE.Mesh(
    buildCellGeometry(viewLattice, cells, toViewColors(colorsFromThickness(viewThickness(), seaLevel()))),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
  );
  scene.add(globe);
  applyHeights(true);
}

// Climate for the world as painted (before any simulation), computed on demand in a helper worker.
let staticClimate: ClimateAndWater | null = null;
let climateWorker: Worker | null = null;
let climateRequest = 0;

function circulationLevel(): CirculationLevel {
  const n = Number(circulationSelect.value);
  return n === 0 || n === 1 || n === 3 || n === 4 || n === 5 ? n : 2;
}

function climateParams(): ClimateParams {
  return { axialTilt: (Number(tiltInput.value) * Math.PI) / 180, spin: Number(spinSelect.value) === -1 ? -1 : 1, seaLevel: seaLevel(), circulation: circulationLevel() };
}

/** Ask the helper worker for the climate of a thickness field; the callback only fires for the newest request. */
let climateSettled: (() => void) | undefined;

function requestClimate(thickness: Float32Array, rock: Uint8Array | undefined, done: (c: ClimateAndWater) => void, settled?: () => void): void {
  // A newer request makes the one still waiting irrelevant; tell its owner so a busy indicator does not stay on.
  climateSettled?.();
  climateSettled = settled;
  climateWorker ??= new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
  const id = ++climateRequest;
  const handler = (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data;
    if (msg.type !== 'climate' || msg.id !== id) return;
    climateWorker?.removeEventListener('message', handler);
    if (id === climateRequest) {
      const { temperature, precipitation, flowTo, discharge, lake, windEast, windNorth, currentEast, currentNorth } = msg;
      climateSettled = undefined;
      done({ temperature, precipitation, flowTo, discharge, lake, windEast, windNorth, currentEast, currentNorth });
      settled?.();
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

/** The outline of one plate as lines on the globe, or null if it has none to draw. */
function plateOutline(id: number, color: number, lift: number): THREE.LineSegments | null {
  const plateOf = prepared?.setup.plateOf;
  if (id < 0 || !plateOf || !cornerRadius) return null;
  const pos: number[] = [];
  const plateAt = (cell: number) => plateOf[viewMap ? viewMap[cell]! : cell]!;
  for (let e = 0; e < borders.count; e++) {
    const a = plateAt(borders.a[e]!) === id;
    if (a === (plateAt(borders.b[e]!) === id)) continue;
    for (const c of [borders.cornerA[e]!, borders.cornerB[e]!]) {
      const r = cornerRadius[c]! + lift;
      pos.push(cells.corners[c * 3]! * r, cells.corners[c * 3 + 1]! * r, cells.corners[c * 3 + 2]! * r);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
  scene.add(lines);
  return lines;
}

/** Outlines one plate (red for Remove Plate, yellow for Split Plate and Edit Plate) to show what a click would act on; -1 clears it. */
function highlightPlate(id: number): void {
  if (id === doomedPlate) return;
  doomedPlate = id;
  if (doomedLines) {
    doomedLines.geometry.dispose();
    scene.remove(doomedLines);
    doomedLines = null;
  }
  doomedLines = plateOutline(id, tool === 'removePlate' ? 0xff2a2a : 0xffd02a, 0.004);
}

/** The plate chosen with Edit Plate, kept outlined (in blue) until another tool is picked. A point on it, since plate numbers can change. */
let selectedAt: [number, number, number] | null = null;
let selectionLines: THREE.LineSegments | null = null;

function selectedPlateId(): number {
  if (!selectedAt || !latticeIndex || !prepared) return -1;
  return prepared.setup.plateOf[latticeIndex.nearest(selectedAt[0], selectedAt[1], selectedAt[2])]!;
}

function drawSelection(): void {
  if (selectionLines) {
    selectionLines.geometry.dispose();
    scene.remove(selectionLines);
    selectionLines = null;
  }
  if (tool === 'editPlate') selectionLines = plateOutline(selectedPlateId(), 0x4cc9ff, 0.0055);
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

const flowToggles = { winds: windToggle, currents: $<HTMLInputElement>('currents') } as const;
const flowLines: Record<keyof typeof flowToggles, THREE.LineSegments | null> = { winds: null, currents: null };
/** Degrees between flow arrows by circulation detail: the finer the flow, the denser and smaller the arrows. */
const ARROW_STEP_DEG = [6, 5, 3.5, 3, 2.6, 2.2] as const;

/** Arrows for the wind or the ocean currents, over whatever layer is on show, coloured and sized by speed. */
function drawFlow(kind: keyof typeof flowToggles): void {
  const old = flowLines[kind];
  if (old) {
    old.geometry.dispose();
    scene.remove(old);
    flowLines[kind] = null;
  }
  const climate = currentWater();
  if (!flowToggles[kind].checked || !climate || !latticeIndex) return;
  const index = latticeIndex;
  const thickness = currentThickness();
  const east = kind === 'winds' ? climate.windEast : climate.currentEast;
  const north = kind === 'winds' ? climate.windNorth : climate.currentNorth;
  const { positions, colors } = flowArrowLines((x, y, z) => {
    const v = index.nearest(x, y, z);
    // Currents run in the sea only; the wind is shown everywhere.
    if (kind === 'currents' && elevationFromThickness(thickness[v]!) - seaLevel() > 0) return null;
    return [east[v]!, north[v]!];
  },
  // Both follow the surface as drawn. The sea is drawn at its floor, so the currents hug that, a hair above so they do not flicker
  // against it; the wind is held at or above sea level, and a little higher so it reads as moving over the land.
  kind === 'currents' ? (x, y, z) => radiusAtVertex(index.nearest(x, y, z)) : (x, y, z) => Math.max(1, radiusAtVertex(index.nearest(x, y, z))),
  ARROW_STEP_DEG[circulationLevel()],
  kind === 'currents' ? 0.0008 : undefined);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  flowLines[kind] = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
  scene.add(flowLines[kind]!);
}

function updateFlowArrows(): void {
  drawFlow('winds');
  drawFlow('currents');
}
for (const toggle of Object.values(flowToggles)) {
  toggle.addEventListener('change', () => {
    ensureClimateForLayer();
    updateFlowArrows();
  });
}

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
  const needed = layer === 'temperature' || layer === 'rainfall' || layer === 'biomes' || waterToggle.checked || windToggle.checked || flowToggles.currents.checked;
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

let erodeBusy = false;
const EROSION_MY = 10;

/** Apply another spell of erosion: to the starting world before a run, or to the keyframe on show. */
erodeButton.addEventListener('click', () => {
  if (erodeBusy || worker) return;
  erodeBusy = true;
  erodeButton.disabled = true;
  erodeButton.setAttribute('aria-busy', 'true');
  erodeButton.textContent = 'Eroding…';
  // The work runs on this thread, so let the busy label paint before it starts.
  requestAnimationFrame(() => setTimeout(() => {
    let climateToo = false;
    try {
      const frame = frames[frameIndex];
      if (!frame || frame.time === 0) {
        clearSimulation();
        recipe = { ...recipe, edits: [...recipe.edits, { kind: 'erode', my: EROSION_MY, time: 0 }] };
        refreshPrepared();
      } else {
        // The edit is replayed by the simulation when it reaches this moment; here the frame on show is eroded to match.
        recipe = { ...recipe, edits: [...recipe.edits, { kind: 'erode', my: EROSION_MY, time: frame.time }] };
        const thickness = Float64Array.from(frame.thickness);
        const erodibility = Float64Array.from(frame.rock, (r) => ROCKS[r]!.erodibility);
        erodeThickness(lattice, thickness, EROSION_MY, DEFAULT_EROSION, erodibility, frame.precipitation);
        fillLoneWater(lattice, thickness);
        frames[frameIndex] = { ...frame, thickness: Float32Array.from(thickness) };
        erodedFrom = erodedFrom === null ? frame.time : Math.min(erodedFrom, frame.time);
        applyHeights(true);
        recolor();
        climateToo = true;
      }
      scheduleSave();
    } finally {
      erodeBusy = false;
      erodeButton.removeAttribute('aria-busy');
      erodeButton.textContent = 'Apply Erosion';
      refreshTimeline();
    }
    if (climateToo) recomputeClimate(); // the rivers and rain follow the new relief
  }, 0));
});

let recomputing = false;
let recomputeAgain = false;

/** Work the climate out again for the frame on show; one run at a time, with the button showing it is busy. */
function recomputeClimate(): void {
  if (recomputing) {
    recomputeAgain = true;
    return;
  }
  recomputing = true;
  recomputeButton.disabled = true;
  recomputeButton.setAttribute('aria-busy', 'true');
  recomputeButton.textContent = 'Recomputing…';
  const settled = () => {
    recomputing = false;
    recomputeButton.disabled = false;
    recomputeButton.removeAttribute('aria-busy');
    recomputeButton.textContent = 'Recompute Climate';
    if (recomputeAgain) {
      recomputeAgain = false;
      recomputeClimate();
    }
  };
  const frame = frames[frameIndex];
  if (frame) {
    const index = frameIndex;
    requestClimate(Float32Array.from(frame.thickness), frame.rock, (c) => {
      frames[index] = { ...frame, ...c };
      recolor();
    }, settled);
  } else {
    staticClimate = null;
    requestClimate(Float32Array.from(viewThickness()), prepared?.rock, (c) => {
      staticClimate = c;
      recolor();
    }, settled);
  }
}
recomputeButton.addEventListener('click', recomputeClimate);

tiltInput.addEventListener('input', () => {
  tiltReadout.textContent = `${tiltInput.value}°`;
  rebuildGuides();
  scheduleSave();
});
spinSelect.addEventListener('change', () => {
  scheduleSave();
});
seaInput.addEventListener('input', () => {
  seaReadout.textContent = `${seaLevel() > 0 ? '+' : ''}${seaLevel()} m`;
  applyHeights(true);
  recolor();
  scheduleSave();
});
// The climate and rivers follow the sea, so they are worked out again once the slider is let go.
seaInput.addEventListener('change', recomputeClimate);
// So does the circulation detail: it changes how land steers the sea and the air.
circulationSelect.addEventListener('change', () => {
  recomputeClimate();
  scheduleSave();
});

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
    : erodedFrom !== null ? ['outdated', `Eroded at ${erodedFrom} million years: simulate again to update what follows`]
    : finished ? ['complete', 'Simulation complete']
    : frames.length > 0 ? ['stopped', 'Stopped before the end']
    : simulationOutdated ? ['outdated', 'World edited: simulate again to see the changes']
    : ['idle', 'Not simulated yet'];
  timeStatus.dataset.state = state;
  timeStatus.textContent = text;
  simulateButton.textContent = worker ? 'Stop' : 'Simulate';
  erodeButton.disabled = worker !== null || erodeBusy;
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

/** The time of the earliest keyframe that was eroded by hand: later keyframes are out of date, earlier ones still hold. */
let erodedFrom: number | null = null;

function clearSimulation(): void {
  if (worker || frames.length > 0) simulationOutdated = true;
  erodedFrom = null;
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
  // After hand-applied erosion at a keyframe, everything before it is unchanged, so those frames stay.
  const from = erodedFrom;
  const kept = from !== null && runSpacing === keyframeSpacing() ? frames.filter((f) => f.time < from) : [];
  clearSimulation();
  frames = kept;
  frameIndex = Math.min(frameIndex, Math.max(0, kept.length - 1));
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
      if (kept.length > 0 && msg.frame.time <= kept[kept.length - 1]!.time) return; // already held, and identical
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
const legendBody = document.getElementById('legendBody') as HTMLDivElement;

/** Where the legend sits (its top-left corner, in pixels): dragged by its title bar, and kept inside the 3D view. */
let legendSpot: { left: number; top: number } | null = null;
try {
  const saved = JSON.parse(localStorage.getItem('world-generator.legend') ?? 'null') as { left?: unknown; top?: unknown } | null;
  if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') legendSpot = { left: saved.left, top: saved.top };
} catch {
  // A convenience only.
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Keep the legend inside the space between the docked panels; before it has been moved it sits at the bottom left. */
function placeLegend(): void {
  if (legend.hidden) return;
  const tools = document.getElementById('tools')!.offsetWidth;
  const side = document.getElementById('side')!.offsetWidth;
  const timeline = document.getElementById('timeline')!.offsetHeight;
  const margin = 12;
  const minLeft = tools + margin, maxLeft = Math.max(minLeft, window.innerWidth - side - legend.offsetWidth - margin);
  const minTop = margin, maxTop = Math.max(minTop, window.innerHeight - timeline - legend.offsetHeight - margin);
  const left = clamp(legendSpot?.left ?? minLeft, minLeft, maxLeft);
  const top = clamp(legendSpot?.top ?? maxTop, minTop, maxTop);
  legend.style.left = `${left}px`;
  legend.style.top = `${top}px`;
}

legend.querySelector<HTMLElement>('#legendHead')!.addEventListener('pointerdown', (e) => {
  const head = e.currentTarget as HTMLElement;
  const startX = e.clientX - legend.offsetLeft, startY = e.clientY - legend.offsetTop;
  head.setPointerCapture(e.pointerId);
  legend.classList.add('dragging');
  const move = (m: PointerEvent) => {
    legendSpot = { left: m.clientX - startX, top: m.clientY - startY };
    placeLegend();
  };
  const stop = () => {
    head.removeEventListener('pointermove', move);
    head.removeEventListener('pointerup', stop);
    head.removeEventListener('pointercancel', stop);
    legend.classList.remove('dragging');
    legendSpot = { left: legend.offsetLeft, top: legend.offsetTop };
    try {
      localStorage.setItem('world-generator.legend', JSON.stringify(legendSpot));
    } catch {
      // A convenience only.
    }
  };
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', stop);
  head.addEventListener('pointercancel', stop);
});
window.addEventListener('resize', placeLegend);
for (const id of ['tools', 'side', 'timeline']) new ResizeObserver(placeLegend).observe(document.getElementById(id)!);

/** A key to the colours, for the layers whose colours are categories. */
function updateLegend(): void {
  const layer = layerSelect.value;
  type Entry = { name: string; color: readonly number[] };
  const layerItems: Entry[] =
    layer === 'geology' ? ROCKS.map((r) => ({ name: r.name, color: r.color }))
    : layer === 'biomes' ? BIOMES.map((b) => ({ name: b.name, color: b.color }))
    : [];
  legendBody.replaceChildren(
    ...layerItems.map((item) => {
      const row = document.createElement('div');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `rgb(${item.color.map((c) => Math.round(c * 255)).join(',')})`;
      row.append(swatch, item.name);
      return row;
    }),
  );
  legend.hidden = layerItems.length === 0;
  placeLegend();
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
    updateFlowArrows();
    updatePlateOutlines();
  }
  updatePlateArrows();
  drawSelection();
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
  editPlate: 'Click a plate to select it, then set its Plate Speed and Plate Spin in the Brush section. This sets how the plate starts out, so it clears a finished simulation.',
  addPlate: 'Press on a spot and drag: the arrow is the new plate’s direction and speed, brush size its size, and Plate Spin how fast it turns.',
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
    if (tool !== 'editPlate') selectedAt = null;
    drawSelection();
    updateEditControls();
    if (BRUSH_TOOLS.has(tool) || tool === 'removePlate' || tool === 'editPlate') openSection('Brush'); // the tools that use its settings
    if (isPlateTool() && layerSelect.value !== 'plates') {
      layerSelect.value = 'plates'; // plate tools make no sense without seeing the plates
      layerSelect.dispatchEvent(new Event('change'));
    }
  });
}

function isPlateTool(): boolean {
  return tool === 'addPlate' || tool === 'removePlate' || tool === 'splitPlate' || tool === 'dragPlate' || tool === 'paintPlate' || tool === 'editPlate';
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

/** How each plate is moving, on the Plates layer: the starting plates' motion before a run, and the frame on show during and after one. */
function updatePlateArrows(): void {
  if (plateArrows) {
    plateArrows.geometry.dispose();
    scene.remove(plateArrows);
    plateArrows = null;
  }
  if (layerSelect.value !== 'plates') return;
  const frame = frames[frameIndex];
  let lines: { positions: number[]; colors: number[] };
  if (frame) {
    lines = plateMotionLines(lattice.positions, frame.plate, frame.omega.length / 3, (id) => [frame.omega[id * 3]!, frame.omega[id * 3 + 1]!, frame.omega[id * 3 + 2]!]);
  } else if (prepared) {
    const { plateOf, plates } = prepared.setup;
    lines = plateMotionLines(lattice.positions, plateOf, plates.length, (id) => {
      const p = plates[id]!;
      return [p.axis[0] * p.angularSpeed, p.axis[1] * p.angularSpeed, p.axis[2] * p.angularSpeed];
    });
  } else return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(lines.colors, 3));
  plateArrows = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
  scene.add(plateArrows);
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const mode = toolMode();
  if (!mode && !isPlateTool()) return;
  const p = pick(e);
  if (!p) return;
  if (tool === 'editPlate') {
    // Choosing a plate changes nothing yet: its motion is set from the sliders in the Brush section.
    selectedAt = tuple(p);
    drawSelection();
    updateEditControls();
    return;
  }
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
        commitPlateEdit({ kind: 'addPlate', center: tuple(from), radius: Number(radiusInput.value), axis: tuple(axis), angularSpeed: speed, ...(plateSpin() !== 0 ? { spin: plateSpin() } : {}), time: 0 });
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
/** The spin chosen for a new plate, in radians per million years (the slider is in degrees). */
const plateSpin = (): number => (Number(plateSpinInput.value) * Math.PI) / 180;

function updateSpinReadout(): void {
  const deg = Number(plateSpinInput.value);
  document.getElementById('spinReadout')!.textContent = deg === 0 ? 'None' : `${deg > 0 ? '+' : ''}${deg.toFixed(1)}°/My ${deg > 0 ? 'anticlockwise' : 'clockwise'}`;
}
plateSpinInput.addEventListener('input', updateSpinReadout);

/** Plate speed is shown in cm a year: one radian per million years is about 637 cm a year at the planet's surface. */
const CM_PER_YEAR_PER_RAD_PER_MY = 637.1;
function updateSpeedReadout(): void {
  document.getElementById('speedReadout')!.textContent = `${Number(plateSpeedInput.value).toFixed(1)} cm/yr`;
}
plateSpeedInput.addEventListener('input', updateSpeedReadout);

/** Show the chosen plate's motion on the sliders, and the sliders only while there is a plate to change. */
function updateEditControls(): void {
  const id = selectedPlateId();
  if (tool === 'editPlate' && id >= 0 && prepared) {
    const plate = prepared.setup.plates[id]!;
    const { drift, spin } = driftAndSpin(plateCentroid(lattice, prepared.setup.plateOf, id), [plate.axis[0] * plate.angularSpeed, plate.axis[1] * plate.angularSpeed, plate.axis[2] * plate.angularSpeed]);
    plateSpeedInput.value = String(Math.min(15, Math.round(drift * CM_PER_YEAR_PER_RAD_PER_MY * 2) / 2));
    plateSpinInput.value = String(Math.max(-1.5, Math.min(1.5, Math.round(((spin * 180) / Math.PI) * 10) / 10)));
  }
  showBrushSettings();
}

/** Letting go of a slider sets the chosen plate's starting motion: an edit like any other, so Undo takes it back. */
function commitPlateMotion(): void {
  if (tool !== 'editPlate' || !selectedAt) return;
  clearSimulation();
  commitPlateEdit({ kind: 'plateMotion', at: selectedAt, speed: Number(plateSpeedInput.value) / CM_PER_YEAR_PER_RAD_PER_MY, spin: plateSpin(), time: 0 });
  updateEditControls();
}
plateSpeedInput.addEventListener('change', commitPlateMotion);
plateSpinInput.addEventListener('change', commitPlateMotion);

function showBrushSettings(): void {
  const row = (input: HTMLElement) => input.closest('label')!;
  row(radiusInput).hidden = !SIZE_TOOLS.has(tool);
  row(strengthInput).hidden = !STRENGTH_TOOLS.has(tool);
  row(removeModeSelect).hidden = tool !== 'removePlate';
  row(plateSpinInput).hidden = !(tool === 'addPlate' || (tool === 'editPlate' && selectedAt !== null));
  row(plateSpeedInput).hidden = !(tool === 'editPlate' && selectedAt !== null);
  const none = $<HTMLDivElement>('brushNone');
  none.hidden = SIZE_TOOLS.has(tool) || tool === 'removePlate' || (tool === 'editPlate' && selectedAt !== null);
  none.textContent = tool === 'editPlate' ? 'Click a plate to change how it moves.' : 'This tool has no brush settings.';
  updateSpinReadout();
  updateSpeedReadout();
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
  updateFlowArrows();
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
  if (generateButton.disabled) return;
  // The work runs on this thread, so let the busy label paint before it starts.
  generateButton.disabled = true;
  generateButton.setAttribute('aria-busy', 'true');
  generateButton.textContent = 'Generating…';
  requestAnimationFrame(() => setTimeout(() => {
    try {
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
    } finally {
      generateButton.disabled = false;
      generateButton.removeAttribute('aria-busy');
      generateButton.textContent = 'Generate Land';
    }
  }, 0));
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
  return { tiltDegrees: Number(tiltInput.value), spin: Number(spinSelect.value) === -1 ? -1 : 1, seaLevel: seaLevel(), circulation: circulationLevel() };
}

function applyPlanet(p: PlanetSettings): void {
  tiltInput.value = String(p.tiltDegrees);
  tiltReadout.textContent = `${p.tiltDegrees}°`;
  spinSelect.value = String(p.spin);
  seaInput.value = String(p.seaLevel);
  circulationSelect.value = String(p.circulation);
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
    highlightPlate((tool === 'removePlate' || tool === 'splitPlate' || tool === 'editPlate') && prepared ? prepared.setup.plateOf[v]! : -1);
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

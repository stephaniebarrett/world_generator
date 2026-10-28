# World Generator

A browser tool for building plausible, seed-reproducible planets for RPG and fantasy settings. You paint rough land onto a 3D globe, set up tectonic plates, and the tool simulates 200 million years of plate tectonics, erosion and climate to turn that sketch into a physical world: mountains, sea floor, rain and winds, rivers and lakes, and biomes. You can then export maps as images.

Everything runs in your browser. There is no server and no account.

## What it does

- **Paint a world.** Draw land and ocean on the globe, raise or lower the ground, or generate a starting layout (continents, Pangaea, two supercontinents, or an archipelago) from a seed.
- **Edit the plates.** The tool divides the world into tectonic plates, which you can add, remove, drag or repaint, and give a direction and speed.
- **Simulate.** Plates move, collide, rift and subduct; hotspots build volcano chains; rivers and rain erode the land; the sea floor sinks as it ages. Climate (temperature, winds, rain, rain shadows), rivers, lakes and biomes are worked out at each saved keyframe.
- **Scrub through time.** A timeline lets you look at the world at any keyframe from 0 to 200 My after the simulation has completed.
- **Look at it many ways.** Layers for elevation, plates, temperature, rainfall, biomes and geology; plate outlines, prevailing-wind arrows, rivers and lakes, and reference lines (axis, equator, tropics, polar circles).
- **Export.** Save and reopen worlds as JSON, and export flat maps as PNG in nine projections.

The same seed, settings and edits always give the same world, on any machine. Different detail levels give similar but not identical worlds.

## Install and run

You need [Node.js](https://nodejs.org/) (a recent version; the project is developed on Node 25) and a modern browser with WebGL (current Chrome, Edge, Firefox, or Safari).

```sh
npm install
npm run dev
```

Then open the address Vite prints (normally <http://localhost:5173/>).

Other commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the development server. |
| `npm run build` | Type-check and build a static site into `dist/`, which you can host anywhere. |
| `npm test` | Run the test suite. |
| `npm run typecheck` | Type-check only. |

The `scripts/` folder holds helpers that drive the app in headless Chrome and save screenshots. They need the dev server running and a local Chrome install, and are not needed to use the tool.

## Using it

### The screen

- **Centre:** the globe. Drag to turn it, scroll to zoom. A label at the top shows which moment is drawn (the start, or how many My into the simulation).
- **Left:** the tool bar.
- **Right:** the settings panel. Drag its left edge to change its width, and click a section heading to fold or unfold it.
- **Bottom:** the timeline, with the Simulate button, the timeline slider and a status line.

### Making a world

1. In the **World** section, type a **Seed** and pick a **Simulation detail**. Start with Medium (about 40,000 points) or Low (about 10,000, fast). Very high and Ultra are slow and heavy.
2. Click **New World** for an empty ocean, or choose a **Land style** and **Land cover** and click **Generate Land**. You can also paint by hand with the tools below. Painting responsiveness depends on your detail settings.
3. Use the tool bar:
   - **Orbit** turns and zooms the globe.
   - **Paint Ocean** and **Paint Land** paint crust. **Raise Terrain** and **Lower Terrain** thicken or thin it. Brush **Size** and **Strength** are in the **Brush** section.
   - **Add Plate:** press a spot and drag out an arrow for the new plate's direction and speed.
   - **Remove Plate:** click a plate. The **Brush** section sets whether its ground is reset to sea floor or kept.
   - **Drag Plate:** press on a plate and drag it somewhere else. Neighbours give way.
   - **Paint Plate:** press on a plate and drag to push its boundary into a neighbour.
   - **Undo** reverses the last edit.
4. Set the planet in the **World** section: **Axial tilt**, **Spin** (like Earth or reversed) and **Sea level**. Click **Recompute Climate** after changing them on a world that is already simulated. Releasing the sea-level slider does this for you.

### Running the simulation

1. Choose a **Keyframe spacing** (every 5, 10, 15 or 20 My). Wider spacing runs faster because fewer climate passes are made. The physics always steps 1 My at a time.
2. Click **Simulate**. A bar behind the timeline ticks fills with each 1 My step, the status line shows the time reached, and each keyframe lights up its tick as it is saved. Click **Stop** to halt the run. Everything saved so far stays and can still be viewed.
3. Drag the timeline slider to look at any saved keyframe. Times that have not been simulated yet cannot be selected.

Editing the world clears the simulation, so run it again to see an edit's effect. Higher detail levels take much longer: a 200 My run takes roughly half a minute at Medium and several minutes at High.

### Looking at the result

In the **View** section:

- **Layer:** elevation, plates, temperature, rainfall, biomes or geology (rock type). A legend appears under it.
- **Height exaggeration** stretches the relief so mountains stand out.
- Switches for cell edges, plate outlines, rivers and lakes, prevailing winds, and reference lines. **Rivers shown** sets how many rivers are drawn.
- **Render detail** (in the World section) sets how finely the globe is drawn, separately from how finely it is simulated.

Hover over the globe to read latitude, longitude, height and, once climate exists, temperature and rainfall.

### Saving and exporting

In the **Save and export** section:

- **Export Map (PNG):** pick a **Map projection**, a **Map centre** (or use **Centre on Current View**) and an **Image width**. The map shows the layer currently selected.
- **Save World (JSON)** and **Open World (JSON)** keep a world as a file.
- The current world is also saved automatically in your browser, and a link ending in `?seed=your-seed` opens that seed.

## Project layout

- `src/sim/`: the simulation (lattice, plate tectonics, erosion, climate, water, biomes). It runs in a Web Worker, and a second worker works out each keyframe's climate while the plates keep moving.
- `src/view/`: rendering helpers (colours, rivers, winds, biome blending, side panel).
- `src/main.ts` and `index.html`: the app and its interface.
- `SPEC.md`: the design spec and a log of what has been built.

The simulation is deterministic by design: it uses a seeded random generator and plain arithmetic only, so results do not depend on the browser or hardware.

// Web Worker entry: runs simulations and climate passes off the main thread.

import type { ClimateParams } from './climate';
import type { StageJob, StageResult } from './climateWorker';
import { climateBuffers, climateForThickness, inlineClimate, keyframeClimate, runSimulation, type ClimateAndWater, type ClimateHost, type ClimateStages, type Frame, type RunParams } from './runner';

export type WorkerRequest =
  | { type: 'run'; params: RunParams }
  | { type: 'climate'; id: number; frequency: number; thickness: Float32Array; params: ClimateParams; rock?: Uint8Array };

export type WorkerMessage =
  | { type: 'frame'; frame: Frame }
  | { type: 'progress'; time: number; keyframe: boolean }
  | { type: 'done' }
  | ({ type: 'climate'; id: number } & ClimateAndWater)
  | { type: 'error'; message: string };

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
}
const ctx = self as unknown as WorkerScope;

/** Most helper threads the climate may use (the plates have a thread of their own): the sea and the winds are two stages and the seasons four. */
const MAX_CLIMATE_HELPERS = 4;

/**
 * Helper threads for the stages of each keyframe's climate, so the plates keep moving while the climate is worked out, and the stages of
 * a keyframe run side by side. Falls back to doing the stages here if threads cannot be made.
 */
function climateWorkerHost(params: RunParams): { host: ClimateHost; close(): void } {
  const count = Math.max(1, Math.min(MAX_CLIMATE_HELPERS, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) - 1));
  const helpers: Worker[] = [];
  try {
    for (let i = 0; i < count; i++) helpers.push(new Worker(new URL('./climateWorker.ts', import.meta.url), { type: 'module' }));
  } catch {
    for (const h of helpers) h.terminate();
    return { host: inlineClimate(params), close() {} };
  }
  const waiting = new Map<number, { ok(r: StageResult): void; fail(e: Error): void; helper: Worker }>();
  const queue: { job: StageJob; ok(r: StageResult): void; fail(e: Error): void }[] = [];
  const busy = new Set<Worker>();
  const dispatch = () => {
    for (const helper of helpers) {
      if (queue.length === 0) return;
      if (busy.has(helper)) continue;
      const { job, ok, fail } = queue.shift()!;
      busy.add(helper);
      waiting.set(job.id, { ok, fail, helper });
      helper.postMessage(job);
    }
  };
  for (const helper of helpers) {
    helper.addEventListener('message', (e: MessageEvent<StageResult>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      busy.delete(helper);
      if (w) {
        if ('error' in e.data) w.fail(new Error(e.data.error));
        else w.ok(e.data);
      }
      dispatch();
    });
  }
  let next = 0;
  const run = <R extends StageResult>(make: (id: number) => StageJob): Promise<R> =>
    new Promise((ok, fail) => {
      queue.push({ job: make(next++), ok: ok as (r: StageResult) => void, fail });
      dispatch();
    });
  const base = (id: number, elevation: Float64Array, climate: ClimateParams) => ({ id, frequency: params.frequency, params: climate, elevation: elevation.slice() });
  const stages: ClimateStages = {
    currents: async (elevation, climate, previous) => (await run<Extract<StageResult, { stage: 'currents' }>>((id) => ({ ...base(id, elevation, climate), stage: 'currents', previous }))).result,
    heat: async (elevation, climate, psi, previousWarmth) => (await run<Extract<StageResult, { stage: 'heat' }>>((id) => ({ ...base(id, elevation, climate), stage: 'heat', psi, previousWarmth }))).result,
    winds: async (elevation, climate, warmth) => (await run<Extract<StageResult, { stage: 'winds' }>>((id) => ({ ...base(id, elevation, climate), stage: 'winds', warmth }))).result,
    season: async (elevation, climate, s, warmth, wind, lake) => (await run<Extract<StageResult, { stage: 'season' }>>((id) => ({ ...base(id, elevation, climate), stage: 'season', s, warmth, wind, lake }))).result,
  };
  const channel = new MessageChannel();
  return {
    host: {
      climate: (thickness, rock, previous) => keyframeClimate(stages, params.frequency, thickness, params.climate, rock, previous),
      // A message to ourselves is delivered after anything already waiting, so replies from the helpers are handled.
      yield: () => new Promise<void>((r) => { channel.port1.onmessage = () => r(); channel.port2.postMessage(0); }),
    },
    close: () => { for (const h of helpers) h.terminate(); },
  };
}

ctx.addEventListener('message', async (event) => {
  const req = event.data;
  try {
    if (req.type === 'run') {
      const { host, close } = climateWorkerHost(req.params);
      try {
        await runSimulation(req.params, (frame) => {
          const msg: WorkerMessage = { type: 'frame', frame };
          ctx.postMessage(msg, [frame.thickness.buffer, frame.plate.buffer, frame.omega.buffer, frame.rock.buffer, frame.temperature.buffer, frame.precipitation.buffer, frame.flowTo.buffer, frame.discharge.buffer, frame.lake.buffer, frame.windEast.buffer, frame.windNorth.buffer, frame.currentEast.buffer, frame.currentNorth.buffer]);
        }, (time, keyframe) => ctx.postMessage({ type: 'progress', time, keyframe } satisfies WorkerMessage), host);
      } finally {
        close();
      }
      ctx.postMessage({ type: 'done' } satisfies WorkerMessage);
    } else {
      const c = climateForThickness(req.frequency, req.thickness, req.params, req.rock);
      ctx.postMessage({ type: 'climate', id: req.id, ...c } satisfies WorkerMessage, climateBuffers(c));
    }
  } catch (e) {
    ctx.postMessage({ type: 'error', message: String(e) } satisfies WorkerMessage);
  }
});

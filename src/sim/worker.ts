// Web Worker entry: runs simulations and climate passes off the main thread.

import type { ClimateParams } from './climate';
import type { ClimateJob, ClimateResult } from './climateWorker';
import { climateBuffers, climateForThickness, inlineClimate, runSimulation, type ClimateAndWater, type ClimateHost, type Frame, type RunParams } from './runner';

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

/** A second worker for the climate, so the plates keep moving while it works; falls back to doing it in place if one cannot be made. */
function climateWorkerHost(params: RunParams): { host: ClimateHost; close(): void } {
  let helper: Worker;
  try {
    helper = new Worker(new URL('./climateWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    return { host: inlineClimate(params), close() {} };
  }
  const waiting = new Map<number, { ok(c: ClimateAndWater): void; fail(e: Error): void }>();
  helper.addEventListener('message', (e: MessageEvent<ClimateResult>) => {
    const { id, ...rest } = e.data;
    const w = waiting.get(id);
    waiting.delete(id);
    if ('error' in rest) w?.fail(new Error(rest.error));
    else w?.ok(rest as ClimateAndWater);
  });
  let next = 0;
  const channel = new MessageChannel();
  return {
    host: {
      climate: (thickness, rock) =>
        new Promise((ok, fail) => {
          const id = next++;
          waiting.set(id, { ok, fail });
          helper.postMessage({ id, frequency: params.frequency, thickness, rock, params: params.climate } satisfies ClimateJob, [thickness.buffer, rock.buffer]);
        }),
      // A message to ourselves is delivered after anything already waiting, so replies from the helper are handled.
      yield: () => new Promise<void>((r) => { channel.port1.onmessage = () => r(); channel.port2.postMessage(0); }),
    },
    close: () => helper.terminate(),
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

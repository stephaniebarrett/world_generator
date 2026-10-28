// Web Worker entry: works out the climate, rivers and lakes of a keyframe for a running simulation, so the plates can keep moving meanwhile.

import type { ClimateParams } from './climate';
import { climateForThickness, type ClimateAndWater } from './runner';

export interface ClimateJob {
  id: number;
  frequency: number;
  thickness: Float32Array;
  rock: Uint8Array;
  params: ClimateParams | undefined;
}
export type ClimateResult = ({ id: number } & ClimateAndWater) | { id: number; error: string };

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ClimateJob>) => void): void;
}
const ctx = self as unknown as WorkerScope;

ctx.addEventListener('message', (event) => {
  const job = event.data;
  try {
    const c = climateForThickness(job.frequency, job.thickness, job.params, job.rock);
    ctx.postMessage({ id: job.id, ...c } satisfies ClimateResult, [c.temperature.buffer, c.precipitation.buffer, c.flowTo.buffer, c.discharge.buffer, c.lake.buffer]);
  } catch (e) {
    ctx.postMessage({ id: job.id, error: String(e) } satisfies ClimateResult);
  }
});

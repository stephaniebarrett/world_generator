// Web Worker entry: does one stage of a keyframe's climate (the sea, the winds, or a season) for a running simulation, so the stages of a
// keyframe, and the plates, can all be worked on at the same time. Several of these run side by side (see worker.ts).

import type { CirculationState, ClimateParams, SeasonResult, SeasonWind } from './climate';
import type { CurrentsResult } from './climate';
import { climateContext, currentsStage, heatStage, seasonStage, windStage } from './climate';
import { buildLattice } from './lattice';

interface Common {
  id: number;
  frequency: number;
  params: ClimateParams;
  elevation: Float64Array;
}
export type StageJob =
  | (Common & { stage: 'currents'; previous: CirculationState | null })
  | (Common & { stage: 'heat'; psi: Float64Array; previousWarmth: Float32Array | null })
  | (Common & { stage: 'winds'; warmth: Float32Array | null })
  | (Common & { stage: 'season'; s: number; warmth: Float32Array | null; wind: SeasonWind; lake: Uint8Array | null });

export type StageResult =
  | { id: number; stage: 'currents'; result: CurrentsResult }
  | { id: number; stage: 'heat'; result: Float32Array }
  | { id: number; stage: 'winds'; result: SeasonWind[] }
  | { id: number; stage: 'season'; result: SeasonResult }
  | { id: number; error: string };

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<StageJob>) => void): void;
}
const ctx = self as unknown as WorkerScope;

ctx.addEventListener('message', (event) => {
  const job = event.data;
  try {
    const context = climateContext(buildLattice(job.frequency), job.elevation, job.params);
    if (job.stage === 'currents') {
      const result = currentsStage(context, job.previous);
      ctx.postMessage({ id: job.id, stage: 'currents', result } satisfies StageResult, [result.psi.buffer, result.currentEast.buffer, result.currentNorth.buffer]);
    } else if (job.stage === 'heat') {
      const result = heatStage(context, job.psi, job.previousWarmth);
      ctx.postMessage({ id: job.id, stage: 'heat', result } satisfies StageResult, [result.buffer]);
    } else if (job.stage === 'winds') {
      const result = windStage(context, job.warmth);
      ctx.postMessage({ id: job.id, stage: 'winds', result } satisfies StageResult, result.flatMap((w) => [w.east.buffer, w.north.buffer]));
    } else {
      const result = seasonStage(context, job.s, job.warmth, job.wind, job.lake ?? undefined);
      ctx.postMessage({ id: job.id, stage: 'season', result } satisfies StageResult, [result.temperature.buffer, result.precipitation.buffer]);
    }
  } catch (e) {
    ctx.postMessage({ id: job.id, error: String(e) } satisfies StageResult);
  }
});

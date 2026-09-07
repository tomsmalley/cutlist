import type { OptimizeResult } from './optimizer';
import type { Options, PanelSpec, StockSpec } from './types';

export interface CalcRequest {
  runId: number;
  panels: PanelSpec[];
  stock: StockSpec[];
  options: Options;
}

/** OptimizeResult with the Map flattened for postMessage. */
export type SerializedResult = Omit<OptimizeResult, 'unplaced'> & {
  unplaced: [string, number][];
};

export type CalcResponse =
  | { type: 'progress'; runId: number; done: number; total: number; tried: number }
  | { type: 'result'; runId: number; tried: number; final: boolean; result: SerializedResult };

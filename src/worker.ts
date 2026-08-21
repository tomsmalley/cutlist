import { compareScores, generateStrategies, optimize, scoreResult } from './optimizer';
import type { OptimizeResult } from './optimizer';
import type { CalcRequest, CalcResponse } from './messages';

function post(msg: CalcResponse): void {
  postMessage(msg);
}

self.onmessage = (e: MessageEvent<CalcRequest>) => {
  const { runId, panels, stock, options } = e.data;
  const strategies = generateStrategies();

  let best: OptimizeResult | null = null;
  let bestScore: number[] = [];

  for (let i = 0; i < strategies.length; i++) {
    const result = optimize(panels, stock, options, strategies[i]);
    const score = scoreResult(result);
    if (!best || compareScores(score, bestScore) < 0) {
      best = result;
      bestScore = score;
    }
    if ((i + 1) % 8 === 0 && i + 1 < strategies.length) {
      post({ type: 'progress', runId, done: i + 1, total: strategies.length });
    }
  }

  // best is always set: generateStrategies() never returns an empty list.
  const b = best!;
  post({
    type: 'result',
    runId,
    tried: strategies.length,
    result: { ...b, unplaced: [...b.unplaced.entries()] },
  });
};

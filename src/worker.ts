import {
  compareScores,
  deterministicStrategies,
  optimize,
  scoreResult,
  shuffleStrategy,
} from './optimizer';
import type { OptimizeResult, Strategy } from './optimizer';
import type { CalcRequest, CalcResponse, SerializedResult } from './messages';

/** How long to keep exploring random restarts after the deterministic pass. */
const TIME_BUDGET_MS = 10000;
/** Stop early once this many candidates in a row fail to beat the best. */
const STALE_LIMIT = 512;
/** Candidates between yields back to the message queue (abort checks). */
const CHUNK = 48;

let currentRun = 0;

function post(msg: CalcResponse): void {
  postMessage(msg);
}

function serialize(r: OptimizeResult): SerializedResult {
  return { ...r, unplaced: [...r.unplaced.entries()] };
}

const yieldToQueue = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

self.onmessage = (e: MessageEvent<CalcRequest>) => {
  currentRun = e.data.runId;
  void search(e.data);
};

async function search(req: CalcRequest): Promise<void> {
  const { runId, panels, stock, options } = req;
  const start = Date.now();
  const deterministic = deterministicStrategies();

  let best: OptimizeResult | null = null;
  let bestScore: number[] = [];
  let tried = 0;
  let stale = 0;

  const consider = (r: OptimizeResult): void => {
    tried++;
    const score = scoreResult(r);
    if (!best || compareScores(score, bestScore) < 0) {
      best = r;
      bestScore = score;
      stale = 0;
    } else {
      stale++;
    }
  };

  let i = 0;
  let seed = 0;
  for (;;) {
    // The deterministic strategies always run in full; seeded shuffles then
    // keep coming until the time budget is spent or the search goes stale.
    let strategy: Strategy;
    if (i < deterministic.length) {
      strategy = deterministic[i++];
    } else {
      if (Date.now() - start >= TIME_BUDGET_MS || stale >= STALE_LIMIT) break;
      strategy = shuffleStrategy(++seed);
    }
    consider(optimize(panels, stock, options, strategy));

    // Show the deterministic best immediately; the budget refines it.
    if (i === deterministic.length && seed === 0 && best) {
      post({ type: 'result', runId, tried, final: false, result: serialize(best) });
    }

    if (tried % CHUNK === 0) {
      post({
        type: 'progress',
        runId,
        done: Math.min(Date.now() - start, TIME_BUDGET_MS - 1),
        total: TIME_BUDGET_MS,
      });
      await yieldToQueue();
      if (runId !== currentRun) return; // superseded by a newer request
    }
  }

  if (runId !== currentRun || !best) return;
  post({ type: 'result', runId, tried, final: true, result: serialize(best) });
}

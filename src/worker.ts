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
/** Wall-clock gap between progress posts (which double as abort checks). */
const PROGRESS_INTERVAL_MS = 100;
/** Minimum gap between interim result posts; each one re-renders the page. */
const RESULT_INTERVAL_MS = 400;

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
  let unshown = false;
  let lastProgress = start;
  let lastResult = -Infinity;
  let lastPct = 0;

  const consider = (r: OptimizeResult): void => {
    tried++;
    const score = scoreResult(r, options);
    if (!best || compareScores(score, bestScore) < 0) {
      best = r;
      bestScore = score;
      stale = 0;
      unshown = true;
    } else {
      stale++;
    }
  };

  let i = 0;
  let seed = 0;
  let deterministicMs = 0;
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

    const now = Date.now();
    if (i === deterministic.length && seed === 0) deterministicMs = now - start;
    if (now - lastProgress < PROGRESS_INTERVAL_MS) continue;
    lastProgress = now;

    // A big project can spend longer on the deterministic pass than the whole
    // time budget, so the bar tracks the longer of the two: the pass's
    // duration is projected from the strategies finished so far.
    const elapsed = now - start;
    const projected =
      i < deterministic.length ? (elapsed * deterministic.length) / i : deterministicMs;
    const total = Math.max(TIME_BUDGET_MS, projected);
    lastPct = Math.max(lastPct, Math.min(99, Math.floor((100 * elapsed) / total)));
    post({ type: 'progress', runId, done: lastPct, total: 100 });

    // Show the best so far as soon as there is one, and every improvement
    // after that; the budget keeps refining it.
    if (unshown && best && now - lastResult >= RESULT_INTERVAL_MS) {
      lastResult = now;
      unshown = false;
      post({ type: 'result', runId, tried, final: false, result: serialize(best) });
    }

    await yieldToQueue();
    if (runId !== currentRun) return; // superseded by a newer request
  }

  if (runId !== currentRun || !best) return;
  post({ type: 'result', runId, tried, final: true, result: serialize(best) });
}

import type { Options, PanelSpec, StockSpec } from './types';
import { RIP_OVERSIZE } from './types';

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  panelId: string;
  rotated: boolean;
}

export interface StripResult {
  y: number;
  h: number;
  /**
   * Ripped RIP_OVERSIZE over the finished height (pieces trimmed back at the
   * cross-cut station); false means the rip itself must hit the final size.
   */
  oversized: boolean;
}

export interface SheetResult {
  stockId: string;
  length: number;
  width: number;
  placements: Placement[];
  /** Full-length rip strips, in cutting order (top to bottom). */
  strips: StripResult[];
}

export interface OptimizeResult {
  sheets: SheetResult[];
  /** panelId -> number of instances that could not be placed */
  unplaced: Map<string, number>;
  unplacedArea: number;
  placedCount: number;
  totalPanelArea: number;
  totalSheetArea: number;
  /** Total area committed to rip strips (lower = bigger reusable offcut). */
  stripArea: number;
}

/**
 * One way of running the packer. The calculate step tries many strategies and
 * keeps the best-scoring layout.
 */
export interface Strategy {
  /** Order panels are placed in. */
  order: 'maxdim' | 'area' | 'width' | 'length' | 'shuffle';
  /** RNG seed, used when order is 'shuffle'. */
  seed: number;
  /** When opening a new strip, prefer the orientation making it shorter or taller. */
  newStripPref: 'short' | 'tall';
  /** Existing-strip fit: prioritise tight strip height or least leftover length. */
  stripFit: 'height' | 'length';
  /**
   * 'fill' only opens new stock when nothing fits an open sheet; 'smallFirst'
   * opens smaller stock even while a larger open sheet still has room.
   */
  stockPolicy: 'fill' | 'smallFirst';
  /**
   * Pull towards strips already holding the same panel: 'prefer' picks such a
   * strip over a tighter fit elsewhere; 'strict' additionally opens a fresh
   * strip rather than joining a strip of different panels.
   */
  affinity: 'none' | 'prefer' | 'strict';
}

export const DEFAULT_STRATEGY: Strategy = {
  order: 'maxdim',
  seed: 0,
  newStripPref: 'short',
  stripFit: 'height',
  stockPolicy: 'smallFirst',
  affinity: 'prefer',
};

/** Every combination of the packer's discrete heuristic knobs (96 in all). */
export function deterministicStrategies(): Strategy[] {
  const strategies: Strategy[] = [];
  for (const order of ['maxdim', 'area', 'width', 'length'] as const) {
    for (const newStripPref of ['short', 'tall'] as const) {
      for (const stripFit of ['height', 'length'] as const) {
        for (const stockPolicy of ['fill', 'smallFirst'] as const) {
          for (const affinity of ['none', 'prefer', 'strict'] as const) {
            strategies.push({ order, seed: 0, newStripPref, stripFit, stockPolicy, affinity });
          }
        }
      }
    }
  }
  return strategies;
}

/** A seeded random-restart strategy; the search draws these until its time budget runs out. */
export function shuffleStrategy(seed: number): Strategy {
  return {
    order: 'shuffle',
    seed,
    newStripPref: seed % 2 === 0 ? 'short' : 'tall',
    stripFit: (seed >> 1) % 2 === 0 ? 'height' : 'length',
    stockPolicy: (seed >> 2) % 2 === 0 ? 'fill' : 'smallFirst',
    affinity: (['none', 'prefer', 'strict'] as const)[seed % 3],
  };
}

/**
 * The workshop cut model: full-length rips (3m track, unwieldy) happen first
 * and never again after cross cutting. Everything else is a cross cut on the
 * hinged rail: separating cuts across a strip, plus one trim cut per piece
 * that sits below its strip height (the piece is rotated and cut along its
 * long axis, so its width must fit the cross-cut capacity).
 *
 * Lexicographic layout quality, lower is better:
 *   unplaced panel area → sheets consumed (total stock area) → weighted cuts
 *   (rips cost RIP_WEIGHT cross cuts each) → mixed-panel strips → prefer
 *   smaller sheets on ties → committed strip area (biggest reusable offcut).
 */
/**
 * A full-length rip costs about this many cross cuts of effort. Finite on
 * purpose: ranking rips lexicographically above cross cuts made the packer
 * pad a strip with taller panels so the strip heights summed exactly to the
 * sheet width (saving the last rip) at the price of a trim cut per shorter
 * piece in that strip — more cuts and shredded offcuts to save one rip.
 */
const RIP_WEIGHT = 3;

export function scoreResult(r: OptimizeResult): number[] {
  let rips = 0;
  let crosses = 0;
  let mix = 0;
  let sumSq = 0;
  for (const sheet of r.sheets) {
    const area = sheet.length * sheet.width;
    sumSq += area * area;
    for (const strip of sheet.strips) {
      if (strip.y + strip.h < sheet.width) rips++;
      const items = sheet.placements
        .filter((p) => p.y === strip.y)
        .sort((a, b) => a.x - b.x);
      if (items.length === 0) continue;
      crosses += items.length - 1;
      const last = items[items.length - 1];
      if (last.x + last.w < sheet.length) crosses++;
      for (const p of items) if (p.h < strip.h) crosses++;
      const kinds = new Set(items.map((p) => p.panelId));
      if (kinds.size > 1) mix += kinds.size - 1;
    }
  }
  return [r.unplacedArea, r.totalSheetArea, RIP_WEIGHT * rips + crosses, mix, sumSq, r.stripArea];
}

export function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sortInstances(instances: PanelSpec[], strategy: Strategy): void {
  const area = (p: PanelSpec) => p.length * p.width;
  switch (strategy.order) {
    case 'maxdim':
      instances.sort(
        (a, b) =>
          Math.max(b.length, b.width) - Math.max(a.length, a.width) || area(b) - area(a)
      );
      break;
    case 'area':
      instances.sort(
        (a, b) => area(b) - area(a) || Math.max(b.length, b.width) - Math.max(a.length, a.width)
      );
      break;
    case 'width':
      instances.sort((a, b) => b.width - a.width || area(b) - area(a));
      break;
    case 'length':
      instances.sort((a, b) => b.length - a.length || area(b) - area(a));
      break;
    case 'shuffle': {
      const rand = mulberry32(strategy.seed);
      for (let i = instances.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [instances[i], instances[j]] = [instances[j], instances[i]];
      }
      break;
    }
  }
}

interface Orientation {
  w: number;
  h: number;
  rotated: boolean;
}

/**
 * Two-stage layout matching a tracksaw workflow: first-stage cuts always run
 * the FULL LENGTH of the sheet (rips), producing strips; panels are then
 * cross-cut from those strips. Sheets are laid out with length along x.
 * A panel's alignment fixes its length parallel or perpendicular to the
 * sheet length; 'any' allows both.
 */
function orientations(panel: PanelSpec): Orientation[] {
  const along: Orientation = { w: panel.length, h: panel.width, rotated: false };
  const across: Orientation = { w: panel.width, h: panel.length, rotated: true };
  if (panel.alignment === 'parallel') return [along];
  if (panel.alignment === 'perpendicular') return [across];
  if (panel.length === panel.width) return [along];
  return [along, across];
}

// ---------------------------------------------------------------------------
// Greedy packing

interface Strip {
  y: number;
  /** Nominal height: the tallest FINISHED piece. Oversized strips occupy os more. */
  h: number;
  usedLength: number;
  /**
   * Ripped RIP_OVERSIZE over nominal height; every piece in the strip is then
   * trimmed to final size at the cross-cut station. Fixed when the strip is
   * opened: only trimmable pieces (which keep the flag true) may join.
   */
  oversized: boolean;
  /**
   * Panels in this strip and their rotation. A panel keeps ONE orientation
   * within a strip (uniform, batch-cuttable runs); other strips — even on
   * the same sheet — may orient it differently.
   */
  rotations: Map<string, boolean>;
}

interface OpenSheet {
  spec: StockSpec;
  strips: Strip[];
  usedWidth: number;
  placements: Placement[];
}

type Score = [number, number, number, number];

function lessThan(a: Score, b: Score): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

interface Candidate {
  sheet: OpenSheet;
  strip: Strip | null; // null = open a new strip
  orient: Orientation;
  /** For a new strip: whether it is ripped oversized. */
  oversized: boolean;
  score: Score;
}

/**
 * Whether a piece can live in an oversized strip: its trim cut (along its
 * length) and the strip's separating cuts (across the oversized height) must
 * both fit the cross-cut capacity.
 */
function oversizable(orient: Orientation, os: number, cap: number): boolean {
  return os > 0 && orient.w <= cap && orient.h + os <= cap;
}

function bestFitInSheet(
  sheet: OpenSheet,
  orients: Orientation[],
  kerf: number,
  cap: number,
  os: number,
  strategy: Strategy,
  panelId: string
): Candidate | null {
  const { length: sheetL, width: sheetW } = sheet.spec;
  // Candidate rank before fit quality: same-panel strips come first under any
  // affinity; 'strict' prefers a fresh strip over joining a mixed one.
  const catSame = 0;
  const catOther = strategy.affinity === 'none' ? 0 : strategy.affinity === 'prefer' ? 1 : 2;
  const catNew = strategy.affinity === 'strict' ? 1 : strategy.affinity === 'prefer' ? 2 : 1;
  let best: Candidate | null = null;

  for (const orient of orients) {
    // Existing strips: fit the strip height, remaining length, this strip's
    // rotation lock for the panel, and the cross-cut rules — a shared strip
    // gets separating cross cuts (strip height ≤ capacity) and any trim is a
    // cross cut along the piece (piece width ≤ capacity).
    for (const strip of sheet.strips) {
      if (orient.h > strip.h) continue;
      if (strip.h + (strip.oversized ? os : 0) > cap) continue;
      const trimmed = strip.oversized || orient.h < strip.h;
      if (trimmed && orient.w > cap) continue;
      // An untrimmed edge on a trimmable piece defeats the option: such a
      // piece belongs in an oversized strip, never flush in an exact one.
      if (!trimmed && oversizable(orient, os, cap)) continue;
      const locked = strip.rotations.get(panelId);
      if (locked !== undefined && orient.rotated !== locked) continue;
      const xStart = strip.usedLength === 0 ? 0 : strip.usedLength + kerf;
      if (xStart + orient.w > sheetL) continue;
      const cat = locked !== undefined ? catSame : catOther;
      const heightWaste = strip.h - orient.h;
      const leftoverLen = sheetL - (xStart + orient.w);
      const score: Score =
        strategy.stripFit === 'height'
          ? [cat, heightWaste, leftoverLen, 0]
          : [cat, leftoverLen, heightWaste, 0];
      if (!best || lessThan(score, best.score))
        best = { sheet, strip, orient, oversized: strip.oversized, score };
    }
    // New strip: needs remaining sheet width. A trimmable piece opens an
    // oversized strip; otherwise a strip taller than the cross-cut capacity
    // can never be cross cut, so it may only hold a single panel spanning the
    // full sheet length (no cuts after the rips).
    const canOs = oversizable(orient, os, cap);
    const yStart = sheet.usedWidth === 0 ? 0 : sheet.usedWidth + kerf;
    if (orient.w <= sheetL && yStart + orient.h + (canOs ? os : 0) <= sheetW) {
      if (canOs || orient.h <= cap || orient.w === sheetL) {
        const heightKey = strategy.newStripPref === 'short' ? orient.h : -orient.h;
        const score: Score = [catNew, heightKey, sheetL - orient.w, 0];
        if (!best || lessThan(score, best.score))
          best = { sheet, strip: null, orient, oversized: canOs, score };
      }
    }
  }
  return best;
}

function place(c: Candidate, panelId: string, kerf: number, os: number): void {
  const { sheet, orient } = c;
  let strip = c.strip;
  if (!strip) {
    const y = sheet.usedWidth === 0 ? 0 : sheet.usedWidth + kerf;
    strip = { y, h: orient.h, usedLength: 0, oversized: c.oversized, rotations: new Map() };
    sheet.strips.push(strip);
    sheet.usedWidth = y + orient.h + (c.oversized ? os : 0);
  }
  const x = strip.usedLength === 0 ? 0 : strip.usedLength + kerf;
  sheet.placements.push({ x, y: strip.y, w: orient.w, h: orient.h, panelId, rotated: orient.rotated });
  strip.usedLength = x + orient.w;
  strip.rotations.set(panelId, orient.rotated);
}

// ---------------------------------------------------------------------------
// Local improvement: relocate/swap placements between strips after the greedy
// pass. The greedy packer fixes strip heights the moment strips open; these
// moves let a strip shrink when its tallest occupant finds a better home
// (e.g. pulling a lone tall panel out of a run of shorter ones).

interface Item {
  panelId: string;
  w: number;
  h: number;
  rotated: boolean;
}

interface ISheet {
  spec: StockSpec;
  strips: Item[][];
}

const MAX_IMPROVE_ROUNDS = 40;
const MAX_IMPROVE_ITEMS = 200;
const MAX_SWAP_ITEMS = 80;

function stripH(st: Item[]): number {
  return st.reduce((m, i) => Math.max(m, i.h), 0);
}

/**
 * Physical (ripped) strip height: nominal plus the oversize allowance when
 * the strip qualifies — every piece trimmable and the oversized height still
 * cross-cuttable. Matches how the greedy packer sets Strip.oversized, so the
 * flag never needs carrying through improvement moves.
 */
function stripOversized(st: Item[], os: number, cap: number): boolean {
  return os > 0 && stripH(st) + os <= cap && st.every((it) => it.w <= cap);
}

function stripPhysH(st: Item[], os: number, cap: number): number {
  return stripH(st) + (stripOversized(st, os, cap) ? os : 0);
}

function stripLen(st: Item[], kerf: number): number {
  return st.reduce((s, i) => s + i.w, 0) + kerf * (st.length - 1);
}

function stripFeasible(st: Item[], spec: StockSpec, kerf: number, cap: number, os: number): boolean {
  const physH = stripPhysH(st, os, cap);
  const len = stripLen(st, kerf);
  if (len > spec.length) return false;
  const needsSeparating = st.length > 1 || len < spec.length;
  if (needsSeparating && physH > cap) return false;
  for (const it of st) {
    if (it.h < physH && it.w > cap) return false;
    // Trimmable pieces must actually be trimmed (see bestFitInSheet).
    if (it.h >= physH && os > 0 && it.w <= cap && it.h + os <= cap) return false;
  }
  // Rotation lock: same panel, same orientation within a strip.
  const rot = new Map<string, boolean>();
  for (const it of st) {
    const r = rot.get(it.panelId);
    if (r !== undefined && r !== it.rotated) return false;
    rot.set(it.panelId, it.rotated);
  }
  return true;
}

function sheetFeasible(sh: ISheet, kerf: number, cap: number, os: number): boolean {
  const used =
    sh.strips.reduce((s, st) => s + stripPhysH(st, os, cap), 0) + kerf * (sh.strips.length - 1);
  if (used > sh.spec.width) return false;
  return sh.strips.every((st) => st.length > 0 && stripFeasible(st, sh.spec, kerf, cap, os));
}

/** Same ordering as scoreResult, minus the components moves cannot change. */
function improveObjective(layout: ISheet[], kerf: number, cap: number, os: number): number[] {
  let totalArea = 0;
  let rips = 0;
  let crosses = 0;
  let mix = 0;
  let sumSq = 0;
  let stripArea = 0;
  for (const sh of layout) {
    const area = sh.spec.length * sh.spec.width;
    totalArea += area;
    sumSq += area * area;
    let y = 0;
    for (const st of sh.strips) {
      const h = stripPhysH(st, os, cap);
      stripArea += h * sh.spec.length;
      y += h;
      if (y < sh.spec.width) rips++;
      y += kerf;
      crosses += st.length - 1;
      if (stripLen(st, kerf) < sh.spec.length) crosses++;
      for (const it of st) if (it.h < h) crosses++;
      const kinds = new Set(st.map((i) => i.panelId));
      if (kinds.size > 1) mix += kinds.size - 1;
    }
  }
  return [totalArea, RIP_WEIGHT * rips + crosses, mix, sumSq, stripArea];
}

/** Group same-panel items adjacent, ordered by first appearance. */
function groupItems(items: Item[]): Item[] {
  const order = new Map<string, number>();
  for (const it of items) if (!order.has(it.panelId)) order.set(it.panelId, order.size);
  return [...items].sort((a, b) => order.get(a.panelId)! - order.get(b.panelId)!);
}

function insertGrouped(st: Item[], item: Item): void {
  for (let i = st.length - 1; i >= 0; i--) {
    if (st[i].panelId === item.panelId) {
      st.splice(i + 1, 0, item);
      return;
    }
  }
  st.push(item);
}

/** Orientations an item may take in a target strip (alignment + strip lock). */
function orientedItems(spec: PanelSpec, targetStrip: Item[] | null): Item[] {
  let opts = orientations(spec).map((o) => ({
    panelId: spec.id,
    w: o.w,
    h: o.h,
    rotated: o.rotated,
  }));
  if (targetStrip) {
    const lock = targetStrip.find((it) => it.panelId === spec.id);
    if (lock) opts = opts.filter((o) => o.rotated === lock.rotated);
  }
  return opts;
}

function cloneFor(layout: ISheet[], a: number, b: number): ISheet[] {
  return layout.map((sh, idx) =>
    idx === a || idx === b ? { spec: sh.spec, strips: sh.strips.map((st) => st.slice()) } : sh
  );
}

function pruneAndCheck(
  clone: ISheet[],
  touched: number[],
  kerf: number,
  cap: number,
  os: number
): ISheet[] | null {
  for (const idx of touched) {
    clone[idx].strips = clone[idx].strips.filter((st) => st.length > 0);
    if (clone[idx].strips.length > 0 && !sheetFeasible(clone[idx], kerf, cap, os)) return null;
  }
  return clone.filter((sh) => sh.strips.length > 0);
}

function applyRelocate(
  layout: ISheet[],
  a: number,
  i: number,
  k: number,
  b: number,
  j: number,
  item: Item,
  kerf: number,
  cap: number,
  os: number
): ISheet[] | null {
  const clone = cloneFor(layout, a, b);
  clone[a].strips[i].splice(k, 1);
  if (j >= clone[b].strips.length) clone[b].strips.push([item]);
  else insertGrouped(clone[b].strips[j], item);
  return pruneAndCheck(clone, a === b ? [a] : [a, b], kerf, cap, os);
}

function applySwapVariants(
  layout: ISheet[],
  a: number,
  i: number,
  k: number,
  b: number,
  j: number,
  l: number,
  byId: Map<string, PanelSpec>,
  kerf: number,
  cap: number,
  os: number
): ISheet[][] {
  const p = layout[a].strips[i][k];
  const q = layout[b].strips[j][l];
  if (p.panelId === q.panelId) return [];
  const pSpec = byId.get(p.panelId);
  const qSpec = byId.get(q.panelId);
  if (!pSpec || !qSpec) return [];
  const pOpts = orientedItems(pSpec, layout[b].strips[j].filter((_, idx) => idx !== l));
  const qOpts = orientedItems(qSpec, layout[a].strips[i].filter((_, idx) => idx !== k));
  const variants: ISheet[][] = [];
  for (const po of pOpts) {
    for (const qo of qOpts) {
      const clone = cloneFor(layout, a, b);
      clone[a].strips[i].splice(k, 1);
      clone[b].strips[j].splice(l, 1);
      insertGrouped(clone[b].strips[j], po);
      insertGrouped(clone[a].strips[i], qo);
      const pruned = pruneAndCheck(clone, a === b ? [a] : [a, b], kerf, cap, os);
      if (pruned) variants.push(pruned);
    }
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Class repack: relocations and swaps move one piece at a time, so they can
// never restructure whole strips — e.g. turning {5 fronts} + {6 sides} plus a
// stray front trimmed elsewhere into two mixed 3+3 strips takes several
// coordinated moves whose intermediates all score worse, and hill climbing
// refuses the first step. Instead, dissolve every strip of one height class
// (plus same-height pieces trimmed inside taller strips) and re-solve their
// 1-D packing exactly, keeping the result only when the global objective
// improves.

const REPACK_MAX_GROUPS = 6;
const REPACK_MAX_ITEMS = 40;
const REPACK_NODE_BUDGET = 20000;

/**
 * Exact 1-D bin packing of grouped pieces: fewest bins first, then least
 * mixing (Σ per-bin distinct panels − 1), matching the objective's ranking.
 * A fill is a per-group count vector; bins are generated in non-increasing
 * lexicographic fill order to break symmetry, and a panel may not appear in
 * one bin under two groups (the strip rotation lock). Best-so-far within the
 * node budget; null when nothing packs.
 */
function packClass(
  widths: number[],
  panels: string[],
  total: number[],
  cap: number,
  kerf: number
): number[][] | null {
  const n = widths.length;
  let nodes = 0;
  let best: number[][] | null = null;
  let bestBins = Infinity;
  let bestMix = Infinity;

  const remLen = (rem: number[]) => rem.reduce((s, c, i) => s + c * widths[i], 0);

  // Fill vectors for one bin, largest counts first, each lexicographically
  // ≤ limit (the previous bin's fill).
  function fillsFor(rem: number[], limit: number[] | null): number[][] {
    const out: number[][] = [];
    const cur = new Array<number>(n).fill(0);
    const rec = (i: number, len: number, count: number, bounded: boolean): void => {
      if (nodes > REPACK_NODE_BUDGET) return;
      if (i === n) {
        if (count > 0) out.push(cur.slice());
        return;
      }
      let max = bounded && limit ? limit[i] : rem[i];
      for (let c = Math.min(max, rem[i]); c >= 0; c--) {
        if (c > 0) {
          const dup = panels.some((p, j) => j < i && cur[j] > 0 && p === panels[i]);
          if (dup) continue;
          const nlen = len + c * widths[i] + (count > 0 ? kerf : 0) + (c - 1) * kerf;
          if (nlen > cap) continue;
          cur[i] = c;
          nodes++;
          rec(i + 1, nlen, count + c, bounded && limit !== null && c === limit[i]);
          cur[i] = 0;
        } else {
          nodes++;
          rec(i + 1, len, count, bounded && (limit === null || limit[i] === 0));
        }
      }
    };
    rec(0, 0, 0, limit !== null);
    return out;
  }

  const dfs = (rem: number[], limit: number[] | null, bins: number[][], mix: number): void => {
    if (nodes > REPACK_NODE_BUDGET) return;
    const rl = remLen(rem);
    if (rl === 0) {
      if (bins.length < bestBins || (bins.length === bestBins && mix < bestMix)) {
        best = bins.map((b) => b.slice());
        bestBins = bins.length;
        bestMix = mix;
      }
      return;
    }
    const lb = bins.length + Math.ceil(rl / cap);
    if (lb > bestBins || (lb === bestBins && mix >= bestMix)) return;
    for (const f of fillsFor(rem, limit)) {
      const nrem = rem.map((c, i) => c - f[i]);
      const kinds = new Set(panels.filter((_, i) => f[i] > 0)).size;
      dfs(nrem, f, [...bins, f], mix + kinds - 1);
    }
  };
  dfs(total, null, [], 0);
  return best;
}

function cloneAll(layout: ISheet[]): ISheet[] {
  return layout.map((sh) => ({ spec: sh.spec, strips: sh.strips.map((st) => st.slice()) }));
}

function tryRepackClass(
  layout: ISheet[],
  v: number,
  includeStrays: boolean,
  kerf: number,
  cap: number,
  os: number
): ISheet[] | null {
  const slots: { sheet: number; strip: number }[] = [];
  const strays: { sheet: number; strip: number; item: number }[] = [];
  for (let a = 0; a < layout.length; a++) {
    for (let i = 0; i < layout[a].strips.length; i++) {
      const st = layout[a].strips[i];
      if (stripH(st) === v) {
        slots.push({ sheet: a, strip: i });
      } else if (includeStrays) {
        for (let k = 0; k < st.length; k++) {
          if (st[k].h === v && st[k].h < stripH(st)) strays.push({ sheet: a, strip: i, item: k });
        }
      }
    }
  }
  if (slots.length === 0 || (slots.length < 2 && strays.length === 0)) return null;

  const pool: Item[] = [];
  for (const s of slots) pool.push(...layout[s.sheet].strips[s.strip]);
  for (const s of strays) pool.push(layout[s.sheet].strips[s.strip][s.item]);
  if (pool.length > REPACK_MAX_ITEMS) return null;

  // Same panel + rotation ⇒ identical dimensions, so groups need no size key.
  const groups = new Map<string, Item[]>();
  for (const it of pool) {
    const key = `${it.panelId}|${it.rotated ? 1 : 0}`;
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  if (groups.size > REPACK_MAX_GROUPS) return null;
  const members = [...groups.values()];
  const widths = members.map((g) => g[0].w);
  const panels = members.map((g) => g[0].panelId);
  const counts = members.map((g) => g.length);

  const slotLens = slots
    .map((s) => layout[s.sheet].spec.length)
    .sort((a, b) => b - a);
  const bins = packClass(widths, panels, counts, slotLens[0], kerf);
  if (!bins || bins.length > slots.length) return null;

  // Longest bins claim the longest-sheet slots; the rest of the slots close.
  const binLen = (b: number[]) =>
    b.reduce((s, c, i) => s + c * widths[i], 0) + kerf * (b.reduce((s, c) => s + c, 0) - 1);
  bins.sort((a, b) => binLen(b) - binLen(a));
  const orderedSlots = [...slots].sort(
    (a, b) => layout[b.sheet].spec.length - layout[a.sheet].spec.length
  );
  for (let i = 0; i < bins.length; i++) {
    if (binLen(bins[i]) > layout[orderedSlots[i].sheet].spec.length) return null;
  }

  const clone = cloneAll(layout);
  const byStrip = new Map<string, number[]>();
  for (const s of strays) {
    const key = `${s.sheet}:${s.strip}`;
    const arr = byStrip.get(key);
    if (arr) arr.push(s.item);
    else byStrip.set(key, [s.item]);
  }
  for (const [key, items] of byStrip) {
    const [a, i] = key.split(':').map(Number);
    for (const k of items.sort((x, y) => y - x)) clone[a].strips[i].splice(k, 1);
  }
  const pools = members.map((g) => g.slice());
  for (let i = 0; i < orderedSlots.length; i++) {
    const target: Item[] = [];
    if (i < bins.length) {
      for (let gi = 0; gi < members.length; gi++) {
        for (let c = 0; c < bins[i][gi]; c++) target.push(pools[gi].pop()!);
      }
    }
    clone[orderedSlots[i].sheet].strips[orderedSlots[i].strip] = target;
  }
  const touched = new Set<number>(orderedSlots.map((s) => s.sheet));
  for (const s of strays) touched.add(s.sheet);
  return pruneAndCheck(clone, [...touched], kerf, cap, os);
}

function findClassRepack(
  layout: ISheet[],
  obj: number[],
  kerf: number,
  cap: number,
  os: number
): { layout: ISheet[]; obj: number[] } | null {
  const heights = new Set<number>();
  for (const sh of layout) for (const st of sh.strips) heights.add(stripH(st));
  for (const v of [...heights].sort((a, b) => b - a)) {
    for (const includeStrays of [true, false]) {
      const cand = tryRepackClass(layout, v, includeStrays, kerf, cap, os);
      if (!cand) continue;
      const candObj = improveObjective(cand, kerf, cap, os);
      if (compareScores(candObj, obj) < 0) return { layout: cand, obj: candObj };
    }
  }
  return null;
}

function findImprovingMove(
  layout: ISheet[],
  obj: number[],
  byId: Map<string, PanelSpec>,
  kerf: number,
  cap: number,
  os: number,
  allowSwaps: boolean
): { layout: ISheet[]; obj: number[] } | null {
  for (let a = 0; a < layout.length; a++) {
    for (let i = 0; i < layout[a].strips.length; i++) {
      for (let k = 0; k < layout[a].strips[i].length; k++) {
        const spec = byId.get(layout[a].strips[i][k].panelId);
        if (!spec) continue;

        // Relocations (including to a brand-new strip on any sheet).
        for (let b = 0; b < layout.length; b++) {
          const stripCount = layout[b].strips.length;
          for (let j = 0; j <= stripCount; j++) {
            if (a === b && j === i) continue;
            const target = j < stripCount ? layout[b].strips[j] : null;
            for (const item of orientedItems(spec, target)) {
              const cand = applyRelocate(layout, a, i, k, b, j, item, kerf, cap, os);
              if (!cand) continue;
              const candObj = improveObjective(cand, kerf, cap, os);
              if (compareScores(candObj, obj) < 0) return { layout: cand, obj: candObj };
            }
          }
        }

        if (!allowSwaps) continue;
        // Swaps with every placement strictly after (a, i, k).
        for (let b = a; b < layout.length; b++) {
          const jStart = b === a ? i + 1 : 0;
          for (let j = jStart; j < layout[b].strips.length; j++) {
            for (let l = 0; l < layout[b].strips[j].length; l++) {
              for (const cand of applySwapVariants(layout, a, i, k, b, j, l, byId, kerf, cap, os)) {
                const candObj = improveObjective(cand, kerf, cap, os);
                if (compareScores(candObj, obj) < 0) return { layout: cand, obj: candObj };
              }
            }
          }
        }
      }
    }
  }
  return null;
}

function improve(
  layout: ISheet[],
  byId: Map<string, PanelSpec>,
  kerf: number,
  cap: number,
  os: number
): ISheet[] {
  const itemCount = layout.reduce((s, sh) => s + sh.strips.reduce((t, st) => t + st.length, 0), 0);
  if (itemCount === 0 || itemCount > MAX_IMPROVE_ITEMS) return layout;
  const allowSwaps = itemCount <= MAX_SWAP_ITEMS;
  let current = layout;
  let obj = improveObjective(current, kerf, cap, os);
  for (let round = 0; round < MAX_IMPROVE_ROUNDS; round++) {
    const next =
      findClassRepack(current, obj, kerf, cap, os) ??
      findImprovingMove(current, obj, byId, kerf, cap, os, allowSwaps);
    if (!next) break;
    current = next.layout;
    obj = next.obj;
  }
  return current;
}

// ---------------------------------------------------------------------------

export function optimize(
  panels: PanelSpec[],
  stock: StockSpec[],
  options: Options,
  strategy: Strategy = DEFAULT_STRATEGY
): OptimizeResult {
  const kerf = Math.max(0, options.kerf || 0);
  const cap = options.crossCutCap > 0 ? options.crossCutCap : Infinity;
  const os = options.ripOversized ? RIP_OVERSIZE : 0;

  const instances = panels
    .filter((p) => p.enabled && p.qty > 0 && p.length > 0 && p.width > 0)
    .flatMap((p) => Array.from({ length: p.qty }, () => p));

  sortInstances(instances, strategy);

  const stockPool = stock
    .filter((s) => s.enabled && s.qty > 0 && s.length > 0 && s.width > 0)
    .map((s) => ({ spec: s, remaining: s.qty }));

  const open: OpenSheet[] = [];
  const unplaced = new Map<string, number>();
  let unplacedArea = 0;
  let placedCount = 0;
  let totalPanelArea = 0;

  const specArea = (s: StockSpec) => s.length * s.width;
  const markUnplaced = (panel: PanelSpec) => {
    unplaced.set(panel.id, (unplaced.get(panel.id) ?? 0) + 1);
    unplacedArea += panel.length * panel.width;
  };

  for (const panel of instances) {
    const orients = orientations(panel);

    // Best fit among open sheets; under 'smallFirst', a smaller open sheet
    // beats a better fit on a larger one.
    let bestOpen: Candidate | null = null;
    for (const sheet of open) {
      const c = bestFitInSheet(sheet, orients, kerf, cap, os, strategy, panel.id);
      if (!c) continue;
      if (!bestOpen) {
        bestOpen = c;
      } else if (strategy.stockPolicy === 'smallFirst') {
        const ca = specArea(c.sheet.spec);
        const ba = specArea(bestOpen.sheet.spec);
        if (ca < ba || (ca === ba && lessThan(c.score, bestOpen.score))) bestOpen = c;
      } else if (lessThan(c.score, bestOpen.score)) {
        bestOpen = c;
      }
    }

    // Smallest unopened stock sheet the panel is cuttable from.
    let chosenStock: { spec: StockSpec; remaining: number } | null = null;
    for (const s of stockPool) {
      if (s.remaining <= 0) continue;
      const fits = orients.some((o) => {
        const canOs = oversizable(o, os, cap);
        return (
          o.w <= s.spec.length &&
          o.h + (canOs ? os : 0) <= s.spec.width &&
          (canOs || o.h <= cap || o.w === s.spec.length)
        );
      });
      if (!fits) continue;
      if (!chosenStock || specArea(s.spec) < specArea(chosenStock.spec)) chosenStock = s;
    }

    let openNew = !bestOpen;
    if (
      bestOpen &&
      chosenStock &&
      strategy.stockPolicy === 'smallFirst' &&
      specArea(chosenStock.spec) < specArea(bestOpen.sheet.spec)
    ) {
      openNew = true;
    }

    let best = bestOpen;
    if (openNew) {
      if (!chosenStock) {
        markUnplaced(panel);
        continue;
      }
      chosenStock.remaining--;
      const sheet: OpenSheet = { spec: chosenStock.spec, strips: [], usedWidth: 0, placements: [] };
      open.push(sheet);
      best = bestFitInSheet(sheet, orients, kerf, cap, os, strategy, panel.id);
      if (!best) {
        open.pop();
        chosenStock.remaining++;
        markUnplaced(panel);
        continue;
      }
    }

    place(best!, panel.id, kerf, os);
    placedCount++;
    totalPanelArea += panel.length * panel.width;
  }

  // Local improvement on the nested strip model, then rebuild placements.
  const byId = new Map(panels.map((p) => [p.id, p] as const));
  let layout: ISheet[] = open
    .filter((sh) => sh.placements.length > 0)
    .map((sh) => ({
      spec: sh.spec,
      strips: [...sh.strips]
        .sort((a, b) => a.y - b.y)
        .map((st) =>
          groupItems(
            sh.placements
              .filter((p) => p.y === st.y)
              .sort((a, b) => a.x - b.x)
              .map((p) => ({ panelId: p.panelId, w: p.w, h: p.h, rotated: p.rotated }))
          )
        ),
    }));
  layout = improve(layout, byId, kerf, cap, os);

  // Result strips carry PHYSICAL (ripped) heights; pieces keep finished
  // sizes, so oversized strips show every piece trimmed down (h < strip.h).
  const sheets: SheetResult[] = layout.map((sh) => {
    const placements: Placement[] = [];
    const strips: StripResult[] = [];
    let y = 0;
    for (const st of sh.strips) {
      const h = stripPhysH(st, os, cap);
      let x = 0;
      for (const it of st) {
        placements.push({ x, y, w: it.w, h: it.h, panelId: it.panelId, rotated: it.rotated });
        x += it.w + kerf;
      }
      strips.push({ y, h, oversized: stripOversized(st, os, cap) });
      y += h + kerf;
    }
    return {
      stockId: sh.spec.id,
      length: sh.spec.length,
      width: sh.spec.width,
      placements,
      strips,
    };
  });

  const totalSheetArea = sheets.reduce((sum, s) => sum + s.length * s.width, 0);
  const stripArea = sheets.reduce(
    (sum, s) => sum + s.strips.reduce((a, t) => a + t.h * s.length, 0),
    0
  );

  return { sheets, unplaced, unplacedArea, placedCount, totalPanelArea, totalSheetArea, stripArea };
}

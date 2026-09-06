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
 * long axis). A cross cut longer than the capacity is still possible with
 * the long track — a NON-STANDARD cut, weighted NONSTD_WEIGHT.
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

/**
 * A NON-STANDARD cross cut — one longer than the cross-cut capacity, so it
 * cannot be made at the station and needs the long track set up on the
 * workpiece — costs this many standard cross cuts. Heavy enough that the
 * packer only resorts to one when it saves a sheet or places a panel that
 * would otherwise not fit, never merely to save a rip or two.
 */
export const NONSTD_WEIGHT = 10;

/** The cross-cut capacity as a bound (0 = unlimited). */
export function crossCap(options: Options): number {
  return options.crossCutCap > 0 ? options.crossCutCap : Infinity;
}

/** Whether a cross cut of this length exceeds the station's capacity. */
export function isNonStandard(cutLength: number, cap: number): boolean {
  return cutLength > cap;
}

export function scoreResult(r: OptimizeResult, options: Options): number[] {
  const cap = crossCap(options);
  let rips = 0;
  let crosses = 0;
  let nonstd = 0;
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
      // Separating cuts run across the strip (length = strip height).
      let separating = items.length - 1;
      const last = items[items.length - 1];
      if (last.x + last.w < sheet.length) separating++;
      if (isNonStandard(strip.h, cap)) nonstd += separating;
      else crosses += separating;
      // Trims run along the piece (length = piece width).
      for (const p of items) {
        if (p.h < strip.h) {
          if (isNonStandard(p.w, cap)) nonstd++;
          else crosses++;
        }
      }
      const kinds = new Set(items.map((p) => p.panelId));
      if (kinds.size > 1) mix += kinds.size - 1;
    }
  }
  return [
    r.unplacedArea,
    r.totalSheetArea,
    RIP_WEIGHT * rips + crosses + NONSTD_WEIGHT * nonstd,
    mix,
    sumSq,
    r.stripArea,
  ];
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

/** Greedy fit rank: non-standard cuts needed, affinity category, then fit. */
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
    // Existing strips: fit the strip height, remaining length, and this
    // strip's rotation lock for the panel. A shared strip gets separating
    // cross cuts (across the strip height) and any trim is a cross cut along
    // the piece (its width); either one longer than the capacity is a
    // non-standard cut, allowed but ranked behind every standard fit.
    for (const strip of sheet.strips) {
      if (orient.h > strip.h) continue;
      const physH = strip.h + (strip.oversized ? os : 0);
      const trimmed = strip.oversized || orient.h < strip.h;
      // Oversized strips exist to trim at the station; keep them to pieces
      // whose trim fits the capacity (see stripOversized).
      if (strip.oversized && orient.w > cap) continue;
      // An untrimmed edge on a trimmable piece defeats the option: such a
      // piece belongs in an oversized strip, never flush in an exact one.
      if (!trimmed && oversizable(orient, os, cap)) continue;
      const locked = strip.rotations.get(panelId);
      if (locked !== undefined && orient.rotated !== locked) continue;
      const xStart = strip.usedLength === 0 ? 0 : strip.usedLength + kerf;
      if (xStart + orient.w > sheetL) continue;
      const nonstd =
        (isNonStandard(physH, cap) ? 1 : 0) + (trimmed && isNonStandard(orient.w, cap) ? 1 : 0);
      const cat = locked !== undefined ? catSame : catOther;
      const heightWaste = strip.h - orient.h;
      const leftoverLen = sheetL - (xStart + orient.w);
      const score: Score =
        strategy.stripFit === 'height'
          ? [nonstd, cat, heightWaste, leftoverLen]
          : [nonstd, cat, leftoverLen, heightWaste];
      if (!best || lessThan(score, best.score))
        best = { sheet, strip, orient, oversized: strip.oversized, score };
    }
    // New strip: needs remaining sheet width. A trimmable piece opens an
    // oversized strip. A strip taller than the cross-cut capacity needs a
    // non-standard cut to separate anything from it, unless its single panel
    // spans the full sheet length (no cuts after the rips).
    const canOs = oversizable(orient, os, cap);
    const yStart = sheet.usedWidth === 0 ? 0 : sheet.usedWidth + kerf;
    if (orient.w <= sheetL && yStart + orient.h + (canOs ? os : 0) <= sheetW) {
      const nonstd = isNonStandard(orient.h, cap) && orient.w < sheetL ? 1 : 0;
      const heightKey = strategy.newStripPref === 'short' ? orient.h : -orient.h;
      const score: Score = [nonstd, catNew, heightKey, sheetL - orient.w];
      if (!best || lessThan(score, best.score))
        best = { sheet, strip: null, orient, oversized: canOs, score };
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

/*
 * Strips and sheets are immutable once they enter a layout: every move
 * builds fresh arrays for the strips it changes and fresh objects for the
 * sheets holding them, sharing everything else. Their identities are
 * therefore sound cache keys for anything derived from them alone. The
 * caches are module-wide because optimize() never reuses an object across
 * calls, so entries from one run can never be seen by another.
 */

/** Everything a strip contributes to feasibility and the objective on its own. */
interface StripInfo {
  physH: number;
  len: number;
  /** Trim rule and rotation lock hold (the sheet still checks the length). */
  valid: boolean;
  /** Separating cuts between pieces; the sheet adds one more for an offcut. */
  separating: number;
  /** Whether separating cuts run longer than the cross-cut capacity. */
  tallCut: boolean;
  trimsStd: number;
  trimsNonstd: number;
  mix: number;
}

const stripInfos = new WeakMap<Item[], StripInfo>();

function stripInfo(st: Item[], kerf: number, cap: number, os: number): StripInfo {
  const cached = stripInfos.get(st);
  if (cached) return cached;
  const physH = stripPhysH(st, os, cap);
  let valid = true;
  let trimsStd = 0;
  let trimsNonstd = 0;
  const rot = new Map<string, boolean>();
  for (const it of st) {
    // Cuts longer than the capacity are legal (non-standard, scored heavily
    // by improveObjective), so height and width impose no limit here — but
    // trimmable pieces must actually be trimmed (see bestFitInSheet)...
    if (it.h >= physH && os > 0 && it.w <= cap && it.h + os <= cap) valid = false;
    // ...and a panel keeps one orientation within a strip.
    const r = rot.get(it.panelId);
    if (r !== undefined && r !== it.rotated) valid = false;
    rot.set(it.panelId, it.rotated);
    if (it.h < physH) {
      if (isNonStandard(it.w, cap)) trimsNonstd++;
      else trimsStd++;
    }
  }
  const info: StripInfo = {
    physH,
    len: stripLen(st, kerf),
    valid,
    separating: st.length - 1,
    tallCut: isNonStandard(physH, cap),
    trimsStd,
    trimsNonstd,
    mix: Math.max(0, rot.size - 1),
  };
  stripInfos.set(st, info);
  return info;
}

function sheetFeasible(sh: ISheet, kerf: number, cap: number, os: number): boolean {
  let used = kerf * (sh.strips.length - 1);
  for (const st of sh.strips) {
    if (st.length === 0) return false;
    const info = stripInfo(st, kerf, cap, os);
    if (!info.valid || info.len > sh.spec.length) return false;
    used += info.physH;
  }
  return used <= sh.spec.width;
}

const sheetObjectives = new WeakMap<ISheet, number[]>();
const sheetIds = new WeakMap<ISheet, number>();
let nextSheetId = 1;

function sheetId(sh: ISheet): number {
  let id = sheetIds.get(sh);
  if (id === undefined) {
    id = nextSheetId++;
    sheetIds.set(sh, id);
  }
  return id;
}

/** One sheet's additive share of the objective: [area, weighted cuts, mix, strip area]. */
function sheetObjective(sh: ISheet, kerf: number, cap: number, os: number): number[] {
  const cached = sheetObjectives.get(sh);
  if (cached) return cached;
  let rips = 0;
  let crosses = 0;
  let nonstd = 0;
  let mix = 0;
  let stripArea = 0;
  let y = 0;
  for (const st of sh.strips) {
    const info = stripInfo(st, kerf, cap, os);
    stripArea += info.physH * sh.spec.length;
    y += info.physH;
    if (y < sh.spec.width) rips++;
    y += kerf;
    const separating = info.separating + (info.len < sh.spec.length ? 1 : 0);
    if (info.tallCut) nonstd += separating;
    else crosses += separating;
    crosses += info.trimsStd;
    nonstd += info.trimsNonstd;
    mix += info.mix;
  }
  const obj = [
    sh.spec.length * sh.spec.width,
    RIP_WEIGHT * rips + crosses + NONSTD_WEIGHT * nonstd,
    mix,
    stripArea,
  ];
  sheetObjectives.set(sh, obj);
  return obj;
}

/** Same ordering as scoreResult, minus the components moves cannot change. */
function improveObjective(layout: ISheet[], kerf: number, cap: number, os: number): number[] {
  let totalArea = 0;
  let cuts = 0;
  let mix = 0;
  let sumSq = 0;
  let stripArea = 0;
  for (const sh of layout) {
    const [area, c, m, s] = sheetObjective(sh, kerf, cap, os);
    totalArea += area;
    sumSq += area * area;
    cuts += c;
    mix += m;
    stripArea += s;
  }
  return [totalArea, cuts, mix, sumSq, stripArea];
}

/** Group same-panel items adjacent, ordered by first appearance. */
function groupItems(items: Item[]): Item[] {
  const order = new Map<string, number>();
  for (const it of items) if (!order.has(it.panelId)) order.set(it.panelId, order.size);
  return [...items].sort((a, b) => order.get(a.panelId)! - order.get(b.panelId)!);
}

/** A copy of the strip with the item added next to its own kind (or at the end). */
function withGrouped(st: Item[], item: Item): Item[] {
  for (let i = st.length - 1; i >= 0; i--) {
    if (st[i].panelId === item.panelId) {
      return [...st.slice(0, i + 1), item, ...st.slice(i + 1)];
    }
  }
  return [...st, item];
}

/** A copy of the strip without the item at k. */
function without(st: Item[], k: number): Item[] {
  return st.filter((_, idx) => idx !== k);
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

/**
 * Copy the sheets about to be modified; every other sheet is shared, and so
 * are the strips of the copied sheets — callers replace the strips they
 * change rather than editing them in place.
 */
function cloneFor(layout: ISheet[], touched: Iterable<number>): ISheet[] {
  const set = new Set(touched);
  return layout.map((sh, idx) => (set.has(idx) ? { spec: sh.spec, strips: sh.strips.slice() } : sh));
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
  const clone = cloneFor(layout, [a, b]);
  clone[a].strips[i] = without(clone[a].strips[i], k);
  if (j >= clone[b].strips.length) clone[b].strips.push([item]);
  else clone[b].strips[j] = withGrouped(clone[b].strips[j], item);
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
      const clone = cloneFor(layout, [a, b]);
      clone[a].strips[i] = without(clone[a].strips[i], k);
      clone[b].strips[j] = without(clone[b].strips[j], l);
      clone[b].strips[j] = withGrouped(clone[b].strips[j], po);
      clone[a].strips[i] = withGrouped(clone[a].strips[i], qo);
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
const PACK_CACHE_LIMIT = 4000;

/**
 * packClass is a pure function of its arguments, and the same class of
 * pieces is re-solved over and over: after every move that touches one of
 * its sheets, and again by every strategy that lays the pieces out the same
 * way. Keyed on the full argument list, so a hit is exact.
 */
const packCache = new Map<string, number[][] | null>();

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

function tryRepackClass(
  layout: ISheet[],
  v: number,
  includeStrays: boolean,
  tried: Set<string>,
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

  // The outcome depends only on the sheets holding this class, so with those
  // unchanged since the last attempt the answer is already known.
  const touched = new Set<number>(slots.map((s) => s.sheet));
  for (const s of strays) touched.add(s.sheet);
  const key = `${v}|${includeStrays ? 1 : 0}|${[...touched].map((a) => sheetId(layout[a])).join(',')}`;
  if (tried.has(key)) return null;
  tried.add(key);

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
  // Canonical group order (widest first) so equal classes share cache hits.
  const members = [...groups.values()].sort(
    (a, b) => b[0].w - a[0].w || a[0].panelId.localeCompare(b[0].panelId) || +a[0].rotated - +b[0].rotated
  );
  const widths = members.map((g) => g[0].w);
  const panels = members.map((g) => g[0].panelId);
  const counts = members.map((g) => g.length);

  const slotLens = slots
    .map((s) => layout[s.sheet].spec.length)
    .sort((a, b) => b - a);
  const packKey = JSON.stringify([widths, panels, counts, slotLens[0], kerf]);
  let bins = packCache.get(packKey);
  if (bins === undefined) {
    bins = packClass(widths, panels, counts, slotLens[0], kerf);
    if (packCache.size >= PACK_CACHE_LIMIT) packCache.clear();
    packCache.set(packKey, bins);
  }
  if (!bins || bins.length > slots.length) return null;

  // Longest bins claim the longest-sheet slots; the rest of the slots close.
  const binLen = (b: number[]) =>
    b.reduce((s, c, i) => s + c * widths[i], 0) + kerf * (b.reduce((s, c) => s + c, 0) - 1);
  bins = [...bins].sort((a, b) => binLen(b) - binLen(a)); // the cached array stays untouched
  const orderedSlots = [...slots].sort(
    (a, b) => layout[b.sheet].spec.length - layout[a.sheet].spec.length
  );
  for (let i = 0; i < bins.length; i++) {
    if (binLen(bins[i]) > layout[orderedSlots[i].sheet].spec.length) return null;
  }

  const clone = cloneFor(layout, touched);
  const byStrip = new Map<string, number[]>();
  for (const s of strays) {
    const key = `${s.sheet}:${s.strip}`;
    const arr = byStrip.get(key);
    if (arr) arr.push(s.item);
    else byStrip.set(key, [s.item]);
  }
  for (const [key, items] of byStrip) {
    const [a, i] = key.split(':').map(Number);
    const gone = new Set(items);
    clone[a].strips[i] = clone[a].strips[i].filter((_, k) => !gone.has(k));
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
  return pruneAndCheck(clone, [...touched], kerf, cap, os);
}

function findClassRepack(
  layout: ISheet[],
  obj: number[],
  tried: Set<string>,
  kerf: number,
  cap: number,
  os: number
): { layout: ISheet[]; obj: number[] } | null {
  const heights = new Set<number>();
  for (const sh of layout) for (const st of sh.strips) heights.add(stripH(st));
  for (const v of [...heights].sort((a, b) => b - a)) {
    for (const includeStrays of [true, false]) {
      const cand = tryRepackClass(layout, v, includeStrays, tried, kerf, cap, os);
      if (!cand) continue;
      const candObj = improveObjective(cand, kerf, cap, os);
      if (compareScores(candObj, obj) < 0) return { layout: cand, obj: candObj };
    }
  }
  return null;
}

/**
 * Every move touches at most two sheets, and whether it improves the layout
 * depends on those two alone. A pass over sheet a that finds nothing has
 * exhausted every (a, b) pair; later rounds skip pairs whose sheets both
 * survived untouched, so each round costs O(changed sheets), not O(sheets²).
 */
function pairKey(a: ISheet, b: ISheet): string {
  return `${sheetId(a)}:${sheetId(b)}`;
}

function findImprovingMove(
  layout: ISheet[],
  obj: number[],
  byId: Map<string, PanelSpec>,
  exhausted: Set<string>,
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
          if (exhausted.has(pairKey(layout[a], layout[b]))) continue;
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
          if (exhausted.has(pairKey(layout[a], layout[b]))) continue;
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
    // Nothing moved out of sheet a (or swapped with it): every pair is spent.
    for (let b = 0; b < layout.length; b++) exhausted.add(pairKey(layout[a], layout[b]));
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
  const repacksTried = new Set<string>();
  const pairsExhausted = new Set<string>();
  for (let round = 0; round < MAX_IMPROVE_ROUNDS; round++) {
    const next =
      findClassRepack(current, obj, repacksTried, kerf, cap, os) ??
      findImprovingMove(current, obj, byId, pairsExhausted, kerf, cap, os, allowSwaps);
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
  const cap = crossCap(options);
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

    // Smallest unopened stock sheet the panel fits on (any cut the panel
    // then needs is at worst non-standard, never impossible).
    let chosenStock: { spec: StockSpec; remaining: number } | null = null;
    for (const s of stockPool) {
      if (s.remaining <= 0) continue;
      const fits = orients.some((o) => {
        const canOs = oversizable(o, os, cap);
        return o.w <= s.spec.length && o.h + (canOs ? os : 0) <= s.spec.width;
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

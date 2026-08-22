/**
 * How a panel may be oriented relative to the sheet: its length parallel to
 * the sheet length, perpendicular to it, or either ('any', the default).
 */
export type Alignment = 'any' | 'parallel' | 'perpendicular';

export interface PanelSpec {
  id: string;
  name: string;
  length: number;
  width: number;
  qty: number;
  alignment: Alignment;
  enabled: boolean;
}

export interface StockSpec {
  id: string;
  length: number;
  width: number;
  qty: number;
  enabled: boolean;
}

export interface Options {
  kerf: number;
  /**
   * Longest cut the cross-cut station can make (mm) — the hinged-rail
   * equivalent of "how deep a piece can be cut across". Strips that need
   * cross cuts must not be taller than this, and a piece can only be trimmed
   * (a cross cut along its long axis after rotating it) if its width fits.
   */
  crossCutCap: number;
  /**
   * Rip strips RIP_OVERSIZE mm taller than needed, then trim every piece back
   * to final size at the cross-cut station — extra cross cuts in exchange for
   * not having to place the long, unwieldy rips dead-on. Strips whose pieces
   * cannot be trimmed (piece longer than the cross-cut capacity) are still
   * ripped at exact size.
   */
  ripOversized: boolean;
}

/** Allowance added to rips when Options.ripOversized is on (mm). */
export const RIP_OVERSIZE = 5;

export interface Project {
  name: string;
  panels: PanelSpec[];
  stock: StockSpec[];
  options: Options;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defaultProject(name: string): Project {
  return {
    name,
    panels: [],
    stock: [{ id: newId(), length: 2440, width: 1220, qty: 10, enabled: true }],
    options: { kerf: 3, crossCutCap: 700, ripOversized: false },
  };
}

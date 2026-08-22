import type { PanelSpec, Project } from './types';

const CURRENT_KEY = 'cut.currentProject';
// Keys from the old multi-project scheme, read once for migration.
const LEGACY_PROJECTS = 'cutlist.projects';
const LEGACY_LAST = 'cutlist.lastProject';

/**
 * Bring a project (from storage or a loaded file) up to the current schema:
 * per-panel alignment/name, no grain/labels options, option defaults.
 */
export function normalizeProject(raw: Project): Project {
  const p = raw as Project & { options: { considerGrain?: boolean; labels?: boolean } };
  const considerGrain = p.options.considerGrain;
  for (const panel of p.panels as (PanelSpec & { grain?: string })[]) {
    if (panel.alignment === undefined) {
      panel.alignment =
        considerGrain && panel.grain
          ? panel.grain === 'length'
            ? 'parallel'
            : 'perpendicular'
          : 'any';
    }
    delete panel.grain;
    if (panel.name === undefined) panel.name = '';
  }
  delete p.options.considerGrain;
  delete p.options.labels;
  if (typeof p.options.kerf !== 'number') p.options.kerf = 3;
  if (p.options.crossCutCap === undefined) p.options.crossCutCap = 700;
  if (typeof p.options.ripOversized !== 'boolean') p.options.ripOversized = false;
  return p;
}

/** The single stored project: the one last worked on. */
export function loadCurrent(): Project | null {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    if (raw) return normalizeProject(JSON.parse(raw) as Project);
    // One-time migration from the old multi-project storage.
    const mapRaw = localStorage.getItem(LEGACY_PROJECTS);
    if (mapRaw) {
      const map = JSON.parse(mapRaw) as Record<string, Project>;
      const last = localStorage.getItem(LEGACY_LAST);
      const p = (last && map[last]) || Object.values(map)[0];
      if (p) return normalizeProject(p);
    }
  } catch {
    // corrupted storage: start fresh
  }
  return null;
}

export function saveCurrent(project: Project): void {
  localStorage.setItem(CURRENT_KEY, JSON.stringify(project));
}

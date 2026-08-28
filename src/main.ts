import './style.css';
import type { Alignment, Project } from './types';
import { defaultProject, newId } from './types';
import * as storage from './storage';
import { normalizeProject } from './storage';
import type { OptimizeResult } from './optimizer';
import type { CalcRequest, CalcResponse } from './messages';
import { renderResults } from './render';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const panelsTbody = el<HTMLTableSectionElement>('panels-tbody');
const stockTbody = el<HTMLTableSectionElement>('stock-tbody');
const resultsEl = el<HTMLElement>('results');
const nameInput = el<HTMLInputElement>('project-name');
const kerfInput = el<HTMLInputElement>('opt-kerf');
const crossCapInput = el<HTMLInputElement>('opt-crosscap');
const ripOversizedInput = el<HTMLInputElement>('opt-ripoversized');
const saveIndicator = el<HTMLSpanElement>('save-indicator');

let project: Project = storage.loadCurrent() ?? defaultProject('untitled project');

// ---------------------------------------------------------------------------
// Persistence (local storage holds only the current project)

let saveTimer: number | undefined;
function scheduleSave(): void {
  saveIndicator.textContent = '';
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    storage.saveCurrent(project);
    saveIndicator.textContent = 'saved';
  }, 400);
}

function changed(recalc = true): void {
  scheduleSave();
  if (recalc) calculate();
}

// ---------------------------------------------------------------------------
// Sidebar tables

function alignIcon(inner: string): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const ALIGN_ICONS: Record<Alignment, string> = {
  any: alignIcon('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  parallel: alignIcon('<polyline points="18 8 22 12 18 16"/><polyline points="6 8 2 12 6 16"/><line x1="2" x2="22" y1="12" y2="12"/>'),
  perpendicular: alignIcon('<polyline points="8 18 12 22 16 18"/><polyline points="8 6 12 2 16 6"/><line x1="12" x2="12" y1="2" y2="22"/>'),
};
const ALIGN_TITLES: Record<Alignment, string> = {
  any: 'Panel alignment: any (may rotate)',
  parallel: 'Panel alignment: length parallel to sheet length',
  perpendicular: 'Panel alignment: length perpendicular to sheet length',
};
const ALIGN_CYCLE: Record<Alignment, Alignment> = {
  any: 'parallel',
  parallel: 'perpendicular',
  perpendicular: 'any',
};

const SWAP_ICON = alignIcon(
  '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>'
);

const CHECK_ICON = alignIcon('<polyline points="20 6 9 17 4 12"/>');
const X_ICON = alignIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

const GRIP_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">' +
  '<circle cx="9" cy="5" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="9" cy="19" r="1.8"/>' +
  '<circle cx="15" cy="5" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="15" cy="19" r="1.8"/></svg>';

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function rowHtml(
  kind: 'panel' | 'stock',
  item: { id: string; name?: string; length: number; width: number; qty: number; enabled: boolean; alignment?: Alignment },
  index = 0
): string {
  const align = item.alignment ?? 'any';
  const nameCell =
    kind === 'panel'
      ? `<td class="name-col"><input type="text" data-field="name" value="${escAttr(item.name ?? '')}" placeholder="${index + 1}" spellcheck="false"></td>`
      : '';
  const alignBtn =
    kind === 'panel'
      ? `<button class="icon-btn align" data-action="align" title="${ALIGN_TITLES[align]}">${ALIGN_ICONS[align]}</button>`
      : '';
  const swapBtn = `<button class="icon-btn swap" data-action="swap" title="Swap length and width">${SWAP_ICON}</button>`;
  return `
    <tr data-id="${item.id}" data-kind="${kind}" class="${item.enabled ? '' : 'row-disabled'}">
      <td class="drag-col"><span class="drag-handle" draggable="true" title="Drag to reorder">${GRIP_ICON}</span></td>
      ${nameCell}
      <td><input type="number" min="0" step="any" data-field="length" value="${item.length || ''}"></td>
      <td><input type="number" min="0" step="any" data-field="width" value="${item.width || ''}"></td>
      <td class="qty-col"><input type="number" min="0" step="1" data-field="qty" value="${item.qty || ''}"></td>
      <td class="actions-col">
        ${swapBtn}
        ${alignBtn}
        <button class="icon-btn enable ${item.enabled ? 'on' : ''}" data-action="enable" title="${item.enabled ? 'Exclude from calculation' : 'Include in calculation'}">${CHECK_ICON}</button>
        <button class="icon-btn delete" data-action="delete" title="Remove row">${X_ICON}</button>
      </td>
    </tr>`;
}

function renderTables(): void {
  panelsTbody.innerHTML = project.panels.map((p, i) => rowHtml('panel', p, i)).join('');
  stockTbody.innerHTML = project.stock.map((s) => rowHtml('stock', s)).join('');
}

function findItem(kind: string, id: string) {
  const list = kind === 'panel' ? project.panels : project.stock;
  return list.find((x) => x.id === id);
}

function handleTableInput(e: Event): void {
  const input = e.target as HTMLInputElement;
  const field = input.dataset.field;
  if (!field) return;
  const row = input.closest('tr');
  if (!row) return;
  const item = findItem(row.dataset.kind!, row.dataset.id!);
  if (!item) return;
  if (field === 'name') {
    if ('name' in item) item.name = input.value;
    changed();
    return;
  }
  const value = parseFloat(input.value);
  if (field === 'length') item.length = value > 0 ? value : 0;
  else if (field === 'width') item.width = value > 0 ? value : 0;
  else if (field === 'qty') item.qty = value > 0 ? Math.floor(value) : 0;
  changed();
}

function handleTableClick(e: Event): void {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!btn) return;
  const row = btn.closest('tr');
  if (!row) return;
  const kind = row.dataset.kind!;
  const id = row.dataset.id!;
  const action = btn.dataset.action;

  if (action === 'delete') {
    if (kind === 'panel') project.panels = project.panels.filter((p) => p.id !== id);
    else project.stock = project.stock.filter((s) => s.id !== id);
    renderTables();
    changed();
    return;
  }

  const item = findItem(kind, id);
  if (!item) return;

  if (action === 'swap') {
    [item.length, item.width] = [item.width, item.length];
    const lengthInput = row.querySelector<HTMLInputElement>('input[data-field="length"]');
    const widthInput = row.querySelector<HTMLInputElement>('input[data-field="width"]');
    if (lengthInput) lengthInput.value = item.length ? String(item.length) : '';
    if (widthInput) widthInput.value = item.width ? String(item.width) : '';
    changed();
  } else if (action === 'enable') {
    item.enabled = !item.enabled;
    btn.classList.toggle('on', item.enabled);
    row.classList.toggle('row-disabled', !item.enabled);
    changed();
  } else if (action === 'align') {
    const panel = project.panels.find((p) => p.id === id);
    if (!panel) return;
    panel.alignment = ALIGN_CYCLE[panel.alignment];
    btn.innerHTML = ALIGN_ICONS[panel.alignment];
    btn.title = ALIGN_TITLES[panel.alignment];
    changed();
  }
}

// --- drag to reorder rows ---

let dragging: { kind: string; id: string } | null = null;

function clearDropMarkers(): void {
  document
    .querySelectorAll('tr.drop-before, tr.drop-after, tr.dragging')
    .forEach((r) => r.classList.remove('drop-before', 'drop-after', 'dragging'));
}

function handleDragStart(e: DragEvent): void {
  const handle = (e.target as HTMLElement).closest('.drag-handle');
  if (!handle) return;
  const row = handle.closest('tr');
  if (!row) return;
  dragging = { kind: row.dataset.kind!, id: row.dataset.id! };
  row.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.id!);
    e.dataTransfer.setDragImage(row, 16, row.clientHeight / 2);
  }
}

function dropTarget(e: DragEvent): { row: HTMLTableRowElement; before: boolean } | null {
  if (!dragging) return null;
  const row = (e.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-id]');
  if (!row || row.dataset.kind !== dragging.kind) return null;
  const rect = row.getBoundingClientRect();
  return { row, before: e.clientY < rect.top + rect.height / 2 };
}

function handleDragOver(e: DragEvent): void {
  const target = dropTarget(e);
  if (!target) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  document
    .querySelectorAll('tr.drop-before, tr.drop-after')
    .forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  target.row.classList.add(target.before ? 'drop-before' : 'drop-after');
}

function handleDrop(e: DragEvent): void {
  const target = dropTarget(e);
  if (!target || !dragging) return;
  e.preventDefault();
  const list: { id: string }[] = dragging.kind === 'panel' ? project.panels : project.stock;
  const from = list.findIndex((x) => x.id === dragging!.id);
  let to = list.findIndex((x) => x.id === target.row.dataset.id);
  if (from >= 0 && to >= 0) {
    if (!target.before) to++;
    if (from < to) to--;
    if (to !== from) {
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      renderTables();
      changed();
    }
  }
  dragging = null;
  clearDropMarkers();
}

function handleDragEnd(): void {
  dragging = null;
  clearDropMarkers();
}

for (const tbody of [panelsTbody, stockTbody]) {
  tbody.addEventListener('input', handleTableInput);
  tbody.addEventListener('click', handleTableClick);
  tbody.addEventListener('dragstart', handleDragStart);
  tbody.addEventListener('dragover', handleDragOver);
  tbody.addEventListener('drop', handleDrop);
  tbody.addEventListener('dragend', handleDragEnd);
}

el<HTMLButtonElement>('add-panel').addEventListener('click', () => {
  project.panels.push({ id: newId(), name: '', length: 0, width: 0, qty: 1, alignment: 'any', enabled: true });
  renderTables();
  panelsTbody.querySelector<HTMLInputElement>('tr:last-child input')?.focus();
  changed(false);
});

el<HTMLButtonElement>('add-stock').addEventListener('click', () => {
  project.stock.push({ id: newId(), length: 2440, width: 1220, qty: 1, enabled: true });
  renderTables();
  stockTbody.querySelector<HTMLInputElement>('tr:last-child input')?.focus();
  changed(false);
});

// ---------------------------------------------------------------------------
// Options

kerfInput.addEventListener('input', () => {
  const v = parseFloat(kerfInput.value);
  project.options.kerf = v >= 0 ? v : 0;
  changed();
});
crossCapInput.addEventListener('input', () => {
  const v = parseFloat(crossCapInput.value);
  project.options.crossCutCap = v > 0 ? v : 0;
  changed();
});
ripOversizedInput.addEventListener('change', () => {
  project.options.ripOversized = ripOversizedInput.checked;
  changed();
});

// ---------------------------------------------------------------------------
// Project management: name + save/load as JSON

function loadIntoUi(): void {
  document.title = `${project.name} — cutlist`;
  nameInput.value = project.name;
  kerfInput.value = String(project.options.kerf);
  crossCapInput.value = String(project.options.crossCutCap);
  ripOversizedInput.checked = project.options.ripOversized;
  renderTables();
}

nameInput.addEventListener('change', () => {
  const next = nameInput.value.trim() || 'untitled project';
  nameInput.value = next;
  project.name = next;
  document.title = `${next} — cutlist`;
  storage.saveCurrent(project);
  saveIndicator.textContent = 'saved';
});

el<HTMLButtonElement>('project-save').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.trim().replace(/[^\w.-]+/g, '-') || 'project'}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

const fileInput = el<HTMLInputElement>('project-file');
el<HTMLButtonElement>('project-load').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()) as Project;
    if (!parsed || !Array.isArray(parsed.panels) || !Array.isArray(parsed.stock) || typeof parsed.options !== 'object') {
      throw new Error('not a project');
    }
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
      parsed.name = file.name.replace(/\.json$/i, '');
    }
    window.clearTimeout(saveTimer);
    project = normalizeProject(parsed);
    storage.saveCurrent(project);
    loadIntoUi();
    calculate();
  } catch {
    alert(`Could not load "${file.name}" — not a valid project file.`);
  }
});

// ---------------------------------------------------------------------------
// Calculate

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const calcBtn = el<HTMLButtonElement>('calculate');
const calcBtnHtml = calcBtn.innerHTML;
let runSeq = 0;
let slowTimer: number | undefined;

function calculate(): void {
  const runId = ++runSeq;
  const msg: CalcRequest = {
    runId,
    panels: project.panels,
    stock: project.stock,
    options: project.options,
  };
  // Only dim the results if the run is actually slow, to avoid flicker.
  window.clearTimeout(slowTimer);
  slowTimer = window.setTimeout(() => {
    calcBtn.classList.add('busy');
    resultsEl.classList.add('calculating');
  }, 200);
  worker.postMessage(msg);
}

function finishRun(): void {
  window.clearTimeout(slowTimer);
  calcBtn.innerHTML = calcBtnHtml;
  calcBtn.classList.remove('busy');
  resultsEl.classList.remove('calculating');
}

worker.onmessage = (e: MessageEvent<CalcResponse>) => {
  const msg = e.data;
  if (msg.runId !== runSeq) return; // stale run superseded by newer input
  if (msg.type === 'progress') {
    calcBtn.classList.add('busy');
    calcBtn.textContent = `Calculating… ${Math.round((100 * msg.done) / msg.total)}%`;
    return;
  }
  // Interim results render right away; the button stays busy until the
  // time-budgeted search delivers its final answer.
  window.clearTimeout(slowTimer);
  resultsEl.classList.remove('calculating');
  if (msg.final) {
    calcBtn.innerHTML = calcBtnHtml;
    calcBtn.classList.remove('busy');
  }
  const result: OptimizeResult = { ...msg.result, unplaced: new Map(msg.result.unplaced) };
  renderResults(
    resultsEl,
    result,
    project.panels,
    project.options.kerf,
    project.options.ripOversized,
    msg.tried
  );
};

worker.onerror = (e) => {
  finishRun();
  resultsEl.innerHTML = `<div class="warning-bar">&#9888; Calculation failed: ${e.message ?? 'unknown error'}</div>`;
};

calcBtn.addEventListener('click', calculate);

// ---------------------------------------------------------------------------
// Hover linking between cut-list entries and cut lines in the diagram.

let hotCut: string | null = null;
function setHotCut(key: string | null): void {
  if (key === hotCut) return;
  hotCut = key;
  resultsEl.querySelectorAll('.cut-hot').forEach((n) => n.classList.remove('cut-hot'));
  if (key) {
    resultsEl.querySelectorAll(`[data-cut="${key}"]`).forEach((n) => n.classList.add('cut-hot'));
  }
  resultsEl.querySelectorAll('.sheet-svg').forEach((svg) => {
    svg.classList.toggle('dimmed', !!key && svg.querySelector(`[data-cut="${key}"]`) !== null);
  });
}

resultsEl.addEventListener('mouseover', (e) => {
  const hit = (e.target as Element).closest?.('[data-cut]');
  setHotCut(hit?.getAttribute('data-cut') || null);
});
resultsEl.addEventListener('mouseleave', () => setHotCut(null));

// ---------------------------------------------------------------------------
// Init

if (project.panels.length === 0) {
  project.panels.push({ id: newId(), name: '', length: 0, width: 0, qty: 1, alignment: 'any', enabled: true });
}
loadIntoUi();
storage.saveCurrent(project);
calculate();

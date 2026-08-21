import type { OptimizeResult } from './optimizer';
import type { PanelSpec } from './types';

const PALETTE = [
  '#8ecae6', '#ffb703', '#a7c957', '#e5989b', '#bde0fe',
  '#f4a261', '#cdb4db', '#90be6d', '#f9c74f', '#adb5bd',
];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function renderResults(
  container: HTMLElement,
  result: OptimizeResult,
  panels: PanelSpec[],
  kerf: number,
  layoutsTried?: number
): void {
  const { sheets, unplaced, placedCount, totalPanelArea, totalSheetArea } = result;

  if (sheets.length === 0 && unplaced.size === 0) {
    container.innerHTML = '<div class="results-empty">Nothing to place — add some panels and stock sheets.</div>';
    return;
  }

  const colorOf = new Map<string, string>();
  panels.forEach((p, i) => colorOf.set(p.id, PALETTE[i % PALETTE.length]));
  const labelOf = new Map<string, string>();
  panels.forEach((p, i) => labelOf.set(p.id, p.name.trim() || String(i + 1)));

  const efficiency = totalSheetArea > 0 ? (totalPanelArea / totalSheetArea) * 100 : 0;

  let html = `
    <div class="stats-bar">
      <div class="stat"><span class="stat-value">${sheets.length}</span><span class="stat-label">sheets used</span></div>
      <div class="stat"><span class="stat-value">${placedCount}</span><span class="stat-label">panels placed</span></div>
      <div class="stat"><span class="stat-value">${efficiency.toFixed(1)}%</span><span class="stat-label">material used</span></div>
      <div class="stat"><span class="stat-value">${((totalSheetArea - totalPanelArea) / 1e6).toFixed(2)} m²</span><span class="stat-label">waste</span></div>
      ${layoutsTried ? `<div class="stat"><span class="stat-value">${layoutsTried}</span><span class="stat-label">layouts tried</span></div>` : ''}
    </div>`;

  if (unplaced.size > 0) {
    const items = [...unplaced.entries()]
      .map(([panelId, count]) => `${count} × ${labelOf.get(panelId) ?? 'panel'}`)
      .join(', ');
    html += `<div class="warning-bar">&#9888; Could not place: ${esc(items)} — add more stock or check sizes.</div>`;
  }

  const maxLen = sheets.reduce((m, s) => Math.max(m, s.length), 0);

  sheets.forEach((sheet, i) => {
    const used = sheet.placements.reduce((sum, p) => sum + p.w * p.h, 0);
    const pct = ((used / (sheet.length * sheet.width)) * 100).toFixed(1);
    // All sheets render at the same pixel width, so on-screen scale is set by
    // sheet LENGTH — base the type size on that, not the (possibly narrow)
    // width, then clamp per panel.
    const baseFont = maxLen / 42;

    // Shared mm→px scale across all sheets: a sheet shorter than the longest
    // one renders proportionally narrower instead of stretching to full width.
    const widthPct = ((sheet.length / maxLen) * 100).toFixed(2);
    let svg = `<svg viewBox="-1 -1 ${sheet.length + 2} ${sheet.width + 2}" class="sheet-svg" style="width:${widthPct}%" preserveAspectRatio="xMinYMin meet">`;
    svg += `<rect x="0" y="0" width="${sheet.length}" height="${sheet.width}" class="sheet-bg"/>`;

    // Per-strip items and runs (consecutive same panels), shared between the
    // cut lines, the cut list, and the hover linking between the two.
    interface Run { label: string; w: number; h: number; count: number }
    const stripData = sheet.strips.map((strip, si) => {
      const items = sheet.placements
        .filter((p) => p.y === strip.y)
        .sort((a, b) => a.x - b.x);
      const runs: Run[] = [];
      const runIdxOf: number[] = [];
      for (const p of items) {
        const label = labelOf.get(p.panelId) ?? '?';
        const prev = runs[runs.length - 1];
        if (prev && prev.label === label && prev.w === p.w && prev.h === p.h) prev.count++;
        else runs.push({ label, w: p.w, h: p.h, count: 1 });
        runIdxOf.push(runs.length - 1);
      }
      return { strip, si, items, runs, runIdxOf };
    });

    // Each visible cut line gets a twin transparent fat line as hover target.
    const cutLine = (x1: number, y1: number, x2: number, y2: number, cls: string, key: string) =>
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}" data-cut="${key}"/>` +
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="hit-line" data-cut="${key}"/>`;

    for (const pl of sheet.placements) {
      const color = colorOf.get(pl.panelId) ?? '#ccc';
      svg += `<rect x="${pl.x}" y="${pl.y}" width="${pl.w}" height="${pl.h}" fill="${color}" class="placed"/>`;
      const dims = `${fmt(pl.w)} × ${fmt(pl.h)}`;
      const vertical = pl.h > pl.w * 1.6;
      const cx = pl.x + pl.w / 2;
      const cy = pl.y + pl.h / 2;
      // Fit the label to the panel: start from the sheet-wide base size,
      // shrink to the panel's short side and to the text's running length,
      // and drop it entirely once it would be illegibly small.
      const along = vertical ? pl.h : pl.w;
      const acrossDim = vertical ? pl.w : pl.h;
      let fs = Math.min(baseFont, acrossDim * 0.5, (along * 0.9) / (dims.length * 0.62));
      if (fs >= baseFont * 0.45) {
        const transform = vertical ? ` transform="rotate(-90 ${cx} ${cy})"` : '';
        svg += `<text x="${cx}" y="${cy}" font-size="${fs}" class="dim-label"${transform}>${dims}</text>`;
      }
      const tag = labelOf.get(pl.panelId) ?? '';
      if (tag) {
        const tagFs = Math.min(
          baseFont * 0.85,
          Math.min(pl.w, pl.h) * 0.4,
          (pl.w * 0.85) / (tag.length * 0.62)
        );
        if (tagFs >= baseFont * 0.35) {
          const pad = tagFs * 0.45;
          svg += `<text x="${pl.x + pad}" y="${pl.y + pad + tagFs * 0.9}" font-size="${tagFs}" class="tag-label">${esc(tag)}</text>`;
        }
      }
    }
    // Offcut dimensions, written into the waste space when it's big enough:
    // the tail of each strip past its last panel, and the untouched band
    // below the last strip (one kerf is consumed by the separating cut).
    const offcuts: { x: number; y: number; w: number; h: number }[] = [];
    for (const strip of sheet.strips) {
      const items = sheet.placements.filter((p) => p.y === strip.y);
      if (items.length === 0) continue;
      const lastEdge = Math.max(...items.map((p) => p.x + p.w));
      const start = lastEdge + kerf;
      if (start < sheet.length) {
        offcuts.push({ x: start, y: strip.y, w: sheet.length - start, h: strip.h });
      }
      // Slivers left when a piece is trimmed below the strip height.
      for (const p of items) {
        const slack = strip.h - p.h - kerf;
        if (slack > 0) offcuts.push({ x: p.x, y: p.y + p.h + kerf, w: p.w, h: slack });
      }
    }
    if (sheet.strips.length > 0) {
      const lastStrip = sheet.strips[sheet.strips.length - 1];
      const bottom = lastStrip.y + lastStrip.h + kerf;
      if (bottom < sheet.width) {
        offcuts.push({ x: 0, y: bottom, w: sheet.length, h: sheet.width - bottom });
      }
    }
    for (const o of offcuts) {
      const dims = `${fmt(o.w)} × ${fmt(o.h)}`;
      const vertical = o.h > o.w * 1.6;
      const along = vertical ? o.h : o.w;
      const across = vertical ? o.w : o.h;
      const fs = Math.min(baseFont * 0.9, across * 0.5, (along * 0.9) / (dims.length * 0.62));
      if (fs >= baseFont * 0.4) {
        const cx = o.x + o.w / 2;
        const cy = o.y + o.h / 2;
        const transform = vertical ? ` transform="rotate(-90 ${cx} ${cy})"` : '';
        svg += `<text x="${cx}" y="${cy}" font-size="${fs}" class="dim-label waste-label"${transform}>${dims}</text>`;
      }
    }

    // Workpiece focus: per cut, a scrim covering everything EXCEPT the
    // workpiece (shown on hover, fading the rest of the sheet), plus an
    // outline on the workpiece itself. A rip focuses the strip it frees, a
    // cross-cut run its panels, a trim the full pre-trim piece.
    const scrim = (x: number, y: number, w: number, h: number, key: string): string => {
      const L = sheet.length;
      const W = sheet.width;
      const parts: string[] = [];
      if (y > 0) parts.push(`<rect x="0" y="0" width="${L}" height="${y}"/>`);
      if (y + h < W) parts.push(`<rect x="0" y="${y + h}" width="${L}" height="${W - y - h}"/>`);
      if (x > 0) parts.push(`<rect x="0" y="${y}" width="${x}" height="${h}"/>`);
      if (x + w < L) parts.push(`<rect x="${x + w}" y="${y}" width="${L - x - w}" height="${h}"/>`);
      return (
        `<g class="dim-scrim" data-cut="${key}">${parts.join('')}</g>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="piece-glow" data-cut="${key}"/>`
      );
    };
    for (const { strip, si, items, runs, runIdxOf } of stripData) {
      if (strip.y + strip.h < sheet.width) {
        svg += scrim(0, strip.y, sheet.length, strip.h, `r${i}-${si}`);
      }
      runs.forEach((r, ri) => {
        const runItems = items.filter((_, k) => runIdxOf[k] === ri);
        if (runItems.length === 0) return;
        const x0 = runItems[0].x;
        const x1 = runItems[runItems.length - 1].x + runItems[runItems.length - 1].w;
        svg += scrim(x0, strip.y, x1 - x0, r.h, `c${i}-${si}-${ri}`);
        if (r.h < strip.h) {
          svg += scrim(x0, strip.y, x1 - x0, strip.h, `t${i}-${si}-${ri}`);
        }
      });
    }

    // Cut lines drawn above the scrims so the hovered cut stays crisp while
    // unrelated lines are faded via the svg-level .dimmed class.
    for (const { strip, si } of stripData) {
      const cutY = strip.y + strip.h;
      if (cutY < sheet.width) {
        svg += cutLine(0, cutY, sheet.length, cutY, 'rip-line', `r${i}-${si}`);
      }
    }
    for (const { strip, si, items, runIdxOf } of stripData) {
      items.forEach((p, k) => {
        const ri = runIdxOf[k];
        const cutX = p.x + p.w;
        if (cutX < sheet.length) {
          svg += cutLine(cutX, strip.y, cutX, strip.y + strip.h, 'cross-line', `c${i}-${si}-${ri}`);
        }
        if (p.h < strip.h) {
          svg += cutLine(p.x, p.y + p.h, p.x + p.w, p.y + p.h, 'cross-line', `t${i}-${si}-${ri}`);
        }
      });
    }

    svg += `<rect x="0" y="0" width="${sheet.length}" height="${sheet.width}" class="sheet-border"/></svg>`;

    // Ordered cut list mirroring the workflow: all rips first (positions from
    // the top edge), then each strip's cross cuts left to right, then trims.
    let cutlist = '<div class="cutlist"><span class="cutlist-title">Cut list</span><ol>';
    let prevCutEdge: number | null = null;
    for (const { strip, si, items, runs } of stripData) {
      if (items.length === 0) continue;
      const lastEdge = items[items.length - 1].x + items[items.length - 1].w;
      const flush = lastEdge >= sheet.length;

      // Cross cuts on the strip this rip frees, with trims (further cross
      // cuts on the freed pieces) nested one level deeper.
      let inner = '<ol>';
      if (items.length === 1 && flush && runs[0].h === strip.h) {
        inner += `<li data-cut="">${esc(runs[0].label)} — no further cuts.</li>`;
      } else {
        runs.forEach((r, ri) => {
          let li = `Cross cut ${r.count} × ${esc(r.label)} @ <b>${fmt(r.w)}</b>.`;
          if (r.h < strip.h) {
            const trimOff = strip.h - r.h - kerf;
            const offNote =
              trimOff > 0
                ? `<li class="offcut-note" data-cut="">offcut ${r.count > 1 ? `${r.count} × ` : ''}${fmt(r.w)} × ${fmt(trimOff)}</li>`
                : '';
            li += `<ol><li data-cut="t${i}-${si}-${ri}">Cross cut ${r.count === 1 ? 'it' : 'each'} down to <b>${fmt(r.h)}</b>.</li>${offNote}</ol>`;
          }
          inner += `<li data-cut="c${i}-${si}-${ri}">${li}</li>`;
        });
        const offW = sheet.length - lastEdge - kerf;
        if (!flush && offW > 0) {
          inner += `<li class="offcut-note" data-cut="">offcut ${fmt(offW)} × ${fmt(strip.h)}</li>`;
        }
      }
      inner += '</ol>';

      const hasRip = strip.y + strip.h < sheet.width;
      if (hasRip) {
        const ripY = strip.y + strip.h;
        const offset = prevCutEdge === null ? ripY : ripY - prevCutEdge;
        const ref = prevCutEdge === null ? 'the top edge' : 'the last cut edge';
        cutlist += `<li data-cut="r${i}-${si}"><b>Rip</b> full length at <b>${fmt(offset)}</b> from ${ref}.${inner}</li>`;
        prevCutEdge = ripY + kerf;
      } else {
        cutlist += `<li data-cut="">Remaining piece (${fmt(strip.h)} tall):${inner}</li>`;
      }
    }
    cutlist += '</ol></div>';

    html += `
      <div class="sheet-card">
        <div class="sheet-title">Sheet ${i + 1} <span class="sheet-sub">${fmt(sheet.length)} × ${fmt(sheet.width)} — ${sheet.placements.length} panels, ${pct}% used</span></div>
        ${svg}
        ${cutlist}
      </div>`;
  });

  if (placedCount > 0) {
    html += '<div class="legend">';
    panels
      .filter((p) => p.enabled && p.qty > 0)
      .forEach((p) => {
        html += `<span class="legend-item"><i style="background:${colorOf.get(p.id)}"></i>${esc(labelOf.get(p.id) ?? '')}: ${fmt(p.length)} × ${fmt(p.width)}</span>`;
      });
    html += '</div>';
  }

  container.innerHTML = html;
}

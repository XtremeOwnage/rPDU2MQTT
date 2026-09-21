// Floor Plans (#470): each floor drawn with its rooms and areas (#463), the outlets, fixtures and devices placed
// on it and the circuits feeding them (#464, #465), shaded live by what each room draws (#466), with a trace
// that finds an outlet's breaker from the outlet (#468). Built for a tablet carried round the house.
import { activate, api, btn, closeSheet, el, ensure, navLink, openSheet, svgEl, toast, formatMeasure } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { sparkline } from '../charts.js';
import { analyse, type Level } from '../circuit-finder.js';
import { type Pt, planRect, planArea, planCentroid, planShapeAt, planSnap, planMove, planClamp, planRound, planScaleMax, planNearestOnSegment } from '../plan-geometry.js';

type Place = {
  id: string; name: string; kind: string; site: string; floor: string | null; value: number | null; state: string;
  nodes: { id: string; label: string }[]; missing: { id: string; label: string }[]; split: { id: string; label: string }[];
};
type PlanNode = { id: string; label: string; kind: string; value: number | null; location: string | null; placed: string | null; circuit: string | null };
type Circuit = {
  ref: string; panel: string; panelName: string; number: string; description: string; amps: number | null; state: string;
  node: string | null; channels: string[]; power: number | null; gap: string;
  devices: { node: string; label: string; value: number | null }[]; remainder: number | null; remainderState: string;
  exceeded: boolean; rooms: string[]; placements: string[];
};
type Live = {
  places: Record<string, Place>; nodes: PlanNode[]; circuits: Circuit[]; placements: Record<string, { value: number | null; circuitKnown: boolean }>;
  units: string; problems: string[]; message: string | null;
};
type Selection = { type: 'room' | 'area' | 'item'; id: string } | null;

/// What can be placed, and how each is drawn: a pictogram inside a circle.
const FP_KINDS: [string, string][] = [['outlet', 'Outlet'], ['switch', 'Switch'], ['fixture', 'Light fixture'], ['appliance', 'Appliance'], ['device', 'Device']];

/// Why a place has no total, in the words the page uses. Never a zero.
const FP_STATE_TEXT: Record<string, string> = {
  unmetered: 'Nothing metered is placed here.',
  unknown: 'A reading this total needs is missing, so it is not shown.',
};

/// A glyph for a placed item, centred on 0,0 at radius r.
function fpGlyph(kind: string, r: number): any {
  const g = svgEl('g', { class: 'fp-glyph' });
  const line = (x1: number, y1: number, x2: number, y2: number) => g.appendChild(svgEl('line', { x1, y1, x2, y2 }));
  const k = r * 0.45;
  if (kind === 'outlet') { line(-k * 0.5, -k * 0.6, -k * 0.5, k * 0.2); line(k * 0.5, -k * 0.6, k * 0.5, k * 0.2); g.appendChild(svgEl('circle', { cx: 0, cy: k * 0.75, r: k * 0.18 })); }
  else if (kind === 'switch') { g.appendChild(svgEl('rect', { x: -k * 0.45, y: -k, width: k * 0.9, height: k * 2, rx: k * 0.2 })); line(0, -k * 0.6, 0, 0); }
  else if (kind === 'fixture') { g.appendChild(svgEl('circle', { cx: 0, cy: 0, r: k * 0.45 })); [0, 45, 90, 135, 180, 225, 270, 315].forEach(a => { const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180); line(c * k * 0.7, s * k * 0.7, c * k, s * k); }); }
  else if (kind === 'appliance') { g.appendChild(svgEl('rect', { x: -k, y: -k, width: k * 2, height: k * 2, rx: k * 0.25 })); g.appendChild(svgEl('circle', { cx: 0, cy: k * 0.15, r: k * 0.5 })); }
  else { g.appendChild(svgEl('rect', { x: -k, y: -k * 0.7, width: k * 2, height: k * 1.3, rx: k * 0.2 })); line(-k * 0.4, k * 0.9, k * 0.4, k * 0.9); }
  return g;
}

export function addFloorPlanSection(nav: any, sections: any) {
  const link = navLink(nav, 'Floor Plans', '⌗');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section fp' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Floor Plans' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Each floor with its rooms and areas, and the outlets, fixtures and devices in them. View shades each room by '
    + 'what it draws — a room with nothing metered reads unmetered, never zero. Rooms draws and edits the outlines; '
    + 'Place drops items onto the plan and links each to the circuit feeding it.'));

  // --- Config access -------------------------------------------------------------------------------
  const flowIn = () => ensure(state.data, 'EnergyFlow', {});
  const sitesIn = (): any[] => ensure(flowIn(), 'Sites', []);
  const itemsIn = (): any[] => ensure(flowIn(), 'Placements', []);
  const floorsAll = () => sitesIn().flatMap((s: any) => ensure(s, 'Floors', []).map((f: any) => ({ site: s, floor: f })));
  const floorById = (id: string) => floorsAll().find(x => x.floor.Id === id) || null;
  const allIds = () => new Set<string>(sitesIn().flatMap((s: any) => [s.Id, ...ensure(s, 'Floors', []).flatMap((f: any) =>
    [f.Id, ...ensure(f, 'Rooms', []).map((r: any) => r.Id), ...ensure(f, 'Areas', []).map((a: any) => a.Id)])]));
  const freshId = (base: string) => {
    const stem = (base || 'place').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'place';
    const taken = allIds();
    let id = stem, n = 2;
    while (taken.has(id)) id = `${stem}_${n++}`;
    return id;
  };
  const freshItemId = (kind: string) => {
    const taken = new Set(itemsIn().map((p: any) => p.Id));
    let n = itemsIn().length + 1, id = `${kind}_${n}`;
    while (taken.has(id)) id = `${kind}_${++n}`;
    return id;
  };

  // --- Page state ----------------------------------------------------------------------------------
  const remembered = (key: string, fallback: string) => { try { return localStorage.getItem('rpdu-fp-' + key) || fallback; } catch { return fallback; } };
  const remember = (key: string, v: string) => { try { localStorage.setItem('rpdu-fp-' + key, v); } catch { /* this session only */ } };
  let floorId = remembered('floor', '');
  let mode: 'view' | 'rooms' | 'place' = 'view';
  let tool: 'select' | 'rect' | 'poly' = 'select';
  let drawKind: 'room' | 'area' = 'room';
  let armed: string | null = null;
  let snapOn = remembered('snap', '1') === '1';
  let period = remembered('period', 'now');
  let selection: Selection = null;
  let selectedCorner = -1;
  let draft: Pt[] = [];
  let rectStart: Pt | null = null, rectEnd: Pt | null = null;
  let live: Live | null = null;
  let imageFailed = '';
  let vb = { x: 0, y: 0, w: 1000, h: 700 };
  let viewFor = '';
  let dragging = false;

  const floorNow = () => floorById(floorId) || floorsAll()[0] || null;
  const roomsNow = (): any[] => { const f = floorNow(); return f ? ensure(f.floor, 'Rooms', []) : []; };
  const areasNow = (): any[] => { const f = floorNow(); return f ? ensure(f.floor, 'Areas', []) : []; };
  const shapeOf = (sel: Selection) => sel?.type === 'room' ? roomsNow().find(r => r.Id === sel.id)
    : sel?.type === 'area' ? areasNow().find(a => a.Id === sel.id) : null;
  const itemOf = (id: string) => itemsIn().find((p: any) => p.Id === id);
  const itemsNow = () => { const ids = new Set(roomsNow().map(r => r.Id)); return itemsIn().filter((p: any) => ids.has(p.Room)); };
  const placeOf = (id: string) => live?.places[id] || null;
  const nameOfPlace = (id: string) => {
    for (const s of sitesIn()) {
      if (s.Id === id) return s.Name || s.Id;
      for (const f of ensure(s, 'Floors', [])) {
        if (f.Id === id) return f.Name || f.Id;
        for (const r of [...ensure(f, 'Rooms', []), ...ensure(f, 'Areas', [])]) if (r.Id === id) return r.Name || r.Id;
      }
    }
    return id;
  };
  const circuitOf = (ref: string) => live?.circuits.find(c => c.ref === ref) || null;
  const circuitLabel = (c: Circuit) => `${c.panelName} · ${c.number}${c.description ? ' — ' + c.description : ''}`;
  const nodeLabel = (id: string) => live?.nodes.find(n => n.id === id)?.label || id;
  const units = () => live?.units || 'W';
  const fmt = (v: number | null | undefined) => v == null ? 'no data' : formatMeasure(Math.round(v * (units() === 'W' ? 1 : 100)) / (units() === 'W' ? 1 : 100), units());
  const changed = () => { refreshDirty(); schedule(); };

  // --- Layout --------------------------------------------------------------------------------------
  const floorSel = el('select', { class: 'fp-floor', title: 'Which floor to show.' }) as HTMLSelectElement;
  floorSel.onchange = () => { floorId = floorSel.value; remember('floor', floorId); selection = null; draft = []; viewFor = ''; render(); };
  const floorBtn = btn('Floor settings');
  const addBtn = btn('Add…');
  const toolsBtn = btn('Tools…');
  const status = el('span', { class: 'ld-count fp-status' });
  sec.appendChild(el('div', { class: 'ld-toolbar fp-bar' }, el('label', { class: 'ld-inst' }, 'Floor ', floorSel), floorBtn, addBtn, toolsBtn, status));

  const modeBar = el('div', { class: 'fp-seg', role: 'tablist' });
  const modeBtns: Record<string, any> = {};
  ([['view', 'View'], ['rooms', 'Rooms'], ['place', 'Place']] as const).forEach(([m, label]) => {
    const b = el('button', { class: 'fp-seg-btn', text: label, type: 'button' });
    b.setAttribute('role', 'tab');
    b.onclick = () => { mode = m; tool = 'select'; armed = null; draft = []; rectStart = null; selectedCorner = -1; render(); };
    modeBtns[m] = b;
    modeBar.appendChild(b);
  });
  const subBar = el('div', { class: 'fp-sub' });
  sec.appendChild(el('div', { class: 'fp-modes' }, modeBar, subBar));

  const svg = svgEl('svg', { class: 'fp-svg', role: 'img' });
  const zoomIn = el('button', { class: 'fp-zbtn', text: '+', title: 'Zoom in', type: 'button' });
  const zoomOut = el('button', { class: 'fp-zbtn', text: '−', title: 'Zoom out', type: 'button' });
  const zoomFit = el('button', { class: 'fp-zbtn', text: '⤢', title: 'Fit the floor', type: 'button' });
  const hint = el('div', { class: 'fp-hint' });
  const stage = el('div', { class: 'fp-stage' }, svg, el('div', { class: 'fp-zoom' }, zoomIn, zoomOut, zoomFit), hint);
  const side = el('aside', { class: 'fp-side' });
  const legend = el('div', { class: 'fp-legend' });
  sec.appendChild(el('div', { class: 'fp-body' }, el('div', { class: 'fp-main' }, stage, legend), side));

  // --- Coordinates ---------------------------------------------------------------------------------
  const floorSize = () => { const f = floorNow()?.floor; return { w: Number(f?.Width) || 1000, h: Number(f?.Height) || 700 }; };
  /// Plan units per screen pixel: what keeps handles and labels the same size on screen at any zoom.
  const upp = () => {
    const r = svg.getBoundingClientRect?.();
    if (!r || !r.width || !r.height) return vb.w / 1000;
    return Math.max(vb.w / r.width, vb.h / r.height);
  };
  const toPlan = (e: any): Pt => {
    const r = svg.getBoundingClientRect();
    const scale = Math.min(r.width / vb.w, r.height / vb.h) || 1;
    const ox = (r.width - vb.w * scale) / 2, oy = (r.height - vb.h * scale) / 2;
    return { X: vb.x + (e.clientX - r.left - ox) / scale, Y: vb.y + (e.clientY - r.top - oy) / scale };
  };
  const fit = () => { const { w, h } = floorSize(); const pad = Math.max(w, h) * 0.03; vb = { x: -pad, y: -pad, w: w + pad * 2, h: h + pad * 2 }; };
  const zoomAt = (p: Pt, factor: number) => {
    const { w, h } = floorSize();
    const nw = Math.max(w * 0.05, Math.min(w * 4, vb.w / factor));
    const f = vb.w / nw;
    vb = { x: p.X - (p.X - vb.x) / f, y: p.Y - (p.Y - vb.y) / f, w: nw, h: vb.h / f };
    drawPlan();
  };
  zoomIn.onclick = () => zoomAt({ X: vb.x + vb.w / 2, Y: vb.y + vb.h / 2 }, 1.4);
  zoomOut.onclick = () => zoomAt({ X: vb.x + vb.w / 2, Y: vb.y + vb.h / 2 }, 1 / 1.4);
  zoomFit.onclick = () => { fit(); drawPlan(); };

  const othersFor = (exclude: any) => [...roomsNow(), ...areasNow()].filter(s => s !== exclude && (s.Shape || []).length >= 3).map(s => s.Shape as Pt[]);
  const snapped = (p: Pt, exclude: any = null) => {
    const { w, h } = floorSize();
    if (!snapOn) return { X: planRound(p.X), Y: planRound(p.Y) };
    const s = planSnap(p, othersFor(exclude), 12 * upp(), Math.max(w, h) / 100);
    return { X: planRound(Math.max(0, Math.min(w, s.pt.X))), Y: planRound(Math.max(0, Math.min(h, s.pt.Y))) };
  };

  // --- Drawing -------------------------------------------------------------------------------------
  const shadeOf = (v: number | null, max: number) => {
    if (v == null || max <= 0) return '';
    const t = Math.max(0, Math.min(1, v / max));
    return `color-mix(in srgb, var(--accent) ${Math.round(12 + t * 68)}%, transparent)`;
  };

  const drawPlan = () => {
    svg.innerHTML = '';
    const fl = floorNow();
    const { w, h } = floorSize();
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('aria-label', fl ? `Floor plan of ${fl.floor.Name || fl.floor.Id}` : 'No floor');
    svg.classList.toggle('is-editing', mode !== 'view');
    const u = upp();

    const defs = svgEl('defs');
    const grid = Math.max(w, h) / 50;
    const gp = svgEl('pattern', { id: 'fp-grid', width: grid, height: grid, patternUnits: 'userSpaceOnUse' });
    gp.appendChild(svgEl('path', { d: `M ${grid} 0 L 0 0 0 ${grid}`, class: 'fp-gridline', 'stroke-width': u }));
    const hatch = svgEl('pattern', { id: 'fp-hatch', width: 10 * u, height: 10 * u, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.appendChild(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 10 * u, class: 'fp-hatchline', 'stroke-width': 1.5 * u }));
    defs.append(gp, hatch);
    svg.appendChild(defs);

    if (!fl) return;
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, class: 'fp-paper' }));
    const image = fl.floor.Image;
    if (image && imageFailed !== image) {
      const img = svgEl('image', { href: `/api/plans/images/${encodeURIComponent(image)}`, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'xMidYMid meet', class: 'fp-image' });
      img.addEventListener('error', () => { imageFailed = image; drawPlan(); drawSide(); });
      svg.appendChild(img);
    }
    if (!image || imageFailed === image || mode !== 'view')
      svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, fill: 'url(#fp-grid)', class: 'fp-gridrect' }));

    const max = planScaleMax(roomsNow().map(r => placeOf(r.Id)?.value));
    const font = 13 * u;
    const label = (poly: Pt[], lines: string[], cls: string) => {
      const c = planCentroid(poly);
      const t = svgEl('text', { x: c.X, y: c.Y - (lines.length - 1) * font * 0.6, class: cls, 'font-size': font });
      lines.forEach((ln, i) => { const s = svgEl('tspan', { x: c.X, dy: i ? font * 1.2 : 0 }); s.textContent = ln; t.appendChild(s); });
      return t;
    };

    roomsNow().forEach(room => {
      const poly: Pt[] = room.Shape || [];
      if (poly.length < 3) return;
      const p = placeOf(room.Id);
      const st = p?.state || 'unmetered';
      const sel = selection?.type === 'room' && selection.id === room.Id;
      const shape = svgEl('polygon', {
        points: poly.map(q => `${q.X},${q.Y}`).join(' '),
        class: `fp-room is-${mode === 'view' ? st : 'edit'}${sel ? ' is-selected' : ''}`,
        'stroke-width': (sel ? 3 : 1.5) * u,
      });
      if (mode === 'view' && st === 'known') shape.style.fill = shadeOf(p!.value, max);
      if (mode === 'view' && st === 'unmetered') shape.setAttribute('fill', 'url(#fp-hatch)');
      shape.dataset.room = room.Id;
      svg.appendChild(shape);
      const lines = [room.Name || room.Id];
      if (mode === 'view') lines.push(st === 'known' ? fmt(p!.value) : st === 'unknown' ? 'no data' : 'unmetered');
      svg.appendChild(label(poly, lines, 'fp-label' + (mode === 'view' ? ' is-' + st : '')));
    });

    areasNow().forEach(area => {
      const poly: Pt[] = area.Shape || [];
      if (poly.length < 3) return;
      const sel = selection?.type === 'area' && selection.id === area.Id;
      const shape = svgEl('polygon', { points: poly.map(q => `${q.X},${q.Y}`).join(' '), class: 'fp-area' + (sel ? ' is-selected' : ''), 'stroke-width': (sel ? 3 : 2) * u, 'stroke-dasharray': `${8 * u} ${5 * u}` });
      shape.dataset.area = area.Id;
      svg.appendChild(shape);
      svg.appendChild(label(poly, [area.Name || area.Id], 'fp-label fp-area-label'));
    });

    // Placed items keep their size on screen at any zoom, and a circuit nobody has identified is ringed.
    const r = 11 * u;
    itemsNow().forEach((item: any) => {
      const sel = selection?.type === 'item' && selection.id === item.Id;
      const known = !!item.Circuit && (live?.placements[item.Id]?.circuitKnown ?? true);
      const g = svgEl('g', { class: 'fp-item' + (sel ? ' is-selected' : '') + (known ? '' : ' is-unknown'), transform: `translate(${item.X},${item.Y})` });
      g.dataset.item = item.Id;
      g.appendChild(svgEl('circle', { r, class: 'fp-item-disc', 'stroke-width': (sel ? 2.5 : 1.5) * u }));
      const glyph = fpGlyph(item.Kind || 'outlet', r);
      glyph.setAttribute('stroke-width', 1.4 * u);
      g.appendChild(glyph);
      if (!known) {
        const badge = svgEl('text', { x: r * 0.8, y: -r * 0.6, class: 'fp-item-q', 'font-size': font * 0.9 });
        badge.textContent = '?';
        g.appendChild(badge);
      }
      const title = svgEl('title');
      title.textContent = `${item.Label || item.Kind}${item.Circuit ? ' — ' + item.Circuit : ' — circuit unknown'}`;
      g.appendChild(title);
      svg.appendChild(g);
    });

    // Editing handles: each corner, and a midpoint on each edge that adds a corner when dragged.
    const target = mode === 'rooms' ? shapeOf(selection) : null;
    if (target && (target.Shape || []).length >= 3) {
      const poly: Pt[] = target.Shape;
      poly.forEach((q, i) => {
        const a = q, b = poly[(i + 1) % poly.length];
        const mid = svgEl('circle', { cx: (a.X + b.X) / 2, cy: (a.Y + b.Y) / 2, r: 6 * u, class: 'fp-mid' });
        mid.dataset.mid = String(i);
        svg.appendChild(mid);
      });
      poly.forEach((q, i) => {
        const hnd = svgEl('circle', { cx: q.X, cy: q.Y, r: 9 * u, class: 'fp-handle' + (i === selectedCorner ? ' is-selected' : '') });
        hnd.dataset.corner = String(i);
        svg.appendChild(hnd);
      });
    }

    // What is being drawn right now.
    if (rectStart && rectEnd) {
      const poly = planRect(rectStart, rectEnd);
      svg.appendChild(svgEl('polygon', { points: poly.map(q => `${q.X},${q.Y}`).join(' '), class: 'fp-draft', 'stroke-width': 2 * u }));
    }
    if (draft.length) {
      svg.appendChild(svgEl('polyline', { points: draft.map(q => `${q.X},${q.Y}`).join(' '), class: 'fp-draft', 'stroke-width': 2 * u }));
      draft.forEach((q, i) => svg.appendChild(svgEl('circle', { cx: q.X, cy: q.Y, r: (i === 0 ? 9 : 6) * u, class: 'fp-draft-pt' + (i === 0 ? ' is-first' : '') })));
    }

    // The scale the shading is on, with what it means at each end.
    legend.innerHTML = '';
    if (mode === 'view' && roomsNow().some(rm => (rm.Shape || []).length >= 3)) {
      legend.append(
        el('span', { class: 'fp-key' }, el('span', { class: 'fp-swatch fp-grad' }), `0 – ${max > 0 ? fmt(max) : 'no readings yet'}`),
        el('span', { class: 'fp-key' }, el('span', { class: 'fp-swatch is-unmetered' }), 'unmetered'),
        el('span', { class: 'fp-key' }, el('span', { class: 'fp-swatch is-unknown' }), 'no data'));
    }
  };

  // --- Pointer handling ----------------------------------------------------------------------------
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: any = null;
  let pinch: { d: number; mid: Pt; vb: typeof vb } | null = null;

  const hitOf = (e: any) => {
    const t = e.target;
    const d = t?.dataset || {};
    if (d.corner != null) return { corner: Number(d.corner) };
    if (d.mid != null) return { mid: Number(d.mid) };
    const g = t?.closest ? t.closest('[data-item]') : null;
    if (g?.dataset?.item) return { item: g.dataset.item };
    if (d.item) return { item: d.item };
    if (d.area) return { area: d.area };
    if (d.room) return { room: d.room };
    return {};
  };

  svg.addEventListener('pointerdown', (e: any) => {
    if (e.button != null && e.button > 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { svg.setPointerCapture?.(e.pointerId); } catch { /* capture is a nicety */ }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mid: toPlan({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }), vb: { ...vb } };
      gesture = null;
      return;
    }
    const p = toPlan(e);
    const hit = hitOf(e);
    gesture = { start: p, sx: e.clientX, sy: e.clientY, hit, moved: false, vb: { ...vb } };

    if (mode === 'rooms') {
      const target = shapeOf(selection);
      if (hit.corner != null && target) { gesture.kind = 'corner'; gesture.index = hit.corner; selectedCorner = hit.corner; }
      else if (hit.mid != null && target) {
        const poly: Pt[] = target.Shape;
        const i = hit.mid;
        poly.splice(i + 1, 0, planNearestOnSegment(p, poly[i], poly[(i + 1) % poly.length]));
        gesture.kind = 'corner'; gesture.index = i + 1; selectedCorner = i + 1;
      }
      else if (tool === 'rect') { gesture.kind = 'rect'; rectStart = snapped(p); rectEnd = rectStart; }
      else if (tool === 'poly') gesture.kind = 'poly';
      else if (hit.room || hit.area) {
        selection = hit.room ? { type: 'room', id: hit.room } : { type: 'area', id: hit.area };
        selectedCorner = -1;
        const s = shapeOf(selection);
        gesture.kind = 'move'; gesture.orig = (s?.Shape || []).map((q: Pt) => ({ ...q }));
      }
      else gesture.kind = 'pan';
    } else if (mode === 'place') {
      if (hit.item) { selection = { type: 'item', id: hit.item }; gesture.kind = 'item'; const it = itemOf(hit.item); gesture.orig = { X: it.X, Y: it.Y }; }
      else gesture.kind = armed ? 'drop' : 'pan';
    } else {
      gesture.kind = 'pan';
    }
    dragging = true;
    drawPlan();
  });

  svg.addEventListener('pointermove', (e: any) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const f = d / pinch.d;
      const { w } = floorSize();
      const nw = Math.max(w * 0.05, Math.min(w * 4, pinch.vb.w / f));
      const k = nw / pinch.vb.w;
      vb = { x: pinch.mid.X - (pinch.mid.X - pinch.vb.x) * k, y: pinch.mid.Y - (pinch.mid.Y - pinch.vb.y) * k, w: nw, h: pinch.vb.h * k };
      const now = toPlan({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      vb.x += pinch.mid.X - now.X; vb.y += pinch.mid.Y - now.Y;
      drawPlan();
      return;
    }
    if (!gesture) return;
    if (!gesture.moved && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) < 6) return;
    gesture.moved = true;
    const p = toPlan(e);
    const { w, h } = floorSize();
    if (gesture.kind === 'pan') {
      const r = svg.getBoundingClientRect();
      const scale = Math.min(r.width / gesture.vb.w, r.height / gesture.vb.h) || 1;
      vb = { ...gesture.vb, x: gesture.vb.x - (e.clientX - gesture.sx) / scale, y: gesture.vb.y - (e.clientY - gesture.sy) / scale };
    } else if (gesture.kind === 'corner') {
      const s = shapeOf(selection);
      if (s) s.Shape[gesture.index] = snapped(p, s);
    } else if (gesture.kind === 'move') {
      const s = shapeOf(selection);
      if (s) {
        let dx = p.X - gesture.start.X, dy = p.Y - gesture.start.Y;
        // The first corner snaps, and the rest follow it, so a room slides into place against its neighbour.
        const first = gesture.orig[0];
        const want = snapped({ X: first.X + dx, Y: first.Y + dy }, s);
        dx = want.X - first.X; dy = want.Y - first.Y;
        s.Shape = planClamp(planMove(gesture.orig, dx, dy), w, h);
      }
    } else if (gesture.kind === 'rect') {
      rectEnd = snapped(p);
    } else if (gesture.kind === 'item') {
      const it = itemOf(selection!.id);
      if (it) { it.X = planRound(Math.max(0, Math.min(w, gesture.orig.X + p.X - gesture.start.X))); it.Y = planRound(Math.max(0, Math.min(h, gesture.orig.Y + p.Y - gesture.start.Y))); }
    }
    drawPlan();
  });

  const endPointer = (e: any) => {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; if (!pointers.size) { dragging = false; } return; }
    const g = gesture;
    gesture = null;
    dragging = false;
    if (!g) return;
    const p = toPlan(e);
    const { w, h } = floorSize();

    if (!g.moved) {
      // A tap.
      if (mode === 'view' || (mode === 'rooms' && tool === 'select' && g.kind === 'pan') || (mode === 'place' && g.kind === 'pan')) {
        selection = g.hit.item ? { type: 'item', id: g.hit.item } : g.hit.room ? { type: 'room', id: g.hit.room } : g.hit.area ? { type: 'area', id: g.hit.area } : null;
        selectedCorner = -1;
      } else if (g.kind === 'poly') {
        const q = snapped(p);
        const first = draft[0];
        if (first && draft.length >= 3 && Math.hypot(q.X - first.X, q.Y - first.Y) <= 14 * upp()) finishOutline(draft);
        else draft.push(q);
      } else if (g.kind === 'drop' && armed) {
        const room = planShapeAt(roomsNow(), p);
        const id = freshItemId(armed);
        itemsIn().push({ Id: id, Kind: armed, Label: '', Room: room?.Id || '', X: planRound(p.X), Y: planRound(p.Y), Circuit: '', Node: '' });
        selection = { type: 'item', id };
        if (!room) toast('Dropped outside every room. Draw the room around it, or move it into one.', false);
        changed();
      } else if (g.kind === 'rect') { rectStart = null; rectEnd = null; }
      render();
      return;
    }

    if (g.kind === 'rect' && rectStart && rectEnd) {
      const poly = planRect(rectStart, rectEnd);
      rectStart = null; rectEnd = null;
      if (Math.abs(planArea(poly)) > (Math.max(w, h) / 100) ** 2) finishOutline(poly);
    } else if (g.kind === 'corner' || g.kind === 'move') {
      const s = shapeOf(selection);
      if (s) s.Shape = planClamp(s.Shape, w, h);
      changed();
    } else if (g.kind === 'item') {
      const it = itemOf(selection!.id);
      // Moving an item into another room moves it there.
      const room = planShapeAt(roomsNow(), { X: it.X, Y: it.Y });
      if (room && room.Id !== it.Room) { it.Room = room.Id; toast(`Moved into ${room.Name || room.Id}.`, true); }
      changed();
    }
    render();
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', (e: any) => { pointers.delete(e.pointerId); gesture = null; pinch = null; dragging = false; rectStart = null; rectEnd = null; drawPlan(); });
  svg.addEventListener('wheel', (e: any) => {
    // Ctrl/⌘ + wheel zooms, as everywhere else in the GUI; a plain wheel scrolls the page past the plan.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomAt(toPlan(e), e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  /// A drawn outline becomes the selected room or area when it has none yet, and a new one otherwise.
  const finishOutline = (poly: Pt[]) => {
    const { w, h } = floorSize();
    const shape = planClamp(poly, w, h);
    draft = [];
    const target = shapeOf(selection);
    if (target && (target.Shape || []).length < 3 && (selection!.type === drawKind)) { target.Shape = shape; }
    else if (drawKind === 'area') {
      const name = `Area ${areasNow().length + 1}`;
      const id = freshId(name);
      // An area drawn over rooms takes them in.
      const rooms = roomsNow().filter(r => (r.Shape || []).length >= 3 && planShapeAt([{ Shape: shape }], planCentroid(r.Shape))).map(r => r.Id);
      areasNow().push({ Id: id, Name: name, Rooms: rooms, Shape: shape });
      selection = { type: 'area', id };
    } else {
      const name = `Room ${roomsNow().length + 1}`;
      const id = freshId(name);
      roomsNow().push({ Id: id, Name: name, Shape: shape });
      selection = { type: 'room', id };
      // Items already dropped inside it are now in it.
      itemsIn().forEach((it: any) => { if (!it.Room && planShapeAt([{ Shape: shape }], { X: it.X, Y: it.Y })) it.Room = id; });
    }
    tool = 'select';
    changed();
    render();
    // Straight to its name: nobody wants to live with "Room 4".
    setTimeout(() => (side.querySelector?.('.fp-name') as any)?.focus?.(), 0);
  };

  // --- Toolbars ------------------------------------------------------------------------------------
  const seg = (options: [string, string][], value: string, onPick: (v: string) => void, title = '') => {
    const box = el('div', { class: 'fp-seg fp-seg-sm' });
    if (title) box.title = title;
    options.forEach(([v, label]) => {
      const b = el('button', { class: 'fp-seg-btn' + (v === value ? ' is-on' : ''), text: label, type: 'button' });
      b.setAttribute('aria-pressed', String(v === value));
      b.onclick = () => onPick(v);
      box.appendChild(b);
    });
    return box;
  };

  const drawSub = () => {
    subBar.innerHTML = '';
    Object.entries(modeBtns).forEach(([m, b]) => { b.classList.toggle('is-on', m === mode); b.setAttribute('aria-selected', String(m === mode)); });
    if (mode === 'view') {
      subBar.appendChild(seg([['now', 'Power now'], ['today', 'Today'], ['week', 'This week']], period, v => { period = v; remember('period', v); load(); },
        'Shade by what each room is drawing now, or by the energy it has used over a period.'));
    } else if (mode === 'rooms') {
      subBar.appendChild(seg([['select', 'Select'], ['rect', 'Rectangle'], ['poly', 'Outline']], tool, v => { tool = v as any; draft = []; render(); }));
      subBar.appendChild(seg([['room', 'Room'], ['area', 'Area']], drawKind, v => { drawKind = v as any; render(); }, 'Draw a room, or an area that may span rooms.'));
      const snap = el('input', { type: 'checkbox' }) as HTMLInputElement;
      snap.checked = snapOn;
      snap.onchange = () => { snapOn = snap.checked; remember('snap', snapOn ? '1' : '0'); };
      subBar.appendChild(el('label', { class: 'ld-inst fp-snap', title: 'Corners snap to other rooms’ corners and edges, then to the grid.' }, snap, ' Snap'));
      if (tool === 'poly' && draft.length) {
        const done = btn('Finish outline', 'primary');
        done.disabled = draft.length < 3;
        done.onclick = () => finishOutline(draft);
        const undo = btn('Undo point');
        undo.onclick = () => { draft.pop(); render(); };
        const cancel = btn('Cancel');
        cancel.onclick = () => { draft = []; render(); };
        subBar.append(done, undo, cancel);
      }
    } else {
      const kinds = el('div', { class: 'fp-seg fp-seg-sm fp-kinds' });
      FP_KINDS.forEach(([k, label]) => {
        const b = el('button', { class: 'fp-seg-btn fp-kind' + (armed === k ? ' is-on' : ''), type: 'button', title: `Tap the plan to place ${label.toLowerCase()}s. Tap again to stop.` });
        const icon = svgEl('svg', { viewBox: '-12 -12 24 24', class: 'fp-kind-icon' });
        icon.appendChild(svgEl('circle', { r: 11, class: 'fp-item-disc' }));
        const gl = fpGlyph(k, 11); gl.setAttribute('stroke-width', '1.4'); icon.appendChild(gl);
        b.append(icon, el('span', { text: label }));
        b.setAttribute('aria-pressed', String(armed === k));
        b.setAttribute('aria-label', label);
        b.onclick = () => { armed = armed === k ? null : k; render(); };
        kinds.appendChild(b);
      });
      subBar.appendChild(kinds);
    }
    hint.textContent = mode === 'rooms'
      ? (tool === 'rect' ? `Drag across the plan to draw a ${drawKind}.` : tool === 'poly' ? `Tap each corner of the ${drawKind}; tap the first corner again to close it.` : 'Tap a room to select it; drag it or its corners. Drag a small dot to add a corner.')
      : mode === 'place' ? (armed ? `Tap the plan to place a ${armed}.` : 'Pick what to place above, or tap an item to edit it.')
      : '';
    hint.hidden = !hint.textContent;
  };

  // --- Side panel ----------------------------------------------------------------------------------
  const row = (label: string, value: any, cls = '') => el('div', { class: 'fp-row ' + cls }, el('span', { class: 'fp-row-k', text: label }), typeof value === 'string' ? el('span', { class: 'fp-row-v', text: value }) : value);
  const field = (label: string, input: any, hintText = '') => el('label', { class: 'fp-field' }, el('span', { class: 'fp-field-k', text: label }), input, ...(hintText ? [el('span', { class: 'fp-field-hint', text: hintText })] : []));
  const valueLine = (p: Place | null) => {
    if (!p) return el('div', { class: 'fp-big is-unmetered', text: 'unmetered' });
    const box = el('div', {});
    box.appendChild(el('div', { class: 'fp-big is-' + p.state, text: p.state === 'known' ? fmt(p.value) : p.state === 'unknown' ? 'no data' : 'unmetered' }));
    if (p.state !== 'known') box.appendChild(el('div', { class: 'desc', text: FP_STATE_TEXT[p.state] || '' }));
    if (p.missing.length) box.appendChild(el('div', { class: 'desc', text: 'Waiting on: ' + p.missing.map(m => m.label).join(', ') }));
    if (p.split.length) box.appendChild(el('div', { class: 'desc', text: 'Fed from inside and outside this place, so its share cannot be told: ' + p.split.map(m => m.label).join(', ') }));
    return box;
  };

  /// Every circuit serving a place: breakers that say they serve it, and the circuits of what is placed or metered in it.
  const circuitsFor = (placeId: string) => {
    if (!live) return [] as Circuit[];
    const inPlace = (loc: string | null) => !!loc && (loc === placeId || areaTakesIn(placeId, loc));
    const refs = new Set<string>();
    live.circuits.forEach(c => { if (c.rooms.some(r => inPlace(r) || areaTakesIn(r, placeId))) refs.add(c.ref); });
    itemsIn().forEach((it: any) => { if (it.Circuit && inPlace(it.Room)) refs.add(it.Circuit); });
    live.nodes.forEach(n => { if (n.circuit && inPlace(n.placed)) refs.add(n.circuit); });
    return live.circuits.filter(c => refs.has(c.ref));
  };
  /// Does an area take in this room?
  const areaTakesIn = (areaId: string, roomId: string) => areasNow().some(a => a.Id === areaId && (a.Rooms || []).includes(roomId));

  const circuitRow = (c: Circuit) => {
    const b = el('button', { class: 'fp-list-row', type: 'button' },
      el('span', { class: 'fp-list-name', text: circuitLabel(c) }),
      el('span', { class: 'fp-list-val' + (c.power == null ? ' is-nodata' : ''), text: c.power == null ? 'no data' : formatMeasure(Math.round(c.power), 'W') }));
    if (c.exceeded) b.appendChild(el('span', { class: 'fp-flag', text: 'devices read more than the circuit', title: 'A device is on a different circuit than recorded, or a CT is on the wrong wire.' }));
    b.onclick = () => openCircuit(c);
    return b;
  };

  const drawSide = () => {
    side.innerHTML = '';
    const fl = floorNow();
    if (!fl) {
      side.appendChild(el('h3', { text: 'Start with a floor' }));
      side.appendChild(el('div', { class: 'desc', text: 'Add a site and its first floor. Rooms from your Version 2.0 room tags can be brought in under Tools.' }));
      const start = btn('Add a site and floor', 'primary');
      start.onclick = () => addSheet();
      side.appendChild(start);
      return;
    }
    if (imageFailed && imageFailed === fl.floor.Image)
      side.appendChild(el('div', { class: 'fp-note is-warn', text: 'This floor’s plan image could not be loaded, so it is drawn on a grid. Upload it again under Floor settings.' }));
    (live?.problems || []).forEach(pr => side.appendChild(el('div', { class: 'fp-note is-warn', text: pr })));
    if (live?.message) side.appendChild(el('div', { class: 'fp-note', text: live.message }));

    if (selection) {
      const back = el('button', { class: 'fp-back', type: 'button', text: '‹ All rooms' });
      back.onclick = () => { selection = null; selectedCorner = -1; render(); };
      side.appendChild(back);
    }
    if (selection?.type === 'item') return drawItem(itemOf(selection.id));
    if (selection && shapeOf(selection)) return drawShape(selection.type as 'room' | 'area', shapeOf(selection));
    drawFloorSummary(fl);
  };

  const drawFloorSummary = (fl: any) => {
    const fp = placeOf(fl.floor.Id), sp = placeOf(fl.site.Id);
    side.appendChild(el('h3', { text: fl.floor.Name || fl.floor.Id }));
    side.appendChild(valueLine(fp));
    if (sp) side.appendChild(row(fl.site.Name || fl.site.Id, sp.state === 'known' ? fmt(sp.value) : sp.state === 'unknown' ? 'no data' : 'unmetered'));
    const list = el('div', { class: 'fp-list' });
    const undrawn: any[] = [];
    [...roomsNow().map(r => ['room', r]), ...areasNow().map(a => ['area', a])].forEach(([type, s]: any) => {
      if ((s.Shape || []).length < 3 && type === 'room') undrawn.push(s);
      const p = placeOf(s.Id);
      const b = el('button', { class: 'fp-list-row', type: 'button' },
        el('span', { class: 'fp-list-name', text: (s.Name || s.Id) + (type === 'area' ? ' (area)' : '') }),
        el('span', { class: 'fp-list-val is-' + (p?.state || 'unmetered'), text: p?.state === 'known' ? fmt(p.value) : p?.state === 'unknown' ? 'no data' : 'unmetered' }));
      b.onclick = () => { selection = { type, id: s.Id }; render(); };
      list.appendChild(b);
    });
    side.appendChild(el('h4', { text: 'Rooms and areas' }));
    side.appendChild(list.children.length ? list : el('div', { class: 'desc', text: 'No rooms yet. Switch to Rooms and draw one.' }));
    if (undrawn.length) side.appendChild(el('div', { class: 'desc', text: `${undrawn.length} room${undrawn.length > 1 ? 's have' : ' has'} no outline yet: select one, then draw it in Rooms.` }));
  };

  const drawShape = (type: 'room' | 'area', s: any) => {
    const p = placeOf(s.Id);
    const editing = mode !== 'view';
    const name = el('input', { type: 'text', class: 'fp-name', value: s.Name || '' }) as HTMLInputElement;
    name.placeholder = type === 'room' ? 'Kitchen' : 'Upstairs';
    name.onchange = () => { s.Name = name.value.trim() || s.Id; changed(); drawPlan(); };
    side.appendChild(el('div', { class: 'fp-side-head' }, editing ? name : el('h3', { text: s.Name || s.Id }), el('span', { class: 'fp-pill', text: type })));
    side.appendChild(el('div', { class: 'fp-id', text: s.Id }));
    side.appendChild(valueLine(p));

    if (type === 'area') {
      const box = el('div', { class: 'fp-checks' });
      roomsNow().forEach(r => {
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = (s.Rooms || []).includes(r.Id);
        cb.onchange = () => { const list = ensure(s, 'Rooms', []); const at = list.indexOf(r.Id); if (cb.checked && at < 0) list.push(r.Id); if (!cb.checked && at >= 0) list.splice(at, 1); changed(); };
        box.appendChild(el('label', { class: 'ld-inst' }, cb, ' ' + (r.Name || r.Id)));
      });
      side.appendChild(el('h4', { text: 'Takes in' }));
      side.appendChild(box.children.length ? box : el('div', { class: 'desc', text: 'No rooms on this floor yet.' }));
    }

    const circuits = circuitsFor(s.Id);
    side.appendChild(el('h4', { text: 'Circuits serving it' }));
    const cl = el('div', { class: 'fp-list' });
    circuits.forEach(c => cl.appendChild(circuitRow(c)));
    side.appendChild(circuits.length ? cl : el('div', { class: 'desc', text: 'No circuit is recorded as serving it. Set the rooms a breaker serves from its circuit, or link what is placed here to a circuit.' }));

    const items = itemsIn().filter((it: any) => it.Room === s.Id || (type === 'area' && (s.Rooms || []).includes(it.Room)));
    const metered = (live?.nodes || []).filter(n => n.placed === s.Id && !items.some((it: any) => it.Node === n.id));
    side.appendChild(el('h4', { text: 'In it' }));
    const il = el('div', { class: 'fp-list' });
    items.forEach((it: any) => {
      const v = live?.placements[it.Id]?.value;
      const b = el('button', { class: 'fp-list-row', type: 'button' },
        el('span', { class: 'fp-list-name', text: `${it.Label || FP_KINDS.find(k => k[0] === it.Kind)?.[1] || it.Kind}` }),
        el('span', { class: 'fp-list-val' + (it.Node && v == null ? ' is-nodata' : ''), text: it.Node ? fmt(v) : it.Circuit ? it.Circuit : 'circuit unknown' }));
      b.onclick = () => { selection = { type: 'item', id: it.Id }; render(); };
      il.appendChild(b);
    });
    metered.forEach(n => il.appendChild(el('div', { class: 'fp-list-row is-static' }, el('span', { class: 'fp-list-name', text: n.label }), el('span', { class: 'fp-list-val', text: fmt(n.value) }))));
    side.appendChild(il.children.length ? il : el('div', { class: 'desc', text: 'Nothing placed or metered here yet.' }));

    // What it has been drawing: the same rollup at every moment in history.
    const trend = el('div', { class: 'fp-trend' });
    const trendBtn = btn('Show the last 24 hours');
    trendBtn.onclick = async () => {
      trend.innerHTML = '';
      trend.appendChild(el('div', { class: 'desc', text: 'Reading…' }));
      let r: any;
      try { r = await api(`/api/locations/series?location=${encodeURIComponent(s.Id)}&minutes=1440&step=900`, { method: 'POST', body: JSON.stringify({ EnergyFlow: flowIn() }) }); }
      catch (e: any) { r = { body: { ok: false, message: e?.message } }; }
      trend.innerHTML = '';
      if (!r.body?.ok) { trend.appendChild(el('div', { class: 'desc', text: r.body?.message || 'Could not read the history.' })); return; }
      const at: string[] = r.body.at || [];
      trend.appendChild(sparkline({ values: r.body.values, color: 'var(--accent)', units: r.body.units || 'W', width: 300, height: 90, grid: true,
        at: (i: number) => at[i] ? new Date(at[i]).toLocaleString([], { hour: '2-digit', minute: '2-digit' }) : '' }));
    };
    side.append(el('h4', { text: 'Trend' }), trendBtn, trend);

    if (editing) {
      const actions = el('div', { class: 'fp-actions' });
      const redraw = btn((s.Shape || []).length >= 3 ? 'Redraw outline' : 'Draw outline', (s.Shape || []).length >= 3 ? '' : 'primary');
      redraw.onclick = () => { mode = 'rooms'; drawKind = type; tool = 'rect'; if ((s.Shape || []).length >= 3 && !confirm('Draw a new outline for it? The current one is replaced.')) return; s.Shape = []; render(); };
      actions.appendChild(redraw);
      if (selectedCorner >= 0 && (s.Shape || []).length > 3) {
        const dropCorner = btn('Remove corner');
        dropCorner.onclick = () => { s.Shape.splice(selectedCorner, 1); selectedCorner = -1; changed(); render(); };
        actions.appendChild(dropCorner);
      }
      const del = btn('Delete', 'danger');
      del.onclick = () => {
        const inIt = itemsIn().filter((it: any) => it.Room === s.Id).length;
        if (!confirm(`Delete ${type} ${s.Name || s.Id}?${inIt ? `\n\n${inIt} placed item(s) are in it; they stay on the plan with no room.` : ''}`)) return;
        const list = type === 'room' ? roomsNow() : areasNow();
        list.splice(list.indexOf(s), 1);
        if (type === 'room') { itemsIn().forEach((it: any) => { if (it.Room === s.Id) it.Room = ''; }); areasNow().forEach(a => { a.Rooms = (a.Rooms || []).filter((x: string) => x !== s.Id); }); }
        selection = null;
        changed();
        render();
      };
      actions.appendChild(del);
      side.appendChild(actions);
    }
  };

  const drawItem = (it: any) => {
    if (!it) { selection = null; return drawSide(); }
    const editing = mode !== 'view';
    const kind = el('select', {}) as HTMLSelectElement;
    FP_KINDS.forEach(([k, l]) => kind.appendChild(el('option', { value: k, text: l })));
    kind.value = it.Kind || 'outlet';
    kind.onchange = () => { it.Kind = kind.value; changed(); drawPlan(); };
    const lbl = el('input', { type: 'text', class: 'fp-name', value: it.Label || '', placeholder: 'e.g. Fridge, Desk outlet' }) as HTMLInputElement;
    lbl.onchange = () => { it.Label = lbl.value.trim(); changed(); drawPlan(); };
    const room = el('select', {}) as HTMLSelectElement;
    room.appendChild(el('option', { value: '', text: '— no room —' }));
    roomsNow().forEach(r => room.appendChild(el('option', { value: r.Id, text: r.Name || r.Id })));
    room.value = it.Room || '';
    room.onchange = () => { it.Room = room.value; changed(); };

    const circuit = el('select', {}) as HTMLSelectElement;
    circuit.appendChild(el('option', { value: '', text: '— not known yet —' }));
    (live?.circuits || []).forEach(c => circuit.appendChild(el('option', { value: c.ref, text: circuitLabel(c) })));
    if (it.Circuit && !circuitOf(it.Circuit)) circuit.appendChild(el('option', { value: it.Circuit, text: `${it.Circuit} (not in any panel)` }));
    circuit.value = it.Circuit || '';
    circuit.onchange = () => { it.Circuit = circuit.value; offerBeneath(it); changed(); render(); };

    const node = el('select', {}) as HTMLSelectElement;
    node.appendChild(el('option', { value: '', text: '— not individually metered —' }));
    (live?.nodes || []).filter(n => !['grid', 'panel', 'inverter', 'battery', 'solar'].includes(n.kind)).forEach(n => node.appendChild(el('option', { value: n.id, text: `${n.label} (${n.id})` })));
    if (it.Node && !(live?.nodes || []).some(n => n.id === it.Node)) node.appendChild(el('option', { value: it.Node, text: it.Node }));
    node.value = it.Node || '';
    node.onchange = () => { it.Node = node.value; offerBeneath(it); changed(); render(); };

    side.appendChild(el('div', { class: 'fp-side-head' }, el('h3', { text: it.Label || FP_KINDS.find(k => k[0] === it.Kind)?.[1] || 'Item' }), el('span', { class: 'fp-pill', text: it.Kind })));
    if (editing) {
      side.append(field('Label', lbl), field('Kind', kind), field('Room', room),
        field('Circuit', circuit, 'The breaker feeding it. Unknown is fine — trace it below.'),
        field('Metered by', node, 'A smart plug, ESPHome sensor, PDU outlet or anything else reading this item alone.'));
    } else {
      side.append(row('Room', it.Room ? nameOfPlace(it.Room) : 'none'), row('Circuit', it.Circuit || 'not known yet'), row('Metered by', it.Node ? nodeLabel(it.Node) : 'not metered'));
    }
    if (it.Node) side.appendChild(row('Reading', fmt(live?.placements[it.Id]?.value)));

    const c = it.Circuit ? circuitOf(it.Circuit) : null;
    if (c) {
      side.appendChild(el('h4', { text: 'Its circuit' }));
      side.appendChild(circuitRow(c));
    } else if (it.Circuit) {
      side.appendChild(el('div', { class: 'fp-note is-warn', text: `${it.Circuit} is not a breaker in any panel, so its circuit reads as unknown.` }));
    }

    const actions = el('div', { class: 'fp-actions' });
    const trace = btn(it.Circuit ? 'Trace again' : 'Trace its circuit', it.Circuit ? '' : 'primary');
    trace.title = 'Switch a load on this outlet on and off; the channel that follows is its circuit.';
    trace.onclick = () => traceItem(it);
    actions.appendChild(trace);
    if (editing) {
      const del = btn('Delete', 'danger');
      del.onclick = () => { if (!confirm(`Remove ${it.Label || it.Kind} from the plan?`)) return; itemsIn().splice(itemsIn().indexOf(it), 1); selection = null; changed(); render(); };
      actions.appendChild(del);
    }
    side.appendChild(actions);
  };

  /// A metered device on a known circuit belongs beneath that circuit in the energy flow; moving it is offered, never done quietly.
  const offerBeneath = (it: any) => {
    const c = it.Circuit ? circuitOf(it.Circuit) : null;
    if (!it.Node || !c?.node || it.Node === c.node) return;
    const links: any[] = ensure(flowIn(), 'Links', []);
    const feeders = links.filter(l => l.To === it.Node).map(l => String(l.From));
    if (feeders.length === 1 && feeders[0] === c.node) return;
    const from = feeders.length ? `It is fed by ${feeders.map(nodeLabel).join(', ')} now; that link is replaced.` : 'Nothing feeds it in the energy flow yet.';
    if (!confirm(`Place ${nodeLabel(it.Node)} beneath ${circuitLabel(c)} (${nodeLabel(c.node)}) in the energy flow?\n\n${from}\n\nCancel leaves the energy flow as it is.`)) return;
    for (let i = links.length - 1; i >= 0; i--) if (links[i].To === it.Node) links.splice(i, 1);
    links.push({ From: c.node, To: it.Node });
    toast('Placed beneath its circuit. Press Save to keep it.', true);
  };

  // --- Circuit sheet (#464, #465) --------------------------------------------------------------------
  const openCircuit = (c: Circuit) => {
    const panel = ensure(flowIn(), 'Panels', []).find((p: any) => p.Id === c.panel);
    const breaker = panel ? ensure(panel, 'Breakers', []).find((b: any) => b.Number === c.number) : null;
    const body = el('div', { class: 'fp-sheet' });
    body.appendChild(row('Reading', c.power == null ? 'no data' : formatMeasure(Math.round(c.power), 'W') + (c.amps ? ` on a ${c.amps} A breaker` : '')));
    if (c.devices.length) {
      body.appendChild(el('h4', { text: 'Metered on it' }));
      c.devices.forEach(d => body.appendChild(row(d.label, d.value == null ? 'no data' : formatMeasure(Math.round(d.value), 'W'))));
      body.appendChild(row('Unmetered remainder', c.remainderState === 'known' ? formatMeasure(Math.round(c.remainder!), 'W') : 'unknown', c.remainderState === 'known' ? '' : 'is-nodata'));
      if (c.remainderState !== 'known') body.appendChild(el('div', { class: 'desc', text: c.power == null ? 'The circuit itself has no reading, so what is left over cannot be said.' : 'A device on it has no reading, so what is left over cannot be said.' }));
      if (c.exceeded) body.appendChild(el('div', { class: 'fp-note is-bad', text: 'What is metered on this circuit reads more than the circuit itself. A device is recorded against the wrong circuit, or the CT is on the wrong wire.' }));
    }
    // From a breaker, everything placed on its circuit, across rooms and floors.
    body.appendChild(el('h4', { text: 'Placed on it' }));
    const placed = itemsIn().filter((it: any) => it.Circuit === c.ref);
    if (!placed.length) body.appendChild(el('div', { class: 'desc', text: 'Nothing placed on the plan is linked to this circuit yet.' }));
    placed.forEach((it: any) => {
      const fl = floorsAll().find(x => ensure(x.floor, 'Rooms', []).some((r: any) => r.Id === it.Room));
      const b = el('button', { class: 'fp-list-row', type: 'button' },
        el('span', { class: 'fp-list-name', text: it.Label || it.Kind }),
        el('span', { class: 'fp-list-val', text: [it.Room ? nameOfPlace(it.Room) : 'no room', fl ? fl.floor.Name || fl.floor.Id : ''].filter(Boolean).join(' · ') }));
      b.onclick = () => { closeSheet(); if (fl) { floorId = fl.floor.Id; viewFor = ''; } selection = { type: 'item', id: it.Id }; render(); };
      body.appendChild(b);
    });
    // Which rooms and areas the circuit serves: how a room finds the circuits serving it.
    if (breaker) {
      body.appendChild(el('h4', { text: 'Serves' }));
      const box = el('div', { class: 'fp-checks' });
      floorsAll().forEach(({ floor }) => [...ensure(floor, 'Rooms', []), ...ensure(floor, 'Areas', [])].forEach((r: any) => {
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = (breaker.Rooms || []).includes(r.Id);
        cb.onchange = () => { const list = ensure(breaker, 'Rooms', []); const at = list.indexOf(r.Id); if (cb.checked && at < 0) list.push(r.Id); if (!cb.checked && at >= 0) list.splice(at, 1); changed(); };
        box.appendChild(el('label', { class: 'ld-inst' }, cb, ` ${r.Name || r.Id}`, el('span', { class: 'fp-muted', text: ` · ${floor.Name || floor.Id}` })));
      }));
      body.appendChild(box.children.length ? box : el('div', { class: 'desc', text: 'No rooms yet.' }));
    }
    const toPanel = btn('Open in Panel Schedule');
    toPanel.onclick = () => { closeSheet(); (Array.from(document.querySelectorAll('nav a')) as any[]).find(a => a.dataset.label === 'Panel Schedule')?.click(); };
    openSheet({ title: circuitLabel(c), body, footer: [toPanel] });
  };

  // --- Trace from the outlet (#468) -----------------------------------------------------------------
  const traceItem = (it: any) => {
    type Stage = { on: boolean; sum: Record<string, number>; n: Record<string, number> };
    const stages: Stage[] = [];
    const labels: Record<string, string> = {};
    let busy = false;
    const body = el('div', { class: 'fp-sheet' });
    body.appendChild(el('div', { class: 'desc', text: `Plug a lamp or kettle into ${it.Label || 'this outlet'} (or switch the fixture), then use the button: switch it, tap, and repeat. The channel that follows every switch is the circuit.` }));
    const tap = el('button', { class: 'cf-tap', type: 'button' }) as HTMLButtonElement;
    const verdict = el('div', { class: 'cf-verdict' });
    const offer = el('div', { class: 'fp-actions' });
    body.append(tap, verdict, offer);

    const sample = async () => {
      const stage = stages[stages.length - 1];
      let r: any;
      try { r = await api('/api/flow'); } catch { return; }
      (r?.body?.ok ? r.body.nodes || [] : []).forEach((n: any) => {
        if (!n.id || String(n.id).includes('#') || typeof n.value !== 'number') return;
        if (!['breaker', 'outlet', 'load', 'node'].includes(n.kind || 'node')) return;
        labels[n.id] = n.label || n.id;
        stage.sum[n.id] = (stage.sum[n.id] || 0) + n.value;
        stage.n[n.id] = (stage.n[n.id] || 0) + 1;
      });
    };
    const levels = (): Level[] => stages.filter(s => Object.keys(s.n).length).map(s => ({ on: s.on, mean: Object.fromEntries(Object.keys(s.sum).map(k => [k, s.sum[k] / s.n[k]])) }));
    const paint = () => {
      const next = !stages.length || stages[stages.length - 1].on ? 'OFF' : 'ON';
      tap.textContent = busy ? 'Reading channels…' : `Switch it ${next}, then tap`;
      tap.disabled = busy;
      const found = analyse(levels(), { labels });
      verdict.className = 'cf-verdict' + (found.done ? ' is-found' : '');
      verdict.textContent = stages.length ? found.verdict : 'Switch the load off, then tap to take the first reading.';
      offer.innerHTML = '';
      if (!found.done) return;
      const channels = found.found.map(f => f.node);
      const matches = (live?.circuits || []).filter(c => channels.some(ch => c.channels.includes(ch) || c.node === ch));
      if (!matches.length) {
        offer.appendChild(el('div', { class: 'desc', text: `${channels.map(ch => labels[ch] || ch).join(' and ')} is not mapped to a breaker yet. Map it in the Panel Schedule, then link this outlet.` }));
        return;
      }
      matches.forEach(c => {
        const b = btn(`Link to ${circuitLabel(c)}`, 'primary');
        b.onclick = () => { it.Circuit = c.ref; changed(); closeSheet(); toast(`Linked to ${circuitLabel(c)}. Press Save to keep it.`, true); render(); };
        offer.appendChild(b);
      });
    };
    tap.onclick = async () => {
      if (busy) return;
      busy = true;
      stages.push({ on: stages.length ? !stages[stages.length - 1].on : false, sum: {}, n: {} });
      paint();
      await sample();
      setTimeout(async () => { await sample(); busy = false; paint(); }, 3000);
    };
    openSheet({ title: `Trace ${it.Label || it.Kind}`, body });
    paint();
  };

  // --- Sheets: add, floor settings, tools ----------------------------------------------------------
  const addSheet = () => {
    const body = el('div', { class: 'fp-sheet' });
    const siteName = el('input', { type: 'text', placeholder: 'Home' }) as HTMLInputElement;
    const floorName = el('input', { type: 'text', placeholder: 'Ground floor' }) as HTMLInputElement;
    const level = el('input', { type: 'number', value: '0', step: '1' }) as HTMLInputElement;
    const siteSel = el('select', {}) as HTMLSelectElement;
    sitesIn().forEach((s: any) => siteSel.appendChild(el('option', { value: s.Id, text: s.Name || s.Id })));
    siteSel.appendChild(el('option', { value: '__new', text: '+ a new site' }));
    siteSel.value = floorNow()?.site.Id || (sitesIn()[0]?.Id ?? '__new');
    const siteRow = field('New site name', siteName);
    const sync = () => { siteRow.hidden = siteSel.value !== '__new'; };
    siteSel.onchange = sync;
    sync();
    body.append(field('Site', siteSel), siteRow, field('Floor name', floorName), field('Level', level, '0 is the ground floor, 1 the one above, −1 a basement.'));
    const add = btn('Add floor', 'primary');
    add.onclick = () => {
      let site = sitesIn().find((s: any) => s.Id === siteSel.value);
      if (!site) {
        const nm = siteName.value.trim() || 'Home';
        site = { Id: freshId(nm), Name: nm, Floors: [] };
        sitesIn().push(site);
      }
      const nm = floorName.value.trim() || `Floor ${ensure(site, 'Floors', []).length + 1}`;
      const f = { Id: freshId(nm), Name: nm, Level: Number(level.value) || 0, Width: 1000, Height: 700, Image: '', Rooms: [], Areas: [] };
      site.Floors.push(f);
      floorId = f.Id; remember('floor', floorId); viewFor = '';
      closeSheet();
      changed();
      toast(`Added ${nm}. Upload its plan under Floor settings, or draw on the grid. Press Save to keep it.`, true);
      mode = 'rooms'; tool = 'rect';
      render();
    };
    openSheet({ title: 'Add a floor', body, footer: [add] });
  };
  addBtn.onclick = addSheet;

  const floorSheet = () => {
    const fl = floorNow();
    if (!fl) return addSheet();
    const f = fl.floor;
    const body = el('div', { class: 'fp-sheet' });
    const name = el('input', { type: 'text', value: f.Name || '' }) as HTMLInputElement;
    name.onchange = () => { f.Name = name.value.trim() || f.Id; changed(); render(); };
    const level = el('input', { type: 'number', value: String(f.Level ?? 0), step: '1' }) as HTMLInputElement;
    level.onchange = () => { f.Level = Number(level.value) || 0; changed(); render(); };
    const limits = el('div', { class: 'desc', text: 'Checking where images are kept…' });
    api('/api/plans/storage').then((r: any) => { limits.textContent = r.body?.ok ? `${r.body.limits} Kept in ${r.body.where}, never in the configuration. A large photo is shrunk here before it is sent.` : 'Plan storage is not reachable.'; }).catch(() => { limits.textContent = 'Plan storage is not reachable.'; });
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,.svg,image/*' }) as HTMLInputElement;
    const upStatus = el('div', { class: 'desc' });
    file.onchange = async () => {
      const picked = file.files?.[0];
      if (!picked) return;
      upStatus.textContent = 'Preparing…';
      try {
        const prepared = await fpPrepareImage(picked);
        upStatus.textContent = 'Uploading…';
        const r = await fetch('/api/plans/images', { method: 'POST', headers: { 'Content-Type': prepared.type || 'application/octet-stream' }, body: prepared.blob });
        const b = await r.json().catch(() => ({}));
        if (!b.ok) { upStatus.textContent = b.message || `Upload failed (${r.status}).`; return; }
        f.Image = b.id;
        imageFailed = '';
        const drawn = [...ensure(f, 'Rooms', []), ...ensure(f, 'Areas', [])].some((s: any) => (s.Shape || []).length >= 3) || itemsIn().some((it: any) => ensure(f, 'Rooms', []).some((r2: any) => r2.Id === it.Room));
        if (!drawn && prepared.width && prepared.height) { f.Width = 1000; f.Height = Math.round(1000 * prepared.height / prepared.width); viewFor = ''; }
        upStatus.textContent = drawn ? 'Uploaded. Rooms already drawn keep their places; the image is fitted to the floor.' : 'Uploaded.';
        changed();
        render();
      } catch (e: any) { upStatus.textContent = e?.message || 'Could not read that image.'; }
    };
    const remove = btn('Remove image');
    remove.hidden = !f.Image;
    remove.onclick = () => { f.Image = ''; changed(); render(); closeSheet(); };
    const del = btn('Delete floor', 'danger');
    del.onclick = () => {
      const rooms = ensure(f, 'Rooms', []).length;
      if (!confirm(`Delete ${f.Name || f.Id}${rooms ? ` and its ${rooms} room(s)` : ''}? Items placed in its rooms are removed too.`)) return;
      const ids = new Set(ensure(f, 'Rooms', []).map((r: any) => r.Id));
      const items = itemsIn();
      for (let i = items.length - 1; i >= 0; i--) if (ids.has(items[i].Room)) items.splice(i, 1);
      fl.site.Floors.splice(fl.site.Floors.indexOf(f), 1);
      floorId = ''; selection = null; viewFor = '';
      closeSheet(); changed(); render();
    };
    body.append(field('Name', name), field('Level', level), el('div', { class: 'fp-id', text: `id ${f.Id} · ${fl.site.Name || fl.site.Id}` }),
      el('h4', { text: 'Plan image' }), limits, file, upStatus, remove);
    openSheet({ title: 'Floor settings', body, footer: [del] });
  };
  floorBtn.onclick = floorSheet;

  const toolsSheet = () => {
    const body = el('div', { class: 'fp-sheet' });
    const tags = btn('Rooms from tags…');
    tags.onclick = () => migrateSheet();
    const ha = btn('Publish rooms to Home Assistant…');
    ha.onclick = () => haSheet();
    body.append(
      el('div', { class: 'fp-tool' }, tags, el('div', { class: 'desc', text: 'Turn Version 2.0 room and area tags into rooms, with a preview of what each becomes before anything is written.' })),
      el('div', { class: 'fp-tool' }, ha, el('div', { class: 'desc', text: 'Create or match a Home Assistant area for each room, and file this bridge’s devices in them.' })));
    openSheet({ title: 'Tools', body });
  };
  toolsBtn.onclick = toolsSheet;

  const migrateSheet = async () => {
    const body = el('div', { class: 'fp-sheet' });
    body.appendChild(el('div', { class: 'desc', text: 'Loading tags…' }));
    openSheet({ title: 'Rooms from tags', body, wide: true });
    let r: any;
    try { r = await api('/api/locations/migrate', { method: 'POST', body: JSON.stringify({ config: { EnergyFlow: flowIn() } }) }); }
    catch (e: any) { r = { body: { ok: false, message: e?.message } }; }
    body.innerHTML = '';
    if (!r.body?.ok) { body.appendChild(el('div', { class: 'desc', text: r.body?.message || 'Could not read the tags.' })); return; }
    const floors = floorsAll();
    if (!floors.length) { body.appendChild(el('div', { class: 'desc', text: 'Add a floor first: a new room needs a floor to go on.' })); return; }
    const tags: any[] = r.body.tags || [];
    if (!tags.length) { body.appendChild(el('div', { class: 'desc', text: 'No tags are in use.' })); return; }
    body.appendChild(el('div', { class: 'desc', text: 'Choose what each tag becomes. Suggestions come from the words in the tag; nothing is written until you apply the preview.' }));
    const rows: { tag: string; as: HTMLSelectElement; floor: HTMLSelectElement; place: HTMLSelectElement; remove: HTMLInputElement }[] = [];
    const table = el('div', { class: 'fp-mig' });
    tags.forEach(t => {
      const as = el('select', {}) as HTMLSelectElement;
      [['skip', 'leave as a tag'], ['room', 'a new room'], ['area', 'a new area'], ['existing', 'an existing place']].forEach(([v, l]) => as.appendChild(el('option', { value: v, text: l })));
      as.value = t.suggest;
      const floor = el('select', {}) as HTMLSelectElement;
      floors.forEach(x => floor.appendChild(el('option', { value: x.floor.Id, text: `${x.site.Name || x.site.Id} › ${x.floor.Name || x.floor.Id}` })));
      floor.value = floorNow()?.floor.Id || floors[0].floor.Id;
      const place = el('select', {}) as HTMLSelectElement;
      floors.forEach(x => [...ensure(x.floor, 'Rooms', []), ...ensure(x.floor, 'Areas', [])].forEach((p: any) => place.appendChild(el('option', { value: p.Id, text: `${p.Name || p.Id} · ${x.floor.Name || x.floor.Id}` }))));
      const remove = el('input', { type: 'checkbox' }) as HTMLInputElement;
      const sync = () => { floor.hidden = !['room', 'area'].includes(as.value); place.hidden = as.value !== 'existing'; remove.disabled = as.value === 'skip'; };
      as.onchange = sync; sync();
      table.appendChild(el('div', { class: 'fp-mig-row' }, el('span', { class: 'fp-mig-tag' }, el('b', { text: t.tag }), el('span', { class: 'fp-muted', text: ` ${t.count}×` })), as, floor, place,
        el('label', { class: 'ld-inst', title: 'Take the tag off once it is a location.' }, remove, ' remove tag')));
      rows.push({ tag: t.tag, as, floor, place, remove });
    });
    body.appendChild(table);
    const out = el('div', { class: 'fp-mig-plan' });
    body.appendChild(out);
    const mappings = () => rows.map(x => ({ tag: x.tag, as: x.as.value, floor: x.floor.value, location: x.place.value, removeTag: x.remove.checked }));
    let plan: any = null;
    const preview = btn('Preview', 'primary');
    const apply = btn('Apply');
    apply.disabled = true;
    preview.onclick = async () => {
      out.innerHTML = '';
      const p: any = await api('/api/locations/migrate', { method: 'POST', body: JSON.stringify({ config: { EnergyFlow: flowIn() }, mappings: mappings() }) }).catch(() => null);
      if (!p?.body?.ok) { out.appendChild(el('div', { class: 'desc', text: p?.body?.message || 'Could not plan it.' })); return; }
      plan = p.body.plan;
      const list = (title: string, items: string[]) => { if (!items.length) return; out.appendChild(el('h4', { text: title })); const ul = el('ul', { class: 'fp-ul' }); items.forEach(s => ul.appendChild(el('li', { text: s }))); out.appendChild(ul); };
      list('Places created', plan.creates.map((c: any) => `${c.kind} ${c.name} (${c.id}) on ${nameOfPlace(c.floor)}, from tag ${c.tag}`));
      list('Nodes placed', plan.nodes.map((n: any) => `${nodeLabel(n.node)} → ${plan.creates.find((c: any) => c.id === n.location)?.name || nameOfPlace(n.location)}${n.note ? ' — ' + n.note : ''}`));
      list('Rules for derived nodes', plan.rules.map((x: any) => `${x.match} → ${plan.creates.find((c: any) => c.id === x.location)?.name || nameOfPlace(x.location)}`));
      list('Tags removed', plan.removeTags);
      list('Left alone', plan.skipped.map((s: any) => `${s.what}: ${s.why}`));
      if (!plan.creates.length && !plan.nodes.length && !plan.rules.length) out.appendChild(el('div', { class: 'desc', text: 'Nothing would change.' }));
      apply.disabled = !(plan.creates.length || plan.nodes.length || plan.rules.length || plan.removeTags.length);
    };
    apply.onclick = () => {
      if (!plan) return;
      plan.creates.forEach((c: any) => {
        const f = floorById(c.floor)?.floor;
        if (!f) return;
        if (c.kind === 'area') ensure(f, 'Areas', []).push({ Id: c.id, Name: c.name, Rooms: [], Shape: [] });
        else ensure(f, 'Rooms', []).push({ Id: c.id, Name: c.name, Shape: [] });
      });
      const nodes: any[] = ensure(flowIn(), 'Nodes', []);
      plan.nodes.forEach((n: any) => { const cfg = nodes.find(x => x.Id === n.node); if (cfg) cfg.Location = n.location; });
      const rules: any[] = ensure(flowIn(), 'AutoLocations', []);
      plan.rules.forEach((x: any) => rules.push({ Match: x.match, Location: x.location }));
      const gone = new Set((plan.removeTags as string[]).map(t => t.toLowerCase()));
      if (gone.size) {
        nodes.forEach(x => { if (Array.isArray(x.Tags)) x.Tags = x.Tags.filter((t: string) => !gone.has(String(t).toLowerCase())); });
        ensure(flowIn(), 'AutoTags', []).forEach((x: any) => { if (Array.isArray(x.Tags)) x.Tags = x.Tags.filter((t: string) => !gone.has(String(t).toLowerCase())); });
      }
      closeSheet();
      changed();
      toast(`Applied: ${plan.creates.length} place(s), ${plan.nodes.length} node(s), ${plan.rules.length} rule(s). New rooms have no outline yet — select each and draw it. Press Save to keep it.`, true);
      render();
    };
    body.appendChild(el('div', { class: 'fp-actions' }, preview, apply));
  };

  const haSheet = async () => {
    const body = el('div', { class: 'fp-sheet' });
    body.appendChild(el('div', { class: 'desc', text: 'Reading Home Assistant…' }));
    openSheet({ title: 'Rooms as Home Assistant areas', body, wide: true });
    const r: any = await api('/api/ha/areas/preview', { method: 'POST', body: JSON.stringify({ EnergyFlow: flowIn() }) }).catch((e: any) => ({ body: { ok: false, message: e?.message } }));
    body.innerHTML = '';
    if (!r.body?.ok) { body.appendChild(el('div', { class: 'desc', text: `${r.body?.message || 'Could not reach Home Assistant.'} The URL and token are set under Home Assistant › Energy Dashboard.` })); return; }
    const plan = r.body.plan;
    const WORDS: Record<string, string> = { create: 'create', rename: 'rename', link: 'link', ok: 'no change', set: 'put in area', keep: 'left alone' };
    const table = (title: string, rows: any[], cells: (x: any) => string[]) => {
      if (!rows.length) return;
      body.appendChild(el('h4', { text: title }));
      const t = el('div', { class: 'fp-ha' });
      rows.forEach(x => t.appendChild(el('div', { class: 'fp-ha-row is-' + x.action }, ...cells(x).map(c => el('span', { text: c })))));
      body.appendChild(t);
    };
    table('Rooms', plan.rooms, (x: any) => [x.name, WORDS[x.action] || x.action, x.why]);
    table('Devices', plan.devices, (x: any) => [x.deviceName, WORDS[x.action] || x.action, x.why]);
    if (plan.leftAlone.length) body.appendChild(el('div', { class: 'desc', text: `Areas no room claims are left alone: ${plan.leftAlone.map((a: any) => a.name).join(', ')}. Removing a room never removes its area.` }));
    if (!plan.rooms.length) body.appendChild(el('div', { class: 'desc', text: 'There are no rooms to publish yet.' }));
    const changes = plan.rooms.filter((x: any) => x.action !== 'ok').length + plan.devices.filter((x: any) => x.action === 'set').length;
    const go = btn(changes ? `Apply ${changes} change${changes > 1 ? 's' : ''}` : 'Nothing to change', 'primary');
    go.disabled = !changes;
    go.onclick = async () => {
      go.disabled = true;
      const a: any = await api('/api/ha/areas/apply', { method: 'POST', body: JSON.stringify({ EnergyFlow: flowIn() }) }).catch((e: any) => ({ body: { ok: false, message: e?.message } }));
      const linked = a.body?.linked || {};
      floorsAll().forEach(({ floor }) => ensure(floor, 'Rooms', []).forEach((rm: any) => { if (linked[rm.Id]) rm.HaArea = linked[rm.Id]; }));
      if (Object.keys(linked).length) changed();
      closeSheet();
      toast((a.body?.message || 'Done.') + (Object.keys(linked).length ? ' Press Save to remember the links, so a rename updates the same area.' : ''), !!a.body?.ok);
    };
    body.appendChild(el('div', { class: 'fp-actions' }, go));
  };

  // --- Loading and rendering -----------------------------------------------------------------------
  let pending: any = null;
  const schedule = () => { clearTimeout(pending); pending = setTimeout(load, 600); };
  const load = async () => {
    const q = period === 'now' ? '' : `?period=${period}`;
    let r: any;
    try { r = await api('/api/locations/resolve' + q, { method: 'POST', body: JSON.stringify({ EnergyFlow: flowIn() }) }); }
    catch (e: any) { r = { body: { ok: false, message: e?.message || 'the request failed' } }; }
    if (!r.body?.ok) { status.textContent = r.body?.message || 'Could not read the locations.'; live = null; }
    else {
      status.textContent = '';
      live = {
        places: Object.fromEntries((r.body.places || []).map((p: Place) => [p.id, p])),
        nodes: r.body.nodes || [], circuits: r.body.circuits || [],
        placements: Object.fromEntries((r.body.placements || []).map((p: any) => [p.id, p])),
        units: r.body.units || 'W', problems: r.body.problems || [], message: r.body.message || null,
      };
    }
    if (!dragging) render();
  };

  const render = () => {
    const floors = floorsAll();
    floorSel.innerHTML = '';
    floors.forEach(x => floorSel.appendChild(el('option', { value: x.floor.Id, text: `${x.site.Name || x.site.Id} › ${x.floor.Name || x.floor.Id}` })));
    if (!floors.length) floorSel.appendChild(el('option', { value: '', text: 'no floors yet' }));
    const fl = floorNow();
    if (fl && fl.floor.Id !== floorId) floorId = fl.floor.Id;
    floorSel.value = floorId;
    floorSel.disabled = !floors.length;
    floorBtn.disabled = !fl;
    if (fl && viewFor !== fl.floor.Id + '|' + fl.floor.Width + '|' + fl.floor.Height) { fit(); viewFor = fl.floor.Id + '|' + fl.floor.Width + '|' + fl.floor.Height; }
    stage.classList.toggle('is-empty', !fl);
    if (fl) stage.style.aspectRatio = `${Number(fl.floor.Width) || 1000} / ${Number(fl.floor.Height) || 700}`;
    drawSub();
    drawPlan();
    drawSide();
  };

  window.addEventListener('keydown', (e: any) => {
    if (!sec.classList.contains('active') || /INPUT|SELECT|TEXTAREA/.test(e.target?.tagName || '')) return;
    if (e.key === 'Escape' && (draft.length || rectStart)) { draft = []; rectStart = null; rectEnd = null; render(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && mode !== 'view' && selection) {
      if (selection.type === 'item') { const it = itemOf(selection.id); if (it && confirm(`Remove ${it.Label || it.Kind} from the plan?`)) { itemsIn().splice(itemsIn().indexOf(it), 1); selection = null; changed(); render(); } }
    }
  });

  link.onclick = () => { activate(link, sec); render(); load(); };
  // The live view keeps up with the house while it is on screen.
  setInterval(() => { if (sec.classList.contains('active') && !dragging && mode === 'view' && period === 'now') load(); }, 10000);
  return { link, sec };
}

/// A picked file made ready to upload: a phone photo decoded upright and shrunk, anything else passed through.
async function fpPrepareImage(file: File): Promise<{ blob: Blob; type: string; width: number; height: number }> {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (isSvg) {
    const text = await file.text();
    const m = text.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
    return { blob: file, type: 'image/svg+xml', width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0 };
  }
  let bitmap: any;
  try { bitmap = await (window as any).createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('This browser cannot read that image. A HEIC photo needs converting to JPEG first, or set the camera to “Most Compatible”.'); }
  const MAX = 4000;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
  // A small PNG is line art worth keeping exact; a photo, or anything large, is re-encoded.
  if (scale === 1 && file.size < 3 * 1024 * 1024 && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    return { blob: file, type: file.type, width, height };
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Could not encode the image.')), 'image/jpeg', 0.85));
  return { blob, type: 'image/jpeg', width, height };
}

// Floor Plans (#470): each floor drawn at real size with its rooms, outdoor zones and areas, doors and windows
// (#463), the outlets, fixtures, devices and utility gear placed on it and the cable runs between them (#464,
// #465), shaded live by what each room draws (#466), with a trace that finds an outlet's breaker from the
// outlet (#468). One Edit mode with a tool palette, undo and redo, and sizes in feet or metres.
import { activate, api, btn, closeSheet, el, ensure, navLink, openSheet, svgEl, toast, formatMeasure } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { sparkline } from '../charts.js';
import { analyse, type Level } from '../circuit-finder.js';
import { type Pt, planRect, planArea, planCentroid, planShapeAt, planSnap, planMove, planClamp, planRound, planScaleMax, planNearestOnSegment, planNearestWall, planPathLength, planIsBox, planBounds, planContains } from '../plan-geometry.js';
import { planUnitSystem, planFmtLen, planFmtArea, planParseLen, planGridStep, planSnapStep, planScaleBar, planDefaultPlot } from '../plan-units.js';
import { planHistory } from '../plan-history.js';
import { PLAN_SURFACES, PLAN_GROUNDS, PLAN_KINDS, PLAN_SUPPLY_KINDS, PLAN_OPENINGS, planTextures, planGlyph, planOpening, planCircuitColor } from '../plan-art.js';

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
type SelType = 'room' | 'area' | 'item' | 'opening' | 'run';
type Selection = { type: SelType; id: string } | null;
type Tool = 'select' | 'pan' | 'room' | 'outline' | 'zone' | 'area' | 'door' | 'window' | 'item' | 'wire' | 'measure';

/// Why a place has no total, in the words the page uses. Never a zero.
const FP_STATE_TEXT: Record<string, string> = {
  unmetered: 'Nothing metered is placed here.',
  unknown: 'A reading this total needs is missing, so it is not shown.',
};

/// The palette: [tool, name, shortcut, what it does].
const FP_TOOLS: [Tool, string, string, string][] = [
  ['select', 'Select', 'V', 'Select and move anything: rooms, their corners, items, doors, windows and wire bends.'],
  ['pan', 'Pan', 'H', 'Drag to move around the plan. Two fingers or the wheel with Ctrl also pan and zoom.'],
  ['room', 'Room', 'R', 'Drag a rectangle to draw a room, or add one by its measurements.'],
  ['outline', 'Outline', 'P', 'Tap each corner of an odd-shaped room; tap the first corner again to close it.'],
  ['zone', 'Outdoor', 'O', 'Drag out a yard, porch, patio, driveway or deck.'],
  ['area', 'Area', 'A', 'Drag out an area that may span rooms, such as upstairs or the server corner.'],
  ['door', 'Door', 'D', 'Tap a wall to put a door in it.'],
  ['window', 'Window', 'W', 'Tap a wall to put a window in it.'],
  ['item', 'Item', 'I', 'Tap to place an outlet, light, appliance, panel, meter, pole or anything else.'],
  ['wire', 'Wire', 'L', 'Draw a cable run: tap where it starts, tap each bend, and tap the item it ends at.'],
  ['measure', 'Measure', 'M', 'Tap two points to measure between them, and set the plan’s scale from a distance you know.'],
];

/// A small line icon for each tool, drawn in the button's own colour.
function fpToolIcon(tool: string): any {
  const s = svgEl('svg', { viewBox: '0 0 24 24', class: 'fp-tool-icon', 'aria-hidden': 'true' });
  const p = (d: string) => s.appendChild(svgEl('path', { d }));
  switch (tool) {
    case 'select': p('M5 3 L5 19 L9.5 14.5 L12.5 21 L15 20 L12 13.5 L18 13.5 Z'); break;
    case 'pan': p('M12 3 V21 M3 12 H21 M12 3 L9.5 5.5 M12 3 L14.5 5.5 M12 21 L9.5 18.5 M12 21 L14.5 18.5 M3 12 L5.5 9.5 M3 12 L5.5 14.5 M21 12 L18.5 9.5 M21 12 L18.5 14.5'); break;
    case 'room': p('M4 5 H20 V19 H4 Z M4 12 H10'); break;
    case 'outline': p('M4 7 L11 4 L20 8 L18 19 L6 18 Z'); break;
    case 'zone': p('M12 3 L7 11 H10 L6 17 H18 L14 11 H17 Z M12 17 V21'); break;
    case 'area': p('M4 5 H7 M10 5 H14 M17 5 H20 V8 M20 11 V14 M20 17 V19 H17 M14 19 H10 M7 19 H4 V16 M4 13 V10 M4 7 V5'); break;
    case 'door': p('M4 20 H20 M6 20 V6 M6 6 A14 14 0 0 1 20 20'); break;
    case 'window': p('M3 9 H21 M3 12 H21 M3 15 H21 M3 9 V15 M21 9 V15'); break;
    case 'item': p('M12 3 A9 9 0 1 0 12.01 3 Z M9.5 8 V12 M14.5 8 V12 M12 15.5 V16'); break;
    case 'wire': p('M4 18 C8 18 8 6 12 6 S16 18 20 18 M4 18 A1.5 1.5 0 1 0 4.01 18 M20 18 A1.5 1.5 0 1 0 20.01 18'); break;
    case 'measure': p('M3 16 L16 3 L21 8 L8 21 Z M7 12 L9 14 M10 9 L12 11 M13 6 L15 8'); break;
    case 'undo': p('M9 7 L4 12 L9 17 M4 12 H14 A6 6 0 0 1 14 24'); break;
    case 'redo': p('M15 7 L20 12 L15 17 M20 12 H10 A6 6 0 0 0 10 24'); break;
  }
  return s;
}

export function addFloorPlanSection(nav: any, sections: any) {
  const link = navLink(nav, 'Floor Plans', '⌗');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section fp' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Floor Plans' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Each floor at real size: rooms and outdoor zones, doors and windows, and the outlets, lights, panels, meters '
    + 'and devices on it with the cable runs between them. View shades each room by what it draws — a room with '
    + 'nothing metered reads unmetered, never zero. Edit draws and moves everything; Ctrl+Z undoes.'));

  // --- Config access -------------------------------------------------------------------------------
  const flowIn = () => ensure(state.data, 'EnergyFlow', {});
  const sitesIn = (): any[] => ensure(flowIn(), 'Sites', []);
  const itemsIn = (): any[] => ensure(flowIn(), 'Placements', []);
  const runsIn = (): any[] => ensure(flowIn(), 'Runs', []);
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
  const freshIn = (list: any[], stem: string) => {
    const taken = new Set(list.map((p: any) => p.Id));
    let n = list.length + 1, id = `${stem}_${n}`;
    while (taken.has(id)) id = `${stem}_${++n}`;
    return id;
  };

  // --- Page state ----------------------------------------------------------------------------------
  const remembered = (key: string, fallback: string) => { try { return localStorage.getItem('rpdu-fp-' + key) || fallback; } catch { return fallback; } };
  const remember = (key: string, v: string) => { try { localStorage.setItem('rpdu-fp-' + key, v); } catch { /* this session only */ } };
  let floorId = remembered('floor', '');
  let mode: 'view' | 'edit' = 'view';
  let tool: Tool = 'select';
  let itemKind = remembered('kind', 'outlet');
  let doorKind = 'door';
  let wireKind = 'circuit';
  let snapOn = remembered('snap', '1') === '1';
  let showWiring = remembered('wiring', '1') === '1';
  let showSizes = remembered('sizes', '0') === '1';
  let period = remembered('period', 'now');
  let selection: Selection = null;
  let selectedCorner = -1;
  let draft: Pt[] = [];
  let rectStart: Pt | null = null, rectEnd: Pt | null = null;
  let wireDraft: { from: string; pts: Pt[] } | null = null;
  let measure: { a: Pt; b: Pt | null } | null = null;
  let live: Live | null = null;
  let imageFailed = '';
  let vb = { x: 0, y: 0, w: 1000, h: 700 };
  let viewFor = '';
  let dragging = false;
  let hover: Pt | null = null;

  const floorNow = () => floorById(floorId) || floorsAll()[0] || null;
  const roomsNow = (): any[] => { const f = floorNow(); return f ? ensure(f.floor, 'Rooms', []) : []; };
  const areasNow = (): any[] => { const f = floorNow(); return f ? ensure(f.floor, 'Areas', []) : []; };
  const openingsNow = (): any[] => { const f = floorNow(); return f ? ensure(f.floor, 'Openings', []) : []; };
  const shapeOf = (sel: Selection) => sel?.type === 'room' ? roomsNow().find(r => r.Id === sel.id)
    : sel?.type === 'area' ? areasNow().find(a => a.Id === sel.id) : null;
  const itemOf = (id: string) => itemsIn().find((p: any) => p.Id === id);
  const runOf = (id: string) => runsIn().find((r: any) => r.Id === id);
  const openingOf = (id: string) => openingsNow().find((o: any) => o.Id === id);
  const onFloor = (it: any, f: any) => it.Floor === f.Id || (!it.Floor && ensure(f, 'Rooms', []).some((r: any) => r.Id === it.Room));
  const itemsNow = () => { const f = floorNow()?.floor; return f ? itemsIn().filter((p: any) => onFloor(p, f)) : []; };
  const runsNow = () => { const f = floorNow()?.floor; return f ? runsIn().filter((r: any) => r.Floor === f.Id) : []; };
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
  const refLabel = (ref: string) => { const c = circuitOf(ref); return c ? circuitLabel(c) : ref; };
  const nodeLabel = (id: string) => live?.nodes.find(n => n.id === id)?.label || id;
  const kindName = (k: string) => PLAN_KINDS.find(x => x[0] === k)?.[1] || k;
  const itemName = (it: any) => it.Label || kindName(it.Kind || 'outlet');
  const units = () => live?.units || 'W';
  const fmt = (v: number | null | undefined) => v == null ? 'no data' : formatMeasure(units() === 'W' ? Math.round(v) : Math.round(v * 100) / 100, units());

  // Real sizes: drawing units per metre on this floor, and the unit system the GUI settings ask for.
  const sys = () => planUnitSystem(state.data?.Gui?.DistanceUnits, (globalThis as any).navigator?.language);
  const scale = () => Math.max(1, Number(floorNow()?.floor.Scale) || 100);
  const len = (unitsLong: number) => planFmtLen(unitsLong / scale(), sys());
  const areaText = (poly: Pt[]) => planFmtArea(Math.abs(planArea(poly)) / (scale() * scale()), sys());
  const toUnits = (text: string) => { const m = planParseLen(text, sys()); return m == null || m <= 0 ? null : m * scale(); };
  const lenInput = (unitsLong: number, onSet: (u: number) => void, placeholder = '') => {
    const i = el('input', { type: 'text', class: 'fp-len', value: unitsLong > 0 ? len(unitsLong) : '', placeholder: placeholder || (sys() === 'imperial' ? `12' 6"` : '3.75 m') }) as HTMLInputElement;
    i.onchange = () => {
      const u = toUnits(i.value);
      if (u == null) { i.classList.add('is-bad'); i.title = sys() === 'imperial' ? `Write it like 12' 6", 12 6 or 150"` : 'Write it like 3.75 m, 3 m 75 cm or 375 cm'; return; }
      i.classList.remove('is-bad');
      onSet(u);
    };
    return i;
  };

  // --- Undo and redo -------------------------------------------------------------------------------
  // Snapshots of everything the page edits; restored in place so every other page keeps its reference.
  const history = planHistory(() => flowIn(), v => { const cur = flowIn(); Object.keys(cur).forEach(k => delete cur[k]); Object.assign(cur, v); });
  const changed = () => { refreshDirty(); schedule(); };
  /// One undoable change: remember what was, make the change, redraw.
  const act = (fn: () => void) => { history.push(); fn(); changed(); render(); };
  const undo = () => { if (history.undo()) { cleanSelection(); changed(); render(); } };
  const redo = () => { if (history.redo()) { cleanSelection(); changed(); render(); } };
  const cleanSelection = () => {
    if (!selection) return;
    const gone = selection.type === 'item' ? !itemOf(selection.id) : selection.type === 'run' ? !runOf(selection.id)
      : selection.type === 'opening' ? !openingOf(selection.id) : !shapeOf(selection);
    if (gone) selection = null;
    selectedCorner = -1;
  };

  // --- Layout --------------------------------------------------------------------------------------
  const floorSel = el('select', { class: 'fp-floor', title: 'Which floor to show.' }) as HTMLSelectElement;
  floorSel.onchange = () => { floorId = floorSel.value; remember('floor', floorId); selection = null; draft = []; wireDraft = null; measure = null; viewFor = ''; render(); };
  const addBtn = btn('+ Floor');
  addBtn.title = 'Add a floor, or a new site with its first floor.';
  const floorBtn = btn('Floor settings');
  const bgBtn = btn('Background');
  bgBtn.title = 'Upload a floor plan image to draw over, set how strongly it shows, and set the scale.';
  const toolsBtn = btn('Tools…');
  const undoBtn = el('button', { class: 'small fp-icon-btn', type: 'button', title: 'Undo (Ctrl+Z)' }, fpToolIcon('undo'));
  undoBtn.setAttribute('aria-label', 'Undo');
  undoBtn.onclick = () => undo();
  const redoBtn = el('button', { class: 'small fp-icon-btn', type: 'button', title: 'Redo (Ctrl+Y)' }, fpToolIcon('redo'));
  redoBtn.setAttribute('aria-label', 'Redo');
  redoBtn.onclick = () => redo();
  const status = el('span', { class: 'ld-count fp-status' });
  sec.appendChild(el('div', { class: 'ld-toolbar fp-bar' }, el('label', { class: 'ld-inst' }, 'Floor ', floorSel), addBtn, floorBtn, bgBtn, toolsBtn,
    el('span', { class: 'fp-undo' }, undoBtn, redoBtn), status));

  const modeBar = el('div', { class: 'fp-seg', role: 'tablist' });
  const modeBtns: Record<string, any> = {};
  ([['view', 'View'], ['edit', 'Edit']] as const).forEach(([m, label]) => {
    const b = el('button', { class: 'fp-seg-btn', text: label, type: 'button' });
    b.setAttribute('role', 'tab');
    b.onclick = () => { mode = m; tool = 'select'; draft = []; rectStart = null; wireDraft = null; measure = null; selectedCorner = -1; render(); };
    modeBtns[m] = b;
    modeBar.appendChild(b);
  });
  const subBar = el('div', { class: 'fp-sub' });
  sec.appendChild(el('div', { class: 'fp-modes' }, modeBar, subBar));

  const palette = el('div', { class: 'fp-palette', role: 'toolbar' });
  palette.setAttribute('aria-label', 'Drawing tools');
  const toolBtns: Record<string, any> = {};
  FP_TOOLS.forEach(([t, name, key, what]) => {
    const b = el('button', { class: 'fp-tool', type: 'button', title: `${name} (${key}) — ${what}` }, fpToolIcon(t), el('span', { class: 'fp-tool-name', text: name }));
    b.setAttribute('aria-label', name);
    b.onclick = () => pickTool(t);
    toolBtns[t] = b;
    palette.appendChild(b);
  });
  const opts = el('div', { class: 'fp-opts' });

  const svg = svgEl('svg', { class: 'fp-svg', role: 'img' });
  const zoomIn = el('button', { class: 'fp-zbtn', text: '+', title: 'Zoom in (+)', type: 'button' });
  const zoomOut = el('button', { class: 'fp-zbtn', text: '−', title: 'Zoom out (−)', type: 'button' });
  const zoomFit = el('button', { class: 'fp-zbtn', text: '⤢', title: 'Fit the floor (0)', type: 'button' });
  const hint = el('div', { class: 'fp-hint' });
  const scaleBar = el('div', { class: 'fp-scalebar' }, el('span', { class: 'fp-scalebar-bar' }), el('span', { class: 'fp-scalebar-text' }));
  const empty = el('div', { class: 'fp-empty' });
  const stage = el('div', { class: 'fp-stage' }, svg, el('div', { class: 'fp-zoom' }, zoomIn, zoomOut, zoomFit), scaleBar, hint, empty);
  const side = el('aside', { class: 'fp-side' });
  const legend = el('div', { class: 'fp-legend' });
  const body = el('div', { class: 'fp-body' }, palette, el('div', { class: 'fp-main' }, opts, stage, legend), side);
  sec.appendChild(body);

  const pickTool = (t: Tool) => {
    if (mode !== 'edit') mode = 'edit';
    tool = t; draft = []; rectStart = null; rectEnd = null; wireDraft = null; measure = null; selectedCorner = -1;
    render();
  };

  // --- Coordinates ---------------------------------------------------------------------------------
  const floorSize = () => { const f = floorNow()?.floor; return { w: Number(f?.Width) || 1000, h: Number(f?.Height) || 700 }; };
  /// Plan units per screen pixel: what keeps handles, strokes and labels the same size on screen at any zoom.
  const upp = () => {
    const r = svg.getBoundingClientRect?.();
    if (!r || !r.width || !r.height) return vb.w / 1000;
    return Math.max(vb.w / r.width, vb.h / r.height);
  };
  const toPlan = (e: any): Pt => {
    const r = svg.getBoundingClientRect();
    const k = Math.min(r.width / vb.w, r.height / vb.h) || 1;
    const ox = (r.width - vb.w * k) / 2, oy = (r.height - vb.h * k) / 2;
    return { X: vb.x + (e.clientX - r.left - ox) / k, Y: vb.y + (e.clientY - r.top - oy) / k };
  };
  const fit = () => { const { w, h } = floorSize(); const pad = Math.max(w, h) * 0.03; vb = { x: -pad, y: -pad, w: w + pad * 2, h: h + pad * 2 }; };
  const zoomAt = (p: Pt, factor: number) => {
    const { w } = floorSize();
    const nw = Math.max(w * 0.02, Math.min(w * 4, vb.w / factor));
    const f = vb.w / nw;
    vb = { x: p.X - (p.X - vb.x) / f, y: p.Y - (p.Y - vb.y) / f, w: nw, h: vb.h / f };
    drawPlan();
  };
  const centre = () => ({ X: vb.x + vb.w / 2, Y: vb.y + vb.h / 2 });
  zoomIn.onclick = () => zoomAt(centre(), 1.4);
  zoomOut.onclick = () => zoomAt(centre(), 1 / 1.4);
  zoomFit.onclick = () => { fit(); drawPlan(); };

  const outlinesOf = (list: any[]) => list.filter(s => (s.Shape || []).length >= 3).map(s => s.Shape as Pt[]);
  const othersFor = (exclude: any) => outlinesOf([...roomsNow(), ...areasNow()].filter(s => s !== exclude));
  const snapStep = () => planSnapStep(sys()) * scale();
  const clampPt = (p: Pt) => { const { w, h } = floorSize(); return { X: planRound(Math.max(0, Math.min(w, p.X))), Y: planRound(Math.max(0, Math.min(h, p.Y))) }; };
  const snapped = (p: Pt, exclude: any = null) => {
    if (!snapOn) return clampPt(p);
    return clampPt(planSnap(p, othersFor(exclude), 12 * upp(), snapStep()).pt);
  };
  const gridSnapped = (p: Pt) => { if (!snapOn) return clampPt(p); const g = snapStep(); return clampPt({ X: Math.round(p.X / g) * g, Y: Math.round(p.Y / g) * g }); };
  /// Where an item actually is: its own point.
  const itemPt = (id: string): Pt | null => { const it = itemOf(id); return it ? { X: Number(it.X) || 0, Y: Number(it.Y) || 0 } : null; };
  /// A run's whole path: its start item, its bends, and its end item.
  const runPath = (r: any): Pt[] => {
    const pts: Pt[] = [];
    const a = r.From ? itemPt(r.From) : null;
    if (a) pts.push(a);
    (r.Points || []).forEach((p: Pt) => pts.push(p));
    const b = r.To ? itemPt(r.To) : null;
    if (b) pts.push(b);
    return pts;
  };
  /// Where a wall is for a door or window: near enough to one, on it and lying along it.
  const wallAt = (p: Pt) => {
    const w = planNearestWall(p, outlinesOf(roomsNow().filter(r => !r.Outdoor)));
    return w && w.dist <= Math.max(0.6 * scale(), 16 * upp()) ? w : null;
  };
  const openingWidth = (kind: string) => {
    const imp = sys() === 'imperial';
    const inch = 0.0254;
    const m = kind === 'window' ? (imp ? 36 * inch : 1.2) : kind === 'double-door' ? (imp ? 60 * inch : 1.5) : kind === 'sliding-door' ? (imp ? 72 * inch : 1.8)
      : kind === 'garage-door' ? (imp ? 108 * inch : 2.7) : (imp ? 36 * inch : 0.9);
    return planRound(m * scale());
  };
  /// The circuit a selection is about, so the plan can bring it forward and fade the rest.
  const focusCircuit = () => selection?.type === 'item' ? itemOf(selection.id)?.Circuit || ''
    : selection?.type === 'run' ? runOf(selection.id)?.Circuit || '' : '';

  // --- Drawing -------------------------------------------------------------------------------------
  const shadeOf = (v: number | null, max: number) => {
    if (v == null || max <= 0) return '';
    const t = Math.max(0, Math.min(1, v / max));
    return `color-mix(in srgb, var(--accent) ${Math.round(18 + t * 64)}%, transparent)`;
  };
  const points = (poly: Pt[]) => poly.map(q => `${q.X},${q.Y}`).join(' ');

  const drawPlan = () => {
    svg.innerHTML = '';
    const fl = floorNow();
    const { w, h } = floorSize();
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('aria-label', fl ? `Floor plan of ${fl.floor.Name || fl.floor.Id}` : 'No floor');
    svg.classList.toggle('is-editing', mode === 'edit' && tool !== 'select' && tool !== 'pan');
    svg.classList.toggle('is-panning', tool === 'pan' || mode === 'view');
    const u = upp();
    const s = scale();

    const defs = svgEl('defs');
    planTextures(s).forEach(p => defs.appendChild(p));
    // The grid is in real units: a foot or half a metre, with a heavier line every five feet or metre.
    const minor = planGridStep(sys()) * s, major = minor * (sys() === 'imperial' ? 5 : 2);
    const gp = svgEl('pattern', { id: 'fp-grid', width: major, height: major, patternUnits: 'userSpaceOnUse' });
    if (minor / u >= 7) for (let x = minor; x < major - 1e-6; x += minor) {
      gp.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: major, class: 'fp-gridline', 'stroke-width': u }));
      gp.appendChild(svgEl('line', { x1: 0, y1: x, x2: major, y2: x, class: 'fp-gridline', 'stroke-width': u }));
    }
    gp.appendChild(svgEl('path', { d: `M ${major} 0 L 0 0 0 ${major}`, class: 'fp-gridline is-major', 'stroke-width': u }));
    const hatch = svgEl('pattern', { id: 'fp-hatch', width: 10 * u, height: 10 * u, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.appendChild(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 10 * u, class: 'fp-hatchline', 'stroke-width': 1.5 * u }));
    defs.append(gp, hatch);
    svg.appendChild(defs);
    legend.innerHTML = '';
    if (!fl) { drawScaleBar(); return; }

    // Ground, then the plan image, then the grid while editing or where there is no image.
    const ground = fl.floor.Ground;
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, class: 'fp-paper' + (ground ? ' is-textured' : ''), fill: ground ? `url(#fp-tex-${ground})` : null }));
    const image = fl.floor.Image;
    if (image && imageFailed !== image) {
      const img = svgEl('image', { href: `/api/plans/images/${encodeURIComponent(image)}`, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'xMidYMid meet', class: 'fp-image', opacity: String(fl.floor.ImageOpacity ?? 0.85) });
      img.addEventListener('error', () => { imageFailed = image; drawPlan(); drawSide(); });
      svg.appendChild(img);
    }
    if (!image || imageFailed === image || mode === 'edit')
      svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, fill: 'url(#fp-grid)', class: 'fp-gridrect' }));
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, class: 'fp-edge', 'stroke-width': u }));

    const max = planScaleMax(roomsNow().map(r => placeOf(r.Id)?.value));
    const font = 13 * u;
    const focus = focusCircuit();
    const label = (poly: Pt[], lines: string[], cls: string) => {
      const c = planCentroid(poly);
      const t = svgEl('text', { x: c.X, y: c.Y - (lines.length - 1) * font * 0.6, class: cls, 'font-size': font });
      lines.forEach((ln, i) => { const sp = svgEl('tspan', { x: c.X, dy: i ? font * 1.2 : 0 }); sp.textContent = ln; t.appendChild(sp); });
      return t;
    };

    // Rooms and outdoor zones: surface first, then the live shading over it, then the walls.
    const rooms = roomsNow().filter(r => (r.Shape || []).length >= 3).sort((a, b) => Number(!!b.Outdoor) - Number(!!a.Outdoor));
    rooms.forEach(room => {
      const poly: Pt[] = room.Shape;
      if (room.Surface) svg.appendChild(svgEl('polygon', { points: points(poly), class: 'fp-surface', fill: `url(#fp-tex-${room.Surface})` }));
    });
    const labels: any[] = [];
    rooms.forEach(room => {
      const poly: Pt[] = room.Shape;
      const p = placeOf(room.Id);
      const st = p?.state || 'unmetered';
      const sel = selection?.type === 'room' && selection.id === room.Id;
      const shape = svgEl('polygon', {
        points: points(poly),
        class: `fp-room ${room.Outdoor ? 'is-outdoor' : 'is-indoor'} is-${mode === 'view' ? st : 'edit'}${room.Surface ? ' has-surface' : ''}${sel ? ' is-selected' : ''}`,
        'stroke-width': (room.Outdoor ? 1.5 : sel ? 5 : 4) * u,
      });
      if (room.Outdoor) shape.setAttribute('stroke-dasharray', `${7 * u} ${5 * u}`);
      if (mode === 'view' && st === 'known') shape.style.fill = shadeOf(p!.value, max);
      if (mode === 'view' && st === 'unmetered' && !room.Surface) shape.style.fill = 'url(#fp-hatch)';
      shape.dataset.room = room.Id;
      svg.appendChild(shape);
      const lines = [room.Name || room.Id];
      if (mode === 'view') lines.push(st === 'known' ? fmt(p!.value) : st === 'unknown' ? 'no data' : 'unmetered');
      if (showSizes || (mode === 'edit' && sel)) lines.push(areaText(poly));
      labels.push(label(poly, lines, 'fp-label' + (mode === 'view' ? ' is-' + st : '') + (room.Outdoor ? ' is-outdoor' : '')));
    });

    areasNow().forEach(area => {
      const poly: Pt[] = area.Shape || [];
      if (poly.length < 3) return;
      const sel = selection?.type === 'area' && selection.id === area.Id;
      const shape = svgEl('polygon', { points: points(poly), class: 'fp-area' + (sel ? ' is-selected' : ''), 'stroke-width': (sel ? 3 : 2) * u, 'stroke-dasharray': `${8 * u} ${5 * u}` });
      shape.dataset.area = area.Id;
      svg.appendChild(shape);
      labels.push(label(poly, [area.Name || area.Id], 'fp-label fp-area-label'));
    });

    // Doors and windows cut the walls they sit in.
    openingsNow().forEach(o => {
      const g = planOpening(o, u);
      if (selection?.type === 'opening' && selection.id === o.Id) g.classList.add('is-selected');
      svg.appendChild(g);
    });

    // Cable runs, in their circuit's colour. A selected circuit comes forward and the rest fade.
    if (showWiring || mode === 'edit') runsNow().forEach(r => {
      const path = runPath(r);
      if (path.length < 2) return;
      const sel = selection?.type === 'run' && selection.id === r.Id;
      const dim = focus && r.Circuit !== focus;
      const colour = r.Kind === 'circuit' ? planCircuitColor(r.Circuit) : r.Kind === 'service' ? 'var(--series-4)' : 'var(--fg)';
      const g = svgEl('g', { class: `fp-run is-${r.Kind || 'circuit'}${sel ? ' is-selected' : ''}${dim ? ' is-dim' : ''}${r.Circuit ? '' : ' is-unknown'}` });
      g.appendChild(svgEl('polyline', { points: points(path), class: 'fp-run-line', stroke: colour, 'stroke-width': (r.Kind === 'circuit' ? 2.5 : 4) * u * (sel ? 1.5 : 1), 'stroke-dasharray': r.Circuit || r.Kind !== 'circuit' ? null : `${6 * u} ${4 * u}` }));
      const hit = svgEl('polyline', { points: points(path), class: 'fp-hit fp-run-hit', 'stroke-width': 14 * u });
      hit.dataset.run = r.Id;
      g.appendChild(hit);
      svg.appendChild(g);
      if (sel && mode === 'edit') {
        (r.Points || []).forEach((q: Pt, i: number) => { const hd = svgEl('circle', { cx: q.X, cy: q.Y, r: 7 * u, class: 'fp-handle' }); hd.dataset.runpt = String(i); svg.appendChild(hd); });
        for (let i = 0; i + 1 < path.length; i++) {
          const m = svgEl('circle', { cx: (path[i].X + path[i + 1].X) / 2, cy: (path[i].Y + path[i + 1].Y) / 2, r: 5 * u, class: 'fp-mid' });
          m.dataset.runmid = String(i);
          svg.appendChild(m);
        }
      }
    });

    // Placed items keep their size on screen at any zoom. An item on an unknown circuit is ringed and marked.
    const r = 12 * u;
    itemsNow().forEach((item: any) => {
      const sel = selection?.type === 'item' && selection.id === item.Id;
      const supply = PLAN_SUPPLY_KINDS.includes(item.Kind);
      const known = supply || (!!item.Circuit && (live?.placements[item.Id]?.circuitKnown ?? true));
      const dim = focus && item.Circuit !== focus;
      const g = svgEl('g', { class: 'fp-item' + (sel ? ' is-selected' : '') + (known ? '' : ' is-unknown') + (supply ? ' is-supply' : '') + (dim ? ' is-dim' : ''), transform: `translate(${item.X},${item.Y})` });
      g.dataset.item = item.Id;
      const disc = svgEl('circle', { r, class: 'fp-item-disc', 'stroke-width': (sel ? 3 : 2) * u });
      if (item.Circuit && (showWiring || focus)) disc.style.stroke = planCircuitColor(item.Circuit);
      g.appendChild(disc);
      const glyph = planGlyph(item.Kind || 'outlet', r);
      glyph.setAttribute('stroke-width', 1.4 * u);
      g.appendChild(glyph);
      if (!known) {
        const badge = svgEl('text', { x: r * 0.85, y: -r * 0.6, class: 'fp-item-q', 'font-size': font * 0.9 });
        badge.textContent = '?';
        g.appendChild(badge);
      }
      if (item.Label && (sel || showSizes)) {
        const t = svgEl('text', { x: 0, y: r + font, class: 'fp-item-label', 'font-size': font * 0.85 });
        t.textContent = item.Label;
        g.appendChild(t);
      }
      const title = svgEl('title');
      title.textContent = `${itemName(item)}${item.Circuit ? ' — ' + refLabel(item.Circuit) : supply ? '' : ' — circuit unknown'}`;
      g.appendChild(title);
      svg.appendChild(g);
    });

    labels.forEach(t => svg.appendChild(t));

    // Wall lengths along the selected room's edges, or every room's when sizes are on.
    const dimsFor = rooms.filter(rm => showSizes || (mode === 'edit' && selection?.type === 'room' && selection.id === rm.Id));
    dimsFor.forEach(rm => {
      const poly: Pt[] = rm.Shape;
      const sign = planArea(poly) >= 0 ? 1 : -1;
      poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length];
        const L = Math.hypot(b.X - a.X, b.Y - a.Y);
        if (L / u < 40) return;
        const nx = -(b.Y - a.Y) / L * sign, ny = (b.X - a.X) / L * sign;
        let ang = Math.atan2(b.Y - a.Y, b.X - a.X) * 180 / Math.PI;
        if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
        const mx = (a.X + b.X) / 2 - nx * 11 * u, my = (a.Y + b.Y) / 2 - ny * 11 * u;
        const t = svgEl('text', { x: mx, y: my, class: 'fp-dim', 'font-size': font * 0.85, transform: `rotate(${ang} ${mx} ${my})` });
        t.textContent = len(L);
        svg.appendChild(t);
      });
    });

    // Editing handles: each corner, and a midpoint on each edge that adds a corner when dragged.
    const target = mode === 'edit' ? shapeOf(selection) : null;
    if (target && (target.Shape || []).length >= 3) {
      const poly: Pt[] = target.Shape;
      poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length];
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

    // What is being drawn right now, with its size.
    if (rectStart && rectEnd) {
      const poly = planRect(rectStart, rectEnd);
      svg.appendChild(svgEl('polygon', { points: points(poly), class: 'fp-draft', 'stroke-width': 2 * u }));
      const b = planBounds(poly);
      const t = svgEl('text', { x: b.x + b.w / 2, y: b.y + b.h / 2, class: 'fp-draft-size', 'font-size': font });
      t.textContent = `${len(b.w)} × ${len(b.h)}`;
      svg.appendChild(t);
    }
    if (draft.length) {
      const pts = hover ? [...draft, hover] : draft;
      svg.appendChild(svgEl('polyline', { points: points(pts), class: 'fp-draft', 'stroke-width': 2 * u }));
      draft.forEach((q, i) => svg.appendChild(svgEl('circle', { cx: q.X, cy: q.Y, r: (i === 0 ? 9 : 6) * u, class: 'fp-draft-pt' + (i === 0 ? ' is-first' : '') })));
    }
    if (wireDraft) {
      const start = wireDraft.from ? itemPt(wireDraft.from) : null;
      const pts = [...(start ? [start] : []), ...wireDraft.pts, ...(hover ? [hover] : [])];
      if (pts.length) {
        svg.appendChild(svgEl('polyline', { points: points(pts), class: 'fp-draft is-wire', 'stroke-width': 2.5 * u }));
        wireDraft.pts.forEach(q => svg.appendChild(svgEl('circle', { cx: q.X, cy: q.Y, r: 5 * u, class: 'fp-draft-pt' })));
      }
    }
    if (measure) {
      const b = measure.b || hover;
      if (b) {
        svg.appendChild(svgEl('line', { x1: measure.a.X, y1: measure.a.Y, x2: b.X, y2: b.Y, class: 'fp-measure', 'stroke-width': 2 * u }));
        const t = svgEl('text', { x: (measure.a.X + b.X) / 2, y: (measure.a.Y + b.Y) / 2 - 8 * u, class: 'fp-measure-text', 'font-size': font });
        t.textContent = len(Math.hypot(b.X - measure.a.X, b.Y - measure.a.Y));
        svg.appendChild(t);
      }
      [measure.a, ...(measure.b ? [measure.b] : [])].forEach(q => svg.appendChild(svgEl('circle', { cx: q.X, cy: q.Y, r: 5 * u, class: 'fp-measure-pt' })));
    }

    // The scale the shading is on, with what the unshaded rooms mean.
    if (mode === 'view' && rooms.length) {
      legend.append(
        el('span', { class: 'fp-key' }, el('span', { class: 'fp-swatch fp-grad' }), `0 – ${max > 0 ? fmt(max) : 'no readings yet'}`),
        el('span', { class: 'fp-key' }, el('span', { class: 'fp-swatch is-unmetered' }), 'unmetered'),
        el('span', { class: 'fp-key' }, el('span', { class: 'fp-swatch is-unknown' }), 'no data'));
    }
    drawScaleBar();
  };

  const drawScaleBar = () => {
    const u = upp();
    const bar = planScaleBar(90 * u / scale(), sys());
    const px = bar.m * scale() / u;
    (scaleBar.children[0] as any).style.width = `${Math.round(px)}px`;
    scaleBar.children[1].textContent = bar.label;
    scaleBar.hidden = !floorNow();
  };


  // --- Pointer handling ----------------------------------------------------------------------------
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: any = null;
  let pinch: { d: number; mid: Pt; vb: typeof vb } | null = null;

  /// What is under the pointer, found by walking up from the element it landed on.
  const hitOf = (e: any) => {
    for (let n = e.target; n && n !== svg; n = n.parentNode || n.parent) {
      const d = n.dataset || {};
      if (d.corner != null) return { corner: Number(d.corner) };
      if (d.mid != null) return { mid: Number(d.mid) };
      if (d.runpt != null) return { runpt: Number(d.runpt) };
      if (d.runmid != null) return { runmid: Number(d.runmid) };
      if (d.item) return { item: d.item as string };
      if (d.opening) return { opening: d.opening as string };
      if (d.run) return { run: d.run as string };
      if (d.area) return { area: d.area as string };
      if (d.room) return { room: d.room as string };
    }
    return {} as any;
  };
  const selectHit = (hit: any) => {
    selection = hit.item ? { type: 'item', id: hit.item } : hit.opening ? { type: 'opening', id: hit.opening } : hit.run ? { type: 'run', id: hit.run }
      : hit.room ? { type: 'room', id: hit.room } : hit.area ? { type: 'area', id: hit.area } : null;
    selectedCorner = -1;
  };

  svg.addEventListener('pointerdown', (e: any) => {
    if (e.button != null && e.button > 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { svg.setPointerCapture?.(e.pointerId); } catch { /* capture is a nicety */ }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mid: toPlan({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }), vb: { ...vb } };
      gesture = null;
      rectStart = null; rectEnd = null;
      return;
    }
    const p = toPlan(e);
    const hit = hitOf(e);
    gesture = { start: p, sx: e.clientX, sy: e.clientY, hit, moved: false, pushed: false, vb: { ...vb }, kind: 'pan' };

    if (mode === 'edit' && tool === 'select') {
      const target = shapeOf(selection);
      const run = selection?.type === 'run' ? runOf(selection.id) : null;
      if (hit.corner != null && target) { gesture.kind = 'corner'; gesture.index = hit.corner; selectedCorner = hit.corner; }
      else if (hit.mid != null && target) { gesture.kind = 'insert'; gesture.index = hit.mid; }
      else if (hit.runpt != null && run) { gesture.kind = 'runpt'; gesture.index = hit.runpt; }
      else if (hit.runmid != null && run) { gesture.kind = 'runinsert'; gesture.index = hit.runmid; }
      else if (hit.item) { selectHit(hit); gesture.kind = 'item'; const it = itemOf(hit.item); gesture.orig = { X: it.X, Y: it.Y }; }
      else if (hit.opening) { selectHit(hit); gesture.kind = 'opening'; const o = openingOf(hit.opening); gesture.orig = { X: o.X, Y: o.Y, Angle: o.Angle }; }
      else if (hit.run) { selectHit(hit); gesture.kind = 'none'; }
      else if (hit.room || hit.area) {
        selectHit(hit);
        const s = shapeOf(selection);
        gesture.kind = 'move';
        gesture.orig = (s?.Shape || []).map((q: Pt) => ({ ...q }));
        // A room carries what is in it and the doors and windows in its walls.
        if (selection!.type === 'room') {
          gesture.items = itemsIn().filter((it: any) => it.Room === s.Id).map((it: any) => ({ it, X: it.X, Y: it.Y }));
          const near = 0.2 * scale();
          gesture.openings = openingsNow().filter(o => { const w = planNearestWall({ X: o.X, Y: o.Y }, [s.Shape]); return w && w.dist <= near; }).map(o => ({ o, X: o.X, Y: o.Y }));
          gesture.runs = runsNow().filter(r => [r.From, r.To].some(id => gesture.items.some((x: any) => x.it.Id === id))).map(r => ({ r, pts: (r.Points || []).map((q: Pt) => ({ ...q })) }));
        }
      }
    } else if (mode === 'edit' && (tool === 'room' || tool === 'zone' || tool === 'area')) {
      gesture.kind = 'rect'; rectStart = snapped(p); rectEnd = rectStart;
    } else if (mode === 'edit' && tool !== 'pan') {
      gesture.kind = 'tap';
    }
    dragging = true;
    drawPlan();
  });

  svg.addEventListener('pointermove', (e: any) => {
    if (!pointers.has(e.pointerId)) {
      // Hovering: the next corner, bend or measuring point follows the pointer.
      if (draft.length || wireDraft || (measure && !measure.b)) { hover = tool === 'wire' ? gridSnapped(toPlan(e)) : snapped(toPlan(e)); drawPlan(); }
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const { w } = floorSize();
      const nw = Math.max(w * 0.02, Math.min(w * 4, pinch.vb.w / (d / pinch.d)));
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
    // A drag is one change: remembered once, as it starts.
    const begin = () => { if (!gesture.pushed) { history.push(); gesture.pushed = true; } };
    const { w, h } = floorSize();
    const k = gesture.kind;
    if (k === 'pan' || k === 'tap' || k === 'none') {
      if (k !== 'pan' && mode === 'edit' && tool !== 'pan') { gesture.kind = 'pan'; }
      const r = svg.getBoundingClientRect();
      const sc = Math.min(r.width / gesture.vb.w, r.height / gesture.vb.h) || 1;
      vb = { ...gesture.vb, x: gesture.vb.x - (e.clientX - gesture.sx) / sc, y: gesture.vb.y - (e.clientY - gesture.sy) / sc };
    } else if (k === 'insert') {
      begin();
      const s = shapeOf(selection);
      const poly: Pt[] = s.Shape;
      poly.splice(gesture.index + 1, 0, snapped(p, s));
      gesture.kind = 'corner'; gesture.index = gesture.index + 1; selectedCorner = gesture.index;
    } else if (k === 'corner') {
      begin();
      const s = shapeOf(selection);
      if (s) s.Shape[gesture.index] = snapped(p, s);
    } else if (k === 'move') {
      begin();
      const s = shapeOf(selection);
      if (s) {
        let dx = p.X - gesture.start.X, dy = p.Y - gesture.start.Y;
        // The first corner snaps and the rest follow, so a room slides into place against its neighbour.
        const first = gesture.orig[0];
        const want = snapped({ X: first.X + dx, Y: first.Y + dy }, s);
        dx = want.X - first.X; dy = want.Y - first.Y;
        s.Shape = planClamp(planMove(gesture.orig, dx, dy), w, h);
        (gesture.items || []).forEach((x: any) => { x.it.X = planRound(x.X + dx); x.it.Y = planRound(x.Y + dy); });
        (gesture.openings || []).forEach((x: any) => { x.o.X = planRound(x.X + dx); x.o.Y = planRound(x.Y + dy); });
        (gesture.runs || []).forEach((x: any) => { x.r.Points = planMove(x.pts, dx, dy).map((q: Pt) => ({ X: planRound(q.X), Y: planRound(q.Y) })); });
      }
    } else if (k === 'rect') {
      rectEnd = snapped(p);
    } else if (k === 'item') {
      begin();
      const it = itemOf(selection!.id);
      if (it) { const q = gridSnapped({ X: gesture.orig.X + p.X - gesture.start.X, Y: gesture.orig.Y + p.Y - gesture.start.Y }); it.X = q.X; it.Y = q.Y; }
    } else if (k === 'opening') {
      begin();
      const o = openingOf(selection!.id);
      const want = { X: gesture.orig.X + p.X - gesture.start.X, Y: gesture.orig.Y + p.Y - gesture.start.Y };
      const wall = wallAt(want);
      if (o) { const q = wall ? wall.pt : clampPt(want); o.X = planRound(q.X); o.Y = planRound(q.Y); if (wall) o.Angle = Math.round(wall.angle * 10) / 10; }
    } else if (k === 'runpt' || k === 'runinsert') {
      begin();
      const r = runOf(selection!.id);
      if (r) {
        const pts = ensure(r, 'Points', []);
        if (k === 'runinsert') {
          // Bends are stored between the ends; a midpoint before the first bend inserts at the front.
          const at = Math.max(0, Math.min(pts.length, gesture.index - (r.From ? 1 : 0) + 1));
          pts.splice(at, 0, gridSnapped(p));
          gesture.kind = 'runpt'; gesture.index = at;
        } else pts[gesture.index] = gridSnapped(p);
      }
    }
    drawPlan();
  });

  const endPointer = (e: any) => {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; if (!pointers.size) dragging = false; return; }
    const g = gesture;
    gesture = null;
    dragging = false;
    if (!g) return;
    const p = toPlan(e);
    const { w, h } = floorSize();

    if (!g.moved) {
      tap(g, p);
      return;
    }
    if (g.kind === 'rect' && rectStart && rectEnd) {
      const poly = planRect(rectStart, rectEnd);
      rectStart = null; rectEnd = null;
      if (Math.abs(planArea(poly)) > (0.3 * scale()) ** 2) finishOutline(poly);
      else render();
      return;
    }
    if (g.kind === 'corner' || g.kind === 'move') {
      const s = shapeOf(selection);
      if (s) s.Shape = planClamp(s.Shape, w, h);
    }
    if (g.kind === 'item') {
      const it = itemOf(selection!.id);
      // Where it lands is where it is: a room, an outdoor zone, or outdoors on this floor.
      const room = planShapeAt(roomsNow(), { X: it.X, Y: it.Y });
      if ((room?.Id || '') !== (it.Room || '')) { it.Room = room?.Id || ''; toast(room ? `Moved into ${room.Name || room.Id}.` : 'Moved outside every room: it is outdoors on this floor.', true); }
      it.Floor = floorNow()?.floor.Id || it.Floor;
    }
    if (g.pushed) changed();
    render();
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', (e: any) => { pointers.delete(e.pointerId); gesture = null; pinch = null; dragging = false; rectStart = null; rectEnd = null; drawPlan(); });
  svg.addEventListener('pointerleave', () => { if (hover) { hover = null; drawPlan(); } });
  svg.addEventListener('dblclick', () => { if (wireDraft) finishWire(''); else if (draft.length >= 3) finishOutline(draft); });
  svg.addEventListener('wheel', (e: any) => {
    // Ctrl/⌘ + wheel zooms (a trackpad pinch arrives this way too); a plain wheel scrolls the page past the plan.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomAt(toPlan(e), e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  /// A tap, by tool.
  const tap = (g: any, p: Pt) => {
    const hit = g.hit;
    if (mode === 'view' || tool === 'select' || tool === 'pan') {
      if (tool !== 'pan') selectHit(hit);
      render();
      return;
    }
    if (tool === 'outline') {
      const q = snapped(p);
      const first = draft[0];
      if (first && draft.length >= 3 && Math.hypot(q.X - first.X, q.Y - first.Y) <= 14 * upp()) finishOutline(draft);
      else { draft.push(q); render(); }
      return;
    }
    if (tool === 'room' || tool === 'zone' || tool === 'area') { rectStart = null; rectEnd = null; render(); return; }
    if (tool === 'item') {
      if (hit.item) { selectHit(hit); render(); return; }
      const q = gridSnapped(p);
      const room = planShapeAt(roomsNow(), q);
      const id = freshIn(itemsIn(), itemKind.replace(/-/g, '_'));
      act(() => {
        itemsIn().push({ Id: id, Kind: itemKind, Label: '', Room: room?.Id || '', Floor: floorNow()!.floor.Id, X: q.X, Y: q.Y, Circuit: '', Node: '' });
        selection = { type: 'item', id };
      });
      if (!room && !PLAN_SUPPLY_KINDS.includes(itemKind)) toast('Placed outdoors — outside every room. That is fine for an exterior light or a yard outlet.', true);
      return;
    }
    if (tool === 'door' || tool === 'window') {
      const kind = tool === 'window' ? 'window' : doorKind;
      const wall = wallAt(p);
      const q = wall ? wall.pt : clampPt(p);
      const id = freshIn(openingsNow(), kind.replace(/-/g, '_'));
      act(() => {
        openingsNow().push({ Id: id, Kind: kind, X: planRound(q.X), Y: planRound(q.Y), Angle: wall ? Math.round(wall.angle * 10) / 10 : 0, Width: openingWidth(kind), Swing: 'left', Flip: false });
        selection = { type: 'opening', id };
      });
      if (!wall) toast('No wall there, so it was placed where you tapped. Drag it onto a wall and it lines up.', false);
      return;
    }
    if (tool === 'wire') {
      if (!wireDraft) {
        wireDraft = hit.item ? { from: hit.item, pts: [] } : { from: '', pts: [gridSnapped(p)] };
        render();
        return;
      }
      if (hit.item && hit.item !== wireDraft.from) { finishWire(hit.item); return; }
      wireDraft.pts.push(gridSnapped(p));
      render();
      return;
    }
    if (tool === 'measure') {
      const q = snapped(p);
      if (!measure || measure.b) measure = { a: q, b: null };
      else measure.b = q;
      render();
    }
  };

  /// A drawn outline becomes the selected room or area when it has none yet, and a new one otherwise.
  const finishOutline = (poly: Pt[]) => {
    const { w, h } = floorSize();
    const shape = planClamp(poly, w, h);
    draft = []; hover = null;
    const kind = tool === 'area' ? 'area' : 'room';
    const outdoor = tool === 'zone';
    const target = shapeOf(selection);
    act(() => {
      if (target && (target.Shape || []).length < 3 && selection!.type === kind) { target.Shape = shape; return; }
      if (kind === 'area') {
        const name = `Area ${areasNow().length + 1}`;
        const id = freshId(name);
        // An area drawn over rooms takes them in.
        const rooms = roomsNow().filter(r => (r.Shape || []).length >= 3 && planContains(shape, planCentroid(r.Shape))).map(r => r.Id);
        areasNow().push({ Id: id, Name: name, Rooms: rooms, Shape: shape });
        selection = { type: 'area', id };
        return;
      }
      const name = outdoor ? `Yard ${roomsNow().filter(r => r.Outdoor).length + 1}` : `Room ${roomsNow().filter(r => !r.Outdoor).length + 1}`;
      const id = freshId(name);
      roomsNow().push({ Id: id, Name: name, Shape: shape, Outdoor: outdoor, Surface: outdoor ? 'grass' : '' });
      selection = { type: 'room', id };
      // Items already dropped inside it are now in it.
      itemsNow().forEach((it: any) => { if (!it.Room && planContains(shape, { X: it.X, Y: it.Y })) it.Room = id; });
    });
    tool = 'select';
    render();
    // Straight to its name: nobody wants to live with "Room 4".
    setTimeout(() => (side.querySelector?.('.fp-name') as any)?.focus?.(), 0);
  };

  /// A wire drawn between two items, or out to a bare point. Its circuit comes from whichever end knows one.
  const finishWire = (to: string) => {
    const d = wireDraft;
    wireDraft = null; hover = null;
    if (!d) return;
    const pathLen = (d.from ? 1 : 0) + d.pts.length + (to ? 1 : 0);
    if (pathLen < 2) { render(); return; }
    const from = d.from ? itemOf(d.from) : null, end = to ? itemOf(to) : null;
    const circuit = from?.Circuit || end?.Circuit || '';
    const id = freshIn(runsIn(), 'run');
    let adopted = '';
    act(() => {
      runsIn().push({ Id: id, Kind: wireKind, Floor: floorNow()!.floor.Id, Circuit: wireKind === 'circuit' ? circuit : '', From: d.from, To: to, Points: d.pts, Label: '' });
      // Wiring an item to one on a known circuit puts it on that circuit — said, and undoable.
      if (wireKind === 'circuit' && circuit) [from, end].forEach(it => { if (it && !it.Circuit && !PLAN_SUPPLY_KINDS.includes(it.Kind)) { it.Circuit = circuit; adopted = itemName(it); } });
      selection = { type: 'run', id };
    });
    if (adopted) toast(`${adopted} is wired to ${refLabel(circuit)}, so it is now on that circuit. Ctrl+Z undoes it.`, true);
  };

  // --- Tool options --------------------------------------------------------------------------------
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
  const check = (label: string, on: boolean, set: (v: boolean) => void, title = '') => {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = on;
    cb.onchange = () => set(cb.checked);
    return el('label', { class: 'ld-inst fp-check', title }, cb, ' ' + label);
  };

  const drawSub = () => {
    subBar.innerHTML = '';
    Object.entries(modeBtns).forEach(([m, b]) => { b.classList.toggle('is-on', m === mode); b.setAttribute('aria-selected', String(m === mode)); });
    if (mode === 'view') {
      subBar.appendChild(seg([['now', 'Power now'], ['today', 'Today'], ['week', 'This week']], period, v => { period = v; remember('period', v); load(); },
        'Shade by what each room is drawing now, or by the energy it has used over a period.'));
    }
    subBar.appendChild(check('Wiring', showWiring, v => { showWiring = v; remember('wiring', v ? '1' : '0'); drawPlan(); }, 'Show cable runs, and ring each item in its circuit’s colour.'));
    subBar.appendChild(check('Sizes', showSizes, v => { showSizes = v; remember('sizes', v ? '1' : '0'); drawPlan(); }, 'Show every wall’s length and each room’s floor area.'));
    if (mode === 'edit') subBar.appendChild(check('Snap', snapOn, v => { snapOn = v; remember('snap', v ? '1' : '0'); }, 'Corners snap to other rooms’ corners and edges, and everything to a fine grid.'));

    palette.hidden = mode !== 'edit';
    body.classList.toggle('is-editing', mode === 'edit');
    Object.entries(toolBtns).forEach(([t, b]) => { b.classList.toggle('is-on', mode === 'edit' && t === tool); b.setAttribute('aria-pressed', String(mode === 'edit' && t === tool)); });
    undoBtn.disabled = !history.canUndo();
    redoBtn.disabled = !history.canRedo();

    opts.innerHTML = '';
    opts.hidden = mode !== 'edit';
    if (mode === 'edit') drawOpts();
    const how = mode === 'view' ? 'Tap a room or item for its detail. Drag to pan, pinch or Ctrl+wheel to zoom.'
      : FP_TOOLS.find(t => t[0] === tool)?.[3] || '';
    hint.textContent = how;
    hint.hidden = !how || (mode === 'view' && !!selection);
  };

  const drawOpts = () => {
    const add = (...n: any[]) => n.forEach(x => opts.appendChild(x));
    if (tool === 'room' || tool === 'zone') {
      const bySize = btn(tool === 'zone' ? 'Add an outdoor zone by size…' : 'Add a room by size…', 'primary');
      bySize.onclick = () => roomBySize(tool === 'zone');
      add(bySize, el('span', { class: 'fp-opts-note', text: 'or drag across the plan.' }));
    } else if (tool === 'outline') {
      if (draft.length) {
        const done = btn('Finish outline', 'primary');
        done.disabled = draft.length < 3;
        done.onclick = () => finishOutline(draft);
        const back = btn('Undo point');
        back.onclick = () => { draft.pop(); render(); };
        const cancel = btn('Cancel');
        cancel.onclick = () => { draft = []; render(); };
        add(done, back, cancel, el('span', { class: 'fp-opts-note', text: `${draft.length} corner${draft.length === 1 ? '' : 's'}` }));
      } else add(el('span', { class: 'fp-opts-note', text: 'Tap the first corner. Double-tap or tap the first corner again to close.' }));
    } else if (tool === 'door') {
      add(seg(PLAN_OPENINGS.filter(o => o[0] !== 'window'), doorKind, v => { doorKind = v; render(); }));
    } else if (tool === 'item') {
      const grid = el('div', { class: 'fp-kinds' });
      ['Inside', 'Power'].forEach(group => {
        grid.appendChild(el('span', { class: 'fp-kinds-group', text: group === 'Inside' ? 'Loads' : 'Supply & utility' }));
        PLAN_KINDS.filter(k => k[2] === group).forEach(([k, label]) => {
          const b = el('button', { class: 'fp-kind' + (itemKind === k ? ' is-on' : ''), type: 'button', title: label });
          const icon = svgEl('svg', { viewBox: '-13 -13 26 26', class: 'fp-kind-icon' });
          icon.appendChild(svgEl('circle', { r: 12, class: 'fp-item-disc' }));
          const gl = planGlyph(k, 12); gl.setAttribute('stroke-width', '1.4'); icon.appendChild(gl);
          b.append(icon, el('span', { text: label }));
          b.setAttribute('aria-pressed', String(itemKind === k));
          b.setAttribute('aria-label', label);
          b.onclick = () => { itemKind = k; remember('kind', k); render(); };
          grid.appendChild(b);
        });
      });
      add(grid);
    } else if (tool === 'wire') {
      add(seg([['circuit', 'Circuit'], ['feeder', 'Feeder'], ['service', 'Service']], wireKind, v => { wireKind = v; render(); },
        'A branch circuit, a feeder between panels, or the utility service from the pole.'));
      if (wireDraft) {
        const done = btn('Finish here', 'primary');
        done.disabled = (wireDraft.from ? 1 : 0) + wireDraft.pts.length < 2;
        done.onclick = () => finishWire('');
        const cancel = btn('Cancel');
        cancel.onclick = () => { wireDraft = null; render(); };
        add(done, cancel, el('span', { class: 'fp-opts-note', text: 'Tap bends, then the item it ends at.' }));
      }
    } else if (tool === 'measure') {
      if (measure?.b) {
        const d = Math.hypot(measure.b.X - measure.a.X, measure.b.Y - measure.a.Y);
        const real = el('input', { type: 'text', class: 'fp-len', placeholder: sys() === 'imperial' ? `e.g. 12' 6"` : 'e.g. 3.75 m' }) as HTMLInputElement;
        const set = btn('Set scale', 'primary');
        set.title = 'Make the plan’s scale such that this line is the length you typed. Rooms keep their outlines; their sizes change.';
        set.onclick = () => {
          const m = planParseLen(real.value, sys());
          if (!m || m <= 0 || d <= 0) { real.classList.add('is-bad'); return; }
          act(() => { floorNow()!.floor.Scale = Math.round((d / m) * 1000) / 1000; });
          measure = null;
          toast(`Scale set: that line is ${planFmtLen(m, sys())}. Every size on this floor now reads in real units.`, true);
        };
        add(el('span', { class: 'fp-measure-read', text: len(d) }), el('span', { class: 'fp-opts-note', text: 'It is really' }), real, set);
      } else add(el('span', { class: 'fp-opts-note', text: measure ? 'Tap the second point.' : 'Tap the first point.' }));
    } else if (tool === 'select') {
      add(el('span', { class: 'fp-opts-note', text: 'Drag to move. Arrow keys nudge; Delete removes; Ctrl+Z undoes.' }));
    } else {
      add(el('span', { class: 'fp-opts-note', text: FP_TOOLS.find(t => t[0] === tool)?.[3] || '' }));
    }
  };

  const roomBySize = (outdoor: boolean) => {
    const body = el('div', { class: 'fp-sheet' });
    const name = el('input', { type: 'text', placeholder: outdoor ? 'Back yard' : 'Kitchen' }) as HTMLInputElement;
    let wU = 0, hU = 0;
    const wIn = lenInput(0, u => { wU = u; }), hIn = lenInput(0, u => { hU = u; });
    const surface = el('select', {}) as HTMLSelectElement;
    PLAN_SURFACES.forEach(([v, l]) => surface.appendChild(el('option', { value: v, text: l })));
    surface.value = outdoor ? 'grass' : '';
    body.append(field('Name', name), el('div', { class: 'fp-two' }, field('Width', wIn, 'Inside wall to inside wall.'), field('Depth', hIn)), field('Surface', surface),
      el('div', { class: 'desc', text: 'It is placed in the middle of the view; drag it where it goes. Sizes are in ' + (sys() === 'imperial' ? 'feet and inches' : 'metres') + ' — change that under GUI › Distance units.' }));
    const add = btn(outdoor ? 'Add zone' : 'Add room', 'primary');
    add.onclick = () => {
      wIn.onchange?.(null as any); hIn.onchange?.(null as any);
      if (!wU || !hU) { toast('Give it a width and a depth.', false); return; }
      const c = snapped(centre());
      const shape = planClamp(planRect({ X: c.X - wU / 2, Y: c.Y - hU / 2 }, { X: c.X + wU / 2, Y: c.Y + hU / 2 }), floorSize().w, floorSize().h);
      const nm = name.value.trim() || (outdoor ? 'Yard' : `Room ${roomsNow().length + 1}`);
      const id = freshId(nm);
      act(() => { roomsNow().push({ Id: id, Name: nm, Shape: shape, Outdoor: outdoor, Surface: surface.value }); selection = { type: 'room', id }; tool = 'select'; });
      closeSheet();
    };
    openSheet({ title: outdoor ? 'Add an outdoor zone' : 'Add a room', body, footer: [add] });
    setTimeout(() => name.focus?.(), 0);
  };


  // --- Side panel ----------------------------------------------------------------------------------
  const row = (label: string, value: any, cls = '') => el('div', { class: 'fp-row ' + cls }, el('span', { class: 'fp-row-k', text: label }), typeof value === 'string' ? el('span', { class: 'fp-row-v', text: value }) : value);
  const field = (label: string, input: any, hintText = '') => el('label', { class: 'fp-field' }, el('span', { class: 'fp-field-k', text: label }), input, ...(hintText ? [el('span', { class: 'fp-field-hint', text: hintText })] : []));
  const select = (choices: [string, string][], value: string, onPick: (v: string) => void) => {
    const s = el('select', {}) as HTMLSelectElement;
    choices.forEach(([v, t]) => s.appendChild(el('option', { value: v, text: t })));
    s.value = value;
    s.onchange = () => onPick(s.value);
    return s;
  };
  const valueLine = (p: Place | null) => {
    if (!p) return el('div', { class: 'fp-big is-unmetered', text: 'unmetered' });
    const box = el('div', {});
    box.appendChild(el('div', { class: 'fp-big is-' + p.state, text: p.state === 'known' ? fmt(p.value) : p.state === 'unknown' ? 'no data' : 'unmetered' }));
    if (p.state !== 'known') box.appendChild(el('div', { class: 'desc', text: FP_STATE_TEXT[p.state] || '' }));
    if (p.missing.length) box.appendChild(el('div', { class: 'desc', text: 'Waiting on: ' + p.missing.map(m => m.label).join(', ') }));
    if (p.split.length) box.appendChild(el('div', { class: 'desc', text: 'Fed from inside and outside this place, so its share cannot be told: ' + p.split.map(m => m.label).join(', ') }));
    return box;
  };
  const actions = (...b: any[]) => el('div', { class: 'fp-actions' }, ...b);
  const listRow = (name: string, val: string, onclick: (() => void) | null, valCls = '') => {
    const kids = [el('span', { class: 'fp-list-name', text: name }), el('span', { class: 'fp-list-val ' + valCls, text: val })];
    const b = onclick ? el('button', { class: 'fp-list-row', type: 'button' }, ...kids) : el('div', { class: 'fp-list-row is-static' }, ...kids);
    if (onclick) b.onclick = onclick;
    return b;
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
  const areaTakesIn = (areaId: string, roomId: string) => areasNow().some(a => a.Id === areaId && (a.Rooms || []).includes(roomId));

  const circuitRow = (c: Circuit) => {
    const b = el('button', { class: 'fp-list-row', type: 'button' },
      el('span', { class: 'fp-swatch-dot', style: { background: planCircuitColor(c.ref) } }),
      el('span', { class: 'fp-list-name', text: circuitLabel(c) }),
      el('span', { class: 'fp-list-val' + (c.power == null ? ' is-nodata' : ''), text: c.power == null ? 'no data' : formatMeasure(Math.round(c.power), 'W') }));
    if (c.exceeded) b.appendChild(el('span', { class: 'fp-flag', text: 'devices read more than the circuit', title: 'A device is on a different circuit than recorded, or a CT is on the wrong wire.' }));
    b.onclick = () => openCircuit(c);
    return b;
  };
  const circuitChoices = (): [string, string][] => [['', '— not known yet —'], ...(live?.circuits || []).map(c => [c.ref, circuitLabel(c)] as [string, string])];

  const drawSide = () => {
    side.innerHTML = '';
    const fl = floorNow();
    if (!fl) {
      side.appendChild(el('h3', { text: 'Start with a floor' }));
      side.appendChild(el('div', { class: 'desc', text: 'Add a site and its first floor, then draw its rooms or upload its plan. Rooms from your Version 2.0 room tags can be brought in under Tools.' }));
      const start = btn('Add a site and floor', 'primary');
      start.onclick = () => addSheet();
      side.appendChild(start);
      return;
    }
    if (imageFailed && imageFailed === fl.floor.Image)
      side.appendChild(el('div', { class: 'fp-note is-warn', text: 'This floor’s plan image could not be loaded, so it is drawn on a grid. Upload it again under Background.' }));
    (live?.problems || []).forEach(pr => side.appendChild(el('div', { class: 'fp-note is-warn', text: pr })));
    if (live?.message) side.appendChild(el('div', { class: 'fp-note', text: live.message }));
    if (selection) {
      const back = el('button', { class: 'fp-back', type: 'button', text: '‹ All rooms' });
      back.onclick = () => { selection = null; selectedCorner = -1; render(); };
      side.appendChild(back);
    }
    const editing = mode === 'edit';
    if (selection?.type === 'item') return drawItem(itemOf(selection.id), editing);
    if (selection?.type === 'opening') return drawOpening(openingOf(selection.id), editing);
    if (selection?.type === 'run') return drawRun(runOf(selection.id), editing);
    if (selection && shapeOf(selection)) return drawShape(selection.type as 'room' | 'area', shapeOf(selection), editing);
    drawFloorSummary(fl);
  };

  const drawFloorSummary = (fl: any) => {
    const fp = placeOf(fl.floor.Id), sp = placeOf(fl.site.Id);
    side.appendChild(el('h3', { text: fl.floor.Name || fl.floor.Id }));
    const { w, h } = floorSize();
    side.appendChild(el('div', { class: 'fp-id', text: `${len(w)} × ${len(h)} plot · ${fl.site.Name || fl.site.Id}` }));
    side.appendChild(valueLine(fp));
    if (sp) side.appendChild(row(fl.site.Name || fl.site.Id, sp.state === 'known' ? fmt(sp.value) : sp.state === 'unknown' ? 'no data' : 'unmetered'));
    const list = el('div', { class: 'fp-list' });
    const undrawn: any[] = [];
    [...roomsNow().map(r => [r.Outdoor ? 'zone' : 'room', r]), ...areasNow().map(a => ['area', a])].forEach(([type, s]: any) => {
      if ((s.Shape || []).length < 3 && type !== 'area') undrawn.push(s);
      const p = placeOf(s.Id);
      list.appendChild(listRow((s.Name || s.Id) + (type === 'area' ? ' (area)' : type === 'zone' ? ' (outdoor)' : ''),
        p?.state === 'known' ? fmt(p.value) : p?.state === 'unknown' ? 'no data' : 'unmetered',
        () => { selection = { type: type === 'area' ? 'area' : 'room', id: s.Id }; render(); }, 'is-' + (p?.state || 'unmetered')));
    });
    side.appendChild(el('h4', { text: 'Rooms and areas' }));
    side.appendChild(list.children.length ? list : el('div', { class: 'desc', text: 'No rooms yet. Choose Edit, then Room, and drag one out — or add one by its measurements.' }));
    if (undrawn.length) side.appendChild(el('div', { class: 'desc', text: `${undrawn.length} room${undrawn.length > 1 ? 's have' : ' has'} no outline yet: select one, then draw it.` }));
    const outside = itemsNow().filter((it: any) => !it.Room);
    if (outside.length) {
      side.appendChild(el('h4', { text: 'Outdoors' }));
      const ol = el('div', { class: 'fp-list' });
      outside.forEach((it: any) => ol.appendChild(listRow(itemName(it), it.Circuit ? refLabel(it.Circuit) : PLAN_SUPPLY_KINDS.includes(it.Kind) ? kindName(it.Kind) : 'circuit unknown',
        () => { selection = { type: 'item', id: it.Id }; render(); })));
      side.appendChild(ol);
    }
  };

  const drawShape = (type: 'room' | 'area', s: any, editing: boolean) => {
    const p = placeOf(s.Id);
    const name = el('input', { type: 'text', class: 'fp-name', value: s.Name || '' }) as HTMLInputElement;
    name.placeholder = type === 'room' ? 'Kitchen' : 'Upstairs';
    name.onchange = () => act(() => { s.Name = name.value.trim() || s.Id; });
    side.appendChild(el('div', { class: 'fp-side-head' }, editing ? name : el('h3', { text: s.Name || s.Id }), el('span', { class: 'fp-pill', text: type === 'area' ? 'area' : s.Outdoor ? 'outdoor' : 'room' })));
    side.appendChild(el('div', { class: 'fp-id', text: s.Id }));
    side.appendChild(valueLine(p));

    const poly: Pt[] = s.Shape || [];
    if (poly.length >= 3) {
      side.appendChild(el('h4', { text: 'Size' }));
      side.appendChild(row('Floor area', areaText(poly)));
      if (editing && type === 'room' && planIsBox(poly)) {
        // A rectangle is sized by its inside measurements; its top-left corner stays put.
        const b = planBounds(poly);
        const setBox = (w: number, h: number) => act(() => { s.Shape = planClamp(planRect({ X: b.x, Y: b.y }, { X: b.x + w, Y: b.y + h }), floorSize().w, floorSize().h); });
        side.appendChild(el('div', { class: 'fp-two' }, field('Width', lenInput(b.w, w => setBox(w, b.h))), field('Depth', lenInput(b.h, h => setBox(b.w, h)))));
      } else if (editing) {
        // Any other outline is sized wall by wall: changing a wall's length moves the corner at its far end.
        const walls = el('div', { class: 'fp-walls' });
        poly.forEach((a, i) => {
          const bpt = poly[(i + 1) % poly.length];
          const L = Math.hypot(bpt.X - a.X, bpt.Y - a.Y);
          walls.appendChild(field(`Wall ${i + 1}`, lenInput(L, want => act(() => {
            if (!L) return;
            const k = want / L;
            s.Shape[(i + 1) % poly.length] = { X: planRound(a.X + (bpt.X - a.X) * k), Y: planRound(a.Y + (bpt.Y - a.Y) * k) };
          }))));
        });
        side.appendChild(walls);
      } else {
        poly.forEach((a, i) => { const bpt = poly[(i + 1) % poly.length]; side.appendChild(row(`Wall ${i + 1}`, len(Math.hypot(bpt.X - a.X, bpt.Y - a.Y)))); });
      }
    }

    if (editing && type === 'room') {
      side.appendChild(el('div', { class: 'fp-two' },
        field('Kind', select([['room', 'Room'], ['outdoor', 'Outdoor zone']], s.Outdoor ? 'outdoor' : 'room', v => act(() => { s.Outdoor = v === 'outdoor'; if (s.Outdoor && !s.Surface) s.Surface = 'grass'; }))),
        field('Surface', select(PLAN_SURFACES, s.Surface || '', v => act(() => { s.Surface = v; })))));
    }
    if (type === 'area') {
      const box = el('div', { class: 'fp-checks' });
      roomsNow().forEach(r => {
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = (s.Rooms || []).includes(r.Id);
        cb.disabled = !editing;
        cb.onchange = () => act(() => { const list = ensure(s, 'Rooms', []); const at = list.indexOf(r.Id); if (cb.checked && at < 0) list.push(r.Id); if (!cb.checked && at >= 0) list.splice(at, 1); });
        box.appendChild(el('label', { class: 'ld-inst' }, cb, ' ' + (r.Name || r.Id)));
      });
      side.appendChild(el('h4', { text: 'Takes in' }));
      side.appendChild(box.children.length ? box : el('div', { class: 'desc', text: 'No rooms on this floor yet.' }));
    }

    const circuits = circuitsFor(s.Id);
    side.appendChild(el('h4', { text: 'Circuits serving it' }));
    const cl = el('div', { class: 'fp-list' });
    circuits.forEach(c => cl.appendChild(circuitRow(c)));
    side.appendChild(circuits.length ? cl : el('div', { class: 'desc', text: 'No circuit is recorded as serving it. Tick the rooms a breaker serves from its circuit, or link what is placed here to a circuit.' }));

    const items = itemsIn().filter((it: any) => it.Room === s.Id || (type === 'area' && (s.Rooms || []).includes(it.Room)));
    const metered = (live?.nodes || []).filter(n => n.placed === s.Id && !items.some((it: any) => it.Node === n.id));
    side.appendChild(el('h4', { text: 'In it' }));
    const il = el('div', { class: 'fp-list' });
    items.forEach((it: any) => {
      const v = live?.placements[it.Id]?.value;
      il.appendChild(listRow(itemName(it), it.Node ? fmt(v) : it.Circuit ? refLabel(it.Circuit) : 'circuit unknown',
        () => { selection = { type: 'item', id: it.Id }; render(); }, it.Node && v == null ? 'is-nodata' : ''));
    });
    metered.forEach(n => il.appendChild(listRow(n.label, fmt(n.value), null)));
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
      const redraw = btn(poly.length >= 3 ? 'Redraw outline' : 'Draw outline', poly.length >= 3 ? '' : 'primary');
      redraw.onclick = () => {
        if (poly.length >= 3 && !confirm('Draw a new outline for it? The current one is replaced.')) return;
        act(() => { s.Shape = []; });
        tool = type === 'area' ? 'area' : s.Outdoor ? 'zone' : 'room';
        render();
      };
      const btns = [redraw];
      if (selectedCorner >= 0 && poly.length > 3) {
        const dropCorner = btn('Remove corner');
        dropCorner.onclick = () => act(() => { s.Shape.splice(selectedCorner, 1); selectedCorner = -1; });
        btns.push(dropCorner);
      }
      const del = btn('Delete', 'danger');
      del.onclick = () => deleteSelection();
      btns.push(del);
      side.appendChild(actions(...btns));
    }
  };

  const drawItem = (it: any, editing: boolean) => {
    if (!it) { selection = null; return drawSide(); }
    const supply = PLAN_SUPPLY_KINDS.includes(it.Kind);
    side.appendChild(el('div', { class: 'fp-side-head' }, el('h3', { text: itemName(it) }), el('span', { class: 'fp-pill', text: kindName(it.Kind) })));
    const where = it.Room ? nameOfPlace(it.Room) : 'Outdoors';
    if (editing) {
      const lbl = el('input', { type: 'text', class: 'fp-name', value: it.Label || '', placeholder: 'e.g. Fridge, Porch light, Desk outlet' }) as HTMLInputElement;
      lbl.onchange = () => act(() => { it.Label = lbl.value.trim(); });
      const rooms: [string, string][] = [['', 'Outdoors / not in a room'], ...roomsNow().map(r => [r.Id, (r.Name || r.Id) + (r.Outdoor ? ' (outdoor)' : '')] as [string, string])];
      side.append(field('Label', lbl),
        el('div', { class: 'fp-two' },
          field('Kind', select(PLAN_KINDS.map(k => [k[0], k[1]] as [string, string]), it.Kind || 'outlet', v => act(() => { it.Kind = v; }))),
          field('Where', select(rooms, it.Room || '', v => act(() => { it.Room = v; it.Floor = floorNow()!.floor.Id; })))));
      if (it.Kind === 'panel') {
        const panels: [string, string][] = [['', '— which panel? —'], ...ensure(flowIn(), 'Panels', []).map((p: any) => [p.Id, p.Name || p.Id] as [string, string])];
        side.appendChild(field('Panel', select(panels, it.Panel || '', v => act(() => { it.Panel = v; })), 'The panel in the Panel Schedule this is. Wires drawn from it can carry its circuits.'));
      }
      if (!supply || it.Kind === 'panel') {
        const circuits = circuitChoices();
        if (it.Circuit && !circuits.some(([v]) => v === it.Circuit)) circuits.push([it.Circuit, `${it.Circuit} (not in any panel)`]);
        side.appendChild(field(it.Kind === 'panel' ? 'Fed from' : 'Circuit', select(circuits, it.Circuit || '', v => { act(() => { it.Circuit = v; }); offerBeneath(it); }),
          it.Kind === 'panel' ? 'For a subpanel: the breaker feeding it.' : 'The breaker feeding it. Unknown is fine — trace it below, or wire it to something on a known circuit.'));
      }
      const nodes: [string, string][] = [['', '— not individually metered —'], ...(live?.nodes || []).map(n => [n.id, `${n.label} (${n.id})`] as [string, string])];
      if (it.Node && !nodes.some(([v]) => v === it.Node)) nodes.push([it.Node, it.Node]);
      side.appendChild(field('Metered by', select(nodes, it.Node || '', v => { act(() => { it.Node = v; }); offerBeneath(it); }),
        'A smart plug, CT, ESPHome sensor, PDU outlet or anything else reading this alone.'));
    } else {
      side.append(row('Where', where));
      if (!supply || it.Circuit) side.append(row('Circuit', it.Circuit ? refLabel(it.Circuit) : 'not known yet'));
      if (it.Kind === 'panel' && it.Panel) side.append(row('Panel', it.Panel));
      side.append(row('Metered by', it.Node ? nodeLabel(it.Node) : 'not metered'));
    }
    if (it.Node) side.appendChild(row('Reading', fmt(live?.placements[it.Id]?.value)));

    const c = it.Circuit ? circuitOf(it.Circuit) : null;
    if (c) { side.appendChild(el('h4', { text: it.Kind === 'panel' ? 'Fed from' : 'Its circuit' })); side.appendChild(circuitRow(c)); }
    else if (it.Circuit) side.appendChild(el('div', { class: 'fp-note is-warn', text: `${it.Circuit} is not a breaker in any panel, so its circuit reads as unknown.` }));

    const wired = runsIn().filter((r: any) => r.From === it.Id || r.To === it.Id);
    if (wired.length) {
      side.appendChild(el('h4', { text: 'Wired to' }));
      const wl = el('div', { class: 'fp-list' });
      wired.forEach((r: any) => {
        const other = r.From === it.Id ? r.To : r.From;
        wl.appendChild(listRow(other ? itemName(itemOf(other) || { Kind: '?' }) : 'a loose end', `${len(planPathLength(runPath(r)))} · ${r.Kind}`,
          () => { selection = { type: 'run', id: r.Id }; render(); }));
      });
      side.appendChild(wl);
    }

    const btns: any[] = [];
    if (!supply) {
      const trace = btn(it.Circuit ? 'Trace again' : 'Trace its circuit', it.Circuit ? '' : 'primary');
      trace.title = 'Switch a load on this outlet on and off; the channel that follows is its circuit.';
      trace.onclick = () => traceItem(it);
      btns.push(trace);
    }
    if (editing) {
      const wire = btn('Wire from here');
      wire.title = 'Start a cable run at this item; tap the bends and then the item it goes to.';
      wire.onclick = () => { tool = 'wire'; wireDraft = { from: it.Id, pts: [] }; render(); };
      const del = btn('Delete', 'danger');
      del.onclick = () => deleteSelection();
      btns.push(wire, del);
    }
    side.appendChild(actions(...btns));
  };

  const drawOpening = (o: any, editing: boolean) => {
    if (!o) { selection = null; return drawSide(); }
    side.appendChild(el('div', { class: 'fp-side-head' }, el('h3', { text: PLAN_OPENINGS.find(x => x[0] === o.Kind)?.[1] || 'Opening' })));
    if (!editing) { side.appendChild(row('Width', len(o.Width))); return; }
    side.append(
      el('div', { class: 'fp-two' },
        field('Kind', select(PLAN_OPENINGS, o.Kind || 'door', v => act(() => { o.Kind = v; }))),
        field('Width', lenInput(Number(o.Width) || 0, w => act(() => { o.Width = planRound(w); })))));
    if ((o.Kind || 'door') !== 'window' && o.Kind !== 'opening') {
      side.appendChild(el('div', { class: 'fp-two' },
        field('Hinges', select([['left', 'Left'], ['right', 'Right']], o.Swing || 'left', v => act(() => { o.Swing = v; }))),
        field('Opens', select([['in', 'This side'], ['out', 'Other side']], o.Flip ? 'out' : 'in', v => act(() => { o.Flip = v === 'out'; })))));
    }
    const turn = btn('Rotate 90°');
    turn.onclick = () => act(() => { o.Angle = ((Number(o.Angle) || 0) + 90) % 360; });
    const del = btn('Delete', 'danger');
    del.onclick = () => deleteSelection();
    side.appendChild(actions(turn, del));
    side.appendChild(el('div', { class: 'desc', text: 'Drag it along a wall to move it; it lines up with whichever wall it is dropped on.' }));
  };

  const drawRun = (r: any, editing: boolean) => {
    if (!r) { selection = null; return drawSide(); }
    const from = r.From ? itemOf(r.From) : null, to = r.To ? itemOf(r.To) : null;
    side.appendChild(el('div', { class: 'fp-side-head' }, el('h3', { text: r.Label || `${r.Kind === 'service' ? 'Service' : r.Kind === 'feeder' ? 'Feeder' : 'Circuit'} run` }), el('span', { class: 'fp-pill', text: r.Kind })));
    side.appendChild(row('From', from ? itemName(from) : 'a loose end'));
    side.appendChild(row('To', to ? itemName(to) : 'a loose end'));
    side.appendChild(row('Length on the plan', len(planPathLength(runPath(r)))));
    if (editing) {
      const note = el('input', { type: 'text', value: r.Label || '', placeholder: 'e.g. through the attic' }) as HTMLInputElement;
      note.onchange = () => act(() => { r.Label = note.value.trim(); });
      side.append(field('Kind', select([['circuit', 'Branch circuit'], ['feeder', 'Feeder'], ['service', 'Utility service']], r.Kind || 'circuit', v => act(() => { r.Kind = v; }))),
        field('Circuit', select(circuitChoices(), r.Circuit || '', v => act(() => {
          r.Circuit = v;
          // Both ends of a branch circuit are on it, unless one says otherwise already.
          [from, to].forEach(it => { if (v && it && !it.Circuit && !PLAN_SUPPLY_KINDS.includes(it.Kind)) it.Circuit = v; });
        })), 'Setting it also puts either end with no circuit of its own on this one.'),
        field('Note', note));
      const del = btn('Delete', 'danger');
      del.onclick = () => deleteSelection();
      side.appendChild(actions(del));
      side.appendChild(el('div', { class: 'desc', text: 'Drag a bend to move it; drag a small dot to add a bend.' }));
    } else if (r.Circuit) side.appendChild(row('Circuit', refLabel(r.Circuit)));
    const c = r.Circuit ? circuitOf(r.Circuit) : null;
    if (c) side.appendChild(circuitRow(c));
  };

  const deleteSelection = () => {
    if (!selection) return;
    const sel = selection;
    if (sel.type === 'item') {
      const it = itemOf(sel.id);
      if (!it) return;
      act(() => {
        itemsIn().splice(itemsIn().indexOf(it), 1);
        // Runs ending at it keep their path and become loose at that end.
        runsIn().forEach((r: any) => { if (r.From === it.Id) { r.Points.unshift({ X: it.X, Y: it.Y }); r.From = ''; } if (r.To === it.Id) { r.Points.push({ X: it.X, Y: it.Y }); r.To = ''; } });
        selection = null;
      });
    } else if (sel.type === 'opening') act(() => { openingsNow().splice(openingsNow().indexOf(openingOf(sel.id)), 1); selection = null; });
    else if (sel.type === 'run') act(() => { runsIn().splice(runsIn().indexOf(runOf(sel.id)), 1); selection = null; });
    else {
      const s = shapeOf(sel);
      if (!s) return;
      const inIt = itemsIn().filter((it: any) => it.Room === s.Id).length;
      if (inIt && !confirm(`Delete ${s.Name || s.Id}? ${inIt} item(s) in it stay on the plan, outdoors.`)) return;
      act(() => {
        const list = sel.type === 'room' ? roomsNow() : areasNow();
        list.splice(list.indexOf(s), 1);
        if (sel.type === 'room') { itemsIn().forEach((it: any) => { if (it.Room === s.Id) { it.Room = ''; it.Floor = floorNow()!.floor.Id; } }); areasNow().forEach(a => { a.Rooms = (a.Rooms || []).filter((x: string) => x !== s.Id); }); }
        selection = null;
      });
      toast(`Deleted. Ctrl+Z brings it back.`, true);
    }
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
    act(() => {
      for (let i = links.length - 1; i >= 0; i--) if (links[i].To === it.Node) links.splice(i, 1);
      links.push({ From: c.node, To: it.Node });
    });
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
      const fl = floorsAll().find(x => onFloor(it, x.floor));
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
        cb.onchange = () => act(() => { const list = ensure(breaker, 'Rooms', []); const at = list.indexOf(r.Id); if (cb.checked && at < 0) list.push(r.Id); if (!cb.checked && at >= 0) list.splice(at, 1); });
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
        b.onclick = () => { closeSheet(); act(() => { it.Circuit = c.ref; }); toast(`Linked to ${circuitLabel(c)}. Press Save to keep it.`, true); };
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



  // --- Sheets: floors, background, tools -----------------------------------------------------------
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
    const plot = planDefaultPlot(sys());
    let wU = plot.w * 100, hU = plot.h * 100;
    const wIn = el('input', { type: 'text', class: 'fp-len', value: planFmtLen(plot.w, sys()) }) as HTMLInputElement;
    const hIn = el('input', { type: 'text', class: 'fp-len', value: planFmtLen(plot.h, sys()) }) as HTMLInputElement;
    const read = () => { const w = planParseLen(wIn.value, sys()), h = planParseLen(hIn.value, sys()); if (w) wU = w * 100; if (h) hU = h * 100; };
    body.append(field('Site', siteSel), siteRow, field('Floor name', floorName), field('Level', level, '0 is the ground floor, 1 the one above, −1 a basement.'),
      el('div', { class: 'fp-two' }, field('Plot width', wIn), field('Plot depth', hIn)),
      el('div', { class: 'desc', text: 'The whole lot you want to draw on, yard included. Upload a plan image afterwards, or draw on the grid.' }));
    const add = btn('Add floor', 'primary');
    add.onclick = () => {
      read();
      const nm = floorName.value.trim();
      act(() => {
        let site = sitesIn().find((s: any) => s.Id === siteSel.value);
        if (!site) {
          const sn = siteName.value.trim() || 'Home';
          site = { Id: freshId(sn), Name: sn, Floors: [] };
          sitesIn().push(site);
        }
        const fname = nm || `Floor ${ensure(site, 'Floors', []).length + 1}`;
        const f = { Id: freshId(fname), Name: fname, Level: Number(level.value) || 0, Width: Math.round(wU), Height: Math.round(hU), Scale: 100, Image: '', Ground: '', Rooms: [], Areas: [], Openings: [] };
        site.Floors.push(f);
        floorId = f.Id; remember('floor', floorId); viewFor = '';
        mode = 'edit'; tool = 'room';
      });
      closeSheet();
      toast('Floor added. Drag out rooms, add one by size, or upload the plan under Background. Press Save to keep it.', true);
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
    name.onchange = () => act(() => { f.Name = name.value.trim() || f.Id; });
    const level = el('input', { type: 'number', value: String(f.Level ?? 0), step: '1' }) as HTMLInputElement;
    level.onchange = () => act(() => { f.Level = Number(level.value) || 0; });
    const { w, h } = floorSize();
    body.append(field('Name', name), field('Level', level),
      el('div', { class: 'fp-two' },
        field('Plot width', lenInput(w, v => act(() => { f.Width = Math.max(100, Math.round(v)); viewFor = ''; }))),
        field('Plot depth', lenInput(h, v => act(() => { f.Height = Math.max(100, Math.round(v)); viewFor = ''; })))),
      field('Ground', select(PLAN_GROUNDS, f.Ground || '', v => act(() => { f.Ground = v; })), 'What is drawn around the rooms: a lawn, a slab, gravel.'),
      el('div', { class: 'fp-id', text: `id ${f.Id} · ${fl.site.Name || fl.site.Id} · ${Math.round(scale() * 100) / 100} drawing units per metre` }));
    const del = btn('Delete floor', 'danger');
    del.onclick = () => {
      const rooms = ensure(f, 'Rooms', []).length;
      if (!confirm(`Delete ${f.Name || f.Id}${rooms ? ` and its ${rooms} room(s)` : ''}? What is placed on it goes too. Ctrl+Z brings it back.`)) return;
      act(() => {
        const items = itemsIn();
        for (let i = items.length - 1; i >= 0; i--) if (onFloor(items[i], f)) items.splice(i, 1);
        const runs = runsIn();
        for (let i = runs.length - 1; i >= 0; i--) if (runs[i].Floor === f.Id) runs.splice(i, 1);
        fl.site.Floors.splice(fl.site.Floors.indexOf(f), 1);
        floorId = ''; selection = null; viewFor = '';
      });
      closeSheet();
    };
    openSheet({ title: 'Floor settings', body, footer: [del] });
  };
  floorBtn.onclick = floorSheet;

  /// Upload a plan image for the floor on screen. With nothing drawn yet, the plot takes the image's proportions.
  const uploadImage = async (file: File, say: (s: string) => void) => {
    const fl = floorNow();
    if (!fl) { say('Add a floor first.'); return false; }
    const f = fl.floor;
    say('Preparing…');
    try {
      const prepared = await fpPrepareImage(file);
      say('Uploading…');
      const r = await fetch('/api/plans/images', { method: 'POST', headers: { 'Content-Type': prepared.type || 'application/octet-stream' }, body: prepared.blob });
      const b = await r.json().catch(() => ({}));
      if (!b.ok) { say(b.message || `Upload failed (${r.status}).`); toast(b.message || 'Upload failed.', false); return false; }
      const drawn = [...ensure(f, 'Rooms', []), ...ensure(f, 'Areas', [])].some((s: any) => (s.Shape || []).length >= 3) || itemsIn().some((it: any) => onFloor(it, f));
      act(() => {
        f.Image = b.id;
        imageFailed = '';
        if (!drawn && prepared.width && prepared.height) { f.Height = Math.max(100, Math.round((Number(f.Width) || 1000) * prepared.height / prepared.width)); viewFor = ''; }
      });
      say(drawn ? 'Uploaded. What is already drawn stays put; the image is fitted to the plot.' : 'Uploaded.');
      toast('Plan uploaded. Now set its scale: Edit › Measure, tap two points you know the distance between.', true);
      return true;
    } catch (e: any) { say(e?.message || 'Could not read that image.'); toast(e?.message || 'Could not read that image.', false); return false; }
  };

  const backgroundSheet = () => {
    const fl = floorNow();
    if (!fl) return addSheet();
    const f = fl.floor;
    const body = el('div', { class: 'fp-sheet' });
    const where = el('div', { class: 'desc', text: 'Checking where images are kept…' });
    api('/api/plans/storage').then((r: any) => { where.textContent = r.body?.ok ? `${r.body.limits} Kept in ${r.body.where}, never in the configuration. A large photo is shrunk here before it is sent.` : 'Plan storage is not reachable.'; }).catch(() => { where.textContent = 'Plan storage is not reachable.'; });
    const upStatus = el('div', { class: 'desc fp-up-status' });
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,.svg,image/*', class: 'fp-file' }) as HTMLInputElement;
    file.onchange = async () => { const picked = file.files?.[0]; if (picked && await uploadImage(picked, t => { upStatus.textContent = t; })) closeSheet(); };
    const choose = btn(f.Image ? 'Replace image…' : 'Choose an image…', 'primary');
    choose.onclick = () => file.click();
    const drop = el('div', { class: 'fp-drop' }, el('div', { text: 'Drop a floor plan, a photo of one, or a screenshot here' }), choose, file);
    drop.addEventListener('dragover', (e: any) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', async (e: any) => { e.preventDefault(); drop.classList.remove('is-over'); const picked = e.dataTransfer?.files?.[0]; if (picked && await uploadImage(picked, t => { upStatus.textContent = t; })) closeSheet(); });
    body.append(drop, upStatus, where);
    if (f.Image) {
      body.appendChild(el('img', { class: 'fp-thumb', src: `/api/plans/images/${encodeURIComponent(f.Image)}`, alt: 'The current plan image' }));
      const opacity = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(f.ImageOpacity ?? 0.85) }) as HTMLInputElement;
      opacity.oninput = () => { f.ImageOpacity = Number(opacity.value); drawPlan(); };
      opacity.onchange = () => { history.push(); refreshDirty(); };
      const scaleBtn = btn('Set the scale…');
      scaleBtn.title = 'Measure a distance you know on the image — a wall, a doorway — and say how long it really is.';
      scaleBtn.onclick = () => { closeSheet(); pickTool('measure'); };
      const remove = btn('Remove image', 'danger');
      remove.onclick = () => { act(() => { f.Image = ''; }); closeSheet(); };
      body.append(field('How strongly it shows', opacity), actions(scaleBtn, remove));
    }
    openSheet({ title: 'Background image', body });
  };
  bgBtn.onclick = backgroundSheet;

  // Dropping an image anywhere on the plan uploads it for this floor.
  stage.addEventListener('dragover', (e: any) => { if (e.dataTransfer?.types?.includes?.('Files')) { e.preventDefault(); stage.classList.add('is-drop'); } });
  stage.addEventListener('dragleave', () => stage.classList.remove('is-drop'));
  stage.addEventListener('drop', (e: any) => {
    stage.classList.remove('is-drop');
    const picked = e.dataTransfer?.files?.[0];
    if (!picked) return;
    e.preventDefault();
    uploadImage(picked, t => { status.textContent = t; });
  });

  const toolsSheet = () => {
    const body = el('div', { class: 'fp-sheet' });
    const tags = btn('Rooms from tags…');
    tags.onclick = () => migrateSheet();
    const ha = btn('Publish rooms to Home Assistant…');
    ha.onclick = () => haSheet();
    body.append(
      el('div', { class: 'fp-tool-row' }, tags, el('div', { class: 'desc', text: 'Turn Version 2.0 room and area tags into rooms, with a preview of what each becomes before anything is written.' })),
      el('div', { class: 'fp-tool-row' }, ha, el('div', { class: 'desc', text: 'Create or match a Home Assistant area for each room, and file this bridge’s devices in them.' })),
      el('h4', { text: 'Keys' }),
      el('div', { class: 'fp-keys' }, ...[
        ['Ctrl+Z / Ctrl+Y', 'undo / redo'], ['V H R P O A', 'select, pan, room, outline, outdoor, area'], ['D W I L M', 'door, window, item, wire, measure'],
        ['Delete', 'remove the selection'], ['Arrows', 'nudge; Shift for more'], ['Esc', 'stop drawing'], ['+ − 0', 'zoom in, out, fit'],
      ].map(([k, t]) => el('div', {}, el('kbd', { text: k }), ' ' + t))));
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
      history.push();
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
      if (Object.keys(linked).length) history.push();
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

  const drawEmpty = () => {
    const fl = floorNow();
    empty.innerHTML = '';
    const bare = !!fl && !fl.floor.Image && !roomsNow().some(r => (r.Shape || []).length >= 3) && !itemsNow().length;
    empty.hidden = !bare && !!fl;
    if (!fl) {
      const start = btn('Add a site and floor', 'primary');
      start.onclick = () => addSheet();
      empty.append(el('div', { class: 'fp-empty-title', text: 'No floors yet' }), el('div', { class: 'desc', text: 'A floor is the plot you draw on: rooms, the yard, and everything placed in them.' }), start);
      return;
    }
    if (!bare) return;
    const up = btn('Upload a plan image', 'primary');
    up.onclick = () => backgroundSheet();
    const draw = btn('Draw a room');
    draw.onclick = () => pickTool('room');
    const size = btn('Add a room by size');
    size.onclick = () => { pickTool('room'); roomBySize(false); };
    empty.append(el('div', { class: 'fp-empty-title', text: 'An empty floor' }),
      el('div', { class: 'desc', text: 'Drop a floor plan image here to trace over, or start drawing on the grid.' }), actions(up, draw, size));
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
    bgBtn.disabled = !fl;
    const key = fl ? `${fl.floor.Id}|${fl.floor.Width}|${fl.floor.Height}` : '';
    if (fl && viewFor !== key) { fit(); viewFor = key; }
    if (fl) stage.style.aspectRatio = `${Number(fl.floor.Width) || 1000} / ${Number(fl.floor.Height) || 700}`;
    stage.classList.toggle('is-empty', !fl);
    drawSub();
    drawPlan();
    drawSide();
    drawEmpty();
  };

  window.addEventListener('keydown', (e: any) => {
    if (!sec.classList.contains('active')) return;
    if (/INPUT|SELECT|TEXTAREA/.test(e.target?.tagName || '') || e.target?.isContentEditable) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = String(e.key || '');
    if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if (ctrl || e.altKey) return;
    if (k === 'Escape') {
      if (draft.length || rectStart || wireDraft || measure) { draft = []; rectStart = null; rectEnd = null; wireDraft = null; measure = null; hover = null; render(); }
      else if (selection) { selection = null; render(); }
      return;
    }
    if (k === 'Enter' && wireDraft) { finishWire(''); return; }
    if (k === 'Enter' && draft.length >= 3) { finishOutline(draft); return; }
    if (k === '+' || k === '=') { zoomAt(centre(), 1.4); return; }
    if (k === '-' || k === '_') { zoomAt(centre(), 1 / 1.4); return; }
    if (k === '0') { fit(); drawPlan(); return; }
    if (mode !== 'edit') return;
    if ((k === 'Delete' || k === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); return; }
    if (k.startsWith('Arrow') && selection) {
      e.preventDefault();
      const step = snapStep() * (e.shiftKey ? 10 : 1);
      const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
      act(() => {
        const s = shapeOf(selection);
        if (s) s.Shape = planClamp(planMove(s.Shape, dx, dy), floorSize().w, floorSize().h);
        const it = selection!.type === 'item' ? itemOf(selection!.id) : selection!.type === 'opening' ? openingOf(selection!.id) : null;
        if (it) { it.X = planRound(it.X + dx); it.Y = planRound(it.Y + dy); }
      });
      return;
    }
    const byKey = FP_TOOLS.find(t => t[2].toLowerCase() === k.toLowerCase());
    if (byKey) { e.preventDefault(); pickTool(byKey[0]); }
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

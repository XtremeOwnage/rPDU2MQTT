// Full-screen, read-only wall display at /kiosk. ?theme=dark|light picks the palette.
import { api, el, svgEl, formatNum } from './helpers.js';
import { subscribeLive, realtimeLive, onRealtimeState } from './realtime.js';
import { SOURCE_COLOR } from './charts.js';
import { homeEnergy, selfSufficiencyPct, netSelfProducedPct, shareBand, sumKnown } from './energy.js';
import { findHub, flowTree, type TreeNode } from './flow-tree.js';

export const isKiosk = () => /^\/kiosk\/?$/i.test(location.pathname || '');

/// The theme a kiosk URL asks for, or null to follow the system.
export function kioskTheme(search: string): string | null {
  const t = new URLSearchParams(search || '').get('theme');
  return t === 'dark' || t === 'light' ? t : null;
}

const KK_ICON: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  solar: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
  grid: 'M9.5 21 11 3h2l1.5 18M6 8h12M5 13h14M10.5 9.5l3 7M13.5 9.5l-3 7',
  battery: 'M8 5h8a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM10 2.5h4M12.8 9l-2.3 4h3l-2.3 4',
};

/// A round axis bound at or above `v`.
export function kkNice(v: number): number {
  if (!(v > 0)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}

const kkW = (w: number | null) => w == null ? '—'
  : Math.abs(w) >= 1000 ? `${formatNum(Math.round(Math.abs(w) / 100) / 10)} kW` : `${formatNum(Math.round(Math.abs(w)))} W`;
const kkKwh = (v: number | null) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} kWh`;
const kkTop = (n: any) => !String(n.id).includes('#');
const kkIds = (nodes: any[], role: string) => nodes.filter(n => n.balance === role && kkTop(n)).map(n => n.id);
const kkSum = (nodes: any[], role: string) => {
  const vals = nodes.filter(n => n.balance === role && kkTop(n) && typeof n.value === 'number').map(n => n.value);
  return vals.length ? vals.reduce((a: number, b: number) => a + b, 0) : null;
};
const kkNet = (out: number | null, back: number | null) => out == null && back == null ? null : (out || 0) - (back || 0);

const KK_EXPORT = SOURCE_COLOR.gridExport;
const KK_HOME = 'var(--accent)';
const KK_IDLE = 'var(--faint)';

/// Battery colour by charge: good at 50% and up, warn from 20%, bad below.
export const kkSocLevel = (pct: number | null) => pct == null ? 'none' : pct >= 50 ? 'good' : pct >= 20 ? 'warn' : 'bad';

/// Who feeds whom right now. Grid is + importing, battery is + discharging; solar serves the home first.
export function kkSplit(p: { solar: number | null; grid: number | null; battery: number | null; home: number | null }) {
  const pos = (v: number | null) => Math.max(0, v || 0);
  let solar = pos(p.solar), home = pos(p.home);
  let charge = pos(-(p.battery || 0)), exportW = pos(-(p.grid || 0));
  let dis = pos(p.battery), imp = pos(p.grid);
  const take = (have: number, want: number) => Math.min(have, want);
  const solarHome = take(solar, home); solar -= solarHome; home -= solarHome;
  const solarBattery = take(solar, charge); solar -= solarBattery; charge -= solarBattery;
  const solarGrid = take(solar, exportW); exportW -= solarGrid;
  const batteryHome = take(dis, home); dis -= batteryHome; home -= batteryHome;
  const gridHome = take(imp, home); imp -= gridHome;
  const gridBattery = take(imp, charge);
  const batteryGrid = take(dis, exportW);
  return { solarHome, solarBattery, solarGrid, batteryHome, gridHome, gridBattery, batteryGrid };
}

/// Leaves of the flow tree under the hub, largest first.
export function kkLoads(nodes: any[], links: any[]): { label: string; value: number }[] {
  const byId = new Map(nodes.map((n: any) => [n.id, n]));
  const { hub } = findHub(nodes, links);
  if (!hub) return [];
  const out: { label: string; value: number }[] = [];
  const walk = (t: TreeNode) => {
    if (t.children.length) { t.children.forEach(walk); return; }
    const n: any = byId.get(t.id);
    if (!n || n.kind === 'unmeasured' || n.synthetic || !(t.value > 0)) return;
    out.push({ label: t.label, value: t.value });
  };
  flowTree(nodes, links, hub, 'out').top.forEach(walk);
  return out.sort((a, b) => b.value - a.value);
}

const kkPhase = (ms: number) => `-${Date.now() % ms}ms`;
let kkUid = 0;
const kkId = () => 'kk' + (kkUid++).toString(36);
const kkStop = (o: number, c: string, a = 1) => {
  const s = svgEl('stop', { offset: o });
  s.style.stopColor = c; s.style.stopOpacity = String(a);
  return s;
};

/// The battery glyph: fill to the charge, coloured by level, with a sweep while charging or discharging.
export function kkBattery(pct: number | null, W: number, H: number, mode: 'charge' | 'discharge' | null) {
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'kk-batt kk-soc-' + kkSocLevel(pct) });
  const id = kkId(), r = H * .16, ir = H * .1, fh = H - 16;
  const fw = pct == null ? 0 : Math.max(pct > 0 ? H * .2 : 0, (W - 34) * Math.min(100, Math.max(0, pct)) / 100);
  const defs = svgEl('defs', {});
  const fill = svgEl('linearGradient', { id: id + 'f', x1: 0, x2: 1 });
  fill.append(kkStop(0, 'color-mix(in srgb, var(--soc) 62%, #000)'), kkStop(1, 'var(--soc)'));
  const sheen = svgEl('linearGradient', { id: id + 's', x1: 0, x2: 1 });
  sheen.append(kkStop(0, '#fff', 0), kkStop(.5, '#fff', .45), kkStop(1, '#fff', 0));
  const clip = svgEl('clipPath', { id: id + 'c' });
  clip.appendChild(svgEl('rect', { x: 8, y: 8, width: fw, height: fh, rx: ir }));
  defs.append(fill, sheen, clip);
  svg.append(defs,
    svgEl('rect', { x: 2, y: 2, width: W - 22, height: H - 4, rx: r, class: 'kk-batt-case' }),
    svgEl('rect', { x: W - 16, y: H * .32, width: 12, height: H * .36, rx: 4, class: 'kk-batt-tip' }),
    svgEl('rect', { x: 8, y: 8, width: fw, height: fh, rx: ir, fill: `url(#${id}f)` }));
  if (mode && fw > 0) {
    const sw = Math.max(60, fw * .45);
    const g = svgEl('g', { 'clip-path': `url(#${id}c)` });
    const bar = svgEl('rect', { x: 0, y: 8, width: sw, height: fh, fill: `url(#${id}s)`, class: 'kk-sheen' });
    const [from, to] = mode === 'charge' ? [8 - sw, 8 + fw] : [8 + fw, 8 - sw];
    bar.style.setProperty('--from', from + 'px'); bar.style.setProperty('--to', to + 'px');
    bar.style.animationDelay = kkPhase(1800);
    g.appendChild(bar); svg.appendChild(g);
    if (mode === 'charge' && W - 34 - fw > H * .4) {
      const bx = 8 + fw + (W - 34 - fw) / 2, by = H / 2, k = H * .012;
      const bolt = svgEl('path', { class: 'kk-bolt', d: `M${bx + 4 * k},${by - 16 * k} L${bx - 7 * k},${by + 2 * k} L${bx},${by + 2 * k} L${bx - 4 * k},${by + 16 * k} L${bx + 7 * k},${by - 2 * k} L${bx},${by - 2 * k}Z` });
      bolt.style.animationDelay = kkPhase(1800);
      svg.appendChild(bolt);
    }
    if (mode === 'discharge') {
      const edge = svgEl('rect', { x: 8 + fw - 4, y: 8, width: 4, height: fh, class: 'kk-batt-edge' });
      edge.style.animationDelay = kkPhase(1800);
      svg.appendChild(edge);
    }
  }
  const t = svgEl('text', { x: (W - 20) / 2, y: H / 2 + H * .15, 'text-anchor': 'middle', 'font-size': H * .44, class: 'kk-batt-pct' });
  t.textContent = pct == null ? '—' : Math.round(pct) + '%';
  svg.appendChild(t);
  return svg;
}

export type KkNow = {
  solar: number | null; grid: number | null; battery: number | null; home: number | null; soc: number | null;
  has: { solar: boolean; grid: boolean; battery: boolean };
  today: { solar: number | null; home: number | null; imported: number | null; exported: number | null; charged: number | null; discharged: number | null };
  solarPeak: number | null;
};

/// Solar on top, grid and battery either side, home below; arrows run the way power moves, as wide as it is.
export function kkFlow(s: KkNow, W: number, H: number) {
  const VW = Math.max(W, 1600), VH = H * VW / W;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${VW} ${VH}`, class: 'kk-flow-svg kk-soc-' + kkSocLevel(s.soc) });
  const defs = svgEl('defs', {});
  svg.appendChild(defs);
  const add = (tag: string, a: any, text?: string) => { const e = svgEl(tag, a); if (text != null) e.textContent = text; svg.appendChild(e); return e; };

  const dots = svgEl('pattern', { id: 'kkdots', width: 34, height: 34, patternUnits: 'userSpaceOnUse' });
  dots.appendChild(svgEl('circle', { cx: 17, cy: 17, r: 1.1, class: 'kk-dotgrid' }));
  const glow = svgEl('radialGradient', { id: 'kkglow' });
  glow.append(kkStop(0, KK_HOME, .10), kkStop(1, KK_HOME, 0));
  defs.append(dots, glow);
  add('rect', { width: VW, height: VH, fill: 'url(#kkdots)' });
  add('ellipse', { cx: VW / 2, cy: VH / 2, rx: VW * .45, ry: VH * .6, fill: 'url(#kkglow)' });

  const cx = VW / 2, nw = 420, nh = 196;
  const N: Record<string, { x: number; y: number }> = {
    solar: { x: cx, y: 18 + nh / 2 }, home: { x: cx, y: VH - 18 - nh / 2 },
    grid: { x: cx - VW * .335, y: VH / 2 }, battery: { x: cx + VW * .335, y: VH / 2 },
  };
  const exporting = (s.grid ?? 0) < -1, importing = (s.grid ?? 0) > 1;
  const bmode: 'charge' | 'discharge' | null = (s.battery ?? 0) < -1 ? 'charge' : (s.battery ?? 0) > 1 ? 'discharge' : null;
  const col: Record<string, string> = {
    solar: (s.solar ?? 0) > 1 ? SOURCE_COLOR.solar : KK_IDLE,
    grid: exporting ? KK_EXPORT : importing ? SOURCE_COLOR.grid : KK_IDLE,
    battery: 'var(--soc)', home: KK_HOME,
  };

  const split = kkSplit(s);
  const edges: [string, string, number][] = [
    ['solar', 'home', split.solarHome], ['solar', 'grid', split.solarGrid], ['solar', 'battery', split.solarBattery],
    ['grid', 'home', split.gridHome], ['battery', 'home', split.batteryHome],
    ['grid', 'battery', split.gridBattery], ['battery', 'grid', split.batteryGrid],
  ];
  const shown = (k: string) => k === 'home' || (s.has as any)[k];
  const geo = (a: string, b: string): { p: [number, number, number, number]; k: string } => {
    const A = N[a], B = N[b];
    if (a === 'solar' && b === 'home') return { p: [cx, A.y + nh / 2, cx, B.y - nh / 2], k: 'v' };
    if (a === 'solar') return { p: [A.x + Math.sign(B.x - cx) * nw / 2, A.y, B.x, B.y - nh / 2], k: 'hv' };
    if (b === 'home') return { p: [A.x, A.y + nh / 2, B.x + Math.sign(A.x - cx) * nw / 2, B.y], k: 'vh' };
    return { p: [A.x + Math.sign(B.x - A.x) * nw / 2, A.y, B.x - Math.sign(B.x - A.x) * nw / 2, B.y], k: 'h' };
  };
  const curve = (k: string, x0: number, y0: number, x1: number, y1: number) =>
    k === 'hv' ? `M${x0},${y0} C${x1},${y0} ${x1},${y0} ${x1},${y1}`
    : k === 'vh' ? `M${x0},${y0} C${x0},${y1} ${x0},${y1} ${x1},${y1}` : `M${x0},${y0} L${x1},${y1}`;
  const pills: [number, number, string, string][] = [];
  edges.forEach(([a, b, w]) => {
    if (!shown(a) || !shown(b)) return;
    const { p: [x0, y0, x1, y1], k } = geo(a, b);
    const inter = (a === 'grid' || a === 'battery') && (b === 'grid' || b === 'battery');
    if (!(w > 1)) { if (!inter) add('path', { d: curve(k, x0, y0, x1, y1), class: 'kk-idle' }); return; }
    const c0 = a === 'grid' ? SOURCE_COLOR.grid : a === 'battery' ? SOURCE_COLOR.battery : SOURCE_COLOR.solar;
    const c1 = b === 'grid' ? KK_EXPORT : b === 'battery' ? SOURCE_COLOR.battery : c0;
    const sw = Math.min(46, 10 + 36 * w / 6000), gid = kkId(), mid = kkId();
    const grad = svgEl('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: x0, y1: y0, x2: x1, y2: y1 });
    grad.append(kkStop(0, c0), kkStop(1, c1));
    const marker = svgEl('marker', { id: mid, viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 1.5, markerHeight: 1.5, orient: 'auto' });
    const head = svgEl('path', { d: 'M0,0 L10,5 L0,10 Z' }); head.style.fill = c1;
    marker.appendChild(head);
    defs.append(grad, marker);
    const ex = k === 'vh' || k === 'h' ? x1 - Math.sign(x1 - x0) * sw * .75 : x1;
    const ey = k === 'vh' || k === 'h' ? y1 : y1 - sw * .75;
    const d = curve(k, x0, y0, ex, ey);
    add('path', { d, stroke: `url(#${gid})`, 'stroke-width': sw + 16, class: 'kk-halo' });
    add('path', { d, stroke: `url(#${gid})`, 'stroke-width': sw, 'marker-end': `url(#${mid})`, class: 'kk-ribbon' });
    const gap = Math.max(26, sw * 1.5), ms = Math.round((2.2 - Math.min(1.5, w / 4000)) * 1000);
    const flow = add('path', { d, 'stroke-width': Math.max(4, sw * .26), 'stroke-dasharray': `1 ${gap}`, class: 'kk-dots' });
    flow.style.setProperty('--o', `${-(gap + 1) * 2}px`);
    flow.style.animationDuration = ms + 'ms';
    flow.style.animationDelay = kkPhase(ms);
    const m: [number, number] = k === 'v' ? [x0, (y0 + y1) / 2] : k === 'hv' ? [(x0 + x1) / 2 + (x1 - x0) * .2, y0]
      : k === 'vh' ? [x0, (y0 + y1) / 2 + 6] : [x0 + (x1 - x0) * .2, y0];
    pills.push([m[0], m[1], kkW(w), c1]);
  });
  pills.forEach(([x, y, t, c]) => {
    const wd = t.length * 13 + 30;
    const r = add('rect', { x: x - wd / 2, y: y - 20, width: wd, height: 40, rx: 20, class: 'kk-pill-bg' }); r.style.stroke = c;
    add('text', { x, y: y + 8, 'text-anchor': 'middle', class: 'kk-pill-text' }, t);
  });

  const bar = (x: number, y: number, w: number, parts: [number, string][], max: number, h = 10) => {
    add('rect', { x, y, width: w, height: h, rx: h / 2, class: 'kk-track' });
    const id = kkId(), clip = svgEl('clipPath', { id });
    clip.appendChild(svgEl('rect', { x, y, width: w, height: h, rx: h / 2 }));
    defs.appendChild(clip);
    const g = add('g', { 'clip-path': `url(#${id})` });
    let o = 0;
    parts.forEach(([v, c]) => {
      const pw = max > 0 ? w * Math.max(0, v) / max : 0;
      if (!(pw > 0)) return;
      const r = svgEl('rect', { x: x + o, y, width: pw, height: h }); r.style.fill = c;
      g.appendChild(r); o += pw + 2;
    });
  };
  const node = (key: string, label: string, state: string, body: (x: number, y: number) => void) => {
    if (!shown(key)) return;
    const n = N[key], c = col[key], x = n.x - nw / 2, y = n.y - nh / 2, gid = kkId();
    const tint = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: .6, y2: 1 });
    tint.append(kkStop(0, c, .16), kkStop(.55, c, 0));
    defs.appendChild(tint);
    const g = add('g', { class: 'kk-node kk-node-' + key + (key === 'battery' ? ' kk-soc-' + kkSocLevel(s.soc) : '') });
    g.style.setProperty('--n', c);
    g.append(svgEl('rect', { x, y, width: nw, height: nh, rx: 20, class: 'kk-node-bg' }),
      svgEl('rect', { x, y, width: nw, height: nh, rx: 20, fill: `url(#${gid})`, class: 'kk-node-edge' }),
      svgEl('rect', { x: x + 22, y, width: 70, height: 3, rx: 1.5, class: 'kk-node-tab' }),
      svgEl('circle', { cx: x + 40, cy: y + 38, r: 19, class: 'kk-node-badge' }));
    const icon = svgEl('path', { d: KK_ICON[key], class: 'kk-node-icon', transform: `translate(${x + 28},${y + 26})` });
    const lab = svgEl('text', { x: x + 70, y: y + 44, class: 'kk-node-label' }); lab.textContent = label;
    g.append(icon, lab);
    if (state) {
      const sw = state.length * 9.5 + 26;
      const pill = svgEl('rect', { x: x + nw - 20 - sw, y: y + 22, width: sw, height: 30, rx: 15, class: 'kk-state-bg' });
      const st = svgEl('text', { x: x + nw - 20 - sw / 2, y: y + 43, 'text-anchor': 'middle', class: 'kk-state-text' }); st.textContent = state;
      g.append(pill, st);
    }
    body(x, y);
  };
  const big = (x: number, y: number, text: string, cls: string) => add('text', { x: x + 24, y: y + 112, class: 'kk-big ' + cls }, text);
  const right = (x: number, y: number, dy: number, text: string, cls = 'kk-note') => add('text', { x: x + nw - 24, y: y + dy, 'text-anchor': 'end', class: cls }, text);
  const left = (x: number, y: number, dy: number, text: string, cls = 'kk-note') => add('text', { x: x + 24, y: y + dy, class: cls }, text);

  node('solar', 'SOLAR', (s.solar ?? 0) > 1 ? 'PRODUCING' : 'IDLE', (x, y) => {
    big(x, y, kkW(s.solar), (s.solar ?? 0) > 1 ? 'kk-c-solar' : 'kk-c-idle');
    right(x, y, 112, `${kkKwh(s.today.solar)} today`, 'kk-note-hi');
    const peak = Math.max(s.solarPeak ?? 0, s.solar ?? 0);
    bar(x + 24, y + 140, nw - 48, [[s.solar ?? 0, SOURCE_COLOR.solar]], peak);
    if (s.solarPeak != null) right(x, y, 176, `24 h peak ${kkW(s.solarPeak)}`);
  });
  node('grid', 'GRID', exporting ? 'EXPORTING' : importing ? 'IMPORTING' : 'IDLE', (x, y) => {
    big(x, y, kkW(s.grid), exporting ? 'kk-c-export' : importing ? 'kk-c-import' : 'kk-c-idle');
    const tw = (nw - 68) / 2, max = Math.max(s.today.imported ?? 0, s.today.exported ?? 0, 0) * 1.15;
    left(x, y, 148, 'In today'); add('text', { x: x + 24 + tw, y: y + 148, 'text-anchor': 'end', class: 'kk-note-val' }, kkKwh(s.today.imported));
    bar(x + 24, y + 160, tw, [[s.today.imported ?? 0, SOURCE_COLOR.grid]], max);
    add('text', { x: x + 44 + tw, y: y + 148, class: 'kk-note' }, 'Out today'); right(x, y, 148, kkKwh(s.today.exported), 'kk-note-val');
    bar(x + 44 + tw, y + 160, tw, [[s.today.exported ?? 0, KK_EXPORT]], max);
  });
  node('home', 'HOME', '', (x, y) => {
    big(x, y, kkW(s.home), 'kk-c-home');
    right(x, y, 112, `${kkKwh(s.today.home)} today`, 'kk-note-hi');
    const mix: [string, number, string][] = [['Solar', split.solarHome, SOURCE_COLOR.solar], ['Battery', split.batteryHome, SOURCE_COLOR.battery], ['Grid', split.gridHome, SOURCE_COLOR.grid]]
      .filter(([l]) => (s.has as any)[l.toLowerCase()]) as [string, number, string][];
    const tot = mix.reduce((t, m) => t + m[1], 0);
    bar(x + 24, y + 136, nw - 48, mix.map(([, v, c]) => [v, c] as [number, string]), tot, 14);
    let lx = x + 24;
    mix.forEach(([l, v, c]) => {
      const dot = add('circle', { cx: lx + 5, cy: y + 172, r: 5 }); dot.style.fill = c;
      add('text', { x: lx + 16, y: y + 177, class: v > 1 ? 'kk-mix' : 'kk-mix kk-mix-off' }, `${l} ${tot > 0 ? Math.round(100 * v / tot) : 0}%`);
      lx += 130;
    });
  });
  node('battery', 'BATTERY', bmode === 'charge' ? 'CHARGING' : bmode ? 'DISCHARGING' : 'IDLE', (x, y) => {
    const g = kkBattery(s.soc, 250, 92, bmode);
    g.setAttribute('x', x + 22); g.setAttribute('y', y + 66);
    svg.appendChild(g);
    right(x, y, 100, kkW(bmode ? s.battery : 0), 'kk-mid');
    if (bmode) right(x, y, 126, bmode === 'charge' ? 'in' : 'out');
    left(x, y, 182, `Today: charged ${kkKwh(s.today.charged)} · discharged ${kkKwh(s.today.discharged)}`, 'kk-note-hi');
  });
  return svg;
}

/// The last 24 hours of solar, home, grid and battery on one power axis, with hour marks.
export function kkDay(lines: { key: string; color: string; values: (number | null)[]; fill?: boolean; dash?: boolean }[], at: string[], W: number, H: number) {
  const padL = 70, padR = 10, padT = 12, padB = 28;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'kk-chart' });
  const known = lines.flatMap(l => l.values).filter((v): v is number => typeof v === 'number');
  if (known.length < 2) return svg;
  const hi = kkNice(Math.max(0, ...known)), lo = -kkNice(-Math.min(0, ...known));
  const span = hi - lo || 1, steps = Math.max(...lines.map(l => l.values.length));
  const x = (i: number) => padL + (i * (W - padL - padR)) / Math.max(1, steps - 1);
  const y = (v: number) => padT + ((hi - v) / span) * (H - padT - padB);
  const ticks = lo < 0 ? [hi, hi / 2, 0, lo] : [hi, hi / 2, 0];
  ticks.forEach(v => {
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? 'kk-zero' : 'kk-gridline' }));
    const t = svgEl('text', { x: padL - 10, y: y(v) + 5, class: 'kk-axis', 'text-anchor': 'end' });
    t.textContent = v === 0 ? '0' : (v < 0 ? '−' : '') + kkW(v);
    svg.appendChild(t);
  });
  at.forEach((iso, i) => {
    const d = new Date(iso);
    if (i === 0 || d.getHours() % 3 !== 0 || new Date(at[i - 1]).getHours() === d.getHours()) return;
    svg.appendChild(svgEl('line', { x1: x(i), x2: x(i), y1: padT, y2: H - padB, class: 'kk-gridline' }));
    const edge = x(i) > W - padR - 28;
    const t = svgEl('text', { x: edge ? W - padR : x(i), y: H - 6, class: 'kk-axis', 'text-anchor': edge ? 'end' : 'middle' });
    t.textContent = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).toLocaleTimeString([], { hour: 'numeric' });
    svg.appendChild(t);
  });
  const defs = svgEl('defs', {});
  svg.appendChild(defs);
  const z = y(Math.max(lo, 0));
  lines.forEach(l => {
    const runs: { i: number; v: number }[][] = [];
    let run: { i: number; v: number }[] = [];
    l.values.forEach((v, i) => { if (typeof v !== 'number') { if (run.length) runs.push(run); run = []; } else run.push({ i, v }); });
    if (run.length) runs.push(run);
    let fill = '';
    if (l.fill) {
      const id = kkId(), g = svgEl('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 });
      g.append(kkStop(0, l.color, .42), kkStop(1, l.color, .03));
      defs.appendChild(g); fill = `url(#${id})`;
    }
    runs.forEach(r => {
      const pts = r.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' L');
      if (fill) svg.appendChild(svgEl('path', { d: `M${x(r[0].i).toFixed(1)},${z} L${pts} L${x(r[r.length - 1].i).toFixed(1)},${z} Z`, fill, class: 'kk-area' }));
      const p = svgEl('path', { d: `M${pts}`, class: 'kk-line' + (l.dash ? ' kk-line-dash' : '') + (l.key === 'home' ? ' kk-line-home' : '') });
      p.style.setProperty('--c', l.color);
      svg.appendChild(p);
    });
  });
  return svg;
}

export function startKiosk() {
  const root: any = document.documentElement;
  root.classList.add('kiosk');
  const theme = kioskTheme(location.search);
  if (theme) root.setAttribute('data-theme', theme); else root.removeAttribute('data-theme');
  document.title = 'rPDU2MQTT';

  const live = el('span', { class: 'kk-dot' });
  const mqtt = el('span', { class: 'kk-pill' }, el('span', { class: 'kk-dot' }), 'MQTT');
  const alerts = el('div', { class: 'kk-alerts' });
  const health = el('span', { class: 'kk-health' });
  const clock = el('div', { class: 'kk-clock' });
  const date = el('div', { class: 'kk-date' });
  const head = el('header', { class: 'kk-head' },
    el('div', { class: 'kk-brand' }, el('span', { text: '⚡' }), el('span', { text: 'rPDU2MQTT' }), live),
    alerts, health, mqtt,
    el('div', { class: 'kk-time' }, clock, date));

  const card = (cls: string, label: string, color: string, ...body: any[]) => {
    const c = el('section', { class: 'kk-card ' + cls }, el('div', { class: 'kk-card-head' }, el('span', { class: 'kk-card-label' }, el('i'), label)), ...body);
    c.style.setProperty('--edge', color);
    return c;
  };
  const flow = el('div', { class: 'kk-flow' });
  const netPct = el('div', { class: 'kk-net' });
  const netStats = el('div', { class: 'kk-stats' });
  const legend = el('div', { class: 'kk-legend' });
  const chart = el('div', { class: 'kk-chart-box' });
  const loads = el('div', { class: 'kk-loads' });
  const dayCard = card('kk-day', 'Last 24 hours', KK_HOME, chart);
  dayCard.firstChild.appendChild(legend);
  const view = el('div', { id: 'kiosk', class: 'kk' }, head, flow,
    el('div', { class: 'kk-bottom' },
      card('kk-netcard', 'Net self-produced today', 'var(--good)', netPct, netStats),
      dayCard,
      card('kk-loadcard', 'Loads now', '#b06fd0', loads)));
  document.body.innerHTML = '';
  document.body.appendChild(view);

  const stat = (label: string, value: string, cls = '') =>
    el('div', { class: 'kk-stat' }, el('div', { class: 'kk-stat-label', text: label }), el('div', { class: 'kk-stat-value ' + cls, text: value }));

  const tick = () => {
    const d = new Date();
    clock.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    date.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  };
  tick();
  setInterval(tick, 5000);

  // Keeps a static screen from burning in.
  let shift = 0;
  setInterval(() => { shift = (shift + 1) % 4; view.style.transform = `translate(${[0, 2, 2, 0][shift]}px, ${[0, 0, 2, 2][shift]}px)`; }, 10 * 60_000);

  onRealtimeState(s => { live.className = 'kk-dot ' + (s === 'live' ? 'good' : s === 'down' ? 'bad' : 'warn'); });

  let bootVersion: string | null = null;
  const status = (body: any) => {
    if (!body) return;
    mqtt.className = 'kk-pill ' + (body.mqttConnected ? 'good' : 'bad');
    if (body.version) {
      if (bootVersion && body.version !== bootVersion) location.reload();
      bootVersion = bootVersion || body.version;
    }
  };

  let day: any = null;
  let solarPeak: number | null = null;

  const drawNow = (power: any, energy: any, lv: Record<string, number>) => {
    const nodes = (power?.nodes || []) as any[];
    const ids = { solar: kkIds(nodes, 'solar'), grid: kkIds(nodes, 'grid'), battery: kkIds(nodes, 'battery') };
    const solarW = kkSum(nodes, 'solar');
    const gridW = kkNet(kkSum(nodes, 'grid'), sumKnown(ids.grid.map(id => lv[`${id}|realpower#in`])));
    const battW = kkNet(kkSum(nodes, 'battery'), sumKnown(ids.battery.map(id => lv[`${id}|realpower#in`])));
    const loadW = kkIds(nodes, 'home').length ? kkSum(nodes, 'home') : undefined;
    const homeW = homeEnergy({ solar: solarW, grid: gridW, battery: battW, ...(loadW === undefined ? {} : { load: loadW }) });

    const eNodes = (energy?.nodes || []) as any[];
    const eIn = (list: string[]) => sumKnown(list.map(id => {
      const n = eNodes.find((x: any) => x.id === id + '#in');
      return typeof n?.value === 'number' ? n.value : undefined;
    }));
    const eSolar = kkSum(eNodes, 'solar');
    const eGridOut = kkSum(eNodes, 'grid'), eGridIn = eIn(ids.grid);
    const eBattOut = kkSum(eNodes, 'battery'), eBattIn = eIn(ids.battery);
    const eLoad = kkIds(eNodes, 'home').length ? kkSum(eNodes, 'home') : undefined;
    const eHome = homeEnergy({ solar: eSolar, battery: kkNet(eBattOut, eBattIn), grid: kkNet(eGridOut, eGridIn), ...(eLoad === undefined ? {} : { load: eLoad }) });
    const self = selfSufficiencyPct(eHome, eGridOut);
    const net = netSelfProducedPct(eHome, eGridOut == null || eGridIn == null ? null : eGridOut - eGridIn);

    const soc = ids.battery.map(id => lv[`${id}|soc`]).filter((v): v is number => typeof v === 'number');
    const now: KkNow = {
      solar: solarW, grid: gridW, battery: battW, home: homeW,
      soc: soc.length ? Math.max(0, Math.min(100, soc.reduce((a, b) => a + b, 0) / soc.length)) : null,
      has: { solar: ids.solar.length > 0, grid: ids.grid.length > 0, battery: ids.battery.length > 0 },
      today: { solar: eSolar, home: eHome, imported: eGridOut, exported: eGridIn, charged: eBattIn, discharged: eBattOut },
      solarPeak,
    };
    const W = flow.clientWidth, H = flow.clientHeight;
    if (W > 0 && H > 0) flow.replaceChildren(kkFlow(now, W, H));

    netPct.textContent = net == null ? '—' : `${Math.round(net)}%`;
    netPct.className = 'kk-net' + (net == null ? '' : ' ov-band-' + shareBand(net));
    netStats.replaceChildren(
      stat('Self-sufficiency', self == null ? '—' : `${Math.round(self)}%`),
      stat('Solar today', kkKwh(eSolar)),
      stat('Imported', kkKwh(eGridOut)),
      stat('Exported', kkKwh(eGridIn), 'kk-c-export'));

    const list = kkLoads(nodes, power?.links || []);
    const max = list[0]?.value || 1;
    const rows = list.slice(0, 12).map(l => {
      const fill = el('span');
      fill.style.width = `${Math.max(1, 100 * l.value / max)}%`;
      return el('div', { class: 'kk-load' },
        el('div', { class: 'kk-load-row' }, el('span', { class: 'kk-load-name', text: l.label }), el('b', { text: kkW(l.value) })),
        el('div', { class: 'kk-load-bar' }, fill));
    });
    loads.replaceChildren(...rows);
    // Only whole rows: drop what doesn't fit.
    while (loads.lastChild && loads.scrollHeight > loads.clientHeight + 1) loads.lastChild.remove();
    drawDay(false);
  };

  const drawDay = (force = true) => {
    const series = (day?.ok && day.series) || [];
    const at: string[] = day?.at || [];
    const steps = (series[0]?.values || []).length;
    const sum = (list: any[]) => !list.length ? [] : Array.from({ length: steps }, (_, i) => {
      let t = 0;
      for (const s of list) { const v = s.values[i]; if (typeof v !== 'number') return null; t += v; }
      return t as number | null;
    });
    const ofRole = (role: string, back = false) => series.filter((s: any) => s.balance === role && String(s.node).endsWith('#in') === back);
    const signed = (role: string) => {
      const o = sum(ofRole(role)), b = sum(ofRole(role, true));
      if (!o.length && !b.length) return [];
      return Array.from({ length: steps }, (_, i) => o[i] == null && b[i] == null ? null : (o[i] ?? 0) - (b[i] ?? 0));
    };
    const home = () => {
      const metered = ofRole('home');
      if (metered.length) return sum(metered);
      const parts = [sum(ofRole('solar')), signed('grid'), signed('battery')].filter(p => p.some(v => v != null));
      if (!parts.length) return [];
      return Array.from({ length: steps }, (_, i) => {
        let t = 0;
        for (const p of parts) { const v = p[i]; if (v == null) return null; t += v; }
        return t as number | null;
      });
    };
    const has = (v: (number | null)[]) => v.some(x => typeof x === 'number');
    const solar = sum(ofRole('solar'));
    const known = solar.filter((v): v is number => typeof v === 'number');
    solarPeak = known.length ? Math.max(...known) : null;
    const lines = [
      { key: 'solar', label: 'Solar', color: SOURCE_COLOR.solar, values: solar, fill: true },
      { key: 'home', label: 'Home', color: KK_HOME, values: home() },
      { key: 'grid', label: 'Grid', color: SOURCE_COLOR.grid, values: signed('grid') },
      { key: 'battery', label: 'Battery', color: SOURCE_COLOR.battery, values: signed('battery'), dash: true },
    ].filter(l => has(l.values));
    view.classList.toggle('kk-nohist', !lines.length);
    legend.replaceChildren(...lines.map(l => {
      const k = el('span', { class: 'kk-key' + (l.dash ? ' dash' : '') }); k.style.setProperty('--c', l.color);
      return el('span', {}, k, l.label);
    }));
    const W = chart.clientWidth, H = chart.clientHeight;
    if (!force && chart.dataset.size === `${W}x${H}`) return;
    chart.dataset.size = `${W}x${H}`;
    chart.replaceChildren(...(lines.length && W && H ? [kkDay(lines, at, W, H)] : []));
  };

  const loadNow = async () => {
    try {
      const [p, e] = await Promise.all([api('/api/flow?metric=realpower'), api('/api/flow?metric=energy_d')]);
      const nodes = (p.body?.nodes || []) as any[];
      const battIds = kkIds(nodes, 'battery'), gridIds = kkIds(nodes, 'grid');
      const q = [
        ...[...battIds, ...gridIds].map(id => ({ Node: id, Metric: 'realpower#in' })),
        ...battIds.map(id => ({ Node: id, Metric: 'soc' })),
      ];
      const lv: Record<string, number> = {};
      if (q.length) {
        try {
          const r = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
          (r.body?.values || []).forEach((v: any) => { if (typeof v.value === 'number') lv[`${v.node}|${v.metric}`] = v.value; });
        } catch { /* absent readings stay dashes */ }
      }
      drawNow(p.body, e.body, lv);
      view.classList.remove('kk-stale');
    } catch { view.classList.add('kk-stale'); }
  };

  const loadDay = async () => {
    try { day = (await api('/api/flow/series?minutes=1440&step=900&metric=realpower')).body; } catch { day = null; }
    drawDay();
  };

  const loadBoard = async () => {
    let list: any[] = [];
    try { list = ((await api('/api/status/board')).body?.cards) || []; } catch { list = []; }
    const wrong = list.filter((c: any) => c.level === 'bad' || c.level === 'warn')
      .sort((a: any, b: any) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));
    health.className = 'kk-health ' + (wrong.some((c: any) => c.level === 'bad') ? 'bad' : wrong.length ? 'warn' : 'good');
    health.textContent = !list.length || wrong.length ? '' : 'All healthy';
    alerts.replaceChildren(...wrong.slice(0, 3).map((c: any) => el('div', { class: 'kk-alert ' + c.level },
      el('span', { text: c.level === 'bad' ? '⛔' : '⚠' }),
      el('span', { class: 'kk-alert-title', text: c.title }),
      el('span', { class: 'kk-alert-state', text: c.state || '' }))));
    if (wrong.length > 3) alerts.appendChild(el('span', { class: 'kk-alert-more', text: `+${wrong.length - 3}` }));
  };

  let pending: any = null;
  const soon = () => { if (!pending) pending = setTimeout(() => { pending = null; loadNow(); }, 2000); };
  subscribeLive('flow:realpower', soon);
  subscribeLive('status', status);
  setInterval(() => { if (!realtimeLive()) loadNow(); }, 15_000);
  setInterval(loadDay, 5 * 60_000);
  setInterval(loadBoard, 30_000);
  setInterval(async () => { try { status((await api('/api/status')).body); } catch { /* retried */ } }, 60_000);
  window.addEventListener('resize', () => loadNow());

  api('/api/status').then((r: any) => status(r.body)).catch(() => { });
  loadDay().then(loadNow);
  loadBoard();
}

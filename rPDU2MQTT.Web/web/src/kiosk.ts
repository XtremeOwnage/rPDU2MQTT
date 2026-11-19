// Full-screen, read-only wall display at /kiosk. ?theme=dark|light picks the palette.
import { api, el, svgEl, formatNum, formatMeasure } from './helpers.js';
import { subscribeLive, realtimeLive, onRealtimeState } from './realtime.js';
import { SOURCE_COLOR } from './charts.js';
import { homeEnergy, selfSufficiencyPct, netSelfProducedPct, shareBand, sumKnown } from './energy.js';
import { findHub, flowTree, treeFill, type TreeNode } from './flow-tree.js';

export const isKiosk = () => /^\/kiosk\/?$/i.test(location.pathname || '');

/// The theme a kiosk URL asks for, or null to follow the system.
export function kioskTheme(search: string): string | null {
  const t = new URLSearchParams(search || '').get('theme');
  return t === 'dark' || t === 'light' ? t : null;
}

/// The look a kiosk URL asks for: ?style=glow|minimal, else classic.
export function kioskStyle(search: string): string {
  const v = new URLSearchParams(search || '').get('style');
  return v === 'glow' || v === 'minimal' ? v : 'classic';
}

const KK_ICON: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  solar: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
  grid: 'M13 2 4 14h7l-1 8 9-12h-7z',
  battery: 'M4 7h15a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM22 10.5v3',
  flow: 'M3 7h6c4 0 6 10 10 10h2M3 17h6c4 0 6-10 10-10h2',
};
const kkIcon = (key: string) => {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'kk-icon', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { d: KK_ICON[key] || '' }));
  return svg;
};

/// A round axis bound at or above `v`: 1, 2, 2.5 or 5 times a power of ten.
export function kkNice(v: number): number {
  if (!(v > 0)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}

const kkW = (w: number | null) => w == null ? '—'
  : Math.abs(w) >= 1000 ? `${formatNum(Math.round(w / 100) / 10)} kW` : `${formatNum(Math.round(w))} W`;
const kkKwh = (v: number | null) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} kWh`;
const kkTop = (n: any) => !String(n.id).includes('#');
const kkIds = (nodes: any[], role: string) => nodes.filter(n => n.balance === role && kkTop(n)).map(n => n.id);
const kkSum = (nodes: any[], role: string) => {
  const vals = nodes.filter(n => n.balance === role && kkTop(n) && typeof n.value === 'number').map(n => n.value);
  return vals.length ? vals.reduce((a: number, b: number) => a + b, 0) : null;
};
const kkNet = (out: number | null, back: number | null) => out == null && back == null ? null : (out || 0) - (back || 0);

const HOME_COLOR = 'var(--accent)';

/// A 24-hour area chart in pixels, with a power scale and hour marks. Below zero is drawn in `under`.
function kkChart(values: (number | null)[], at: string[], color: string, under: string, W: number, H: number) {
  const padL = 70, padR = 8, padT = 10, padB = 26;
  const known = values.filter((v): v is number => typeof v === 'number');
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'kk-chart' });
  if (known.length < 2) return svg;
  const hi = kkNice(Math.max(0, ...known)), lo = -kkNice(-Math.min(0, ...known));
  const span = hi - lo || 1;
  const x = (i: number) => padL + (i * (W - padL - padR)) / Math.max(1, values.length - 1);
  const y = (v: number) => padT + ((hi - v) / span) * (H - padT - padB);

  const ticks = lo < 0 ? [hi, 0, lo] : [hi, hi / 2, 0];
  ticks.forEach(v => {
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? 'kk-zero' : 'kk-gridline' }));
    const t = svgEl('text', { x: padL - 10, y: y(v) + 5, class: 'kk-axis', 'text-anchor': 'end' });
    t.textContent = v === 0 ? '0' : kkW(v);
    svg.appendChild(t);
  });
  at.forEach((iso, i) => {
    const d = new Date(iso);
    if (i === 0 || d.getHours() % 6 !== 0 || new Date(at[i - 1]).getHours() === d.getHours()) return;
    svg.appendChild(svgEl('line', { x1: x(i), x2: x(i), y1: padT, y2: H - padB, class: 'kk-gridline' }));
    const edge = x(i) > W - padR - 28;
    const t = svgEl('text', { x: edge ? W - padR : x(i), y: H - 6, class: 'kk-axis', 'text-anchor': edge ? 'end' : 'middle' });
    t.textContent = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).toLocaleTimeString([], { hour: 'numeric' });
    svg.appendChild(t);
  });

  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (typeof v !== 'number') { if (run.length) runs.push(run); run = []; return; }
    run.push({ i, v });
  });
  if (run.length) runs.push(run);

  const id = 'kk' + Math.random().toString(36).slice(2, 8);
  const defs = svgEl('defs', {});
  const clip = (name: string, y0: number, y1: number) => {
    const c = svgEl('clipPath', { id: id + name });
    c.appendChild(svgEl('rect', { x: 0, y: y0, width: W, height: Math.max(0, y1 - y0) }));
    defs.appendChild(c);
  };
  clip('a', 0, y(0));
  clip('b', y(0), H);
  svg.appendChild(defs);
  const z = y(0).toFixed(1);
  for (const [part, c, top] of [['a', color, true], ['b', under, false]] as [string, string, boolean][]) {
    const fade = svgEl('linearGradient', { id: id + part + 'f', gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0, y1: top ? padT : y(0), y2: top ? y(0) : H - padB });
    [[0, top ? 0.42 : 0.04], [1, top ? 0.04 : 0.42]].forEach(([o, a]) => {
      const st = svgEl('stop', { offset: o });
      st.style.stopColor = c; st.style.stopOpacity = String(a);
      fade.appendChild(st);
    });
    defs.appendChild(fade);
    const g = svgEl('g', { 'clip-path': `url(#${id + part})` });
    runs.forEach(r => {
      const line = r.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' L');
      g.appendChild(svgEl('path', { d: `M${x(r[0].i).toFixed(1)},${z} L${line} L${x(r[r.length - 1].i).toFixed(1)},${z} Z`, fill: `url(#${id + part}f)`, class: 'kk-area' }));
      const path = svgEl('path', { d: `M${line}`, fill: 'none', stroke: c, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'kk-line' });
      path.style.setProperty('--c', c);
      g.appendChild(path);
    });
    svg.appendChild(g);
  }
  return svg;
}

type KkBar = { key: string; label: string; value: number; color: string; col: number; y: number; h: number; out: number; in: number };

/// The flow as a Sankey in pixels: supply, the hub, what it feeds, and what those feed.
export function kkSankey(nodes: any[], links: any[], W: number, H: number, units: string) {
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'kk-sankey' });
  const byId = new Map(nodes.map((n: any) => [n.id, n]));
  const { hub, supply } = findHub(nodes, links);
  const { top, total } = flowTree(nodes, links, hub, 'out');
  if (!(total > 0)) return svg;

  const GAP = 10, MIN = 18, BAR = 16;
  const cols: KkBar[][] = [];
  const edges: { a: KkBar; b: KkBar; v: number; color: string }[] = [];
  const bar = (key: string, label: string, value: number, color: string, col: number): KkBar =>
    ({ key, label, value, color, col, y: 0, h: 0, out: 0, in: 0 });

  let hubBar: KkBar | null = null;
  if (hub) {
    const src = supply.map(id => {
      const v = links.filter((l: any) => l.source === id && l.target === hub).reduce((t: number, l: any) => t + Math.max(0, l.value || 0), 0);
      const n: any = byId.get(id);
      return bar(id, n?.label || id, v, (SOURCE_COLOR as any)[n?.kind] || 'var(--muted)', 0);
    }).filter(b => b.value > 0).sort((a, b) => b.value - a.value);
    const hn: any = byId.get(hub);
    hubBar = bar(hub, hn?.label || hub, Math.max(total, src.reduce((t, b) => t + b.value, 0)), HOME_COLOR, src.length ? 1 : 0);
    if (src.length) { cols.push(src); src.forEach(b => edges.push({ a: b, b: hubBar!, v: b.value, color: b.color })); }
    cols.push([hubBar]);
  }
  const scaleOf = (count: number) => (H - GAP * Math.max(0, count - 1)) / Math.max(total, hubBar?.value || 0);

  // How many fit at a readable height, the rest folded into one.
  const fold = (list: TreeNode[], k: number, room: number) => {
    const shown: TreeNode[] = [];
    let used = 0;
    for (const t of list) {
      if (t.value * k < MIN || used + t.value * k > room + 1) break;
      shown.push(t); used += t.value * k + GAP;
    }
    if (list.length - shown.length === 1 && list[shown.length].value * k >= 2) shown.push(list[shown.length]);
    return { shown, rest: list.slice(shown.length).reduce((t, x) => t + x.value, 0) };
  };
  let k = scaleOf(Math.min(top.length, 14));
  const l1 = fold(top, k, H);
  const c1 = l1.shown.map(t => ({ t, b: bar(t.key, t.label, t.value, treeFill(t), cols.length) }));
  const col1 = c1.map(x => x.b);
  if (l1.rest > 0) col1.push(bar('other', 'Other', l1.rest, 'var(--faint)', cols.length));
  cols.push(col1);
  if (hubBar) col1.forEach(b => edges.push({ a: hubBar!, b, v: b.value, color: b.color }));

  const col2: KkBar[] = [];
  c1.forEach(({ t, b: parent }) => fold(t.children, k, H).shown.forEach(c => {
    const b = bar(c.key, c.label, c.value, treeFill(c), cols.length);
    col2.push(b);
    edges.push({ a: parent, b, v: c.value, color: b.color });
  }));
  if (col2.length) cols.push(col2);

  k = Math.min(...cols.map(c => scaleOf(c.length)));
  cols.forEach(c => {
    let y = 0;
    c.forEach(b => { b.h = Math.max(2, b.value * k); b.y = y; y += b.h + GAP; });
    const spare = H - (y - GAP);
    if (c.length && spare > 0 && c[0].col <= 1) c.forEach(b => { b.y += spare / 2; });
  });

  const labelL = 190, labelR = 250;
  const span = W - labelL - labelR - BAR;
  const xOf = (col: number) => labelL + (cols.length === 1 ? 0 : (col * span) / (cols.length - 1));
  const phase = -(Date.now() % 1600);
  const defs = svgEl('defs', {});
  svg.appendChild(defs);
  let gid = 0;
  const gtag = Math.random().toString(36).slice(2, 7);
  const gradient = (from: string, to: string, x0: number, x1: number) => {
    const id = `kkg${gtag}${gid++}`;
    const g = svgEl('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: x0, x2: x1, y1: 0, y2: 0 });
    [[0, from], [1, to]].forEach(([o, c]) => { const st = svgEl('stop', { offset: o }); st.style.stopColor = c as string; g.appendChild(st); });
    defs.appendChild(g);
    return id;
  };
  edges.forEach(e => {
    const h = Math.max(1, e.v * k);
    const x0 = xOf(e.a.col) + BAR, x1 = xOf(e.b.col);
    const y0 = e.a.y + e.a.out, y1 = e.b.y + e.b.in;
    e.a.out += h; e.b.in += h;
    const m = (x0 + x1) / 2;
    svg.appendChild(svgEl('path', {
      d: `M${x0},${y0} C${m},${y0} ${m},${y1} ${x1},${y1} L${x1},${y1 + h} C${m},${y1 + h} ${m},${y0 + h} ${x0},${y0 + h} Z`,
      fill: `url(#${gradient(e.a.color, e.b.color, x0, x1)})`, class: 'kk-band',
    }));
    const line = svgEl('path', { d: `M${x0},${y0 + h / 2} C${m},${y0 + h / 2} ${m},${y1 + h / 2} ${x1},${y1 + h / 2}`, class: 'kk-pulse' });
    line.style.strokeWidth = String(Math.min(3, Math.max(1, h / 4)));
    line.style.animationDelay = phase + 'ms';
    svg.appendChild(line);
  });
  cols.flat().forEach(b => {
    const x = xOf(b.col);
    svg.appendChild(svgEl('rect', { x, y: b.y, width: BAR, height: b.h, rx: 3, fill: b.color }));
    if (b.h < 14) return;
    const left = b.col === 0 && cols.length > 1;
    const tx = left ? x - 10 : x + BAR + 10, anchor = left ? 'end' : 'start';
    const two = b.h >= 40;
    const name = svgEl('text', { x: tx, y: b.y + b.h / 2 + (two ? -4 : 5), 'text-anchor': anchor, class: 'kk-sk-name' });
    name.textContent = two ? b.label : `${b.label} · ${formatMeasure(b.value, units)}`;
    svg.appendChild(name);
    if (two) {
      const val = svgEl('text', { x: tx, y: b.y + b.h / 2 + 16, 'text-anchor': anchor, class: 'kk-sk-val' });
      val.textContent = formatMeasure(b.value, units);
      svg.appendChild(val);
    }
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

  /// One source: its reading now, its figures for today, and its last 24 hours.
  const card = (key: string, label: string, color: string) => {
    const c = {
      key, color,
      box: el('section', { class: 'kk-card kk-' + key }),
      state: el('span', { class: 'kk-state' }),
      now: el('div', { class: 'kk-now' }),
      extra: el('div', { class: 'kk-extra' }),
      stats: el('div', { class: 'kk-stats' }),
      chart: el('div', { class: 'kk-chart-box' }),
    };
    c.box.style.setProperty('--edge', color);
    c.box.append(
      el('div', { class: 'kk-card-head' }, el('span', { class: 'kk-card-label' }, kkIcon(key), label), c.state),
      el('div', { class: 'kk-card-main' }, c.now, c.extra), c.stats,
      c.chart);
    return c;
  };
  const cards: Record<string, any> = {
    home: card('home', 'Home', HOME_COLOR),
    solar: card('solar', 'Solar', SOURCE_COLOR.solar),
    grid: card('grid', 'Grid', SOURCE_COLOR.grid),
    battery: card('battery', 'Battery', SOURCE_COLOR.battery),
  };
  const sources = el('div', { class: 'kk-sources' }, ...Object.values(cards).map(c => c.box));
  const flow = el('div', { class: 'kk-flow-box' });
  const view = el('div', { id: 'kiosk', class: 'kk' }, head, sources,
    el('section', { class: 'kk-card kk-flow' }, el('div', { class: 'kk-card-head' }, el('span', { class: 'kk-card-label' }, kkIcon('flow'), 'Flow')), flow));
  view.dataset.kstyle = kioskStyle(location.search);
  (view.lastChild as any).style.setProperty('--edge', HOME_COLOR);
  document.body.innerHTML = '';
  document.body.appendChild(view);

  const stat = (label: string, value: string, band?: number | null) =>
    el('div', { class: 'kk-stat' }, el('div', { class: 'kk-stat-label', text: label }),
      el('div', { class: 'kk-stat-value' + (band ? ' ov-band-' + band : ''), text: value }));

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
  let peaks: Record<string, number | null> = {};

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
    const netPct = netSelfProducedPct(eHome, eGridOut == null || eGridIn == null ? null : eGridOut - eGridIn);

    const idle = (w: number | null) => w == null || Math.abs(w) <= 1;
    const set = (c: any, now: string, state: string, stats: any[], extra?: any) => {
      c.now.textContent = now;
      c.state.textContent = state;
      c.stats.replaceChildren(...stats);
      c.extra.replaceChildren(...(extra ? [extra] : []));
    };

    set(cards.home, kkW(homeW), '', [
      stat('Today', kkKwh(eHome)),
      stat('Self-sufficiency', self == null ? '—' : `${Math.round(self)}%`),
      stat('Self-produced (net)', netPct == null ? '—' : `${Math.round(netPct)}%`, netPct == null ? null : shareBand(netPct)),
    ]);

    cards.solar.box.hidden = !ids.solar.length;
    set(cards.solar, kkW(solarW), idle(solarW) ? 'idle' : 'producing', [
      stat('Today', kkKwh(eSolar)),
      stat('Peak', kkW(peaks.solar ?? null)),
    ]);

    cards.grid.box.hidden = !ids.grid.length;
    set(cards.grid, kkW(gridW == null ? null : Math.abs(gridW)), idle(gridW) ? 'idle' : gridW! > 0 ? 'importing' : 'exporting', [
      stat('Imported', kkKwh(eGridOut)),
      stat('Exported', kkKwh(eGridIn)),
    ]);
    cards.grid.box.classList.toggle('is-export', !idle(gridW) && gridW! < 0);

    cards.battery.box.hidden = !ids.battery.length;
    const soc = ids.battery.map(id => lv[`${id}|soc`]).filter((v): v is number => typeof v === 'number');
    const pct = soc.length ? Math.max(0, Math.min(100, Math.round(soc.reduce((a, b) => a + b, 0) / soc.length))) : null;
    const gauge = el('div', { class: 'kk-gauge ' + (pct == null ? '' : pct >= 60 ? 'good' : pct >= 25 ? 'warn' : 'bad') },
      el('div', { class: 'kk-gauge-fill' }), el('span', { class: 'kk-gauge-text', text: pct == null ? '—' : pct + '%' }));
    gauge.firstChild.style.width = (pct ?? 0) + '%';
    set(cards.battery, kkW(battW == null ? null : Math.abs(battW)), idle(battW) ? 'idle' : battW! < 0 ? 'charging' : 'discharging', [
      stat('Charged', kkKwh(eBattIn)),
      stat('Discharged', kkKwh(eBattOut)),
    ], gauge);

    const W = flow.clientWidth, H = flow.clientHeight;
    if (W > 0 && H > 0) flow.replaceChildren(kkSankey(nodes, power?.links || [], W, H, power?.units || 'W'));
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
    const lines: Record<string, (number | null)[]> = { home: home(), solar: sum(ofRole('solar')), grid: signed('grid'), battery: signed('battery') };
    const known = (v: (number | null)[]) => v.filter((x): x is number => typeof x === 'number');
    peaks = { solar: known(lines.solar).length ? Math.max(...known(lines.solar)) : null };
    Object.values(cards).forEach(c => {
      const values = lines[c.key] || [];
      c.box.classList.toggle('no-chart', !known(values).length);
      const W = c.chart.clientWidth, H = c.chart.clientHeight;
      if (!force && c.chart.dataset.size === `${W}x${H}`) return;
      c.chart.dataset.size = `${W}x${H}`;
      if (!known(values).length || !W || !H) { c.chart.replaceChildren(); return; }
      const under = c.key === 'grid' ? SOURCE_COLOR.gridExport : c.color;
      c.chart.replaceChildren(kkChart(values, at, c.color, under, W, H));
    });
    view.classList.toggle('kk-nohist', Object.values(cards).every(c => !known(lines[c.key] || []).length));
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

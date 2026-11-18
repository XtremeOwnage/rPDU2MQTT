// Full-screen, read-only wall display at /kiosk. ?theme=dark|light picks the palette.
import { api, el, formatNum } from './helpers.js';
import { subscribeLive, realtimeLive, onRealtimeState } from './realtime.js';
import { drawEnergyFlow, type FlowArm } from './energy-diagram.js';
import { sparkline, KIND_COLOR, SOURCE_COLOR } from './charts.js';
import { homeEnergy, selfSufficiencyPct, netSelfProducedPct, shareBand, sumKnown } from './energy.js';

export const isKiosk = () => /^\/kiosk\/?$/i.test(location.pathname || '');

/// The theme a kiosk URL asks for, or null to follow the system.
export function kioskTheme(search: string): string | null {
  const t = new URLSearchParams(search || '').get('theme');
  return t === 'dark' || t === 'light' ? t : null;
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

/// Measured leaf nodes drawing power, largest first.
export function topLoads(graph: any, limit: number) {
  const nodes = (graph?.nodes || []) as any[];
  const sources = new Set(((graph?.links || []) as any[]).map(l => l.source));
  return nodes
    .filter(n => kkTop(n) && !sources.has(n.id) && !n.balance && typeof n.value === 'number' && n.value > 1
      && !['solar', 'grid', 'battery', 'unmeasured'].includes(n.kind))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

export function startKiosk() {
  const root: any = document.documentElement;
  root.classList.add('kiosk');
  const theme = kioskTheme(location.search);
  if (theme) root.setAttribute('data-theme', theme); else root.removeAttribute('data-theme');
  document.title = 'rPDU2MQTT';

  const live = el('span', { class: 'kk-dot' });
  const mqtt = el('span', { class: 'kk-pill' }, el('span', { class: 'kk-dot' }), 'MQTT');
  const health = el('span', { class: 'kk-health' });
  const clock = el('div', { class: 'kk-clock' });
  const date = el('div', { class: 'kk-date' });
  const head = el('header', { class: 'kk-head' },
    el('div', { class: 'kk-brand' }, el('span', { text: '⚡' }), el('span', { text: 'rPDU2MQTT' }), live),
    health, mqtt,
    el('div', { class: 'kk-time' }, clock, date));

  const alerts = el('div', { class: 'kk-alerts' });
  const flow = el('div', { class: 'energy-flow kk-flow' });
  const batt = el('div', { class: 'kk-batt' });
  const today = el('div', { class: 'kk-today' });
  const loads = el('div', { class: 'kk-loads' });
  const strips = el('div', { class: 'kk-strips' });

  const panel = (cls: string, title: string, ...body: any[]) =>
    el('section', { class: 'kk-panel ' + cls }, el('h2', { class: 'kk-h', text: title }), ...body);

  const day = panel('kk-24', 'Last 24 hours', strips);
  const view = el('div', { id: 'kiosk', class: 'kk' }, head, alerts,
    el('div', { class: 'kk-grid' },
      panel('kk-now', 'Now', el('div', { class: 'kk-now-body' }, flow, batt)),
      panel('kk-day', 'Today', today),
      panel('kk-top', 'Top loads', loads),
      day));
  document.body.innerHTML = '';
  document.body.appendChild(view);

  const tick = () => {
    const d = new Date();
    clock.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    date.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  };
  tick();
  setInterval(tick, 5000);

  onRealtimeState(s => { live.className = 'kk-dot ' + (s === 'live' ? 'good' : s === 'down' ? 'bad' : 'warn'); });

  let bootVersion: string | null = null;
  const status = (body: any) => {
    if (!body) return;
    mqtt.className = 'kk-pill ' + (body.mqttConnected ? 'good' : 'bad');
    // A new build is served: load it.
    if (body.version) {
      if (bootVersion && body.version !== bootVersion) location.reload();
      bootVersion = bootVersion || body.version;
    }
  };

  const tile = (edge: string | null, label: string, value: string, band?: number | null) => {
    const t = el('div', { class: 'kk-tile' },
      el('div', { class: 'kk-tile-label', text: label }),
      el('div', { class: 'kk-tile-value' + (band ? ' ov-band-' + band : ''), text: value }));
    if (edge) t.style.setProperty('--edge', edge);
    return t;
  };

  const drawBattery = (soc: number | null, watts: number | null) => {
    batt.innerHTML = '';
    const pct = soc == null ? null : Math.max(0, Math.min(100, Math.round(soc)));
    const level = pct == null ? 'unknown' : pct >= 60 ? 'good' : pct >= 25 ? 'warn' : 'bad';
    const fill = el('div', { class: 'ov-batt-fill' });
    fill.style.height = (pct ?? 0) + '%';
    const what = watts == null || Math.abs(watts) <= 1 ? 'idle' : watts < 0 ? 'charging' : 'discharging';
    batt.append(el('div', { class: 'ov-batt-body kk-batt-body ov-batt-' + level },
      el('div', { class: 'ov-batt-shell' }, fill, el('div', { class: 'ov-batt-cap' })),
      el('div', {},
        el('div', { class: 'kk-batt-pct', text: pct == null ? '—' : pct + '%' }),
        el('div', { class: 'kk-tile-sub', text: what }))));
  };

  const drawNow = (power: any, energy: any, lv: Record<string, number>) => {
    const nodes = (power?.nodes || []) as any[];
    const solarIds = kkIds(nodes, 'solar'), gridIds = kkIds(nodes, 'grid'), battIds = kkIds(nodes, 'battery');
    const solarW = kkSum(nodes, 'solar');
    const gridNet = kkNet(kkSum(nodes, 'grid'), sumKnown(gridIds.map(id => lv[`${id}|realpower#in`])));
    const battNet = kkNet(kkSum(nodes, 'battery'), sumKnown(battIds.map(id => lv[`${id}|realpower#in`])));
    const loadW = kkIds(nodes, 'home').length ? kkSum(nodes, 'home') : undefined;
    const homeW = homeEnergy({ solar: solarW, grid: gridNet, battery: battNet, ...(loadW === undefined ? {} : { load: loadW }) });

    const arms: FlowArm[] = [];
    if (solarIds.length) arms.push({ key: 'solar', icon: '☀', label: 'Solar', text: kkW(solarW), color: KIND_COLOR.solar, flow: solarW });
    if (gridIds.length) arms.push({ key: 'grid', icon: '⚡', label: 'Grid', text: kkW(gridNet == null ? null : Math.abs(gridNet)), color: KIND_COLOR.grid, flow: gridNet });
    if (battIds.length) arms.push({ key: 'battery', icon: '🔋', label: 'Battery', text: kkW(battNet == null ? null : Math.abs(battNet)), color: KIND_COLOR.battery, flow: battNet });
    arms.push({ key: 'home', icon: '⌂', label: 'Home', text: kkW(homeW), color: 'var(--accent)', flow: homeW == null ? null : -homeW });
    drawEnergyFlow(flow, arms);

    batt.hidden = !battIds.length;
    if (battIds.length) {
      const soc = battIds.map(id => lv[`${id}|soc`]).filter((v): v is number => typeof v === 'number');
      drawBattery(soc.length ? soc.reduce((a, b) => a + b, 0) / soc.length : null, battNet);
    }

    const eNodes = (energy?.nodes || []) as any[];
    const eIn = (ids: string[]) => sumKnown(ids.map(id => {
      const n = eNodes.find((x: any) => x.id === id + '#in');
      return typeof n?.value === 'number' ? n.value : undefined;
    }));
    const eSolar = kkSum(eNodes, 'solar');
    const eGridOut = kkSum(eNodes, 'grid'), eGridIn = eIn(gridIds);
    const eBatt = kkNet(kkSum(eNodes, 'battery'), eIn(battIds));
    const eLoad = kkIds(eNodes, 'home').length ? kkSum(eNodes, 'home') : undefined;
    const eHome = homeEnergy({ solar: eSolar, battery: eBatt, grid: kkNet(eGridOut, eGridIn), ...(eLoad === undefined ? {} : { load: eLoad }) });
    const self = selfSufficiencyPct(eHome, eGridOut);
    const netPct = netSelfProducedPct(eHome, eGridOut == null || eGridIn == null ? null : eGridOut - eGridIn);

    today.innerHTML = '';
    if (solarIds.length) today.appendChild(tile(SOURCE_COLOR.solar, 'Solar produced', kkKwh(eSolar)));
    today.appendChild(tile('var(--accent)', 'Home used', kkKwh(eHome)));
    if (gridIds.length) {
      today.appendChild(tile(SOURCE_COLOR.grid, 'Grid imported', kkKwh(eGridOut)));
      today.appendChild(tile(SOURCE_COLOR.gridExport, 'Grid exported', kkKwh(eGridIn)));
    }
    today.appendChild(tile(null, 'Self-sufficiency', self == null ? '—' : `${Math.round(self)}%`));
    today.appendChild(tile(null, 'Self-produced (net)', netPct == null ? '—' : `${Math.round(netPct)}%`,
      netPct == null ? null : shareBand(netPct)));

    loads.innerHTML = '';
    const list = topLoads(power, 12);
    const max = list.length ? list[0].value : 1;
    if (!list.length) loads.appendChild(el('div', { class: 'kk-empty', text: '—' }));
    list.forEach((n: any) => {
      const bar = el('div', { class: 'kk-load-bar' });
      bar.style.width = Math.max(2, (n.value / max) * 100) + '%';
      loads.appendChild(el('div', { class: 'kk-load' },
        el('div', { class: 'kk-load-row' }, el('span', { class: 'kk-load-name', text: n.label || n.id }), el('span', { class: 'kk-load-val', text: kkW(n.value) })),
        el('div', { class: 'kk-load-track' }, bar)));
    });
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
    let body: any = null;
    try { body = (await api('/api/flow/series?minutes=1440&step=900&metric=realpower')).body; } catch { body = null; }
    strips.innerHTML = '';
    const series = (body?.ok && body.series) || [];
    day.hidden = !series.length;
    if (!series.length) return;
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
    ([['solar', 'Solar'], ['grid', 'Grid'], ['battery', 'Battery'], ['home', 'Home']] as [string, string][]).forEach(([kind, label]) => {
      const values = kind === 'home' ? home() : sum(ofRole(kind));
      const known = values.filter((v): v is number => typeof v === 'number');
      if (!known.length) return;
      const peak = Math.max(...known);
      const color = kind === 'home' ? 'var(--accent)' : (KIND_COLOR[kind] || 'var(--accent)');
      const strip = el('div', { class: 'kk-strip' },
        el('div', { class: 'kk-strip-head' },
          el('span', { class: 'kk-tile-label', text: label }),
          el('span', { class: 'kk-strip-peak', text: `peak ${kkW(peak)}` })),
        el('div', { class: 'kk-spark' }, sparkline({
          values, color, units: body.units || 'W', width: 400, height: 120,
        })));
      strip.style.setProperty('--edge', color);
      strips.appendChild(strip);
    });
    day.hidden = !strips.childElementCount;
  };

  const loadBoard = async () => {
    let cards: any[] = [];
    try { cards = ((await api('/api/status/board')).body?.cards) || []; } catch { cards = []; }
    const wrong = cards.filter((c: any) => c.level === 'bad' || c.level === 'warn')
      .sort((a: any, b: any) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));
    health.className = 'kk-health ' + (wrong.some((c: any) => c.level === 'bad') ? 'bad' : wrong.length ? 'warn' : 'good');
    health.textContent = !cards.length ? '' : wrong.length ? `${wrong.length} alert${wrong.length === 1 ? '' : 's'}` : 'All healthy';
    alerts.innerHTML = '';
    alerts.hidden = !wrong.length;
    wrong.slice(0, 4).forEach((c: any) => alerts.appendChild(el('div', { class: 'kk-alert ' + c.level },
      el('span', { text: c.level === 'bad' ? '⛔' : '⚠' }),
      el('span', { class: 'kk-alert-title', text: c.title }),
      el('span', { class: 'kk-alert-state', text: c.state || '' }))));
  };

  let pending: any = null;
  const soon = () => { if (!pending) pending = setTimeout(() => { pending = null; loadNow(); }, 1000); };
  subscribeLive('flow:realpower', soon);
  subscribeLive('status', status);
  setInterval(() => { if (!realtimeLive()) loadNow(); }, 15_000);
  setInterval(loadDay, 5 * 60_000);
  setInterval(loadBoard, 30_000);
  setInterval(async () => { try { status((await api('/api/status')).body); } catch { /* retried */ } }, 60_000);

  api('/api/status').then((r: any) => status(r.body)).catch(() => { });
  loadNow();
  loadDay();
  loadBoard();
}

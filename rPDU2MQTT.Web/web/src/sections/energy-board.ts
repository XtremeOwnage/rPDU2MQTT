// The Energy Overview: solar / battery / grid / home as tiles and an animated diagram.
import { api, btn, el, activate, formatNum, svgEl, navLink, instanceSelector, withInstance } from '../helpers.js';
import { liveWhileActive, realtimeLive } from '../realtime.js';
import { state } from '../state.js';
// The energy rules every view shares — see energy.ts for why they are not written twice.
import { homeEnergy, selfSufficiencyPct, coveredEnergy } from '../energy.js';
import { sparkline } from '../charts.js';
import { requestFocus } from '../state.js';
import { historyControl, historyQuery, historyNote, periodRow, periodWindow, type PeriodKey } from '../history-control.js';
import { drawEnergyFlow, type FlowArm } from '../energy-diagram.js';


// The Energy overview (#energy-rollup C): an at-a-glance board of where power is flowing right now —
export function addEnergyOverviewSection(nav: any, sections: any) {
  const link = navLink(nav, "Energy", "⚡");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Energy Overview' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Where your power is flowing right now, from the latest poll. Figures are summed from the nodes you tagged solar / battery / grid; anything unmeasured shows “—”, never a guess. Tag nodes and bind their sources on the Nodes tab.' }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  // Power now, or energy for the day so far (#371).
  const showSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  showSel.appendChild(el('option', { value: 'realpower', text: 'Power (W)' }));
  showSel.appendChild(el('option', { value: 'energytoday', text: 'Energy today (kWh)' }));
  const instSel = instanceSelector(() => load());
  const status = el('span', { class: 'ld-count' });
  bar.append(refresh, el('span', { class: 'desc', style: { margin: '0' }, text: 'Show:' }), showSel, instSel.wrap, status);
  sec.appendChild(bar);
  // As on the Flow page: a whole day is an energy question, a specific time is a power one.
  let hadDay = false;
  const hist = historyControl((what: any) => {
    periods.mark(null);
    const leftLive = what === 'day' && !hadDay && !!hist.day();
    hadDay = !!hist.day();
    if ((leftLive && !hist.time() && showSel.value === 'realpower') || (what === 'span' && hist.span() > 1))
      showSel.value = 'energytoday';
    load();
  });
  // One click for the periods people actually ask for. A period is a question about energy — "how much
  // today" — so it answers in energy rather than leaving a power reading under a heading about a month.
  const periods = periodRow((key: PeriodKey) => {
    const { day, days } = periodWindow(key);
    hist.set(day, days);
    showSel.value = 'energytoday';
    periods.mark(key);
    hadDay = true;
    load();
  });
  sec.appendChild(periods.row);
  sec.appendChild(hist.row);
  showSel.onchange = () => load();

  // One column for the whole board.
  const board = el('div', { class: 'energy-board' }); sec.appendChild(board);
  const flowWrap = el('div', { class: 'energy-flow' }); board.appendChild(flowWrap);
  const grid = el('div', { class: 'energy-grid' }); board.appendChild(grid);
  const summary = el('div', { class: 'energy-summary' }); board.appendChild(summary);

  const fmtPower = (w: number | null) => w == null ? '—'
    : Math.abs(w) >= 1000 ? `${formatNum(w / 1000)} kW` : `${formatNum(Math.round(w))} W`;
  // Energy is cumulative (kWh); one decimal is plenty and the units come from the energy graph itself.
  const fmtEnergy = (v: number | null, units: string) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} ${units || 'kWh'}`;

  // A tile: coloured accent, big power figure, a direction/idle sub-line.
  const gaugeArc = (fraction: number, over: boolean) => {
    const R = 26, CX = 30, CY = 30;
    // A 240° sweep opening at the bottom — the shape a dial is read as.
    const START = 150, SWEEP = 240;
    const pt = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      return `${(CX + R * Math.cos(r)).toFixed(2)},${(CY + R * Math.sin(r)).toFixed(2)}`;
    };
    const arc = (from: number, to: number, cls: string, extra: Record<string, string> = {}) => svgEl('path', {
      d: `M${pt(from)} A${R},${R} 0 ${to - from > 180 ? 1 : 0} 1 ${pt(to)}`,
      fill: 'none', 'stroke-width': '6', 'stroke-linecap': 'round', class: cls, ...extra,
    });
    const g = svgEl('svg', { viewBox: '0 0 60 60', class: 'gauge', width: '60', height: '60' });
    g.appendChild(arc(START, START + SWEEP, 'gauge-track'));
    if (fraction > 0) g.appendChild(arc(START, START + SWEEP * fraction, over ? 'gauge-fill over' : 'gauge-fill'));
    return g;
  };

  const tile = (cls: string, icon: string, label: string, value: string, sub: string, subCls = '',
                gauge?: { fraction: number, over: boolean, max: number, units: string },
                trend?: { values: (number | null)[], color: string, units: string, at?: (i: number) => string },
                link?: { ids: string[], label: string }) => {
    const t = el('div', { class: 'energy-tile' + (cls ? ' ' + cls : '') });
    const head = el('div', { class: 'energy-head' });
    head.append(el('span', { class: 'energy-icon', text: icon }), el('span', { class: 'energy-label', text: label }));
    t.append(head, el('div', { class: 'energy-value', text: value }), el('div', { class: 'energy-sub' + (subCls ? ' ' + subCls : ''), text: sub }));
    if (gauge) {
      const wrap = el('div', { class: 'gauge-wrap' });
      wrap.appendChild(gaugeArc(gauge.fraction, gauge.over));
      wrap.appendChild(el('span', {
        class: 'gauge-cap' + (gauge.over ? ' over' : ''),
        text: gauge.over ? `over ${formatNum(gauge.max)} ${gauge.units}` : `of ${formatNum(gauge.max)} ${gauge.units}`,
      }));
      wrap.title = gauge.over
        ? `This reading is past the ${formatNum(gauge.max)} ${gauge.units} maximum set for this node, so the dial `
          + 'shows full. The reading is not wrong — the stated maximum is too low. Change it on the Nodes tab.'
        : `${Math.round(gauge.fraction * 100)}% of the ${formatNum(gauge.max)} ${gauge.units} maximum set for this node.`;
      t.appendChild(wrap);
    }
    // The shape behind the number. A tile without one looks exactly as it did before — no placeholder, and
    // no flat line standing in for readings nobody has.
    if (trend) t.appendChild(sparkline({ values: trend.values, color: trend.color, units: trend.units, at: trend.at }));
    if (link && link.ids.length) openOnClick(t, link.ids, link.label);
    return t;
  };

  /// Make something a way into this node's own day on the Trends page.
  ///
  /// The board answers "what is happening now"; the obvious next question is "and what has it been doing
  /// today", which was three deliberate steps away — open Trends, change the range, then untick everything
  /// that is not this. The click carries the node set the tile was summed from, so the answer is about the
  /// same nodes the figure came from rather than whatever Trends happened to be showing.
  const openOnClick = (elm: any, ids: string[], label: string) => {
    elm.classList?.add('is-linked');
    elm.style.cursor = 'pointer';
    if (elm.setAttribute) elm.setAttribute('tabindex', '0');
    const title = `Show ${label} for today on the Trends page`;
    if (elm.setAttribute) elm.setAttribute('title', title); else elm.title = title;

    const go = () => {
      requestFocus(ids, 'today=1&step=300', label);
      const link = [...document.querySelectorAll('nav a')].find((a: any) => (a.dataset?.label || '') === 'Trends');
      if (link) (link as any).click();
    };
    elm.addEventListener('click', go);
    elm.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault?.(); go(); } });
  };

  /// One trend per tile, summed across the nodes that tile is made of.
  ///
  /// Strict on gaps: a step counts only when EVERY node behind the tile reported at it. A partial sum drawn
  /// as a total is the same lie as a fabricated reading — three MPPTs where one dropped out would show the
  /// array's output falling, when what fell was the coverage.
  const trendFor = (ids: string[], color: string, units: string) => {
    if (!ids.length || !trendSeries) return undefined;
    const rows = ids.map(id => trendSeries!.byNode.get(id)).filter(Boolean) as (number | null)[][];
    if (rows.length !== ids.length || !rows.length) return undefined;

    const values = rows[0].map((_, i) =>
      rows.every(r => r[i] != null && Number.isFinite(r[i] as number))
        ? rows.reduce((sum, r) => sum + (r[i] as number), 0)
        : null);
    return values.some(v => v != null) ? { values, color, units, at: trendSeries!.at } : undefined;
  };

  /// The gauge for a node, or undefined when one would be a guess.
  const gaugeFor = (ids: string[], value: number | null, units: string) => {
    const cfgNodes = (state.data?.EnergyFlow?.Nodes || []) as any[];
    // Several tagged nodes of one kind (three MPPTs, two arrays) sum into one tile, so their ceilings sum too.
    const maxes = ids.map(id => cfgNodes.find(n => n.Id === id)?.Max).filter((m: any) => typeof m === 'number' && m > 0);
    if (!maxes.length || value == null) return undefined;
    const max = maxes.reduce((a: number, b: number) => a + b, 0);
    const fraction = Math.min(1, Math.max(0, value / max));
    return { fraction, over: value > max, max, units };
  };

  const drawFlow = (arms: FlowArm[]) =>
    drawEnergyFlow(flowWrap, arms, (a, g) => openOnClick(g, a.ids!, a.label));

  // Why is this tile empty?
  const whyNoReading = (kind: string) => {
    const nodes = (state.data?.EnergyFlow?.Nodes || []).filter((n: any) => (n.Kind || '') === kind);
    if (!nodes.length) return 'no reading yet';
    const bound = nodes.flatMap((n: any) => n.Sources || []);
    if (!bound.length)
      return nodes.some((n: any) => n.Value != null) ? 'static value only' : 'no source bound';
    // Bound but silent: name what it is waiting on, so the topic/register can be checked against reality.
    const first = bound[0];
    const what = first.Type === 'modbus'
      ? `${first.Connection || 'modbus'} reg ${first.Register}`
      : (first.Topic || 'its source');
    return bound.length > 1 ? `waiting on ${bound.length} sources` : `waiting on ${what}`;
  };
  // The hint under a tile: the direction when there's a value, the reason when there isn't.
  const subOrWhy = (value: number | null, kind: string, whenKnown: string) => value == null ? whyNoReading(kind) : whenKnown;

  // Same question for the battery's state of charge.
  const whyNoSoc = (battIds: string[], liveInfo: Record<string, any>) => {
    const cfg = (state.data?.EnergyFlow?.Nodes || []).filter((n: any) => battIds.includes(n.Id));
    if (!cfg.length) return 'no battery node';
    const socSrcs = cfg.flatMap((n: any) => (n.Sources || []).filter((s: any) => s.Metric === 'soc'));
    if (!socSrcs.length) return 'no charge source bound';
    // Bound and expired: the endpoint still reports the last reading.
    const stale = battIds.map(id => liveInfo[`${id}|soc`]).find((i: any) => i && i.reported != null);
    if (stale) {
      const secs = Math.round(stale.ageSeconds || 0);
      const ago = secs >= 3600 ? `${Math.round(secs / 360) / 10} h` : secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs} s`;
      return `charge ${ago} stale`;
    }
    const first = socSrcs[0];
    const what = first.Type === 'modbus' ? `${first.Connection || 'modbus'} reg ${first.Register}` : (first.Topic || 'its source');
    return `no charge yet from ${what}`;
  };

  // Sum a kind's out-direction (graph) values.
  const sumKind = (nodes: any[], kind: string) => {
    const ns = nodes.filter(n => (n.kind || 'node') === kind);
    let sum = 0, known = false;
    ns.forEach(n => { if (typeof n.value === 'number') { sum += n.value; known = true; } });
    return { present: ns.length > 0, value: known ? sum : null };
  };

  // The board needs several round-trips, and is triggered by pushes as well as by the timer.
  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    try { await loadBoard(); } finally { loading = false; }
  };

  // The last few hours behind the tiles, keyed by node. Null until a load fills it, and left null when
  // history is off or the backend has nothing — which is why a tile can simply have no trend.
  let trendSeries: { byNode: Map<string, (number | null)[]>, at: (i: number) => string } | null = null;

  /// Read the window every tile's trend is drawn from. One request for the whole board.
  const loadTrend = async (metric: string) => {
    trendSeries = null;
    // A past instant is a moment, not a window: the trend would be the same line on every tile.
    if (hist.at() || hist.span() > 1) return;
    try {
      const minutes = 180, step = 300;
      const r = await api(withInstance(
        `/api/flow/series?minutes=${minutes}&step=${step}&metric=${encodeURIComponent(metric)}`, instSel));
      const body = r?.body;
      if (!body || !body.ok || !Array.isArray(body.series) || !body.series.length) return;

      const byNode = new Map<string, (number | null)[]>();
      for (const s of body.series) if (s && s.node) byNode.set(s.node, s.values || []);
      const points = Math.max(...[...byNode.values()].map(v => v.length), 0);
      if (points < 2) return;

      // Each point's clock time in the viewer's own zone, for the hover.
      const stepMs = step * 1000, endMs = Date.now();
      const at = (i: number) => new Date(endMs - (points - 1 - i) * stepMs)
        .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      trendSeries = { byNode, at };
    } catch { /* the board is the point; a missing trend just means no line */ }
  };

  const loadBoard = async () => {
    // The whole board reads one metric (#371).
    const metric = showSel.value || 'realpower';
    const isEnergy = metric !== 'realpower';
    let r: any;
    const at = hist.at();
    let path = withInstance('/api/flow' + (isEnergy ? '?metric=' + encodeURIComponent(metric) : ''), instSel);
    const past = historyQuery(hist);
    if (past) path += (path.includes('?') ? '&' : '?') + past.slice(1);
    try { r = await api(path); }
    catch (e: any) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    await loadTrend(metric);
    grid.innerHTML = ''; summary.innerHTML = ''; flowWrap.innerHTML = '';
    if (!r.body || !r.body.ok) {
      // Say what actually went wrong.
      const why = (r.body && r.body.message) || `the server answered ${r.status ?? '?'} with no explanation`;
      grid.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'Could not load energy data — ' + why }));
      status.textContent = ''; return;
    }
    // Derived lanes are for the diagram, not the totals.
    hist.setNote(historyNote(r.body));
    const nodes = (r.body.nodes || []).filter((n: any) => !String(n.id || '').includes('#'));

    // Live cache reads: the in-direction (charge/export) power for battery/grid nodes.
    const battIds = nodes.filter((n: any) => n.kind === 'battery').map((n: any) => n.id);
    const gridIds = nodes.filter((n: any) => n.kind === 'grid').map((n: any) => n.id);
    // The other two kinds, for the gauges: a tile sums every node of its kind, so its ceiling sums too.
    const solarIds = nodes.filter((n: any) => n.kind === 'solar').map((n: any) => n.id);
    const loadIds = nodes.filter((n: any) => n.kind === 'load').map((n: any) => n.id);
    const liveBy: Record<string, number> = {};
    // The full record, not just the value: it carries the staleness fields (reported/ageSeconds/fresh).
    const liveInfo: Record<string, any> = {};

    // A past view must not read the live cache.
    const historical = !!r.body.historical;
    const inFromGraph: Record<string, number> = {};
    if (historical)
      (r.body.nodes || []).forEach((n: any) => {
        const id = String(n.id || '');
        if (id.endsWith('#in') && typeof n.value === 'number') inFromGraph[id.slice(0, -3) + '|' + metric + '#in'] = n.value;
      });

    const q = historical ? [] : [
      ...[...battIds, ...gridIds].map(id => ({ Node: id, Metric: metric + '#in' })),
      ...battIds.map(id => ({ Node: id, Metric: 'soc' })),
    ];
    if (q.length) {
      try {
        const lr = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
        (lr.body?.values || []).forEach((v: any) => {
          liveInfo[`${v.node}|${v.metric}`] = v;
          if (typeof v.value === 'number') liveBy[`${v.node}|${v.metric}`] = v.value;
        });
      } catch { /* no live cache — these reads just stay absent */ }
    }
    const inBy = historical ? inFromGraph : liveBy;
    const sumIn = (ids: string[]) => { let s = 0, known = false; ids.forEach(id => { const k = `${id}|${metric}#in`; if (k in inBy) { s += inBy[k]; known = true; } }); return known ? s : null; };
    // Battery SoC: average across battery nodes that report it (a bank reads as one figure). Only live —
    const socVals = historical ? [] : battIds.map(id => liveBy[`${id}|soc`]).filter((v): v is number => typeof v === 'number');
    const soc = socVals.length ? Math.round(socVals.reduce((a, b) => a + b, 0) / socVals.length) : null;

    // Formatting and gauges follow the metric.
    const units = r.body.units || (isEnergy ? 'kWh' : 'W');
    const fmt = (v: number | null) => isEnergy ? fmtEnergy(v, units) : fmtPower(v);
    const dial = (ids: string[], v: number | null) => isEnergy ? undefined : gaugeFor(ids, v, 'W');

    const solar = sumKind(nodes, 'solar');
    const batt = sumKind(nodes, 'battery');   // out = discharge
    const gridK = sumKind(nodes, 'grid');     // out = import
    const load_ = sumKind(nodes, 'load');
    const battIn = sumIn(battIds);            // charge
    const gridIn = sumIn(gridIds);            // export

    // Net = out − in. Present-but-all-unknown stays null; a measured side alone still yields a net.
    const net = (out: { present: boolean, value: number | null }, inV: number | null) =>
      out.value == null && inV == null ? null : (out.value || 0) - (inV || 0);
    const battNet = net(batt, battIn);
    const gridNet = net(gridK, gridIn);

    // Home load: prefer explicitly-tagged load nodes; otherwise derive from the balance.
    let home: number | null = null, homeSub = '';
    if (load_.present) { home = load_.value; homeSub = home == null ? 'no reading yet' : 'consuming'; }
    else {
      // Same rule as the Trends page: a kind the system does not have is left out.
      home = homeEnergy({
        ...(solar.present ? { solar: solar.value } : {}),
        ...(batt.present ? { battery: battNet } : {}),
        ...(gridK.present ? { grid: gridNet } : {}),
      });
      if (home != null) homeSub = 'balance of measured sources';
    }

    // Self-sufficiency is an ENERGY question — over some window.
    let eHome: number | null = null, eFromGrid: number | null = null, eUnits = 'kWh';
    let eWindow = 'of lifetime energy';
    if (isEnergy) {
      // The board is already an energy view, so the bar is a share of the very tiles above it.
      eHome = home;
      eUnits = units;
      // Energy drawn from the grid is what it imported.
      eFromGrid = gridK.value == null ? null : Math.max(0, gridK.value);
      const day = hist.day();
      eWindow = day ? `of energy on ${new Date(hist.at()).toLocaleDateString()}`
        : metric === 'energytoday' ? 'of today’s energy' : 'of lifetime energy';
    } else try {
      // Today, not all time.
      const er = await api(withInstance('/api/flow?metric=energytoday', instSel));
      if (er.body?.ok) {
        const enodes = er.body.nodes || [];
        eUnits = er.body.units || 'kWh';
        // From the answer, not from what was asked for.
        eWindow = er.body.metric === 'energytoday' ? 'of today’s energy' : 'of lifetime energy';
        const eSolar = sumKind(enodes, 'solar'), eBatt = sumKind(enodes, 'battery'), eGrid = sumKind(enodes, 'grid'), eLoad = sumKind(enodes, 'load');
        // In-direction (charge/export) energy from the same live cache, keyed to the same metric.
        const eInBy: Record<string, number> = {};
        const eq = [...battIds, ...gridIds].map(id => ({ Node: id, Metric: 'energytoday#in' }));
        if (eq.length) {
          try {
            const elr = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eq) });
            (elr.body?.values || []).forEach((v: any) => { if (typeof v.value === 'number') eInBy[`${v.node}|${v.metric}`] = v.value; });
          } catch { /* no live cache — energy#in just stays absent */ }
        }
        const eSumIn = (ids: string[]) => { let s = 0, known = false; ids.forEach(id => { const k = `${id}|energytoday#in`; if (k in eInBy) { s += eInBy[k]; known = true; } }); return known ? s : null; };
        const eBattNet = net(eBatt, eSumIn(battIds)), eGridNet = net(eGrid, eSumIn(gridIds));
        // Home energy: tagged load nodes if present, else the balance of measured sources (same rule as power).
        if (eLoad.present) eHome = eLoad.value;
        else {
          const unknownFeeder = (eSolar.present && eSolar.value == null) || (eBatt.present && eBatt.value == null) || (eGrid.present && eGrid.value == null);
          if (!unknownFeeder && (eSolar.present || eBatt.present || eGrid.present)) eHome = (eSolar.value || 0) + (eBattNet || 0) + (eGridNet || 0);
        }
        // What the house drew, not what it drew net of what it sent back.
        if (eGrid.value != null) eFromGrid = Math.max(0, eGrid.value);
      }
    } catch { /* energy graph unavailable — self-sufficiency just won't render */ }

    // Animated flow diagram — the arms present in this system, each with its live figure and flow direction.
    const arms: any[] = [];
    if (solar.present) arms.push({ key: 'solar', icon: '☀️', label: 'Solar', text: fmt(solar.value), color: 'var(--warn)', flow: solar.value, ids: solarIds });
    if (batt.present || battIds.length) arms.push({ key: 'battery', icon: '🔋', label: 'Battery', text: soc != null ? `${soc}%` : fmt(battNet == null ? null : Math.abs(battNet)), color: 'var(--good)', flow: battNet, ids: battIds });
    if (gridK.present || gridIds.length) arms.push({ key: 'grid', icon: '⚡', label: 'Grid', text: fmt(gridNet == null ? null : Math.abs(gridNet)), color: 'var(--accent)', flow: gridNet, ids: gridIds });
    if (home != null || load_.present) arms.push({ key: 'home', icon: '🏠', label: 'Home', text: fmt(home), color: 'var(--muted)', flow: home, ids: loadIds });
    if (arms.length) drawFlow(arms);

    // Solar
    if (solar.present)
      grid.appendChild(tile('solar', '☀️', 'Solar', fmt(solar.value),
        subOrWhy(solar.value, 'solar', solar.value! > 1 ? 'producing' : 'idle'), solar.value && solar.value > 1 ? 'supply' : '',
        dial(solarIds, solar.value), trendFor(solarIds, 'var(--warn)', units), { ids: solarIds, label: 'Solar' }));

    // Battery — sign tells charge vs discharge; magnitude is what's shown. SoC (when bound) leads the sub-line.
    if (batt.present || battIds.length) {
      const dir = subOrWhy(battNet, 'battery', battNet! > 1 ? 'discharging' : battNet! < -1 ? 'charging' : 'idle');
      const cls = battNet == null ? '' : battNet > 1 ? 'supply' : battNet < -1 ? 'draw' : '';
      // SoC always leads the sub-line, so the state-of-charge slot is always shown.
      const socWhy = soc == null ? whyNoSoc(battIds, liveInfo) : null;
      // The dial is the battery's power against its rating; the slim bar below is state of charge.
      const t = tile('battery', '🔋', 'Battery', fmt(battNet == null ? null : Math.abs(battNet)), `${soc == null ? socWhy : soc + '%'} · ${dir}`, cls,
        dial(battIds, battNet == null ? null : Math.abs(battNet)), trendFor(battIds, 'var(--good)', units), { ids: battIds, label: 'Battery' });
      if (socWhy) t.title = `No battery percentage: ${socWhy}. Bind or correct the state-of-charge source on the Nodes tab.`;
      // A slim charge gauge under the tile when SoC is known — the "battery %" at a glance.
      if (soc != null) {
        const g = el('div', { class: 'energy-soc-bar', title: `${soc}% state of charge` }, el('span', { style: { width: soc + '%' } }));
        t.appendChild(g);
      }
      grid.appendChild(t);
    }

    // Grid — positive = importing (drawing from the utility), negative = exporting (selling back).
    if (gridK.present || gridIds.length) {
      const sub = subOrWhy(gridNet, 'grid', gridNet! > 1 ? 'importing' : gridNet! < -1 ? 'exporting' : 'idle');
      const cls = gridNet == null ? '' : gridNet > 1 ? 'draw' : gridNet < -1 ? 'supply' : '';
      // On energy the figure is the day's NET — import minus export, signed (#371).
      const gridShown = gridNet == null ? null : isEnergy ? gridNet : Math.abs(gridNet);
      grid.appendChild(tile('grid', '⚡', 'Grid', fmt(gridShown),
        isEnergy ? `${sub} · net for the day` : sub, cls,
        dial(gridIds, gridNet == null ? null : Math.abs(gridNet)), trendFor(gridIds, 'var(--accent)', units), { ids: gridIds, label: 'Grid' }));
    }

    // Home load (computed above with the flow arms).
    if (home != null || load_.present)
      grid.appendChild(tile('home', '🏠', 'Home', fmt(home), home == null ? whyNoReading('load') : (homeSub || 'consuming'), '',
        dial(loadIds, home), trendFor(loadIds, 'var(--muted)', units), { ids: loadIds, label: 'Home' }));

    // Self-sufficiency: the share of the home's energy (kWh) over the window above that was not drawn from the grid.
    const ssPct = selfSufficiencyPct(eHome, eFromGrid);
    const ssCovered = coveredEnergy(eHome, eFromGrid);
    if (ssPct != null && ssCovered != null) {
      const covered = ssCovered;
      const pct = Math.round(ssPct);
      const row = el('div', { class: 'energy-selfsuff' });
      row.append(
        el('div', { class: 'energy-ss-label', text: `Self-sufficiency ${pct}%` }),
        el('div', { class: 'energy-ss-bar' }, el('span', { style: { width: pct + '%' } })),
        el('div', { class: 'desc', text: `${fmtEnergy(covered, eUnits)} of ${fmtEnergy(eHome, eUnits)} ${eWindow} covered by solar + battery.` }),
      );
      summary.appendChild(row);
    }

    if (!grid.children.length)
      grid.appendChild(el('div', { class: 'desc', text: 'Nothing tagged yet. On the Nodes tab, set a node’s Kind to solar, battery, or grid and bind a source — it’ll show here.' }));
    status.textContent = `updated ${new Date().toLocaleTimeString()}`;
  };

  refresh.onclick = () => load();

  // The board is assembled from several reads, so the push is used as a trigger to rebuild it.
  const syncLive = liveWhileActive(sec, () => 'flow:realpower' + (instSel.get() ? '|' + instSel.get() : ''),
    () => { if (!hist.day()) load(); });
  // Fallback for when the stream isn't up; it does nothing while it is.
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive() && !hist.day()) load(); }, 8000);
  link.onclick = () => { activate(link, sec); syncLive(); load(); };
}

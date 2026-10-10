import { api, btn, el, activate, formatNum, svgEl, navLink, instanceSelector, withInstance } from '../helpers.js';
import { busyInSection, liveWhileActive, realtimeLive } from '../realtime.js';
import { state } from '../state.js';
import { homeEnergy, homeBalanceTrend, selfSufficiencyPct, coveredEnergy, netSelfProducedPct, shareBand } from '../energy.js';
import { sparkline, KIND_COLOR } from '../charts.js';
import { requestFocus } from '../state.js';
import { historyControl, historyQuery, historyNote, periodRow, periodWindow, type PeriodKey } from '../history-control.js';
import { drawEnergyFlow, type FlowArm } from '../energy-diagram.js';


export function addEnergyOverviewSection(nav: any, sections: any) {
  const link = navLink(nav, "Energy", "⚡");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const head = el('div', { class: 'energy-head-row' });
  head.appendChild(el('h2', { text: 'Energy' }));
  sec.appendChild(head);

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  const showSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  showSel.appendChild(el('option', { value: 'realpower', text: 'Power (W)' }));
  showSel.appendChild(el('option', { value: 'energy_d', text: 'Energy (kWh)' }));
  try { showSel.value = localStorage.getItem('rpdu-energy-show') === 'realpower' ? 'realpower' : 'energy_d'; } catch { showSel.value = 'energy_d'; }
  const instSel = instanceSelector(() => load());
  const status = el('span', { class: 'ld-count' });
  const historyBtn = btn('History ▾');
  bar.append(showSel, instSel.wrap, historyBtn, refresh, status);
  head.appendChild(bar);
  let hadDay = false;
  const hist = historyControl((what: any) => {
    periods.mark(null);
    const leftLive = what === 'day' && !hadDay && !!hist.day();
    hadDay = !!hist.day();
    if ((leftLive && !hist.time() && showSel.value === 'realpower') || (what === 'span' && hist.span() > 1))
      showSel.value = 'energy_d';
    load();
  });
  const periods = periodRow((key: PeriodKey) => {
    const { day, days } = periodWindow(key);
    hist.set(day, days);
    showSel.value = 'energy_d';
    periods.mark(key);
    hadDay = true;
    load();
  });
  const historyPanel = el('div', { class: 'energy-history' }, periods.row, hist.row);
  sec.appendChild(historyPanel);
  let historyOpen = false;
  const syncHistory = () => {
    const open = historyOpen || !!hist.day();
    historyPanel.hidden = !open;
    historyBtn.textContent = hist.day() ? `History: ${hist.day()} ▴` : open ? 'History ▴' : 'History ▾';
    historyBtn.classList[hist.day() ? 'add' : 'remove']('primary');
    historyBtn.hidden = hist.row.classList.contains('is-hidden') && !hist.day();
  };
  historyBtn.onclick = () => { historyOpen = !(historyOpen || !!hist.day()); syncHistory(); };
  syncHistory();
  showSel.onchange = () => { try { localStorage.setItem('rpdu-energy-show', showSel.value); } catch { /* this session only */ } load(); };

  const board = el('div', { class: 'energy-board' }); sec.appendChild(board);
  const flowWrap = el('div', { class: 'energy-flow' }); board.appendChild(flowWrap);
  const gridEl = el('div', { class: 'energy-grid' }); board.appendChild(gridEl);
  const summaryEl = el('div', { class: 'energy-summary' }); board.appendChild(summaryEl);

  const fmtPower = (w: number | null) => w == null ? '—'
    : Math.abs(w) >= 1000 ? `${formatNum(w / 1000)} kW` : `${formatNum(Math.round(w))} W`;
  const fmtEnergy = (v: number | null, units: string) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} ${units || 'kWh'}`;

  const gaugeArc = (fraction: number, over: boolean) => {
    const R = 26, CX = 30, CY = 30;
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
    if (trend) t.appendChild(sparkline({ values: trend.values, color: trend.color, units: trend.units, at: trend.at }));
    if (link && link.ids.length) openOnClick(t, link.ids, link.label);
    return t;
  };

  const openOnClick = (elm: any, ids: string[], label: string) => {
    elm.classList?.add('is-linked');
    elm.style.cursor = 'pointer';
    if (elm.setAttribute) elm.setAttribute('tabindex', '0');
    const title = `Show ${label} for today on the Node Trends page`;
    if (elm.setAttribute) elm.setAttribute('title', title); else elm.title = title;

    const go = () => {
      requestFocus(ids, 'today=1', label);
      const link = [...document.querySelectorAll('nav a')].find((a: any) => (a.dataset?.label || '') === 'Node Trends');
      if (link) (link as any).click();
    };
    elm.addEventListener('click', go);
    elm.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault?.(); go(); } });
  };

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

  // Home with no node of its own is the balance of its sources, so its trend is too.
  const homeTrend = (roles: { solar: string[], battery: string[], grid: string[] }, units: string) => {
    const values = trendSeries && homeBalanceTrend(trendSeries.byNode, roles);
    return values ? { values, color: 'var(--muted)', units, at: trendSeries!.at } : undefined;
  };

  const gaugeFor = (ids: string[], value: number | null, units: string) => {
    const cfgNodes = (state.data?.EnergyFlow?.Nodes || []) as any[];
    const maxes = ids.map(id => cfgNodes.find(n => n.Id === id)?.Max).filter((m: any) => typeof m === 'number' && m > 0);
    if (!maxes.length || value == null) return undefined;
    const max = maxes.reduce((a: number, b: number) => a + b, 0);
    const fraction = Math.min(1, Math.max(0, value / max));
    return { fraction, over: value > max, max, units };
  };

  const drawFlow = (arms: FlowArm[]) =>
    drawEnergyFlow(flowWrap, arms, (a, g) => openOnClick(g, a.ids!, a.label));

  const whyNoReading = (ids: string[]) => {
    const nodes = (state.data?.EnergyFlow?.Nodes || []).filter((n: any) => ids.includes(n.Id));
    if (!nodes.length) return 'no reading yet';
    const bound = nodes.flatMap((n: any) => n.Sources || []);
    if (!bound.length)
      return nodes.some((n: any) => n.Value != null) ? 'static value only' : 'no source bound';
    const first = bound[0];
    const what = first.Type === 'modbus'
      ? `${first.Connection || 'modbus'} reg ${first.Register}`
      : (first.Topic || 'its source');
    return bound.length > 1 ? `waiting on ${bound.length} sources` : `waiting on ${what}`;
  };
  const subOrWhy = (value: number | null, ids: string[], whenKnown: string) => value == null ? whyNoReading(ids) : whenKnown;

  const whyNoSoc = (battIds: string[], liveInfo: Record<string, any>) => {
    const cfg = (state.data?.EnergyFlow?.Nodes || []).filter((n: any) => battIds.includes(n.Id));
    if (!cfg.length) return 'no battery node';
    const socSrcs = cfg.flatMap((n: any) => (n.Sources || []).filter((s: any) => s.Metric === 'soc'));
    if (!socSrcs.length) return 'no charge source bound';
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

  const sumRole = (nodes: any[], role: string) => {
    const ns = nodes.filter(n => n.balance === role && !String(n.id || '').includes('#'));
    let sum = 0, known = false;
    ns.forEach(n => { if (typeof n.value === 'number') { sum += n.value; known = true; } });
    return { present: ns.length > 0, value: known ? sum : null };
  };

  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    try { await loadBoard(); } finally { loading = false; }
  };

  let trendSeries: { byNode: Map<string, (number | null)[]>, at: (i: number) => string } | null = null;

  const loadTrend = async (metric: string) => {
    trendSeries = null;
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

      const stepMs = step * 1000, endMs = Date.now();
      const at = (i: number) => new Date(endMs - (points - 1 - i) * stepMs)
        .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      trendSeries = { byNode, at };
    } catch { /* the board is the point; a missing trend just means no line */ }
  };

  const loadBoard = async () => {
    syncHistory();
    const held = board.offsetHeight || 0;
    if (held) board.style.minHeight = held + 'px';
    try { await fillBoard(); } finally { board.style.minHeight = ''; }
  };

  const fillBoard = async () => {
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
    const grid = el('div'), summary = el('div');
    const move = (from: any, to: any) => { to.innerHTML = ''; [...from.children].forEach((c: any) => to.appendChild(c)); };
    const swap = () => { move(grid, gridEl); move(summary, summaryEl); };
    if (!r.body || !r.body.ok) {
      const transient = !r.status || r.status === 502 || r.status === 503 || r.status === 504;
      if (transient && gridEl.children.length) {
        status.textContent = `bridge not answering (${r.status || 'no response'}) — showing the last reading, retrying`;
        return;
      }
      const why = (r.body && r.body.message)
        || (transient ? `the bridge is not answering (${r.status || 'no response'}) — it may be restarting; retrying`
                      : `the server answered ${r.status ?? '?'} with no explanation`);
      grid.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'Could not load energy data — ' + why }));
      flowWrap.innerHTML = '';
      swap();
      status.textContent = ''; return;
    }
    hist.setNote(historyNote(r.body));
    const nodes = (r.body.nodes || []).filter((n: any) => !String(n.id || '').includes('#'));

    const ofRole = (role: string) => nodes.filter((n: any) => n.balance === role).map((n: any) => n.id);
    const battIds = ofRole('battery');
    const gridIds = ofRole('grid');
    const solarIds = ofRole('solar');
    const loadIds = ofRole('home');
    const liveBy: Record<string, number> = {};
    const liveInfo: Record<string, any> = {};

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
    const socVals = historical ? [] : battIds.map(id => liveBy[`${id}|soc`]).filter((v): v is number => typeof v === 'number');
    const soc = socVals.length ? Math.round(socVals.reduce((a, b) => a + b, 0) / socVals.length) : null;

    const units = r.body.units || (isEnergy ? 'kWh' : 'W');
    const fmt = (v: number | null) => isEnergy ? fmtEnergy(v, units) : fmtPower(v);
    const dial = (ids: string[], v: number | null) => isEnergy ? undefined : gaugeFor(ids, v, 'W');

    const solar = sumRole(nodes, 'solar');
    const batt = sumRole(nodes, 'battery');   // out = discharge
    const gridK = sumRole(nodes, 'grid');     // out = import
    const load_ = sumRole(nodes, 'home');
    const battIn = sumIn(battIds);            // charge
    const gridIn = sumIn(gridIds);            // export

    const net = (out: { present: boolean, value: number | null }, inV: number | null) =>
      out.value == null && inV == null ? null : (out.value || 0) - (inV || 0);
    const battNet = net(batt, battIn);
    const gridNet = net(gridK, gridIn);

    let home: number | null = null, homeSub = '';
    if (load_.present) { home = load_.value; homeSub = home == null ? 'no reading yet' : 'consuming'; }
    else {
      home = homeEnergy({
        ...(solar.present ? { solar: solar.value } : {}),
        ...(batt.present ? { battery: battNet } : {}),
        ...(gridK.present ? { grid: gridNet } : {}),
      });
      if (home != null) homeSub = 'balance of measured sources';
    }

    let eHome: number | null = null, eFromGrid: number | null = null, eGridNet: number | null = null, eUnits = 'kWh';
    let eWindow = 'of lifetime energy';
    if (isEnergy) {
      eHome = home;
      eUnits = units;
      eFromGrid = gridK.value == null ? null : Math.max(0, gridK.value);
      eGridNet = gridK.value == null || gridIn == null ? null : gridNet;
      const day = hist.day();
      eWindow = day ? `of energy on ${new Date(hist.at()).toLocaleDateString()}`
        : metric === 'energy_d' ? 'of today’s energy' : 'of lifetime energy';
    } else try {
      const er = await api(withInstance('/api/flow?metric=energy_d', instSel));
      if (er.body?.ok) {
        const enodes = er.body.nodes || [];
        eUnits = er.body.units || 'kWh';
        eWindow = er.body.metric === 'energy_d' ? 'of today’s energy' : 'of lifetime energy';
        const eSolar = sumRole(enodes, 'solar'), eBatt = sumRole(enodes, 'battery'), eGrid = sumRole(enodes, 'grid'), eLoad = sumRole(enodes, 'home');
        const eInBy: Record<string, number> = {};
        const eq = [...battIds, ...gridIds].map(id => ({ Node: id, Metric: 'energy_d#in' }));
        if (eq.length) {
          try {
            const elr = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eq) });
            (elr.body?.values || []).forEach((v: any) => { if (typeof v.value === 'number') eInBy[`${v.node}|${v.metric}`] = v.value; });
          } catch { /* no live cache — energy#in just stays absent */ }
        }
        const eSumIn = (ids: string[]) => { let s = 0, known = false; ids.forEach(id => { const k = `${id}|energy_d#in`; if (k in eInBy) { s += eInBy[k]; known = true; } }); return known ? s : null; };
        const eBattNet = net(eBatt, eSumIn(battIds)), eGridBal = net(eGrid, eSumIn(gridIds));
        if (eLoad.present) eHome = eLoad.value;
        else {
          const unknownFeeder = (eSolar.present && eSolar.value == null) || (eBatt.present && eBatt.value == null) || (eGrid.present && eGrid.value == null);
          if (!unknownFeeder && (eSolar.present || eBatt.present || eGrid.present)) eHome = (eSolar.value || 0) + (eBattNet || 0) + (eGridBal || 0);
        }
        if (eGrid.value != null) eFromGrid = Math.max(0, eGrid.value);
        if (eGrid.value != null && eSumIn(gridIds) != null) eGridNet = eGridBal;
      }
    } catch { /* energy graph unavailable — self-sufficiency just won't render */ }

    const arms: any[] = [];
    if (solar.present) arms.push({ key: 'solar', icon: '☀️', label: 'Solar', text: fmt(solar.value), color: KIND_COLOR.solar, flow: solar.value, ids: solarIds });
    if (batt.present || battIds.length) arms.push({ key: 'battery', icon: '🔋', label: 'Battery', text: soc != null ? `${soc}%` : fmt(battNet == null ? null : Math.abs(battNet)), color: KIND_COLOR.battery, flow: battNet, ids: battIds });
    if (gridK.present || gridIds.length) arms.push({ key: 'grid', icon: '⚡', label: 'Grid', text: fmt(gridNet == null ? null : Math.abs(gridNet)), color: KIND_COLOR.grid, flow: gridNet, ids: gridIds });
    if (home != null || load_.present) arms.push({ key: 'home', icon: '🏠', label: 'Home', text: fmt(home), color: 'var(--muted)', flow: home, ids: loadIds });
    if (arms.length) drawFlow(arms); else flowWrap.innerHTML = '';

    if (solar.present)
      grid.appendChild(tile('solar', '☀️', 'Solar', fmt(solar.value),
        subOrWhy(solar.value, solarIds, solar.value! > 1 ? 'producing' : 'idle'), solar.value && solar.value > 1 ? 'supply' : '',
        dial(solarIds, solar.value), trendFor(solarIds, 'var(--warn)', units), { ids: solarIds, label: 'Solar' }));

    if (batt.present || battIds.length) {
      const dir = subOrWhy(battNet, battIds, battNet! > 1 ? 'discharging' : battNet! < -1 ? 'charging' : 'idle');
      const cls = battNet == null ? '' : battNet > 1 ? 'supply' : battNet < -1 ? 'draw' : '';
      const socWhy = soc == null ? whyNoSoc(battIds, liveInfo) : null;
      const t = tile('battery', '🔋', 'Battery', fmt(battNet == null ? null : Math.abs(battNet)), `${soc == null ? socWhy : soc + '%'} · ${dir}`, cls,
        dial(battIds, battNet == null ? null : Math.abs(battNet)), trendFor(battIds, 'var(--good)', units), { ids: battIds, label: 'Battery' });
      if (socWhy) t.title = `No battery percentage: ${socWhy}. Bind or correct the state-of-charge source on the Nodes tab.`;
      if (soc != null) {
        const g = el('div', { class: 'energy-soc-bar', title: `${soc}% state of charge` }, el('span', { style: { width: soc + '%' } }));
        t.appendChild(g);
      }
      grid.appendChild(t);
    }

    if (gridK.present || gridIds.length) {
      const sub = subOrWhy(gridNet, gridIds, gridNet! > 1 ? 'importing' : gridNet! < -1 ? 'exporting' : 'idle');
      const cls = gridNet == null ? '' : gridNet > 1 ? 'draw' : gridNet < -1 ? 'supply' : '';
      const gridShown = gridNet == null ? null : isEnergy ? gridNet : Math.abs(gridNet);
      grid.appendChild(tile('grid', '⚡', 'Grid', fmt(gridShown),
        isEnergy ? `${sub} · net for the day` : sub, cls,
        dial(gridIds, gridNet == null ? null : Math.abs(gridNet)), trendFor(gridIds, 'var(--accent)', units), { ids: gridIds, label: 'Grid' }));
    }

    if (home != null || load_.present)
      grid.appendChild(tile('home', '🏠', 'Home', fmt(home), home == null ? whyNoReading(loadIds) : (homeSub || 'consuming'), '',
        dial(loadIds, home), load_.present ? trendFor(loadIds, 'var(--muted)', units) : homeTrend({ solar: solarIds, battery: battIds, grid: gridIds }, units), { ids: loadIds, label: 'Home' }));

    const ssPct = selfSufficiencyPct(eHome, eFromGrid);
    const ssCovered = coveredEnergy(eHome, eFromGrid);
    if (ssPct != null && ssCovered != null) {
      const covered = ssCovered;
      const pct = Math.round(ssPct);
      const row = el('div', { class: 'energy-selfsuff' });
      row.append(
        el('div', { class: 'energy-ss-label', text: `Self-sufficiency ${pct}%` }),
        el('div', { class: 'energy-ss-bar' }, el('span', { style: { width: pct + '%' } })),
        el('div', { class: 'desc', text: `${fmtEnergy(covered, eUnits)} of ${fmtEnergy(eHome, eUnits)} ${eWindow} covered by solar + battery; ${fmtEnergy(eFromGrid, eUnits)} imported.` }),
      );
      summary.appendChild(row);
    }
    const netPct = netSelfProducedPct(eHome, eGridNet);
    if (netPct != null) {
      const pct = Math.round(netPct);
      const exported = eFromGrid == null || eGridNet == null ? null : eFromGrid - eGridNet;
      summary.appendChild(el('div', { class: 'energy-selfsuff' },
        el('div', { class: 'energy-ss-label', text: `Self-produced (net) ${pct}%` }),
        el('div', { class: 'energy-ss-bar ov-band-' + shareBand(netPct) }, el('span', { style: { width: Math.min(100, pct) + '%' } })),
        el('div', { class: 'desc', text: `${fmtEnergy(eHome! - eGridNet!, eUnits)} of ${fmtEnergy(eHome, eUnits)} ${eWindow}, counting ${fmtEnergy(exported, eUnits)} exported against import.` }),
      ));
    }

    if (!grid.children.length)
      grid.appendChild(el('div', { class: 'desc', text: 'Nothing counts toward solar, battery, grid or home yet. Pick the nodes on the Balance page (or set a node’s Kind to solar, battery or grid) and bind a source — it’ll show here.' }));
    swap();
    status.textContent = `updated ${new Date().toLocaleTimeString()}`;
  };

  refresh.onclick = () => load();

  const syncLive = liveWhileActive(sec, () => 'flow:realpower' + (instSel.get() ? '|' + instSel.get() : ''),
    () => { if (!hist.day()) load(); });
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive() && !hist.day() && !busyInSection(sec)) load(); }, 8000);
  link.onclick = () => { activate(link, sec); syncLive(); load(); };
}

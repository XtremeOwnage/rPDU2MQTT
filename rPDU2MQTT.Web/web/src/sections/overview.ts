// The landing page: what the system is doing right now, in one screen.
//
// The Status board answered "is the bridge healthy", which is the question you ask second. The first one
// is "what is my power doing" — and it was three clicks away behind a board of green dots (#395).
import { api, el, activate, navLink, formatNum, btn } from '../helpers.js';
import { liveWhileActive, realtimeLive } from '../realtime.js';
import { drawEnergyFlow, type FlowArm } from '../energy-diagram.js';
import { sparkline, KIND_COLOR } from '../charts.js';
import { homeEnergy, selfSufficiencyPct, sumKnown } from '../energy.js';
import { requestFocus } from '../state.js';

export function addOverviewSection(nav: any, sections: any) {
  const link = navLink(nav, 'Overview', '⌂');
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Overview' }));
  sec.appendChild(el('div', {
    class: 'desc',
    text: 'What the system is doing now, what it has done today, and anything that needs attention. '
      + 'Nothing here is estimated: a figure nothing measured is shown as a dash.',
  }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  const stamp = el('span', { class: 'ld-count' });
  bar.append(refresh, stamp); sec.appendChild(bar);

  // Anything wrong goes at the top, at full size. When nothing is, it collapses to a single line.
  const alerts = el('div'); sec.appendChild(alerts);

  const now = el('div', { class: 'ov-now' }); sec.appendChild(now);
  const flowWrap = el('div', { class: 'energy-flow ov-flow' }); now.appendChild(flowWrap);
  // Not `ov-battery`: a tile for the battery kind is built as `ov-` + kind, and the two collided.
  const battWrap = el('div', { class: 'ov-batt-side' }); now.appendChild(battWrap);

  sec.appendChild(el('h3', { text: 'Today so far', class: 'ov-h3' }));
  const todayRow = el('div', { class: 'ov-tiles' }); sec.appendChild(todayRow);

  sec.appendChild(el('h3', { text: 'Last 24 hours', class: 'ov-h3' }));
  const dayRow = el('div', { class: 'ov-tiles' }); sec.appendChild(dayRow);

  const fmtW = (w: number | null) => w == null ? '—'
    : Math.abs(w) >= 1000 ? `${formatNum(Math.round(w / 100) / 10)} kW` : `${formatNum(Math.round(w))} W`;
  const fmtKwh = (v: number | null) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} kWh`;

  const idsOfKind = (nodes: any[], kind: string) => nodes.filter(n => n.kind === kind && !n.id.includes('#')).map(n => n.id);
  const sumOfKind = (nodes: any[], kind: string) => {
    const vals = nodes.filter(n => n.kind === kind && !n.id.includes('#') && typeof n.value === 'number').map(n => n.value);
    return vals.length ? vals.reduce((a: number, b: number) => a + b, 0) : null;
  };

  /// A figure with its name, and the sub-line that says what it means. Clicking opens that node's day.
  const tile = (kind: string, icon: string, label: string, value: string, sub: string, ids: string[]) => {
    const t = el('div', { class: 'ov-tile ov-' + kind });
    t.append(
      el('div', { class: 'ov-tile-head' }, el('span', { class: 'ov-icon', text: icon }), el('span', { text: label })),
      el('div', { class: 'ov-value', text: value }),
      el('div', { class: 'ov-sub', text: sub }));
    if (ids.length) {
      t.classList.add('is-link');
      t.title = `Show ${label} through the day`;
      t.onclick = () => {
        requestFocus(ids, 'today=1&step=300', label);
        (document.querySelector('nav a[data-label="Trends"]') as any)?.click();
      };
    }
    return t;
  };

  /// The battery, as the thing people actually look for: how full, which way, and how fast.
  const drawBattery = (soc: number | null, watts: number | null, why: string, volts: number | null) => {
    battWrap.innerHTML = '';
    const charging = watts != null && watts < -1;
    const idle = watts == null || Math.abs(watts) <= 1;
    const pct = soc == null ? null : Math.max(0, Math.min(100, soc));
    const level = pct == null ? 'unknown' : pct >= 60 ? 'good' : pct >= 25 ? 'warn' : 'bad';

    const card = el('div', { class: 'ov-batt-card' });
    card.appendChild(el('div', { class: 'ov-batt-title', text: 'Battery' }));
    // A battery drawn as a battery: the fill IS the charge, so the number is confirmation, not the message.
    const body = el('div', { class: 'ov-batt-body ov-batt-' + level });
    const shell = el('div', { class: 'ov-batt-shell' });
    const fill = el('div', { class: 'ov-batt-fill' });
    fill.style.height = (pct == null ? 0 : pct) + '%';
    shell.append(fill, el('div', { class: 'ov-batt-cap' }));
    const state = pct == null ? why : idle ? 'idle' : charging ? `charging · ${fmtW(Math.abs(watts!))}` : `discharging · ${fmtW(watts!)}`;
    body.append(shell, el('div', { class: 'ov-batt-read' },
      el('div', { class: 'ov-batt-pct', text: pct == null ? '—' : pct + '%' }),
      // Volts are how you tell a healthy pack from a sagging one, and the percentage alone never says it.
      el('div', { class: 'ov-batt-volts', text: volts == null ? '' : `${formatNum(Math.round(volts * 10) / 10)} V` }),
      el('div', { class: 'ov-sub', text: state })));
    card.appendChild(body);
    battWrap.appendChild(card);
  };

  /// One problem, said plainly and at a size that cannot be scrolled past.
  const alertCard = (level: string, title: string, state: string, detail: string) =>
    el('div', { class: 'ov-alert ' + level },
      el('span', { class: 'ov-alert-icon', text: level === 'bad' ? '⛔' : '⚠' }),
      el('div', {},
        el('div', { class: 'ov-alert-title', text: `${title} — ${state}` }),
        el('div', { class: 'desc', text: detail || '' })));

  const drawStatus = (body: any) => {
    const cards = (body && body.cards) || [];
    alerts.innerHTML = '';
    if (!cards.length) return;
    const wrong = cards.filter((c: any) => c.level === 'bad' || c.level === 'warn');
    if (!wrong.length) {
      const ok = cards.filter((c: any) => c.level === 'good').length;
      alerts.appendChild(el('div', { class: 'ov-allgood' },
        el('span', { class: 'dot good' }),
        el('span', { text: `All ${ok} component${ok === 1 ? '' : 's'} healthy` }),
        el('a', { class: 'ov-allgood-link', text: 'Status board', onclick: () => (document.querySelector('nav a[data-label="Status"]') as any)?.click() })));
      return;
    }
    wrong.sort((a: any, b: any) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));
    wrong.forEach((c: any) => alerts.appendChild(alertCard(c.level, c.title, c.state, c.detail)));
  };

  let lastDay: any = null;

  const drawDay = () => {
    dayRow.innerHTML = '';
    const body = lastDay;
    if (!body?.ok || !(body.series || []).length) {
      dayRow.appendChild(el('div', { class: 'desc', text: 'No history for the last 24 hours yet.' }));
      return;
    }
    const steps = ((body.series || [])[0]?.values || []).length;
    /// Sum a set of series step by step. Only a step EVERY one of them reported counts: a partial sum reads
    /// as a dip that never happened.
    const sumSeries = (list: any[]) => !list.length ? [] : Array.from({ length: steps }, (_, i) => {
      let total = 0;
      for (const s of list) { const v = s.values[i]; if (typeof v !== 'number') return null; total += v; }
      return total as number | null;
    });
    const ofKind = (kind: string, returns = false) => (body.series || [])
      .filter((s: any) => s.kind === kind && String(s.node).endsWith('#in') === returns);

    /// What the house drew at each step: the same balance as the figure above, done per reading rather
    /// than once. A step missing any part of that balance is a gap — filling it with a zero would draw a
    /// house that stopped using power.
    const homeValues = () => {
      const metered = ofKind('load');
      if (metered.length) return sumSeries(metered);
      const net = (kind: string) => {
        const out = sumSeries(ofKind(kind)), back = sumSeries(ofKind(kind, true));
        if (!out.length && !back.length) return [];
        return Array.from({ length: steps }, (_, i) => {
          const o = out[i], b = back[i];
          if (o == null && b == null) return null;
          return (o ?? 0) - (b ?? 0);
        });
      };
      const solar = sumSeries(ofKind('solar')), grid = net('grid'), batt = net('battery');
      const parts = [solar, grid, batt].filter(p => p.some(v => v != null));
      if (!parts.length) return [];
      return Array.from({ length: steps }, (_, i) => {
        let total = 0;
        for (const p of parts) { const v = p[i]; if (v == null) return null; total += v; }
        return total as number | null;
      });
    };

    const strip = ([kind, label, icon]: [string, string, string]) => {
      const values = kind === 'home' ? homeValues() : sumSeries(ofKind(kind));
      if (!values.length || !values.some(v => v != null)) return;
      // The same shape as the tiles above: a figure, what it means, and the shape behind it. A strip on
      // its own says "something happened" without saying what.
      const known = values.filter((v): v is number => typeof v === 'number');
      const nowV = [...values].reverse().find((v): v is number => typeof v === 'number') ?? null;
      const peak = known.length ? Math.max(...known) : null;
      const box = el('div', { class: 'ov-tile ov-strip ov-' + kind });
      box.append(
        el('div', { class: 'ov-tile-head' },
          el('span', { class: 'ov-icon', text: icon }), el('span', { text: label }),
          el('span', { class: 'ov-peak', text: peak == null ? '' : `peak ${fmtW(peak)}` })),
        el('div', { class: 'ov-value', text: fmtW(nowV) }),
        sparkline({
          values, color: kind === 'home' ? 'var(--accent)' : (KIND_COLOR[kind] || 'var(--accent)'), units: body.units || 'W',
          width: 300, height: 72,
          at: (i: number) => (body.at || [])[i] ? new Date(body.at[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
        }),
        el('div', { class: 'ov-sub', text: known.length ? `${known.length} of ${values.length} readings` : 'no readings' }));
      dayRow.appendChild(box);
    };
    ([['solar', 'Solar', '☀'], ['grid', 'Grid', '⚡'], ['battery', 'Battery', '🔋'], ['home', 'Home', '⌂']] as [string, string, string][]).forEach(strip);
  };

  const loadDay = async () => {
    try {
      const r = await api('/api/flow/series?minutes=1440&step=900&metric=realpower');
      lastDay = r.body;
    } catch { lastDay = null; }
    drawDay();
  };

  const drawNow = (power: any, energy: any, live: Record<string, number>, liveInfo: Record<string, any>) => {
    const nodes = (power?.nodes || []) as any[];
    const solarIds = idsOfKind(nodes, 'solar'), gridIds = idsOfKind(nodes, 'grid'), battIds = idsOfKind(nodes, 'battery');
    const solarW = sumOfKind(nodes, 'solar');
    const gridOut = sumOfKind(nodes, 'grid');
    const gridIn = sumKnown(gridIds.map(id => live[`${id}|realpower#in`]));
    const battOut = sumOfKind(nodes, 'battery');
    const battIn = sumKnown(battIds.map(id => live[`${id}|realpower#in`]));
    // One signed figure per bidirectional node: out is positive, in is negative.
    const gridNet = gridOut == null && gridIn == null ? null : (gridOut || 0) - (gridIn || 0);
    const battNet = battOut == null && battIn == null ? null : (battOut || 0) - (battIn || 0);
    // A metered load node wins over the balance of sources; without one the home is what is left over.
    const loadW = idsOfKind(nodes, 'load').length ? sumOfKind(nodes, 'load') : undefined;
    const homeW = homeEnergy({ solar: solarW, grid: gridNet, battery: battNet, ...(loadW === undefined ? {} : { load: loadW }) });

    const arms: FlowArm[] = [];
    if (solarIds.length) arms.push({ key: 'solar', icon: '☀', label: 'Solar', text: fmtW(solarW), color: KIND_COLOR.solar, flow: solarW, ids: solarIds });
    if (gridIds.length) arms.push({ key: 'grid', icon: '⚡', label: 'Grid', text: fmtW(gridNet == null ? null : Math.abs(gridNet)), color: KIND_COLOR.grid, flow: gridNet, ids: gridIds });
    if (battIds.length) arms.push({ key: 'battery', icon: '🔋', label: 'Battery', text: fmtW(battNet == null ? null : Math.abs(battNet)), color: KIND_COLOR.battery, flow: battNet, ids: battIds });
    arms.push({ key: 'home', icon: '⌂', label: 'Home', text: fmtW(homeW), color: 'var(--accent)', flow: homeW == null ? null : -homeW });
    drawEnergyFlow(flowWrap, arms, (a, g) => {
      g.style.cursor = 'pointer';
      g.onclick = () => {
        requestFocus(a.ids!, 'today=1&step=300', a.label);
        (document.querySelector('nav a[data-label="Trends"]') as any)?.click();
      };
    });

    const socVals = battIds.map(id => live[`${id}|soc`]).filter((v): v is number => typeof v === 'number');
    // Voltage is a condition at a point, never a sum: several packs in parallel share one bus voltage.
    const voltVals = battIds.map(id => live[`${id}|voltage`]).filter((v): v is number => typeof v === 'number');
    drawBattery(socVals.length ? Math.round(socVals.reduce((a, b) => a + b, 0) / socVals.length) : null,
      battNet, battIds.length ? 'no charge source bound' : 'no battery configured',
      voltVals.length ? voltVals.reduce((a, b) => a + b, 0) / voltVals.length : null);

    // --- Today ------------------------------------------------------------------------------------
    todayRow.innerHTML = '';
    const eNodes = (energy?.nodes || []) as any[];
    if (!eNodes.length) {
      todayRow.appendChild(el('div', { class: 'desc', text: 'No energy totals yet — history is off, or nothing has reported today.' }));
      return;
    }
    const eSolar = sumOfKind(eNodes, 'solar');
    const eGridOut = sumOfKind(eNodes, 'grid');
    const eGridIn = sumKnown(gridIds.map(id => {
      const n = eNodes.find((x: any) => x.id === id + '#in');
      return typeof n?.value === 'number' ? n.value : undefined;
    }));
    const eBattOut = sumOfKind(eNodes, 'battery');
    const eLoad = idsOfKind(eNodes, 'load').length ? sumOfKind(eNodes, 'load') : undefined;
    const eHome = homeEnergy({
      solar: eSolar, battery: eBattOut,
      grid: eGridOut == null && eGridIn == null ? null : (eGridOut || 0) - (eGridIn || 0),
      ...(eLoad === undefined ? {} : { load: eLoad }),
    });

    if (solarIds.length) todayRow.appendChild(tile('solar', '☀', 'Solar produced', fmtKwh(eSolar), 'since the day rolled over', solarIds));
    if (gridIds.length) todayRow.appendChild(tile('grid', '⚡', 'Grid imported', fmtKwh(eGridOut), eGridIn ? `${fmtKwh(eGridIn)} exported` : 'nothing exported', gridIds));
    todayRow.appendChild(tile('home', '⌂', 'Home used', fmtKwh(eHome), eHome == null ? 'no measured sources' : 'everything the house drew', []));
    const pct = selfSufficiencyPct(eHome, eGridOut);
    todayRow.appendChild(tile('self', '◔', 'Self-sufficiency', pct == null ? '—' : `${Math.round(pct)}%`,
      pct == null ? 'needs both home use and grid import' : 'of what the house used came from you', []));
  };

  let power: any = null, energy: any = null;

  const load = async () => {
    stamp.textContent = 'loading…';
    try {
      const [p, e] = await Promise.all([api('/api/flow?metric=realpower'), api('/api/flow?metric=energytoday')]);
      power = p.body; energy = e.body;
      const nodes = (power?.nodes || []) as any[];
      const battIds = idsOfKind(nodes, 'battery'), gridIds = idsOfKind(nodes, 'grid');
      const q = [
        ...[...battIds, ...gridIds].map(id => ({ Node: id, Metric: 'realpower#in' })),
        ...battIds.map(id => ({ Node: id, Metric: 'soc' })),
        ...battIds.map(id => ({ Node: id, Metric: 'voltage' })),
      ];
      const live: Record<string, number> = {}, liveInfo: Record<string, any> = {};
      if (q.length) {
        try {
          const lr = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
          (lr.body?.values || []).forEach((v: any) => {
            liveInfo[`${v.node}|${v.metric}`] = v;
            if (typeof v.value === 'number') live[`${v.node}|${v.metric}`] = v.value;
          });
        } catch { /* the live cache is not there; those readings stay absent */ }
      }
      drawNow(power, energy, live, liveInfo);
      stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
    } catch (err: any) {
      stamp.textContent = '';
      alerts.appendChild(alertCard('bad', 'Overview', 'could not load', err?.message || 'the request failed'));
    }
    try { drawStatus((await api('/api/status/board')).body); } catch { /* the board has its own page */ }
    await loadDay();
  };

  refresh.onclick = () => load();
  liveWhileActive(sec, () => 'flow:realpower', () => load());
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive()) load(); }, 15000);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, load };
}

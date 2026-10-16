import { api, el, activate, navLink, formatNum, btn } from '../helpers.js';
import { liveWhileActive, realtimeLive } from '../realtime.js';
import { drawEnergyFlow, type FlowArm } from '../energy-diagram.js';
import { sparkline, KIND_COLOR } from '../charts.js';
import { homeEnergy, selfSufficiencyPct, netSelfProducedPct, shareBand, sumKnown } from '../energy.js';
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
  const showSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  showSel.appendChild(el('option', { value: 'energy_d', text: 'Energy (kWh)' }));
  showSel.appendChild(el('option', { value: 'realpower', text: 'Power (W)' }));
  try { showSel.value = localStorage.getItem('rpdu-overview-show') === 'realpower' ? 'realpower' : 'energy_d'; } catch { showSel.value = 'energy_d'; }
  const stamp = el('span', { class: 'ld-count' });
  bar.append(showSel, refresh, stamp); sec.appendChild(bar);

  const alerts = el('div'); sec.appendChild(alerts);

  const now = el('div', { class: 'ov-now' }); sec.appendChild(now);
  const flowWrap = el('div', { class: 'energy-flow ov-flow' }); now.appendChild(flowWrap);
  const battWrap = el('div', { class: 'ov-batt-side' }); now.appendChild(battWrap);

  sec.appendChild(el('h3', { text: 'Today so far', class: 'ov-h3' }));
  const todayRow = el('div', { class: 'ov-tiles' }); sec.appendChild(todayRow);

  sec.appendChild(el('h3', { text: 'Last 24 hours', class: 'ov-h3' }));
  const dayRow = el('div', { class: 'ov-tiles' }); sec.appendChild(dayRow);

  const fmtW = (w: number | null) => w == null ? '—'
    : Math.abs(w) >= 1000 ? `${formatNum(Math.round(w / 100) / 10)} kW` : `${formatNum(Math.round(w))} W`;
  const fmtKwh = (v: number | null) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} kWh`;

  const idsOfRole = (nodes: any[], role: string) => nodes.filter(n => n.balance === role && !n.id.includes('#')).map(n => n.id);
  const sumOfRole = (nodes: any[], role: string) => {
    const vals = nodes.filter(n => n.balance === role && !n.id.includes('#') && typeof n.value === 'number').map(n => n.value);
    return vals.length ? vals.reduce((a: number, b: number) => a + b, 0) : null;
  };

  const tile = (kind: string, icon: string, label: string, value: string | Node, sub: string, ids: string[]) => {
    const t = el('div', { class: 'ov-tile ov-' + kind });
    t.append(
      el('div', { class: 'ov-tile-head' }, el('span', { class: 'ov-icon', text: icon }), el('span', { text: label })),
      typeof value === 'string' ? el('div', { class: 'ov-value', text: value }) : value,
      el('div', { class: 'ov-sub', text: sub }));
    if (ids.length) {
      t.classList.add('is-link');
      t.title = `Show ${label} through the day`;
      t.onclick = () => {
        requestFocus(ids, 'today=1', label);
        (document.querySelector('nav a[data-label="Node Trends"]') as any)?.click();
      };
    }
    return t;
  };

  const drawBattery = (soc: number | null, watts: number | null, why: string, volts: number | null) => {
    battWrap.innerHTML = '';
    const charging = watts != null && watts < -1;
    const idle = watts == null || Math.abs(watts) <= 1;
    const pct = soc == null ? null : Math.max(0, Math.min(100, soc));
    const level = pct == null ? 'unknown' : pct >= 60 ? 'good' : pct >= 25 ? 'warn' : 'bad';

    const card = el('div', { class: 'ov-batt-card' });
    card.appendChild(el('div', { class: 'ov-batt-title', text: 'Battery' }));
    const body = el('div', { class: 'ov-batt-body ov-batt-' + level });
    const shell = el('div', { class: 'ov-batt-shell' });
    const fill = el('div', { class: 'ov-batt-fill' });
    fill.style.height = (pct == null ? 0 : pct) + '%';
    shell.append(fill, el('div', { class: 'ov-batt-cap' }));
    const state = pct == null ? why : idle ? 'idle' : charging ? `charging · ${fmtW(Math.abs(watts!))}` : `discharging · ${fmtW(watts!)}`;
    body.append(shell, el('div', { class: 'ov-batt-read' },
      el('div', { class: 'ov-batt-pct', text: pct == null ? '—' : pct + '%' }),
      el('div', { class: 'ov-batt-volts', text: volts == null ? '' : `${formatNum(Math.round(volts * 10) / 10)} V` }),
      el('div', { class: 'ov-sub', text: state })));
    card.appendChild(body);
    battWrap.appendChild(card);
  };

  let withheld: any[] = [];

  const alertCard = (level: string, title: string, state: string, detail: string, id?: string, onDismiss?: () => void) => {
    const mine = withheld.filter((w: any) => !id || !w.integration || w.integration === id);
    const card = el('div', { class: 'ov-alert ' + level },
      el('span', { class: 'ov-alert-icon', text: level === 'bad' ? '⛔' : '⚠' }));
    if (onDismiss) {
      const x = el('button', { class: 'ov-alert-x', type: 'button', text: '×', title: 'Dismiss' }) as HTMLButtonElement;
      x.onclick = onDismiss;
      card.appendChild(x);
    }
    const body = el('div', { class: 'ov-alert-body' },
      el('div', { class: 'ov-alert-title', text: `${title} — ${state}` }),
      el('div', { class: 'desc', text: detail || '' }));
    card.appendChild(body);
    if (!mine.length) return card;

    const list = el('div', { class: 'ov-alert-detail' });
    list.hidden = true;
    mine.forEach((w: any) => {
      const row = el('div', { class: 'ov-withheld' });
      row.appendChild(el('strong', { text: `${w.node}${w.metric ? ' · ' + w.metric : ''}` }));
      if (w.source) row.appendChild(el('code', { text: w.source }));
      row.appendChild(el('div', { class: 'desc', text: w.reason || 'No reason given.' }));
      list.appendChild(row);
    });

    const toggle = el('button', { class: 'ov-alert-more', type: 'button' }) as HTMLButtonElement;
    const label = () => `${list.hidden ? 'Show' : 'Hide'} ${mine.length} withheld binding${mine.length === 1 ? '' : 's'}`;
    toggle.textContent = label();
    toggle.onclick = () => { list.hidden = !list.hidden; toggle.textContent = label(); };
    body.append(toggle, list);
    return card;
  };

  const DISMISS_KEY = 'rpdu-ov-dismissed';
  const dismissed = new Set<string>();
  try { (JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]') as string[]).forEach(k => dismissed.add(k)); } catch { /* none */ }
  const saveDismissed = () => { try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed])); } catch { /* this view only */ } };

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

    const keyOf = (c: any) => `${c.id || c.title}|${c.level}|${c.state}`;
    const present = new Set(wrong.map(keyOf));
    dismissed.forEach(k => { if (!present.has(k)) dismissed.delete(k); });
    saveDismissed();
    const shown = wrong.filter((c: any) => !dismissed.has(keyOf(c)));
    const hidden = wrong.length - shown.length;

    const head = el('div', { class: 'ov-alerts-head' });
    const bad = shown.filter((c: any) => c.level === 'bad').length;
    head.appendChild(el('span', { text: shown.length
      ? `${shown.length} alert${shown.length === 1 ? '' : 's'}${bad ? ` · ${bad} failing` : ''}` : 'No alerts shown' }));
    if (hidden) {
      const back = el('button', { class: 'ov-alert-more', type: 'button', text: `Show ${hidden} dismissed` }) as HTMLButtonElement;
      back.onclick = () => { wrong.forEach((c: any) => dismissed.delete(keyOf(c))); saveDismissed(); drawStatus(body); };
      head.appendChild(back);
    }
    if (shown.length) {
      const all = el('button', { class: 'ov-alert-more', type: 'button', text: 'Dismiss all' }) as HTMLButtonElement;
      all.onclick = () => { shown.forEach((c: any) => dismissed.add(keyOf(c))); saveDismissed(); drawStatus(body); };
      head.appendChild(all);
    }
    alerts.appendChild(head);
    shown.forEach((c: any) => alerts.appendChild(alertCard(c.level, c.title, c.state, c.detail, c.id,
      () => { dismissed.add(keyOf(c)); saveDismissed(); drawStatus(body); })));
  };

  let lastDay: any = null;
  let origin: { carriedOver: number; accumulatingSinceUtc?: string; store?: string } | null = null;
  const sinceLabel = () => {
    if (!origin || origin.carriedOver > 0 || !origin.accumulatingSinceUtc) return 'since the day rolled over';
    const from = new Date(origin.accumulatingSinceUtc);
    return `only since ${from.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — totals did not carry over`;
  };
  const originNote = () => {
    if (!origin || origin.carriedOver > 0 || !origin.accumulatingSinceUtc) return null;
    const where = origin.store === 'file' ? 'a file inside the container'
      : origin.store === 'cache' ? 'the shared cache' : 'memory';
    return el('div', { class: 'ov-note warn' },
      el('span', { class: 'ov-alert-icon', text: '⚠' }),
      el('div', {},
        el('div', { class: 'ov-alert-title', text: 'Today’s totals restarted with the process' }),
        el('div', { class: 'desc', text:
          `Nothing carried over from ${where}, so the figures below cover only since `
          + `${new Date(origin.accumulatingSinceUtc).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, `
          + 'not the whole day. Trends reads the history backend and still shows the full day.' })));
  };

  const drawDay = () => {
    dayRow.innerHTML = '';
    const body = lastDay;
    if (!body?.ok || !(body.series || []).length) {
      dayRow.appendChild(el('div', { class: 'desc', text: 'No history for the last 24 hours yet.' }));
      return;
    }
    const steps = ((body.series || [])[0]?.values || []).length;
    const sumSeries = (list: any[]) => !list.length ? [] : Array.from({ length: steps }, (_, i) => {
      let total = 0;
      for (const s of list) { const v = s.values[i]; if (typeof v !== 'number') return null; total += v; }
      return total as number | null;
    });
    const ofRole = (role: string, returns = false) => (body.series || [])
      .filter((s: any) => s.balance === role && String(s.node).endsWith('#in') === returns);

    const homeValues = () => {
      const metered = ofRole('home');
      if (metered.length) return sumSeries(metered);
      const net = (kind: string) => {
        const out = sumSeries(ofRole(kind)), back = sumSeries(ofRole(kind, true));
        if (!out.length && !back.length) return [];
        return Array.from({ length: steps }, (_, i) => {
          const o = out[i], b = back[i];
          if (o == null && b == null) return null;
          return (o ?? 0) - (b ?? 0);
        });
      };
      const solar = sumSeries(ofRole('solar')), grid = net('grid'), batt = net('battery');
      const parts = [solar, grid, batt].filter(p => p.some(v => v != null));
      if (!parts.length) return [];
      return Array.from({ length: steps }, (_, i) => {
        let total = 0;
        for (const p of parts) { const v = p[i]; if (v == null) return null; total += v; }
        return total as number | null;
      });
    };

    const strip = ([kind, label, icon]: [string, string, string]) => {
      const values = kind === 'home' ? homeValues() : sumSeries(ofRole(kind));
      if (!values.length || !values.some(v => v != null)) return;
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
    const solarIds = idsOfRole(nodes, 'solar'), gridIds = idsOfRole(nodes, 'grid'), battIds = idsOfRole(nodes, 'battery');
    const solarW = sumOfRole(nodes, 'solar');
    const gridOut = sumOfRole(nodes, 'grid');
    const gridIn = sumKnown(gridIds.map(id => live[`${id}|realpower#in`]));
    const battOut = sumOfRole(nodes, 'battery');
    const battIn = sumKnown(battIds.map(id => live[`${id}|realpower#in`]));
    const gridNet = gridOut == null && gridIn == null ? null : (gridOut || 0) - (gridIn || 0);
    const battNet = battOut == null && battIn == null ? null : (battOut || 0) - (battIn || 0);
    const loadW = idsOfRole(nodes, 'home').length ? sumOfRole(nodes, 'home') : undefined;
    const homeW = homeEnergy({ solar: solarW, grid: gridNet, battery: battNet, ...(loadW === undefined ? {} : { load: loadW }) });

    const eNodes = (energy?.nodes || []) as any[];
    const eInOf = (ids: string[]) => sumKnown(ids.map(id => {
      const n = eNodes.find((x: any) => x.id === id + '#in');
      return typeof n?.value === 'number' ? n.value : undefined;
    }));
    const eSolar = sumOfRole(eNodes, 'solar');
    const eGridOut = sumOfRole(eNodes, 'grid');
    const eGridIn = eInOf(gridIds);
    const eBattOut = sumOfRole(eNodes, 'battery');
    const eBattIn = eInOf(battIds);
    const eBattNet = eBattOut == null && eBattIn == null ? null : (eBattOut || 0) - (eBattIn || 0);
    const eGridSigned = eGridOut == null && eGridIn == null ? null : (eGridOut || 0) - (eGridIn || 0);
    const eLoad = idsOfRole(eNodes, 'home').length ? sumOfRole(eNodes, 'home') : undefined;
    const eHome = homeEnergy({
      solar: eSolar, battery: eBattNet, grid: eGridSigned,
      ...(eLoad === undefined ? {} : { load: eLoad }),
    });

    const isEnergy = showSel.value !== 'realpower';
    const fmtF = isEnergy ? fmtKwh : fmtW;
    const fSolar = isEnergy ? eSolar : solarW, fGrid = isEnergy ? eGridSigned : gridNet;
    const fBatt = isEnergy ? eBattNet : battNet, fHome = isEnergy ? eHome : homeW;
    const arms: FlowArm[] = [];
    if (solarIds.length) arms.push({ key: 'solar', icon: '☀', label: 'Solar', text: fmtF(fSolar), color: KIND_COLOR.solar, flow: fSolar, ids: solarIds });
    if (gridIds.length) arms.push({ key: 'grid', icon: '⚡', label: 'Grid', text: fmtF(fGrid == null ? null : Math.abs(fGrid)), color: KIND_COLOR.grid, flow: fGrid, ids: gridIds });
    if (battIds.length) arms.push({ key: 'battery', icon: '🔋', label: 'Battery', text: fmtF(fBatt == null ? null : Math.abs(fBatt)), color: KIND_COLOR.battery, flow: fBatt, ids: battIds });
    arms.push({ key: 'home', icon: '⌂', label: 'Home', text: fmtF(fHome), color: 'var(--accent)', flow: fHome == null ? null : -fHome });
    drawEnergyFlow(flowWrap, arms, (a, g) => {
      g.style.cursor = 'pointer';
      g.onclick = () => {
        requestFocus(a.ids!, 'today=1', a.label);
        (document.querySelector('nav a[data-label="Node Trends"]') as any)?.click();
      };
    });

    const socVals = battIds.map(id => live[`${id}|soc`]).filter((v): v is number => typeof v === 'number');
    const voltVals = battIds.map(id => live[`${id}|voltage`]).filter((v): v is number => typeof v === 'number');
    drawBattery(socVals.length ? Math.round(socVals.reduce((a, b) => a + b, 0) / socVals.length) : null,
      battNet, battIds.length ? 'no charge source bound' : 'no battery configured',
      voltVals.length ? voltVals.reduce((a, b) => a + b, 0) / voltVals.length : null);

    todayRow.innerHTML = '';
    if (!eNodes.length) {
      todayRow.appendChild(el('div', { class: 'desc', text: 'No energy totals yet — history is off, or nothing has reported today.' }));
      return;
    }

    const note = originNote();
    if (note) todayRow.appendChild(note);
    if (solarIds.length) todayRow.appendChild(tile('solar', '☀', 'Solar produced', fmtKwh(eSolar), sinceLabel(), solarIds));
    if (gridIds.length) {
      const eGridNet = eGridOut == null || eGridIn == null ? null : eGridOut - eGridIn;
      const cols = el('div', { class: 'ov-cols' },
        el('div', {}, el('div', { class: 'ov-col-label', text: 'Imported' }), el('div', { class: 'ov-value', text: fmtKwh(eGridOut) })),
        el('div', {}, el('div', { class: 'ov-col-label', text: 'Exported' }), el('div', { class: 'ov-value', text: fmtKwh(eGridIn) })));
      todayRow.appendChild(tile('grid', '⚡', 'Grid', cols, eGridNet == null ? 'net needs both import and export'
        : `net ${fmtKwh(Math.abs(eGridNet))} ${eGridNet < 0 ? 'exported' : 'imported'}`, gridIds));
    }
    todayRow.appendChild(tile('home', '⌂', 'Home used', fmtKwh(eHome), eHome == null ? 'no measured sources' : 'everything the house drew', []));
    const pct = selfSufficiencyPct(eHome, eGridOut);
    todayRow.appendChild(tile('self', '◔', 'Self-sufficiency', pct == null ? '—' : `${Math.round(pct)}%`,
      pct == null ? 'needs both home use and grid import' : 'of what the house used came from you', []));
    const netPct = netSelfProducedPct(eHome, eGridOut == null || eGridIn == null ? null : eGridOut - eGridIn);
    const netTile = tile('net', '☀', 'Self-produced (net)', netPct == null ? '—' : `${Math.round(netPct)}%`,
      netPct == null ? 'needs home use, grid import and export' : 'of what the house used, net of export', []);
    if (netPct != null) netTile.querySelector('.ov-value')?.classList.add('ov-band-' + shareBand(netPct));
    todayRow.appendChild(netTile);
  };

  let power: any = null, energy: any = null;

  const load = async () => {
    stamp.textContent = 'loading…';
    try {
      const [p, e] = await Promise.all([api('/api/flow?metric=realpower'), api('/api/flow?metric=energy_d')]);
      try { origin = (await api('/api/time')).body?.period ?? null; } catch { origin = null; }
      power = p.body; energy = e.body;
      const nodes = (power?.nodes || []) as any[];
      const battIds = idsOfRole(nodes, 'battery'), gridIds = idsOfRole(nodes, 'grid');
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
    try {
      const w = await api('/api/flow/withheld');
      withheld = (w.body && w.body.ok && w.body.sources) || [];
    } catch { withheld = []; }
    try { drawStatus((await api('/api/status/board')).body); } catch { /* the board has its own page */ }
    await loadDay();
  };

  refresh.onclick = () => load();
  showSel.onchange = () => {
    try { localStorage.setItem('rpdu-overview-show', showSel.value); } catch { /* not remembered */ }
    load();
  };
  liveWhileActive(sec, () => 'flow:realpower', () => load());
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive()) load(); }, 15000);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, load };
}

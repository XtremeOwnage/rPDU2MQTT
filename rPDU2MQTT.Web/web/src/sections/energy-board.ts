// The Energy Overview: where power is flowing right now, as four tiles and an animated diagram.
//
// Split out of flow.ts, which had grown to four unrelated pages in one file. It depends on exactly three
// things from the rest of the flow code — the moment picker and the two functions that phrase its query
// and its answer — and those now live in history-control.ts, so this page and the Sankey cannot describe
// the same window differently.
import { api, btn, el, activate, formatNum, svgEl, navLink, instanceSelector, withInstance } from '../helpers.js';
import { liveWhileActive, realtimeLive } from '../realtime.js';
import { state } from '../state.js';
// The energy rules every view shares — see energy.ts for why they are not written twice.
import { homeEnergy, selfSufficiencyPct, coveredEnergy } from '../energy.js';
import { historyControl, historyQuery, historyNote } from '../history-control.js';


// The Energy overview (#energy-rollup C): an at-a-glance board of where power is flowing right now —
// solar in, battery charging/discharging, grid import/export, and the house load — summed from the nodes
// tagged solar/battery/grid. It reads the same live values everything else does; anything unmeasured shows
// "—", never a fabricated zero (the whole flow's accuracy rule). Battery/grid net uses the in-direction
// (charge/export) power from the #in cache key, so the arrows point the right way.
export function addEnergyOverviewSection(nav: any, sections: any) {
  const link = navLink(nav, "Energy", "⚡");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Energy Overview' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Where your power is flowing right now, from the latest poll. Figures are summed from the nodes you tagged solar / battery / grid; anything unmeasured shows “—”, never a guess. Tag nodes and bind their sources on the Nodes tab.' }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  // Power now, or energy for the day so far (#371). Two different questions: what the house is doing this
  // second, and what it has used since the period rolled over.
  const showSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  showSel.appendChild(el('option', { value: 'realpower', text: 'Power (W)' }));
  showSel.appendChild(el('option', { value: 'energytoday', text: 'Energy today (kWh)' }));
  const instSel = instanceSelector(() => load());
  const status = el('span', { class: 'ld-count' });
  bar.append(refresh, el('span', { class: 'desc', style: { margin: '0' }, text: 'Show:' }), showSel, instSel.wrap, status);
  sec.appendChild(bar);
  // As on the Flow page: a whole day is an energy question, a specific time is a power one, and the choice
  // is a default at the moment of the pick rather than something re-imposed on every load.
  let hadDay = false;
  const hist = historyControl((what: any) => {
    const leftLive = what === 'day' && !hadDay && !!hist.day();
    hadDay = !!hist.day();
    if ((leftLive && !hist.time() && showSel.value === 'realpower') || (what === 'span' && hist.span() > 1))
      showSel.value = 'energytoday';
    load();
  });
  sec.appendChild(hist.row);
  showSel.onchange = () => load();

  // One column for the whole board, so the diagram and the tiles share an edge and read as a single
  // thing. Left to themselves the diagram centred itself in the page while the tiles bunched up against
  // the left margin, and the two looked unrelated.
  const board = el('div', { class: 'energy-board' }); sec.appendChild(board);
  const flowWrap = el('div', { class: 'energy-flow' }); board.appendChild(flowWrap);
  const grid = el('div', { class: 'energy-grid' }); board.appendChild(grid);
  const summary = el('div', { class: 'energy-summary' }); board.appendChild(summary);

  const fmtPower = (w: number | null) => w == null ? '—'
    : Math.abs(w) >= 1000 ? `${formatNum(w / 1000)} kW` : `${formatNum(Math.round(w))} W`;
  // Energy is cumulative (kWh); one decimal is plenty and the units come from the energy graph itself.
  const fmtEnergy = (v: number | null, units: string) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} ${units || 'kWh'}`;

  // A tile: coloured accent, big power figure, a direction/idle sub-line.
  // A dial drawn only against a ceiling somebody stated. Nothing here invents a maximum: without one the
  // tile shows the plain reading, which is the honest rendering of a quantity whose limit nobody has given.
  // Mirrors Core.Flow.Gauge, which owns the arithmetic and its edge cases.
  const gaugeArc = (fraction: number, over: boolean) => {
    const R = 26, CX = 30, CY = 30;
    // A 240° sweep opening at the bottom — the shape a dial is read as, rather than a full ring which has
    // no start and therefore no "empty".
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
                gauge?: { fraction: number, over: boolean, max: number, units: string }) => {
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
    return t;
  };

  /// The gauge for a node, or undefined when one would be a guess. Reads Max straight from the config the
  /// Nodes tab edits, so setting it takes effect on the next refresh with no restart.
  const gaugeFor = (ids: string[], value: number | null, units: string) => {
    const cfgNodes = (state.data?.EnergyFlow?.Nodes || []) as any[];
    // Several tagged nodes of one kind (three MPPTs, two arrays) sum into one tile, so their ceilings sum too.
    const maxes = ids.map(id => cfgNodes.find(n => n.Id === id)?.Max).filter((m: any) => typeof m === 'number' && m > 0);
    if (!maxes.length || value == null) return undefined;
    const max = maxes.reduce((a: number, b: number) => a + b, 0);
    const fraction = Math.min(1, Math.max(0, value / max));
    return { fraction, over: value > max, max, units };
  };

  // The animated flow diagram: a central hub with Solar (top), Grid (left), Battery (right) and Home (bottom),
  // particles streaming along each arm in the real direction of flow — toward the hub when a source supplies,
  // away when it draws (charge/export/consumption). Speed and particle count scale with power; an unknown or
  // idle arm just shows a dim static line, never invented motion.
  const HUB = { x: 220, y: 150 };
  const NODEPOS: Record<string, { x: number, y: number }> = {
    solar: { x: 220, y: 46 }, grid: { x: 66, y: 150 }, battery: { x: 374, y: 150 }, home: { x: 220, y: 254 },
  };
  const drawFlow = (arms: { key: string, icon: string, label: string, text: string, color: string, flow: number | null }[]) => {
    flowWrap.innerHTML = '';
    // Frame only the arms that exist. The four positions describe the full cross (solar top, grid left,
    // battery right, home bottom); a fixed 440x300 box therefore reserved the whole bottom of the diagram
    // for a home arm that most setups never tag, leaving a tall band of blank space under it that the
    // board had to push the tiles past. Fit the box to what is actually drawn instead.
    // Only the vertical extent is fitted. The width stays the full cross (grid .. battery), because the
    // SVG is laid out at 100% width and its height follows from the aspect ratio — narrowing the box for a
    // one-armed system would make it render absurdly tall.
    const ys = arms.map(a => NODEPOS[a.key].y);
    // Below a node sits its label (+42) and value (+57); above it, the ring (r 26).
    const y0 = Math.min(HUB.y, ...ys) - 40, y1 = Math.max(HUB.y, ...ys) + 70;
    const svg = svgEl('svg', {
      viewBox: `12 ${y0} 416 ${y1 - y0}`,
      width: '100%', preserveAspectRatio: 'xMidYMid meet', class: 'energy-flow-svg',
    });
    const lines = svgEl('g', {}); const dots = svgEl('g', {}); const nodes = svgEl('g', {});
    svg.append(lines, dots, nodes);

    arms.forEach(a => {
      const p = NODEPOS[a.key];
      // Base connector (always visible, dim) between the node and the hub.
      lines.appendChild(svgEl('line', { x1: p.x, y1: p.y, x2: HUB.x, y2: HUB.y, class: 'energy-arm' }));

      // Direction: >0 supplies the hub (node→hub); <0 draws from it (hub→node). Home only ever consumes.
      const toHub = a.key === 'home' ? false : (a.flow ?? 0) >= 0;
      const mag = Math.abs(a.flow ?? 0);
      if (a.flow != null && mag > 1) {
        const [sx, sy, ex, ey] = toHub ? [p.x, p.y, HUB.x, HUB.y] : [HUB.x, HUB.y, p.x, p.y];
        const kw = mag / 1000;
        const dur = Math.max(2.2, 6 - Math.min(3.5, kw * 0.9));       // more power → faster
        const count = Math.min(5, Math.max(2, Math.round(1 + kw)));    // …and denser
        for (let i = 0; i < count; i++) {
          const dot = svgEl('circle', { r: 3.4, fill: a.color, class: 'energy-dot' });
          dot.appendChild(svgEl('animateMotion', { dur: `${dur}s`, repeatCount: 'indefinite', begin: `-${(dur / count) * i}s`, path: `M${sx},${sy} L${ex},${ey}` }));
          dots.appendChild(dot);
        }
      }

      // Node: a coloured ring with its icon, a label and the live figure.
      const g = svgEl('g', { class: 'energy-node' + (a.flow != null && mag > 1 ? ' live' : '') });
      g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 26, class: 'energy-node-ring', style: `stroke:${a.color}` }));
      const icon = svgEl('text', { x: p.x, y: p.y + 1, class: 'energy-node-icon' }); icon.textContent = a.icon; g.appendChild(icon);
      const lab = svgEl('text', { x: p.x, y: p.y + 42, class: 'energy-node-label' }); lab.textContent = a.label; g.appendChild(lab);
      const val = svgEl('text', { x: p.x, y: p.y + 57, class: 'energy-node-val' }); val.textContent = a.text; g.appendChild(val);
      nodes.appendChild(g);
    });

    // A small hub dot where the arms meet.
    nodes.appendChild(svgEl('circle', { cx: HUB.x, cy: HUB.y, r: 5, class: 'energy-hub' }));
    flowWrap.appendChild(svg);
  };

  // Why is this tile empty? "No reading yet" is a dead end — it doesn't say whether the node has no source
  // bound at all, or has one that has never delivered. The configured hierarchy is already in the browser,
  // so answer it here and point at the thing to go fix.
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

  // Same question for the battery's state of charge, which has its own source and so its own reasons to be
  // blank. A bare "—" cannot be acted on: a battery with no soc source bound and one bound to a topic that
  // never publishes look identical on screen and need completely different fixes. This happened for real —
  // a soc source pointed at a topic name the publisher does not use, so power read fine and the percentage
  // sat empty with nothing on the page to say why. Name the topic; that is the thing to check.
  const whyNoSoc = (battIds: string[], liveInfo: Record<string, any>) => {
    const cfg = (state.data?.EnergyFlow?.Nodes || []).filter((n: any) => battIds.includes(n.Id));
    if (!cfg.length) return 'no battery node';
    const socSrcs = cfg.flatMap((n: any) => (n.Sources || []).filter((s: any) => s.Metric === 'soc'));
    if (!socSrcs.length) return 'no charge source bound';
    // Bound and expired: the endpoint still reports the last reading, so say how old it is rather than
    // showing a figure that is no longer true.
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

  // Sum a kind's out-direction (graph) values. Returns present (any nodes of this kind) and the known sum
  // (null when nodes exist but none has a value) so we can tell "no grid" from "grid, value unknown".
  const sumKind = (nodes: any[], kind: string) => {
    const ns = nodes.filter(n => (n.kind || 'node') === kind);
    let sum = 0, known = false;
    ns.forEach(n => { if (typeof n.value === 'number') { sum += n.value; known = true; } });
    return { present: ns.length > 0, value: known ? sum : null };
  };

  // The board needs several round-trips, and it is now triggered by pushes as well as by the timer and
  // the button — so never let a second pass start on top of one still in flight.
  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    try { await loadBoard(); } finally { loading = false; }
  };

  const loadBoard = async () => {
    // The whole board reads one metric (#371). Power and energy-today are the same shape — a value per
    // node plus an in-direction for the bidirectional ones — so the tiles are built once and the metric
    // decides what they mean.
    const metric = showSel.value || 'realpower';
    const isEnergy = metric !== 'realpower';
    let r: any;
    const at = hist.at();
    let path = withInstance('/api/flow' + (isEnergy ? '?metric=' + encodeURIComponent(metric) : ''), instSel);
    const past = historyQuery(hist);
    if (past) path += (path.includes('?') ? '&' : '?') + past.slice(1);
    try { r = await api(path); }
    catch (e: any) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    grid.innerHTML = ''; summary.innerHTML = ''; flowWrap.innerHTML = '';
    if (!r.body || !r.body.ok) {
      // Say what actually went wrong. A bare "could not load" leaves you with nowhere to start; the
      // server's own message is the useful thing, and its HTTP status is the fallback.
      const why = (r.body && r.body.message) || `the server answered ${r.status ?? '?'} with no explanation`;
      grid.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'Could not load energy data — ' + why }));
      status.textContent = ''; return;
    }
    // Derived lanes are for the diagram, not the totals. The graph carries synthetic nodes the builder
    // adds to make the picture balance — a bidirectional node's return lane (`battery#in`, `grid#in`) and
    // a pass-through's unmetered remainder (`…#unmeasured`). The return lanes deliberately inherit their
    // parent's kind so they colour and read as the same device, which means a plain sumKind('battery')
    // would add charge to discharge and sumKind('grid') would add export to import — the tiles would
    // report a battery doing both at once. These tiles compute the in-direction themselves, from the live
    // cache, a few lines below. '#' appears in no real id (PDU and outlet ids use ':'), so it is a safe
    // marker for "the builder made this".
    hist.setNote(historyNote(r.body));
    const nodes = (r.body.nodes || []).filter((n: any) => !String(n.id || '').includes('#'));

    // Live cache reads: the in-direction (charge/export) power for battery/grid nodes, plus battery state of
    // charge — none of which the flow graph carries. Keyed by node|metric so one round-trip covers them all.
    const battIds = nodes.filter((n: any) => n.kind === 'battery').map((n: any) => n.id);
    const gridIds = nodes.filter((n: any) => n.kind === 'grid').map((n: any) => n.id);
    // The other two kinds, for the gauges: a tile sums every node of its kind, so its ceiling sums too.
    const solarIds = nodes.filter((n: any) => n.kind === 'solar').map((n: any) => n.id);
    const loadIds = nodes.filter((n: any) => n.kind === 'load').map((n: any) => n.id);
    const liveBy: Record<string, number> = {};
    // The full record, not just the value: it carries the staleness fields (reported/ageSeconds/fresh),
    // which are the only way to tell a source that has expired from one that never published at all.
    const liveInfo: Record<string, any> = {};

    // A past view must not read the live cache. It did, so a board showing last Tuesday took its
    // charge/export and its state of charge from this second and printed them under that date — the same
    // mistake as painting a live diagram over a chosen day, in the one place that was still doing it.
    // Historically the in-direction comes from the graph itself: the return lanes are series of their own.
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
    // the exporter keeps no series for it, so a past view has none, and showing today's would be a reading
    // from the wrong moment dressed as that day's.
    const socVals = historical ? [] : battIds.map(id => liveBy[`${id}|soc`]).filter((v): v is number => typeof v === 'number');
    const soc = socVals.length ? Math.round(socVals.reduce((a, b) => a + b, 0) / socVals.length) : null;

    // Formatting and gauges follow the metric. A node's Max is a full-scale power figure, so a dial against
    // it means nothing for kWh — the tile shows the plain reading instead.
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

    // Home load: prefer explicitly-tagged load nodes; otherwise derive from the balance, but only when every
    // present source is known (an unknown feeder would make the balance a guess — so it shows "—" instead).
    let home: number | null = null, homeSub = '';
    if (load_.present) { home = load_.value; homeSub = home == null ? 'no reading yet' : 'consuming'; }
    else {
      // Same rule as the Trends page: a kind the system does not have is left out, one that exists but has
      // not reported is unknown and stops the balance rather than counting as nothing.
      home = homeEnergy({
        ...(solar.present ? { solar: solar.value } : {}),
        ...(batt.present ? { battery: battNet } : {}),
        ...(gridK.present ? { grid: gridNet } : {}),
      });
      if (home != null) homeSub = 'balance of measured sources';
    }

    // Self-sufficiency is an ENERGY question — over some window, what share of the home's kWh came from
    // solar + battery rather than the grid — so it is answered over the window the board is showing.
    //
    // It used to fetch lifetime energy unconditionally. Under a chosen day that put a figure describing all
    // time beneath tiles describing that day: the bar did not move when the day did, and the two contradicted
    // each other on the same screen.
    let eHome: number | null = null, eFromGrid: number | null = null, eUnits = 'kWh';
    let eWindow = 'of lifetime energy';
    if (isEnergy) {
      // The board is already an energy view, so the bar is a share of the very tiles above it. No second
      // read, and no second way of deriving the same numbers that could disagree with them.
      eHome = home;
      eUnits = units;
      // Energy drawn from the grid is what it imported. Netting export off first would let a house that
      // imported 10 kWh and exported 10 read as fully self-sufficient, which it was not.
      eFromGrid = gridK.value == null ? null : Math.max(0, gridK.value);
      const day = hist.day();
      eWindow = day ? `of energy on ${new Date(hist.at()).toLocaleDateString()}`
        : metric === 'energytoday' ? 'of today’s energy' : 'of lifetime energy';
    } else try {
      // Today, not all time. On the power view this asked for lifetime energy, so the bar under a board of
      // live watts described every kWh since each counter was first bound — a figure that barely moves and
      // answers a question nobody was asking. Today is the window the rest of the board is about.
      const er = await api(withInstance('/api/flow?metric=energytoday', instSel));
      if (er.body?.ok) {
        const enodes = er.body.nodes || [];
        eUnits = er.body.units || 'kWh';
        // From the answer, not from what was asked for. Hardcoding "today" here meant the label kept
        // saying today no matter which metric came back, so it could not be wrong and could not be caught.
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
        // What the house drew, not what it drew net of what it sent back: exported energy is not
        // consumption avoided, and netting it off overstates the share solar covered.
        if (eGrid.value != null) eFromGrid = Math.max(0, eGrid.value);
      }
    } catch { /* energy graph unavailable — self-sufficiency just won't render */ }

    // Animated flow diagram — the arms present in this system, each with its live figure and flow direction.
    const arms: any[] = [];
    if (solar.present) arms.push({ key: 'solar', icon: '☀️', label: 'Solar', text: fmt(solar.value), color: 'var(--warn)', flow: solar.value });
    if (batt.present || battIds.length) arms.push({ key: 'battery', icon: '🔋', label: 'Battery', text: soc != null ? `${soc}%` : fmt(battNet == null ? null : Math.abs(battNet)), color: 'var(--good)', flow: battNet });
    if (gridK.present || gridIds.length) arms.push({ key: 'grid', icon: '⚡', label: 'Grid', text: fmt(gridNet == null ? null : Math.abs(gridNet)), color: 'var(--accent)', flow: gridNet });
    if (home != null || load_.present) arms.push({ key: 'home', icon: '🏠', label: 'Home', text: fmt(home), color: 'var(--muted)', flow: home });
    if (arms.length) drawFlow(arms);

    // Solar
    if (solar.present)
      grid.appendChild(tile('solar', '☀️', 'Solar', fmt(solar.value),
        subOrWhy(solar.value, 'solar', solar.value! > 1 ? 'producing' : 'idle'), solar.value && solar.value > 1 ? 'supply' : '',
        dial(solarIds, solar.value)));

    // Battery — sign tells charge vs discharge; magnitude is what's shown. SoC (when bound) leads the sub-line.
    if (batt.present || battIds.length) {
      const dir = subOrWhy(battNet, 'battery', battNet! > 1 ? 'discharging' : battNet! < -1 ? 'charging' : 'idle');
      const cls = battNet == null ? '' : battNet > 1 ? 'supply' : battNet < -1 ? 'draw' : '';
      // SoC always leads the sub-line — so the state-of-charge slot is always shown rather than silently
      // vanishing. When it is blank it says why (unbound / stale / never delivered) instead of just "—",
      // because "—" gives the operator nothing to go and fix.
      const socWhy = soc == null ? whyNoSoc(battIds, liveInfo) : null;
      // The dial is the battery's power against its rating; the slim bar below is state of charge. Two
      // different quantities, so they are two different marks rather than one doing double duty.
      const t = tile('battery', '🔋', 'Battery', fmt(battNet == null ? null : Math.abs(battNet)), `${soc == null ? socWhy : soc + '%'} · ${dir}`, cls,
        dial(battIds, battNet == null ? null : Math.abs(battNet)));
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
      // On energy the figure is the day's NET — import minus export, signed (#371). A magnitude would read
      // the same for a day that imported 5 kWh and one that exported 5 kWh.
      const gridShown = gridNet == null ? null : isEnergy ? gridNet : Math.abs(gridNet);
      grid.appendChild(tile('grid', '⚡', 'Grid', fmt(gridShown),
        isEnergy ? `${sub} · net for the day` : sub, cls,
        dial(gridIds, gridNet == null ? null : Math.abs(gridNet))));
    }

    // Home load (computed above with the flow arms).
    if (home != null || load_.present)
      grid.appendChild(tile('home', '🏠', 'Home', fmt(home), home == null ? whyNoReading('load') : (homeSub || 'consuming'), '',
        dial(loadIds, home)));

    // Self-sufficiency: the share of the home's energy (kWh) over the window above that was NOT drawn from
    // the grid. Only when the home energy and grid import both resolve and the house has actually used
    // energy; anything else would be dividing a guess.
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

  // The board is assembled from several reads (the graph, the in-direction live values, the energy graph),
  // so the push is used as a *trigger*: when the server says the flow moved, rebuild the board. That keeps
  // one source of truth for how the figures are derived while making the page react in ~2s instead of 8.
  // Both the push and the fallback timer are held while a past moment is on screen: a reload would fetch
  // the chosen instant again, but it would also overwrite a view the operator is reading with a fresh one
  // every couple of seconds.
  const syncLive = liveWhileActive(sec, () => 'flow:realpower' + (instSel.get() ? '|' + instSel.get() : ''),
    () => { if (!hist.day()) load(); });
  // Fallback for when the stream isn't up; it does nothing while it is.
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive() && !hist.day()) load(); }, 8000);
  link.onclick = () => { activate(link, sec); syncLive(); load(); };
}

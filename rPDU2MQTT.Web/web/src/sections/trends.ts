// Trends: usage over time, as bars per day.
import { api, btn, el, activate, formatNum, navLink, instanceSelector, withInstance } from '../helpers.js';
// The energy rules every view shares, so this page and the Energy Overview cannot answer differently.
import { homeEnergy, selfSufficiencyPct, sumKnown } from '../energy.js';
import { barChart, hideCard, colorFor, KIND_COLOR, type Line } from '../charts.js';
import { takeFocus } from '../state.js';

// The bar chart itself — axis, gaps, signs, hover — lives in charts.ts.

export function addTrendsSection(nav: any, sections: any) {
  const link = navLink(nav, 'Trends', '▦');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Trends' }));
  sec.appendChild(el('div', {
    class: 'desc',
    text: 'Daily energy over time, read from the history backend. A day the backend has no reading for is '
      + 'left empty rather than drawn as zero, and is left out of every total — nothing recorded is not the '
      + 'same as nothing used.',
  }));

  const bar = el('div', { class: 'ld-toolbar' });
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());

  // Two kinds of range, and they answer different questions with different metrics.
  const RANGES: [string, string, string][] = [
    // Not "the last 24 hours": today starts where the counters last re-based.
    ['today=1&step=300', 'today so far', 'power'],
    // The whole previous period, on the same boundary — not "the 24 hours before now".
    ['today=1&back=1&step=300', 'yesterday', 'power'],
    ['minutes=360&step=300', 'last 6 hours', 'power'],
    ['minutes=1440&step=900', 'last 24 hours', 'power'],
    ['days=7', 'last 7 days', 'energy'],
    ['days=14', 'last 14 days', 'energy'],
    ['days=30', 'last 30 days', 'energy'],
    ['days=90', 'last 90 days', 'energy'],
  ];
  const rangeSel = el('select', { title: 'How far back to chart. Within a day the charts show power; across days, the daily energy totals.' }) as HTMLSelectElement;
  RANGES.forEach(([v, t]) => rangeSel.appendChild(el('option', { value: v, text: t })));
  rangeSel.value = 'days=30';
  rangeSel.onchange = () => load();
  const intraDay = () => (RANGES.find(r => r[0] === rangeSel.value) || [])[2] === 'power';
  /// Where an intra-day window actually fell, in the reader's own clock. The day rolls over on the server's
  /// configured period zone, which is not necessarily the reader's — so it is said outright rather than
  /// inferred from the axis.
  const windowNote = (at: string[] | undefined) => {
    if (!intraDay() || !at?.length) return '';
    const from = new Date(at[0]), to = new Date(at[at.length - 1]);
    const clock = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return ` · ${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(from)} → ${clock(to)}`;
  };
  /// A window that is still filling. "Yesterday" is not one, and neither is any range that ended.
  const running = () => !rangeSel.value.includes('back=');
  /// How wide an intra-day chart may be. A day of five-minute samples is 288 bars: at the daily rule of
  /// 26px each that is a 7,488px chart in a ~1,600px pane, so the reader sees a fifth of their day, opened
  /// at the far end, with two axis labels on it. A day belongs on screen whole.
  const fitTo = () => intraDay() ? (charts.clientWidth || 1200) : undefined;

  const modeSel = el('select', { title: 'Stack the day’s nodes into one bar, or draw them side by side.' }) as HTMLSelectElement;
  [['stack', 'stacked'], ['group', 'side by side']].forEach(([v, t]) => modeSel.appendChild(el('option', { value: v, text: t })));
  modeSel.onchange = () => draw();

  const status = el('span', { class: 'ld-count' });
  bar.append(refresh, el('label', { class: 'ld-inst' }, 'Show ', rangeSel), el('label', { class: 'ld-inst' }, 'as ', modeSel), instSel.wrap, status);
  sec.appendChild(bar);

  const tagRow = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  sec.appendChild(tagRow);
  const picker = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  sec.appendChild(picker);

  const charts = el('div'); sec.appendChild(charts);
  const table = el('div'); sec.appendChild(table);

  let body: any = null;
  const off = new Set<string>();
  // Which column the table is ordered by.
  const sort = { col: 1, desc: true };

  const load = async () => {
    status.textContent = 'loading…';
    charts.innerHTML = ''; table.innerHTML = ''; picker.innerHTML = ''; tagRow.innerHTML = '';
    const path = withInstance('/api/flow/series?' + rangeSel.value, instSel);
    let r: any;
    try { r = await api(path); }
    catch (e: any) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    body = r.body;
    if (!body || !body.ok) {
      status.textContent = '';
      charts.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: (body && body.message) || 'Could not load the series.' }));
      return;
    }
    // Arrived from another page asking for something specific — "show me Solar for today".
    if (pending) {
      off.clear();
      const wanted = new Set(pending.nodes);
      (body.series || []).forEach((x: any) => { if (!wanted.has(x.node)) off.add(x.node); });
      // If none of what was asked for is in this window, say so rather than silently charting nothing.
      if (off.size === (body.series || []).length) {
        off.clear();
        resetSelection();
        status.textContent = `no history for ${pending.label || 'that node'} in this range`;
      }
      pending = null;
    }
    else if (!off.size) resetSelection();
    draw();
  };

  /// A request from another page, applied on the next load.
  let pending: { nodes: string[]; range: string | null; label: string | null } | null = null;

  /// Open this page focused on a set of nodes, over a range. Called when someone clicks a tile elsewhere.
  const openFocused = () => {
    const want = takeFocus();
    if (!want) return false;
    pending = want;
    if (want.range && RANGES.some(r => r[0] === want.range)) rangeSel.value = want.range;
    load();
    return true;
  };

  const shown = () => (body?.series || []).filter((s: any) => !off.has(s.node));

  /// The selection the page opens with: the leaves the Energy board treats as the whole picture.
  const resetSelection = () => {
    off.clear();
    const kinds = new Set((body?.series || []).map((s: any) => s.kind));
    const preferred = ['solar', 'battery', 'grid', 'load'].filter(k => kinds.has(k));
    if (preferred.length >= 2) (body?.series || []).forEach((s: any) => { if (!preferred.includes(s.kind)) off.add(s.node); });
  };

  const drawTags = () => {
    tagRow.innerHTML = '';
    const tags = new Set<string>();
    (body?.series || []).forEach((s: any) => (s.tags || []).forEach((t: string) => tags.add(t)));
    if (!tags.size) return;
    tagRow.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Tags:' }));
    [...tags].sort().forEach(tag => {
      const members = (body.series || []).filter((s: any) => (s.tags || []).includes(tag));
      const allOn = members.every((s: any) => !off.has(s.node));
      const chip = btn((allOn ? '● ' : '○ ') + tag);
      chip.title = `${members.length} node(s) tagged "${tag}" — click to chart exactly these`;
      chip.onclick = () => {
        // Selecting a tag charts that tag and nothing else.
        off.clear();
        (body.series || []).forEach((s: any) => { if (!(s.tags || []).includes(tag)) off.add(s.node); });
        draw();
      };
      tagRow.appendChild(chip);
    });
  };

  const drawPicker = () => {
    picker.innerHTML = '';
    picker.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Nodes:' }));
    (body?.series || []).forEach((s: any, i: number) => {
      const on = !off.has(s.node);
      const chip = btn((on ? '● ' : '○ ') + (s.label || s.node));
      chip.title = (on ? 'On the chart — click to take it off' : 'Off the chart — click to add it')
        + ((s.tags || []).length ? `\ntags: ${(s.tags || []).join(', ')}` : '');
      if (on) chip.style.borderColor = colorFor(s.kind, i);
      chip.onclick = () => { if (on) off.add(s.node); else off.delete(s.node); draw(); };
      picker.appendChild(chip);
    });
    const all = btn('All');
    all.title = 'Chart every node. A hierarchy counts the same energy at several tiers, so read a stack of all of them with that in mind.';
    all.onclick = () => { off.clear(); draw(); };
    const none = btn('None');
    none.title = 'Take every node off the by-node chart. The system charts below are unaffected.';
    none.onclick = () => { (body?.series || []).forEach((s: any) => off.add(s.node)); draw(); };
    const reset = btn('Reset', 'primary');
    reset.title = 'Back to the default selection: solar, battery, grid and the loads.';
    reset.onclick = () => { resetSelection(); draw(); };
    picker.append(all, none, reset);
  };

  /// The return lanes: battery charge, grid export. Negative, because that is the direction they are.
  const isReturn = (s: any) => String(s.node || '').endsWith('#in');
  const signed = (s: any): (number | null)[] =>
    isReturn(s) ? s.values.map((v: any) => (v == null ? null : -Math.abs(v))) : s.values;

  /// Sum one kind across the window, day by day. Null where no node of that kind reported that day —
  const byKind = (kind: string): (number | null)[] | null => {
    const members = (body.series || []).filter((s: any) => s.kind === kind);
    if (!members.length) return null;
    return (body.days || []).map((_: string, d: number) => sumKnown(members.map((s: any) => signed(s)[d])));
  };

  const section = (title: string, note: string, made: { svg: any; gaps: number }, legend: Line[]) => {
    const box = el('div', { style: { margin: '18px 0 4px' } });
    box.appendChild(el('h3', { text: title, style: { margin: '4px 0', fontSize: '15px' } }));
    if (note) box.appendChild(el('div', { class: 'desc', text: note }));
    const scroll = el('div', { style: { overflowX: 'auto', paddingBottom: '4px' } });
    scroll.appendChild(made.svg);
    box.appendChild(scroll);
    if (legend.length > 1 || legend.length === 1) {
      const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '10px' } });
      legend.forEach(l => row.appendChild(el('span', { class: 'desc', style: { margin: '0' } },
        el('span', { class: 'trend-swatch', style: { background: l.color } }), l.label)));
      box.appendChild(row);
    }
    charts.appendChild(box);
    // A chart wider than the page opens on its oldest bars, and for a window still filling the newest are
    // what the page is about — so start at the right-hand end (#378). A window that has already ended has no
    // "newest", and opening yesterday at 11pm hides the day. scrollWidth is only known once in the document.
    if (running()) scroll.scrollLeft = scroll.scrollWidth;
    return made.gaps;
  };

  const draw = () => {
    drawTags(); drawPicker();
    charts.innerHTML = ''; table.innerHTML = '';
    hideCard();
    if (!body?.ok) return;

    // A day carries the server's period key; a moment within one is named here, in the viewer's clock.
    const days: string[] = body.days
      || (body.at || []).map((iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const series = shown();
    const units = body.units || 'kWh';
    // The last period has not ended.
    const partial: string | null = body.partial || null;

    // --- Per node, as chosen ---------------------------------------------------------------------
    let gaps = 0;
    if (series.length) {
      const lines: Line[] = series.map((s: any, i: number) => ({
        label: s.label || s.node, color: colorFor(s.kind, i), values: signed(s),
      }));
      gaps = section(intraDay() ? 'Power by node' : 'Daily energy by node',
        'The nodes selected above.' + (partial ? ' The faded bar is today, still in progress — it counts in the totals below, so far.' : ''),
        barChart({ days, lines, units, stacked: modeSel.value === 'stack', partial, fitTo: fitTo() }), lines);
    } else {
      const box = el('div', { style: { margin: '18px 0 4px' } });
      box.appendChild(el('h3', { text: intraDay() ? 'Power by node' : 'Daily energy by node', style: { margin: '4px 0', fontSize: '15px' } }));
      box.appendChild(el('div', { class: 'desc', text: 'No nodes selected — pick one above, or press Reset. The charts below are about the whole system and are not affected by the selection.' }));
      charts.appendChild(box);
    }

    // --- Grid ------------------------------------------------------------------------------------
    const gridSupply = (body.series || []).filter((s: any) => s.kind === 'grid' && !isReturn(s));
    const gridReturn = (body.series || []).filter((s: any) => s.kind === 'grid' && isReturn(s));
    const sumOf = (list: any[]) => days.map((_, d) => sumKnown(list.map((s: any) => signed(s)[d])));
    const gridIn = byKind('grid');
    if (gridSupply.length) {
      const imports = sumOf(gridSupply), exports_ = gridReturn.length ? sumOf(gridReturn) : null;
      const gridLines: Line[] = [{ label: 'Import', color: KIND_COLOR.grid, values: imports }];
      if (exports_) gridLines.push({ label: 'Export', color: '#6fb0e0', values: exports_ });
      section(intraDay() ? 'Grid' : 'Grid per day',
        'Every grid node, whatever is selected above. Import above the line, export below it'
        + (exports_ ? '.' : ' — no export series is in history for this window, so only import is charted.'),
        barChart({ days, lines: gridLines, units, stacked: true, partial, fitTo: fitTo() }), gridLines);
    }

    // --- Self-sufficiency ---------------------------------------------------------------------------
    const solar = byKind('solar'), batt = byKind('battery'), load = byKind('load');
    // Self-sufficiency is a share of energy over a period.
    if (!intraDay() && gridIn && (load || solar)) {
      // A kind this system does not have is left out of the balance entirely.
      const drawn = sumOf(gridSupply);
      const pct = days.map((_, d) => selfSufficiencyPct(homeEnergy({
        ...(solar ? { solar: solar[d] } : {}),
        ...(batt ? { battery: batt[d] } : {}),
        ...(gridIn ? { grid: gridIn[d] } : {}),
        ...(load ? { load: load[d] } : {}),
      }), drawn[d]));
      if (pct.some(v => v != null)) {
        const ssLines: Line[] = [{ label: 'Self-sufficiency', color: KIND_COLOR.solar, values: pct }];
        section('Self-sufficiency per day',
          'Every node, whatever is selected above — a share of a subset would not be self-sufficiency. '
          + 'The share of the home’s energy that did not come from the grid'
          + (load ? '.' : ', with the home taken as the balance of the measured sources.')
          + ' A day missing either figure is left empty rather than estimated.',
          barChart({ days, lines: ssLines, units: '%', stacked: false, max: 100, pct: true, partial }), ssLines);
      }
    }

    // --- Where the day's energy came from -------------------------------------------------------
    const supplyLines: Line[] = [];
    ([['solar', 'Solar'], ['battery', 'Battery out'], ['grid', 'Grid import']] as [string, string][])
      .forEach(([k, label]) => {
        const v = sumOf((body.series || []).filter((s: any) => s.kind === k && !isReturn(s)));
        if (v.some(x => x != null)) supplyLines.push({ label, color: KIND_COLOR[k], values: v });
      });
    ([['battery', 'Battery in', '#2f8f52'], ['grid', 'Grid export', '#6fb0e0']] as [string, string, string][])
      .forEach(([k, label, colour]) => {
        const list = (body.series || []).filter((s: any) => s.kind === k && isReturn(s));
        if (!list.length) return;
        const v = sumOf(list);
        if (v.some(x => x != null)) supplyLines.push({ label, color: colour, values: v });
      });
    if (supplyLines.length > 1) {
      section(intraDay() ? 'Where the power is coming from' : 'Where the day’s energy came from',
        'Each kind summed across its nodes, whatever is selected above. What went back — battery charge, '
        + 'grid export — is below the line, so the same energy is not counted as produced and then again '
        + 'as returned.',
        barChart({ days, lines: supplyLines, units, stacked: true, partial, fitTo: fitTo() }), supplyLines);
    }

    // --- Totals ----------------------------------------------------------------------------------
    if (!series.length) {
      status.textContent = `${days.length} ${intraDay() ? 'sample(s)' : 'day(s)'} from ${body.source}`;
      return;
    }

    const step = Number(body.stepSeconds) || 0;
    const rows = series.map((s: any) => {
      // The day in progress counts. It is a real reading of a real day — an early one, said so in the note,
      // the fade and the hover — and leaving it out made the page disagree with the Energy board about today.
      const vals = s.values
        .map((v: any, d: number) => [v, days[d]] as [number | null, string])
        .filter(([v]: any) => v != null);
      const sum = vals.reduce((a: number, [v]: any) => a + v, 0);
      const best = vals.reduce((a: any, b: any) => (b[0] > (a?.[0] ?? -Infinity) ? b : a), null as any);
      // Energy from power samples: each sample stands for one step of time.
      const kwh = intraDay() && step > 0 ? (sum * step) / 3_600_000 : null;
      return {
        label: s.label || s.node,
        headline: intraDay() ? (best ? best[0] : null) : sum,
        kwh,
        mean: vals.length ? sum / vals.length : null,
        covered: vals.length,
        peakAt: best ? best[1] : '',
        peakValue: best ? best[0] : null,
      };
    });

    const denom = days.length;
    const cols: { head: string; num: boolean; text: (r: any) => string; sort: (r: any) => any; title?: string }[] = [
      { head: 'Node', num: false, text: r => r.label, sort: r => r.label.toLowerCase() },
      { head: intraDay() ? `Peak (${units})` : `Total (${units})`, num: true,
        text: r => r.headline == null ? '—' : formatNum(Number(r.headline.toFixed(2))),
        sort: r => r.headline ?? -Infinity,
        // Adding up power samples gives a number in watts that is a quantity of nothing.
        title: intraDay() ? 'The highest sample in the window. Power samples are not added up — that would give a number in watts that is a quantity of nothing.'
          : 'Summed over the days that reported' + (partial ? `, including ${partial} as far as it has got.` : '.') },
      ...(intraDay() ? [{ head: 'Energy (kWh, est.)', num: true,
        text: (r: any) => r.kwh == null ? '—' : formatNum(Number(r.kwh.toFixed(3))),
        sort: (r: any) => r.kwh ?? -Infinity,
        title: `Each sample held for its ${step}s step and added up. An estimate: it assumes the power between samples was the sampled value, and it covers only the samples that exist.` }] : []),
      { head: `Mean per ${intraDay() ? 'sample' : 'day'} (${units})`, num: true,
        text: r => r.mean == null ? '—' : formatNum(Number(r.mean.toFixed(2))), sort: r => r.mean ?? -Infinity,
        // An early day counts as a whole one here, so say so rather than let a low mean look like a quiet week.
        title: intraDay() || !partial ? undefined
          : `Over the days that reported. ${partial} is one of them and is only part-way through, so the mean reads low until it ends.` },
      { head: `${intraDay() ? 'Samples' : 'Days'} with data`, num: true,
        text: r => `${r.covered} of ${denom}`, sort: r => r.covered },
      { head: intraDay() ? 'Peak at' : 'Peak day', num: false,
        // The day in progress can hold the peak, and it is a peak that may still rise — say which it is.
        text: r => r.peakAt ? `${r.peakAt} · ${formatNum(r.peakValue)}${r.peakAt === partial ? ' · so far' : ''}` : '—',
        sort: r => r.peakAt },
    ];

    // Sorted by whichever column you clicked.
    if (sort.col >= cols.length) sort.col = 0;
    const key = cols[sort.col].sort;
    rows.sort((a: any, b: any) => {
      const x = key(a), y = key(b);
      const c = typeof x === 'string' ? String(x).localeCompare(String(y)) : (x < y ? -1 : x > y ? 1 : 0);
      return sort.desc ? -c : c;
    });

    const t = el('table', { class: 'ld' });
    const head = el('tr');
    cols.forEach((c, i) => {
      const th = el('th', { class: c.num ? 'num sortable' : 'sortable' });
      th.append(c.head + (sort.col === i ? (sort.desc ? ' ▾' : ' ▴') : ''));
      th.title = (c.title ? c.title + '\n' : '') + 'Click to sort by this column.';
      th.onclick = () => { if (sort.col === i) sort.desc = !sort.desc; else { sort.col = i; sort.desc = c.num; } draw(); };
      head.appendChild(th);
    });
    t.appendChild(el('thead', {}, head));
    const tb = el('tbody');
    rows.forEach((r: any) => {
      const tr = el('tr');
      cols.forEach(c => tr.appendChild(el('td', { class: c.num ? 'num' : '', text: c.text(r) })));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    table.appendChild(t);

    status.textContent = `${days.length} ${intraDay() ? 'sample(s)' : 'day(s)'} from ${body.source}`
      + windowNote(body.at)
      + (gaps ? ` · ${gaps} with no reading` : '')
      + (partial ? ` · ${partial} still in progress` : '');
    status.title = gaps
      ? 'Those days are drawn as empty slots and left out of the totals. The backend holds nothing for them.'
      : '';
  };

  refresh.onclick = () => load();
  link.onclick = () => { activate(link, sec); if (!openFocused() && !body) load(); };
  // Landing here from another page's click: the request is collected when this section becomes visible.
  window.addEventListener('rpdu:activate', () => { if (sec.classList.contains('active')) openFocused(); });
  return { link, sec };
}

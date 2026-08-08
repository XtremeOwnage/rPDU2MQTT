// Trends: usage over time, as bars per day.
//
// Every other view answers "what is happening now" or "what happened at this moment". Neither answers "is
// this getting worse", which is what a month of daily totals answers at a glance.
//
// Two rules the whole page is built around. A day the backend has no reading for is a GAP — an empty slot,
// counted, and left out of every total — because "nobody recorded it" and "nothing was used" are different
// facts and only the second is a claim. And a derived chart (self-sufficiency, grid import) is drawn only
// for the days whose inputs are all present: a percentage computed from a missing figure is a number
// nobody measured.
import { api, btn, el, activate, formatNum, navLink, instanceSelector, withInstance } from '../helpers.js';

// The kinds worth a colour of their own; anything else shares the neutral run. Matches the Sankey's
// vocabulary so a node is the same colour wherever it appears.
const KIND_COLOR: Record<string, string> = {
  solar: 'var(--warn, #d08700)',
  battery: 'var(--good, #46c46a)',
  grid: 'var(--accent, #4f8cff)',
  load: '#b06fd0',
  outlet: '#7f8ea3',
  pdu: '#5c7fa3',
  panel: '#c98b3f',
  inverter: '#3fb0a8',
};
const colorFor = (kind: string, i: number) =>
  KIND_COLOR[kind] || ['#4f8cff', '#46c46a', '#d08700', '#b06fd0', '#3fb0a8', '#c05c5c'][i % 6];

/// One drawable series: a name, a colour, and one value per day — null where there is no reading.
type Line = { label: string; color: string; values: (number | null)[] };

const SVG = 'http://www.w3.org/2000/svg';
const svgTag = (tag: string, attrs: Record<string, any>) => {
  const e = document.createElementNS(SVG, tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
  return e;
};

/// The hover card. One card for the page, moved and refilled — a card per chart would leak one per redraw.
let card: any = null;
function hoverCard(): any {
  if (!card) {
    card = el('div', { class: 'node-card trend-card' });
    document.body.appendChild(card);
  }
  return card;
}
function hideCard() { if (card) card.classList.remove('show'); }

/**
 * A day-by-day bar chart.
 *
 * `stacked` adds the day's series into one bar ("where did the day go"); otherwise they sit side by side
 * ("how do these compare"). A day where every series is null is drawn as an empty slot and reported, never
 * as a bar of zero.
 */
function barChart(opts: {
  days: string[]; lines: Line[]; units: string; stacked: boolean; max?: number; pct?: boolean;
}): { svg: any; gaps: number } {
  const { days, lines, units, stacked } = opts;
  const has = (d: number) => lines.some(l => l.values[d] != null);
  const dayTotal = (d: number) => lines.reduce((s, l) => s + (l.values[d] ?? 0), 0);
  const peak = opts.max ?? Math.max(
    stacked ? Math.max(...days.map((_, d) => (has(d) ? dayTotal(d) : 0)), 0)
      : Math.max(...lines.flatMap(l => l.values.map(v => v ?? 0)), 0),
    0);

  const W = Math.max(720, days.length * 26);
  const H = 240, padL = 56, padB = 40, padT = 12, padR = 8;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / days.length;
  const x = (d: number) => padL + slot * d;
  const barW = Math.max(3, slot * 0.72);
  const y = (v: number) => padT + plotH - (peak > 0 ? (v / peak) * plotH : 0);

  const svg = svgTag('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'trend-chart' });

  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (peak / ticks) * i, yy = y(v);
    svg.appendChild(svgTag('line', { x1: padL, y1: yy, x2: W - padR, y2: yy, stroke: 'var(--line)', 'stroke-width': 1 }));
    const t = svgTag('text', { x: padL - 6, y: yy + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 });
    t.textContent = formatNum(Number(v.toFixed(peak < 10 ? 2 : 0))) + (opts.pct ? '%' : '');
    svg.appendChild(t);
  }

  let gaps = 0;
  days.forEach((day, d) => {
    if (!has(d)) {
      gaps++;
      const g = svgTag('rect', { x: x(d) + (slot - barW) / 2, y: padT, width: barW, height: plotH, fill: 'var(--line)', opacity: 0.25 });
      const title = document.createElementNS(SVG, 'title');
      title.textContent = `${day} — no reading from the history backend`;
      g.appendChild(title);
      svg.appendChild(g);
    } else if (stacked) {
      let base = 0;
      lines.forEach(l => {
        const v = l.values[d];
        if (v == null || v <= 0) return;
        svg.appendChild(svgTag('rect', {
          x: x(d) + (slot - barW) / 2, y: y(base + v), width: barW,
          height: Math.max(1, (v / peak) * plotH), fill: l.color,
        }));
        base += v;
      });
    } else {
      const each = barW / lines.length;
      lines.forEach((l, i) => {
        const v = l.values[d];
        if (v == null || v <= 0) return;
        svg.appendChild(svgTag('rect', {
          x: x(d) + (slot - barW) / 2 + each * i, y: y(v), width: Math.max(1, each - 1),
          height: Math.max(1, (v / peak) * plotH), fill: l.color,
        }));
      });
    }

    const every = Math.ceil(days.length / 12);
    if (d % every === 0) {
      const t = svgTag('text', { x: x(d) + slot / 2, y: H - padB + 16, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11 });
      t.textContent = day.slice(5);
      svg.appendChild(t);
    }
  });

  svg.appendChild(svgTag('line', { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, stroke: 'var(--line)', 'stroke-width': 1 }));

  // A full-height hit area per day, over the bars. Hovering a thin bar is a game of skill, and a stacked
  // segment can be a pixel tall — the question is "what happened on this day", so the day is the target.
  days.forEach((day, d) => {
    const hit = svgTag('rect', {
      x: x(d), y: padT, width: slot, height: plotH, fill: 'transparent', class: 'trend-hit', 'data-day': day,
    });
    const show = (ev: any) => {
      const c = hoverCard();
      c.innerHTML = '';
      c.appendChild(el('div', { class: 'nh-title', text: day }));
      if (!has(d)) {
        c.appendChild(el('div', { class: 'nh-warn', text: 'no reading from the history backend' }));
      } else {
        lines.forEach(l => {
          const v = l.values[d];
          c.appendChild(el('div', { class: 'nh-row' },
            el('span', { class: 'nh-name' },
              el('span', { class: 'trend-swatch', style: { background: l.color } }),
              l.label),
            el('span', { class: 'nh-num', text: v == null ? '—' : `${formatNum(Number(v.toFixed(2)))}${opts.pct ? '%' : ' ' + units}` })));
        });
        if (stacked && lines.length > 1)
          c.appendChild(el('div', { class: 'nh-row nh-total' },
            el('span', { class: 'nh-name', text: 'Total' }),
            el('span', { class: 'nh-num', text: `${formatNum(Number(dayTotal(d).toFixed(2)))} ${units}` })));
      }
      c.classList.add('show');
      const px = (ev && ev.clientX) || 0, py = (ev && ev.clientY) || 0;
      c.style.left = Math.max(8, px + 14) + 'px';
      c.style.top = Math.max(8, py + 14) + 'px';
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('mousemove', show);
    hit.addEventListener('mouseleave', hideCard);
    svg.appendChild(hit);
  });

  return { svg, gaps };
}

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

  // Two kinds of range, and they answer different questions with different metrics. Within a day the
  // question is power — a daily energy counter charted through the day only ever climbs, which says
  // nothing about when the load was. Across days it is the daily total, the one figure that adds up.
  const RANGES: [string, string, string][] = [
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
    if (!off.size) resetSelection();
    draw();
  };

  const shown = () => (body?.series || []).filter((s: any) => !off.has(s.node));

  /// The selection the page opens with: the leaves the Energy board treats as the whole picture, so what
  /// is on screen first adds up instead of counting the same energy at three tiers.
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
        // Selecting a tag charts that tag and nothing else. Adding its nodes to whatever was already on
        // screen is how you end up stacking a panel on top of its own outlets without noticing.
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

  /// Sum one kind across the window, day by day. Null where no node of that kind reported that day —
  /// summing what happens to be present would quietly answer a different question each day.
  const byKind = (kind: string): (number | null)[] | null => {
    const members = (body.series || []).filter((s: any) => s.kind === kind);
    if (!members.length) return null;
    return (body.days || []).map((_: string, d: number) => {
      const vals = members.map((s: any) => s.values[d]).filter((v: any) => v != null);
      return vals.length ? vals.reduce((a: number, b: number) => a + b, 0) : null;
    });
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
    return made.gaps;
  };

  const draw = () => {
    drawTags(); drawPicker();
    charts.innerHTML = ''; table.innerHTML = '';
    hideCard();
    if (!body?.ok) return;

    const days: string[] = body.days || [];
    const series = shown();
    const units = body.units || 'kWh';

    // --- Per node, as chosen ---------------------------------------------------------------------
    // The only chart the node selection governs. Emptying it used to hide the whole page, which said the
    // selection drove everything below — while those charts went on summing every node regardless.
    let gaps = 0;
    if (series.length) {
      const lines: Line[] = series.map((s: any, i: number) => ({
        label: s.label || s.node, color: colorFor(s.kind, i), values: s.values,
      }));
      gaps = section(intraDay() ? 'Power by node' : 'Daily energy by node', 'The nodes selected above.',
        barChart({ days, lines, units, stacked: modeSel.value === 'stack' }), lines);
    } else {
      const box = el('div', { style: { margin: '18px 0 4px' } });
      box.appendChild(el('h3', { text: intraDay() ? 'Power by node' : 'Daily energy by node', style: { margin: '4px 0', fontSize: '15px' } }));
      box.appendChild(el('div', { class: 'desc', text: 'No nodes selected — pick one above, or press Reset. The charts below are about the whole system and are not affected by the selection.' }));
      charts.appendChild(box);
    }

    // --- Grid ------------------------------------------------------------------------------------
    // What the backend holds for the grid is the import direction. The export lane is a synthetic node and
    // the exporter does not publish those, so a "net" figure here would be import with a name that claims
    // export was subtracted. Say what it is instead.
    const gridIn = byKind('grid');
    if (gridIn) {
      const gridLines: Line[] = [{ label: 'Grid import', color: KIND_COLOR.grid, values: gridIn }];
      section(intraDay() ? 'Grid power' : 'Grid import per day',
        'Every grid node, whatever is selected above. Drawn from the grid — export is not charted: '
        + 'the return lane is a derived node and the exporter does not publish those, so there is nothing '
        + 'in history to subtract.',
        barChart({ days, lines: gridLines, units, stacked: false }), gridLines);
    }

    // --- Self-sufficiency ---------------------------------------------------------------------------
    // The share of the home's energy that did not come from the grid, per day. Drawn only for days where
    // both figures are present: a percentage computed from a missing number is not a measurement.
    const solar = byKind('solar'), batt = byKind('battery'), load = byKind('load');
    // Self-sufficiency is a share of energy over a period. The same arithmetic on instantaneous power is a
    // different quantity — the share of this second's supply — and putting it under the same name would
    // invite reading a momentary grid draw as a bad day.
    if (!intraDay() && gridIn && (load || solar)) {
      // Only the kinds that exist here. A system with no battery has no battery series, which is not the
      // same as a battery that failed to report — treating the two alike blanked the whole chart.
      const present = [solar, batt, gridIn].filter((k): k is (number | null)[] => !!k);
      const home = days.map((_, d) => {
        if (load) return load[d];
        const parts = present.map(k => k[d]);
        return parts.some(p => p == null) ? null : parts.reduce((a: any, b: any) => a + b, 0);
      });
      const pct = days.map((_, d) => {
        const h = home[d], g = gridIn[d];
        if (h == null || g == null || h <= 0) return null;
        return Math.max(0, Math.min(100, ((h - Math.max(0, g)) / h) * 100));
      });
      if (pct.some(v => v != null)) {
        const ssLines: Line[] = [{ label: 'Self-sufficiency', color: KIND_COLOR.solar, values: pct }];
        section('Self-sufficiency per day',
          'Every node, whatever is selected above — a share of a subset would not be self-sufficiency. '
          + 'The share of the home’s energy that did not come from the grid'
          + (load ? '.' : ', with the home taken as the balance of the measured sources.')
          + ' A day missing either figure is left empty rather than estimated.',
          barChart({ days, lines: ssLines, units: '%', stacked: false, max: 100, pct: true }), ssLines);
      }
    }

    // --- Where the day's energy came from -------------------------------------------------------
    const kinds: [string, string][] = [['solar', 'Solar'], ['battery', 'Battery'], ['grid', 'Grid']];
    const supply = kinds.map(([k, label]) => ({ k, label, values: byKind(k) }))
      .filter(x => x.values) as { k: string; label: string; values: (number | null)[] }[];
    if (supply.length > 1) {
      const supplyLines: Line[] = supply.map(s => ({ label: s.label, color: KIND_COLOR[s.k], values: s.values }));
      section(intraDay() ? 'Where the power is coming from' : 'Where the day’s energy came from',
        'Each source summed across every node of that kind, whatever is selected above.',
        barChart({ days, lines: supplyLines, units, stacked: true }), supplyLines);
    }

    // --- Totals ----------------------------------------------------------------------------------
    if (!series.length) {
      status.textContent = `${days.length} ${intraDay() ? 'sample(s)' : 'day(s)'} from ${body.source}`;
      return;
    }

    const t = el('table', { class: 'ld' });
    const head = el('tr');
    const per = intraDay() ? 'sample' : 'day';
    [intraDay() ? 'Node' : 'Node', intraDay() ? `Peak (${units})` : `Total (${units})`,
     `Mean per ${per} (${units})`, `${intraDay() ? 'Samples' : 'Days'} with data`,
     intraDay() ? 'Peak at' : 'Peak day'].forEach((h, i) =>
      head.appendChild(el('th', { class: i > 0 && i < 4 ? 'num' : '', text: h })));
    t.appendChild(el('thead', {}, head));
    const tb = el('tbody');
    series.forEach((s: any) => {
      const vals = s.values.map((v: any, d: number) => [v, days[d]] as [number | null, string]).filter(([v]: any) => v != null);
      const total = vals.reduce((a: number, [v]: any) => a + v, 0);
      const best = vals.reduce((a: any, b: any) => (b[0] > (a?.[0] ?? -Infinity) ? b : a), null as any);
      const tr = el('tr');
      tr.appendChild(el('td', { text: s.label || s.node }));
      // Adding up power samples would produce a number in watts that is not a quantity of anything.
      tr.appendChild(el('td', { class: 'num', text: intraDay()
        ? (best ? formatNum(Number(best[0].toFixed(2))) : '—')
        : formatNum(Number(total.toFixed(2))) }));
      tr.appendChild(el('td', { class: 'num', text: vals.length ? formatNum(Number((total / vals.length).toFixed(2))) : '—' }));
      tr.appendChild(el('td', { class: 'num', text: `${vals.length} of ${days.length}` }));
      tr.appendChild(el('td', { text: best ? `${best[1]} · ${formatNum(best[0])}` : '—' }));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    table.appendChild(t);

    status.textContent = `${days.length} ${intraDay() ? 'sample(s)' : 'day(s)'} from ${body.source}`
      + (gaps ? ` · ${gaps} with no reading` : '');
    status.title = gaps
      ? 'Those days are drawn as empty slots and left out of the totals. The backend holds nothing for them.'
      : '';
  };

  refresh.onclick = () => load();
  link.onclick = () => { activate(link, sec); if (!body) load(); };
  return { link, sec };
}

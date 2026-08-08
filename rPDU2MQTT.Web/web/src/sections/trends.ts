// Trends: usage over time, as bars per day.
//
// Every other view answers "what is happening now" or "what happened at this moment". Neither answers
// "is this getting worse", which is the question a month of daily totals answers at a glance and no
// single-instant view ever can.
//
// Two rules the chart is built around. A day the backend has no reading for is a GAP, drawn as an empty
// slot and counted in the footer — never a zero-height bar, because "nobody recorded it" and "nothing was
// used that day" are different facts and the second one is a claim. And the totals under the chart cover
// only the days that actually reported, with the count beside them, so a short month cannot read as a
// cheap one.
import { api, btn, el, activate, formatNum, navLink, instanceSelector, withInstance, toast } from '../helpers.js';
import { state } from '../state.js';

// The kinds worth a colour of their own; anything else shares the neutral one. Matches the Sankey's
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

export function addTrendsSection(nav: any, sections: any) {
  const link = navLink(nav, 'Trends', '▦');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Trends' }));
  sec.appendChild(el('div', {
    class: 'desc',
    text: 'Daily energy over time, read from the history backend. One bar per day per node; a day the '
      + 'backend has no reading for is left empty rather than drawn as zero, because nothing recorded is '
      + 'not the same as nothing used.',
  }));

  const bar = el('div', { class: 'ld-toolbar' });
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());

  const rangeSel = el('select', { title: 'How far back to chart.' }) as HTMLSelectElement;
  [['7', 'last 7 days'], ['14', 'last 14 days'], ['30', 'last 30 days'], ['90', 'last 90 days']]
    .forEach(([v, t]) => rangeSel.appendChild(el('option', { value: v, text: t })));
  rangeSel.value = '30';
  rangeSel.onchange = () => load();

  // Stacked reads as "where did the day's energy go"; side by side compares nodes against each other.
  const modeSel = el('select', { title: 'Stack the day’s nodes into one bar, or draw them side by side.' }) as HTMLSelectElement;
  [['stack', 'stacked'], ['group', 'side by side']].forEach(([v, t]) => modeSel.appendChild(el('option', { value: v, text: t })));
  modeSel.onchange = () => draw();

  const status = el('span', { class: 'ld-count' });
  bar.append(refresh, el('label', { class: 'ld-inst' }, 'Show ', rangeSel), el('label', { class: 'ld-inst' }, 'as ', modeSel), instSel.wrap, status);
  sec.appendChild(bar);

  // Which nodes are on the chart. Everything the backend answered for, minus what you switch off — a
  // hierarchy double-counts by design (a panel and its outlets are the same watts twice), so charting all
  // of it at once and stacking would draw a total that is true of nothing.
  const picker = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  sec.appendChild(picker);

  const chart = el('div'); sec.appendChild(chart);
  const table = el('div'); sec.appendChild(table);

  let body: any = null;
  const off = new Set<string>();

  const load = async () => {
    status.textContent = 'loading…';
    chart.innerHTML = ''; table.innerHTML = ''; picker.innerHTML = '';
    let path = withInstance('/api/flow/series?days=' + encodeURIComponent(rangeSel.value), instSel);
    let r: any;
    try { r = await api(path); }
    catch (e: any) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    body = r.body;
    if (!body || !body.ok) {
      status.textContent = '';
      chart.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' },
        text: (body && body.message) || 'Could not load the series.' }));
      return;
    }
    // Default to the leaves of the hierarchy the Energy board already treats as the whole picture, so the
    // first thing on screen adds up rather than counting the same energy at three tiers.
    if (!off.size) {
      const kinds = new Set(body.series.map((s: any) => s.kind));
      const preferred = ['solar', 'battery', 'grid', 'load'].filter(k => kinds.has(k));
      if (preferred.length >= 2) body.series.forEach((s: any) => { if (!preferred.includes(s.kind)) off.add(s.node); });
    }
    draw();
  };

  const shown = () => (body?.series || []).filter((s: any) => !off.has(s.node));

  const drawPicker = () => {
    picker.innerHTML = '';
    picker.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Nodes:' }));
    (body?.series || []).forEach((s: any, i: number) => {
      const on = !off.has(s.node);
      const chip = btn((on ? '● ' : '○ ') + (s.label || s.node));
      chip.title = on ? 'On the chart — click to take it off' : 'Off the chart — click to add it';
      if (on) chip.style.borderColor = colorFor(s.kind, i);
      chip.onclick = () => { if (on) off.add(s.node); else off.delete(s.node); draw(); };
      picker.appendChild(chip);
    });
    const all = btn('All');
    all.onclick = () => { off.clear(); draw(); };
    picker.appendChild(all);
  };

  const draw = () => {
    drawPicker();
    chart.innerHTML = ''; table.innerHTML = '';
    if (!body?.ok) return;

    const days: string[] = body.days || [];
    const series = shown();
    const units = body.units || 'kWh';
    if (!series.length) {
      chart.appendChild(el('div', { class: 'desc', text: 'No nodes selected — pick one above.' }));
      status.textContent = '';
      return;
    }

    const stacked = modeSel.value === 'stack';
    // A day is missing only when NOTHING reported it. A node that has no value on a day it did report is
    // that node's gap, not the day's.
    const dayTotal = (d: number) => series.reduce((sum: number, s: any) => sum + (s.values[d] ?? 0), 0);
    const dayHasAny = (d: number) => series.some((s: any) => s.values[d] != null);
    const peak = stacked
      ? Math.max(...days.map((_, d) => (dayHasAny(d) ? dayTotal(d) : 0)), 0)
      : Math.max(...series.flatMap((s: any) => s.values.map((v: any) => v ?? 0)), 0);

    const W = Math.max(720, days.length * 26);
    const H = 260, padL = 56, padB = 42, padT = 12, padR = 8;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const x = (d: number) => padL + (plotW / days.length) * d;
    const slot = plotW / days.length;
    const barW = Math.max(3, slot * 0.72);
    const y = (v: number) => padT + plotH - (peak > 0 ? (v / peak) * plotH : 0);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('class', 'trend-chart');

    const svgEl2 = (tag: string, attrs: Record<string, any>) => {
      const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
      return e;
    };

    // A scale, or the bars are decoration.
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (peak / ticks) * i;
      const yy = y(v);
      svg.appendChild(svgEl2('line', { x1: padL, y1: yy, x2: W - padR, y2: yy, stroke: 'var(--line)', 'stroke-width': 1 }));
      const t = svgEl2('text', { x: padL - 6, y: yy + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 });
      t.textContent = formatNum(Number(v.toFixed(peak < 10 ? 2 : 0)));
      svg.appendChild(t);
    }

    let gaps = 0;
    days.forEach((day, d) => {
      if (!dayHasAny(d)) {
        gaps++;
        // An empty slot, marked. Nothing recorded that day is a fact about the record, not about the day.
        const g = svgEl2('rect', {
          x: x(d) + (slot - barW) / 2, y: padT, width: barW, height: plotH,
          fill: 'var(--line)', opacity: 0.25,
        });
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = `${day} — no reading from the history backend`;
        g.appendChild(title);
        svg.appendChild(g);
        return;
      }

      if (stacked) {
        let base = 0;
        series.forEach((s: any, i: number) => {
          const v = s.values[d];
          if (v == null || v <= 0) return;
          const h = (v / peak) * plotH;
          const rect = svgEl2('rect', {
            x: x(d) + (slot - barW) / 2, y: y(base + v), width: barW, height: Math.max(1, h),
            fill: colorFor(s.kind, i),
          });
          const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          title.textContent = `${day} · ${s.label || s.node}: ${formatNum(v)} ${units}`;
          rect.appendChild(title);
          svg.appendChild(rect);
          base += v;
        });
      } else {
        const each = barW / series.length;
        series.forEach((s: any, i: number) => {
          const v = s.values[d];
          if (v == null || v <= 0) return;
          const rect = svgEl2('rect', {
            x: x(d) + (slot - barW) / 2 + each * i, y: y(v), width: Math.max(1, each - 1),
            height: Math.max(1, (v / peak) * plotH), fill: colorFor(s.kind, i),
          });
          const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          title.textContent = `${day} · ${s.label || s.node}: ${formatNum(v)} ${units}`;
          rect.appendChild(title);
          svg.appendChild(rect);
        });
      }

      // Every few days, so the axis stays readable at 90.
      const every = Math.ceil(days.length / 12);
      if (d % every === 0) {
        const t = svgEl2('text', {
          x: x(d) + slot / 2, y: H - padB + 16, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11,
        });
        t.textContent = day.slice(5);
        svg.appendChild(t);
      }
    });

    const axis = svgEl2('line', { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, stroke: 'var(--line)', 'stroke-width': 1 });
    svg.appendChild(axis);

    const scroll = el('div', { style: { overflowX: 'auto', paddingBottom: '4px' } });
    scroll.appendChild(svg);
    chart.appendChild(scroll);

    // Legend, in the chart's own colours.
    const legend = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '10px' } });
    series.forEach((s: any, i: number) => legend.appendChild(el('span', { class: 'desc', style: { margin: '0' } },
      el('span', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: colorFor(s.kind, i), marginRight: '4px' } }),
      s.label || s.node)));
    chart.appendChild(legend);

    // Totals, over the days that reported. The count is part of the figure: a total over 22 of 30 days is
    // not a month, and presenting it as one is how a gap turns into a saving.
    const t = el('table', { class: 'ld' });
    const head = el('tr');
    ['Node', `Total (${units})`, `Mean per day (${units})`, 'Days with data', 'Peak day'].forEach((h, i) =>
      head.appendChild(el('th', { class: i > 0 && i < 4 ? 'num' : '', text: h })));
    t.appendChild(el('thead', {}, head));
    const tb = el('tbody');
    series.forEach((s: any) => {
      const vals = s.values.map((v: any, d: number) => [v, days[d]] as [number | null, string]).filter(([v]: any) => v != null);
      const total = vals.reduce((a: number, [v]: any) => a + v, 0);
      const best = vals.reduce((a: any, b: any) => (b[0] > (a?.[0] ?? -Infinity) ? b : a), null as any);
      const tr = el('tr');
      tr.appendChild(el('td', { text: s.label || s.node }));
      tr.appendChild(el('td', { class: 'num', text: formatNum(Number(total.toFixed(2))) }));
      tr.appendChild(el('td', { class: 'num', text: vals.length ? formatNum(Number((total / vals.length).toFixed(2))) : '—' }));
      tr.appendChild(el('td', { class: 'num', text: `${vals.length} of ${days.length}` }));
      tr.appendChild(el('td', { text: best ? `${best[1]} · ${formatNum(best[0])}` : '—' }));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    table.appendChild(t);

    status.textContent = `${days.length} day(s) from ${body.source}`
      + (gaps ? ` · ${gaps} with no reading` : '');
    status.title = gaps
      ? 'Those days are drawn as empty slots and left out of the totals. The backend holds nothing for them.'
      : '';
  };

  refresh.onclick = () => load();
  link.onclick = () => { activate(link, sec); if (!body) load(); };
  return { link, sec };
}

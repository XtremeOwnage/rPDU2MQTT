// Node Trends: each selected node's own series over the chosen window, with its totals.
import { btn, el, formatNum } from '../helpers.js';
import { barChart, colorFor, type Line } from '../charts.js';
import { takeFocus } from '../state.js';
import { trendsPage, signed, type TrendsPage } from './trends-shared.js';

export function addNodeTrendsSection(nav: any, sections: any) {
  const off = new Set<string>();
  const sort = { col: 1, desc: true };
  let filter = '';
  let overlayId = '';
  let pending: { nodes: string[]; range: string | null; label: string | null } | null = null;
  let page: TrendsPage;

  const tagRow = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  const search = el('input', { class: 'trend-search' }) as HTMLInputElement;
  search.type = 'search';
  search.placeholder = 'Filter nodes';
  search.title = 'Show only the nodes whose name, id or tags contain this text.';
  const searchRow = el('div', { class: 'ld-toolbar' }, search);
  const picker = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  const table = el('div');
  const overlaySel = el('select', { title: 'Draw one more series as a line over the chart, on the same axis.' }) as HTMLSelectElement;

  const all = (): any[] => page.body()?.series || [];
  const shown = () => all().filter((s: any) => !off.has(s.node));
  const matches = (s: any) => !filter
    || [s.label, s.node, ...(s.tags || [])].some(t => String(t || '').toLowerCase().includes(filter));

  // The selection the page opens with: the leaves the Energy board treats as the whole picture.
  const resetSelection = () => {
    off.clear();
    const kinds = new Set(all().map((s: any) => s.kind));
    const preferred = ['solar', 'battery', 'grid', 'load'].filter(k => kinds.has(k));
    if (preferred.length >= 2) all().forEach((s: any) => { if (!preferred.includes(s.kind)) off.add(s.node); });
  };

  const drawTags = () => {
    tagRow.innerHTML = '';
    const tags = new Set<string>();
    all().forEach((s: any) => (s.tags || []).forEach((t: string) => tags.add(t)));
    if (!tags.size) return;
    tagRow.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Tags:' }));
    [...tags].sort().forEach(tag => {
      const members = all().filter((s: any) => (s.tags || []).includes(tag));
      const allOn = members.every((s: any) => !off.has(s.node));
      const chip = btn((allOn ? '● ' : '○ ') + tag);
      chip.title = `${members.length} node(s) tagged "${tag}" — click to chart exactly these`;
      chip.onclick = () => {
        off.clear();
        all().forEach((s: any) => { if (!(s.tags || []).includes(tag)) off.add(s.node); });
        page.draw();
      };
      tagRow.appendChild(chip);
    });
  };

  const drawPicker = () => {
    picker.innerHTML = '';
    picker.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Nodes:' }));
    const visible = all().filter(matches);
    all().forEach((s: any, i: number) => {
      if (!matches(s)) return;
      const on = !off.has(s.node);
      const chip = btn((on ? '● ' : '○ ') + (s.label || s.node));
      chip.title = (on ? 'On the chart — click to take it off' : 'Off the chart — click to add it')
        + ((s.tags || []).length ? `\ntags: ${(s.tags || []).join(', ')}` : '');
      if (on) chip.style.borderColor = colorFor(s.kind, i);
      chip.onclick = () => { if (on) off.add(s.node); else off.delete(s.node); page.draw(); };
      picker.appendChild(chip);
    });
    if (filter && !visible.length) picker.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: `no node matches "${filter}"` }));
    const allBtn = btn('All');
    allBtn.title = filter ? 'Chart every node matching the filter.' : 'Chart every node. A hierarchy counts the same energy at several tiers, so read a stack of all of them with that in mind.';
    allBtn.onclick = () => { visible.forEach((s: any) => off.delete(s.node)); page.draw(); };
    const none = btn('None');
    none.title = filter ? 'Take every node matching the filter off the chart.' : 'Take every node off the chart.';
    none.onclick = () => { visible.forEach((s: any) => off.add(s.node)); page.draw(); };
    const reset = btn('Reset', 'primary');
    reset.title = 'Back to the default selection: solar, battery, grid and the loads.';
    reset.onclick = () => { resetSelection(); page.draw(); };
    picker.append(allBtn, none, reset);
  };
  search.oninput = () => { filter = search.value.trim().toLowerCase(); drawPicker(); };

  const fillOverlay = () => {
    overlaySel.innerHTML = '';
    overlaySel.appendChild(el('option', { value: '', text: 'nothing' }));
    all().forEach((s: any) => overlaySel.appendChild(el('option', { value: s.node, text: s.label || s.node })));
    if (!all().some((s: any) => s.node === overlayId)) overlayId = '';
    overlaySel.value = overlayId;
  };
  overlaySel.onchange = () => { overlayId = overlaySel.value; page.draw(); };

  const byNodeTitle = (p: TrendsPage) => p.perDay()
    ? `Daily ${p.metricName()} by node`
    : `${p.metricName().charAt(0).toUpperCase()}${p.metricName().slice(1)} by node`;

  const drawTable = (p: TrendsPage, series: any[], days: string[], units: string, partial: string | null) => {
    const step = Number(p.body().stepSeconds) || 0;
    const rows = series.map((s: any) => {
      const vals = s.values
        .map((v: any, d: number) => [v, days[d]] as [number | null, string])
        .filter(([v]: any) => v != null);
      const sum = vals.reduce((a: number, [v]: any) => a + v, 0);
      const best = vals.reduce((a: any, b: any) => (b[0] > (a?.[0] ?? -Infinity) ? b : a), null as any);
      // Energy from power samples: each sample stands for one step of time.
      const kwh = p.rate() && units === 'W' && step > 0 ? (sum * step) / 3_600_000 : null;
      return {
        label: s.label || s.node,
        headline: p.summable() ? sum : (best ? best[0] : null),
        kwh,
        mean: vals.length ? sum / vals.length : null,
        covered: vals.length,
        peakAt: best ? best[1] : '',
        peakValue: best ? best[0] : null,
      };
    });

    const perDay = p.perDay();
    const cols: { head: string; num: boolean; text: (r: any) => string; sort: (r: any) => any; title?: string }[] = [
      { head: 'Node', num: false, text: r => r.label, sort: r => r.label.toLowerCase() },
      { head: p.summable() ? `Total (${units})` : `Peak (${units})`, num: true,
        text: r => r.headline == null ? '—' : formatNum(Number(r.headline.toFixed(2))),
        sort: r => r.headline ?? -Infinity,
        title: !p.summable() ? 'The highest reading in the window. These are not added up: a sum of them would be a quantity of nothing.'
          : 'Summed over the days that reported' + (partial ? `, including ${partial} as far as it has got.` : '.') },
      ...(p.rate() && units === 'W' ? [{ head: 'Energy (kWh, est.)', num: true,
        text: (r: any) => r.kwh == null ? '—' : formatNum(Number(r.kwh.toFixed(3))),
        sort: (r: any) => r.kwh ?? -Infinity,
        title: `Each sample held for its ${step}s step and added up. An estimate covering only the samples that exist.` }] : []),
      { head: `Mean per ${perDay ? 'day' : 'sample'} (${units})`, num: true,
        text: r => r.mean == null ? '—' : formatNum(Number(r.mean.toFixed(2))), sort: r => r.mean ?? -Infinity,
        title: !perDay || !partial ? undefined
          : `Over the days that reported. ${partial} is one of them and is only part-way through, so the mean reads low until it ends.` },
      { head: `${perDay ? 'Days' : 'Samples'} with data`, num: true,
        text: r => `${r.covered} of ${days.length}`, sort: r => r.covered },
      { head: perDay ? 'Peak day' : 'Peak at', num: false,
        text: r => r.peakAt ? `${r.peakAt} · ${formatNum(r.peakValue)}${r.peakAt === partial ? ' · so far' : ''}` : '—',
        sort: r => r.peakAt },
    ];

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
      th.onclick = () => { if (sort.col === i) sort.desc = !sort.desc; else { sort.col = i; sort.desc = c.num; } p.draw(); };
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
  };

  const created = trendsPage(nav, sections, {
    label: 'Node Trends',
    icon: '▥',
    stackable: true,
    controls: () => [el('label', { class: 'ld-inst' }, 'overlay ', overlaySel)],
    above: () => [tagRow, searchRow, picker],
    below: () => [table],
    loaded: () => {
      if (pending) {
        off.clear();
        const wanted = new Set(pending.nodes);
        all().forEach((s: any) => { if (!wanted.has(s.node)) off.add(s.node); });
        // None of what was asked for is in this window: fall back rather than chart nothing.
        if (off.size === all().length) resetSelection();
        pending = null;
      } else if (!off.size) resetSelection();
      fillOverlay();
    },
    activated: (p) => {
      const want = takeFocus();
      if (!want) return false;
      pending = want;
      if (want.range) p.showRange(want.range);
      p.load();
      return true;
    },
    render: (p) => {
      drawTags(); drawPicker(); table.innerHTML = '';
      const body = p.body();
      if (!body?.ok) return;

      const days = p.days();
      const series = shown();
      const units = body.units || 'kWh';
      const partial: string | null = body.partial || null;
      const over = overlayId ? all().find((s: any) => s.node === overlayId) : null;
      const overlay: Line | undefined = over
        ? { label: over.label || over.node, color: 'var(--accent)', values: signed(over) } : undefined;

      if (!series.length) {
        const box = el('div', { style: { margin: '18px 0 4px' } });
        box.appendChild(el('h3', { text: byNodeTitle(p), style: { margin: '4px 0', fontSize: '15px' } }));
        box.appendChild(el('div', { class: 'desc', text: 'No nodes selected — pick one above, or press Reset. The whole-system charts are on the Trends page.' }));
        p.charts.appendChild(box);
        p.status.textContent = p.statusLine(0);
        return;
      }

      const lines: Line[] = series.map((s: any, i: number) => ({ label: s.label || s.node, color: colorFor(s.kind, i), values: signed(s) }));
      const legend = overlay ? [...lines, { ...overlay, label: `${overlay.label} (overlay)` }] : lines;
      const gaps = p.section(byNodeTitle(p),
        'The nodes selected above.' + (partial ? ' The faded bar is today, still in progress — it counts in the totals below, so far.' : ''),
        barChart({ days, lines, units, stacked: p.stacked(), kind: p.kind(), partial, fitTo: p.fitTo(), height: p.leadHeight(), overlay }), legend);

      drawTable(p, series, days, units, partial);
      p.status.textContent = p.statusLine(gaps);
      p.status.title = gaps ? 'Those are drawn as empty slots and left out of the totals. The backend holds nothing for them.' : '';
    },
  });
  page = created.page;
  return { link: created.link, sec: created.sec };
}

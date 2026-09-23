// What a node has been drawing, in a sheet: the panel schedule opens it for a breaker, the flow diagram for
// whatever was right-clicked. One line, summed from the nodes asked for — a moment where any of them has no
// reading is a gap in the line, never a partial sum.
import { api, btn, closeSheet, el, openSheet } from './helpers.js';
import { sparkline } from './charts.js';
import { editNodeOnNextOpen } from './sections/nodes.js';

/// Windows worth asking about, and how finely each is sampled.
export const HISTORY_WINDOWS: [string, string][] = [
  ['minutes=60&step=30', 'Last hour'],
  ['minutes=360&step=60', 'Last 6 hours'],
  ['minutes=1440&step=900', 'Last 24 hours'],
  ['days=7&step=3600', 'Last 7 days'],
  ['days=30&step=21600', 'Last 30 days'],
];
/// The window a sheet opens on when nobody has picked one yet.
const HISTORY_DEFAULT = 'minutes=1440&step=900';
/// The measurements a reading can be asked for in, and what each is called.
export const HISTORY_METRICS: [string, string][] = [
  ['realpower', 'Power (W)'],
  ['current', 'Current (A)'],
  ['apparentpower', 'Apparent (VA)'],
  ['energy_d', 'Energy today (kWh)'],
];
/// The last window picked, kept per browser: the same question tends to be asked over the same span.
const WINDOW_KEY = 'rpdu2mqtt.history.window';
const rememberedWindow = () => {
  try { const v = localStorage.getItem(WINDOW_KEY); return HISTORY_WINDOWS.some(([q]) => q === v) ? v! : HISTORY_DEFAULT; }
  catch { return HISTORY_DEFAULT; }
};

export type HistoryRequest = {
  title: string;
  /// The nodes the line is summed from. Empty means there is nothing to chart, and `empty` says why.
  nodes: string[];
  lineLabel: string;
  labelOf?: (id: string) => string;
  metric?: string;
  empty?: string;
  /// Buttons of the caller's own, beside the one that opens the node editor.
  footer?: any[];
  editNode?: boolean;
  /// What the line is made of — a panel's circuits, a double-pole's legs — each drawn on a strip of its own
  /// from the same reading, so where a total went can be read off without asking again.
  parts?: string[];
  partsLabel?: string;
};

/// Open the history of one or more nodes, over a window picked in the sheet.
export function openHistorySheet(o: HistoryRequest) {
  const nodes = o.nodes.filter(Boolean);
  const labelOf = o.labelOf || ((id: string) => id);
  const metric = o.metric || 'realpower';
  const plot = el('div', { class: 'ps-chart' });
  const legend = el('div', { class: 'ld-toolbar ps-legend', style: { flexWrap: 'wrap', gap: '10px' } });
  const note = el('div', { class: 'desc' });
  const breakdown = el('div', { class: 'hs-parts' });
  // A part that is the whole is not a breakdown; two legs summed into one line are.
  const parts = (o.parts || []).filter(id => id && !(nodes.length === 1 && nodes[0] === id));
  let window = rememberedWindow();
  let metricNow = metric;

  const load = async () => {
    if (!nodes.length) {
      plot.innerHTML = '';
      note.textContent = o.empty || 'Nothing is measuring this, so there is nothing to chart.';
      return;
    }
    plot.innerHTML = '';
    note.textContent = 'Reading…';
    let r: any;
    try { r = await api(`/api/flow/series?${window}&metric=${metricNow}`); }
    catch (e: any) { r = { body: { ok: false, message: e?.message || 'the request failed' } }; }
    const body = r?.body;
    if (!body?.ok) { note.textContent = body?.message || 'Could not read the history.'; return; }
    const all = body.series || [];
    const series = all.filter((s: any) => nodes.includes(s.node));
    if (!series.length) { note.textContent = `The history backend holds nothing for ${nodes.join(', ')} in this window.`; return; }
    // A node with no reading at some moment leaves the total unknown then, exactly as its power is.
    const at: string[] = body.at || [];
    const values = at.map((_, i) => {
      let total = 0;
      for (const s of series) { const v = s.values?.[i]; if (v == null) return null; total += v; }
      return total as number | null;
    });
    const known = values.filter((v): v is number => v != null);
    const units = body.units || 'W';
    // What the line is, and what it is summed from.
    legend.innerHTML = '';
    legend.appendChild(el('span', { class: 'desc', style: { margin: '0' } },
      el('span', { class: 'trend-swatch', style: { background: 'var(--accent)' } }), o.lineLabel));
    if (nodes.length > 1 || nodes[0] !== o.lineLabel)
      nodes.forEach(id => legend.appendChild(el('span', { class: 'desc', style: { margin: '0' } }, `${labelOf(id)} (${id})`)));
    plot.appendChild(sparkline({
      values, color: 'var(--accent)', units, width: 560, height: 160, grid: true,
      at: (i: number) => at[i] ? new Date(at[i]).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '',
    }));
    const when = (i: number) => (at[i] ? new Date(at[i]).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    const peak = known.length ? Math.max(...known) : null;
    const peakAt = peak == null ? '' : when(values.findIndex(v => v === peak));
    const last = [...values].reverse().find(v => v != null);
    note.textContent = known.length
      ? `${known.length} of ${values.length} readings · peak ${Math.round(peak!).toLocaleString('en-US')} ${units}`
        + `${peakAt ? ` at ${peakAt}` : ''} · average ${Math.round(known.reduce((a, v) => a + v, 0) / known.length).toLocaleString('en-US')} ${units}`
        + `${last == null ? '' : ` · latest ${Math.round(last).toLocaleString('en-US')} ${units}`} · from ${nodes.join(' + ')}`
      : `No readings stored for ${nodes.join(', ')} in this window.`;

    // What the total is made of, each on a strip of its own over the same window and the same reading.
    breakdown.innerHTML = '';
    if (!parts.length) return;
    const held = parts.map(id => ({ id, s: all.find((x: any) => x.node === id) })).filter(x => x.s);
    if (!held.length) {
      breakdown.appendChild(el('div', { class: 'desc', text: `Nothing is stored for what ${o.lineLabel} is made of in this window.` }));
      return;
    }
    breakdown.appendChild(el('div', { class: 'hs-parts-head', text: o.partsLabel || 'What it is made of' }));
    // Ordered by what each drew, so the biggest part of the total is first.
    held.map(({ id, s }) => {
      const vs: (number | null)[] = (s.values || []).map((v: any) => (typeof v === 'number' ? v : null));
      const seen = vs.filter((v): v is number => v != null);
      return { id, label: s.label || labelOf(id), vs, latest: [...vs].reverse().find(v => v != null) ?? null, avg: seen.length ? seen.reduce((a, v) => a + v, 0) / seen.length : null };
    }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1)).forEach(part => {
      const row = el('div', { class: 'hs-part' });
      row.dataset.node = part.id;
      row.appendChild(el('span', { class: 'hs-part-name', text: part.label, title: part.id }));
      row.appendChild(sparkline({ values: part.vs, color: 'var(--accent)', units, width: 132, height: 34 }));
      // A part with no reading says so: it is not nothing, it is unknown.
      row.appendChild(el('span', { class: 'hs-part-num', text: part.latest == null ? 'no data' : `${Math.round(part.latest).toLocaleString('en-US')} ${units}` }));
      breakdown.appendChild(row);
    });
  };

  const picker = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  const buttons = HISTORY_WINDOWS.map(([q, label]) => {
    const b = btn(label);
    b.onclick = () => {
      window = q;
      try { localStorage.setItem(WINDOW_KEY, q); } catch { /* a browser that keeps nothing still charts */ }
      buttons.forEach(x => x.classList.remove('primary'));
      b.classList.add('primary');
      load();
    };
    picker.appendChild(b);
    return b;
  });
  const markWindow = () => buttons.forEach((b, i) => b.classList.toggle('primary', HISTORY_WINDOWS[i][0] === window));
  markWindow();
  // The same reading, asked for in another measurement: watts, amps, or the energy behind them.
  const metricSel = el('select', { class: 'hs-metric', title: 'Which measurement to chart.' }) as HTMLSelectElement;
  HISTORY_METRICS.forEach(([v, t]) => metricSel.appendChild(el('option', { value: v, text: t })));
  if (!HISTORY_METRICS.some(([v]) => v === metricNow)) metricSel.appendChild(el('option', { value: metricNow, text: metricNow }));
  metricSel.value = metricNow;
  metricSel.onchange = () => { metricNow = metricSel.value; load(); };
  picker.appendChild(el('label', { class: 'ld-inst' }, 'Show ', metricSel));

  // The node itself is a thing of its own — its bindings and its label live on the Nodes page.
  const toNode = btn('Edit node');
  toNode.hidden = !nodes.length || o.editNode === false;
  toNode.title = nodes.length ? `Open ${labelOf(nodes[0])} (${nodes[0]}) in the node editor.` : '';
  toNode.onclick = () => {
    closeSheet();
    editNodeOnNextOpen(nodes[0]);
    (Array.from(document.querySelectorAll('nav a')) as any[]).find(a => a.dataset.label === 'Nodes')?.click();
  };
  openSheet({
    title: o.title,
    body: el('div', {}, picker, plot, legend, note, breakdown),
    footer: [toNode, ...(o.footer || [])],
  });
  load();
}

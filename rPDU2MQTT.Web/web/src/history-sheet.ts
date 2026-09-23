// What a node has been drawing, in a sheet: the panel schedule opens it for a breaker, the flow diagram for
// whatever was right-clicked. One line, summed from the nodes asked for — a moment where any of them has no
// reading is a gap in the line, never a partial sum.
import { api, btn, closeSheet, el, openSheet } from './helpers.js';
import { sparkline } from './charts.js';
import { editNodeOnNextOpen } from './sections/nodes.js';

/// Windows worth asking about, and how finely each is sampled.
export const HISTORY_WINDOWS: [string, string][] = [
  ['minutes=360&step=60', 'Last 6 hours'],
  ['minutes=1440&step=900', 'Last 24 hours'],
  ['days=7&step=3600', 'Last 7 days'],
];

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
};

/// Open the history of one or more nodes, over a window picked in the sheet.
export function openHistorySheet(o: HistoryRequest) {
  const nodes = o.nodes.filter(Boolean);
  const labelOf = o.labelOf || ((id: string) => id);
  const metric = o.metric || 'realpower';
  const plot = el('div', { class: 'ps-chart' });
  const legend = el('div', { class: 'ld-toolbar ps-legend', style: { flexWrap: 'wrap', gap: '10px' } });
  const note = el('div', { class: 'desc' });
  let window = HISTORY_WINDOWS[1][0];

  const load = async () => {
    if (!nodes.length) {
      plot.innerHTML = '';
      note.textContent = o.empty || 'Nothing is measuring this, so there is nothing to chart.';
      return;
    }
    plot.innerHTML = '';
    note.textContent = 'Reading…';
    let r: any;
    try { r = await api(`/api/flow/series?${window}&metric=${metric}`); }
    catch (e: any) { r = { body: { ok: false, message: e?.message || 'the request failed' } }; }
    const body = r?.body;
    if (!body?.ok) { note.textContent = body?.message || 'Could not read the history.'; return; }
    const series = (body.series || []).filter((s: any) => nodes.includes(s.node));
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
    note.textContent = known.length
      ? `${known.length} of ${values.length} readings · peak ${Math.round(Math.max(...known)).toLocaleString('en-US')} ${units} · `
        + `average ${Math.round(known.reduce((a, v) => a + v, 0) / known.length).toLocaleString('en-US')} ${units} · from ${nodes.join(' + ')}`
      : `No readings stored for ${nodes.join(', ')} in this window.`;
  };

  const picker = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  const buttons = HISTORY_WINDOWS.map(([q, label]) => {
    const b = btn(label);
    b.onclick = () => { window = q; buttons.forEach(x => x.classList.remove('primary')); b.classList.add('primary'); load(); };
    picker.appendChild(b);
    return b;
  });
  buttons[1].classList.add('primary');

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
    body: el('div', {}, picker, plot, legend, note),
    footer: [toNode, ...(o.footer || [])],
  });
  load();
}

// Node Data: every reading the energy flow is collecting, in one table.
//
// The chart shows one metric at a time and only what flows, so everything else the bridge ingests — a
// battery's state of charge, a temperature, an inverter's frequency — had nowhere to be seen. This lists
// each node against every metric bound to it.
//
// The column that matters is Updated. A dead publisher and a topic that was never right both show an
// empty chart, and they need completely different fixes; the API reports a reading even after it has
// expired (flagged, not hidden) precisely so the two can be told apart here.
//
// With history on, the same table can show a past moment instead, picked on a timeline (#514).
import { api, btn, el, activate, formatNum, navLink } from '../helpers.js';
import { state } from '../state.js';
import { liveWhileActive, realtimeLive } from '../realtime.js';
import { timelineStrip } from './timeline.js';
import { stepToFit } from './trends-shared.js';
import type { Line } from '../charts.js';

// Mirrors FlowUnits.cs — the canonical unit each metric is stored in, and its display name.
const UNITS: Record<string, [string, string]> = {
  realpower: ['Power', 'W'], apparentpower: ['Apparent power', 'VA'], energy: ['Energy', 'kWh'],
  current: ['Current', 'A'], voltage: ['Voltage', 'V'], frequency: ['Frequency', 'Hz'],
  powerfactor: ['Power factor', ''], soc: ['State of charge', '%'],
  percent: ['Percentage', '%'], temperature: ['Temperature', '°C'],
};
const metricName = (m: string) => (UNITS[m] || [m, ''])[0];
const metricUnit = (m: string) => (UNITS[m] || [m, ''])[1];

/// How far back the timeline reaches.
const NODE_DATA_WINDOWS: [number, string][] = [[60, '1 hour'], [360, '6 hours'], [1440, '24 hours'], [10080, '7 days']];
/// Samples drawn across the timeline.
const STRIP_POINTS = 300;
const STRIP_COLOURS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];

const ago = (s: number) => s < 1 ? 'just now'
  : s < 90 ? Math.round(s) + 's ago'
  : s < 5400 ? Math.round(s / 60) + 'm ago'
  : Math.round(s / 3600) + 'h ago';

export function addNodeDataSection(nav: any, sections: any) {
  const link = navLink(nav, 'Node Data', '⊞');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Node Data' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Every reading the energy flow is collecting — one row per node and bound metric, whatever the chart happens to be showing. “Updated” is the one to watch: a source that has stopped reporting still lists its last value, marked stale, so a dead publisher can be told apart from a binding that was never right.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const refresh = btn('Refresh');
  const filter = el('input', { type: 'text', placeholder: 'Filter (node / metric / topic)…' });
  const onlyProblems = el('input', { type: 'checkbox', class: 'switch' });
  const problemsLab = el('label', { title: 'Show only rows with no reading, or one that has gone stale.' },
    onlyProblems, ' Problems only');
  const count = el('span', { class: 'ld-count' });
  const pastOn = el('input', { type: 'checkbox', class: 'switch' });
  const pastLab = el('label', { title: 'Show what each reading was at a moment picked on a timeline, from history.' },
    pastOn, ' Point in time');
  const windowSel = el('select', { title: 'How far back the timeline reaches.' }) as HTMLSelectElement;
  NODE_DATA_WINDOWS.forEach(([m, t]) => windowSel.appendChild(el('option', { value: String(m), text: t })));
  windowSel.value = '1440';
  // The day the timeline ends on; blank is now.
  const dayIn = el('input', { type: 'date', title: 'The day the timeline ends on. Blank for now.' }) as HTMLInputElement;
  const pastTools = el('span', { style: { display: 'contents' } }, windowSel, el('span', { class: 'desc', style: { margin: '0' }, text: 'ending' }), dayIn);
  bar.append(refresh, filter, problemsLab, pastLab, pastTools, count);
  sec.appendChild(bar);
  const strip = timelineStrip(span => { if (span) { at = span.from; load(); } }, undefined, { moment: true });
  sec.appendChild(strip.el);
  const wrap = el('div'); sec.appendChild(wrap);

  // The moment shown, in epoch ms, or null for now.
  let at: number | null = null;
  const historyOn = () => !!(state.data?.History || {}).Enabled;
  const past = () => historyOn() && pastOn.checked;
  const syncPast = () => {
    pastLab.classList[historyOn() ? 'remove' : 'add']('is-hidden');
    pastTools.classList[past() ? 'remove' : 'add']('is-hidden');
    strip.el.hidden = !past();
    problemsLab.classList[past() ? 'add' : 'remove']('is-hidden');
  };

  // One row per (node, bound metric), from the configured hierarchy — so a binding that has never
  // delivered still appears, which is exactly the case worth seeing.
  const rows = () => {
    const out: any[] = [];
    (state.data?.EnergyFlow?.Nodes || []).forEach((n: any) => {
      if (!n.Id) return;
      const bound = (n.Sources || []).concat((n.Mqtt || []).map((m: any) => ({ Type: 'mqtt', ...m })));
      if (!bound.length) {
        if (n.Value != null) out.push({ node: n, metric: 'realpower', src: null, fixed: n.Value });
        return;
      }
      bound.forEach((s: any) => out.push({ node: n, metric: s.Metric || 'realpower', src: s }));
    });
    return out;
  };

  const describe = (s: any) => !s ? 'fixed value'
    : s.Type === 'modbus' ? `${s.Connection || 'modbus'} · register ${s.Register}`
    : (s.Topic || '') + (s.JsonField ? ` · ${s.JsonField}` : '');

  let live: Record<string, any> = {};
  const keyOf = (r: any) => `${r.node.Id}|${r.metric}`;

  const draw = () => {
    const f = (filter.value || '').trim().toLowerCase();
    let list = rows();
    list = list.filter(r => !f || `${r.node.Label || ''} ${r.node.Id} ${metricName(r.metric)} ${describe(r.src)}`.toLowerCase().includes(f));
    if (onlyProblems.checked && !past()) list = list.filter(r => {
      const v = live[keyOf(r)];
      // A reading with no timestamp is not a problem — it is in use. Only nothing at all, or something stale.
      return r.fixed == null && (!v || (v.reported == null && v.value == null) || v.fresh === false);
    });

    wrap.innerHTML = '';
    if (!list.length) {
      wrap.appendChild(el('div', { class: 'desc', text: onlyProblems.checked && !past() ? 'Nothing stale or missing — every bound source is reporting.' : 'No nodes have sources bound yet. Bind one on the Nodes tab.' }));
      return;
    }

    const t = el('table', { class: 'ld' });
    const head = el('tr');
    // A past moment has no age to show: the reading is whatever history held then.
    (past() ? ['Node', 'Metric', 'Value'] : ['Node', 'Metric', 'Value', 'Updated'])
      .forEach((h, i) => head.appendChild(el('th', { class: i === 2 ? 'num' : '', text: h })));
    t.appendChild(el('thead', {}, head));
    const tb = el('tbody');

    let stale = 0, missing = 0;
    list.forEach(r => {
      const v = live[keyOf(r)];
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('span', { text: r.node.Label || r.node.Id }),
        el('div', { class: 'desc', style: { fontSize: '11px', margin: '0' }, text: r.node.Id })));
      // Where the reading comes from, on hover rather than a column of its own.
      tr.appendChild(el('td', { text: metricName(r.metric), title: describe(r.src) }));

      // `reported` is the reading including one that has expired, and it only exists where the ingest can
      // date its readings. `value` is the live figure the roll-up is using. Reading the first alone meant a
      // source that cannot report ages showed "—" here while the diagram beside it drew that very number.
      const shown = v ? (v.reported != null ? v.reported : v.value) : null;
      const val = el('td', { class: 'num' });
      if (r.fixed != null) val.append(el('span', { text: `${formatNum(r.fixed)} ${metricUnit(r.metric)}`.trim() }));
      else if (shown != null) val.append(el('span', { text: `${formatNum(shown)} ${metricUnit(r.metric)}`.trim() }));
      else { val.append(el('span', { style: { color: 'var(--muted)' }, text: '—' })); missing++; }
      tr.appendChild(val);
      if (past()) { tb.appendChild(tr); return; }

      const upd = el('td');
      if (r.fixed != null) upd.append(el('span', { class: 'desc', text: 'fixed' }));
      // A value with no timestamp is not a source that never reported — it is one whose ingest does not
      // date its readings. Calling it "never" while showing its number contradicts the row itself.
      else if (v && v.atUtc == null && shown != null)
        upd.append(el('span', { class: 'desc', title: 'This value is in use, but the source it came from does not record when it arrived, so it cannot be aged.', text: 'no timestamp' }));
      else if (!v || v.atUtc == null) upd.append(el('span', { style: { color: 'var(--muted)' }, text: 'never' }));
      else {
        const fresh = v.fresh !== false;
        if (!fresh) stale++;
        upd.append(el('span', { class: 'dot ' + (fresh ? 'good' : 'bad') }), ' ', ago(v.ageSeconds ?? 0));
        upd.title = new Date(v.atUtc).toLocaleString()
          + (v.staleAfterSeconds ? `\nExpires after ${v.staleAfterSeconds}s without an update.` : '\nNever expires.')
          + (fresh ? '' : '\nStale — this value is no longer used by the flow or the exports.');
      }
      tr.appendChild(upd);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);

    if (past()) {
      count.textContent = `${list.length} reading(s)` + (missing ? ` · ${missing} with no history then` : '');
      count.title = at != null ? `As of ${new Date(at).toLocaleString()}` : '';
      return;
    }
    count.textContent = `${list.length} reading(s)`
      + (stale ? ` · ${stale} stale` : '') + (missing ? ` · ${missing} never reported` : '');
    count.title = stale || missing
      ? 'A stale row had a value that expired; a "never" row has a binding that has not delivered once — check the topic or register.'
      : '';
  };

  const load = async () => {
    syncPast();
    const when = past() ? at : null;
    if (past() && when == null) { live = {}; draw(); return; }
    const q = rows().filter(r => !r.fixed).map(r => ({ Node: r.node.Id, Metric: r.metric }));
    if (q.length) {
      const path = '/api/flow/live' + (when != null ? '?at=' + encodeURIComponent(new Date(when).toISOString()) : '');
      const r = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
      // A moment picked since this was asked for is already on its way.
      if ((past() ? at : null) !== when) return;
      live = {};
      (r.body?.values || []).forEach((v: any) => { live[`${v.node}|${v.metric}`] = v; });
      if (r.body?.ok === false) count.textContent = r.body.message || '';
    }
    draw();
  };

  /// The timeline: the busiest few nodes' power over the window, so the moment can be picked by its shape.
  const loadStrip = async () => {
    const minutes = Number(windowSel.value) || 1440;
    const step = stepToFit(minutes * 60, STRIP_POINTS);
    const now = Date.now();
    const end = dayIn.value ? Math.min(now, new Date(`${dayIn.value}T23:59:59`).getTime()) : now;
    const r = await api(`/api/flow/series?from=${encodeURIComponent(new Date(end - minutes * 60_000).toISOString())}`
      + `&to=${encodeURIComponent(new Date(end).toISOString())}&step=${step}&metric=realpower`);
    const b = r.body;
    const points = ((b?.at || []) as string[]).map(iso => new Date(iso).getTime());
    if (!b?.ok || points.length < 2) {
      strip.el.hidden = true;
      at = null;
      wrap.innerHTML = '';
      wrap.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: b?.message || 'No history for that window.' }));
      return;
    }
    const peak = (s: any) => Math.max(0, ...s.values.filter((v: any) => v != null).map((v: number) => Math.abs(v)));
    const lines: Line[] = (b.series || []).filter((s: any) => !String(s.node).endsWith('#in'))
      .sort((x: any, y: any) => peak(y) - peak(x)).slice(0, STRIP_COLOURS.length)
      .map((s: any, i: number) => ({ label: s.label || s.node, color: STRIP_COLOURS[i], values: s.values }));
    strip.el.hidden = false;
    strip.draw({ lines, points, bounds: { from: points[0], to: points[points.length - 1] }, width: 1200 });
    // Opens on the newest reading; a moment still inside the window is kept.
    if (at == null || at < points[0] || at > points[points.length - 1]) at = points[points.length - 1];
    strip.set({ from: at, to: at });
    load();
  };

  const refreshAll = () => (past() ? loadStrip() : load());
  refresh.onclick = refreshAll;
  filter.oninput = draw;
  onlyProblems.onchange = draw;
  pastOn.onchange = () => { at = null; syncPast(); refreshAll(); };
  windowSel.onchange = () => loadStrip();
  dayIn.onchange = () => { at = null; loadStrip(); };
  // Ages tick even when nothing new arrives — a row going stale is itself the event worth seeing.
  liveWhileActive(sec, () => 'flow:realpower', () => { if (!past()) load(); });
  setInterval(() => { if (sec.classList.contains('active') && !past() && !realtimeLive()) load(); }, 10000);
  syncPast();
  link.onclick = () => { activate(link, sec); refreshAll(); };
  return link;
}

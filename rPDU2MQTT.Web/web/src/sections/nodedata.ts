// Node Data: every reading the energy flow is collecting, in one table.
//
// The chart shows one metric at a time and only what flows, so everything else the bridge ingests — a
// battery's state of charge, a temperature, an inverter's frequency — had nowhere to be seen. This lists
// each node against every metric bound to it.
//
// The column that matters is Updated. A dead publisher and a topic that was never right both show an
// empty chart, and they need completely different fixes; the API reports a reading even after it has
// expired (flagged, not hidden) precisely so the two can be told apart here.
import { api, btn, el, activate, formatNum, navLink } from '../helpers.js';
import { state } from '../state.js';
import { liveWhileActive, realtimeLive } from '../realtime.js';

// Mirrors FlowUnits.cs — the canonical unit each metric is stored in, and its display name.
const UNITS: Record<string, [string, string]> = {
  realpower: ['Power', 'W'], apparentpower: ['Apparent power', 'VA'], energy: ['Energy', 'kWh'],
  current: ['Current', 'A'], voltage: ['Voltage', 'V'], frequency: ['Frequency', 'Hz'],
  powerfactor: ['Power factor', ''], soc: ['State of charge', '%'],
  percent: ['Percentage', '%'], temperature: ['Temperature', '°C'],
};
const metricName = (m: string) => (UNITS[m] || [m, ''])[0];
const metricUnit = (m: string) => (UNITS[m] || [m, ''])[1];

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
  bar.append(refresh, filter, problemsLab, count);
  sec.appendChild(bar);
  const wrap = el('div'); sec.appendChild(wrap);

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
    if (onlyProblems.checked) list = list.filter(r => { const v = live[keyOf(r)]; return r.fixed == null && (!v || v.reported == null || v.fresh === false); });

    wrap.innerHTML = '';
    if (!list.length) {
      wrap.appendChild(el('div', { class: 'desc', text: onlyProblems.checked ? 'Nothing stale or missing — every bound source is reporting.' : 'No nodes have sources bound yet. Bind one on the Nodes tab.' }));
      return;
    }

    const t = el('table', { class: 'ld' });
    const head = el('tr');
    ['Node', 'Metric', 'Value', 'Updated', 'Source'].forEach((h, i) => head.appendChild(el('th', { class: i === 2 ? 'num' : '', text: h })));
    t.appendChild(el('thead', {}, head));
    const tb = el('tbody');

    let stale = 0, missing = 0;
    list.forEach(r => {
      const v = live[keyOf(r)];
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('span', { text: r.node.Label || r.node.Id }),
        el('div', { class: 'desc', style: { fontSize: '11px', margin: '0' }, text: r.node.Id })));
      tr.appendChild(el('td', { text: metricName(r.metric) }));

      const val = el('td', { class: 'num' });
      if (r.fixed != null) val.append(el('span', { text: `${formatNum(r.fixed)} ${metricUnit(r.metric)}`.trim() }));
      else if (v && v.reported != null) val.append(el('span', { text: `${formatNum(v.reported)} ${metricUnit(r.metric)}`.trim() }));
      else { val.append(el('span', { style: { color: 'var(--muted)' }, text: '—' })); missing++; }
      tr.appendChild(val);

      const upd = el('td');
      if (r.fixed != null) upd.append(el('span', { class: 'desc', text: 'fixed' }));
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
      tr.appendChild(el('td', {}, el('span', { class: 'ov-sub', text: describe(r.src) })));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);

    count.textContent = `${list.length} reading(s)`
      + (stale ? ` · ${stale} stale` : '') + (missing ? ` · ${missing} never reported` : '');
    count.title = stale || missing
      ? 'A stale row had a value that expired; a "never" row has a binding that has not delivered once — check the topic or register.'
      : '';
  };

  const load = async () => {
    const q = rows().filter(r => !r.fixed).map(r => ({ Node: r.node.Id, Metric: r.metric }));
    if (q.length) {
      const r = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
      live = {};
      (r.body?.values || []).forEach((v: any) => { live[`${v.node}|${v.metric}`] = v; });
    }
    draw();
  };

  refresh.onclick = load;
  filter.oninput = draw;
  onlyProblems.onchange = draw;
  // Ages tick even when nothing new arrives — a row going stale is itself the event worth seeing.
  liveWhileActive(sec, () => 'flow:realpower', () => load());
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive()) load(); }, 10000);
  link.onclick = () => { activate(link, sec); load(); };
  return link;
}

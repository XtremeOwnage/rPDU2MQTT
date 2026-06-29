// Integration Paths section + the shared paths-table builders (also used by the overrides preview).
import { api, btn, activate, toast } from '../helpers.js';

// A click-to-copy monospace table cell (used by the path tables).
export function pathCopyCell(text: string) {
  const td = document.createElement('td');
  if (!text) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
  const code = document.createElement('span'); code.textContent = text; code.style.cursor = 'pointer';
  code.style.fontFamily = 'ui-monospace,Consolas,monospace'; code.style.fontSize = '12px'; code.title = 'Click to copy';
  code.onclick = () => { navigator.clipboard?.writeText(text); toast('Copied: ' + text, true); };
  td.appendChild(code); return td;
}

// Build a paths table (Device / Outlet / Measurement / MQTT [/ Prometheus] [/ EmonCMS]).
export function pathsTable(rows: any[], promOn: boolean, emonOn: boolean) {
  const t = document.createElement('table'); t.className = 'ld';
  const cols = ['Device', 'Outlet / entity', 'Measurement', 'MQTT topic'];
  if (promOn) cols.push('Prometheus'); if (emonOn) cols.push('EmonCMS');
  const head = document.createElement('tr'); cols.forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
  const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
  const tb = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    [r.device, r.source, r.type].forEach(c => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
    tr.appendChild(pathCopyCell(r.mqtt));
    if (promOn) tr.appendChild(pathCopyCell(r.prometheus));
    if (emonOn) tr.appendChild(pathCopyCell(r.emoncms));
    tb.appendChild(tr);
  });
  t.appendChild(tb); return t;
}

// Generated integration paths per measurement (MQTT topic, Prometheus metric, EmonCMS key).
export function addPathsSection(nav: any, sections: any) {
  const link = document.createElement('a'); link.textContent = 'Paths'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Integration Paths'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'The MQTT topic, Prometheus metric, and EmonCMS key generated for each measurement (reflecting your overrides). Click a value to copy it.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const filter = document.createElement('input'); filter.type = 'text'; filter.placeholder = 'Filter (device / outlet / measurement / path)…';
  const count = document.createElement('span'); count.className = 'ld-count';
  bar.appendChild(refresh); bar.appendChild(filter); bar.appendChild(count); sec.appendChild(bar);
  const tableWrap = document.createElement('div'); sec.appendChild(tableWrap);

  let rows: any[] = [], promOn = false, emonOn = false;
  const draw = () => {
    const f = filter.value.trim().toLowerCase();
    const shown = f ? rows.filter(r => (r.device + ' ' + r.source + ' ' + r.type + ' ' + r.mqtt + ' ' + (r.prometheus || '') + ' ' + (r.emoncms || '')).toLowerCase().includes(f)) : rows;
    tableWrap.innerHTML = ''; tableWrap.appendChild(pathsTable(shown, promOn, emonOn));
  };
  const load = async () => {
    const r = await api('/api/paths');
    if (!r.body.ok) { tableWrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load paths.') + '</div>'; count.textContent = ''; return; }
    rows = r.body.rows || []; promOn = !!r.body.prometheusEnabled; emonOn = !!r.body.emonEnabled;
    count.textContent = rows.length + ' measurements';
    draw();
  };
  refresh.onclick = load; filter.oninput = draw;
  link.onclick = () => { activate(link, sec); load(); };
}

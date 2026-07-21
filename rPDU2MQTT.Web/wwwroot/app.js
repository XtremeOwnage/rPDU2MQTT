// ── state.ts ────────────────────────────────────────────────────
// Shared, mutable app state: the config schema and the editable config document, both set on load().
// (Authored as ES modules; the build bundles them into one shared scope, as the GUI has always run.)
const state                               = { schema: [], data: {} };

// ── helpers.ts ──────────────────────────────────────────────────
// Generic, dependency-free helpers: fetch wrapper, DOM builders, the toast, tab activation, the SVG
// zoom helper, and the multi-PDU instance selector.

const api = (p        , opt      ) => fetch(p, opt).then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }));

function ensure(obj     , key        , fallback     ) { if (obj[key] === undefined || obj[key] === null) obj[key] = fallback; return obj[key]; }

// --- DOM helpers ---------------------------------------------------------------------------------
// Create an element with optional props and children, to cut createElement/append boilerplate.
function el(tag        , props      , ...children       )      {
  const e      = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k === 'text') e.textContent = v;
    else if (k in e) e[k] = v; else e.setAttribute(k, v       );
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
// A small ".small" button (add a class like "danger"/"primary" via cls).
function btn(label        , cls         )      { return el('button', { class: 'small' + (cls ? ' ' + cls : ''), text: label }); }

function formatNum(v     ) { return (typeof v === 'number' && Number.isFinite(v)) ? v.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(v); }

// SVG element helper (separate namespace from el()).
function svgEl(tag        , attrs      )      {
  const e      = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v       );
  return e;
}

function toast(msg        , good          ) { const t      = document.getElementById('toast'); t.textContent = msg; t.className = 'toast ' + (good ? 'good' : 'bad'); }

// Copy text, and say honestly whether it worked. navigator.clipboard only exists in a secure context, and
// this GUI is usually reached over plain http on a LAN — so fall back to the old selection trick rather than
// silently doing nothing while claiming "Copied".
async function copyText(text        )                   {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// Make an element copy some text when clicked, with the feedback that goes with it.
function copyOnClick(node     , text        , label         ) {
  node.style.cursor = 'pointer';
  node.title = 'Click to copy';
  node.onclick = async () => {
    const ok = await copyText(text);
    toast(ok ? `Copied: ${label || text}` : 'Could not copy — your browser blocked it (try selecting the text).', ok);
  };
  return node;
}

// A URL-friendly slug for a nav label (used to put the active tab in the address bar).
function slug(text        )         {
  return (text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function activate(link     , sec     ) {
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  link.classList.add('active'); sec.classList.add('active');
  // Reflect the active tab in the URL hash so a refresh (or a shared link) reopens it. Only write when it
  // actually changes, to avoid spurious history entries / hashchange loops (see the listener in main.ts).
  const s = slug(link.textContent);
  if (s && decodeURIComponent((location.hash || '').slice(1)) !== s) location.hash = s;
}

// Mouse-wheel zoom for an SVG inside a scroll container. The SVG must carry a viewBox of its base size;
// we scale by setting its width/height and keep the point under the cursor fixed. Returns a detach fn.
function attachZoom(scroll     , svg     , baseW        , baseH        ) {
  let z = 1; const min = 0.25, max = 6;
  const apply = () => { svg.setAttribute('width', Math.round(baseW * z)); svg.setAttribute('height', Math.round(baseH * z)); };
  apply();
  const onWheel = (e     ) => {
    e.preventDefault();
    const r = scroll.getBoundingClientRect();
    const cx = scroll.scrollLeft + (e.clientX - r.left), cy = scroll.scrollTop + (e.clientY - r.top);
    const prev = z;
    z = Math.min(max, Math.max(min, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    if (z === prev) return;
    apply();
    const k = z / prev;
    scroll.scrollLeft = cx * k - (e.clientX - r.left);
    scroll.scrollTop = cy * k - (e.clientY - r.top);
  };
  scroll.addEventListener('wheel', onWheel, { passive: false });
  return () => scroll.removeEventListener('wheel', onWheel);
}

// --- Multi-PDU: per-tab instance selector ---
let _instancesCache      = null;
async function getInstances() {
  if (_instancesCache) return _instancesCache;
  const r = await api('/api/instances');
  _instancesCache = (r.body && r.body.ok) ? (r.body.instances || []) : [];
  return _instancesCache;
}
// A per-tab PDU instance picker. Returns { wrap, get } — append `wrap` to a toolbar; `get()` is the
// selected instance id. Stays hidden when only one instance is configured (single-PDU UX unchanged);
// then get() === '' so the backend falls back to the primary. `onChange` fires when the user switches.
function instanceSelector(onChange                       ) {
  const sel      = el('select');
  const wrap = el('label', { class: 'ld-inst', style: { display: 'none' } }, 'Instance ', sel);
  getInstances().then((list       ) => {
    if (list.length <= 1) return;
    list.forEach(i => sel.appendChild(el('option', { value: i.id, text: i.id + (i.primary ? ' (primary)' : '') })));
    sel.value = (list.find(i => i.primary) || list[0]).id;
    wrap.style.display = '';
  });
  sel.onchange = () => onChange && onChange(sel.value);
  return { wrap, get: () => sel.value || '' };
}
// Append `?instance=<id>` to a path when an instance is selected (empty -> primary, omit the param).
function withInstance(path        , instSel     ) {
  const v = instSel.get();
  return v ? path + (path.includes('?') ? '&' : '?') + 'instance=' + encodeURIComponent(v) : path;
}

// ── overrides.ts ────────────────────────────────────────────────
// Overrides editor (driven by live PDU data) + the config export/prune helpers.

function ovGet(path          ) { let o = state.data.Overrides; for (const p of path) { if (o == null) return undefined; o = o[p]; } return o; }
function ovSet(path          , val     ) {
  let o = state.data.Overrides = state.data.Overrides || {};
  for (let i = 0; i < path.length - 1; i++) { if (o[path[i]] == null) o[path[i]] = {}; o = o[path[i]]; }
  const last = path[path.length - 1];
  if (val === undefined || val === null || val === '') delete o[last]; else o[last] = val;
}

function ovText(label        , path          , placeholder         ) {
  const f = document.createElement('label'); f.className = 'ov-field';
  const s = document.createElement('span'); s.textContent = label; f.appendChild(s);
  const inp = document.createElement('input'); inp.type = 'text';
  const v = ovGet(path); if (v != null) inp.value = v;
  if (placeholder) inp.placeholder = placeholder;
  inp.onchange = () => ovSet(path, inp.value.trim());
  f.appendChild(inp); return f;
}
function ovEnabled(path          ) {
  const f = document.createElement('label'); f.className = 'ov-field ov-check';
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = ovGet(path) !== false;
  // Checked == default (true) -> drop the key; unchecked -> persist Enabled:false.
  inp.onchange = () => ovSet(path, inp.checked ? undefined : false);
  const s = document.createElement('span'); s.textContent = 'Enabled';
  f.appendChild(inp); f.appendChild(s); return f;
}
// ph: { name, id } placeholders showing the current (default) values.
// makeModel: also render Manufacturer/Model overrides (devices/outlets/groups, not measurements).
function overrideFields(objPath          , ph     , makeModel          ) {
  ph = ph || {};
  const wrap = document.createElement('div'); wrap.className = 'ov-fields';
  wrap.appendChild(ovText('Name (display)', [...objPath, 'Name'], ph.name));
  wrap.appendChild(ovText('ID (object_id)', [...objPath, 'ID'], ph.id));
  if (makeModel) {
    // Keep Make + Model together on one line.
    const pair = document.createElement('div'); pair.className = 'ov-pair';
    pair.appendChild(ovText('Make (manufacturer)', [...objPath, 'Make'], 'e.g. Dell'));
    pair.appendChild(ovText('Model', [...objPath, 'Model'], 'e.g. PowerEdge R730xd'));
    wrap.appendChild(pair);
  }
  wrap.appendChild(ovEnabled([...objPath, 'Enabled']));
  if (makeModel) {
    const note = document.createElement('div'); note.className = 'ov-note';
    note.textContent = 'Make/Model: leave blank to use the PDU’s value (or the Remap Model/Manufacturer result, if those toggles are enabled).';
    wrap.appendChild(note);
  }
  return wrap;
}
// A muted line of "label value" context bits; empty values are skipped.
function ovContext(parts       ) {
  const span = document.createElement('span'); span.className = 'ov-sub';
  span.textContent = parts.filter(p => p[1]).map(p => (p[0] ? p[0] + ' ' : '') + p[1]).join('   ·   ');
  return span;
}
function overrideCard(title        , contextParts       , objPath          , ph     , makeModel          ) {
  const card = document.createElement('div'); card.className = 'ov-card';
  const head = document.createElement('div'); head.className = 'ov-head';
  const t = document.createElement('div'); t.className = 'ov-title'; t.textContent = title; head.appendChild(t);
  if (contextParts && contextParts.some(p => p[1])) head.appendChild(ovContext(contextParts));
  card.appendChild(head);
  card.appendChild(overrideFields(objPath, ph, makeModel));
  return card;
}
function groupHeader(title        , sub               ) {
  const w = document.createElement('div'); w.className = 'ov-group';
  const h = document.createElement('h3'); h.textContent = title; w.appendChild(h);
  if (sub) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = sub; w.appendChild(d); }
  return w;
}
function outletRow(deviceKey        , o     ) {
  const row = document.createElement('div'); row.className = 'ov-outlet';
  const lab = document.createElement('div'); lab.className = 'ov-outlet-label';
  const strong = document.createElement('strong'); strong.textContent = 'Outlet ' + o.index; lab.appendChild(strong);
  const friendly = o.label || o.name;
  if (friendly) { const s = document.createElement('span'); s.textContent = ' — ' + friendly; lab.appendChild(s); }
  row.appendChild(lab);
  if (o.name || o.displayName) row.appendChild(ovContext([['PDU name:', o.name], ['discovered as:', o.displayName]]));
  row.appendChild(overrideFields(['Devices', deviceKey, 'Outlets', String(o.index)], { name: o.displayName, id: o.objectId }, true));
  return row;
}
function deviceCard(dev     ) {
  const card = document.createElement('div'); card.className = 'ov-card';
  const head = document.createElement('div'); head.className = 'ov-head';
  const friendly = dev.label || dev.name || dev.key;
  const t = document.createElement('div'); t.className = 'ov-title'; t.textContent = 'Device: ' + friendly; head.appendChild(t);
  head.appendChild(ovContext([['key', dev.key], ['PDU name:', dev.name], ['discovered as:', dev.displayName]]));
  card.appendChild(head);
  card.appendChild(overrideFields(['Devices', dev.key], { name: dev.displayName, id: dev.objectId }, true));

  // Merge live outlets with any override-only outlet keys (e.g. disabled ones not in live data).
  const live = dev.outlets || [];
  const ovOutlets = ovGet(['Devices', dev.key, 'Outlets']) || {};
  const merged = [...live];
  Object.keys(ovOutlets).forEach(idx => { if (!live.some((o     ) => String(o.index) === String(idx))) merged.push({ index: Number(idx), displayName: '(not currently discovered)' }); });
  if (merged.length) {
    const ol = document.createElement('div'); ol.className = 'ov-outlets';
    merged.sort((a     , b     ) => a.index - b.index).forEach((o     ) => ol.appendChild(outletRow(dev.key, o)));
    card.appendChild(ol);
  }
  return card;
}

async function renderOverrides(container     ) {
  container.dataset.loaded = '1';
  container.innerHTML = '<div class="desc">Loading live PDU data…</div>';
  const r = await api('/api/live');
  ensure(state.data, 'Overrides', {}); ensure(state.data.Overrides, 'Devices', {}); ensure(state.data.Overrides, 'Measurements', {});
  container.innerHTML = '';
  if (!r.body.ok) {
    const w = document.createElement('div'); w.className = 'desc'; w.style.color = 'var(--bad)';
    w.textContent = (r.body.message || 'Could not load live data.') + ' Showing existing overrides only.';
    container.appendChild(w);
  }
  const lv = r.body.ok ? r.body : { devices: [], measurements: [], groups: [] };
  const ov = state.data.Overrides;

  container.appendChild(overrideCard('Bridge (rPDU2MQTT)', [['', 'the top-level bridge device']], ['PDU'], {}, true));

  container.appendChild(groupHeader('Devices', 'Each discovered device and its outlets. Leave a field blank to keep the value shown in the placeholder.'));
  const liveKeys = new Set();
  lv.devices.forEach((d     ) => { liveKeys.add(d.key); container.appendChild(deviceCard(d)); });
  Object.keys(ov.Devices || {}).filter(k => !liveKeys.has(k)).forEach(k => container.appendChild(deviceCard({ key: k, displayName: '(not currently discovered)', outlets: [] })));

  container.appendChild(groupHeader('Measurements', 'Applied to every measurement of this type, across all outlets.'));
  const units      = {}; (lv.measurements || []).forEach((m     ) => { units[m.type] = m.units; });
  const types = [...new Set([...(lv.measurements || []).map((m     ) => m.type), ...Object.keys(ov.Measurements || {})])];
  types.forEach(tp => container.appendChild(overrideCard('measurement: ' + tp, [['units:', units[tp]]], ['Measurements', tp], {})));

  if (lv.groups && lv.groups.length) {
    container.appendChild(groupHeader('OneView Groups', null));
    lv.groups.forEach((g     ) => container.appendChild(overrideCard('Group: ' + (g.label || g.name || g.key), [['key', g.key], ['discovered as:', g.displayName]], ['OneviewGroups', 'Overrides', g.key], { name: g.displayName }, true)));
  }
}

// Show the generated paths produced by the current (unsaved) overrides, computed server-side
// against the real processing pipeline so it matches what would actually be published.
async function previewOverridePaths(box     ) {
  box.innerHTML = '<div class="desc">Computing paths with your unsaved edits…</div>';
  const r = await fetch('/api/paths/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) })
    .then(async res => ({ ok: res.ok, body: await res.json().catch(() => ({}       )) }));
  box.innerHTML = '';
  if (!r.body.ok) { box.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not compute paths.') + '</div>'; return; }
  const note = document.createElement('div'); note.className = 'desc';
  note.innerHTML = 'Paths with unsaved overrides applied. Note: overrides change the <b>HA name/object_id</b> and <b>Prometheus device/source labels</b>; the <b>MQTT topic</b> and <b>EmonCMS key</b> derive from the PDU’s raw keys and are not affected.';
  box.appendChild(note);
  box.appendChild(pathsTable(r.body.rows || [], !!r.body.prometheusEnabled, !!r.body.emonEnabled));
}

// Strip empty override objects so untouched entries don't pollute the saved config.
function exportData() {
  const clone = JSON.parse(JSON.stringify(state.data));
  if (clone.Overrides) pruneEmpty(clone.Overrides);
  return clone;
}
function pruneEmpty(o     )      {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const k of Object.keys(o)) {
      const v = pruneEmpty(o[k]);
      if (v === undefined) delete o[k];
    }
    if (Object.keys(o).length === 0) return undefined;
  }
  return o;
}

// ── sections/paths.ts ───────────────────────────────────────────
// Integration Paths section + the shared paths-table builders (also used by the overrides preview).

// A click-to-copy monospace table cell (used by the path tables).
function pathCopyCell(text        ) {
  const td = document.createElement('td');
  if (!text) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
  const code = document.createElement('span'); code.textContent = text;
  code.style.fontFamily = 'ui-monospace,Consolas,monospace'; code.style.fontSize = '12px';
  td.appendChild(copyOnClick(code, text)); return td;
}

// Every cell copies — the device, outlet and measurement names are as worth copying as the paths are
// (they're what you type into an override, a filter or a template).
function copyCell(text        ) {
  const td = document.createElement('td');
  if (!text) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
  const span = document.createElement('span'); span.textContent = text;
  td.appendChild(copyOnClick(span, text)); return td;
}

// Build a paths table (Device / Outlet / Measurement / MQTT [/ Prometheus] [/ EmonCMS]).
function pathsTable(rows       , promOn         , emonOn         ) {
  const t = document.createElement('table'); t.className = 'ld';
  const cols = ['Device', 'Outlet / entity', 'Measurement', 'MQTT topic'];
  if (promOn) cols.push('Prometheus'); if (emonOn) cols.push('EmonCMS');
  const head = document.createElement('tr'); cols.forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
  const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
  const tb = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    [r.device, r.source, r.type].forEach(c => tr.appendChild(copyCell(c)));
    tr.appendChild(pathCopyCell(r.mqtt));
    if (promOn) tr.appendChild(pathCopyCell(r.prometheus));
    if (emonOn) tr.appendChild(pathCopyCell(r.emoncms));
    tb.appendChild(tr);
  });
  t.appendChild(tb); return t;
}

// Generated integration paths per measurement (MQTT topic, Prometheus metric, EmonCMS key).
function addPathsSection(nav     , sections     ) {
  const link = document.createElement('a'); link.textContent = 'Paths'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Integration Paths'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'The MQTT topic, Prometheus metric, and EmonCMS key generated for each measurement (reflecting your overrides). Click any value — path, device, outlet or measurement — to copy it.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const filter = document.createElement('input'); filter.type = 'text'; filter.placeholder = 'Filter (device / outlet / measurement / path)…';
  const count = document.createElement('span'); count.className = 'ld-count';
  bar.appendChild(refresh); bar.appendChild(filter); bar.appendChild(count); sec.appendChild(bar);
  const tableWrap = document.createElement('div'); sec.appendChild(tableWrap);

  let rows        = [], promOn = false, emonOn = false;
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

// ── sections/diagnostics.ts ─────────────────────────────────────
// Status / diagnostics: component health, versions, uptime, restart, and (in Kubernetes) logs + events.

function addDiagnosticsSection(nav     , sections     ) {
  const link = document.createElement('a'); link.textContent = 'Diagnostics'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Diagnostics'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc'; d.textContent = 'Runtime status and maintenance actions.'; sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'sec-actions';
  const refresh = btn('Refresh');
  bar.appendChild(refresh); sec.appendChild(bar);

  // Restart panel: one button per restartable target. In Kubernetes these roll-restart the matching
  // Deployment(s) (which also pulls the latest image); in a split non-k8s deployment they signal the tier
  // over the bus; otherwise it's just this process. Populated from /api/restart/targets.
  const restartBar = document.createElement('div'); restartBar.className = 'sec-actions'; sec.appendChild(restartBar);
  const loadRestartTargets = async () => {
    restartBar.innerHTML = '';
    const r = await api('/api/restart/targets');
    const method = r.body.method || 'local';
    const targets = r.body.targets || [];
    const verb = method === 'rollout' ? 'Rollout restart' : method === 'signal' ? 'Restart' : 'Restart';
    const label = document.createElement('span'); label.className = 'desc'; label.style.cssText = 'margin:0 6px 0 0;align-self:center;';
    label.textContent = method === 'rollout' ? 'Rollout restart (also updates the image):' : method === 'signal' ? 'Restart a tier:' : 'Restart:';
    restartBar.appendChild(label);
    targets.forEach((t     ) => {
      const b = btn(`${verb} — ${t.label}`, t.id === 'all' ? 'danger' : '');
      b.onclick = async () => {
        if (!confirm(`${verb} ${t.label}? It will disconnect briefly while it restarts.`)) return;
        const rr = await api('/api/restart?target=' + encodeURIComponent(t.id), { method: 'POST' });
        toast(rr.body.message || 'Restarting…', rr.ok && rr.body.ok);
      };
      restartBar.appendChild(b);
    });
  };

  const comp = document.createElement('div'); comp.style.margin = '6px 0 14px'; sec.appendChild(comp);
  const info = document.createElement('table'); info.className = 'ld'; sec.appendChild(info);
  const grainsWrap = document.createElement('div'); grainsWrap.style.margin = '14px 0 0'; sec.appendChild(grainsWrap);
  const k8sWrap = document.createElement('div'); sec.appendChild(k8sWrap);

  // The live grain tree (v3): every silo (pod), the grain types active on each, and the current leader.
  const shortSilo = (s        ) => (s || '').split('@')[0];
  const renderGrains = (g     ) => {
    grainsWrap.innerHTML = '';
    const head = document.createElement('div'); head.textContent = 'Grains'; head.style.cssText = 'font-weight:600;color:var(--accent);margin:0 0 6px;'; grainsWrap.appendChild(head);
    if (!g || !g.ok) {
      const d = document.createElement('div'); d.className = 'desc';
      d.textContent = 'Grain diagnostics unavailable' + (g && g.message ? ': ' + g.message : ' (single-node cluster or management grain not ready).');
      grainsWrap.appendChild(d); return;
    }
    const silos = g.silos || [];
    const sub = document.createElement('div'); sub.className = 'desc'; sub.style.margin = '0 0 8px';
    sub.textContent = silos.length + ' silo' + (silos.length === 1 ? '' : 's') + ' · leader: ' + (g.leader || 'none');
    grainsWrap.appendChild(sub);

    // Only show the per-silo placement column when there's more than one silo — otherwise it's the same
    // address on every row and just noise.
    const multiSilo = silos.length > 1;
    const cols = multiSilo ? ['Grain', 'Active', 'Placement'] : ['Grain', 'Active'];
    const t = document.createElement('table'); t.className = 'ld';
    const hr = document.createElement('tr'); cols.forEach(x => { const th = document.createElement('th'); th.textContent = x; hr.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(hr); t.appendChild(thead);
    const tb = document.createElement('tbody');
    (g.grains || []).forEach((row     ) => {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td'); c1.textContent = row.type; c1.title = row.fullType || '';
      const c2 = document.createElement('td'); c2.textContent = row.activations;
      tr.appendChild(c1); tr.appendChild(c2);
      if (multiSilo) {
        const c3 = document.createElement('td'); c3.style.cssText = 'color:var(--muted);font-size:12px;';
        c3.textContent = (row.silos || []).map((s     ) => shortSilo(s.silo) + ' ×' + s.count).join(', ');
        tr.appendChild(c3);
      }
      tb.appendChild(tr);
    });
    t.appendChild(tb); grainsWrap.appendChild(t);
    if (!(g.grains || []).length) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = 'No active grains.'; grainsWrap.appendChild(d); }
  };

  // A "Components" panel: which roles this node runs, MQTT transport, and whether PDU data is flowing.
  const compLine = (dotClass        , label        ) => {
    const ln = document.createElement('div'); ln.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px;';
    const dot = document.createElement('span'); dot.className = 'dot' + (dotClass ? ' ' + dotClass : '');
    const t = document.createElement('span'); t.textContent = label;
    ln.appendChild(dot); ln.appendChild(t); return ln;
  };
  const renderComponents = (b     ) => {
    comp.innerHTML = '';
    const head = document.createElement('div'); head.textContent = 'Components'; head.style.cssText = 'font-weight:600;color:var(--accent);margin-bottom:6px;'; comp.appendChild(head);
    const roles = b.roles || [];
    comp.appendChild(compLine('good', 'Roles on this node: ' + (roles.length ? roles.join(', ') : 'all')));
    comp.appendChild(compLine(b.mqttConnected ? 'good' : 'bad', 'MQTT — ' + (b.mqttConnected ? 'connected' : 'disconnected') + ' (' + (b.mqttHost || '?') + ')'));
    const ds = b.dataSources || [];
    if (!ds.length) comp.appendChild(compLine('', 'PDU data — none yet' + (roles.length && !roles.includes('worker') ? ' (waiting on a worker)' : '')));
    else ds.forEach((s     ) => comp.appendChild(compLine(s.stale ? 'bad' : 'good', 'PDU data · ' + s.instance + ' — ' + (s.stale ? 'stale, ' : '') + 'updated ' + s.ageSeconds + 's ago')));
    // Other role processes seen on the bus (split deployments only).
    (b.processes || []).forEach((p     ) => comp.appendChild(compLine(p.stale ? 'bad' : 'good', 'Process · ' + ((p.roles || []).join('+') || '?') + ' @ ' + (p.host || '?') + ' — ' + (p.stale ? 'last seen ' : 'alive, ') + p.ageSeconds + 's ago')));
  };

  const fmtUptime = (s        ) => { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; };
  const row = (k        , v     ) => { const tr = document.createElement('tr'); const a = document.createElement('td'); a.textContent = k; a.style.color = 'var(--muted)'; a.style.width = '220px'; const b = document.createElement('td'); b.textContent = (v == null || v === '') ? '—' : v; tr.appendChild(a); tr.appendChild(b); return tr; };

  const load = async () => {
    const r = await api('/api/diagnostics'); const b = r.body;
    renderComponents(b);
    info.innerHTML = '';
    info.appendChild(row('App version', b.version));
    if (b.image) info.appendChild(row('Container image', b.image));
    if (b.update) {
      // Operator update report (#210). Highlight when a newer release than the deployed one is available.
      const u = b.update;
      let txt        ;
      if (u.available) txt = 'update available → ' + (u.latest || '?') + (u.applied ? ' (auto-updated)' : '') + (u.current ? ' (on ' + u.current + ')' : '');
      else if (u.current) txt = 'up to date (' + u.current + ')';
      else txt = u.message || '—';
      const tr = row('Updates', txt);
      if (u.available && !u.applied) (tr.lastChild               ).style.color = 'var(--warn, #d08700)';
      info.appendChild(tr);
    }
    info.appendChild(row('Uptime', b.uptimeSeconds != null ? fmtUptime(b.uptimeSeconds) : null));
    info.appendChild(row('Started (UTC)', b.startedUtc));
    info.appendChild(row('MQTT', (b.mqttConnected ? 'connected' : 'disconnected') + ' — ' + b.mqttHost));
    info.appendChild(row('Last PDU poll (UTC)', b.lastPollUtc));
    if (b.emoncms && b.emoncms.enabled) {
      const s = b.emoncms.status || {};
      let txt;
      if (s.ok === true) txt = 'ok (' + b.emoncms.transport + ') — last sent ' + (s.lastSuccessUtc || '?') + (s.count ? ', ' + s.count + ' inputs' : '');
      else if (s.ok === false) txt = 'error (' + b.emoncms.transport + ') — ' + (s.lastError || 'unknown');
      else txt = 'enabled (' + b.emoncms.transport + ') — no export yet';
      info.appendChild(row('EmonCMS', txt));
    }
    info.appendChild(row('Config source', b.configSource));
    info.appendChild(row('.NET', b.dotnet));
    info.appendChild(row('OS', b.os));
    info.appendChild(row('Kubernetes', b.kubernetes ? (b.ns + ' / ' + (b.pod || '?')) : 'no'));
    try { const gr = await api('/api/grains'); renderGrains(gr.body); } catch { renderGrains(null); }
    k8sWrap.innerHTML = '';
    if (b.kubernetes) buildK8sTools(k8sWrap);
  };
  refresh.onclick = load;
  link.onclick = () => { activate(link, sec); load(); loadRestartTargets(); };
}

// Kubernetes-only: on-demand pod logs + recent events.
function buildK8sTools(container     ) {
  const tools = document.createElement('div'); tools.className = 'sec-actions';
  const logsBtn = btn('Load logs');
  const evBtn = btn('Load events');
  tools.appendChild(logsBtn); tools.appendChild(evBtn); container.appendChild(tools);
  const out = document.createElement('div'); container.appendChild(out);

  logsBtn.onclick = async () => {
    out.innerHTML = '<div class="desc">Loading logs…</div>';
    const r = await api('/api/diagnostics/logs');
    if (!r.body.ok) { out.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Failed.') + '</div>'; return; }
    const ta = document.createElement('textarea'); ta.className = 'yaml'; ta.readOnly = true; ta.value = r.body.logs || '(empty)';
    out.innerHTML = ''; out.appendChild(ta);
  };
  evBtn.onclick = async () => {
    out.innerHTML = '<div class="desc">Loading events…</div>';
    const r = await api('/api/diagnostics/events');
    if (!r.body.ok) { out.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Failed.') + '</div>'; return; }
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr'); ['Time', 'Type', 'Reason', 'Message', 'Count'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    (r.body.events || []).forEach((e     ) => { const tr = document.createElement('tr'); [e.time, e.type, e.reason, e.message, e.count].forEach(c => { const td = document.createElement('td'); td.textContent = c == null ? '' : c; tr.appendChild(td); }); tb.appendChild(tr); });
    t.appendChild(tb); out.innerHTML = ''; out.appendChild(t);
    if (!(r.body.events || []).length) out.innerHTML = '<div class="desc">No recent events.</div>';
  };
}

// ── sections/control.ts ─────────────────────────────────────────
// Direct outlet control (on/off/reboot) + group actions + label editing.

function addControlSection(nav     , sections     ) {
  const link = document.createElement('a'); link.textContent = 'PDU Control'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Outlet Control'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Turn outlets on/off, reboot, reset stats, or rename them on the PDU. Requires write actions enabled (PDU.ActionsEnabled) and PDU credentials.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());
  const filter = document.createElement('input'); filter.type = 'text'; filter.placeholder = 'Filter (device / outlet)…';
  bar.appendChild(refresh); bar.appendChild(instSel.wrap); bar.appendChild(filter); sec.appendChild(bar);
  const warn = document.createElement('div'); warn.className = 'desc'; warn.style.color = 'var(--bad)'; warn.style.display = 'none';
  warn.textContent = 'Write actions are disabled (PDU.ActionsEnabled is false). Enable it in the PDU section and restart to control outlets.';
  sec.appendChild(warn);
  const groupsWrap = document.createElement('div'); sec.appendChild(groupsWrap);
  const devicesWrap = document.createElement('div'); sec.appendChild(devicesWrap);
  const tableWrap = document.createElement('div'); sec.appendChild(tableWrap);

  let rows        = [], groups        = [], devices        = [], enabled = false;
  const actGroup = async (g     , action        ) => {
    const verb = action === 'on' ? 'turn ON' : action === 'off' ? 'turn OFF' : 'reboot';
    if (!confirm('Group "' + (g.name || g.key) + '": ' + verb + ' ALL member outlets?')) return;
    toast('Group ' + (g.name || g.key) + ': ' + action + '…', true);
    const r = await api('/api/control/group', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupKey: g.key, action, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 1000);
  };
  const setGroupLabel = (g     , value        ) => postLabel({ target: 'group', groupKey: g.key, label: (value || '').trim() }, 'Group ' + (g.name || g.key));
  const drawGroups = () => {
    groupsWrap.innerHTML = '';
    if (!groups.length) return;
    const hh = document.createElement('div'); hh.className = 'desc'; hh.style.marginTop = '4px'; hh.textContent = 'Groups — rename, see member states, and act on all member outlets:'; groupsWrap.appendChild(hh);
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Group', 'Label (on PDU)', 'Members', 'Actions'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    groups.forEach(g => {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td'); nameTd.textContent = g.name || g.key; tr.appendChild(nameTd);
      // Editable group label (written to the PDU).
      const labTd = document.createElement('td');
      const lin = document.createElement('input'); lin.type = 'text'; lin.value = g.label || ''; lin.style.width = '140px'; lin.disabled = !enabled;
      const setBtn = btn('Set'); setBtn.disabled = !enabled; setBtn.style.marginLeft = '6px';
      setBtn.onclick = () => setGroupLabel(g, lin.value);
      labTd.appendChild(lin); labTd.appendChild(setBtn); tr.appendChild(labTd);
      // Aggregate member state: a dot per member outlet + an "n/m on" summary.
      const memTd = document.createElement('td');
      const members = g.members || [];
      const onCount = members.filter((m     ) => m.state === 'on').length;
      members.forEach((m     ) => {
        const dot = document.createElement('span');
        dot.className = 'dot ' + (m.state === 'on' ? 'good' : m.state === 'off' ? 'bad' : 'muted');
        dot.style.marginRight = '3px'; dot.title = (m.name || ('#' + m.number)) + ': ' + (m.state || '?');
        memTd.appendChild(dot);
      });
      if (members.length) { const c = document.createElement('span'); c.className = 'ld-count'; c.style.marginLeft = '4px'; c.textContent = onCount + '/' + members.length + ' on'; memTd.appendChild(c); }
      else { memTd.textContent = '—'; memTd.style.color = 'var(--muted)'; }
      tr.appendChild(memTd);
      const actTd = document.createElement('td');
      [['All On', 'on'], ['All Off', 'off'], ['Reboot All', 'reboot']].forEach(([lab, a]) => {
        const b = btn(lab, a !== 'on' ? 'danger' : ''); b.disabled = !enabled; b.style.marginRight = '6px'; b.onclick = () => actGroup(g, a); actTd.appendChild(b);
      });
      tr.appendChild(actTd); tb.appendChild(tr);
    });
    t.appendChild(tb); groupsWrap.appendChild(t);
  };
  const act = async (o     , action        ) => {
    if (action === 'off' && !confirm('Turn OFF outlet ' + o.number + ' (' + o.name + ')?')) return;
    if (action === 'reboot' && !confirm('Reboot outlet ' + o.number + ' (' + o.name + ')? Connected equipment will lose power briefly.')) return;
    if (action === 'resetstats' && !confirm('Reset statistics for outlet ' + o.number + ' (' + o.name + ')?')) return;
    toast('Outlet ' + o.number + ': ' + action + '…', true);
    const r = await api('/api/control/outlet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: o.deviceId, index: o.index, action, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 800); // let the PDU apply, then re-read state
  };
  const postLabel = async (payload     , desc        ) => {
    toast(desc + ': set label…', true);
    const r = await api('/api/control/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 800);
  };
  const setLabel = (o     , value        ) => postLabel({ deviceId: o.deviceId, target: 'outlet', index: o.index, label: (value || '').trim() }, 'Outlet ' + o.number);
  const drawDevices = () => {
    devicesWrap.innerHTML = '';
    if (!devices.length) return;
    const hh = document.createElement('div'); hh.className = 'desc'; hh.style.marginTop = '4px';
    hh.textContent = 'PDUs & circuits — labels are written to the PDU:'; devicesWrap.appendChild(hh);
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Type', 'Name', 'Label (on PDU)'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    const labelRow = (kind        , name        , current        , payload     ) => {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td'); td0.textContent = kind; tr.appendChild(td0);
      const td1 = document.createElement('td'); td1.textContent = name || ''; tr.appendChild(td1);
      const td2 = document.createElement('td');
      const lin = document.createElement('input'); lin.type = 'text'; lin.value = current || ''; lin.style.width = '150px'; lin.disabled = !enabled;
      const setBtn = btn('Set'); setBtn.disabled = !enabled; setBtn.style.marginLeft = '6px';
      setBtn.onclick = () => postLabel(Object.assign({}, payload, { label: (lin.value || '').trim() }), kind + ' ' + (name || ''));
      td2.appendChild(lin); td2.appendChild(setBtn); tr.appendChild(td2);
      tb.appendChild(tr);
    };
    devices.forEach(d => {
      labelRow('PDU', d.name, d.label, { deviceId: d.deviceId, target: 'device' });
      (d.circuits || []).forEach((c     ) => labelRow('Circuit', c.name, c.label, { deviceId: d.deviceId, target: 'entity', entityKey: c.key }));
    });
    t.appendChild(tb); devicesWrap.appendChild(t);
  };
  const draw = () => {
    const f = filter.value.trim().toLowerCase();
    const shown = f ? rows.filter(r => (r.device + ' ' + r.name + ' ' + r.number).toLowerCase().includes(f)) : rows;
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Device', 'Outlet', 'Label (on PDU)', 'State', 'Actions'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    shown.forEach(o => {
      const tr = document.createElement('tr');
      const tdDev = document.createElement('td'); tdDev.textContent = o.device; tr.appendChild(tdDev);
      const tdName = document.createElement('td');
      tdName.appendChild(document.createTextNode('#' + o.number + ' — ' + (o.name || '')));
      // Current write-action config, so changes made via HA are visible here.
      const cfg = document.createElement('div'); cfg.className = 'ld-count';
      cfg.textContent = 'delays: on ' + o.onDelay + 's / off ' + o.offDelay + 's / reboot ' + o.rebootDelay + 's · power-on: ' + (o.poaAction || '?');
      tdName.appendChild(cfg); tr.appendChild(tdName);
      // Editable PDU label.
      const tdLabel = document.createElement('td');
      const lin = document.createElement('input'); lin.type = 'text'; lin.value = o.label || ''; lin.style.width = '150px'; lin.disabled = !enabled;
      const setBtn = btn('Set'); setBtn.disabled = !enabled; setBtn.style.marginLeft = '6px';
      setBtn.onclick = () => setLabel(o, lin.value);
      tdLabel.appendChild(lin); tdLabel.appendChild(setBtn);
      // Reset only shows when a label is actually set; clears it back to the PDU default.
      if ((o.label || '').trim()) {
        const resetBtn = btn('Reset', 'danger'); resetBtn.disabled = !enabled; resetBtn.style.marginLeft = '4px';
        resetBtn.onclick = () => { if (confirm('Clear the label for outlet ' + o.number + '?')) setLabel(o, ''); };
        tdLabel.appendChild(resetBtn);
      }
      tr.appendChild(tdLabel);
      const tdState = document.createElement('td');
      const dot = document.createElement('span'); dot.className = 'dot ' + (o.state === 'on' ? 'good' : 'bad'); tdState.appendChild(dot);
      tdState.appendChild(document.createTextNode(o.state || '?')); tr.appendChild(tdState);
      const tdAct = document.createElement('td');
      [['On', 'on'], ['Off', 'off'], ['Reboot', 'reboot'], ['Reset Stats', 'resetstats']].forEach(([lab, a]) => {
        const b = btn(lab, a === 'off' ? 'danger' : ''); b.disabled = !enabled; b.style.marginRight = '6px'; b.onclick = () => act(o, a); tdAct.appendChild(b);
      });
      tr.appendChild(tdAct); tb.appendChild(tr);
    });
    t.appendChild(tb); tableWrap.innerHTML = ''; tableWrap.appendChild(t);
  };
  const load = async () => {
    const r = await api(withInstance('/api/control/outlets', instSel));
    if (!r.body.ok) { tableWrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load outlets.') + '</div>'; return; }
    rows = r.body.outlets || []; groups = r.body.groups || []; devices = r.body.devices || []; enabled = !!r.body.actionsEnabled;
    warn.style.display = enabled ? 'none' : 'block'; drawGroups(); drawDevices(); draw();
  };
  refresh.onclick = load; filter.oninput = draw;
  link.onclick = () => { activate(link, sec); load(); };
}

// ── sections/livedata.ts ────────────────────────────────────────
// A read-only view of the current readings being pulled from the PDU(s).

function addLiveDataSection(nav     , sections     ) {
  const link = document.createElement('a'); link.textContent = 'Live Data'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Live Data'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc'; d.textContent = 'Current measurements pulled from the PDU(s) on each poll.'; sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const viewSel = document.createElement('select');
  [['grouped', 'Grouped (by outlet)'], ['flat', 'Flat (one row per reading)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; viewSel.appendChild(o); });
  const filter = document.createElement('input'); filter.type = 'text'; filter.placeholder = 'Filter (device / outlet / measurement)…';
  const autoLab = document.createElement('label'); const auto = document.createElement('input'); auto.type = 'checkbox';
  autoLab.appendChild(auto); autoLab.appendChild(document.createTextNode('Auto-refresh (5s)'));
  const count = document.createElement('span'); count.className = 'ld-count';
  const instSel = instanceSelector(() => load());
  bar.appendChild(refresh); bar.appendChild(instSel.wrap); bar.appendChild(viewSel); bar.appendChild(filter); bar.appendChild(autoLab); bar.appendChild(count);
  sec.appendChild(bar);
  const tableWrap = document.createElement('div'); sec.appendChild(tableWrap);
  const groupsWrap = document.createElement('div'); sec.appendChild(groupsWrap);

  let body      = { entities: [], types: [], units: {}, readings: [], groups: [] }, timer      = null;

  // Pivoted: one row per outlet/entity, a column per measurement type, grouped by device.
  const drawGrouped = () => {
    const f = filter.value.trim().toLowerCase();
    const types = body.types || [];
    const ents = (body.entities || []).filter((e     ) => !f || (e.device + ' ' + e.source + ' ' + types.join(' ')).toLowerCase().includes(f));
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    const cols = ['Outlet / entity', 'State', ...types.map((ty        ) => ty + (body.units[ty] ? ' (' + body.units[ty] + ')' : ''))];
    cols.forEach((x        , i        ) => { const th = document.createElement('th'); th.textContent = x; if (i >= 2) th.className = 'num'; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    let lastDevice      = null;
    ents.forEach((e     ) => {
      if (e.device !== lastDevice) {
        lastDevice = e.device;
        const dr = document.createElement('tr'); const dtd = document.createElement('td'); dtd.colSpan = cols.length;
        dtd.textContent = e.device; dtd.style.cssText = 'font-weight:600;background:var(--panel);color:var(--accent)';
        dr.appendChild(dtd); tb.appendChild(dr);
      }
      const tr = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = (e.number ? '#' + e.number + ' ' : '') + (e.source || ''); tr.appendChild(name);
      const st = document.createElement('td');
      if (e.kind === 'outlet' && e.state) { const dot = document.createElement('span'); dot.className = 'dot ' + (e.state === 'on' ? 'good' : 'bad'); st.appendChild(dot); st.appendChild(document.createTextNode(e.state)); }
      else { st.textContent = '—'; st.style.color = 'var(--muted)'; }
      tr.appendChild(st);
      types.forEach((ty        ) => { const td = document.createElement('td'); td.className = 'num'; const v = (e.values || {})[ty]; td.textContent = (v == null) ? '' : formatNum(v); tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); tableWrap.innerHTML = ''; tableWrap.appendChild(t);
  };

  const drawFlat = () => {
    const f = filter.value.trim().toLowerCase();
    const rows = (body.readings || []).filter((r     ) => !f || (r.device + ' ' + r.source + ' ' + r.type).toLowerCase().includes(f));
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Device', 'Outlet / entity', 'Measurement', 'Value', 'Units'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    rows.forEach((r     ) => {
      const tr = document.createElement('tr');
      [r.device, r.source, r.type, formatNum(r.value), r.units || ''].forEach((c, i) => { const td = document.createElement('td'); if (i === 3) td.className = 'num'; td.textContent = c; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); tableWrap.innerHTML = ''; tableWrap.appendChild(t);
  };

  // OneView group rollups — one row per group, a column per measurement type showing the group
  // total (Sum, falling back to Avg), flanked by Min/Max columns for types whose members vary.
  const drawGroupRollups = () => {
    groupsWrap.innerHTML = '';
    const gs = body.groups || [];
    if (!gs.length) return;
    const f = filter.value.trim().toLowerCase();
    const shown = gs.filter((g     ) => !f || (g.name || '').toLowerCase().includes(f));
    if (!shown.length) return;
    // Union of measurement types (+ units) across all groups, for stable columns. A type whose members
    // vary gets Min/Max columns flanking its total (e.g. Min | realPower (W) | Max).
    const types           = []; const units      = {}; const spread      = {};
    gs.forEach((g     ) => (g.measurements || []).forEach((m     ) => {
      if (!types.includes(m.type)) types.push(m.type);
      if (m.units && !units[m.type]) units[m.type] = m.units;
      if (m.min != null && m.max != null) spread[m.type] = true;
    }));
    types.sort();
    // Flatten types into ordered columns.
    const cols        = [];
    types.forEach(ty => {
      if (spread[ty]) cols.push({ ty, kind: 'min', label: 'Min' });
      cols.push({ ty, kind: 'val', label: ty + (units[ty] ? ' (' + units[ty] + ')' : '') });
      if (spread[ty]) cols.push({ ty, kind: 'max', label: 'Max' });
    });
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['OneView group', ...cols.map(c => c.label)].forEach((x, i) => { const th = document.createElement('th'); th.textContent = x; if (i >= 1) th.className = 'num'; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    shown.forEach((g     ) => {
      const byType      = {}; (g.measurements || []).forEach((m     ) => byType[m.type] = m);
      const tr = document.createElement('tr');
      const gtd = document.createElement('td'); gtd.textContent = g.name; gtd.style.fontWeight = '600'; tr.appendChild(gtd);
      cols.forEach(c => {
        const td = document.createElement('td'); td.className = 'num';
        const m = byType[c.ty];
        if (m) {
          const v = c.kind === 'min' ? m.min : c.kind === 'max' ? m.max : (m.sum != null ? m.sum : m.avg);
          td.textContent = (v == null) ? '' : formatNum(v);
          if (c.kind === 'val' && m.avg != null) td.title = c.ty + ' avg ' + formatNum(m.avg);
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    const hh = document.createElement('div'); hh.className = 'desc'; hh.style.marginTop = '12px'; hh.textContent = 'OneView groups (rollups — group totals, with per-member Min/Max):'; groupsWrap.appendChild(hh);
    t.appendChild(tb); groupsWrap.appendChild(t);
  };
  const draw = () => { (viewSel.value === 'flat' ? drawFlat : drawGrouped)(); drawGroupRollups(); };
  const load = async () => {
    const r = await api(withInstance('/api/livedata', instSel));
    if (!r.body.ok) { tableWrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load live data.') + '</div>'; groupsWrap.innerHTML = ''; count.textContent = ''; return; }
    body = r.body;
    count.textContent = (body.entities || []).length + ' outlets/entities · ' + (body.readings || []).length + ' readings · ' + (body.groups || []).length + ' groups';
    draw();
  };
  refresh.onclick = load;
  filter.oninput = draw;
  viewSel.onchange = draw;
  auto.onchange = () => {
    clearInterval(timer);
    if (auto.checked) timer = setInterval(() => {
      // Stop polling the PDU once the user navigates away from this tab.
      if (!sec.classList.contains('active')) { clearInterval(timer); auto.checked = false; return; }
      load();
    }, 5000);
  };
  link.onclick = () => { activate(link, sec); load(); };
}

// ── sections/flow.ts ────────────────────────────────────────────
// Energy Flow: a read-only Sankey + the layered arrow-graph hierarchy editor.

// Metrics a live source can supply: [stored key (matches PDU Measurement.Type), friendly label, canonical
// unit, selectable input units]. The key stays the PDU vocabulary so live values roll up with outlets; the
// UI shows the friendly name and a unit picker. Mirrors EnergyFlowSource.Metric + FlowUnits (Core).
const METRICS                                       = [
  ['realpower', 'Power', 'W', ['W', 'kW', 'MW']],
  ['apparentpower', 'Apparent power', 'VA', ['VA', 'kVA']],
  ['energy', 'Energy', 'kWh', ['Wh', 'kWh', 'MWh']],
  ['current', 'Current', 'A', ['A', 'mA']],
  ['voltage', 'Voltage', 'V', ['mV', 'V', 'kV']],
  ['frequency', 'Frequency', 'Hz', ['Hz']],
  ['powerfactor', 'Power factor', '', ['']],
];
const SOURCE_METRICS = METRICS.map(m => m[0]);
const metricMeta = (key         ) => METRICS.find(m => m[0] === key) || METRICS[0];
const metricLabel = (key         ) => metricMeta(key)[1];

// What a virtual node represents — mirrors [AllowedValues] on EnergyFlowNode.Kind. Each kind offers only
// the metrics that make sense for it (a battery has no frequency); 'battery' also gets a storage field.
const NODE_KINDS                               = [
  ['node', 'Virtual node', SOURCE_METRICS],
  ['panel', 'Electrical panel', ['realpower', 'apparentpower', 'current', 'voltage', 'energy', 'powerfactor']],
  ['inverter', 'Inverter', SOURCE_METRICS],
  ['battery', 'Battery', ['realpower', 'energy', 'current', 'voltage']],
  ['solar', 'Solar / PV', ['realpower', 'energy', 'current', 'voltage']],
  ['grid', 'Grid', SOURCE_METRICS],
  ['load', 'Load', ['realpower', 'apparentpower', 'energy', 'current', 'voltage', 'powerfactor']],
];
const kindMeta = (kind         ) => NODE_KINDS.find(k => k[0] === (kind || 'node')) || NODE_KINDS[0];

// Source binding types — mirrors [AllowedValues] on EnergyFlowSource.Type. Each type renders its own fields
// in the two source columns; adding an ingest is another entry here plus a branch in the row renderer.
const SOURCE_TYPES                     = [['mqtt', 'MQTT topic'], ['modbus', 'Modbus TCP']];

// Metrics whose sign carries direction, so inverting one is meaningful (export vs import, charge vs discharge).
const SIGNED_METRICS = ['realpower', 'apparentpower', 'current'];

// Why a "Current" cell can sit empty — the thing every new binding trips over.
const LIVE_HINT = 'Live value from the running ingest. It appears when the source next reports: an MQTT binding when the publisher sends, a Modbus one on the worker’s next poll — and a new or edited binding is not read at all until you Save. Nothing here is missing because the page needs reloading.';
const MODBUS_REGISTER_TYPES = ['holding', 'input'];
const MODBUS_DATATYPES = ['uint16', 'int16', 'uint32', 'int32', 'float32'];
const MODBUS_WORDORDERS = ['big', 'little'];

// How an unmeasured node is valued — mirrors [AllowedValues] on EnergyFlowNode.Mode. A live/static value
// always wins; this only governs nodes the graph would otherwise infer. 'None' leads because it's what a new
// node gets: a node you haven't measured yet should read as nothing, not as an inferred figure.
const NODE_MODES                             = [
  ['none', 'None (nothing inferred)', 'Never inferred — contributes nothing unless it has a real value or children, so an unmeasured node simply drops out instead of showing a fabricated figure. The default for a new node.'],
  ['auto', 'Auto (aggregate / share)', 'Sums its children, and as a feeder takes a share of whatever load measured siblings don’t cover. Sizes the node from what’s left over, so it always shows something.'],
  ['static', 'Static (fixed value)', 'A fixed leaf valued at the number you enter (still superseded by a bound live source). Reveals the Fixed value field.'],
  ['residual', 'Residual (untracked feeder)', 'The designated absorber on the feeder side: carries the demand still needed after every measured feeder has supplied its part.'],
  ['untracked', 'Untracked (child of a measured parent)', 'Place under a parent that has a measured total (a bound source or fixed value): shows the slice of that total its tracked siblings don’t account for. Contributes nothing if the parent has no measured total.'],
];

// --- Browsing what's out there: MQTT topics, and a Modbus device's registers ----------------------
//
// The topic index behind these only exists while we're asking for it — every call renews a short lease and
// the broker subscription is dropped when nobody is browsing (see ITopicIndexGrain). So autocomplete costs a
// subscription while this editor is open and nothing at all afterwards; there's no background indexer.

let pickerSeq = 0;

/// A modal panel over the page. Returns the body to fill; closes on the button, the backdrop, or Escape.
function overlay(title        )                                   {
  const back = el('div', { style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.55)', zIndex: '50', display: 'flex', alignItems: 'center', justifyContent: 'center' } });
  const panel = el('div', { style: { background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: '8px', padding: '14px', width: 'min(860px, 92vw)', maxHeight: '80vh', overflow: 'auto' } });
  const head = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } });
  head.appendChild(el('h4', { text: title, style: { margin: '0', fontSize: '14px' } }));
  const x = btn('Close');
  head.appendChild(x);
  const body = el('div');
  panel.append(head, body);
  back.appendChild(panel);
  document.body.appendChild(back);

  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e     ) => { if (e.key === 'Escape') close(); };
  x.onclick = close;
  back.onclick = (e     ) => { if (e.target === back) close(); };
  document.addEventListener('keydown', onKey);
  return { body, close };
}

async function fetchTopics(q        , limit = 50)               {
  const r = await api(`/api/mqtt/topics?q=${encodeURIComponent(q || '')}&limit=${limit}`);
  return (r.body && r.body.ok) ? r.body : { topics: [], listening: false, indexed: 0 };
}

async function fetchTopicDetail(topic        )                      {
  if (!topic) return null;
  const r = await api(`/api/mqtt/topic?topic=${encodeURIComponent(topic)}`);
  return (r.body && r.body.ok) ? r.body : null;
}

/// Inline autocomplete for a topic input: a datalist kept in step with what you've typed.
function topicSuggester(input     , onExactPick            ) {
  const list = el('datalist', { id: 'topics-' + (++pickerSeq) });
  input.setAttribute('list', list.id);
  let timer      = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const body = await fetchTopics(input.value.trim());
      list.innerHTML = '';
      (body.topics || []).forEach((t     ) => list.appendChild(el('option', { value: t.topic })));
      // Picking from the dropdown fires 'input', not 'change', so treat an exact hit as a choice.
      if ((body.topics || []).some((t     ) => t.topic === input.value.trim())) onExactPick();
    }, 250);
  });
  return { list };
}

/// Inline autocomplete for the JSON field, read from the chosen topic's own payload.
function jsonFieldSuggester(input     , topicOf              ) {
  const list = el('datalist', { id: 'fields-' + (++pickerSeq) });
  input.setAttribute('list', list.id);
  const fill = async () => {
    const detail = await fetchTopicDetail(topicOf());
    list.innerHTML = '';
    ((detail && detail.fields) || []).forEach((f     ) => list.appendChild(el('option', { value: f.field })));
  };
  input.addEventListener('focus', fill);
  return list;
}

/// Fill in what the payload tells us about a freshly chosen topic — without overwriting deliberate choices.
async function applyTopicHint(src     , topic        , fieldIn     , rerender            ) {
  const detail = await fetchTopicDetail(topic);
  if (!detail) return;

  const notes           = [];
  // Only infer where the user hasn't already decided: an untouched binding still reads 'realpower'.
  if (detail.metric && (!src.Metric || src.Metric === 'realpower') && detail.metric !== src.Metric) {
    src.Metric = detail.metric; src.Unit = undefined; notes.push(metricLabel(detail.metric));
  }
  if (detail.unit && !src.Unit && detail.unit !== metricMeta(src.Metric || 'realpower')[2]) {
    src.Unit = detail.unit; notes.push(detail.unit);
  }
  if (detail.isJson && !src.JsonField && (detail.fields || []).length === 1) {
    src.JsonField = detail.fields[0].field;
    if (fieldIn) fieldIn.value = src.JsonField;
    notes.push('field ' + src.JsonField);
  }

  const sample = detail.value != null ? `${formatNum(detail.value)}` : (detail.payload || '').slice(0, 40);
  toast(notes.length ? `Read ${sample} — set ${notes.join(', ')}.` : `Last value: ${sample}`, true);
  if (notes.length) rerender();
}

/// The topic browser: search what's on the broker, see each topic's last value, click to bind it.
function openTopicPicker(current        , onPick                         ) {
  const { body, close } = overlay('Browse broker topics');
  body.appendChild(el('div', { class: 'desc', text: 'Live topics seen on the broker while this window is open. Nothing is indexed in the background — the subscription starts when you browse and stops when you stop.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const search = el('input', { type: 'search', value: current || '', placeholder: 'filter topics…', style: { width: '320px' } })                    ;
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(search, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Topic', 'Last value', 'Looks like', ''].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const load = async () => {
    const b = await fetchTopics(search.value.trim(), 100);
    tbody.innerHTML = '';
    status.textContent = b.listening
      ? `${(b.topics || []).length} shown · ${b.indexed}/${b.capacity} indexed`
      : 'waiting for the broker subscription to come up…';
    (b.topics || []).forEach((t     ) => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('code', { text: t.topic })));
      tr.appendChild(el('td', { class: 'num', text: t.value != null ? formatNum(t.value) + (t.unit ? ' ' + t.unit : '') : (t.payload || '').slice(0, 48) }));
      tr.appendChild(el('td', { text: t.isJson ? `JSON · ${(t.fields || []).length} field(s)` : (t.metric ? metricLabel(t.metric) : '—') }));
      const use = btn('Use', 'primary');
      use.onclick = () => { onPick(t.topic); close(); };
      tr.appendChild(el('td', {}, use));
      tbody.appendChild(tr);
    });
  };

  let timer      = null;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  load();
  // Keep the index's lease alive (and the list fresh) for as long as the window is open.
  const poll = setInterval(() => { if (!document.body.contains(tbl)) { clearInterval(poll); return; } load(); }, 5000);
}

/// The Modbus explorer: read a block of registers off the device and pick the one that looks right.
function openModbusExplorer(src     , onPick            ) {
  const conns        = (state.data?.Modbus?.Connections) || [];
  const conn = conns.find(c => c.Id === src.Connection);
  const { body } = overlay('Modbus explorer' + (conn ? ` · ${conn.Name || conn.Id}` : ''));

  if (!conn) {
    body.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'Pick a Modbus connection for this binding first (they are defined in the Modbus section).' }));
    return;
  }

  body.appendChild(el('div', { class: 'desc', text: 'One read per click — a gateway usually accepts a single client, and the worker is already polling it. Each register is decoded every way that makes sense; click the value that matches what the device should be reporting.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const startIn = el('input', { type: 'number', value: src.Register ?? 0, title: 'First register', style: { width: '90px' } })                    ;
  const countIn = el('input', { type: 'number', value: 32, title: 'How many', style: { width: '70px' } })                    ;
  const bankSel = el('select', { style: { width: 'auto' } })                     ;
  MODBUS_REGISTER_TYPES.forEach(t => bankSel.appendChild(el('option', { value: t, text: t })));
  bankSel.value = src.RegisterType || 'holding';
  const read = btn('Read', 'primary');
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(startIn, countIn, bankSel, read, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Register', 'uint16', 'int16', 'uint32', 'float32'].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const pick = (register        , dataType        ) => {
    src.Register = register;
    src.RegisterType = bankSel.value === 'holding' ? undefined : bankSel.value;
    src.DataType = dataType === 'uint16' ? undefined : dataType;
    toast(`Bound register ${register} as ${dataType}.`, true);
    onPick();
  };

  const cell = (row     , key        ) => {
    const td = el('td', { class: 'num' });
    if (row[key] == null) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
    const link = el('span', { text: formatNum(row[key]), style: { cursor: 'pointer', color: 'var(--accent, #4f8cff)' }, title: `Use register ${row.register} as ${key}` });
    link.onclick = () => pick(row.register, key);
    td.appendChild(link);
    return td;
  };

  read.onclick = async () => {
    status.textContent = 'reading…';
    const r = await api('/api/modbus/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Host: conn.Host, Port: conn.Port, UnitId: conn.UnitId, Framing: conn.Framing, TimeoutMs: conn.TimeoutMs,
        Start: parseInt(startIn.value) || 0, Count: parseInt(countIn.value) || 32, RegisterType: bankSel.value,
      }),
    });
    status.textContent = (r.body && r.body.message) || (r.body?.ok ? '' : 'read failed');
    status.style.color = r.body?.ok ? 'var(--muted)' : 'var(--bad)';
    tbody.innerHTML = '';
    ((r.body && r.body.rows) || []).forEach((row     ) => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('code', { text: String(row.register) })));
      tr.append(cell(row, 'uint16'), cell(row, 'int16'), cell(row, 'uint32'), cell(row, 'float32'));
      tbody.appendChild(tr);
    });
  };
  read.onclick(null);
}

/// Rename a node and carry its wiring with it. The id is the node's identity everywhere — links, the legacy
/// Parents map, and every downstream path derived from it — so this rewrites the references in the config and
/// is honest about the ones it can't reach.
function openRenameDialog(node     , flow     , existingIds             , onRenamed                      ) {
  const { body, close } = overlay(`Rename ${node.Label || node.Id}`);
  const links        = ensure(flow, 'Links', []);
  const parents      = ensure(flow, 'Parents', {});
  const wired = links.filter(l => l.From === node.Id || l.To === node.Id).length
    + Object.entries(parents).filter(([c, p]) => c === node.Id || p === node.Id).length;

  body.appendChild(el('div', { class: 'desc', text: `Its ${wired} wiring reference(s) move with it automatically.` }));

  // The id is what every integration keys off, so a rename is a rename downstream too — say so plainly
  // rather than letting someone discover it when their history stops.
  const warn = el('div', {
    class: 'desc',
    style: { border: '1px solid var(--bad)', borderRadius: '6px', padding: '8px', margin: '8px 0', color: 'var(--fg)' },
  });
  warn.appendChild(el('b', { text: 'This changes how the node appears downstream.' }));
  warn.appendChild(el('div', { text: 'The MQTT topic, the Home Assistant entity/unique id, the Prometheus series and the EmonCMS feed are all derived from the id. Anything already recording under the old name — HA history, an energy dashboard entry, a Grafana query, an emonCMS feed — will see this as a new thing and stop following the old one. Rename deliberately, and fix those up afterwards.' }));
  body.appendChild(warn);

  const row = el('div', { class: 'ld-toolbar' });
  const idIn = el('input', { type: 'text', value: node.Id, style: { width: '260px' } })                    ;
  const apply = btn('Rename', 'primary');
  const err = el('span', { class: 'desc', style: { margin: '0 0 0 8px', color: 'var(--bad)' } });
  row.append(idIn, apply, err);
  body.appendChild(row);

  apply.onclick = () => {
    const next = (idIn.value || '').trim();
    if (!next) { err.textContent = 'An id is required.'; return; }
    if (next === node.Id) { close(); return; }
    if (existingIds.has(next)) { err.textContent = 'That id already exists.'; return; }

    const from = node.Id;
    node.Id = next;
    links.forEach(l => { if (l.From === from) l.From = next; if (l.To === from) l.To = next; });
    // The legacy Parents map keys by child id and stores the parent id, so both sides can name this node.
    Object.keys(parents).forEach(child => {
      if (parents[child] === from) parents[child] = next;
      if (child === from) { parents[next] = parents[child]; delete parents[child]; }
    });

    toast(`Renamed ${from} → ${next}; ${wired} reference(s) updated. Save to apply.`, true);
    close();
    onRenamed(next);
  };
  idIn.onkeydown = (e     ) => { if (e.key === 'Enter') apply.onclick(null); };
}

// A labelled field (label above a control) for the node editor's form grid.
function field(labelText        , control             , hint         ) {
  const f = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } });
  f.appendChild(el('label', { text: labelText, style: { fontSize: '11px', color: 'var(--muted)' } }));
  f.appendChild(control);
  if (hint) f.appendChild(el('div', { class: 'desc', text: hint, style: { margin: '0', fontSize: '11px' } }));
  return f;
}

// Per-node editor (#129): name, kind, mode, fixed value, a battery's storage, and the live value bindings —
// one row per metric, each carrying a Type (MQTT today) and its transport fields, all editable in place
// (including the topic, which the old flat table couldn't change).
function renderNodeEditor(node     , links       , cand                  , rerender                           ) {
  const meta = kindMeta(node.Kind);
  const allowed = meta[2];
  const box = el('div', { style: { margin: '10px 0 4px', padding: '14px', border: '1px solid var(--accent, #4f8cff)', borderRadius: '8px', background: 'var(--panel2)' } });

  const header = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } });
  header.appendChild(el('h4', { text: `Editing ${node.Label || node.Id}`, style: { margin: '0', fontSize: '14px' } }));
  const close = btn('Close'); close.onclick = () => rerender(true);
  header.appendChild(close);
  box.appendChild(header);

  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '12px' } });

  const labIn = el('input', { type: 'text', value: node.Label || '', placeholder: node.Id });
  labIn.onchange = () => { node.Label = labIn.value.trim() || undefined; };
  grid.appendChild(field('Name', labIn));

  const kindSel = el('select');
  NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
  kindSel.value = node.Kind || 'node';
  kindSel.onchange = () => { node.Kind = kindSel.value === 'node' ? undefined : kindSel.value; rerender(); };
  grid.appendChild(field('Kind', kindSel));

  const modeSel = el('select');
  NODE_MODES.forEach(([v, label, desc]) => { const o = el('option', { value: v, text: label }); o.title = desc; modeSel.appendChild(o); });
  modeSel.value = node.Mode || 'auto';
  modeSel.onchange = () => {
    node.Mode = modeSel.value === 'auto' ? undefined : modeSel.value;
    if (node.Mode !== 'static') node.Value = undefined;  // a fixed value only belongs to a static node
    rerender();  // toggle the Fixed value field
  };
  grid.appendChild(field('Mode', modeSel, 'How it’s valued with no measurement.'));

  // The fixed value only makes sense for a static leaf — show it only in that mode.
  if ((node.Mode || 'auto') === 'static') {
    const valIn = el('input', { type: 'number', step: 'any', value: node.Value ?? '', placeholder: '—' });
    valIn.onchange = () => { const v = +valIn.value; node.Value = (valIn.value !== '' && !isNaN(v)) ? v : undefined; };
    grid.appendChild(field('Fixed value', valIn, 'Used unless a bound source reports.'));
  }

  if ((node.Kind || 'node') === 'battery') {
    const stoIn = el('input', { type: 'number', step: 'any', value: node.StorageKwh ?? '', placeholder: 'kWh' });
    stoIn.onchange = () => { const v = +stoIn.value; node.StorageKwh = (stoIn.value !== '' && !isNaN(v)) ? v : undefined; };
    grid.appendChild(field('Storage (kWh)', stoIn));
  }
  box.appendChild(grid);

  // --- Live value bindings ---
  box.appendChild(el('h5', { text: 'Live value bindings', style: { margin: '6px 0 2px', fontSize: '12px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'Bind a metric to a live source — an MQTT topic, or a register on a Modbus TCP connection (set those up in the Modbus section). One binding per metric drives that metric’s power/energy/… roll-up; a fresh reading supersedes the fixed value. Takes effect without a restart once saved — the Current column then fills in on the source’s next message or poll, no page reload needed.', style: { margin: '0 0 8px' } }));

  const sources        = ensure(node, 'Sources', []);
  if (sources.length) {
    const tbl = el('table', { class: 'ld' });
    const head = el('tr');
    const colHint      = {
      Invert: 'Flip the sign of a power or current reading — for a source that publishes export/discharge as positive when your hierarchy wants it negative (or vice versa).',
      Current: LIVE_HINT,
    };
    ['Type', 'Metric', 'Unit', 'Source', 'Details', 'Scale', 'Invert', 'Current', ''].forEach(h => {
      const th = el('th', { text: h });
      if (colHint[h]) th.title = colHint[h];
      head.appendChild(th);
    });
    tbl.appendChild(el('thead', {}, head));
    const body = el('tbody');
    // Cells that a live probe fills in, keyed to their source so a refresh can update them in place.
    const liveCells                            = [];
    sources.forEach((src     ) => {
      const tr = el('tr');

      const typeSel = el('select', { style: { width: 'auto' } });
      SOURCE_TYPES.forEach(([v, label]) => typeSel.appendChild(el('option', { value: v, text: label })));
      typeSel.value = src.Type || 'mqtt';
      typeSel.onchange = () => { src.Type = typeSel.value; rerender(); };  // the Source/Details fields differ per type
      tr.appendChild(el('td', {}, typeSel));

      // Offer this kind's metrics (friendly labels), but keep an already-chosen one even if the kind wouldn't
      // list it. Changing the metric resets the unit (units differ per metric) and re-renders the row.
      const metricSel = el('select', { style: { width: 'auto' } });
      const metric = src.Metric || 'realpower';
      const opts = allowed.includes(metric) ? allowed : [metric, ...allowed];
      opts.forEach((m        ) => metricSel.appendChild(el('option', { value: m, text: metricLabel(m) })));
      metricSel.value = metric;
      metricSel.onchange = () => { src.Metric = metricSel.value; src.Unit = undefined; rerender(); };
      tr.appendChild(el('td', {}, metricSel));

      // Input unit → converted to the metric's canonical unit on ingest. Store only a non-canonical choice.
      const [, , canonical, units] = metricMeta(metric);
      const unitSel = el('select', { style: { width: 'auto' } });
      units.forEach((u        ) => unitSel.appendChild(el('option', { value: u, text: u || '—' })));
      unitSel.value = src.Unit || canonical;
      unitSel.disabled = units.length <= 1;
      unitSel.onchange = () => { src.Unit = unitSel.value === canonical ? undefined : unitSel.value; };
      tr.appendChild(el('td', {}, unitSel));

      // The Source + Details columns are type-specific.
      if ((src.Type || 'mqtt') === 'modbus') {
        // Source = which configured Modbus connection; Details = the register spec.
        const connections        = (state.data?.Modbus?.Connections) || [];
        const connSel = el('select', { style: { width: '160px' } });
        connSel.appendChild(el('option', { value: '', text: connections.length ? '— pick a connection —' : 'none — add one in Modbus' }));
        connections.forEach((c     ) => connSel.appendChild(el('option', { value: c.Id, text: c.Name || c.Id })));
        connSel.value = src.Connection || '';
        connSel.onchange = () => { src.Connection = connSel.value || undefined; };
        tr.appendChild(el('td', {}, connSel));

        const details = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } });
        const regIn = el('input', { type: 'number', value: src.Register ?? 0, title: 'Register address', style: { width: '80px' } });
        regIn.onchange = () => { const v = +regIn.value; src.Register = !isNaN(v) ? v : 0; };
        const regTypeSel = el('select', { title: 'Register bank', style: { width: 'auto' } });
        MODBUS_REGISTER_TYPES.forEach(t => regTypeSel.appendChild(el('option', { value: t, text: t })));
        regTypeSel.value = src.RegisterType || 'holding';
        regTypeSel.onchange = () => { src.RegisterType = regTypeSel.value === 'holding' ? undefined : regTypeSel.value; };
        const dtSel = el('select', { title: 'Data type', style: { width: 'auto' } });
        MODBUS_DATATYPES.forEach(t => dtSel.appendChild(el('option', { value: t, text: t })));
        dtSel.value = src.DataType || 'uint16';
        const woSel = el('select', { title: 'Word order (32-bit)', style: { width: 'auto' } });
        MODBUS_WORDORDERS.forEach(t => woSel.appendChild(el('option', { value: t, text: t })));
        woSel.value = src.WordOrder || 'big';
        woSel.onchange = () => { src.WordOrder = woSel.value === 'big' ? undefined : woSel.value; };
        // Word order only matters for 32-bit types; keep it enabled only then.
        const is32 = () => ['uint32', 'int32', 'float32'].includes(dtSel.value);
        woSel.disabled = !is32();
        dtSel.onchange = () => { src.DataType = dtSel.value === 'uint16' ? undefined : dtSel.value; woSel.disabled = !is32(); };

        // Rather than guessing a register from a PDF, read the device and pick the value that looks right.
        const explore = btn('Browse…');
        explore.title = 'Read a block of registers from the device and choose one.';
        explore.onclick = () => openModbusExplorer(src, rerender);

        details.append(regIn, regTypeSel, dtSel, woSel, explore);
        tr.appendChild(el('td', {}, details));
      } else {
        // Source = the topic, with autocomplete off what the broker is actually carrying, and a Browse
        // button for picking one by eye. Details = the JSON field, itself autocompleted from the payload.
        const topicCell = el('td');
        const topicIn = el('input', { type: 'text', value: src.Topic || '', placeholder: 'solar_assistant/inverter_1/pv_power/state', style: { width: '300px' } })                    ;
        const fieldIn = el('input', { type: 'text', value: src.JsonField || '', placeholder: 'JSON field (optional)', style: { width: '120px' } })                    ;

        const suggest = topicSuggester(topicIn, () => {
          src.Topic = topicIn.value.trim();
          applyTopicHint(src, topicIn.value.trim(), fieldIn, rerender);
        });
        topicIn.onchange = () => { src.Topic = topicIn.value.trim(); applyTopicHint(src, src.Topic, fieldIn, rerender); };

        const browse = btn('Browse');
        browse.title = 'Browse the topics currently on the broker and pick one.';
        browse.onclick = () => openTopicPicker(topicIn.value.trim(), picked => {
          topicIn.value = picked;
          src.Topic = picked;
          applyTopicHint(src, picked, fieldIn, rerender);
        });

        topicCell.append(topicIn, suggest.list, ' ', browse);
        tr.appendChild(topicCell);

        fieldIn.onchange = () => { src.JsonField = fieldIn.value.trim() || undefined; };
        const fieldCell = el('td');
        fieldCell.append(fieldIn, jsonFieldSuggester(fieldIn, () => src.Topic || ''));
        tr.appendChild(fieldCell);
      }

      // Scale carries the magnitude; Invert carries the sign. Kept as one number on the wire (Scale) so
      // nothing downstream has to learn a second knob — the checkbox is just its sign, spelled out.
      const scaleIn = el('input', { type: 'number', step: 'any', value: Math.abs(src.Scale ?? 1), style: { width: '80px' } });
      const setScale = (magnitude        , invert         ) => {
        const v = (invert ? -1 : 1) * (isNaN(magnitude) || magnitude === 0 ? 1 : Math.abs(magnitude));
        src.Scale = v === 1 ? undefined : v;
      };
      scaleIn.onchange = () => setScale(+scaleIn.value, (src.Scale ?? 1) < 0);
      tr.appendChild(el('td', {}, scaleIn));

      // Sign only means anything where the value has a direction — power and current, not voltage/energy.
      const invCell = el('td', { style: { textAlign: 'center' } });
      if (SIGNED_METRICS.includes(metric)) {
        const inv = el('input', { type: 'checkbox' })                    ;
        inv.checked = (src.Scale ?? 1) < 0;
        inv.title = 'Flip the sign of this reading (e.g. solar/battery power the source publishes as export).';
        inv.onchange = () => setScale(+scaleIn.value, inv.checked);
        invCell.appendChild(inv);
      } else {
        invCell.appendChild(el('span', { text: '—', style: { color: 'var(--muted)' }, title: 'Sign has no meaning for this metric.' }));
      }
      tr.appendChild(invCell);

      // Live value for every binding type: Modbus is read from the device; the rest (MQTT, future types)
      // come from the shared live cache the running ingests fill — so you can confirm a mapping reads right.
      const liveCell = el('td', { class: 'num', style: { minWidth: '90px', color: 'var(--muted)' }, text: '…' });
      liveCells.push({ src, cell: liveCell });
      tr.appendChild(liveCell);

      const rm = btn('Remove', 'danger');
      rm.onclick = () => { sources.splice(sources.indexOf(src), 1); rerender(); };
      tr.appendChild(el('td', {}, rm));
      body.appendChild(tr);
    });
    tbl.appendChild(body);
    box.appendChild(tbl);

    // Live "Current" value for every binding: Modbus is read straight from the device (works before saving);
    // MQTT and any future type come from the shared live cache the running ingests fill. Auto-refreshes.
    if (liveCells.length) {
      const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
      const setCell = (cell     , value               , err         , metric         ) => {
        if (value == null) { cell.textContent = err ? 'err' : '—'; cell.style.color = err ? 'var(--bad)' : 'var(--muted)'; cell.title = err || ('No live value yet. ' + LIVE_HINT); }
        else { const cu = metricMeta(metric)[2]; cell.textContent = `${formatNum(value)} ${cu}`.trim(); cell.style.color = 'var(--good)'; cell.title = ''; }
      };
      // A Modbus device is a shared serial resource — many gateways accept only one client at a time, and
      // the worker already polls it. So auto-refresh reads the shared live cache (no device access); only an
      // explicit "Test device read" opens its own connection, to check a binding before it's saved/polled.
      const refresh = async (probe = false) => {
        let probeMsg = '';
        if (probe) {
          const modbus = liveCells.filter(lc => (lc.src.Type || 'mqtt') === 'modbus');
          const conns        = (state.data?.Modbus?.Connections) || [];
          const byConn = new Map                                   ();
          modbus.forEach(lc => { const id = lc.src.Connection || ''; (byConn.get(id) || byConn.set(id, []).get(id) ).push(lc); });
          for (const [connId, cells] of byConn) {
            const conn = conns.find(c => c.Id === connId);
            if (!conn) { cells.forEach(lc => setCell(lc.cell, null, 'pick a connection')); probeMsg = 'Pick a Modbus connection.'; continue; }
            try {
              const r = await api('/api/modbus/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ Host: conn.Host, Port: conn.Port, UnitId: conn.UnitId, Framing: conn.Framing, TimeoutMs: conn.TimeoutMs, Items: cells.map(lc => lc.src) }) });
              if (!r.body.ok) { cells.forEach(lc => setCell(lc.cell, null, 'err')); probeMsg = r.body.message || 'probe failed'; continue; }
              const readings = r.body.readings || [];
              cells.forEach((lc, i) => setCell(lc.cell, readings[i]?.value ?? null, readings[i]?.error, lc.src.Metric));
              const firstErr = readings.find((rd     ) => rd?.error)?.error;
              if (firstErr) probeMsg = (r.body.message || '') + ' — ' + firstErr;
            } catch (e     ) { cells.forEach(lc => setCell(lc.cell, null, 'err')); probeMsg = String(e?.message || e); }
          }
        }

        // Every binding not just device-probed reads the shared live cache the running ingests fill.
        const cached = probe ? liveCells.filter(lc => (lc.src.Type || 'mqtt') !== 'modbus') : liveCells;
        if (cached.length) {
          try {
            const r = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(cached.map(lc => ({ Node: node.Id, Metric: lc.src.Metric || 'realpower' }))) });
            const vals = (r.body && r.body.values) || [];
            cached.forEach((lc, i) => setCell(lc.cell, vals[i]?.value ?? null, undefined, lc.src.Metric));
          } catch (e     ) { cached.forEach(lc => setCell(lc.cell, null, 'err')); }
        }
        status.textContent = probeMsg || `updated ${new Date().toLocaleTimeString()}`;
        status.style.color = probeMsg ? 'var(--bad)' : 'var(--muted)';
      };
      const hasModbus = liveCells.some(lc => (lc.src.Type || 'mqtt') === 'modbus');
      const refreshBtn = btn(hasModbus ? 'Test device read' : 'Refresh values');
      if (hasModbus) refreshBtn.title = 'Open a one-off connection to the device to test these bindings. Normally the worker polls it and the value shows here automatically — avoid hammering a gateway that allows only one client.';
      refreshBtn.onclick = () => refresh(true);
      box.appendChild(el('div', { class: 'ld-toolbar', style: { marginTop: '6px' } }, refreshBtn, status));
      refresh(false);
      // Self-cleaning: once this editor is replaced/closed its box leaves the DOM and the poll stops.
      const timer = setInterval(() => { if (!document.body.contains(box)) { clearInterval(timer); return; } refresh(false); }, 5000);
    }
  }

  const addBind = btn('Add binding', 'primary');
  addBind.onclick = () => {
    // Default to the first metric this kind offers that isn't bound yet, so a click rarely needs a re-pick.
    const used = new Set(sources.map((s     ) => s.Metric || 'realpower'));
    const metric = allowed.find((m        ) => !used.has(m)) || allowed[0];
    sources.push({ Type: 'mqtt', Metric: metric, Topic: '' });
    rerender();
  };
  box.appendChild(el('div', { class: 'ld-toolbar', style: { marginTop: '8px' } }, addBind));

  // --- Feeders & children (wiring) — the parent/child specification, alongside the visual Flow tab. ---
  box.appendChild(el('h5', { text: 'Feeders & children', style: { margin: '12px 0 2px', fontSize: '12px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'Which nodes feed this one, and which it feeds. The same wiring you can drag on the Flow tab.', style: { margin: '0 0 6px' } }));

  const nm = (id        ) => (cand.get(id) || {}).label || id;
  const wouldLoop = (from        , to        ) => {
    const adj      = {}; links.forEach(l => (adj[l.From] = adj[l.From] || []).push(l.To));
    const stack = [to]; const seen = new Set        ();
    while (stack.length) { const x = stack.pop() ; if (x === from) return true; if (seen.has(x)) continue; seen.add(x); (adj[x] || []).forEach((t        ) => stack.push(t)); }
    return false;
  };
  const addLink = (from        , to        ) => {
    if (from === to || links.some(l => l.From === from && l.To === to)) return;
    if (wouldLoop(from, to)) { toast('That would create a feeder loop.', false); return; }
    links.push({ From: from, To: to });
  };
  const removeLink = (from        , to        ) => { const i = links.findIndex(l => l.From === from && l.To === to); if (i >= 0) links.splice(i, 1); };
  const wireRow = (title        , current          , onAdd                     , onRemove                     ) => {
    const row = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', margin: '3px 0' } });
    row.appendChild(el('span', { class: 'desc', style: { margin: '0', minWidth: '64px' }, text: title }));
    current.forEach(other => {
      const chip = el('span', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '1px 8px', fontSize: '12px' } });
      const x = el('span', { text: '✕', style: { cursor: 'pointer', color: 'var(--bad)' } });
      x.onclick = () => { onRemove(other); rerender(); };
      chip.append(nm(other), x); row.appendChild(chip);
    });
    // The picker lists every node in the hierarchy, which on a real install is hundreds of outlets — so it
    // comes with a search box that filters it as you type (Enter takes the single match).
    const options = [...cand.keys()].filter(id => id !== node.Id && !current.includes(id)).sort((a, b) => nm(a).localeCompare(nm(b)));
    const search = el('input', { type: 'search', placeholder: 'search…', style: { width: '130px' } })                    ;
    const sel = el('select', { style: { width: 'auto' } })                     ;
    const matches = () => {
      const f = (search.value || '').trim().toLowerCase();
      return f ? options.filter(id => (id + ' ' + nm(id)).toLowerCase().includes(f)) : options;
    };
    const fill = () => {
      const m = matches();
      sel.innerHTML = '';
      sel.appendChild(el('option', { value: '', text: m.length ? `+ add… (${m.length})` : 'no match' }));
      m.forEach(id => sel.appendChild(el('option', { value: id, text: nm(id) })));
    };
    search.oninput = fill;
    search.onkeydown = (e     ) => {
      if (e.key !== 'Enter') return;
      const m = matches();
      if (m.length === 1) { onAdd(m[0]); rerender(); }
    };
    fill();
    sel.onchange = () => { if (sel.value) { onAdd(sel.value); rerender(); } };
    row.append(search, sel);
    return row;
  };
  box.appendChild(wireRow('Fed by', links.filter(l => l.To === node.Id).map(l => l.From), o => addLink(o, node.Id), o => removeLink(o, node.Id)));
  box.appendChild(wireRow('Feeds', links.filter(l => l.From === node.Id).map(l => l.To), o => addLink(node.Id, o), o => removeLink(node.Id, o)));

  return box;
}

// Bring an EnergyFlow config up to the current shape in place (idempotent) — run on load by both the Flow
// and Nodes tabs since either can be opened first: legacy single-feeder Parents → directed Links, per-node
// Mqtt → the general Sources list, and a bare Value → the explicit 'static' mode.
function migrateEnergyFlow(flow     ) {
  const links = ensure(flow, 'Links', []);
  const legacy = ensure(flow, 'Parents', {});
  if (Object.keys(legacy).length) {
    Object.entries(legacy).forEach(([child, parent]) => { if (parent && child && !links.some((l     ) => l.From === parent && l.To === child)) links.push({ From: parent, To: child }); });
    Object.keys(legacy).forEach(k => delete legacy[k]);
  }
  ensure(flow, 'Nodes', []).forEach((n     ) => {
    if (n.Mqtt && n.Mqtt.length) { n.Sources = (n.Sources || []).concat(n.Mqtt.map((s     ) => ({ Type: 'mqtt', ...s }))); delete n.Mqtt; }
    if (n.Value != null && (!n.Mode || n.Mode === 'auto')) n.Mode = 'static';
  });
}

// Save the whole config (both tabs edit the shared EnergyFlow object; either Save persists everything).
async function saveConfig(onSaved            ) {
  const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) });
  toast(r.body.message || (r.ok ? 'Saved.' : 'Save failed.'), r.ok && r.body.ok);
  if (r.ok && r.body.ok) onSaved();
}

// The candidate node universe for wiring: the built graph's nodes (pdu/outlet/…) plus the custom defs.
function flowCandidates(lastGraph     , customNodes       ) {
  const cand = new Map             ();
  (lastGraph?.nodes || []).forEach((n     ) => cand.set(n.id, { id: n.id, label: n.label, kind: n.kind }));
  customNodes.forEach((n     ) => cand.set(n.Id, { id: n.Id, label: n.Label || n.Id, kind: n.Kind || 'node', custom: true }));
  return cand;
}

// Virtual-node manager (#129): the dedicated node-configuration surface (its own Nodes tab). Each row is a
// node; Edit opens the full editor (name, kind, mode, value, bindings, feeders/children) below the table.
// Deleting a node takes its bound sources with it (they live on the node).
function renderNodeManager(flow     , customNodes       , links       , cand                  , editing                       , rerender                           ) {
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Virtual nodes', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'The custom nodes you’ve added (panels, breakers, batteries, producers, a “Total”). Click Edit to set the name, kind, how it’s valued, and bind live values from your broker.' }));

  if (!customNodes.length) {
    box.appendChild(el('div', { class: 'desc', text: 'No virtual nodes yet — add one above.' }));
    return box;
  }

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Id', 'Label', 'Kind', 'Mode', 'Value', 'Bindings', ''].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const body = el('tbody');
  customNodes.forEach((n     ) => {
    const tr = el('tr');
    if (editing.id === n.Id) tr.style.outline = '2px solid var(--accent, #4f8cff)';
    tr.appendChild(el('td', {}, el('code', { text: n.Id, style: { color: 'var(--muted)' } })));
    tr.appendChild(el('td', { text: n.Label || n.Id }));
    tr.appendChild(el('td', { text: kindMeta(n.Kind)[1] }));
    tr.appendChild(el('td', { text: n.Mode || 'auto' }));
    tr.appendChild(el('td', { class: 'num', text: n.Value ?? '—' }));
    const nb = (n.Sources || []).length;
    tr.appendChild(el('td', { text: nb ? String(nb) : '—', class: nb ? '' : 'num' }));

    const actions = el('td', { style: { whiteSpace: 'nowrap' } });
    const edit = btn(editing.id === n.Id ? 'Editing…' : 'Edit');
    edit.onclick = () => { editing.id = editing.id === n.Id ? null : n.Id; rerender(); };
    const rename = btn('Rename');
    rename.title = 'Change this node’s id, moving its wiring with it.';
    rename.onclick = () => {
      const taken = new Set        ([...cand.keys(), ...customNodes.map((x     ) => x.Id)]);
      taken.delete(n.Id);
      openRenameDialog(n, flow, taken, id => { if (editing.id === n.Id) editing.id = id; rerender(); });
    };

    // Copy: the same node under a free id, opened for renaming. Its bindings come along (that's the tedious
    // part worth copying — a second panel string, another breaker on the same meter); its wiring doesn't,
    // since the copy usually feeds somewhere else.
    const copy = btn('Copy');
    copy.title = 'Duplicate this node (kind, mode, value and bindings) under a new id — rename it, then wire it up.';
    copy.onclick = () => {
      const taken = (id        ) => customNodes.some((x     ) => x.Id === id);
      let id = `${n.Id}-copy`;
      for (let i = 2; taken(id); i++) id = `${n.Id}-copy-${i}`;
      const clone = JSON.parse(JSON.stringify(n));
      clone.Id = id;
      clone.Label = `${n.Label || n.Id} (copy)`;
      customNodes.splice(customNodes.indexOf(n) + 1, 0, clone);
      editing.id = id;
      toast(`Copied to '${id}' — rename it and set its feeders.`, true);
      rerender();
    };
    const rm = btn('Delete', 'danger');
    rm.onclick = () => {
      customNodes.splice(customNodes.indexOf(n), 1);
      for (let j = links.length - 1; j >= 0; j--) if (links[j].From === n.Id || links[j].To === n.Id) links.splice(j, 1);
      if (editing.id === n.Id) editing.id = null;
      toast(`${n.Label || n.Id} deleted.`, true);
      rerender();
    };
    actions.append(edit, ' ', rename, ' ', copy, ' ', rm);
    tr.appendChild(actions);
    body.appendChild(tr);
  });
  tbl.appendChild(body);
  box.appendChild(tbl);

  const editingNode = editing.id ? customNodes.find((n     ) => n.Id === editing.id) : null;
  if (editingNode) box.appendChild(renderNodeEditor(editingNode, links, cand, (close          ) => { if (close) editing.id = null; rerender(); }));
  return box;
}

function addFlowSection(nav     , sections     ) {
  const link = document.createElement('a'); link.textContent = 'Flow'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Energy Flow'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Live power flow (from the latest poll). Outlet→PDU is auto-derived; add upstream nodes (panels, breakers, a “Total”) and drag to set each node’s feeder to model the full hierarchy. Link width is proportional to the measurement.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());
  const count = document.createElement('span'); count.className = 'ld-count';
  bar.appendChild(refresh); bar.appendChild(instSel.wrap); bar.appendChild(count); sec.appendChild(bar);
  const wrap = document.createElement('div'); sec.appendChild(wrap);
  const treePanel = document.createElement('div'); treePanel.style.margin = '16px 0 4px'; sec.appendChild(treePanel);
  const ed      = document.createElement('div'); ed.style.marginTop = '18px'; sec.appendChild(ed);
  let lastGraph      = null;

  // The distributed node-grain roll-up (v3): each configured node's value computed by its own grain
  // (measured leaves report their source, aggregates sum their children, residuals the remainder).
  const renderTree = async () => {
    treePanel.innerHTML = '';
    const head = document.createElement('div'); head.textContent = 'Node-grain roll-up (distributed)';
    head.style.cssText = 'font-weight:600;color:var(--accent);margin:0 0 6px;'; treePanel.appendChild(head);
    let r     ; try { r = await api('/api/flow/tree'); } catch { r = { body: { ok: false } }; }
    if (!r.body || !r.body.ok) {
      const dd = document.createElement('div'); dd.className = 'desc';
      dd.textContent = 'Node tree unavailable' + (r.body && r.body.message ? ': ' + r.body.message : ' (single-node cluster or nothing provisioned yet).');
      treePanel.appendChild(dd); return;
    }
    const nodes = r.body.nodes || [];
    if (!nodes.length) {
      const dd = document.createElement('div'); dd.className = 'desc';
      dd.textContent = 'No node values yet — add energy-flow nodes and feed a source; the grains roll them up here.';
      treePanel.appendChild(dd); return;
    }
    const t = document.createElement('table'); t.className = 'ld';
    const hr = document.createElement('tr'); ['Node', 'Rolled-up values'].forEach(x => { const th = document.createElement('th'); th.textContent = x; hr.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(hr); t.appendChild(thead);
    const tb = document.createElement('tbody');
    nodes.forEach((n     ) => {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td'); c1.textContent = n.node;
      const c2 = document.createElement('td'); c2.style.cssText = 'color:var(--muted);font-size:12px;';
      c2.textContent = (n.metrics || []).map((m     ) => m.metric + ': ' + formatNum(m.value)).join(', ');
      tr.appendChild(c1); tr.appendChild(c2); tb.appendChild(tr);
    });
    t.appendChild(tb); treePanel.appendChild(t);
  };

  // Layered Sankey: columns = longest path from a root (energy flows left->right, parent->child).
  const draw = (graph     ) => {
    wrap.innerHTML = '';
    const links = (graph.links || []).slice();
    const nodes = graph.nodes || [];
    if (!links.length) { wrap.innerHTML = '<div class="desc" style="color:var(--muted)">No measured power flow to display. Define an EnergyFlow hierarchy, or check that outlets report power.</div>'; count.textContent = ''; return; }

    const units = graph.units || '';
    const incoming      = {}, outgoing      = {};
    nodes.forEach((n     ) => { incoming[n.id] = []; outgoing[n.id] = []; });
    links.forEach((l     ) => { (outgoing[l.source] = outgoing[l.source] || []).push(l); (incoming[l.target] = incoming[l.target] || []).push(l); });
    const sumv = (arr       ) => (arr || []).reduce((s, l) => s + l.value, 0);
    const nodeValue = (id        ) => Math.max(sumv(incoming[id]), sumv(outgoing[id]));

    // Column index = longest path from a root (a node with no incoming links).
    const colMemo      = {};
    const col = (id        , seen              )         => {
      if (colMemo[id] != null) return colMemo[id];
      seen = seen || new Set();
      if (seen.has(id)) return 0;
      seen.add(id);
      const ins = incoming[id] || [];
      const c = ins.length ? Math.max(...ins.map((l     ) => col(l.source, seen) + 1)) : 0;
      seen.delete(id);
      return colMemo[id] = c;
    };
    nodes.forEach((n     ) => col(n.id));
    const maxCol = Math.max(0, ...nodes.map((n     ) => colMemo[n.id]));

    const cols        = [];
    nodes.forEach((n     ) => { const c = colMemo[n.id]; (cols[c] = cols[c] || []).push(n); });

    const W = 960, padTop = 22, gap = 8, nodeW = 12, usableH = 520;
    // Labels sit to the right of each node, so reserve a right gutter for them and only a small left pad.
    const leftPad = 16, rightGutter = 232;
    const maxTotal = Math.max(1, ...cols.map(cn => cn.reduce((s        , n     ) => s + nodeValue(n.id), 0)));
    const pxPerUnit = usableH / maxTotal;
    const colX = (c        ) => leftPad + (maxCol > 0 ? c * ((W - leftPad - rightGutter - nodeW) / maxCol) : 0);

    const pos      = {};
    // Barycenter: a node's preferred y is the value-weighted mean of its (already positioned) feeders.
    const bary = (id        ) => { let w = 0, s = 0; (incoming[id] || []).forEach((l     ) => { const sp = pos[l.source]; if (sp) { s += (sp.y + sp.h / 2) * l.value; w += l.value; } }); return w ? s / w : Infinity; };
    cols.forEach((cn, c) => {
      // Roots stack by size; downstream columns follow their feeder's order (groups children, avoids crossings).
      if (c === 0) cn.sort((a     , b     ) => nodeValue(b.id) - nodeValue(a.id));
      else cn.sort((a     , b     ) => (bary(a.id) - bary(b.id)) || (nodeValue(b.id) - nodeValue(a.id)));
      let y = padTop;
      cn.forEach((n     ) => { const h = Math.max(2, nodeValue(n.id) * pxPerUnit); pos[n.id] = { x: colX(c), y, h, outOff: 0, inOff: 0 }; y += h + gap; });
    });

    // Fit the viewBox to the tallest column (stacking gaps push it past usableH), so nothing clips.
    const totalH = Math.ceil(Math.max(padTop + usableH, ...nodes.map((n     ) => pos[n.id] ? pos[n.id].y + pos[n.id].h : 0))) + padTop;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${totalH}`, width: W, height: totalH, style: 'display:block' });
    const colors = ['#49f', '#4f9', '#fa4', '#f49', '#9f4', '#4ff', '#f94', '#a9f'];

    // Ribbons (filled bezier bands), stacked on each node edge by target order.
    links.sort((a     , b     ) => pos[a.target].y - pos[b.target].y).forEach((l     ) => {
      const s = pos[l.source], t = pos[l.target];
      if (!s || !t) return;
      const h = Math.max(1, l.value * pxPerUnit);
      const x1 = s.x + nodeW, x2 = t.x, xc = (x1 + x2) / 2;
      const sTop = s.y + s.outOff, tTop = t.y + t.inOff;
      const color = colors[colMemo[l.source] % colors.length];
      svg.appendChild(svgEl('path', { d: `M${x1},${sTop} C${xc},${sTop} ${xc},${tTop} ${x2},${tTop} L${x2},${tTop + h} C${xc},${tTop + h} ${xc},${sTop + h} ${x1},${sTop + h} Z`, fill: color, 'fill-opacity': '0.3' }));
      s.outOff += h; t.inOff += h;
    });

    // Nodes + labels (to the right of each node, vertically centered; a bg halo keeps them legible
    // where they cross a ribbon).
    nodes.forEach((n     ) => {
      const p = pos[n.id]; if (!p) return;
      svg.appendChild(svgEl('rect', { x: p.x, y: p.y, width: nodeW, height: p.h, rx: 2, fill: colors[colMemo[n.id] % colors.length] }));
      const lab = svgEl('text', {
        x: p.x + nodeW + 6, y: p.y + p.h / 2, fill: 'var(--fg)', 'font-size': '11', 'font-weight': n.kind === 'outlet' ? '400' : '600',
        'dominant-baseline': 'middle', 'paint-order': 'stroke', stroke: 'var(--panel2)', 'stroke-width': '3', 'stroke-linejoin': 'round',
      });
      lab.textContent = `${n.label} · ${formatNum(nodeValue(n.id))} ${units}`;
      svg.appendChild(lab);
    });

    count.textContent = `${nodes.length} node(s) · ${links.length} link(s)`;
    const scroll = el('div', { style: { overflow: 'auto', maxHeight: '74vh', border: '1px solid var(--line)', borderRadius: '6px' } });
    scroll.appendChild(svg); wrap.appendChild(scroll);
    attachZoom(scroll, svg, W, totalH);  // scroll-into-view container is replaced on each draw(), so no leak.
  };

  // --- Hierarchy editor: a layered, left→right arrow graph (energy flows source → target). Drag from a
  //     node's right ● output port onto another node to add a directed feed. A node can have many feeders
  //     (a transfer switch fed by grid + generator + inverter) and producers are just feeds pointing into
  //     what they power (solar → inverter). Columns are auto-laid-out by depth to minimise crossings. ---
  const colors = ['#4f8cff', '#46c46a', '#fa4', '#f49', '#9f4', '#4ff'];
  const NW = 190, NH = 46;

  const renderEditor = () => {
    if (ed._cleanup) ed._cleanup();
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const customNodes = ensure(flow, 'Nodes', []);
    const links = ensure(flow, 'Links', []);
    ed.innerHTML = '';

    ed.appendChild(el('h3', { text: 'Hierarchy', style: { margin: '4px 0' } }));
    ed.appendChild(el('div', { class: 'desc', text: 'Energy flows left → right. Drag from a node’s right ● onto another node to add a feed (source powers target); click ✕ on a link to remove it. Double-click a custom node to rename it. PDU → outlet links are auto-derived (dashed) until you wire an explicit feeder. Add and configure nodes on the Nodes tab.' }));

    const bar2 = el('div', { class: 'ld-toolbar' });
    const save = btn('Save', 'primary');
    save.onclick = () => saveConfig(load);
    bar2.append(save); ed.appendChild(bar2);

    // MQTT export of the hierarchy (#164): each tier's rolled-up value is published per poll. Saved with
    // the hierarchy (the Save button posts the whole config).
    const exportRow = el('div', { class: 'ld-toolbar' });
    const topicIn = el('input', { type: 'text', placeholder: '{parent}/energyflow/{id}', style: { width: '280px' } });
    topicIn.value = flow.MqttTopicTemplate || '';
    topicIn.disabled = !flow.MqttExport;
    topicIn.onchange = () => { flow.MqttTopicTemplate = topicIn.value.trim() || undefined; };
    const expChk = el('input', { type: 'checkbox' }); expChk.checked = !!flow.MqttExport;
    expChk.onchange = () => { flow.MqttExport = expChk.checked; topicIn.disabled = !expChk.checked; };
    exportRow.append(el('label', {}, expChk, ' Export tiers to MQTT'), el('span', { class: 'desc', style: { margin: '0' }, text: 'Topic:' }), topicIn);
    ed.appendChild(exportRow);

    // Candidate nodes (from the built graph + custom defs).
    const cand = flowCandidates(lastGraph, customNodes);
    const nm = (id        )         => (cand.get(id) || {}).label || id;
    const byLabel = (a        , b        ) => (cand.get(a).label || a).localeCompare(cand.get(b).label || b);

    const autoParent = (id        ) => { const m = /^outlet:(.+):\d+$/.exec(id); return m ? 'pdu:' + m[1] : null; };

    // Edges: explicit directed Links, plus the auto PDU → outlet feed (suppressed once an outlet is
    // explicitly fed). `custom` edges are user links (deletable); auto edges are dashed and fixed.
    const customTo = new Set(links.map((l     ) => l.To));
    const edges        = [];
    cand.forEach((c     ) => { const ap = autoParent(c.id); if (ap && cand.has(ap) && !customTo.has(c.id)) edges.push({ from: ap, to: c.id, custom: false }); });
    links.forEach((l     ) => { if (cand.has(l.From) && cand.has(l.To)) edges.push({ from: l.From, to: l.To, custom: true, ref: l }); });

    // Adjacency + column = longest path from a root (every edge therefore points strictly rightward).
    const incoming      = {}, outgoing      = {};
    cand.forEach((_     , id        ) => { incoming[id] = []; outgoing[id] = []; });
    edges.forEach(e => { outgoing[e.from].push(e); incoming[e.to].push(e); });
    const colMemo      = {};
    const col = (id        , seen              )         => {
      if (colMemo[id] != null) return colMemo[id];
      seen = seen || new Set(); if (seen.has(id)) return 0; seen.add(id);
      const ins = incoming[id] || [];
      const c = ins.length ? Math.max(...ins.map((e     ) => col(e.from, seen) + 1)) : 0;
      seen.delete(id); return colMemo[id] = c;
    };
    [...cand.keys()].forEach(id => col(id));
    // Would adding from→to create a loop? (can `to` already reach `from`?)
    const reaches = (a        , b        ) => { const stack = [a], seen = new Set(); while (stack.length) { const x = stack.pop() ; if (x === b) return true; if (seen.has(x)) continue; seen.add(x); (outgoing[x] || []).forEach((e     ) => stack.push(e.to)); } return false; };

    // Layout: stack each column top-to-bottom; order downstream columns by feeder barycenter.
    const padX = 22, padY = 18, rowGap = 16, step = NW + 96;
    const cols        = [];
    [...cand.keys()].forEach(id => { const c = col(id); (cols[c] = cols[c] || []).push(id); });
    const pos      = {};
    const bary = (id        ) => { const ins = incoming[id] || []; if (!ins.length) return 1e9; let s = 0, w = 0; ins.forEach((e     ) => { const p = pos[e.from]; if (p) { s += p.y + NH / 2; w++; } }); return w ? s / w : 1e9; };
    cols.forEach((ids, c) => {
      if (c === 0) ids.sort((a        , b        ) => (cand.get(a).kind === 'pdu' ? 0 : 1) - (cand.get(b).kind === 'pdu' ? 0 : 1) || byLabel(a, b));
      else ids.sort((a        , b        ) => (bary(a) - bary(b)) || byLabel(a, b));
      let y = padY;
      ids.forEach((id        ) => { pos[id] = { x: padX + c * step, y }; y += NH + rowGap; });
    });

    const W = Math.max(640, ...[...cand.keys()].map(id => pos[id].x + NW + padX));
    const H = Math.max(260, ...[...cand.keys()].map(id => pos[id].y + NH + padY));
    const scroll = el('div', { style: { overflow: 'auto', border: '1px solid var(--line)', borderRadius: '6px', marginTop: '10px', maxHeight: '72vh' } });
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: 'background:var(--panel2); display:block' });
    scroll.appendChild(svg); ed.appendChild(scroll);
    const detachZoom = attachZoom(scroll, svg, W, H);
    const defs = svgEl('defs', {}); svg.appendChild(defs);
    [['fh-arrow', 'var(--line)'], ['fh-arrow-c', '#5ab0ff']].forEach(([id, fill]) => {
      const mk = svgEl('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
      mk.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill })); defs.appendChild(mk);
    });
    const edgeLayer = svgEl('g', {}); svg.appendChild(edgeLayer);
    const nodeLayer = svgEl('g', {}); svg.appendChild(nodeLayer);

    const edgeD = (a     , b     ) => { const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, xc = (x1 + x2) / 2; return `M${x1},${y1} C${xc},${y1} ${xc},${y2} ${x2},${y2}`; };
    edges.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      edgeLayer.appendChild(svgEl('path', { d: edgeD(a, b), fill: 'none', stroke: e.custom ? '#5ab0ff' : 'var(--line)', 'stroke-width': e.custom ? 2 : 1.5, 'stroke-dasharray': e.custom ? '' : '4 3', 'marker-end': `url(#${e.custom ? 'fh-arrow-c' : 'fh-arrow'})`, 'pointer-events': 'none' }));
      if (e.custom) {
        // Drifting dashes along the link, hinting at flow direction.
        edgeLayer.appendChild(svgEl('path', { class: 'flow-line', d: edgeD(a, b), fill: 'none', stroke: '#cfe8ff', 'stroke-opacity': '0.85', 'stroke-width': '2.6', 'stroke-linecap': 'round', 'stroke-dasharray': '7 11', 'pointer-events': 'none' }));
        const mx = (a.x + NW + b.x) / 2, my = (a.y + b.y) / 2 + NH / 2;
        const del = svgEl('text', { x: mx, y: my, 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: 'var(--bad)', 'font-size': '15', style: 'cursor:pointer' });
        del.textContent = '✕'; del.onclick = () => { const i = links.indexOf(e.ref); if (i >= 0) links.splice(i, 1); toast(`${nm(e.from)} → ${nm(e.to)} removed.`, true); renderEditor(); };
        edgeLayer.appendChild(del);
      }
    });

    const nodeG      = {};
    [...cand.values()].forEach((c     ) => {
      const p = pos[c.id], color = colors[col(c.id) % colors.length];
      const g = svgEl('g', { transform: `translate(${p.x},${p.y})`, style: 'cursor:default' }); g.dataset.id = c.id;
      g.appendChild(svgEl('rect', { width: NW, height: NH, rx: 7, fill: 'var(--panel)', stroke: color, 'stroke-width': 2 }));
      const t1 = svgEl('text', { x: 11, y: 19, fill: 'var(--fg)', 'font-size': '12', 'font-weight': '600' }); t1.textContent = c.label.length > 26 ? c.label.slice(0, 25) + '…' : c.label; g.appendChild(t1);
      const t2 = svgEl('text', { x: 11, y: 35, fill: 'var(--muted)', 'font-size': '10' }); t2.textContent = c.id; g.appendChild(t2);
      g.appendChild(svgEl('circle', { cx: NW, cy: NH / 2, r: 7, fill: color, style: 'cursor:crosshair', 'data-port': c.id }));
      if (c.custom) {
        const rm = svgEl('text', { x: NW - 13, y: 15, fill: 'var(--bad)', 'font-size': '13', style: 'cursor:pointer', 'data-rm': c.id }); rm.textContent = '✕'; g.appendChild(rm);
        // Rename in place: double-click the node to relabel it. Only the Label changes — Id stays fixed, so
        // every link/source keyed off it survives. (Ids aren't editable here for exactly that reason.)
        t1.setAttribute('title', 'Double-click to rename'); g.style.cursor = 'pointer';
        g.addEventListener('dblclick', (e     ) => {
          e.preventDefault();
          const node = customNodes.find((n     ) => n.Id === c.id); if (!node) return;
          const next = window.prompt(`Rename “${node.Label || node.Id}” (id ${node.Id} is unchanged)`, node.Label || node.Id);
          if (next == null) return; // cancelled
          node.Label = next.trim() || node.Id;
          toast(`Renamed to ${node.Label}. Save the hierarchy to keep it.`, true);
          renderEditor();
        });
      }
      nodeLayer.appendChild(g); nodeG[c.id] = g;
    });

    // Interactions: drag a node's output port onto another node to add a directed feed. Map screen
    // coords through the SVG CTM so the drag line stays correct under zoom/scroll.
    const toUser = (cx        , cy        ) => new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse());
    let linkFrom      = null, tempLine      = null, hovered      = null;
    const highlight = (id     ) => {
      if (id === hovered) return;
      if (hovered && nodeG[hovered]) { const rc = nodeG[hovered].querySelector('rect'); rc.setAttribute('stroke', colors[col(hovered) % colors.length]); rc.setAttribute('stroke-width', '2'); }
      hovered = id;
      if (hovered && nodeG[hovered]) { const rc = nodeG[hovered].querySelector('rect'); rc.setAttribute('stroke', '#46c46a'); rc.setAttribute('stroke-width', '3'); }
    };
    const targetUnder = (cx        , cy        ) => { const hit      = document.elementFromPoint(cx, cy); const gn = hit && hit.closest && hit.closest('g[data-id]'); return gn && gn.dataset.id !== linkFrom ? gn.dataset.id : null; };
    const onDown = (e     ) => {
      const portId = e.target.getAttribute && e.target.getAttribute('data-port');
      const rmId = e.target.getAttribute && e.target.getAttribute('data-rm');
      if (rmId) { const i = customNodes.findIndex((n     ) => n.Id === rmId); if (i >= 0) customNodes.splice(i, 1); for (let j = links.length - 1; j >= 0; j--) if (links[j].From === rmId || links[j].To === rmId) links.splice(j, 1); renderEditor(); return; }
      if (portId) { linkFrom = portId; tempLine = svgEl('path', { d: '', fill: 'none', stroke: '#5ab0ff', 'stroke-width': 2, 'stroke-dasharray': '4 3', 'pointer-events': 'none' }); edgeLayer.appendChild(tempLine); e.preventDefault(); }
    };
    const onMove = (e     ) => {
      if (!linkFrom) return;
      const u = toUser(e.clientX, e.clientY), a = pos[linkFrom];
      tempLine.setAttribute('d', `M${a.x + NW},${a.y + NH / 2} L${u.x},${u.y}`);
      highlight(targetUnder(e.clientX, e.clientY));
    };
    const onUp = (e     ) => {
      if (!linkFrom) return;
      const src = linkFrom, tgt = targetUnder(e.clientX, e.clientY);
      if (tempLine) tempLine.remove(); linkFrom = null; highlight(null);
      if (!tgt || src === tgt) return;
      if (reaches(tgt, src)) { toast('That would create a feeder loop.', false); return; }
      if (links.some((l     ) => l.From === src && l.To === tgt)) { toast('That feed already exists.', false); return; }
      links.push({ From: src, To: tgt });
      toast(`${nm(src)} → ${nm(tgt)} added.`, true);
      renderEditor();
    };
    svg.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    ed._cleanup = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); detachZoom(); };
  };

  const load = async () => {
    const r = await api(withInstance('/api/flow', instSel));
    if (!r.body.ok) { wrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load flow data.') + '</div>'; count.textContent = ''; lastGraph = null; renderEditor(); return; }
    lastGraph = r.body;
    draw(r.body);
    renderEditor();
    renderTree();
  };
  refresh.onclick = load;
  link.onclick = () => { activate(link, sec); load(); };
}

// The dedicated Nodes tab (#129): configure the virtual nodes — kind, how they're valued, live-value
// bindings, and feeders/children — separate from the Flow visualization. Both edit the shared EnergyFlow.
// Ready-made device templates (EG4 inverters, meters, …), fetched once and cached.
let nodeTemplatesCache               = null;
async function loadNodeTemplates()                 {
  if (nodeTemplatesCache) return nodeTemplatesCache;
  const r = await api('/api/node-templates');
  nodeTemplatesCache = (r.body?.ok && r.body.templates) ? r.body.templates : [];
  return nodeTemplatesCache;
}

// Instantiate a template into the live config: create its Modbus connection (if any) and its pre-wired
// nodes/links, all under an id prefix so the same device can be imported more than once without clashes.
function instantiateTemplate(tpl     , prefix        , host        , unitId        , flow     )           {
  const nodes = ensure(flow, 'Nodes', []);
  const links = ensure(flow, 'Links', []);
  let connId                    ;
  if (tpl.transport === 'modbus' && tpl.modbus) {
    const conns = ensure(ensure(state.data, 'Modbus', {}), 'Connections', []);
    connId = prefix;
    conns.push({ Id: connId, Name: tpl.name, Host: host || '', Port: tpl.modbus.port, UnitId: unitId,
      PollIntervalSeconds: tpl.modbus.pollIntervalSeconds, Framing: tpl.modbus.framing || 'tcp', Enabled: true });
  }
  const idOf = (key        ) => prefix + '-' + key;
  const added           = [];
  (tpl.nodes || []).forEach((tn     ) => {
    const node      = { Id: idOf(tn.key), Label: tn.label, Kind: tn.kind, Sources: (tn.sources || []).map((s     ) => {
      const src      = { Type: tpl.transport, Metric: s.metric };
      if (s.unit) src.Unit = s.unit;
      if (s.scale != null && s.scale !== 1) src.Scale = s.scale;
      if (tpl.transport === 'modbus') {
        src.Connection = connId; src.Register = s.register; src.RegisterType = s.registerType;
        src.DataType = s.dataType; src.WordOrder = s.wordOrder;
      } else { if (s.topic) src.Topic = s.topic; if (s.jsonField) src.JsonField = s.jsonField; }
      return src;
    }) };
    nodes.push(node); added.push(node.Id);
    if (tn.feedsKey) links.push({ From: idOf(tn.key), To: idOf(tn.feedsKey) });
  });
  return added;
}

// The "Import device template" panel: pick a template, set an id prefix + Modbus host/unit, and drop the
// pre-wired nodes into the config for review.
function renderImportPanel(flow     , existingIds             , rerender            )              {
  const panel = el('div', { class: 'tpl-import' });
  panel.appendChild(el('div', { class: 'desc', text: 'Import a known device to pre-fill its nodes and register bindings. Review and Save afterwards; addresses are community starting points — verify against your firmware.' }));
  const row = el('div', { class: 'ld-toolbar' });
  const sel = el('select', { style: { width: 'auto' } })                     ;
  const prefixIn = el('input', { type: 'text', placeholder: 'id prefix (e.g. eg4)' })                    ;
  const hostIn = el('input', { type: 'text', placeholder: 'Modbus host / IP' })                    ;
  const unitIn = el('input', { type: 'number', placeholder: 'unit', style: { width: '70px' } })                    ;
  const importBtn = btn('Import', 'primary');
  const note = el('div', { class: 'desc' });
  row.append(sel, prefixIn, hostIn, unitIn, importBtn);
  panel.append(row, note);

  loadNodeTemplates().then(tpls => {
    if (!tpls.length) { note.textContent = 'No device templates available.'; return; }
    tpls.forEach((t     ) => sel.appendChild(el('option', { value: t.id, text: t.vendor + ' · ' + t.name })));
    const showMeta = () => {
      const t = tpls.find((x     ) => x.id === sel.value);
      if (!t) return;
      prefixIn.value = t.id; hostIn.style.display = t.transport === 'modbus' ? '' : 'none';
      unitIn.style.display = t.transport === 'modbus' ? '' : 'none';
      unitIn.value = t.modbus ? String(t.modbus.unitId) : '';
      note.innerHTML = '';
      note.append(el('span', { text: (t.description || '') + ' ' }));
      if (t.sourceUrl) { const a = document.createElement('a'); a.href = t.sourceUrl; a.target = '_blank'; a.textContent = 'Register source ↗'; a.style.color = 'var(--accent)'; note.appendChild(a); }
    };
    sel.onchange = showMeta; showMeta();
    importBtn.onclick = () => {
      const t = tpls.find((x     ) => x.id === sel.value); if (!t) return;
      const prefix = (prefixIn.value || '').trim(); if (!prefix) { toast('An id prefix is required.', false); return; }
      const clash = (t.nodes || []).map((n     ) => prefix + '-' + n.key).find((id        ) => existingIds.has(id));
      if (clash) { toast(`Node id '${clash}' already exists — pick a different prefix.`, false); return; }
      const added = instantiateTemplate(t, prefix, hostIn.value.trim(), parseInt(unitIn.value) || 1, flow);
      toast(`Imported ${t.name}: ${added.length} node(s). Set the Modbus host if needed, then Save.`, true);
      rerender();
    };
  });
  return panel;
}

function addNodesSection(nav     , sections     ) {
  const link = document.createElement('a'); link.textContent = 'Nodes'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Energy Nodes'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Configure the virtual nodes in your energy hierarchy — panels, breakers, batteries, producers, a “Total”. Set each node’s kind, how it’s valued, its live-value bindings (MQTT / Modbus), and its feeders & children. The wiring also shows visually on the Flow tab.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const instSel = instanceSelector(() => load());
  const count = document.createElement('span'); count.className = 'ld-count';
  bar.appendChild(instSel.wrap); bar.appendChild(count); sec.appendChild(bar);
  const ed      = document.createElement('div'); ed.style.marginTop = '8px'; sec.appendChild(ed);
  let lastGraph      = null;
  const editing                        = { id: null };

  const render = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const customNodes = ensure(flow, 'Nodes', []);
    const links = ensure(flow, 'Links', []);
    count.textContent = `${customNodes.length} node(s)`;
    ed.innerHTML = '';

    const addBar = el('div', { class: 'ld-toolbar' });
    const idIn = el('input', { type: 'text', placeholder: 'id (e.g. gridboss)' });
    const labIn = el('input', { type: 'text', placeholder: 'label (e.g. Grid Boss)' });
    const kindSel = el('select', { style: { width: 'auto' } });
    NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
    const addBtn = btn('Add node', 'primary');
    const importBtn = btn('Import device template');
    const save = btn('Save', 'primary');
    addBtn.onclick = () => {
      const id = (idIn.value || '').trim(); if (!id) { toast('Node id is required.', false); return; }
      if (customNodes.some((n     ) => n.Id === id) || (lastGraph?.nodes || []).some((n     ) => n.id === id)) { toast('That id already exists.', false); return; }
      // Mode 'none' by default: a brand-new node has nothing measuring it, and inferring a size for it (the
      // 'auto' share) invents a figure the user never entered. Opt into inference deliberately.
      const node      = { Id: id, Label: (labIn.value || '').trim() || id, Mode: 'none' };
      if (kindSel.value !== 'node') node.Kind = kindSel.value;
      customNodes.push(node); editing.id = id; render();  // open the new node's editor straight away
    };
    save.onclick = () => saveConfig(load);
    addBar.append(idIn, labIn, kindSel, addBtn, importBtn, save); ed.appendChild(addBar);

    // Import-device-template panel, toggled by the button (existing ids guard against prefix clashes).
    const existingIds = new Set        ([...customNodes.map((n     ) => n.Id), ...((lastGraph?.nodes || []).map((n     ) => n.id))]);
    const impWrap = el('div'); ed.appendChild(impWrap);
    importBtn.onclick = () => {
      if (impWrap.firstChild) { impWrap.innerHTML = ''; return; }   // toggle closed
      impWrap.appendChild(renderImportPanel(flow, existingIds, render));
    };

    const cand = flowCandidates(lastGraph, customNodes);
    ed.appendChild(renderNodeManager(flow, customNodes, links, cand, editing, (close          ) => { if (close) editing.id = null; render(); }));
  };

  const load = async () => {
    // The flow graph gives the auto (pdu/outlet) node ids for the feeder/children pickers; node config itself
    // is global, so a failed/empty graph just means fewer wiring candidates, not an error.
    const r = await api(withInstance('/api/flow', instSel));
    lastGraph = r.body?.ok ? r.body : null;
    render();
  };
  link.onclick = () => { activate(link, sec); load(); };
}

// ── sections/export.ts ──────────────────────────────────────────
// A synthetic section that exports the current form state as config.yaml or an RpduConfig manifest — and
// takes one back (#214), merged into what's on screen or replacing it whole.

function addExportSection(nav     , sections     ) {
  const link = document.createElement('a'); link.textContent = 'Export'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Export'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Render the current (possibly unsaved) config for copy/paste into a ConfigMap, an RpduConfig custom resource, or source control.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'sec-actions';
  const fmt = document.createElement('select');
  [['yaml', 'config.yaml'], ['manifest', 'RpduConfig (Kubernetes)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; fmt.appendChild(o); });
  const copy = btn('Copy');
  const refresh = btn('Refresh');
  bar.appendChild(fmt); bar.appendChild(copy); bar.appendChild(refresh); sec.appendChild(bar);

  const ta = document.createElement('textarea'); ta.className = 'yaml'; ta.readOnly = true; ta.spellcheck = false; sec.appendChild(ta);

  const fill = async () => {
    const endpoint = fmt.value === 'manifest' ? '/api/config/manifest' : '/api/config/yaml';
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) });
    ta.value = r.ok ? await r.text() : 'Unable to render.';
  };
  copy.onclick = async () => { ta.select(); const ok = await copyText(ta.value); toast(ok ? 'Copied to clipboard.' : 'Could not copy — your browser blocked it (the text is selected, so Ctrl+C works).', ok); };
  refresh.onclick = fill;
  fmt.onchange = fill;

  sec.appendChild(buildImport());

  link.onclick = () => { activate(link, sec); fill(); };
}

// The other direction: paste a config (or a section of one) from somewhere else and apply it here.
function buildImport() {
  const wrap = el('div', { style: { marginTop: '22px' } });
  wrap.appendChild(el('h3', { text: 'Import', style: { margin: '4px 0', fontSize: '15px' } }));
  wrap.appendChild(el('div', {
    class: 'desc',
    text: 'Paste a config.yaml or an RpduConfig manifest — a whole one, or just the sections you want. Nothing is saved: the result is loaded into the form for you to review, and you press Save as usual.',
  }));

  const bar = el('div', { class: 'sec-actions' });
  const mode = el('select')                     ;
  [
    ['merge', 'Merge — apply only what the paste mentions'],
    ['replace', 'Replace — the paste becomes the whole config'],
  ].forEach(([v, t]) => mode.appendChild(el('option', { value: v, text: t })));
  const apply = btn('Import', 'primary');
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(mode, apply, status);
  wrap.appendChild(bar);

  const input = el('textarea', { class: 'yaml', spellcheck: false, placeholder: 'Paste config.yaml or an RpduConfig manifest here…' })                       ;
  wrap.appendChild(input);

  // Replace throws away everything the paste doesn't mention, which is worth saying before it happens.
  const note = el('div', { class: 'desc' });
  const describe = () => {
    note.textContent = mode.value === 'replace'
      ? 'Replace: any section the paste doesn’t mention goes back to its default — including PDUs, overrides and nodes you have here but not there.'
      : 'Merge: only the keys present in the paste are applied; everything else keeps its current value. A list (nodes, links, labels) is applied whole rather than half-merged.';
  };
  mode.onchange = describe;
  describe();
  wrap.appendChild(note);

  apply.onclick = async () => {
    const yaml = input.value.trim();
    if (!yaml) { toast('Paste a configuration first.', false); return; }

    status.textContent = 'importing…';
    const r = await api('/api/config/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Yaml: yaml, Mode: mode.value, Current: JSON.stringify(exportData()) }),
    });

    if (!r.body?.ok) {
      status.textContent = '';
      toast(r.body?.message || 'Import failed.', false);
      return;
    }

    // Load it into the form; the user reviews and saves like any other edit.
    state.data = r.body.config;
    build();
    const sections = (r.body.sections || []).join(', ');
    (r.body.notes || []).forEach((n        ) => toast(n, true));
    status.textContent = `applied ${sections || 'nothing'}`;
    toast(`Imported ${sections}. Review the tabs, then Save.`, true);
  };

  return wrap;
}

// ── sections/ha-energy.ts ───────────────────────────────────────
// Home Assistant Energy Mapping (#128): the EnergyDashboard settings + manual sync/clear actions.

function addHaEnergySection(nav     , sections     ) {
  const link = document.createElement('a'); link.textContent = 'HA Energy Mapping'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Home Assistant Energy Mapping'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Map the energy-flow hierarchy into Home Assistant’s Energy Dashboard (individual devices + their upstream device). Each tier is published to HA as an Energy sensor by the flow export, so enable “Export tiers to MQTT” (Flow tab) and HA discovery for the full Grid → Panel → Circuit → PDU → outlet chain to appear. Settings persist with the main Save button; the buttons act immediately using the values below.';
  sec.appendChild(d);

  const ha = ensure(ensure(state.data, 'HomeAssistant', {}), 'EnergyDashboard', {});

  const field = (label        , key        , type = 'text', placeholder = '') => {
    const f = el('div', { class: 'field' });
    f.appendChild(el('label', { text: label }));
    const inp      = el('input', { type, placeholder });
    if (ha[key] != null) inp.value = ha[key];
    inp.onchange = () => { ha[key] = inp.value === '' ? null : inp.value; };
    f.appendChild(inp);
    return { f, inp };
  };
  const url = field('Home Assistant URL', 'Url', 'text', 'http://homeassistant.local:8123');
  const token = field('Long-lived access token', 'Token', 'password', '');
  const etype = field('Energy measurement type', 'EnergyMeasurementType', 'text', 'energy');

  const chkF = el('div', { class: 'field' });
  const chk      = el('input', { type: 'checkbox' }); chk.checked = !!ha.Enabled;
  chk.onchange = () => { ha.Enabled = chk.checked; };
  chkF.appendChild(el('label', { style: { fontWeight: '600' } }, chk, ' Enable periodic sync'));
  chkF.appendChild(el('div', { class: 'desc', text: 'Re-push the hierarchy automatically every few polls while enabled.' }));

  const grid = el('div', { class: 'grid' });
  grid.append(url.f, token.f, etype.f, chkF);
  sec.appendChild(grid);

  const bar = el('div', { class: 'sec-actions' });
  const syncBtn = btn('Sync now', 'primary');
  const clearBtn = btn('Clear energy dashboard', 'danger');
  bar.append(syncBtn, clearBtn); sec.appendChild(bar);
  sec.appendChild(el('div', { class: 'desc', text: 'Also Save (main button) so the periodic sync uses these settings.' }));

  syncBtn.onclick = async () => {
    toast('Syncing to Home Assistant…', true);
    const r = await api('/api/ha-energy/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.inp.value.trim(), token: token.inp.value, energyMeasurementType: etype.inp.value.trim() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
  };
  clearBtn.onclick = async () => {
    if (!confirm('Clear ALL devices from Home Assistant’s Energy Dashboard?\n\nThis removes every entry in the dashboard’s device list — including any you added manually. You can re-add the hierarchy with “Sync now”.')) return;
    toast('Clearing the Energy Dashboard…', true);
    const r = await api('/api/ha-energy/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.inp.value.trim(), token: token.inp.value }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
  };
  link.onclick = () => activate(link, sec);
}

// ── sections/home.ts ────────────────────────────────────────────
// Landing/status page (#186): a red / amber / green board for the bridge and everything it talks to.
// v3: the verdicts come from the component grains via /api/status — this file only renders them. Deciding
// what "stale" or "waiting" means lives with the component that knows, not in the browser.

function addHomeSection(nav     , sections     ) {
  const link = document.createElement('a'); link.textContent = 'Status'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Status' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Every hop your energy data takes — the meters it comes from, the broker it moves over, and the stores it lands in. Green = healthy, amber = degraded or waiting, red = broken, grey = not configured.' }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  bar.appendChild(refresh); sec.appendChild(bar);
  const grid = el('div', { class: 'status-grid' }); sec.appendChild(grid);

  // The dot/badge class per level; 'off' has no class (grey is the default).
  const dotClass      = { good: 'good', warn: 'warn', bad: 'bad', off: '' };

  const card = (cls        , title        , stateText        , detail                ) => {
    const c = el('div', { class: 'status-card' });
    const head = el('div', { class: 'status-head' });
    head.appendChild(el('span', { class: 'dot' + (cls ? ' ' + cls : '') }));
    head.appendChild(el('b', { text: title }));
    head.appendChild(el('span', { class: 'status-state' + (cls ? ' ' + cls : ''), text: stateText }));
    c.appendChild(head);
    c.appendChild(el('div', { class: 'desc', text: detail || '' }));
    return c;
  };

  const ago = (s        ) => s < 90 ? s + 's ago' : Math.round(s / 60) + 'm ago';
  const uptime = (s        ) => { s = Math.floor(s || 0); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return 'up ' + (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; };

  // A card's detail is the static part plus, where the grain asked for it, the aged instant it carries.
  const detailOf = (c     ) => {
    const parts           = [];
    if (c.detail) parts.push(c.detail);
    if (c.eventUtc && c.age && c.age !== 'none') {
      const secs = Math.max(0, (Date.now() - new Date(c.eventUtc).getTime()) / 1000);
      parts.push(c.age === 'uptime' ? uptime(secs) : ago(Math.round(secs)));
    }
    return parts.join(' ');
  };

  const load = async () => {
    const r = await api('/api/status/board');
    const cards = (r.body && r.body.cards) || [];
    grid.innerHTML = '';

    if (!cards.length) {
      grid.appendChild(card('warn', 'Status', 'Waiting', 'No component has reported yet'));
      return;
    }
    cards.forEach((c     ) => grid.appendChild(card(dotClass[c.level] ?? '', c.title, c.state, detailOf(c))));
  };

  refresh.onclick = () => load();
  // Refresh while the tab is on screen so the board stays live without polling in the background.
  setInterval(() => { if (sec.classList.contains('active')) load(); }, 10000);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, load };
}

// ── config-form.ts ──────────────────────────────────────────────
// Schema-driven config form: render scalar/object/dictionary/list nodes, the per-section panels, the
// nav, and the overall build() that wires every tab.

function scalarInput(node     , obj     )      {
  let el     ;
  if (node.type === 'bool') {
    el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!obj[node.key];
    el.onchange = () => obj[node.key] = el.checked;
  } else if (node.type === 'enum') {
    el = document.createElement('select');
    // A blank choice (value "") means "unset" — leave the field out so its default/auto behaviour applies.
    (node.enumValues || []).forEach((v        ) => { const o = document.createElement('option'); o.value = v; o.textContent = v === '' ? '(default)' : v; el.appendChild(o); });
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => obj[node.key] = el.value === '' ? undefined : el.value;
  } else if (node.type === 'int' || node.type === 'double') {
    el = document.createElement('input'); el.type = 'number'; if (node.type === 'double') el.step = 'any';
    if (node.min != null) el.min = node.min; if (node.max != null) el.max = node.max;
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => obj[node.key] = el.value === '' ? null : Number(el.value);
  } else {
    el = document.createElement('input'); el.type = node.type === 'password' ? 'password' : 'text';
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => obj[node.key] = el.value === '' ? null : el.value;
  }
  return el;
}

// Render an object's child properties into `container`: scalar fields flow into a multi-column grid
// (compact), while nested lists/dicts/objects are tall unbreakable blocks, so they render full-width
// and stacked — otherwise the CSS column-balancer shoves them into one lopsided column.
function renderObjectBody(properties       , target     , container     ) {
  const isComplex = (c     ) => c.type === 'object' || c.type === 'list' || c.type === 'dictionary';
  const scalars = (properties || []).filter(c => !isComplex(c));
  const complex = (properties || []).filter(isComplex);
  if (scalars.length) {
    const grid = document.createElement('div'); grid.className = 'grid';
    scalars.forEach(child => renderNode(child, target, grid));
    container.appendChild(grid);
  }
  complex.forEach(child => renderNode(child, target, container));
}

// Render an arbitrary node bound to obj[node.key] (the value lives under its key on obj).
function renderNode(node     , obj     , container     ) {
  if (node.type === 'object') {
    const target = ensure(obj, node.key, {});
    const fs = document.createElement('fieldset');
    const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
    renderObjectBody(node.properties, target, fs);
    container.appendChild(fs);
  } else if (node.type === 'dictionary') {
    container.appendChild(renderMap(node, ensure(obj, node.key, {})));
  } else if (node.type === 'list') {
    container.appendChild(renderList(node, ensure(obj, node.key, [])));
  } else {
    const f = document.createElement('div'); f.className = 'field';
    const lab = document.createElement('label'); lab.textContent = node.label; f.appendChild(lab);
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; f.appendChild(d); }
    const input = scalarInput(node, obj);
    f.appendChild(input);
    if (node.templateVars && node.templateVars.length) f.appendChild(templateVarChips(node.templateVars, input, obj, node));
    container.appendChild(f);
  }
}

// Click-to-insert / draggable chips for a templated field's available {variables}.
function templateVarChips(vars          , input     , obj     , node     ) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;';
  const label = document.createElement('span'); label.className = 'desc'; label.style.margin = '0'; label.textContent = 'Variables:';
  wrap.appendChild(label);
  vars.forEach(v => {
    const token = '{' + v + '}';
    const chip = document.createElement('span'); chip.textContent = token; chip.draggable = true;
    chip.style.cssText = 'cursor:grab;user-select:none;font:12px ui-monospace,Consolas,monospace;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 7px;';
    chip.title = 'Click to insert at the cursor, or drag into the field';
    chip.onclick = () => {
      const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, s) + token + input.value.slice(e);
      const pos = s + token.length; input.focus(); input.setSelectionRange(pos, pos);
      obj[node.key] = input.value === '' ? null : input.value;
    };
    // Native text drop inserts at the drop point; the field's change handler syncs the model on blur.
    chip.ondragstart = (ev     ) => ev.dataTransfer.setData('text/plain', token);
    wrap.appendChild(chip);
  });
  return wrap;
}

// Render the value of a dictionary/list element (valueSchema has no key of its own).
function renderValue(valueSchema     , holder     , keyName     , container     ) {
  const node = Object.assign({}, valueSchema, { key: keyName, label: 'value' });
  if (node.type === 'object') {
    const target = ensure(holder, keyName, {});
    // A dictionary/list entry's fields (e.g. each PDU instance): scalars in columns, collections full-width.
    renderObjectBody(node.properties, target, container);
  } else {
    renderNode(node, holder, container);
  }
}

function renderMap(node     , mapObj     ) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
  const entries = document.createElement('div'); fs.appendChild(entries);

  const drawEntry = (key        ) => {
    const wrap = document.createElement('div'); wrap.className = 'map-entry';
    const head = document.createElement('div'); head.className = 'head';
    const keyIn = document.createElement('input'); keyIn.className = 'key'; keyIn.type = 'text'; keyIn.value = key;
    keyIn.onchange = () => { if (keyIn.value && keyIn.value !== key) { mapObj[keyIn.value] = mapObj[key]; delete mapObj[key]; key = keyIn.value; } };
    const del = btn('Remove', 'danger');
    del.onclick = () => { delete mapObj[key]; entries.removeChild(wrap); };
    head.appendChild(keyIn); head.appendChild(del); wrap.appendChild(head);
    if (mapObj[key] == null) mapObj[key] = (node.valueSchema && node.valueSchema.type === 'object') ? {} : '';
    renderValue(node.valueSchema, mapObj, key, wrap);
    entries.appendChild(wrap);
  };

  Object.keys(mapObj).forEach(drawEntry);
  const add = btn('+ Add');
  add.onclick = () => { let k = 'new'; let i = 1; while (mapObj[k] !== undefined) k = 'new' + (i++); mapObj[k] = node.valueSchema.type === 'object' ? {} : ''; drawEntry(k); };
  fs.appendChild(add);
  return fs;
}

function renderList(node     , arr       ) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  const entries = document.createElement('div'); fs.appendChild(entries);
  const draw = (idx        ) => {
    const wrap = document.createElement('div'); wrap.className = 'list-entry';
    const del = btn('Remove', 'danger');
    del.onclick = () => { arr.splice(idx, 1); rebuild(); };
    wrap.appendChild(del);
    renderValue(node.valueSchema, arr, idx, wrap);
    entries.appendChild(wrap);
  };
  const rebuild = () => { entries.innerHTML = ''; arr.forEach((_, i) => draw(i)); };
  rebuild();
  const add = btn('+ Add');
  add.onclick = () => { arr.push(node.valueSchema.type === 'object' ? {} : ''); rebuild(); };
  fs.appendChild(add);
  return fs;
}

// Nav grouped by function (#209): the PDU group only does anything with Vertiv rPDUs configured; live
// value sources are Integrations; readings are consolidated and shipped onward (Destinations); the rest is
// plumbing (System). A group holds both schema-driven config sections (by key) and the bespoke tool tabs
// (by their add* fn). Ungrouped schema sections fall into System, so a new one is never lost.

const NAV_GROUPS                                        = [
  // Sources: the Vertiv rPDU integration is the parent; its PDU-only tabs hang off it as children.
  { title: 'Sources', items: [{ schema: 'Pdus' }, { schema: 'Overrides', child: true }, { tool: addLiveDataSection, child: true }, { tool: addControlSection, child: true }, { tool: addPathsSection, child: true }] },
  { title: 'Energy Flow', items: [{ tool: addNodesSection }, { tool: addFlowSection }] },
  { title: 'Integrations', items: [{ schema: 'MQTT' }, { schema: 'Modbus' }] },
  { title: 'Destinations', items: [{ schema: 'EmonCMS' }, { schema: 'HomeAssistant' }, { tool: addHaEnergySection, child: true }, { schema: 'Prometheus' }] },
  { title: 'System', items: [{ schema: 'Gui' }, { schema: 'Api' }, { schema: 'Health' }, { schema: 'Logging' }, { schema: 'Debug' }, { tool: addExportSection }, { tool: addDiagnosticsSection }] },
];

// Display-label fixes — acronyms in caps, and clearer names (#209). Keys are schema section keys.
const LABEL_OVERRIDES                         = { Pdus: 'Vertiv rPDU', Api: 'API', Gui: 'GUI', Modbus: 'Modbus TCP', HomeAssistant: 'Home Assistant' };

// A collapsible nav group: clicking the header toggles its items. Returns the container the group's links
// (schema sections or tool tabs) are appended into.
function navGroup(nav     , title        ) {
  const wrap = el('div', { class: 'nav-group-wrap' });
  const header = el('div', { class: 'nav-group', text: title });
  const items = el('div', { class: 'nav-group-items' });
  header.onclick = () => wrap.classList.toggle('collapsed');
  wrap.append(header, items); nav.appendChild(wrap);
  return items;
}

// Render one schema-driven config section (nav link + panel); returns the nav link.
function renderConfigSection(node     , nav     , sections     ) {
  const label = LABEL_OVERRIDES[node.key] || node.label;
  const link = document.createElement('a'); link.textContent = label; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = label; sec.appendChild(h);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; sec.appendChild(d); }
  // Section-specific actions belong with the section they act on, not on every page.
  const acts = sectionActions(node);
  if (acts) sec.appendChild(acts);
  if (node.key === 'Overrides') {
    // Bespoke, live-data-driven editor instead of the blind dictionary form.
    const tools = document.createElement('div'); tools.className = 'sec-actions';
    const refresh = btn('Refresh live data');
    const preview = btn('Preview generated paths (with unsaved edits)');
    tools.appendChild(refresh); tools.appendChild(preview);
    const pathsBox = document.createElement('div');
    const container      = document.createElement('div');
    refresh.onclick = () => renderOverrides(container);
    preview.onclick = () => previewOverridePaths(pathsBox);
    sec.appendChild(tools); sec.appendChild(pathsBox); sec.appendChild(container);
    link.onclick = () => { activate(link, sec); if (!container.dataset.loaded) renderOverrides(container); };
  } else {
    if (node.type === 'object') {
      ensure(state.data, node.key, {});
      // EnergyDashboard has its own "HA Energy Mapping" tab, so don't also render it in the HA form.
      const props = node.key === 'HomeAssistant' ? (node.properties || []).filter((p     ) => p.key !== 'EnergyDashboard') : node.properties;
      renderObjectBody(props, state.data[node.key], sec);
    }
    else renderNode(node, state.data, sec);
    if (node.key === 'Gui') wireGuiAuth(sec);
    else if (node.key === 'EmonCMS') wireEmonCmsTransport(sec);
    else if (node.key === 'Api') wireApiDocs(sec);
    else if (node.key === 'Operator') wireOperatorSwitch(sec);
    link.onclick = () => activate(link, sec);
  }
  return link;
}

function build() {
  const nav      = document.getElementById('nav'); const sections      = document.getElementById('sections');
  nav.innerHTML = ''; sections.innerHTML = '';

  const byKey = new Map(state.schema.map((n     ) => [n.key, n]));
  // EnergyFlow has a dedicated visual editor (Flow/Nodes tabs), so its raw schema form is hidden here.
  const HIDDEN = new Set(['EnergyFlow']);
  // Any schema section not explicitly grouped (and not hidden) lands in System, so a new one is never lost.
  const knownSchema = new Set(NAV_GROUPS.flatMap(g => g.items.filter(i => 'schema' in i).map((i     ) => i.schema)));
  const system = NAV_GROUPS.find(g => g.title === 'System') ;
  state.schema.forEach((n     ) => { if (!knownSchema.has(n.key) && !HIDDEN.has(n.key)) system.items.push({ schema: n.key }); });

  // The landing page: a status board, rendered first so it's the default tab (#186).
  const home = addHomeSection(nav, sections);
  const first      = home.link;

  for (const g of NAV_GROUPS) {
    // Drop items whose schema section is absent (e.g. Logging is hidden from the schema under Kubernetes).
    const items = g.items.filter(it => 'tool' in it || byKey.get((it       ).schema));
    if (!items.length) continue;
    const container = navGroup(nav, g.title);
    for (const it of items) {
      if ('schema' in it) {
        const l = renderConfigSection(byKey.get(it.schema), container, sections);
        if (it.child && l) l.classList.add('nav-child');
      } else {
        const before = container.children.length;
        it.tool(container, sections);
        if (it.child && container.children[before]) container.children[before].classList.add('nav-child');
      }
    }
  }

  // Open the tab named in the URL hash (so a refresh / shared link lands where you were), else the first.
  const wanted = decodeURIComponent((location.hash || '').slice(1));
  const target = wanted ? ([...nav.querySelectorAll('a')]         ).find(a => slug(a.textContent) === wanted) : null;
  (target || first)?.click();
}

// In the Gui section, grey out the auth fields that don't apply to the selected AuthType.
function wireGuiAuth(sec     ) {
  const oidcFs = [...sec.querySelectorAll('fieldset')].find((fs     ) => fs.querySelector('legend')?.textContent === 'Oidc')       ;
  // The AuthType dropdown is the only select in the Gui section (outside the Oidc fieldset).
  const authSelect = [...sec.querySelectorAll('.field select')].find((s     ) => !oidcFs || !oidcFs.contains(s))       ;
  if (!authSelect) return;
  // Basic-auth fields = text/password inputs of the Gui section, outside the Oidc fieldset.
  const basicInputs = [...sec.querySelectorAll('.field input')].filter((i     ) => (!oidcFs || !oidcFs.contains(i)) && (i.type === 'text' || i.type === 'password'));
  const oidcInputs = oidcFs ? [...oidcFs.querySelectorAll('input, select, textarea')] : [];
  const setOff = (els       , off         ) => els.forEach((e     ) => { e.disabled = off; e.style.opacity = off ? '0.5' : '1'; });
  const apply = () => {
    const t = authSelect.value;
    setOff(basicInputs, t !== 'Basic');
    setOff(oidcInputs, t !== 'Oidc');
  };
  authSelect.addEventListener('change', apply);
  apply();
}

// In the EmonCMS section, hide the fields that don't apply to the selected Transport (Http vs Mqtt).
function wireEmonCmsTransport(sec     ) {
  const fields = [...sec.querySelectorAll('.field')]         ;
  const field = (label        ) => fields.find(f => f.querySelector('label')?.textContent === label);
  const transportSel = field('Transport')?.querySelector('select');
  if (!transportSel) return;
  const mqttOnly = ['MqttBaseTopic', 'MqttTopicTemplate'].map(field).filter(Boolean);
  // Url/ApiKey are needed by the HTTP transport AND by feed auto-config (which drives the REST API
  // regardless of the measurement transport); Path is HTTP-transport only.
  const urlKey = ['Url', 'ApiKey'].map(field).filter(Boolean);
  const pathField = field('Path');
  const feedsAuto = field('AutoConfigure')?.querySelector('input[type=checkbox]');
  const apply = () => {
    const t = transportSel.value; // 'Http' | 'Mqtt'
    urlKey.forEach((f     ) => f.style.display = (t === 'Http' || feedsAuto?.checked) ? '' : 'none');
    if (pathField) pathField.style.display = t === 'Http' ? '' : 'none';
    mqttOnly.forEach((f     ) => f.style.display = t === 'Mqtt' ? '' : 'none');
  };
  transportSel.addEventListener('change', apply);
  feedsAuto?.addEventListener('change', apply);
  apply();
}

// The API section advertises OpenAPI/Scalar docs but never said where they live (#190). Show the real
// URLs, derived from the configured port. The API listens on its own port, so the links are built from
// this page's hostname rather than its path — they are only reachable if that port is exposed to you.
function wireApiDocs(sec     ) {
  const fields = [...sec.querySelectorAll('.field')]         ;
  const field = (label        ) => fields.find(f => f.querySelector('label')?.textContent === label);
  const enabled = field('Enabled')?.querySelector('input[type=checkbox]');
  const portIn = field('Port')?.querySelector('input');
  if (!portIn) return;

  const box = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = 'Documentation'; box.appendChild(lg);
  const desc = document.createElement('div'); desc.className = 'desc'; box.appendChild(desc);
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  box.appendChild(list);

  const LINKS = [
    ['Interactive docs (Scalar)', '/scalar/v1'],
    ['OpenAPI document', '/openapi/v1.json'],
    ['API root', '/api/v1'],
  ];

  const apply = () => {
    const on = enabled ? enabled.checked : true;
    const port = portIn.value || '8082';
    const base = `${location.protocol}//${location.hostname}:${port}`;
    desc.textContent = on
      ? 'The API is served on its own port — these links work once that port is reachable from your browser.'
      : 'The API is disabled. Enable it above, save, and restart; these links will work once it is listening.';
    list.innerHTML = '';
    for (const [label, path] of LINKS) {
      const row = document.createElement('div');
      const a = document.createElement('a');
      a.href = base + path; a.textContent = base + path;
      a.target = '_blank'; a.rel = 'noopener';
      a.style.cssText = 'font:12px ui-monospace,Consolas,monospace;';
      if (!on) { a.style.pointerEvents = 'none'; a.style.opacity = '0.5'; }
      row.appendChild(document.createTextNode(label + ': '));
      row.appendChild(a);
      list.appendChild(row);
    }
  };

  portIn.addEventListener('input', apply);
  enabled?.addEventListener('change', apply);
  apply();
  sec.appendChild(box);
}

// Operator page: a channel/version switcher — roll the Deployment to stable/edge/dev or a specific release (#210).
function wireOperatorSwitch(sec     ) {
  const box = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = 'Deployed version'; box.appendChild(lg);
  const desc = el('div', { class: 'desc' }); box.appendChild(desc);
  const row = el('div', { class: 'sec-actions' });
  const sel = document.createElement('select'); sel.style.width = 'auto';
  const switchBtn = btn('Switch', 'primary');
  const forceBtn = btn('Force update');
  forceBtn.title = 'Re-pull the current tag now (pins its current digest so it rolls even on IfNotPresent). Use for moving channels like edge/dev that changed underneath.';
  const status = el('div', { class: 'desc' });
  row.append(sel, switchBtn, forceBtn); box.append(row, status);
  sec.appendChild(box);

  forceBtn.onclick = async () => {
    if (!confirm('Force a re-pull of the currently-deployed tag and roll the Deployment now?')) return;
    forceBtn.disabled = true;
    const res = await api('/api/operator/redeploy', { method: 'POST' });
    forceBtn.disabled = false;
    toast(res.body?.message || (res.ok ? 'Force update requested.' : 'Force update failed.'), res.ok && res.body?.ok);
    if (res.ok && res.body?.ok) status.textContent = res.body.message;
  };

  const CHANNEL_LABEL                         = {
    stable: 'stable — newest release', latest: 'latest — newest release', edge: 'edge — main branch (bleeding edge)',
    dev: 'dev — work-in-progress builds', unstable: 'unstable — work-in-progress builds',
  };

  api('/api/operator/tags').then(r => {
    const b = r.body || {};
    if (!b.ok) { desc.textContent = b.message || 'Version switching is unavailable.'; sel.style.display = 'none'; switchBtn.style.display = 'none'; forceBtn.style.display = 'none'; return; }
    desc.innerHTML = `Roll the Deployment to a different image tag. Currently deployed: <b>${b.current || '—'}</b>. Switching restarts the workload (a normal rolling update).`;
    const group = (label        , tags          , fmt                       ) => {
      if (!tags || !tags.length) return;
      const og = document.createElement('optgroup'); og.label = label;
      tags.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = fmt(t); if (t === b.current) o.selected = true; og.appendChild(o); });
      sel.appendChild(og);
    };
    group('Channels', b.channels || [], (t        ) => CHANNEL_LABEL[t] || t);
    group('Versions', b.versions || [], (t        ) => t);
    if (!sel.options.length) { desc.textContent += ' No tags found in the registry.'; switchBtn.disabled = true; }

    switchBtn.onclick = async () => {
      const tag = sel.value; if (!tag) return;
      if (tag === b.current) { toast('That tag is already deployed.', false); return; }
      if (!confirm(`Switch the deployment to "${tag}"? This rolls the workload (all tiers) to that image.`)) return;
      switchBtn.disabled = true;
      const res = await api('/api/operator/set-tag?tag=' + encodeURIComponent(tag), { method: 'POST' });
      switchBtn.disabled = false;
      toast(res.body?.message || (res.ok ? 'Switch requested.' : 'Switch failed.'), res.ok && res.body?.ok);
      if (res.ok && res.body?.ok) status.textContent = res.body.message;
    };
  }).catch(() => { desc.textContent = 'Could not load available versions.'; sel.style.display = 'none'; switchBtn.style.display = 'none'; forceBtn.style.display = 'none'; });
}

// Section-specific action buttons (connection tests; Home Assistant discovery actions).
function sectionActions(node     ) {
  const bar = document.createElement('div'); bar.className = 'sec-actions';
  const add = (label        , fn     , cls         ) => { const b = btn(label, cls); b.onclick = fn; bar.appendChild(b); };

  if (node.key === 'MQTT') add('Test MQTT connection', testMqtt);
  else if (node.key === 'PDU') add('Test PDU connection', testPdu);
  else if (node.key === 'Modbus') add('Test connections', testModbus);
  else if (node.key === 'EmonCMS') { add('Test EmonCMS connection', testEmonCms); add('Provision feeds now', provisionEmonCmsFeeds); add('Delete all feeds', deleteEmonCmsFeeds, 'danger'); }
  else if (node.key === 'HomeAssistant') {
    if ((state.data.HomeAssistant || {}).DiscoveryEnabled === false) return null;
    add('Republish discovery', rediscoverHa);
    add('Clear discovery', clearHa, 'danger');
  } else return null;

  return bar;
}

// ── actions.ts ──────────────────────────────────────────────────
// Section-level connection tests + Home Assistant discovery actions (wired from sectionActions()).

// Test every configured Modbus TCP connection by opening a throwaway connection to each.
async function testModbus() {
  const conns = (state.data?.Modbus?.Connections) || [];
  if (!conns.length) { toast('No Modbus connections configured — add one first.', false); return; }
  toast(`Testing ${conns.length} Modbus connection(s)…`, true);
  for (const c of conns) {
    if (!c.Host) { toast(`${c.Name || c.Id || 'connection'}: no host set.`, false); continue; }
    const r = await api('/api/modbus/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Host: c.Host, Port: c.Port, UnitId: c.UnitId }) });
    toast(`${c.Name || c.Id}: ${r.body.message || (r.body.ok ? 'OK' : 'failed')}`, r.body.ok);
  }
}

async function testMqtt() { const r = await api('/api/test/mqtt', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
async function testPdu() { toast('Testing PDU…', true); const r = await api('/api/test/pdu', { method: 'POST' }); toast(r.body.message, r.body.ok); }
async function testEmonCms() { toast('Testing EmonCMS…', true); const r = await api('/api/test/emoncms', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
async function provisionEmonCmsFeeds() { toast('Provisioning EmonCMS feeds…', true); const r = await api('/api/emoncms/provision-feeds', { method: 'POST' }); toast(r.body.message, r.body.ok); }
async function deleteEmonCmsFeeds() {
  if (!confirm('⚠️ DELETE ALL EmonCMS feeds created by rPDU2MQTT?\n\n'
    + 'This PERMANENTLY deletes every feed under rPDU2MQTT’s tag/node — and ALL of their stored history in EmonCMS.\n\n'
    + 'It CANNOT be undone. Any EmonCMS dashboards, graphs, apps or virtual feeds that use these feeds will break.\n\n'
    + 'Only continue if you intend to wipe and rebuild them.')) return;
  if (!confirm('Are you absolutely sure?\n\nThis is your last chance to cancel before every rPDU2MQTT feed and its data are destroyed.')) return;
  const typed = prompt('Final confirmation — type  DELETE  (all caps) to permanently delete all rPDU2MQTT feeds:');
  if (typed !== 'DELETE') { toast('Cancelled — nothing was deleted.', false); return; }
  toast('Deleting EmonCMS feeds…', true);
  const r = await api('/api/emoncms/delete-feeds', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}
async function rediscoverHa() { toast('Requesting discovery…', true); const r = await api('/api/discovery/rediscover', { method: 'POST' }); toast(r.body.message, r.body.ok); }
async function clearHa() {
  if (!confirm('Clear all Home Assistant discovery messages? The entities will disappear from Home Assistant until discovery runs again.')) return;
  const r = await api('/api/discovery/clear', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}

// ── main.ts ─────────────────────────────────────────────────────
// Bootstrap & shared status: load the schema + config, build the UI, and wire the global Save/Reload.

// Back/forward navigation + direct hash edits: open the matching tab if it isn't already active. (Normal
// tab clicks already set the hash via activate(), so by the time this fires the tab is active -> no-op,
// which also avoids re-loading a tab's data on every click.)
window.addEventListener('hashchange', () => {
  const wanted = decodeURIComponent((location.hash || '').slice(1));
  if (!wanted) return;
  const link = ([...document.querySelectorAll('nav a')]         ).find(a => slug(a.textContent) === wanted);
  if (link && !link.classList.contains('active')) link.click();
});

async function load() {
  state.schema = (await api('/api/schema')).body;
  state.data = (await api('/api/config')).body;
  build();
  refreshStatus();
}

// Last-seen operator update report, so "check now" can tell when a fresh result has landed.
let lastCheckedAt                = null;

// Render the header update chip from the operator's report (#210). Hidden when no operator is reporting.
function renderUpdate(u     ) {
  const upd = document.getElementById('st-update')       ;
  if (!u) { upd.style.display = 'none'; lastCheckedAt = null; return; }
  lastCheckedAt = u.checkedAt || null;
  upd.style.display = 'inline-flex';
  upd.classList.remove('busy');
  if (u.available) {
    upd.className = 'st-update warn';
    upd.textContent = '↑ ' + (u.latest || 'Update');
    upd.title = 'Update available: ' + (u.latest || '?') + (u.current ? ' (on ' + u.current + ')' : '')
      + (u.applied ? ' — auto-updated' : '') + '\nClick to check now';
  } else if (u.current) {
    upd.className = 'st-update good';
    upd.textContent = '✓ ' + u.current;
    upd.title = 'Up to date' + (u.checkedAt ? ' (checked ' + new Date(u.checkedAt).toLocaleString() + ')' : '') + '\nClick to check now';
  } else {
    upd.className = 'st-update';
    upd.textContent = 'Check updates';
    upd.title = (u.message || '') + '\nClick to check now';
  }
}

async function refreshStatus() {
  const { body } = await api('/api/status');
  (document.getElementById('st-version')       ).textContent = 'v' + (body.version || '?');
  (document.getElementById('st-mqtt-dot')       ).className = 'dot ' + (body.mqttConnected ? 'good' : 'bad');
  renderUpdate(body.update);
  // A ConfigMap / read-only mount can't be saved; disable Save and explain why.
  const readOnly = body.configWritable === false;
  const save = document.getElementById('btn-save')       ;
  save.disabled = readOnly;
  save.title = readOnly ? 'Config file is read-only and cannot be saved.' : '';
  (document.getElementById('ro-note')       ).style.display = readOnly ? 'inline' : 'none';
  // Show a logout link + signed-in user when OIDC is in use.
  if (body.auth === 'oidc') {
    (document.getElementById('st-logout')       ).style.display = 'inline';
    if (body.user) (document.getElementById('st-user')       ).textContent = body.user;
  }
}

// "Check now": ask the operator (a separate process) to run a registry check, then poll for the result.
async function checkUpdatesNow() {
  const upd = document.getElementById('st-update')       ;
  if (upd.classList.contains('busy')) return;
  const priorCheckedAt = lastCheckedAt;
  upd.classList.add('busy'); upd.textContent = '⏳ Checking…'; upd.title = 'Checking for updates…';

  const r = await api('/api/operator/check', { method: 'POST' });
  if (!r.ok || !r.body?.ok) { toast(r.body?.message || 'Update check failed.', false); await refreshStatus(); return; }

  // The operator patches the CR status asynchronously; poll a few times for a newer checkedAt.
  const started = Date.now();
  while (Date.now() - started < 12000) {
    await new Promise(res => setTimeout(res, 1500));
    const s = (await api('/api/status')).body;
    if (s.update && s.update.checkedAt && s.update.checkedAt !== priorCheckedAt) {
      renderUpdate(s.update);
      toast(s.update.available ? ('Update available: ' + (s.update.latest || '?')) : 'Up to date.', true);
      return;
    }
  }
  await refreshStatus();
  toast('Requested a check — no response yet. Is the operator role running?', false);
}

(document.getElementById('st-update')       ).onclick = checkUpdatesNow;
(document.getElementById('btn-reload')       ).onclick = load;
(document.getElementById('btn-save')       ).onclick = async () => {
  const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) });
  toast(r.body.message || (r.ok ? 'Saved.' : 'Save failed.'), r.ok && r.body.ok);
};

load();

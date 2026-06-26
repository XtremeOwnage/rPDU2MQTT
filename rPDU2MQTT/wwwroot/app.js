const api = (p, opt) => fetch(p, opt).then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }));
let schema = [], data = {};

function ensure(obj, key, fallback) { if (obj[key] === undefined || obj[key] === null) obj[key] = fallback; return obj[key]; }

// --- DOM helpers ---------------------------------------------------------------------------------
// Create an element with optional props and children, to cut createElement/append boilerplate.
function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k === 'text') e.textContent = v;
    else if (k in e) e[k] = v; else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
// A small ".small" button (add a class like "danger"/"primary" via cls).
function btn(label, cls) { return el('button', { class: 'small' + (cls ? ' ' + cls : ''), text: label }); }

// --- Multi-PDU: per-tab instance selector ---
let _instancesCache = null;
async function getInstances() {
  if (_instancesCache) return _instancesCache;
  const r = await api('/api/instances');
  _instancesCache = (r.body && r.body.ok) ? (r.body.instances || []) : [];
  return _instancesCache;
}
// A per-tab PDU instance picker. Returns { wrap, get } — append `wrap` to a toolbar; `get()` is the
// selected instance id. Stays hidden when only one instance is configured (single-PDU UX unchanged);
// then get() === '' so the backend falls back to the primary. `onChange` fires when the user switches.
function instanceSelector(onChange) {
  const sel = el('select');
  const wrap = el('label', { class: 'ld-inst', style: { display: 'none' } }, 'Instance ', sel);
  getInstances().then(list => {
    if (list.length <= 1) return;
    list.forEach(i => sel.appendChild(el('option', { value: i.id, text: i.id + (i.primary ? ' (primary)' : '') })));
    sel.value = (list.find(i => i.primary) || list[0]).id;
    wrap.style.display = '';
  });
  sel.onchange = () => onChange && onChange(sel.value);
  return { wrap, get: () => sel.value || '' };
}
// Append `?instance=<id>` to a path when an instance is selected (empty -> primary, omit the param).
function withInstance(path, instSel) {
  const v = instSel.get();
  return v ? path + (path.includes('?') ? '&' : '?') + 'instance=' + encodeURIComponent(v) : path;
}

// === Config form (schema-driven rendering) ===
function scalarInput(node, obj) {
  let el;
  if (node.type === 'bool') {
    el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!obj[node.key];
    el.onchange = () => obj[node.key] = el.checked;
  } else if (node.type === 'enum') {
    el = document.createElement('select');
    (node.enumValues || []).forEach(v => { const o = document.createElement('option'); o.value = o.textContent = v; el.appendChild(o); });
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => obj[node.key] = el.value;
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

// Render an arbitrary node bound to obj[node.key] (the value lives under its key on obj).
function renderNode(node, obj, container) {
  if (node.type === 'object') {
    const target = ensure(obj, node.key, {});
    const fs = document.createElement('fieldset');
    const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
    // Lay nested fields out in columns to use the horizontal space.
    const grid = document.createElement('div'); grid.className = 'grid';
    (node.properties || []).forEach(child => renderNode(child, target, grid));
    fs.appendChild(grid);
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
function templateVarChips(vars, input, obj, node) {
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
    chip.ondragstart = (ev) => ev.dataTransfer.setData('text/plain', token);
    wrap.appendChild(chip);
  });
  return wrap;
}

// Render the value of a dictionary/list element (valueSchema has no key of its own).
function renderValue(valueSchema, holder, keyName, container) {
  const node = Object.assign({}, valueSchema, { key: keyName, label: 'value' });
  if (node.type === 'object') {
    const target = ensure(holder, keyName, {});
    // Multi-column layout for a dictionary/list entry's fields (e.g. each PDU instance).
    const grid = document.createElement('div'); grid.className = 'grid';
    (node.properties || []).forEach(child => renderNode(child, target, grid));
    container.appendChild(grid);
  } else {
    renderNode(node, holder, container);
  }
}

function renderMap(node, mapObj) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
  const entries = document.createElement('div'); fs.appendChild(entries);

  const drawEntry = (key) => {
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

function renderList(node, arr) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  const entries = document.createElement('div'); fs.appendChild(entries);
  const draw = (idx) => {
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

function build() {
  const nav = document.getElementById('nav'); const sections = document.getElementById('sections');
  nav.innerHTML = ''; sections.innerHTML = '';
  schema.forEach((node, i) => {
    const link = document.createElement('a'); link.textContent = node.label; nav.appendChild(link);
    const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
    const h = document.createElement('h2'); h.textContent = node.label; sec.appendChild(h);
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
      const container = document.createElement('div');
      refresh.onclick = () => renderOverrides(container);
      preview.onclick = () => previewOverridePaths(pathsBox);
      sec.appendChild(tools); sec.appendChild(pathsBox); sec.appendChild(container);
      link.onclick = () => { activate(link, sec); if (!container.dataset.loaded) renderOverrides(container); };
    } else {
      if (node.type === 'object') {
        ensure(data, node.key, {});
        const grid = document.createElement('div'); grid.className = 'grid';
        (node.properties || []).forEach(c => renderNode(c, data[node.key], grid));
        sec.appendChild(grid);
      }
      else renderNode(node, data, sec);
      if (node.key === 'Gui') wireGuiAuth(sec);
      link.onclick = () => activate(link, sec);
    }
    if (i === 0) link.click();
  });
  addControlSection(nav, sections);
  addLiveDataSection(nav, sections);
  addPathsSection(nav, sections);
  addExportSection(nav, sections);
  addDiagnosticsSection(nav, sections);
}

// In the Gui section, grey out the auth fields that don't apply to the selected AuthType.
function wireGuiAuth(sec) {
  const oidcFs = [...sec.querySelectorAll('fieldset')].find(fs => fs.querySelector('legend')?.textContent === 'Oidc');
  // The AuthType dropdown is the only select in the Gui section (outside the Oidc fieldset).
  const authSelect = [...sec.querySelectorAll('.field select')].find(s => !oidcFs || !oidcFs.contains(s));
  if (!authSelect) return;
  // Basic-auth fields = text/password inputs of the Gui section, outside the Oidc fieldset.
  const basicInputs = [...sec.querySelectorAll('.field input')].filter(i => (!oidcFs || !oidcFs.contains(i)) && (i.type === 'text' || i.type === 'password'));
  const oidcInputs = oidcFs ? [...oidcFs.querySelectorAll('input, select, textarea')] : [];
  const setOff = (els, off) => els.forEach(e => { e.disabled = off; e.style.opacity = off ? '0.5' : '1'; });
  const apply = () => {
    const t = authSelect.value;
    setOff(basicInputs, t !== 'Basic');
    setOff(oidcInputs, t !== 'Oidc');
  };
  authSelect.addEventListener('change', apply);
  apply();
}

// A click-to-copy monospace table cell (used by the path tables).
function pathCopyCell(text) {
  const td = document.createElement('td');
  if (!text) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
  const code = document.createElement('span'); code.textContent = text; code.style.cursor = 'pointer';
  code.style.fontFamily = 'ui-monospace,Consolas,monospace'; code.style.fontSize = '12px'; code.title = 'Click to copy';
  code.onclick = () => { navigator.clipboard?.writeText(text); toast('Copied: ' + text, true); };
  td.appendChild(code); return td;
}

// Build a paths table (Device / Outlet / Measurement / MQTT [/ Prometheus] [/ EmonCMS]).
function pathsTable(rows, promOn, emonOn) {
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
// === GUI sections (Paths, Diagnostics, Control, Live Data) ===
function addPathsSection(nav, sections) {
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

  let rows = [], promOn = false, emonOn = false;
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

// Status / diagnostics: versions, uptime, restart, and (in Kubernetes) logs + events.
function addDiagnosticsSection(nav, sections) {
  const link = document.createElement('a'); link.textContent = 'Diagnostics'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Diagnostics'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc'; d.textContent = 'Runtime status and maintenance actions.'; sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'sec-actions';
  const refresh = btn('Refresh');
  const restart = btn('Restart bridge', 'danger');
  bar.appendChild(refresh); bar.appendChild(restart); sec.appendChild(bar);

  const info = document.createElement('table'); info.className = 'ld'; sec.appendChild(info);
  const k8sWrap = document.createElement('div'); sec.appendChild(k8sWrap);

  const fmtUptime = s => { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; };
  const row = (k, v) => { const tr = document.createElement('tr'); const a = document.createElement('td'); a.textContent = k; a.style.color = 'var(--muted)'; a.style.width = '220px'; const b = document.createElement('td'); b.textContent = (v == null || v === '') ? '—' : v; tr.appendChild(a); tr.appendChild(b); return tr; };

  const load = async () => {
    const r = await api('/api/diagnostics'); const b = r.body;
    info.innerHTML = '';
    info.appendChild(row('App version', b.version));
    if (b.image) info.appendChild(row('Container image', b.image));
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
    k8sWrap.innerHTML = '';
    if (b.kubernetes) buildK8sTools(k8sWrap);
  };
  refresh.onclick = load;
  restart.onclick = async () => {
    if (!confirm('Restart the bridge? It will disconnect briefly while the container restarts.')) return;
    const r = await api('/api/restart', { method: 'POST' });
    toast(r.body.message || 'Restarting…', r.ok && r.body.ok);
  };
  link.onclick = () => { activate(link, sec); load(); };
}

// Kubernetes-only: on-demand pod logs + recent events.
function buildK8sTools(container) {
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
    (r.body.events || []).forEach(e => { const tr = document.createElement('tr'); [e.time, e.type, e.reason, e.message, e.count].forEach(c => { const td = document.createElement('td'); td.textContent = c == null ? '' : c; tr.appendChild(td); }); tb.appendChild(tr); });
    t.appendChild(tb); out.innerHTML = ''; out.appendChild(t);
    if (!(r.body.events || []).length) out.innerHTML = '<div class="desc">No recent events.</div>';
  };
}

// Direct outlet control (on/off/reboot). A convenient place to exercise write actions.
function addControlSection(nav, sections) {
  const link = document.createElement('a'); link.textContent = 'Control'; nav.appendChild(link);
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

  let rows = [], groups = [], devices = [], enabled = false;
  const actGroup = async (g, action) => {
    const verb = action === 'on' ? 'turn ON' : action === 'off' ? 'turn OFF' : 'reboot';
    if (!confirm('Group "' + (g.name || g.key) + '": ' + verb + ' ALL member outlets?')) return;
    toast('Group ' + (g.name || g.key) + ': ' + action + '…', true);
    const r = await api('/api/control/group', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupKey: g.key, action, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 1000);
  };
  const setGroupLabel = (g, value) => postLabel({ target: 'group', groupKey: g.key, label: (value || '').trim() }, 'Group ' + (g.name || g.key));
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
      const onCount = members.filter(m => m.state === 'on').length;
      members.forEach(m => {
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
  const act = async (o, action) => {
    if (action === 'off' && !confirm('Turn OFF outlet ' + o.number + ' (' + o.name + ')?')) return;
    if (action === 'reboot' && !confirm('Reboot outlet ' + o.number + ' (' + o.name + ')? Connected equipment will lose power briefly.')) return;
    if (action === 'resetstats' && !confirm('Reset statistics for outlet ' + o.number + ' (' + o.name + ')?')) return;
    toast('Outlet ' + o.number + ': ' + action + '…', true);
    const r = await api('/api/control/outlet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: o.deviceId, index: o.index, action, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 800); // let the PDU apply, then re-read state
  };
  const postLabel = async (payload, desc) => {
    toast(desc + ': set label…', true);
    const r = await api('/api/control/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 800);
  };
  const setLabel = (o, value) => postLabel({ deviceId: o.deviceId, target: 'outlet', index: o.index, label: (value || '').trim() }, 'Outlet ' + o.number);
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
    const labelRow = (kind, name, current, payload) => {
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
      (d.circuits || []).forEach(c => labelRow('Circuit', c.name, c.label, { deviceId: d.deviceId, target: 'entity', entityKey: c.key }));
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

// A read-only view of the current readings being pulled from the PDU(s).
function addLiveDataSection(nav, sections) {
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

  let body = { entities: [], types: [], units: {}, readings: [], groups: [] }, timer = null;

  // Pivoted: one row per outlet/entity, a column per measurement type, grouped by device.
  const drawGrouped = () => {
    const f = filter.value.trim().toLowerCase();
    const types = body.types || [];
    const ents = (body.entities || []).filter(e => !f || (e.device + ' ' + e.source + ' ' + types.join(' ')).toLowerCase().includes(f));
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    const cols = ['Outlet / entity', 'State', ...types.map(ty => ty + (body.units[ty] ? ' (' + body.units[ty] + ')' : ''))];
    cols.forEach((x, i) => { const th = document.createElement('th'); th.textContent = x; if (i >= 2) th.className = 'num'; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    let lastDevice = null;
    ents.forEach(e => {
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
      types.forEach(ty => { const td = document.createElement('td'); td.className = 'num'; const v = (e.values || {})[ty]; td.textContent = (v == null) ? '' : formatNum(v); tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); tableWrap.innerHTML = ''; tableWrap.appendChild(t);
  };

  const drawFlat = () => {
    const f = filter.value.trim().toLowerCase();
    const rows = (body.readings || []).filter(r => !f || (r.device + ' ' + r.source + ' ' + r.type).toLowerCase().includes(f));
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Device', 'Outlet / entity', 'Measurement', 'Value', 'Units'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    rows.forEach(r => {
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
    const shown = gs.filter(g => !f || (g.name || '').toLowerCase().includes(f));
    if (!shown.length) return;
    // Union of measurement types (+ units) across all groups, for stable columns. A type whose members
    // vary gets Min/Max columns flanking its total (e.g. Min | realPower (W) | Max).
    const types = []; const units = {}; const spread = {};
    gs.forEach(g => (g.measurements || []).forEach(m => {
      if (!types.includes(m.type)) types.push(m.type);
      if (m.units && !units[m.type]) units[m.type] = m.units;
      if (m.min != null && m.max != null) spread[m.type] = true;
    }));
    types.sort();
    // Flatten types into ordered columns.
    const cols = [];
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
    shown.forEach(g => {
      const byType = {}; (g.measurements || []).forEach(m => byType[m.type] = m);
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

function formatNum(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(v); }

function activate(link, sec) {
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  link.classList.add('active'); sec.classList.add('active');
}

// ---- Overrides editor (driven by live PDU data) ----
// === Overrides editor ===
function ovGet(path) { let o = data.Overrides; for (const p of path) { if (o == null) return undefined; o = o[p]; } return o; }
function ovSet(path, val) {
  let o = data.Overrides = data.Overrides || {};
  for (let i = 0; i < path.length - 1; i++) { if (o[path[i]] == null) o[path[i]] = {}; o = o[path[i]]; }
  const last = path[path.length - 1];
  if (val === undefined || val === null || val === '') delete o[last]; else o[last] = val;
}

function ovText(label, path, placeholder) {
  const f = document.createElement('label'); f.className = 'ov-field';
  const s = document.createElement('span'); s.textContent = label; f.appendChild(s);
  const inp = document.createElement('input'); inp.type = 'text';
  const v = ovGet(path); if (v != null) inp.value = v;
  if (placeholder) inp.placeholder = placeholder;
  inp.onchange = () => ovSet(path, inp.value.trim());
  f.appendChild(inp); return f;
}
function ovEnabled(path) {
  const f = document.createElement('label'); f.className = 'ov-field ov-check';
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = ovGet(path) !== false;
  // Checked == default (true) -> drop the key; unchecked -> persist Enabled:false.
  inp.onchange = () => ovSet(path, inp.checked ? undefined : false);
  const s = document.createElement('span'); s.textContent = 'Enabled';
  f.appendChild(inp); f.appendChild(s); return f;
}
// ph: { name, id } placeholders showing the current (default) values.
// makeModel: also render Manufacturer/Model overrides (devices/outlets/groups, not measurements).
function overrideFields(objPath, ph, makeModel) {
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
function ovContext(parts) {
  const span = document.createElement('span'); span.className = 'ov-sub';
  span.textContent = parts.filter(p => p[1]).map(p => (p[0] ? p[0] + ' ' : '') + p[1]).join('   ·   ');
  return span;
}
function overrideCard(title, contextParts, objPath, ph, makeModel) {
  const card = document.createElement('div'); card.className = 'ov-card';
  const head = document.createElement('div'); head.className = 'ov-head';
  const t = document.createElement('div'); t.className = 'ov-title'; t.textContent = title; head.appendChild(t);
  if (contextParts && contextParts.some(p => p[1])) head.appendChild(ovContext(contextParts));
  card.appendChild(head);
  card.appendChild(overrideFields(objPath, ph, makeModel));
  return card;
}
function groupHeader(title, sub) {
  const w = document.createElement('div'); w.className = 'ov-group';
  const h = document.createElement('h3'); h.textContent = title; w.appendChild(h);
  if (sub) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = sub; w.appendChild(d); }
  return w;
}
function outletRow(deviceKey, o) {
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
function deviceCard(dev) {
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
  Object.keys(ovOutlets).forEach(idx => { if (!live.some(o => String(o.index) === String(idx))) merged.push({ index: Number(idx), displayName: '(not currently discovered)' }); });
  if (merged.length) {
    const ol = document.createElement('div'); ol.className = 'ov-outlets';
    merged.sort((a, b) => a.index - b.index).forEach(o => ol.appendChild(outletRow(dev.key, o)));
    card.appendChild(ol);
  }
  return card;
}

async function renderOverrides(container) {
  container.dataset.loaded = '1';
  container.innerHTML = '<div class="desc">Loading live PDU data…</div>';
  const r = await api('/api/live');
  ensure(data, 'Overrides', {}); ensure(data.Overrides, 'Devices', {}); ensure(data.Overrides, 'Measurements', {});
  container.innerHTML = '';
  if (!r.body.ok) {
    const w = document.createElement('div'); w.className = 'desc'; w.style.color = 'var(--bad)';
    w.textContent = (r.body.message || 'Could not load live data.') + ' Showing existing overrides only.';
    container.appendChild(w);
  }
  const lv = r.body.ok ? r.body : { devices: [], measurements: [], groups: [] };
  const ov = data.Overrides;

  container.appendChild(overrideCard('Bridge (rPDU2MQTT)', [['', 'the top-level bridge device']], ['PDU'], {}, true));

  container.appendChild(groupHeader('Devices', 'Each discovered device and its outlets. Leave a field blank to keep the value shown in the placeholder.'));
  const liveKeys = new Set();
  lv.devices.forEach(d => { liveKeys.add(d.key); container.appendChild(deviceCard(d)); });
  Object.keys(ov.Devices || {}).filter(k => !liveKeys.has(k)).forEach(k => container.appendChild(deviceCard({ key: k, displayName: '(not currently discovered)', outlets: [] })));

  container.appendChild(groupHeader('Measurements', 'Applied to every measurement of this type, across all outlets.'));
  const units = {}; (lv.measurements || []).forEach(m => { units[m.type] = m.units; });
  const types = [...new Set([...(lv.measurements || []).map(m => m.type), ...Object.keys(ov.Measurements || {})])];
  types.forEach(tp => container.appendChild(overrideCard('measurement: ' + tp, [['units:', units[tp]]], ['Measurements', tp], {})));

  if (lv.groups && lv.groups.length) {
    container.appendChild(groupHeader('OneView Groups', null));
    lv.groups.forEach(g => container.appendChild(overrideCard('Group: ' + (g.label || g.name || g.key), [['key', g.key], ['discovered as:', g.displayName]], ['OneviewGroups', 'Overrides', g.key], { name: g.displayName }, true)));
  }
}

// Show the generated paths produced by the current (unsaved) overrides, computed server-side
// against the real processing pipeline so it matches what would actually be published.
async function previewOverridePaths(box) {
  box.innerHTML = '<div class="desc">Computing paths with your unsaved edits…</div>';
  const r = await fetch('/api/paths/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) })
    .then(async res => ({ ok: res.ok, body: await res.json().catch(() => ({})) }));
  box.innerHTML = '';
  if (!r.body.ok) { box.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not compute paths.') + '</div>'; return; }
  const note = document.createElement('div'); note.className = 'desc';
  note.innerHTML = 'Paths with unsaved overrides applied. Note: overrides change the <b>HA name/object_id</b> and <b>Prometheus device/source labels</b>; the <b>MQTT topic</b> and <b>EmonCMS key</b> derive from the PDU’s raw keys and are not affected.';
  box.appendChild(note);
  box.appendChild(pathsTable(r.body.rows || [], !!r.body.prometheusEnabled, !!r.body.emonEnabled));
}

// Strip empty override objects so untouched entries don't pollute the saved config.
function exportData() {
  const clone = JSON.parse(JSON.stringify(data));
  if (clone.Overrides) pruneEmpty(clone.Overrides);
  return clone;
}
function pruneEmpty(o) {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const k of Object.keys(o)) {
      const v = pruneEmpty(o[k]);
      if (v === undefined) delete o[k];
    }
    if (Object.keys(o).length === 0) return undefined;
  }
  return o;
}

// Section-specific action buttons (connection tests; Home Assistant discovery actions).
function sectionActions(node) {
  const bar = document.createElement('div'); bar.className = 'sec-actions';
  const add = (label, fn, cls) => { const b = btn(label, cls); b.onclick = fn; bar.appendChild(b); };

  if (node.key === 'MQTT') add('Test MQTT connection', testMqtt);
  else if (node.key === 'PDU') add('Test PDU connection', testPdu);
  else if (node.key === 'EmonCMS') add('Test EmonCMS connection', testEmonCms);
  else if (node.key === 'HomeAssistant') {
    if ((data.HomeAssistant || {}).DiscoveryEnabled === false) return null;
    add('Republish discovery', rediscoverHa);
    add('Clear discovery', clearHa, 'danger');
  } else return null;

  return bar;
}

// A synthetic section that exports the current form state as config.yaml or an RpduConfig manifest.
function addExportSection(nav, sections) {
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
  copy.onclick = () => { ta.select(); navigator.clipboard?.writeText(ta.value); toast('Copied to clipboard.', true); };
  refresh.onclick = fill;
  fmt.onchange = fill;
  link.onclick = () => { activate(link, sec); fill(); };
}

function toast(msg, good) { const t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast ' + (good ? 'good' : 'bad'); }

// === Bootstrap & shared actions ===
async function load() {
  schema = (await api('/api/schema')).body;
  data = (await api('/api/config')).body;
  build();
  refreshStatus();
}

async function refreshStatus() {
  const { body } = await api('/api/status');
  document.getElementById('st-version').textContent = 'v' + (body.version || '?');
  document.getElementById('st-mqtt-dot').className = 'dot ' + (body.mqttConnected ? 'good' : 'bad');
  // A ConfigMap / read-only mount can't be saved; disable Save and explain why.
  const readOnly = body.configWritable === false;
  const save = document.getElementById('btn-save');
  save.disabled = readOnly;
  save.title = readOnly ? 'Config file is read-only and cannot be saved.' : '';
  document.getElementById('ro-note').style.display = readOnly ? 'inline' : 'none';
  // Show a logout link + signed-in user when OIDC is in use.
  if (body.auth === 'oidc') {
    document.getElementById('st-logout').style.display = 'inline';
    if (body.user) document.getElementById('st-user').textContent = body.user;
  }
}

async function testMqtt() { const r = await api('/api/test/mqtt', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
async function testPdu() { toast('Testing PDU…', true); const r = await api('/api/test/pdu', { method: 'POST' }); toast(r.body.message, r.body.ok); }
async function testEmonCms() { toast('Testing EmonCMS…', true); const r = await api('/api/test/emoncms', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
async function rediscoverHa() { toast('Requesting discovery…', true); const r = await api('/api/discovery/rediscover', { method: 'POST' }); toast(r.body.message, r.body.ok); }
async function clearHa() {
  if (!confirm('Clear all Home Assistant discovery messages? The entities will disappear from Home Assistant until discovery runs again.')) return;
  const r = await api('/api/discovery/clear', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}

document.getElementById('btn-reload').onclick = load;
document.getElementById('btn-save').onclick = async () => {
  const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) });
  toast(r.body.message || (r.ok ? 'Saved.' : 'Save failed.'), r.ok && r.body.ok);
};

load();

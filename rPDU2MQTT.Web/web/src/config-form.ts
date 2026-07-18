// Schema-driven config form: render scalar/object/dictionary/list nodes, the per-section panels, the
// nav, and the overall build() that wires every tab.
import { ensure, el, btn, activate, slug } from './helpers.js';
import { state } from './state.js';
import { renderOverrides, previewOverridePaths } from './overrides.js';
import { testMqtt, testPdu, testEmonCms, provisionEmonCmsFeeds, deleteEmonCmsFeeds, rediscoverHa, clearHa, testModbus } from './actions.js';
import { addPathsSection } from './sections/paths.js';
import { addDiagnosticsSection } from './sections/diagnostics.js';
import { addControlSection } from './sections/control.js';
import { addLiveDataSection } from './sections/livedata.js';
import { addFlowSection, addNodesSection } from './sections/flow.js';
import { addExportSection } from './sections/export.js';
import { addHaEnergySection } from './sections/ha-energy.js';
import { addHomeSection } from './sections/home.js';

function scalarInput(node: any, obj: any): any {
  let el: any;
  if (node.type === 'bool') {
    el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!obj[node.key];
    el.onchange = () => obj[node.key] = el.checked;
  } else if (node.type === 'enum') {
    el = document.createElement('select');
    // A blank choice (value "") means "unset" — leave the field out so its default/auto behaviour applies.
    (node.enumValues || []).forEach((v: string) => { const o = document.createElement('option'); o.value = v; o.textContent = v === '' ? '(default)' : v; el.appendChild(o); });
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
function renderObjectBody(properties: any[], target: any, container: any) {
  const isComplex = (c: any) => c.type === 'object' || c.type === 'list' || c.type === 'dictionary';
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
function renderNode(node: any, obj: any, container: any) {
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
function templateVarChips(vars: string[], input: any, obj: any, node: any) {
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
    chip.ondragstart = (ev: any) => ev.dataTransfer.setData('text/plain', token);
    wrap.appendChild(chip);
  });
  return wrap;
}

// Render the value of a dictionary/list element (valueSchema has no key of its own).
function renderValue(valueSchema: any, holder: any, keyName: any, container: any) {
  const node = Object.assign({}, valueSchema, { key: keyName, label: 'value' });
  if (node.type === 'object') {
    const target = ensure(holder, keyName, {});
    // A dictionary/list entry's fields (e.g. each PDU instance): scalars in columns, collections full-width.
    renderObjectBody(node.properties, target, container);
  } else {
    renderNode(node, holder, container);
  }
}

function renderMap(node: any, mapObj: any) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
  const entries = document.createElement('div'); fs.appendChild(entries);

  const drawEntry = (key: string) => {
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

function renderList(node: any, arr: any[]) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  const entries = document.createElement('div'); fs.appendChild(entries);
  const draw = (idx: number) => {
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
type NavItem = { schema: string, child?: boolean } | { tool: (nav: any, sections: any) => any, child?: boolean };
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  // Sources: the Vertiv rPDU integration is the parent; its PDU-only tabs hang off it as children.
  { title: 'Sources', items: [{ schema: 'Pdus' }, { schema: 'Overrides', child: true }, { tool: addLiveDataSection, child: true }, { tool: addControlSection, child: true }, { tool: addPathsSection, child: true }] },
  { title: 'Energy Flow', items: [{ tool: addNodesSection }, { tool: addFlowSection }] },
  { title: 'Integrations', items: [{ schema: 'MQTT' }, { schema: 'Modbus' }] },
  { title: 'Destinations', items: [{ schema: 'EmonCMS' }, { schema: 'HomeAssistant' }, { tool: addHaEnergySection, child: true }, { schema: 'Prometheus' }] },
  { title: 'System', items: [{ schema: 'Gui' }, { schema: 'Api' }, { schema: 'Health' }, { schema: 'Logging' }, { schema: 'Debug' }, { tool: addExportSection }, { tool: addDiagnosticsSection }] },
];

// Display-label fixes — acronyms in caps, and clearer names (#209). Keys are schema section keys.
const LABEL_OVERRIDES: Record<string, string> = { Pdus: 'Vertiv rPDU', Api: 'API', Gui: 'GUI', Modbus: 'Modbus TCP', HomeAssistant: 'Home Assistant' };

// A collapsible nav group: clicking the header toggles its items. Returns the container the group's links
// (schema sections or tool tabs) are appended into.
function navGroup(nav: any, title: string) {
  const wrap = el('div', { class: 'nav-group-wrap' });
  const header = el('div', { class: 'nav-group', text: title });
  const items = el('div', { class: 'nav-group-items' });
  header.onclick = () => wrap.classList.toggle('collapsed');
  wrap.append(header, items); nav.appendChild(wrap);
  return items;
}

// Render one schema-driven config section (nav link + panel); returns the nav link.
function renderConfigSection(node: any, nav: any, sections: any) {
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
    const container: any = document.createElement('div');
    refresh.onclick = () => renderOverrides(container);
    preview.onclick = () => previewOverridePaths(pathsBox);
    sec.appendChild(tools); sec.appendChild(pathsBox); sec.appendChild(container);
    link.onclick = () => { activate(link, sec); if (!container.dataset.loaded) renderOverrides(container); };
  } else {
    if (node.type === 'object') {
      ensure(state.data, node.key, {});
      // EnergyDashboard has its own "HA Energy Mapping" tab, so don't also render it in the HA form.
      const props = node.key === 'HomeAssistant' ? (node.properties || []).filter((p: any) => p.key !== 'EnergyDashboard') : node.properties;
      renderObjectBody(props, state.data[node.key], sec);
    }
    else renderNode(node, state.data, sec);
    if (node.key === 'Gui') wireGuiAuth(sec);
    else if (node.key === 'EmonCMS') wireEmonCmsTransport(sec);
    else if (node.key === 'Api') wireApiDocs(sec);
    link.onclick = () => activate(link, sec);
  }
  return link;
}

export function build() {
  const nav: any = document.getElementById('nav'); const sections: any = document.getElementById('sections');
  nav.innerHTML = ''; sections.innerHTML = '';

  const byKey = new Map(state.schema.map((n: any) => [n.key, n]));
  // EnergyFlow has a dedicated visual editor (Flow/Nodes tabs), so its raw schema form is hidden here.
  const HIDDEN = new Set(['EnergyFlow']);
  // Any schema section not explicitly grouped (and not hidden) lands in System, so a new one is never lost.
  const knownSchema = new Set(NAV_GROUPS.flatMap(g => g.items.filter(i => 'schema' in i).map((i: any) => i.schema)));
  const system = NAV_GROUPS.find(g => g.title === 'System')!;
  state.schema.forEach((n: any) => { if (!knownSchema.has(n.key) && !HIDDEN.has(n.key)) system.items.push({ schema: n.key }); });

  // The landing page: a status board, rendered first so it's the default tab (#186).
  const home = addHomeSection(nav, sections);
  const first: any = home.link;

  for (const g of NAV_GROUPS) {
    // Drop items whose schema section is absent (e.g. Logging is hidden from the schema under Kubernetes).
    const items = g.items.filter(it => 'tool' in it || byKey.get((it as any).schema));
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
  const target = wanted ? ([...nav.querySelectorAll('a')] as any[]).find(a => slug(a.textContent) === wanted) : null;
  (target || first)?.click();
}

// In the Gui section, grey out the auth fields that don't apply to the selected AuthType.
function wireGuiAuth(sec: any) {
  const oidcFs = [...sec.querySelectorAll('fieldset')].find((fs: any) => fs.querySelector('legend')?.textContent === 'Oidc') as any;
  // The AuthType dropdown is the only select in the Gui section (outside the Oidc fieldset).
  const authSelect = [...sec.querySelectorAll('.field select')].find((s: any) => !oidcFs || !oidcFs.contains(s)) as any;
  if (!authSelect) return;
  // Basic-auth fields = text/password inputs of the Gui section, outside the Oidc fieldset.
  const basicInputs = [...sec.querySelectorAll('.field input')].filter((i: any) => (!oidcFs || !oidcFs.contains(i)) && (i.type === 'text' || i.type === 'password'));
  const oidcInputs = oidcFs ? [...oidcFs.querySelectorAll('input, select, textarea')] : [];
  const setOff = (els: any[], off: boolean) => els.forEach((e: any) => { e.disabled = off; e.style.opacity = off ? '0.5' : '1'; });
  const apply = () => {
    const t = authSelect.value;
    setOff(basicInputs, t !== 'Basic');
    setOff(oidcInputs, t !== 'Oidc');
  };
  authSelect.addEventListener('change', apply);
  apply();
}

// In the EmonCMS section, hide the fields that don't apply to the selected Transport (Http vs Mqtt).
function wireEmonCmsTransport(sec: any) {
  const fields = [...sec.querySelectorAll('.field')] as any[];
  const field = (label: string) => fields.find(f => f.querySelector('label')?.textContent === label);
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
    urlKey.forEach((f: any) => f.style.display = (t === 'Http' || feedsAuto?.checked) ? '' : 'none');
    if (pathField) pathField.style.display = t === 'Http' ? '' : 'none';
    mqttOnly.forEach((f: any) => f.style.display = t === 'Mqtt' ? '' : 'none');
  };
  transportSel.addEventListener('change', apply);
  feedsAuto?.addEventListener('change', apply);
  apply();
}

// The API section advertises OpenAPI/Scalar docs but never said where they live (#190). Show the real
// URLs, derived from the configured port. The API listens on its own port, so the links are built from
// this page's hostname rather than its path — they are only reachable if that port is exposed to you.
function wireApiDocs(sec: any) {
  const fields = [...sec.querySelectorAll('.field')] as any[];
  const field = (label: string) => fields.find(f => f.querySelector('label')?.textContent === label);
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

// Section-specific action buttons (connection tests; Home Assistant discovery actions).
function sectionActions(node: any) {
  const bar = document.createElement('div'); bar.className = 'sec-actions';
  const add = (label: string, fn: any, cls?: string) => { const b = btn(label, cls); b.onclick = fn; bar.appendChild(b); };

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

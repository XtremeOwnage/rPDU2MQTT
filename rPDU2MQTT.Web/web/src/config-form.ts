// Schema-driven config form, nav, and build().
import { ensure, el, btn, activate, slug, api, toast, navLink, navLabel } from './helpers.js';
import { templateHelp } from './template-field.js';
import { state } from './state.js';
import { expectRestart } from './realtime.js';
import { registerField, clearFieldRegistry, refreshDirty, onDirty, changeCountFor } from './dirty.js';
import { renderOverrides, previewOverridePaths } from './overrides.js';
import { tagInput } from './tags.js';
import { testMqtt, testPdu, testEmonCms, provisionEmonCmsFeeds, deleteEmonCmsFeeds, cleanupEmonCmsInputs, cleanupEmonCmsFeeds, rediscoverHa, clearHa, testModbus, testHistory, integrationActionBar } from './actions.js';
import { addPathsSection } from './sections/paths.js';
import { addDiagnosticsSection } from './sections/diagnostics.js';
import { addControlSection } from './sections/control.js';
import { addLiveDataSection } from './sections/livedata.js';
import { addFlowSection, addNodesSection, addEnergyOverviewSection, addMqttImportSection } from './sections/flow.js';
import { addNodeDataSection } from './sections/nodedata.js';
import { addTrendsSection } from './sections/trends.js';
import { renderPduTags } from './sections/pdu-tags.js';
import { openMqttExplorer, openRegisterExplorer } from './sections/explorer.js';
import { addNodeTrendsSection } from './sections/node-trends.js';
import { addGroupsSection } from './sections/groups.js';
import { addBalanceSection } from './sections/balance.js';
import { addCircuitFinderSection } from './sections/circuit-finder.js';
import { addPanelScheduleSection } from './sections/panel-schedule.js';
import { addFloorPlanSection } from './sections/floor-plan.js';
import { pluginPages, pluginPageTool } from './plugin-pages.js';
import { addExportSection } from './sections/export.js';
import { addHaEnergySection } from './sections/ha-energy.js';
import { addTagsSection } from './sections/tags-page.js';
import { addHomeSection } from './sections/home.js';
import { addOverviewSection } from './sections/overview.js';
import { addDiscoveryCleanup } from './sections/ha-cleanup.js';
import { featureToggle } from './sections/features.js';

function scalarInput(node: any, obj: any): any {
  const touched = () => refreshDirty();
  let el: any;
  if (node.type === 'bool') {
    el = document.createElement('input'); el.type = 'checkbox'; el.className = 'switch'; el.checked = !!(obj[node.key] ?? node.default);
    el.onchange = () => { obj[node.key] = el.checked; touched(); };
  } else if (node.type === 'enum') {
    el = document.createElement('select');
    // A blank choice means unset; leave the field out.
    const choices: string[] = (node.enumValues || []).slice();
    // Keep an unrecognised saved value on the list.
    const current = obj[node.key];
    if (current != null && current !== '' && !choices.includes(String(current))) choices.push(String(current));
    choices.forEach((v: string) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === '' ? '(default)' : v + ((node.enumValues || []).includes(v) ? '' : ' — not recognised');
      el.appendChild(o);
    });
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => { obj[node.key] = el.value === '' ? undefined : el.value; touched(); };
  } else if (node.type === 'int' || node.type === 'double') {
    el = document.createElement('input'); el.type = 'number'; if (node.type === 'double') el.step = 'any';
    if (node.min != null) el.min = node.min; if (node.max != null) el.max = node.max;
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => { obj[node.key] = el.value === '' ? null : Number(el.value); touched(); };
  } else {
    el = document.createElement('input'); el.type = node.type === 'password' ? 'password' : 'text';
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => { obj[node.key] = el.value === '' ? null : el.value; touched(); };
  }
  // Settings whose "off" would lock the GUI out are shown disabled (schema notEditableReason).
  if (node.notEditableReason) {
    el.disabled = true;
    el.title = node.notEditableReason;
  }
  return el;
}

function switchWrap(input: any) {
  const label = el('span', { class: 'switch-state', text: input.checked ? 'On' : 'Off' });
  const wrap = el('label', { class: 'switch-wrap' }, input, label);
  const sync = () => label.textContent = input.checked ? 'On' : 'Off';
  const prior = input.onchange;
  input.onchange = (e: any) => { prior?.(e); sync(); };
  return wrap;
}

// Render an object's properties: scalars in a multi-column grid, collections full-width.
// `path` locates `target` in the config document.
function renderObjectBody(properties: any[], target: any, container: any, path: string[] = []) {
  const isComplex = (c: any) => c.type === 'object' || c.type === 'list' || c.type === 'dictionary';
  const scalars = (properties || []).filter(c => !isComplex(c));
  const complex = (properties || []).filter(isComplex);
  const fields = new Map<string, any>();

  // Schema-grouped settings render together in a box, in first-appearance order.
  const into = (list: any[], host: any) => {
    const grid = document.createElement('div'); grid.className = 'grid';
    list.forEach(child => {
      renderNode(child, target, grid, path);
      fields.set(child.key, grid.children[grid.children.length - 1]);
    });
    host.appendChild(grid);
  };

  const loose = scalars.filter(c => !c.group);
  if (loose.length) into(loose, container);

  const groups: string[] = [];
  scalars.forEach(c => { if (c.group && !groups.includes(c.group)) groups.push(c.group); });
  groups.forEach(name => {
    const box = document.createElement('fieldset'); box.className = 'setting-group';
    const legend = document.createElement('legend'); legend.textContent = name; box.appendChild(legend);
    into(scalars.filter(c => c.group === name), box);
    container.appendChild(box);
  });

  if (scalars.length) wireVisibility(scalars, target, fields);
  complex.forEach(child => renderNode(child, target, container, path));
}

// Shown only when another setting has a given value (schema visibleWhen).
function wireVisibility(props: any[], target: any, fields: Map<string, any>) {
  props.filter(p => p.visibleWhen).forEach(p => {
    const field = fields.get(p.key);
    if (!field) return;
    // Unset means the deciding setting is at its default.
    const decider = props.find((x: any) => x.key === p.visibleWhen.key);
    const sync = () => {
      const cur = target[p.visibleWhen.key] ?? decider?.default ?? '';
      show(field, p.visibleWhen.values.includes(String(cur)));
    };
    sync();
    visibilitySyncs.push(sync);
  });
}

// Re-checks for every conditional field; rebuilt with the form.
let visibilitySyncs: (() => void)[] = [];
let visibilityOff: any = null;
const runVisibilitySyncs = () => visibilitySyncs.forEach(s => s());

// Re-evaluate feature-hidden nav entries on page change; registered once.
window.addEventListener?.('rpdu:activate', runVisibilitySyncs);

function show(elm: any, on: boolean) { elm.classList[on ? 'remove' : 'add']('is-hidden'); }

/// PreferEmonCms -> "Prefer EmonCMS"; acronyms are restored after the split.
function humanise(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bEmon\s*Cms\b/gi, 'EmonCMS')
    .replace(/^./, c => c.toUpperCase());
}

/// A radio group for a small closed set, each choice with its own tooltip.
function radioGroup(node: any, obj: any) {
  const wrap = document.createElement('div');
  wrap.className = 'radio-group';
  const name = `r${Math.random().toString(36).slice(2)}`;
  const current = () => String(obj[node.key] ?? node.default ?? (node.enumValues || [])[0] ?? '');
  (node.enumValues || []).forEach((v: string, i: number) => {
    const why = (node.enumDescriptions || [])[i] || '';
    const lab = document.createElement('label');
    lab.className = 'radio';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = name; input.value = v;
    input.checked = current() === v;
    input.onchange = () => { if (input.checked) { obj[node.key] = v; refreshDirty(); runVisibilitySyncs(); } };
    const text = document.createElement('span'); text.textContent = humanise(v);
    lab.appendChild(input); lab.appendChild(text);
    // Info mark carrying the choice's explanation.
    if (why) {
      const hint = document.createElement('span');
      hint.className = 'hint'; hint.textContent = 'ⓘ'; hint.title = why;
      lab.appendChild(hint);
    }
    wrap.appendChild(lab);
  });
  return wrap;
}

/// Render one schema section's settings into another page.
export function renderSettingsOf(key: string, container: any) {
  const node = (state.schema || []).find((n: any) => n.key === key);
  if (!node?.properties) return;
  renderObjectBody(node.properties, ensure(state.data, key, {}), container, [key]);
}

export function renderNode(node: any, obj: any, container: any, path: string[] = []) {
  const here = [...path, node.key];
  if (node.type === 'object') {
    const target = ensure(obj, node.key, {});
    const fs = document.createElement('fieldset');
    const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
    renderObjectBody(node.properties, target, fs, here);
    container.appendChild(fs);
  } else if (node.type === 'dictionary') {
    container.appendChild(renderMap(node, ensure(obj, node.key, {}), here));
  } else if (node.type === 'list') {
    container.appendChild(renderList(node, ensure(obj, node.key, []), here));
  } else {
    const f = document.createElement('div'); f.className = 'field';
    f.dataset.key = node.key;
    // Config path of this control, for devtools and checks.
    f.dataset.path = here.join('.');
    // A blank label means something beside the control already names it.
    if (node.label !== '') { const lab = document.createElement('label'); lab.textContent = node.label; f.appendChild(lab); }
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; f.appendChild(d); }
    const input = node.radio ? radioGroup(node, obj) : scalarInput(node, obj);
    f.appendChild(node.type === 'bool' ? switchWrap(input) : node.type === 'password' ? revealWrap(input) : input);
    if (node.notEditableReason) {
      const why = document.createElement('div');
      why.className = 'desc field-locked';
      why.textContent = node.notEditableReason;
      f.appendChild(why);
    }
    if (node.templateVars && node.templateVars.length) f.appendChild(templateVarChips(node.templateVars, input, obj, node));
    // A password's value must never reach the change-review list.
    registerField(here, f, node.type === 'password');
    container.appendChild(f);
  }
}

// A templated field's placeholders: what each means, an example, and a preview of the result.
function templateVarChips(vars: string[], input: any, _obj: any, node: any) {
  return templateHelp(input, vars, { blankTemplate: typeof node.default === 'string' ? node.default : undefined });
}

/// The same schema minus the field that names the entry, which is shown as its heading instead.
function withoutKey(valueSchema: any, key: string) {
  if (!valueSchema || valueSchema.type !== 'object' || !valueSchema.properties) return valueSchema;
  return Object.assign({}, valueSchema, { properties: valueSchema.properties.filter((p: any) => p.key !== key) });
}

/// A measurement type as it is written down, in the words the rest of the GUI uses for it.
const TYPE_LABELS: Record<string, string> = {
  realpower: 'Power', apparentpower: 'Apparent power', energy: 'Energy', energy_d: 'Energy Daily',
  current: 'Current', voltage: 'Voltage', frequency: 'Frequency', powerfactor: 'Power factor',
};
function labelFor(value: string) { return TYPE_LABELS[value] || value; }

// Render a dictionary/list element's value; `path` addresses the element.
/// Returns the node the control is bound to.
function renderValue(valueSchema: any, holder: any, keyName: any, container: any, path: string[], inline = false) {
  const node = Object.assign({}, valueSchema, { key: keyName, label: inline ? '' : 'value' });
  if (node.type === 'object') {
    const target = ensure(holder, keyName, {});
    // A dictionary/list entry's fields (e.g. each PDU instance): scalars in columns, collections full-width.
    renderObjectBody(node.properties, target, container, path);
  } else {
    renderNode(node, holder, container, path.slice(0, -1));
  }
  return node;
}

function renderMap(node: any, mapObj: any, path: string[]) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
  if (node.mapExample) {
    const ex = document.createElement('div'); ex.className = 'desc map-example'; ex.textContent = node.mapExample;
    fs.appendChild(ex);
  }
  const entries = document.createElement('div'); fs.appendChild(entries);

  // A map of scalars renders one row per entry; a map of objects renders cards.
  const inline = !node.valueSchema || node.valueSchema.type !== 'object';

  const drawEntry = (key: string) => {
    const wrap = document.createElement('div'); wrap.className = 'map-entry' + (inline ? ' inline' : '');
    const keyIn = document.createElement('input'); keyIn.className = 'key'; keyIn.type = 'text'; keyIn.value = key;
    const del = btn('Remove', 'danger');
    del.onclick = () => { delete mapObj[key]; entries.removeChild(wrap); refreshDirty(); };
    if (mapObj[key] == null) mapObj[key] = (node.valueSchema && node.valueSchema.type === 'object') ? {} : '';

    let bound: any;
    if (inline) {
      wrap.appendChild(keyIn);
      bound = renderValue(node.valueSchema, mapObj, key, wrap, [...path, key], true);
      wrap.appendChild(del);
    } else {
      const head = document.createElement('div'); head.className = 'head';
      head.appendChild(keyIn); head.appendChild(del); wrap.appendChild(head);
      bound = renderValue(node.valueSchema, mapObj, key, wrap, [...path, key]);
    }
    // Rebind the control to the renamed key.
    keyIn.onchange = () => {
      if (!keyIn.value || keyIn.value === key) return;
      mapObj[keyIn.value] = mapObj[key];
      delete mapObj[key];
      key = keyIn.value;
      if (bound) bound.key = key;
      refreshDirty();
    };
    entries.appendChild(wrap);
  };

  // Column headings for key/value rows.
  if (inline) {
    const head = document.createElement('div'); head.className = 'map-head';
    const k = document.createElement('span'); k.textContent = node.keyLabel || 'Key';
    const v = document.createElement('span'); v.textContent = node.valueLabel || 'Value';
    head.appendChild(k); head.appendChild(v);
    entries.appendChild(head);
  }

  Object.keys(mapObj).forEach(drawEntry);
  const add = btn('+ Add');
  add.onclick = () => { let k = 'new'; let i = 1; while (mapObj[k] !== undefined) k = 'new' + (i++); mapObj[k] = node.valueSchema.type === 'object' ? {} : ''; drawEntry(k); refreshDirty(); };
  fs.appendChild(add);
  return fs;
}

function renderList(node: any, arr: any[], path: string[]) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);

  // Tag lists are picked from defined tags, not typed.
  if (node.tagChoices) {
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
    const picker = tagInput(arr, { strict: true });
    fs.appendChild(picker);
    registerField([...path], fs as any, false);
    return fs;
  }

  const entries = document.createElement('div'); fs.appendChild(entries);
  // A fixed list: entries are titled by fixedListKey, with no Add or Remove.
  const fixedKey: string | undefined = node.fixedListKey;
  const draw = (idx: number) => {
    const wrap = document.createElement('div'); wrap.className = 'list-entry';
    if (fixedKey) {
      const head = document.createElement('div'); head.className = 'head';
      const name = document.createElement('strong');
      name.textContent = labelFor(String((arr[idx] || {})[fixedKey] ?? ''));
      head.appendChild(name); wrap.appendChild(head);
    } else {
      const del = btn('Remove', 'danger');
      del.onclick = () => { arr.splice(idx, 1); rebuild(); refreshDirty(); };
      wrap.appendChild(del);
    }
    renderValue(fixedKey ? withoutKey(node.valueSchema, fixedKey) : node.valueSchema, arr, idx, wrap, [...path, String(idx)]);
    entries.appendChild(wrap);
  };
  const rebuild = () => { entries.innerHTML = ''; arr.forEach((_, i) => draw(i)); };
  rebuild();
  if (!fixedKey) {
    const add = btn('+ Add');
    add.onclick = () => { arr.push(node.valueSchema.type === 'object' ? {} : ''); rebuild(); refreshDirty(); };
    fs.appendChild(add);
  }
  return fs;
}

// Nav groups; ungrouped schema sections fall into System.
/// `after` names the schema section(s) a tool follows; without it a tool goes to the end of its group.
type NavItem = { schema: string, child?: boolean }
  | { tool: (nav: any, sections: any) => any, child?: boolean, after?: string | string[] };
/** Anchors for the PDU tabs, in order of preference. */
const PDU_BLOCK = ['Overrides', 'Pdus'];
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  // Sources: the PDU tabs are children of the Vertiv rPDU page.
  { title: 'Sources', items: [{ tool: addLiveDataSection, child: true, after: PDU_BLOCK }, { tool: addControlSection, child: true, after: PDU_BLOCK }, { tool: addPathsSection, child: true, after: PDU_BLOCK }] },
  { title: 'Energy Flow', items: [{ tool: addEnergyOverviewSection }, { tool: addNodesSection }, { tool: addGroupsSection, child: true }, { tool: addBalanceSection, child: true }, { tool: addTagsSection }, { tool: addFlowSection }, { tool: addTrendsSection }, { tool: addNodeTrendsSection }, { tool: addCircuitFinderSection }, { tool: addPanelScheduleSection }, { tool: addFloorPlanSection }, { tool: addNodeDataSection }] },
  { title: 'Integrations', items: [{ tool: addMqttImportSection, child: true, after: 'MQTT' }] },
  { title: 'Destinations', items: [{ tool: addHaEnergySection, child: true, after: 'HomeAssistant' }] },
  { title: 'System', items: [{ tool: addHomeSection }, { tool: addExportSection }, { tool: addDiagnosticsSection }] },
];

// Display-label fixes, keyed by schema section key.
const LABEL_OVERRIDES: Record<string, string> = { Pdus: 'Vertiv rPDU', Api: 'API', Gui: 'GUI', Modbus: 'Modbus TCP', HomeAssistant: 'Home Assistant' };

// A leading glyph per schema-driven page; unlisted sections get the neutral bullet.
const NAV_ICONS: Record<string, string> = {
  'Vertiv rPDU': '▤', 'Overrides': '✎', 'MQTT': '⇅', 'Modbus TCP': '⧉', 'EmonCMS': '▦',
  'Home Assistant': '⌂', 'Prometheus': '◎', 'GUI': '▭', 'API': '⚙',
  'Health': '♥', 'Logging': '☰', 'Debug': '⚑', 'Operator': '⎈',
};
function navIcon(label: string) { return NAV_ICONS[label] || '•'; }

// A collapsible nav group; returns the container its links are appended into.
function navGroup(nav: any, title: string) {
  const wrap = el('div', { class: 'nav-group-wrap' });
  const header = el('div', { class: 'nav-group', text: title });
  const items = el('div', { class: 'nav-group-items' });
  header.onclick = () => wrap.classList.toggle('collapsed');
  wrap.append(header, items); nav.appendChild(wrap);
  return items;
}

// A credential field with a show/hide button, hidden by default.
function revealWrap(input: any) {
  const wrap = el('div', { class: 'reveal-wrap' });
  const eye = btn('Show');
  eye.type = 'button';
  eye.className = 'small reveal-btn';
  eye.title = 'Show this value';
  eye.onclick = () => {
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    eye.textContent = hidden ? 'Hide' : 'Show';
    eye.title = hidden ? 'Hide this value' : 'Show this value';
  };
  wrap.append(input, eye);
  return wrap;
}

// The History page's extras, each placed in its settings' box.
function historyBox(sec: any, name: string) {
  const found = [...sec.querySelectorAll('fieldset.setting-group')].find((f: any) => f.querySelector('legend')?.textContent === name);
  if (found) return found;
  const box = el('fieldset', { class: 'setting-group' }, el('legend', { text: name }));
  sec.appendChild(box);
  return box;
}

// Link to the EmonCMS export page, whose feeds EmonCMS history reads.
function wireHistoryProvider(sec: any) {
  const wrap = el('div', { class: 'desc feature-pointer' });
  wrap.appendChild(el('span', { text: 'EmonCMS history reads the feeds the EmonCMS export writes. Its server, API key and feed names are configured on the EmonCMS page. ' }));
  const go = btn('EmonCMS');
  go.onclick = () => jumpToSection('EmonCMS');
  wrap.appendChild(go);
  historyBox(sec, 'Reading').appendChild(wrap);

  const sync = () => show(wrap, (state.data.History || {}).Provider === 'emoncms');
  sync();
  visibilitySyncs.push(sync);

  // An empty LocalPath resolves at runtime; show where readings actually go.
  const where = el('div', { class: 'history-facts' });
  historyBox(sec, 'Local storage').appendChild(where);
  api('/api/history/store').then((r: any) => {
    const b = r?.body;
    if (!b?.ok) { where.hidden = true; return; }
    const size = b.bytes > 1024 * 1024 ? `${(b.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b.bytes / 1024)} KB`;
    where.append(
      fact(b.recording ? 'Writing to' : 'Not writing; stored in', b.path, b.fromEnvironment ? 'from RPDU2MQTT_HISTORY_DIRECTORY, because the directory setting is empty' : ''),
      fact('Oldest reading', b.oldest ? when(b.oldest) : 'none yet'),
      fact('Series', String(b.series)),
      fact('Size', size));
  }).catch(() => { where.hidden = true; });

  historyBox(sec, 'Copy history').appendChild(historyCopyPanel());
}

function fact(label: string, value: string, note = '') {
  return el('div', { class: 'history-fact' }, el('span', { class: 'desc', text: label }), el('strong', { text: value }),
    note ? el('span', { class: 'desc', text: note }) : null);
}

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function every(seconds: number) {
  return seconds >= 86400 ? 'a day' : seconds >= 3600 ? 'an hour' : seconds >= 60 ? 'a minute' : `${seconds}s`;
}

function duration(ms: number) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Copy every node's history from one backend into another; only what the destination lacks is written.
function historyCopyPanel() {
  const wrap = el('div');
  const from = el('select') as HTMLSelectElement;
  const to = el('select') as HTMLSelectElement;
  const days = el('input', { type: 'number', min: '0', step: '1', placeholder: 'all (ten years)' }) as HTMLInputElement;
  const conflicts = el('select') as HTMLSelectElement;
  const keep = el('option', { value: 'keep', text: 'Fill gaps only — keep what the destination has' });
  const replace = el('option', { value: 'replace', text: 'Replace with the source\'s reading' });
  conflicts.append(keep, replace);
  const conflictNote = el('div', { class: 'desc' });
  conflictNote.hidden = true;
  let backends: any[] = [];
  // Replacing is only offered where the destination can actually replace a reading.
  const syncConflicts = () => {
    const why = backends.find((x: any) => x.id === to.value)?.replace;
    replace.disabled = !!why;
    if (why) conflicts.value = 'keep';
    conflictNote.textContent = why ? `Replacing is not available for ${to.value}: ${why}.` : '';
    conflictNote.hidden = !why;
  };
  to.onchange = syncConflicts;
  conflicts.onchange = syncConflicts;
  const go = btn('Copy history', 'primary');
  const field = (label: string, control: any, note = '') =>
    el('div', { class: 'field' }, el('label', { text: label }), note ? el('div', { class: 'desc', text: note }) : null, control);
  wrap.append(
    el('div', { class: 'grid' },
      field('From', from),
      field('To', to, 'Only local and EmonCMS can be written.'),
      field('Days back', days, 'Empty is ten years.'),
      el('div', { class: 'field' }, el('label', { text: 'When both have a reading' }), conflictNote, conflicts)),
    el('div', { class: 'ld-toolbar' }, go));

  // Progress of the running copy.
  const pill = el('span', { class: 'pill' });
  const route = el('strong');
  const bar = el('span', { style: { width: '0%' } });
  const facts = el('div', { class: 'history-facts' });
  const note = el('div', { class: 'desc' });
  const status = el('div', { class: 'history-copy-status' }, el('div', { class: 'history-copy-head' }, pill, route), el('div', { class: 'progress' }, bar), facts, note);
  wrap.appendChild(status);

  let timer: any = null;
  const render = (s: any) => {
    if (!s) return;
    const started = s.started ? new Date(s.started).getTime() : 0;
    const ended = s.finished ? new Date(s.finished).getTime() : Date.now();
    const done = s.readsDone || 0, total = s.reads || 0;
    const stopped = !s.running && typeof s.message === 'string' && s.message.startsWith('Copy stopped');
    status.hidden = !started;
    pill.className = 'pill ' + (s.running ? 'warn' : stopped || s.readsFailed ? 'bad' : 'good');
    pill.textContent = s.running ? 'Running' : stopped ? 'Stopped' : 'Finished';
    route.textContent = s.from ? `${s.from} → ${s.to}, ${s.conflicts === 'replace' ? 'replacing' : 'filling gaps'}` : '';
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    bar.style.width = `${s.running ? pct : total ? pct : 0}%`;
    facts.replaceChildren(
      fact('Progress', total ? `${pct.toFixed(1)}%` : 'starting', total ? `${done.toLocaleString()} of ${total.toLocaleString()} reads` : ''),
      s.running && s.window ? fact('Reading now', `${when(s.window.from)} → ${when(s.window.to)}`, `every ${every(s.window.intervalSeconds)}`) : null,
      fact('Copied back to', s.oldestCopied ? when(s.oldestCopied) : 'nothing yet', s.newestCopied ? `newest ${when(s.newestCopied)}` : ''),
      fact('Readings copied', (s.readingsCopied || 0).toLocaleString()),
      fact('Written', (s.slotsWritten || 0).toLocaleString()),
      fact('Already complete', s.seriesChecked ? `${(100 * (s.seriesComplete || 0) / s.seriesChecked).toFixed(0)}%` : '—',
        `${(s.seriesComplete || 0).toLocaleString()} of ${(s.seriesChecked || 0).toLocaleString()}`),
      fact('Incomplete reads', (s.readsFailed || 0).toLocaleString(), s.feedsFailed ? `${s.feedsFailed.toLocaleString()} feed reads failed after 3 tries; run it again to fill them` : ''),
      fact(s.running ? 'Elapsed' : 'Took', started ? duration(ended - started) : '—'),
      s.running && done > 0 && total > done ? fact('Remaining', `about ${duration((ended - started) / done * (total - done))}`) : null);
    note.textContent = s.running ? '' : s.message || '';
    go.disabled = !!s.running;
    clearTimeout(timer);
    if (s.running && wrap.isConnected) timer = setTimeout(refresh, 3000);
  };
  const refresh = () => api('/api/history/copy').then((r: any) => {
    const b = r?.body;
    if (!b?.ok) { wrap.replaceChildren(el('div', { class: 'desc', text: b?.message || 'History copying is not available.' })); return; }
    if (!from.options.length) {
      backends = b.backends || [];
      for (const x of b.backends || []) {
        from.append(el('option', { value: x.id, text: x.id + (x.read ? ` (${x.read})` : ''), disabled: !!x.read }));
        to.append(el('option', { value: x.id, text: x.id + (x.write ? ' (read only)' : ''), disabled: !!x.write, title: x.write || '' }));
      }
      // Default: the first readable backend into local.
      const readable = (b.backends || []).find((x: any) => !x.read && x.id !== 'local');
      if (readable) from.value = readable.id;
      if ((b.backends || []).some((x: any) => x.id === 'local' && !x.write)) to.value = 'local';
      syncConflicts();
    }
    render(b.status);
  }).catch(() => { status.hidden = true; });

  go.onclick = async () => {
    if (conflicts.value === 'replace'
      && !confirm(`Replace readings in ${to.value} with ${from.value}'s wherever both have one? What ${to.value} held there is overwritten.`)) return;
    const q = `from=${encodeURIComponent(from.value)}&to=${encodeURIComponent(to.value)}&days=${encodeURIComponent(days.value || '0')}&conflicts=${conflicts.value}`;
    const r: any = await api(`/api/history/copy?${q}`, { method: 'POST' });
    toast(r?.body?.message || 'Copy failed.', !!r?.body?.ok);
    refresh();
  };
  status.hidden = true;
  refresh();
  return wrap;
}

// A disabled feature's settings page is still built, but its nav entry is hidden.
function hideWhileOff(link: any, sectionKey: string, feature: any) {
  const sync = () => {
    const cur = (state.data[sectionKey] || {})[feature.key];
    const on = cur == null ? !!feature.default : !!cur;
    // Never hide the active page.
    show(link, on || link.classList.contains('active'));
  };
  sync();
  visibilitySyncs.push(sync);
}

// Render one schema-driven config section (nav link + panel); returns the nav link.
function renderConfigSection(node: any, nav: any, sections: any) {
  const label = LABEL_OVERRIDES[node.key] || node.label;
  const link = navLink(nav, label, navIcon(label));
  // The document section this page edits, for the nav's pending-edit count.
  link.dataset.section = node.key;
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = label; sec.appendChild(h);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; sec.appendChild(d); }
  const acts = sectionActions(node);
  if (acts) sec.appendChild(acts);
  if (node.key === 'Overrides') {
    // Live-data-driven editor instead of the dictionary form.
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
      let props = node.properties;
      // A feature's on/off switch lives on the Features page, so it is removed here.
      const feature = featureToggle(node);
      if (feature) {
        props = (props || []).filter((p: any) => p !== feature);
        hideWhileOff(link, node.key, feature);
      }
      // Plugin settings live under Plugins/<id>.
      const target = node.isPlugin
        ? ensure(ensure(state.data, 'Plugins', {}), node.key, {})
        : state.data[node.key];
      const path = node.isPlugin ? ['Plugins', node.key] : [node.key];
      renderObjectBody(props, target, sec, path);
    }
    else renderNode(node, state.data, sec, []);
    if (node.isPlugin) integrationActionBar(node.key).then(bar => { if (bar) sec.appendChild(bar); });
    if (node.key === 'HomeAssistant') addDiscoveryCleanup(sec);
    if (node.key === 'History') wireHistoryProvider(sec);
    if (node.key === 'Gui') wireGuiAuth(sec);
    else if (node.key === 'EmonCMS') wireEmonCmsTransport(sec);
    else if (node.key === 'Api') wireApiDocs(sec);
    else if (node.key === 'Operator') { wireOperatorCheck(sec); wireOperatorSwitch(sec); }
    link.onclick = () => activate(link, sec);
  }
  if (node.key === 'Pdus') {
    // The Vertiv plugin's own settings (Enabled) sit on this page.
    const vertiv = state.schema.find((n: any) => n.isPlugin && n.key === 'vertiv');
    if (vertiv) {
      const box = el('fieldset', { class: 'setting-group' }, el('legend', { text: 'Plugin' }));
      renderObjectBody(vertiv.properties, ensure(ensure(state.data, 'Plugins', {}), 'vertiv', {}), box, ['Plugins', 'vertiv']);
      sec.insertBefore(box, sec.children[1] ?? null);
    }
    const tags = renderPduTags();
    sec.appendChild(tags.el);
    const open = link.onclick;
    link.onclick = (ev: any) => { open?.call(link, ev); tags.load(); };
  }
  return link;
}

export function build() {
  const nav: any = document.getElementById('nav'); const sections: any = document.getElementById('sections');
  nav.innerHTML = ''; sections.innerHTML = '';
  clearFieldRegistry();
  visibilitySyncs = [];

  const byKey = new Map(state.schema.map((n: any) => [n.key, n]));
  // Sections with no page of their own.
  const HIDDEN = new Set(['EnergyFlow', 'Plugins', 'Health', 'Debug', 'PlanStorage', 'Api', 'Cache', 'vertiv']);
  // Schema sections are placed by their declared group (System if none); tools follow them.
  const navGroups = NAV_GROUPS.map(g => ({ title: g.title, items: [] as NavItem[] }));
  const groupFor = (title: string) => navGroups.find(g => g.title === title) ?? navGroups.find(g => g.title === 'System')!;

  state.schema.forEach((n: any) => {
    if (HIDDEN.has(n.key)) return;
    groupFor(n.group || 'System').items.push({ schema: n.key });
  });
  const navItems = NAV_GROUPS.map(g => [...g.items]);
  pluginPages.forEach(p => (navItems[NAV_GROUPS.findIndex(g => g.title === p.group)] ?? navItems[navItems.length - 1]).push({ tool: pluginPageTool(p) }));
  navItems.forEach((list, i) => list.forEach(it => {
    // Place a tool after its first present anchor, behind tools already there; otherwise at the end.
    const items = navGroups[i].items;
    const after = 'after' in it && it.after ? ([] as string[]).concat(it.after) : [];
    let at = -1;
    for (const key of after) { at = items.findIndex(x => 'schema' in x && x.schema === key); if (at >= 0) break; }
    if (at < 0) { items.push(it); return; }
    while (at + 1 < items.length && 'tool' in items[at + 1] && (items[at + 1] as any).after === it.after) at++;
    items.splice(at + 1, 0, it);
  }));

  // The landing page, first so it is the default tab.
  const overview = addOverviewSection(nav, sections);
  const first: any = overview.link;

  for (const g of navGroups) {
    // Drop items whose schema section is absent.
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

  // Open the tab named in the URL hash, else the first.
  const wanted = decodeURIComponent((location.hash || '').slice(1));
  const target = wanted ? ([...nav.querySelectorAll('a')] as any[]).find(a => slug(navLabel(a)) === wanted) : null;
  (target || first)?.click();

  // One subscription re-runs every conditional field's check.
  visibilityOff?.();
  visibilityOff = onDirty(runVisibilitySyncs);

  wireNavBadges(nav);
}

// Each config page's nav entry shows its unsaved-edit count.
let navBadgesOff: any = null;
function wireNavBadges(nav: any) {
  navBadgesOff?.();
  const links = ([...nav.querySelectorAll('a')] as any[]).filter(a => a.dataset?.section);
  const claimed = links.flatMap(a => String(a.dataset.section).split(',').map((s: string) => s.trim()));
  navBadgesOff = onDirty(() => links.forEach(a => {
    const n = changeCountFor(a.dataset.section, claimed);
    const existing = a.querySelector('.nav-badge');
    if (!n) { existing?.remove(); return; }
    if (existing) existing.textContent = String(n);
    else a.appendChild(el('span', { class: 'nav-badge', text: String(n), title: n + ' unsaved change(s) on this page' }));
  }));
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
  // Url/ApiKey are needed for HTTP transport and feed auto-config; Path is HTTP only.
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

// Show the OpenAPI/Scalar doc URLs, built from this page's hostname and the API port.
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
      // Left clickable when the API is off; the row states why.
      if (!on) {
        a.style.opacity = '0.55';
        a.title = 'The API is disabled, so nothing is listening on this port yet — enable it above, save, and restart.';
        row.appendChild(document.createTextNode(label + ': '));
        row.appendChild(a);
        row.appendChild(el('span', { class: 'desc', style: { margin: '0 0 0 6px' }, text: '· API disabled' }));
      } else {
        row.appendChild(document.createTextNode(label + ': '));
        row.appendChild(a);
      }
      list.appendChild(row);
    }
  };

  portIn.addEventListener('input', apply);
  enabled?.addEventListener('change', apply);
  apply();
  sec.appendChild(box);
}

// Operator page: an on-demand, read-only update check.
function wireOperatorCheck(sec: any) {
  const box = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = 'Update check'; box.appendChild(lg);
  box.appendChild(el('div', { class: 'desc', text: 'Check the registry now and report whether a newer eligible version (bounded by Policy) is available. Read-only — this never changes the Deployment.' }));
  const row = el('div', { class: 'sec-actions' });
  const check = btn('Check now', 'primary');
  const result = el('div', { class: 'desc', style: { margin: '4px 0 0', fontSize: '13px' } });
  row.append(check); box.append(row, result);
  sec.appendChild(box);

  const show = (u: any) => {
    // Colour from the reported severity; `available` is the fallback for legacy reports.
    const msg = u?.message || (u?.available ? 'Update available.' : 'Up to date.');
    const sev = u?.severity ?? (u?.available ? 'UpdateAvailable' : 'Ok');
    if (sev === 'UpdateAvailable') { result.style.color = 'var(--warn, #fa4)'; result.textContent = '↑ ' + msg; }
    else if (sev === 'Ok') { result.style.color = 'var(--good)'; result.textContent = '✓ ' + msg; }
    else { result.style.color = 'var(--muted)'; result.textContent = msg; }   // Info / Error
    if (u?.checkedAt) result.textContent += ` · checked ${new Date(u.checkedAt).toLocaleTimeString()}`;
  };

  check.onclick = async () => {
    check.disabled = true;
    result.style.color = 'var(--muted)'; result.textContent = 'Checking the registry…';
    const r = await api('/api/operator/check', { method: 'POST' });
    check.disabled = false;
    if (!r.body?.ok) { result.style.color = 'var(--bad)'; result.textContent = r.body?.message || 'Check failed.'; return; }
    show(r.body.update);
  };
}

// Operator page: a channel/version switcher.
function wireOperatorSwitch(sec: any) {
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
    const forcedOk = res.ok && res.body?.ok;
    toast(res.body?.message || (res.ok ? 'Force update requested.' : 'Force update failed.'), forcedOk);
    if (forcedOk) {
      status.textContent = res.body.message;
      expectRestart('Re-pulling the deployed image');
      toast('Updating — the bridge is restarting. This page reconnects on its own.', true);
    }
  };

  const CHANNEL_LABEL: Record<string, string> = {
    stable: 'stable — newest release', latest: 'latest — newest release', edge: 'edge — main branch (bleeding edge)',
    dev: 'dev — work-in-progress builds', unstable: 'unstable — work-in-progress builds',
  };

  api('/api/operator/tags').then(r => {
    const b = r.body || {};
    if (!b.ok) { desc.textContent = b.message || 'Version switching is unavailable.'; sel.style.display = 'none'; switchBtn.style.display = 'none'; forceBtn.style.display = 'none'; return; }
    desc.innerHTML = `Roll the Deployment to a different image tag. Currently deployed: <b>${b.current || '—'}</b>. Switching restarts the workload (a normal rolling update).`;
    const group = (label: string, tags: string[], fmt: (t: string) => string) => {
      if (!tags || !tags.length) return;
      const og = document.createElement('optgroup'); og.label = label;
      tags.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = fmt(t); if (t === b.current) o.selected = true; og.appendChild(o); });
      sel.appendChild(og);
    };
    group('Channels', b.channels || [], (t: string) => CHANNEL_LABEL[t] || t);
    group('Versions', b.versions || [], (t: string) => t);
    if (!sel.options.length) { desc.textContent += ' No tags found in the registry.'; switchBtn.disabled = true; }

    switchBtn.onclick = async () => {
      const tag = sel.value; if (!tag) return;
      if (tag === b.current) { toast('That tag is already deployed.', false); return; }
      if (!confirm(`Switch the deployment to "${tag}"? This rolls the workload (all tiers) to that image.`)) return;
      switchBtn.disabled = true;
      const res = await api('/api/operator/set-tag?tag=' + encodeURIComponent(tag), { method: 'POST' });
      switchBtn.disabled = false;
      const switchedOk = res.ok && res.body?.ok;
      toast(res.body?.message || (res.ok ? 'Switch requested.' : 'Switch failed.'), switchedOk);
      if (switchedOk) {
        status.textContent = res.body.message;
        expectRestart(`Switching to ${tag}`);
        toast(`Updating to ${tag} — the bridge is restarting. This page reconnects on its own.`, true);
      }
    };
  }).catch(() => { desc.textContent = 'Could not load available versions.'; sel.style.display = 'none'; switchBtn.style.display = 'none'; forceBtn.style.display = 'none'; });
}

// A link to the configured system, shown only when a URL is set; href resolved on each visit.
function externalLink(label: string, href: () => string | null, hint: string) {
  const a: any = el('a', { class: 'ext-link', target: '_blank', rel: 'noopener', title: hint }, label + ' ↗');
  const sync = () => {
    const u = href();
    if (u) { a.href = u; a.title = hint + '\n' + u; a.classList.remove('is-hidden'); }
    else a.classList.add('is-hidden');
  };
  sync();
  // activate() fires on each tab switch, picking up URL edits.
  window.addEventListener?.('rpdu:activate', sync);
  return a;
}

// A configured URL, trimmed, only if it looks like one.
function cfgUrl(...path: string[]): string | null {
  let o: any = state.data;
  for (const p of path) { if (o == null) return null; o = o[p]; }
  const s = typeof o === 'string' ? o.trim() : '';
  return /^https?:\/\/.+/i.test(s) ? s.replace(/\/+$/, '') : null;
}

// Section-specific action buttons.
function sectionActions(node: any) {
  const bar = document.createElement('div'); bar.className = 'sec-actions';

  // The last action's result, shown on the page.
  const result = el('div', { class: 'desc test-result' });

  const add = (label: string, fn: any, cls?: string) => {
    const b = btn(label, cls);
    b.onclick = async () => {
      const was = b.textContent;
      b.disabled = true; b.textContent = 'Working…';
      result.textContent = '';
      result.className = 'desc test-result';
      try {
        const out: any = await fn();
        if (out && typeof out.message === 'string') {
          result.textContent = (out.ok ? '✓ ' : '✗ ') + out.message;
          result.classList.add(out.ok ? 'test-ok' : 'test-bad');
        }
      } catch (e: any) {
        // A throwing action must not leave the button stuck on "Working…".
        result.textContent = '✗ ' + (e?.message || e);
        result.classList.add('test-bad');
      } finally { b.disabled = false; b.textContent = was; }
    };
    bar.appendChild(b);
  };

  if (node.key === 'MQTT') { add('Test MQTT connection', testMqtt); add('Explore topics', async () => openMqttExplorer()); }
  else if (node.key === 'History') add('Test history backend', testHistory);
  else if (node.key === 'PDU') add('Test PDU connection', testPdu);
  else if (node.key === 'Modbus') { add('Test connections', testModbus); add('Explore registers', async () => openRegisterExplorer()); }
  else if (node.key === 'EmonCMS') {
    add('Test EmonCMS connection', testEmonCms); add('Provision feeds now', provisionEmonCmsFeeds);
    add('Delete old inputs', cleanupEmonCmsInputs); add('Delete old feeds', cleanupEmonCmsFeeds, 'danger'); add('Delete all feeds', deleteEmonCmsFeeds, 'danger');
    bar.appendChild(externalLink('Open EmonCMS', () => cfgUrl('EmonCMS', 'Url'), 'Open the EmonCMS server this bridge feeds'));
  } else if (node.key === 'HomeAssistant') {
    if ((state.data.HomeAssistant || {}).DiscoveryEnabled !== false) {
      add('Republish discovery', rediscoverHa);
      add('Clear discovery', clearHa, 'danger');
      // The two cleanups "Clear discovery" cannot do.
    }
    bar.appendChild(externalLink('Open Home Assistant', () => cfgUrl('HomeAssistant', 'EnergyDashboard', 'Url'), 'Open Home Assistant'));
  } else if (node.key === 'Prometheus') {
    // Our own exporter's /metrics, on this page's hostname.
    bar.appendChild(externalLink('Open /metrics', () => {
      const p = state.data?.Prometheus || {};
      return p.Exporter === false ? null : `${location.protocol}//${location.hostname}:${p.Port || 9184}/metrics`;
    }, 'The metrics this bridge exposes for Prometheus to scrape'));
  } else if (node.key === 'Pdus') {
    // One link per configured PDU's web UI.
    Object.entries(state.data?.Pdus || {}).forEach(([id, pdu]: any) => {
      bar.appendChild(externalLink(`Open ${id}`, () => {
        const c = pdu?.Connection || {};
        const host = (c.Host || '').trim();
        if (!host) return null;
        const scheme = c.Scheme || 'http';
        const port = c.Port && c.Port !== 80 && c.Port !== 443 ? ':' + c.Port : '';
        return `${scheme}://${host}${port}`;
      }, `Open the ${id} PDU's own web interface`));
    });
    if (!bar.children.length) return null;
  } else return null;

  return el('div', {}, bar, result);
}

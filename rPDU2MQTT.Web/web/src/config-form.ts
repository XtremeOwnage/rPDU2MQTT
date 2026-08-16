// Schema-driven config form: render scalar/object/dictionary/list nodes, the per-section panels, the
// nav, and the overall build() that wires every tab.
import { ensure, el, btn, activate, slug, api, toast, navLink, navLabel } from './helpers.js';
import { state } from './state.js';
import { expectRestart } from './realtime.js';
import { registerField, clearFieldRegistry, refreshDirty, onDirty, changeCountFor } from './dirty.js';
import { renderOverrides, previewOverridePaths } from './overrides.js';
import { tagInput } from './tags.js';
import { testMqtt, testPdu, testEmonCms, provisionEmonCmsFeeds, deleteEmonCmsFeeds, rediscoverHa, clearHa, testModbus, testHistory, integrationActionBar } from './actions.js';
import { addPathsSection } from './sections/paths.js';
import { addDiagnosticsSection } from './sections/diagnostics.js';
import { addControlSection } from './sections/control.js';
import { addLiveDataSection } from './sections/livedata.js';
import { addFlowSection, addNodesSection, addEnergyOverviewSection, addMqttImportSection } from './sections/flow.js';
import { addNodeDataSection } from './sections/nodedata.js';
import { addTrendsSection } from './sections/trends.js';
import { addExportSection } from './sections/export.js';
import { addHaEnergySection } from './sections/ha-energy.js';
import { addHomeSection } from './sections/home.js';
import { addDiscoveryCleanup } from './sections/ha-cleanup.js';
import { addFeaturesSection, featureToggle, jumpToFeatures } from './sections/features.js';

// Every scalar edit reports back, so the save bar, the nav badges and the field's own "edited" mark all
// stay in step with the document as it is typed.
function scalarInput(node: any, obj: any): any {
  const touched = () => refreshDirty();
  let el: any;
  if (node.type === 'bool') {
    el = document.createElement('input'); el.type = 'checkbox'; el.className = 'switch'; el.checked = !!obj[node.key];
    el.onchange = () => { obj[node.key] = el.checked; touched(); };
  } else if (node.type === 'enum') {
    el = document.createElement('select');
    // A blank choice (value "") means "unset" — leave the field out so its default/auto behaviour applies.
    const choices: string[] = (node.enumValues || []).slice();
    // A saved value the build does not offer stays on the list, named as unrecognised. Dropping it would
    // show a blank control over a config that still holds the value, and the first edit of any other field
    // on the page would look like the user chose to clear it.
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
  // A setting whose "off" would take away the means of turning it back on — the GUI's own Enabled flag
  // being the one that matters. Shown rather than hidden: a setting that vanishes reads as unsupported and
  // sends the operator looking for it, while a disabled control with the reason beside it answers in place.
  // The server decides which these are (schema notEditableReason), so there is no list to keep in step here.
  if (node.notEditableReason) {
    el.disabled = true;
    el.title = node.notEditableReason;
  }
  return el;
}

// A boolean reads (and hits) better as a switch with the current state spelled out beside it than as a
// 16px checkbox whose meaning you have to infer from the label.
function switchWrap(input: any) {
  const label = el('span', { class: 'switch-state', text: input.checked ? 'On' : 'Off' });
  const wrap = el('label', { class: 'switch-wrap' }, input, label);
  const sync = () => label.textContent = input.checked ? 'On' : 'Off';
  const prior = input.onchange;
  input.onchange = (e: any) => { prior?.(e); sync(); };
  return wrap;
}

// Render an object's child properties into `container`: scalar fields flow into a multi-column grid
// (compact), while nested lists/dicts/objects are tall unbreakable blocks, so they render full-width
// and stacked — otherwise the CSS column-balancer shoves them into one lopsided column.
// `path` is where `target` lives in the config document, so each field can be tracked for unsaved edits.
function renderObjectBody(properties: any[], target: any, container: any, path: string[] = []) {
  const isComplex = (c: any) => c.type === 'object' || c.type === 'list' || c.type === 'dictionary';
  const scalars = (properties || []).filter(c => !isComplex(c));
  const complex = (properties || []).filter(isComplex);
  if (scalars.length) {
    const grid = document.createElement('div'); grid.className = 'grid';
    const fields = new Map<string, any>();
    scalars.forEach(child => {
      renderNode(child, target, grid, path);
      fields.set(child.key, grid.children[grid.children.length - 1]);
    });
    container.appendChild(grid);
    wireVisibility(scalars, target, fields);
  }
  complex.forEach(child => renderNode(child, target, container, path));
}

// A setting that only applies to one choice of another setting (schema visibleWhen) — the Prometheus URL,
// when the history provider is Prometheus. Hidden the rest of the time rather than shown greyed out: an
// EmonCMS page carrying a Prometheus URL reads as if that is what will be queried.
//
// Which fields these are comes from the schema, so the form holds no list of provider-specific settings.
function wireVisibility(props: any[], target: any, fields: Map<string, any>) {
  props.filter(p => p.visibleWhen).forEach(p => {
    const field = fields.get(p.key);
    if (!field) return;
    // Unset means the deciding setting is at its default, not that it is blank — leaving History.Provider
    // alone still means Prometheus, and the URL has to be reachable.
    const decider = props.find((x: any) => x.key === p.visibleWhen.key);
    const sync = () => {
      const cur = target[p.visibleWhen.key] ?? decider?.default ?? '';
      show(field, p.visibleWhen.values.includes(String(cur)));
    };
    sync();
    visibilitySyncs.push(sync);
  });
}

// Every conditional field's re-check, run together whenever the document is edited. Rebuilt with the form,
// so a sync never outlives the element it hides.
let visibilitySyncs: (() => void)[] = [];
let visibilityOff: any = null;
const runVisibilitySyncs = () => visibilitySyncs.forEach(s => s());

// Leaving a page can change what belongs in the nav too: a page kept visible only because you were on it
// (its feature switched off from inside it) drops out once you go somewhere else. Registered once — the
// list it runs is rebuilt with the form, this listener is not.
window.addEventListener?.('rpdu:activate', runVisibilitySyncs);

function show(elm: any, on: boolean) { elm.classList[on ? 'remove' : 'add']('is-hidden'); }

// Render an arbitrary node bound to obj[node.key] (the value lives under its key on obj).
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
    // Where this control writes to, on the element itself: it makes a rendered form readable in devtools,
    // and it is how a check can say "this exact setting is rendered once" rather than matching on a label
    // like "Enabled", which several unrelated nested sections legitimately share.
    f.dataset.path = here.join('.');
    const lab = document.createElement('label'); lab.textContent = node.label; f.appendChild(lab);
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; f.appendChild(d); }
    const input = scalarInput(node, obj);
    f.appendChild(node.type === 'bool' ? switchWrap(input) : input);
    // Say why it's greyed out, in the field itself — a disabled control with no explanation reads as a bug.
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

// Click-to-insert / draggable chips for a templated field's available {variables}.
function templateVarChips(vars: string[], input: any, obj: any, node: any) {
  const wrap = document.createElement('div'); wrap.className = 'tpl-vars';
  const label = document.createElement('span'); label.className = 'desc'; label.style.margin = '0'; label.textContent = 'Variables:';
  wrap.appendChild(label);
  vars.forEach(v => {
    const token = '{' + v + '}';
    const chip = document.createElement('span'); chip.className = 'tpl-chip'; chip.textContent = token; chip.draggable = true;
    chip.title = 'Click to insert at the cursor, or drag into the field';
    chip.onclick = () => {
      const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, s) + token + input.value.slice(e);
      const pos = s + token.length; input.focus(); input.setSelectionRange(pos, pos);
      obj[node.key] = input.value === '' ? null : input.value;
      refreshDirty();
    };
    // Native text drop inserts at the drop point; the field's change handler syncs the model on blur.
    chip.ondragstart = (ev: any) => ev.dataTransfer.setData('text/plain', token);
    wrap.appendChild(chip);
  });
  return wrap;
}

// Render the value of a dictionary/list element (valueSchema has no key of its own). `path` addresses
// the element itself, e.g. ['Pdus','default'] or ['Modbus','Connections','0'].
function renderValue(valueSchema: any, holder: any, keyName: any, container: any, path: string[]) {
  const node = Object.assign({}, valueSchema, { key: keyName, label: 'value' });
  if (node.type === 'object') {
    const target = ensure(holder, keyName, {});
    // A dictionary/list entry's fields (e.g. each PDU instance): scalars in columns, collections full-width.
    renderObjectBody(node.properties, target, container, path);
  } else {
    renderNode(node, holder, container, path.slice(0, -1));
  }
}

function renderMap(node: any, mapObj: any, path: string[]) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
  const entries = document.createElement('div'); fs.appendChild(entries);

  const drawEntry = (key: string) => {
    const wrap = document.createElement('div'); wrap.className = 'map-entry';
    const head = document.createElement('div'); head.className = 'head';
    const keyIn = document.createElement('input'); keyIn.className = 'key'; keyIn.type = 'text'; keyIn.value = key;
    keyIn.onchange = () => { if (keyIn.value && keyIn.value !== key) { mapObj[keyIn.value] = mapObj[key]; delete mapObj[key]; key = keyIn.value; refreshDirty(); } };
    const del = btn('Remove', 'danger');
    del.onclick = () => { delete mapObj[key]; entries.removeChild(wrap); refreshDirty(); };
    head.appendChild(keyIn); head.appendChild(del); wrap.appendChild(head);
    if (mapObj[key] == null) mapObj[key] = (node.valueSchema && node.valueSchema.type === 'object') ? {} : '';
    renderValue(node.valueSchema, mapObj, key, wrap, [...path, key]);
    entries.appendChild(wrap);
  };

  Object.keys(mapObj).forEach(drawEntry);
  const add = btn('+ Add');
  add.onclick = () => { let k = 'new'; let i = 1; while (mapObj[k] !== undefined) k = 'new' + (i++); mapObj[k] = node.valueSchema.type === 'object' ? {} : ''; drawEntry(k); refreshDirty(); };
  fs.appendChild(add);
  return fs;
}

function renderList(node: any, arr: any[], path: string[]) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);

  // A list of tag names is a list of references to something defined elsewhere, so it is chosen rather
  // than typed: a mistyped tag here is a filter that silently matches nothing.
  if (node.tagChoices) {
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
    const picker = tagInput(arr, { strict: true });
    fs.appendChild(picker);
    registerField([...path], fs as any, false);
    return fs;
  }

  const entries = document.createElement('div'); fs.appendChild(entries);
  const draw = (idx: number) => {
    const wrap = document.createElement('div'); wrap.className = 'list-entry';
    const del = btn('Remove', 'danger');
    del.onclick = () => { arr.splice(idx, 1); rebuild(); refreshDirty(); };
    wrap.appendChild(del);
    renderValue(node.valueSchema, arr, idx, wrap, [...path, String(idx)]);
    entries.appendChild(wrap);
  };
  const rebuild = () => { entries.innerHTML = ''; arr.forEach((_, i) => draw(i)); };
  rebuild();
  const add = btn('+ Add');
  add.onclick = () => { arr.push(node.valueSchema.type === 'object' ? {} : ''); rebuild(); refreshDirty(); };
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
  { title: 'Sources', items: [{ tool: addLiveDataSection, child: true }, { tool: addControlSection, child: true }, { tool: addPathsSection, child: true }] },
  { title: 'Energy Flow', items: [{ tool: addEnergyOverviewSection }, { tool: addNodesSection }, { tool: addFlowSection }, { tool: addTrendsSection }, { tool: addNodeDataSection }] },
  { title: 'Integrations', items: [{ tool: addMqttImportSection, child: true }] },
  { title: 'Destinations', items: [{ tool: addHaEnergySection, child: true }] },
  { title: 'System', items: [{ tool: addFeaturesSection }, { tool: addExportSection }, { tool: addDiagnosticsSection }] },
];

// Display-label fixes — acronyms in caps, and clearer names (#209). Keys are schema section keys.
const LABEL_OVERRIDES: Record<string, string> = { Pdus: 'Vertiv rPDU', Api: 'API', Gui: 'GUI', Modbus: 'Modbus TCP', HomeAssistant: 'Home Assistant' };

// A leading glyph per schema-driven page. Purely a scanning aid — the label is still the page's
// identity — so an unlisted section simply gets the neutral bullet. (The bespoke tool tabs pass their
// own glyph to navLink() where they build their link.)
const NAV_ICONS: Record<string, string> = {
  'Vertiv rPDU': '▤', 'Overrides': '✎', 'MQTT': '⇅', 'Modbus TCP': '⧉', 'EmonCMS': '▦',
  'Home Assistant': '⌂', 'Prometheus': '◎', 'GUI': '▭', 'API': '⚙',
  'Health': '♥', 'Logging': '☰', 'Debug': '⚑', 'Operator': '⎈',
};
function navIcon(label: string) { return NAV_ICONS[label] || '•'; }

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

// Says where a section's on/off switch went, and takes you there — a control that simply vanishes reads as
// a missing feature and sends the operator hunting for it.
function featurePointer(label: string) {
  const wrap = el('div', { class: 'desc feature-pointer' });
  wrap.appendChild(el('span', { text: `${label} is turned on and off on the Features page. ` }));
  const go = btn('Features');
  go.onclick = () => jumpToFeatures();
  wrap.appendChild(go);
  return wrap;
}

// Reading history from EmonCMS reads the feeds the EmonCMS export writes — same server, same key, same feed
// names — so there is nothing to configure for it here. Point at the page that does configure it rather
// than leave the page looking empty, or worse, duplicate the server and key into a second place to edit.
function wireHistoryProvider(sec: any) {
  const wrap = el('div', { class: 'desc feature-pointer' });
  wrap.appendChild(el('span', { text: 'EmonCMS history reads the feeds the EmonCMS export writes. Its server, API key and feed names are configured on the EmonCMS page. ' }));
  const go = btn('EmonCMS');
  go.onclick = () => jumpToSection('EmonCMS');
  wrap.appendChild(go);
  sec.appendChild(wrap);

  const sync = () => show(wrap, (state.data.History || {}).Provider === 'emoncms');
  sync();
  visibilitySyncs.push(sync);
}

// A settings page for a capability that is switched off is a page of settings for something that is not
// running. Its nav entry is hidden until the feature is turned on.
//
// Hidden, not removed: the page is still built, still reachable from the Features card's Settings button
// and from the command palette, and its entry returns the instant the switch is flipped — no save, no
// reload. The Features page is the one place that answers "what is this bridge doing?", and the nav now
// agrees with it instead of listing ten pages for things that are off.
function hideWhileOff(link: any, sectionKey: string, feature: any) {
  const sync = () => {
    const cur = (state.data[sectionKey] || {})[feature.key];
    const on = cur == null ? !!feature.default : !!cur;
    // Never hide the page being looked at: switching a feature off from its own settings page is exactly
    // when its nav entry would vanish under you, which reads as the GUI breaking.
    show(link, on || link.classList.contains('active'));
  };
  sync();
  visibilitySyncs.push(sync);
}

// Render one schema-driven config section (nav link + panel); returns the nav link.
function renderConfigSection(node: any, nav: any, sections: any) {
  const label = LABEL_OVERRIDES[node.key] || node.label;
  const link = navLink(nav, label, navIcon(label));
  // Which part of the document this page edits, so its nav entry can carry a count of pending edits.
  link.dataset.section = node.key;
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
      let props = node.key === 'HomeAssistant' ? (node.properties || []).filter((p: any) => p.key !== 'EnergyDashboard') : node.properties;
      // A feature's on/off switch lives on the Features page, not on eight separate pages (#292). It is
      // removed here rather than duplicated: two switches bound to one value would disagree the moment one
      // of them was clicked, and a page showing "Off" for something that is on is exactly the kind of
      // inaccuracy this GUI must never show.
      const feature = featureToggle(node);
      if (feature) {
        props = (props || []).filter((p: any) => p !== feature);
        sec.appendChild(featurePointer(label));
        hideWhileOff(link, node.key, feature);
      }
      // A plugin's settings live under Plugins/<id>, not as a property of their own — Config was compiled
      // before the plugin existed. Everything else about rendering and change-tracking is identical.
      const target = node.isPlugin
        ? ensure(ensure(state.data, 'Plugins', {}), node.key, {})
        : state.data[node.key];
      const path = node.isPlugin ? ['Plugins', node.key] : [node.key];
      renderObjectBody(props, target, sec, path);
    }
    else renderNode(node, state.data, sec, []);
    // A plugin's buttons come from what it says it can do — no per-integration wiring here at all.
    if (node.isPlugin) integrationActionBar(node.key).then(bar => { if (bar) sec.appendChild(bar); });
    // The discovery cleanups belong with the discovery buttons, not on the energy-mapping page.
    if (node.key === 'HomeAssistant') addDiscoveryCleanup(sec);
    if (node.key === 'History') wireHistoryProvider(sec);
    if (node.key === 'Gui') wireGuiAuth(sec);
    else if (node.key === 'EmonCMS') wireEmonCmsTransport(sec);
    else if (node.key === 'Api') wireApiDocs(sec);
    else if (node.key === 'Operator') { wireOperatorCheck(sec); wireOperatorSwitch(sec); }
    link.onclick = () => activate(link, sec);
  }
  return link;
}

export function build() {
  const nav: any = document.getElementById('nav'); const sections: any = document.getElementById('sections');
  nav.innerHTML = ''; sections.innerHTML = '';
  // Everything registered against the old DOM is gone with it.
  clearFieldRegistry();
  visibilitySyncs = [];

  const byKey = new Map(state.schema.map((n: any) => [n.key, n]));
  // EnergyFlow has a dedicated visual editor (Flow/Nodes tabs), so its raw schema form is hidden here.
  const HIDDEN = new Set(['EnergyFlow']);
  // A section the client doesn't place itself — a plugin's, or a new built-in — goes where the schema says
  // it belongs, and into System when it says nothing, so a new one is never lost.
  //
  // Built from a COPY of NAV_GROUPS. Pushing into the module-level constant meant every rebuild of the form
  // appended the same sections again, so saving twice put a page in the nav three times.
  // Every schema section is placed by what the SCHEMA says, built-in or plugin. NAV_GROUPS now carries
  // only the visual editors (Flow, Nodes, Trends…), which have no schema section to declare a group on.
  // Holding the grouping in two places is how a section ends up registered, rendered and reachable while
  // sitting in the wrong group, with nothing to say it was forgotten.
  //
  // Schema sections lead each group and the tools follow, because a tool marked `child` indents under
  // whatever precedes it — the PDU tabs belong under the PDU page, not above it.
  const navGroups = NAV_GROUPS.map(g => ({ title: g.title, items: [] as NavItem[] }));
  const groupFor = (title: string) => navGroups.find(g => g.title === title) ?? navGroups.find(g => g.title === 'System')!;

  state.schema.forEach((n: any) => {
    if (HIDDEN.has(n.key)) return;
    groupFor(n.group || 'System').items.push({ schema: n.key });
  });
  NAV_GROUPS.forEach((g, i) => navGroups[i].items.push(...g.items));

  // The landing page: a status board, rendered first so it's the default tab (#186).
  const home = addHomeSection(nav, sections);
  const first: any = home.link;

  for (const g of navGroups) {
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
  const target = wanted ? ([...nav.querySelectorAll('a')] as any[]).find(a => slug(navLabel(a)) === wanted) : null;
  (target || first)?.click();

  // One subscription for every conditional field, so changing the setting they hang off takes effect as
  // soon as it is picked rather than after a save and reload.
  visibilityOff?.();
  visibilityOff = onDirty(runVisibilitySyncs);

  wireNavBadges(nav);
}

// Each config page's nav entry carries the number of unsaved edits inside it, so pending work is
// visible from anywhere — you don't have to remember which tab you were on when you changed something.
let navBadgesOff: any = null;
function wireNavBadges(nav: any) {
  // A rebuild replaces every link, so drop the watcher that was pointing at the old ones.
  navBadgesOff?.();
  const links = ([...nav.querySelectorAll('a')] as any[]).filter(a => a.dataset?.section);
  navBadgesOff = onDirty(() => links.forEach(a => {
    const n = changeCountFor(a.dataset.section);
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
      // Left clickable even when the API is off. Killing pointer-events made these look like ordinary
      // links that silently ignored a click — reported as "API links not clickable" (#295), because a
      // dead-looking link is indistinguishable from a broken page. The reason is now on the row itself
      // rather than only in the paragraph above it, so the state is legible where the link is.
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

// Operator page: an on-demand update check. Asks the operator to query the registry now and says plainly
// whether a newer eligible version (bounded by Policy) is available — read-only, never touches the Deployment.
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
    // The operator reports both the message and a Severity, so the colour comes straight from that severity —
    // no re-deriving from wording (the old code called 'unstable' a "release", then keyword-sniffed the prose).
    // Fall back to `available` only for a legacy report that predates the severity field.
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

// Operator page: a channel/version switcher — roll the Deployment to stable/edge/dev or a specific release (#210).
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
      // The workload is about to go away. Say so, so the dropped stream reads as "busy", not "broken".
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

// A link out to the system this page configures. It appears only when a URL is actually configured, so it
// can never dangle, and the href is resolved on each visit rather than at build time — otherwise editing
// the URL and clicking straight through would open the old one.
function externalLink(label: string, href: () => string | null, hint: string) {
  const a: any = el('a', { class: 'ext-link', target: '_blank', rel: 'noopener', title: hint }, label + ' ↗');
  const sync = () => {
    const u = href();
    if (u) { a.href = u; a.title = hint + '\n' + u; a.classList.remove('is-hidden'); }
    else a.classList.add('is-hidden');
  };
  sync();
  // activate() announces every tab switch, so a URL edited elsewhere is picked up on the way back here.
  window.addEventListener?.('rpdu:activate', sync);
  return a;
}

// A configured URL, trimmed and only if it looks like one — a half-typed host shouldn't produce a link.
function cfgUrl(...path: string[]): string | null {
  let o: any = state.data;
  for (const p of path) { if (o == null) return null; o = o[p]; }
  const s = typeof o === 'string' ? o.trim() : '';
  return /^https?:\/\/.+/i.test(s) ? s.replace(/\/+$/, '') : null;
}

// Section-specific action buttons (connection tests; Home Assistant discovery actions; a way in to the
// system being configured).
function sectionActions(node: any) {
  const bar = document.createElement('div'); bar.className = 'sec-actions';

  // What the last action did, on the page. A toast is gone in a few seconds and "did that work?" is the
  // whole reason these buttons exist — a test whose answer you have to catch is a test that says nothing.
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
        // An action that throws must not leave the button stuck on "Working…" with nothing said.
        result.textContent = '✗ ' + (e?.message || e);
        result.classList.add('test-bad');
      } finally { b.disabled = false; b.textContent = was; }
    };
    bar.appendChild(b);
  };

  if (node.key === 'MQTT') add('Test MQTT connection', testMqtt);
  else if (node.key === 'History') add('Test history backend', testHistory);
  else if (node.key === 'PDU') add('Test PDU connection', testPdu);
  else if (node.key === 'Modbus') add('Test connections', testModbus);
  else if (node.key === 'EmonCMS') {
    add('Test EmonCMS connection', testEmonCms); add('Provision feeds now', provisionEmonCmsFeeds); add('Delete all feeds', deleteEmonCmsFeeds, 'danger');
    bar.appendChild(externalLink('Open EmonCMS', () => cfgUrl('EmonCMS', 'Url'), 'Open the EmonCMS server this bridge feeds'));
  } else if (node.key === 'HomeAssistant') {
    if ((state.data.HomeAssistant || {}).DiscoveryEnabled !== false) {
      add('Republish discovery', rediscoverHa);
      add('Clear discovery', clearHa, 'danger');
      // The two cleanups that "Clear discovery" cannot do. One removes retained configs for things this
      // build no longer publishes; the other removes devices Home Assistant still lists whose config is
      // already gone, which is reachable only through HA's own API.
    }
    // The base URL is configured for the Energy Dashboard sync, but it's the way in to HA either way.
    bar.appendChild(externalLink('Open Home Assistant', () => cfgUrl('HomeAssistant', 'EnergyDashboard', 'Url'), 'Open Home Assistant'));
  } else if (node.key === 'Prometheus') {
    // Our own exporter, not the Pushgateway (that URL is a write endpoint, not something to visit). Built
    // from this page's hostname the way the API docs links are — it only resolves if that port is exposed.
    bar.appendChild(externalLink('Open /metrics', () => {
      const p = state.data?.Prometheus || {};
      return p.Exporter === false ? null : `${location.protocol}//${location.hostname}:${p.Port || 9184}/metrics`;
    }, 'The metrics this bridge exposes for Prometheus to scrape'));
  } else if (node.key === 'Pdus') {
    // One way in per configured PDU — their web UIs are where you go to check anything this can't show.
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

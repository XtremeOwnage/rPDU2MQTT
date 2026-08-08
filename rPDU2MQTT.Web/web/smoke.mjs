// Behavioral smoke test for the bundled GUI: stub a minimal DOM + fetch, run app.js, and let
// load() -> build() construct every section. Catches cross-module wiring/reference errors that a mere
// syntax check would miss. Not a substitute for a browser, but it exercises the whole setup path.
//
// The schema is the REAL one (schema.fixture.json, dumped from ConfigSchema.Build()), not an empty list:
// an empty schema renders no sections at all, which made this test pass no matter what build() did with
// them. Regenerate the fixture when config sections change — see the header note in that file.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
// The leading _README node carries the fixture's regeneration note (JSON has no comments); it isn't
// part of the schema, so drop it before handing it to the app.
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');

// A config with a custom flow node already bound to an MQTT source (#205), so opening the Flow tab
// exercises the hierarchy editor and the live-sources table rather than just their empty states.
const config = {
  EnergyFlow: {
    Nodes: [
      // A legacy MQTT binding (migrates to Sources) plus a Modbus binding, so the editor exercises both
      // source-type branches of the binding row.
      { Id: 'solar', Label: 'Solar',
        Mqtt: [{ Topic: 'solar_assistant/inverter_1/pv_power/state', Metric: 'realpower' }],
        Sources: [{ Type: 'modbus', Connection: 'inv1', Register: 100, Metric: 'energy', DataType: 'float32' }] },
      { Id: 'panel', Label: 'Panel', Value: 100 },
    ],
    Links: [{ From: 'solar', To: 'panel' }],
    MqttExport: true,
  },
  Modbus: { Connections: [{ Id: 'inv1', Name: 'Inverter', Host: '10.0.0.5', Port: 502, UnitId: 1 }] },
};
// Three deep on purpose: mppt -> solar -> panel. A two-node graph cannot tell "walk the whole supply
// chain" apart from "light the direct feeder", which is exactly the bug the focus test needs to catch.
const flowGraph = {
  ok: true,
  nodes: [
    { id: 'mppt', label: 'MPPT', kind: 'node', value: 750 },
    { id: 'solar', label: 'Solar', kind: 'node', value: 750 },
    { id: 'panel', label: 'Panel', kind: 'node', value: 750 },
  ],
  links: [
    { source: 'mppt', target: 'solar', value: 750 },
    { source: 'solar', target: 'panel', value: 750 },
  ],
  metric: 'realpower', units: 'W',
};

// One fresh reading and one that expired, so the Node Data page has both states to render.
const liveValues = { ok: true, values: [
  { node: 'solar', metric: 'realpower', value: 4237, reported: 4237, atUtc: new Date().toISOString(), ageSeconds: 3, fresh: true, staleAfterSeconds: 120 },
  { node: 'solar', metric: 'energy', value: null, reported: 91.5, atUtc: new Date(Date.now() - 7200e3).toISOString(), ageSeconds: 7200, fresh: false, staleAfterSeconds: 120 },
] };

const bodies = (url) =>
  url.includes('/api/flow/live') ? liveValues :
  url.includes('/api/schema') ? schema :
  url.includes('/api/instances') ? { ok: true, instances: [] } :
  url.includes('/api/config') ? config :
  url.includes('/api/flow') ? flowGraph :
  { ok: true };

// The DOM + browser globals live in domstub.mjs, shared with layout.check.mjs.
const { sandbox, getEl, storage } = makeDom({ bodies });


vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
// load() is async; give its awaited fetches a tick to resolve so build() runs.
await new Promise(r => setTimeout(r, 50));

// --- Assertions -------------------------------------------------------------------------------------
const fail = (m) => { console.error('smoke FAILED: ' + m); process.exit(1); };
const navLinksNow = () => query(getEl('nav'), 'a', true);

const nav = getEl('nav');
// A nav entry's text now includes its leading glyph, so its identity lives in dataset.label — the same
// value the hash slugs and the command palette read.
const navLinks = query(nav, 'a', true);
const linkText = navLinks.map(a => a.dataset.label || a.textContent);
const groups = query(nav, '.nav-group', true).map(g => g.textContent);

if (!linkText.length) fail('no nav links were rendered');
for (const g of ['Sources', 'Energy Flow', 'Integrations', 'Destinations', 'System'])
  if (!groups.includes(g)) fail(`nav group "${g}" missing (got: ${groups.join(', ')})`);

// Every non-hidden schema section must reach the nav (tokens match the display label, e.g. Pdus renders as
// "Vertiv rPDU"). "Api" is deliberately in no NAV_GROUPS list, so this also pins the catch-all: without it,
// ungrouped sections vanish from the UI entirely.
for (const key of ['MQTT', 'Vertiv', 'EmonCMS', 'HomeAssistant', 'Prometheus', 'Api'])
  if (!linkText.some(t => t.replace(/\s/g, '').toLowerCase().includes(key.toLowerCase())))
    fail(`schema section "${key}" has no nav link (got: ${linkText.join(', ')})`);

// EnergyFlow is hidden from the schema-driven nav in favour of the bespoke Flow tab.
if (linkText.includes('EnergyFlow')) fail('EnergyFlow should be hidden from the config nav');

if (!query(getEl('sections'), '.section', true).length) fail('no sections were rendered');

// --- The shell: unsaved-change tracking, theme, palette ---------------------------------------------
// These are the parts with no section of their own, so nothing else would notice them breaking.

// Nothing has been edited yet, so the save bar must not be on screen at all.
if (!getEl('savebar').classList.contains('is-hidden'))
  fail('the save bar is showing before anything was edited');

// Edit one field and the whole chain should light up: the field marks itself, the bar appears with a
// count, and the owning page's nav entry gets a badge. (The MQTT page is a plain scalar form.)
const mqttLink = navLinks.find(a => a.dataset.label === 'MQTT');
if (!mqttLink) fail('no MQTT tab');
mqttLink.click();
const mqttSec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!mqttSec) fail('clicking the MQTT tab activated no section');
// (The stub sets `type` as a property, the way the renderer does, so select on that rather than [type=].)
const textInput = (f) => query(f, 'input', true).find(i => i.type === 'text');
const hostField = query(mqttSec, '.field', true).find(textInput);
if (!hostField) fail('the MQTT page rendered no text field to edit');
const hostInput = textInput(hostField);
hostInput.value = 'broker.example.test';
hostInput.onchange();

if (!hostField.classList.contains('dirty')) fail('an edited field was not marked as changed');
if (getEl('savebar').classList.contains('is-hidden')) fail('the save bar stayed hidden after an edit');
if (getEl('save-count').textContent !== '1 unsaved change')
  fail(`the save bar miscounted: "${getEl('save-count').textContent}"`);
if (!query(mqttLink, '.nav-badge', false)) fail('the edited page got no nav badge');

// Editing it back to the loaded value is not a change — the diff must ignore the round trip.
hostInput.value = '';
hostInput.onchange();
if (!getEl('savebar').classList.contains('is-hidden'))
  fail('reverting an edit left the save bar showing');
if (hostField.classList.contains('dirty')) fail('reverting an edit left the field marked as changed');

// Ctrl+K opens the palette, listing every page (it reads the nav, so a new page needs no registration).
getEl('cmd-open').click();
const cmdItems = query(getEl('overlay'), '.cmd-item', true);
if (cmdItems.length !== navLinks.length)
  fail(`the palette listed ${cmdItems.length} pages but the nav has ${navLinks.length}`);

// The theme button cycles system -> dark -> light and persists the choice.
getEl('st-theme').click();
if (storage.get('rpdu-theme') !== 'dark') fail(`the theme button did not switch to dark (got ${storage.get('rpdu-theme')})`);
if (sandbox.document.documentElement.getAttribute('data-theme') !== 'dark') fail('the dark theme was not applied to <html>');

// Tabs build their body lazily on first click, so build() alone never touches the bespoke editors. Open
// the Flow tab to exercise the Sankey + hierarchy drag-graph (#129).
const flowLink = navLinks.find(a => a.dataset.label === 'Flow');
if (!flowLink) fail('no Flow tab');
flowLink.click();
await new Promise(r => setTimeout(r, 50));
const activeSec = () => query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!query(activeSec(), 'rect', true).some(r => r.attrs['data-node']))
  fail('the Flow tab did not render the diagram');

// The roll-up table, the wiring editor and the roll-up settings are three pages of their own under Energy
// Flow, reachable without going through the diagram first.
for (const [label, marker] of [['Roll-up', 'Rolled-up values'], ['Hierarchy', 'Drag from a node'], ['Settings', 'Track daily totals']]) {
  const l = navLinksNow().find(a => a.dataset.label === label);
  if (!l) fail(`no ${label} page under Energy Flow`);
  if (l.dataset.section !== 'EnergyFlow') fail(`the ${label} page does not carry EnergyFlow's unsaved-edit count`);
  l.click();
  await new Promise(r => setTimeout(r, 50));
  if (!activeSec().textContent.includes(marker)) fail(`the ${label} page rendered nothing ("${marker}" missing)`);
}

// Each of those settings has exactly one control. Left behind as well as moved, two controls would be
// bound to one value and would disagree the moment either was used. Counted as controls, not as text —
// another page is free to mention a setting and say where it lives.
const everyLabel = () => query(getEl('sections'), 'label', true).map(l => l.textContent);
for (const setting of ['Export tiers to MQTT', 'Track daily totals', 'Infer from a single supply path',
                       'Derive kWh from power']) {
  const on = everyLabel().filter(t => t.includes(setting)).length;
  if (on !== 1) fail(`"${setting}" has ${on} controls; it belongs in exactly one place`);
}

flowLink.click();
await new Promise(r => setTimeout(r, 50));

// Node configuration now lives on its own Nodes tab. Open it, open the 'solar' node's editor, and confirm
// it surfaces the migrated MQTT topic, the Modbus connection picker, and the feeders/children wiring.
const nodesLink = navLinks.find(a => a.dataset.label === 'Nodes');
if (!nodesLink) fail('no Nodes tab');
nodesLink.click();
await new Promise(r => setTimeout(r, 50));

const sectionsText = query(getEl('sections'), '.section', true).map(s => s.textContent).join(' ');
if (!sectionsText.includes('Virtual nodes')) fail('the Nodes tab did not render the virtual-node manager');

const editBtn = query(getEl('sections'), 'button', true).find(b => b.textContent === 'Edit');
if (!editBtn) fail('the virtual-node manager rendered no Edit button');
editBtn.click();
await new Promise(r => setTimeout(r, 20));

// The editor opens as a modal on <body>, not inline under the table (#292) — inline put the form at the
// bottom of a long page, away from the row, and kept the table too wide for a small screen.
const editor = query(sandbox.document.body, '.node-editor', false);
if (!editor) fail('opening a node did not open the editor modal');
if (query(getEl('sections'), '.node-editor', false)) fail('the node editor rendered inline under the table again');
const editorText = editor.textContent;
if (!editorText.includes('Live value bindings')) fail('opening a node did not render its bindings editor');
if (!editorText.includes('Feeders & children')) fail('the node editor did not render the feeders/children wiring');
if (!query(editor, 'input', true).some(i => i.value === 'solar_assistant/inverter_1/pv_power/state'))
  fail('the node editor did not surface the migrated MQTT binding as an editable topic');
// The Modbus binding row must render its connection picker, listing the configured connection.
if (!editorText.includes('Inverter')) fail('the Modbus binding row did not list the configured connection');

// Escape dismisses it, and dismissing it leaves nothing behind on <body>.
sandbox.document.dispatch('keydown', { key: 'Escape' });
await new Promise(r => setTimeout(r, 20));
if (query(sandbox.document.body, '.node-editor', false)) fail('Escape did not close the node editor modal');

// --- Wiring from the Nodes table (no dragging) ---
// The Flow tab's canvas needs a node's port dragged onto its target, which means scrolling a tall column.
nodesLink.click();
await new Promise(r => setTimeout(r, 50));

const feedRow = query(getEl('sections'), 'tr', true).find(r => r.textContent.includes('panel'));
if (!feedRow) fail('no row for the panel node in the virtual-node table');
const feedSel = query(feedRow, 'select', true)[0];
if (!feedSel) fail('the node table offers no way to set what a node feeds without dragging');

// Its options are the other nodes, and it reflects the wiring already in the config.
const feedOpts = (feedSel.children || []).map(o => o.value || (o.attrs && o.attrs.value));
if (!feedOpts.includes('solar')) fail(`the feeds control does not offer the other nodes: ${feedOpts.join(', ')}`);

// A loop is refused: solar already feeds panel, so panel feeding solar would close a cycle.
feedSel.value = 'solar';
feedSel.onchange({});
await new Promise(r => setTimeout(r, 20));
const looped = (config.EnergyFlow.Links || []).some(l => l.From === 'panel' && l.To === 'solar');
if (looped) fail('the feeds control accepted a wiring that closes a feeder loop');

// --- Features page (#292) -----------------------------------------------------------------------------
// Every capability's on/off switch on one page, and NOT also on its own config page: two switches bound to
// one value disagree the moment either is clicked, and a page showing "Off" for something that is on is
// exactly the inaccuracy this GUI must never display.
const featuresLink = navLinks.find(a => a.dataset.label === 'Features');
if (!featuresLink) fail('no Features tab');
featuresLink.click();
await new Promise(r => setTimeout(r, 20));

const featureKeys = schema
  .filter(n => (n.properties || []).some(p => p.isFeatureToggle))
  .map(n => n.key);
if (featureKeys.length < 5) fail(`the schema fixture only marks ${featureKeys.length} feature toggles — it is stale`);

const featureSec = query(getEl('sections'), '.section', true).find(s => s.textContent.includes('Everything this bridge can do'));
if (!featureSec) fail('the Features tab rendered no page');
const featureSwitches = query(featureSec, '.switch', true);
if (featureSwitches.length !== featureKeys.length)
  fail(`Features shows ${featureSwitches.length} switches for ${featureKeys.length} feature toggles`);

// Every one of them is rendered exactly once, on the Features page — matched on the config path the field
// writes to, not on its label, since several unrelated nested sections legitimately have an "Enabled".
const featureFields = query(featureSec, '.field', true).map(f => f.dataset.path).filter(Boolean);
for (const key of featureKeys) {
  const prop = schema.find(n => n.key === key).properties.find(p => p.isFeatureToggle);
  const path = `${key}.${prop.key}`;
  const rendered = query(getEl('sections'), '.field', true).filter(f => f.dataset.path === path);
  if (rendered.length !== 1) fail(`${path} is rendered ${rendered.length} times — it must live only on Features`);
  if (!featureFields.includes(path)) fail(`${path} is rendered somewhere other than the Features page`);

  // And the page it left says where it went, so the switch doesn't just look missing.
  const link = navLinks.find(a => a.dataset.section === key);
  if (!link) continue;                       // section not in the nav (hidden build) — nothing to point at
  link.click();
  await new Promise(r => setTimeout(r, 10));
  if (!query(getEl('sections'), '.feature-pointer', true).length)
    fail(`the ${key} page does not say where its on/off switch went`);
}

// The GUI's own switch stays visible but locked — hiding it reads as unsupported, and enabling it from
// here would let you lock yourself out of the only place to turn it back on.
featuresLink.click();
await new Promise(r => setTimeout(r, 20));
const guiSwitch = query(featureSec, '.field', true).find(f => f.textContent.includes('Web GUI'));
if (!guiSwitch) fail('the Features page does not list the GUI itself');
if (!query(guiSwitch, '.switch', true).some(i => i.disabled)) fail('the GUI switch is editable from inside the GUI');
if (!guiSwitch.textContent.includes('lock you out')) fail('the locked GUI switch does not say why');

// Toggling here edits the real document, so the change shows up as an unsaved edit against its section.
// By config path, not by label text: another feature's description mentioning EmonCMS would otherwise
// match first, and the assertion below would be about the wrong card.
const emon = query(featureSec, '.field', true).find(f => f.dataset.path === 'EmonCMS.Enabled');
if (!emon) fail('the Features page does not list the EmonCMS export');
const emonSwitch = query(emon, '.switch', true)[0];
emonSwitch.checked = !emonSwitch.checked;
emonSwitch.onchange({});
if (!emon.classList.contains('dirty')) fail('toggling a feature was not marked as an unsaved edit');
const emonLink = navLinks.find(a => a.dataset.section === 'EmonCMS');
if (emonLink && !query(emonLink, '.nav-badge', false))
  fail('toggling a feature on the Features page put no badge on the section that owns it');
// Not toggled back: the fixture has no EmonCMS section at all, so switching it off again writes an
// explicit false where there was nothing, which is a genuine edit to the document. (Reverting an edit
// back to nothing is covered on the MQTT field above, where the empty string prunes away.)

// --- Flow node hover card ----------------------------------------------------------------------------
// The card is only reachable by hovering a Sankey node, so nothing else would notice it breaking.
flowLink.click();
await new Promise(r => setTimeout(r, 50));
const nodeRect = query(getEl("sections"), "rect", true).find(r => r.attrs["data-node"] === "solar" && r._on.mouseenter);
if (!nodeRect) fail("no Sankey node exposes a hover handler");
nodeRect.dispatch("mouseenter", { clientX: 100, clientY: 100 });

const cardEl = query(getEl("body") === undefined ? sandbox.document.body : sandbox.document.body, ".node-card", false);
if (!cardEl) fail("hovering a node rendered no card");
const cardText = cardEl.textContent;
for (const want of ["Solar", "solar"])
  if (!cardText.includes(want)) fail(`the hover card is missing "${want}" (got: ${cardText})`);
if (!cardEl.classList.contains("show")) fail("the hover card was built but never shown");
nodeRect.dispatch("mouseleave", {});
if (cardEl.classList.contains("show")) fail("the hover card stayed up after the pointer left");

// --- Focus a supply path -------------------------------------------------------------------------
// Clicking a node lights what feeds it and dims the rest; clicking it again restores.
const sankeyNodes = query(getEl('sections'), 'rect', true).filter(r => r.attrs['data-node']);
if (!sankeyNodes.length) fail('no Sankey node carries a data-node tag for focusing');
const panelRect = sankeyNodes.find(r => r.attrs['data-node'] === 'panel');
if (!panelRect) fail('the fixture graph did not render its "panel" node');

panelRect.dispatch('click', { stopPropagation() {} });
const focusSvg = query(getEl('sections'), 'svg', true).find(x => x.classList.contains('flow-focus'));
if (!focusSvg) fail('clicking a node did not focus its supply path');
// solar feeds panel, so both are on the path.
const lit = query(focusSvg, 'rect', true).filter(r => r.classList.contains('on-path')).map(r => r.attrs['data-node']);
for (const want of ['panel', 'solar', 'mppt'])
  if (!lit.includes(want)) fail(`focusing "panel" left "${want}" off the path (lit: ${lit.join(', ')})`);
if (!query(focusSvg, 'path', true).some(p => p.classList.contains('on-path')))
  fail('the ribbon feeding the focused node was not lit');

panelRect.dispatch('click', { stopPropagation() {} });
if (focusSvg.classList.contains('flow-focus')) fail('clicking the focused node again did not restore the view');
// --- Node Data page ------------------------------------------------------------------------------
// Freshness is the reason this page exists: an expired reading must still be listed, and marked as such.
const dataLink = navLinksNow().find(a => a.dataset.label === 'Node Data');
if (!dataLink) fail('no Node Data tab');
dataLink.click();
await new Promise(r => setTimeout(r, 50));
const dataSec = query(getEl('sections'), '.section', true).find(x => x.classList.contains('active'));
if (!dataSec) fail('clicking Node Data activated no section');
const dataText = dataSec.textContent;
if (!dataText.includes('solar_assistant/inverter_1/pv_power/state'))
  fail('the Node Data page did not list the bound MQTT source');
const dots = query(dataSec, '.dot', true);
if (!dots.some(d => d.classList.contains('bad'))) fail('a stale reading was not flagged on the Node Data page');
if (!dots.some(d => d.classList.contains('good'))) fail('a fresh reading was not marked fresh on the Node Data page');

// --- Stylesheet: the toggle switch's specificity ---------------------------------------------------
// Nothing here renders CSS, so a cascade bug ships invisibly — this one did. `input[type=checkbox]` is
// (0,1,1) and `.switch` is (0,1,0), so a bare checkbox rule silently outranks the switch and collapses
// every toggle in the config form to a 16px circle with its thumb outside it.
//
// This does not evaluate the cascade (that needs a browser). It pins the one invariant that broke: a
// checkbox sizing rule must not also match a switch.
const sheet = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
for (const m of sheet.matchAll(/(^|\})([^{}]*input\[type=checkbox\][^{}]*)\{([^}]*)\}/g)) {
  const selector = m[2].trim(), body = m[3];
  if (!/(^|;)\s*(width|height)\s*:/.test(body)) continue;          // not a sizing rule
  if (selector.includes('.switch') && !selector.includes(':not(.switch)')) continue;  // the switch's own
  if (!selector.includes(':not(.switch)'))
    fail(`"${selector}" sizes checkboxes without excluding .switch — it outranks the switch rules and `
       + 'collapses every toggle. Add :not(.switch), or raise the switch selector above it.');
}

console.log(`smoke: build() rendered ${linkText.length} nav links across ${groups.length} groups; `
  + `Flow + Nodes editors OK; change tracking, palette (${cmdItems.length} pages) and theme OK`);

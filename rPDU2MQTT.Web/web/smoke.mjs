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
const flowGraph = {
  ok: true,
  nodes: [{ id: 'solar', label: 'Solar', kind: 'node' }, { id: 'panel', label: 'Panel', kind: 'node' }],
  links: [{ source: 'solar', target: 'panel', value: 750 }],
  metric: 'realpower', units: 'W',
};

const bodies = (url) =>
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
if (!query(getEl('sections'), '.section', true).map(s => s.textContent).join(' ').includes('Hierarchy'))
  fail('the Flow tab did not render the hierarchy editor');

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

const editorText = query(getEl('sections'), '.section', true).map(s => s.textContent).join(' ');
if (!editorText.includes('Live value bindings')) fail('opening a node did not render its bindings editor');
if (!editorText.includes('Feeders & children')) fail('the node editor did not render the feeders/children wiring');
if (!query(getEl('sections'), 'input', true).some(i => i.attrs.value === 'solar_assistant/inverter_1/pv_power/state'))
  fail('the node editor did not surface the migrated MQTT binding as an editable topic');
// The Modbus binding row must render its connection picker, listing the configured connection.
if (!editorText.includes('Inverter')) fail('the Modbus binding row did not list the configured connection');

// --- Flow node hover card ----------------------------------------------------------------------------
// The card is only reachable by hovering a Sankey node, so nothing else would notice it breaking.
flowLink.click();
await new Promise(r => setTimeout(r, 50));
const nodeRect = query(getEl("sections"), "rect", true).find(r => r.attrs.width === "12" && r._on.mouseenter);
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

console.log(`smoke: build() rendered ${linkText.length} nav links across ${groups.length} groups; `
  + `Flow + Nodes editors OK; change tracking, palette (${cmdItems.length} pages) and theme OK`);

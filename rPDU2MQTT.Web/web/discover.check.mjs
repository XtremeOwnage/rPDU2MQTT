// Importing readings other integrations announce over Home Assistant MQTT discovery.
//
// Covers what the panel refuses: an entity whose value template transforms the field cannot be bound, and
// one already modelled must not be added twice. Both render as disabled rows carrying a reason, rather
// than being omitted from the list.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('discover check FAILED: ' + m); process.exit(1); };

// 'esp_garage_power' is importable; 'shelly_scaled' has a template we cannot read; 'solar' already exists.
const importable = {
  ok: true, scanned: 120,
  readings: [
    { id: 'esp_garage_power', uniqueId: 'esp_garage_power', label: 'Garage Meter Power', device: 'Garage Meter',
      topic: 'esphome/garage/sensor/power/state', metric: 'realpower', unit: 'W', jsonField: null, unsupported: null },
    { id: 'shelly_scaled', uniqueId: 'shelly_scaled', label: 'Shelly Scaled', device: 'Shelly EM',
      topic: 'shelly/em/power', metric: 'realpower', unit: 'W', jsonField: null,
      unsupported: 'its value template does more than read a field' },
    { id: 'solar', uniqueId: 'solar', label: 'Solar', device: 'Inverter',
      topic: 'sa/pv_power', metric: 'realpower', unit: 'W', jsonField: null, unsupported: null },
  ],
};

// Topic-matched readings state no unit: esphome/.../energy_d/state = 3063.783 is Wh or kWh depending only
// on the value. The panel must ask rather than assume.
const pattern = {
  ok: true, scanned: 68, profile: 'esphome',
  readings: [
    { id: 'esphome_deep_freezer_energy_d', label: 'deep_freezer energy_d', device: 'deep_freezer',
      topic: 'esphome/devices/deep_freezer/sensor/energy_d/state', metric: 'energy', unit: null,
      units: ['kWh', 'Wh', 'MWh'], canonicalUnit: 'kWh', jsonField: null, sample: '3063.783', unsupported: null },
    { id: 'esphome_fridge_energy_d', label: 'fridge energy_d', device: 'fridge',
      topic: 'esphome/devices/fridge/sensor/energy_d/state', metric: 'energy', unit: null,
      units: ['kWh', 'Wh', 'MWh'], canonicalUnit: 'kWh', jsonField: null, sample: '1365.109', unsupported: null },
      { id: 'esphome_fridge_power', label: 'fridge power', device: 'fridge',
      topic: 'esphome/devices/fridge/sensor/power/state', metric: 'realpower', unit: null,
      units: ['W', 'kW', 'MW'], canonicalUnit: 'W', jsonField: null, sample: '97.6', unsupported: null },
    // Sanitises to 'main_panel', which is an unrelated node already in the config.
    { id: 'esphome_main_panel_power', label: 'main panel power', device: 'main panel',
      topic: 'esphome/devices/main_panel/sensor/power/state', metric: 'realpower', unit: null,
      units: ['W', 'kW', 'MW'], canonicalUnit: 'W', jsonField: null, sample: '12.0', unsupported: null },
  ],
};

// 'solar' already binds the topic the discovery scan offers, so that row is not importable again.
const cfg = {
  EnergyFlow: {
    Nodes: [
      { Id: 'solar', Label: 'Solar', Sources: [{ Type: 'mqtt', Topic: 'sa/pv_power', Metric: 'realpower' }] },
      { Id: 'main_panel', Label: 'Main Panel' },
    ],
    Links: [],
  },
};

const builtIn = {
  ok: true,
  profile: {
    id: 'esphome', label: 'ESPHome', filter: 'esphome/#',
    pattern: 'esphome/devices/{device}/sensor/{measure}/state', jsonField: null,
    metrics: { power: 'realpower', energy_d: 'energy' },
  },
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? cfg :
    url.includes('/api/mqtt/profile?') ? builtIn :
    url.includes('/api/mqtt/profiles') ? { ok: true, profiles: [
      { id: 'esphome', label: 'ESPHome', pattern: 'esphome/devices/{device}/sensor/{measure}/state' },
      { id: 'custom:Tasmota', label: 'Tasmota', pattern: 'tele/{device}/SENSOR/{measure}' },
    ] } :
    url.includes('/api/mqtt/importable/pattern') ? pattern :
    url.includes('/api/mqtt/importable') ? importable :
    url.includes('/api/flow/live') ? { ok: true, values: [] } :
    url.includes('/api/flow/withheld') ? { ok: true, sources: [] } :
    url.includes('/api/flow') ? { ok: true, nodes: [], links: [], metric: 'realpower', units: 'W' } :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

// Its own page under Integrations, not the node editor's toolbar: it reads the broker rather than the PDU.
const nav = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'MQTT Import');
if (!nav) fail('no MQTT Import page in the nav');
nav.click();
await new Promise(r => setTimeout(r, 200));

const buttons = () => query(getEl('sections'), 'button', true);
// The label carries the count once rows are ticked, so match on the prefix.
const addButtons = () => buttons().filter(b => /^Add( \d+)? selected$/.test(b.textContent || ''));
const addButton = () => {
  const b = addButtons()[0];
  if (!b) fail('no "Add selected" control');
  return b;
};
if (!buttons().some(b => b.textContent === 'Scan broker')) fail('the MQTT Import page rendered no scan control');

buttons().find(b => b.textContent === 'Scan broker').click();
await new Promise(r => setTimeout(r, 200));

const rows = query(getEl('sections'), 'tr', true).filter(r => query(r, 'input', true).length);
if (rows.length !== 3) fail(`expected a row per reading, got ${rows.length}`);

const boxFor = (label) => {
  const row = rows.find(r => r.textContent.includes(label));
  if (!row) fail(`no row for ${label}`);
  return { row, box: query(row, 'input', true)[0] };
};

// Importable: selectable.
const good = boxFor('Garage Meter Power');
if (good.box.disabled) fail('an importable reading was not selectable');

// Unreadable template: shown, disabled, and says why.
const bad = boxFor('Shelly Scaled');
if (!bad.box.disabled) fail('a reading whose template cannot be read was offered for import');
if (!bad.row.textContent.includes('Cannot import')) fail('the refused row does not say why');

// Already modelled: shown, disabled, and says so.
const dup = boxFor('Solar');
if (!dup.box.disabled) fail('a reading that is already a node was offered again');
if (!dup.row.textContent.includes('Already bound')) fail('the duplicate row does not say why');

// Taking the importable one adds a node, tagged, valued only by its own binding.
good.box.checked = true;
good.box.onchange({});
addButton().click();
await new Promise(r => setTimeout(r, 100));

// The node id comes from the device, not the reading: "Garage Meter" -> garage_meter.
const added = cfg.EnergyFlow.Nodes.find(n => n.Id === 'garage_meter');
if (!added) fail('selecting a reading did not add a node');
if (JSON.stringify(added.Tags) !== JSON.stringify(['imported'])) fail(`the imported node was not tagged: ${JSON.stringify(added.Tags)}`);
if (added.Mode !== 'none') fail('an imported node must not be set to aggregate children it does not have');
const src = (added.Sources || [])[0] || {};
if (src.Topic !== 'esphome/garage/sensor/power/state') fail('the binding does not point at the discovered topic');
if (src.Metric !== 'realpower' || src.Unit !== 'W') fail('the binding lost the metric or unit');

// And nothing else was added — in particular not the two refused rows.
if (cfg.EnergyFlow.Nodes.length !== 3) fail(`expected the two seeded nodes plus one device, got ${cfg.EnergyFlow.Nodes.map(n => n.Id).join(', ')}`);

// --- The topic-profile path.
const sel = query(getEl('sections'), 'select', true)
  .find(s => (s.children || []).some(o => (o.value || (o.attrs && o.attrs.value)) === 'esphome'));
if (!sel) fail('no source selector offering the topic profiles');
// Profiles come from the server, so one defined in config appears without a rebuild.
const opts = (sel.children || []).map(o => o.value || (o.attrs && o.attrs.value));
if (!opts.includes('custom:Tasmota')) fail(`a configured profile is missing from the source list: ${opts.join(', ')}`);
sel.value = 'esphome';
buttons().find(b => b.textContent === 'Scan broker').click();
await new Promise(r => setTimeout(r, 200));

const patRow = query(getEl('sections'), 'tr', true).find(r => r.textContent.includes('deep_freezer'));
if (!patRow) fail('the topic-profile scan rendered no row');
// The sampled value is shown, because it is the only thing that distinguishes Wh from kWh.
if (!patRow.textContent.includes('3063.783')) fail('the row does not show the sampled value');
// The unit is a dropdown of what the converter accepts, defaulted to the metric's canonical unit.
const unitBox = query(patRow, 'select', true)[0];
if (!unitBox) fail('a topic-matched reading has no unit control');
const unitOpts = (unitBox.children || []).map(o => o.value || (o.attrs && o.attrs.value));
if (!unitOpts.includes('Wh') || !unitOpts.includes('kWh'))
  fail(`the unit list does not come from the metric's converter table: ${unitOpts.join(', ')}`);
if (unitBox.value !== 'kWh') fail(`expected the canonical unit as the default, got '${unitBox.value}'`);

// Wire the imports into an existing node, so they join the hierarchy rather than sitting apart from it.
const feeds = query(getEl('sections'), 'select', true)
  .find(sl => (sl.children || []).some(o => (o.value || (o.attrs && o.attrs.value)) === 'main_panel'));
if (!feeds) fail('no feeder selector offering the configured nodes');
if (feeds.value !== '') fail(`the feeder defaulted to '${feeds.value}' rather than leaving nodes unwired`);
feeds.value = 'main_panel';

// Select all: one click rather than one per row.
buttons().find(b => b.textContent === 'Select all').click();
await new Promise(r => setTimeout(r, 20));
const allRows = query(getEl('sections'), 'tr', true).filter(r => query(r, 'input', true).length);
const checkable = allRows.map(r => query(r, 'input', true)[0]).filter(b => !b.disabled);
if (!checkable.every(b => b.checked)) fail('Select all left rows unchecked');

// The action is repeated below the table: with twenty rows the toolbar scrolls out of view, leaving the
// page's Save button as the only visible control.
if (addButtons().length < 2) fail('the Add action is not repeated below the table');
// The label counts what is ticked, so the button states what pressing it will do.
if (!addButtons().some(b => /^Add \d+ selected$/.test(b.textContent)))
  fail(`the Add button does not show how many rows are ticked: ${addButtons().map(b => b.textContent).join(' | ')}`);

// Per-metric unit setter: changing it moves every row of that metric, and leaves the others alone.
const bulkSels = query(getEl('sections'), 'select', true)
  .filter(sel => (sel.children || []).some(o => (o.value || (o.attrs && o.attrs.value)) === 'Wh'));
const bulkEnergy = bulkSels[0];
if (!bulkEnergy) fail('no per-metric unit setter for energy');
bulkEnergy.value = 'Wh';
bulkEnergy.onchange({});
await new Promise(r => setTimeout(r, 20));

const energyRows = allRows.filter(r => r.textContent.includes('energy_d'));
for (const row of energyRows) {
  const sel = query(row, 'select', true)[0];
  if (sel.value !== 'Wh') fail(`the bulk setter missed an energy row: ${sel.value}`);
}
const powerRow = allRows.find(r => r.textContent.includes('fridge power'));
if (query(powerRow, 'select', true)[0].value !== 'W') fail('the energy bulk setter changed a power row');

// Import straight from the bulk setting, without touching the row's own control: the bulk change has to
// reach the reading, not just the dropdown that displays it.
addButton().click();
await new Promise(r => setTimeout(r, 100));

const imported = cfg.EnergyFlow.Nodes.find(n => n.Id === 'deep_freezer');
if (!imported) fail('the topic-matched reading was not added');
const energySrc = (imported.Sources || []).find(x => x.Metric === 'energy') || {};
if (energySrc.Unit !== 'Wh') fail('the unit set in bulk was not carried onto the binding');
if (energySrc.Accumulation !== 'lifetime') fail('an imported energy counter must default to lifetime');

// One node per device with a source per metric, not one node per reading. The fridge publishes two.
const fridge = cfg.EnergyFlow.Nodes.find(n => n.Id === 'fridge');
if (!fridge) fail(`no node for the fridge device: ${cfg.EnergyFlow.Nodes.map(n => n.Id).join(', ')}`);
if (cfg.EnergyFlow.Nodes.filter(n => n.Id.startsWith('fridge')).length !== 1)
  fail('the fridge device produced more than one node');
if ((fridge.Sources || []).length !== 2)
  fail(`fridge should carry one source per selected metric, got ${(fridge.Sources || []).length}`);
const metrics = fridge.Sources.map(x => x.Metric).sort();
if (JSON.stringify(metrics) !== JSON.stringify(['energy', 'realpower'])) fail(`wrong metrics on the device node: ${metrics}`);
// Each source keeps its own unit: the energy one set in bulk, the power one its default.
if (fridge.Sources.find(x => x.Metric === 'energy').Unit !== 'Wh') fail('the energy source lost its unit');
if (fridge.Sources.find(x => x.Metric === 'realpower').Unit !== 'W') fail('the power source lost its unit');

// A device whose id collides with an unrelated node is imported beside it, not merged into it. Appending
// one device's topics to another node would bind the wrong readings to it.
const panel = cfg.EnergyFlow.Nodes.find(n => n.Id === 'main_panel');
if ((panel.Sources || []).length) fail('an unrelated node absorbed the imported device\'s sources');
if (!cfg.EnergyFlow.Nodes.some(n => n.Id === 'main_panel_2')) fail(
  `the colliding device was not imported under a free id: ${cfg.EnergyFlow.Nodes.map(n => n.Id).join(', ')}`);

// Every imported node is wired to the chosen node, as a load drawn from it.
//
// Direction matters: an appliance monitor draws from the panel. Wiring it as a feeder adds its draw to the
// panel's total while the appliance is still inside the panel's unmeasured remainder, counting it twice.
const links = cfg.EnergyFlow.Links || [];
for (const id of ['deep_freezer', 'fridge']) {
  const link = links.find(l => l.To === id);
  if (!link) fail(`${id} was imported with no link, leaving it disconnected on the diagram`);
  if (link.From !== 'main_panel') fail(`${id} was wired from '${link.From}' rather than the chosen node`);
  if (links.some(l => l.From === id)) fail(`${id} was wired as a feeder, inflating what it draws from`);
}

// --- A built-in profile can be copied into config to edit.
// The add re-rendered the panel, so re-select the source first.
const srcAgain = query(getEl('sections'), 'select', true)
  .find(sl => (sl.children || []).some(o => (o.value || (o.attrs && o.attrs.value)) === 'esphome'));
srcAgain.value = 'esphome';
buttons().find(b => b.textContent === 'Copy this profile to config').click();
await new Promise(r => setTimeout(r, 100));
const copied = ((cfg.MQTT || {}).ImportProfiles || []).find(p => p.Name === 'ESPHome');
if (!copied) fail('copying a built-in profile put nothing into MQTT.ImportProfiles');
if (copied.Pattern !== 'esphome/devices/{device}/sensor/{measure}/state') fail('the copied profile lost its pattern');
if (!copied.Metrics || copied.Metrics.power !== 'realpower') fail('the copied profile lost its metric map');

console.log('discover: both scans import; refusals shown with a reason; units default and set in bulk; '
  + 'imported nodes are wired to the chosen feeder; a built-in profile copies into config');

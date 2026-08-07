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
  ],
};

const cfg = { EnergyFlow: { Nodes: [{ Id: 'solar', Label: 'Solar' }], Links: [] } };

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? cfg :
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
if (!dup.row.textContent.includes('Already a node')) fail('the duplicate row does not say why');

// Taking the importable one adds a node, tagged, valued only by its own binding.
good.box.checked = true;
good.box.onchange({});
buttons().find(b => b.textContent === 'Add selected').click();
await new Promise(r => setTimeout(r, 100));

const added = cfg.EnergyFlow.Nodes.find(n => n.Id === 'esp_garage_power');
if (!added) fail('selecting a reading did not add a node');
if (JSON.stringify(added.Tags) !== JSON.stringify(['imported'])) fail(`the imported node was not tagged: ${JSON.stringify(added.Tags)}`);
if (added.Mode !== 'none') fail('an imported node must not be set to aggregate children it does not have');
const src = (added.Sources || [])[0] || {};
if (src.Topic !== 'esphome/garage/sensor/power/state') fail('the binding does not point at the discovered topic');
if (src.Metric !== 'realpower' || src.Unit !== 'W') fail('the binding lost the metric or unit');

// And nothing else was added — in particular not the two refused rows.
if (cfg.EnergyFlow.Nodes.length !== 2) fail(`expected 2 nodes, got ${cfg.EnergyFlow.Nodes.map(n => n.Id).join(', ')}`);

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

// Select all: one click rather than one per row.
buttons().find(b => b.textContent === 'Select all').click();
await new Promise(r => setTimeout(r, 20));
const allRows = query(getEl('sections'), 'tr', true).filter(r => query(r, 'input', true).length);
const checkable = allRows.map(r => query(r, 'input', true)[0]).filter(b => !b.disabled);
if (!checkable.every(b => b.checked)) fail('Select all left rows unchecked');

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
buttons().find(b => b.textContent === 'Add selected').click();
await new Promise(r => setTimeout(r, 100));

const imported = cfg.EnergyFlow.Nodes.find(n => n.Id === 'esphome_deep_freezer_energy_d');
if (!imported) fail('the topic-matched reading was not added');
if ((imported.Sources[0] || {}).Unit !== 'Wh') fail('the unit the operator entered was not carried onto the binding');
if ((imported.Sources[0] || {}).Accumulation !== 'lifetime') fail('an imported energy counter must default to lifetime');

console.log('discover: discovery and topic-profile scans both import; refusals are shown with a reason; a '
  + 'topic-matched reading asks for its unit and carries it onto the binding');

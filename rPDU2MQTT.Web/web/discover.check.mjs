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

const cfg = { EnergyFlow: { Nodes: [{ Id: 'solar', Label: 'Solar' }], Links: [] } };

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? cfg :
    url.includes('/api/mqtt/importable') ? importable :
    url.includes('/api/flow/live') ? { ok: true, values: [] } :
    url.includes('/api/flow/withheld') ? { ok: true, sources: [] } :
    url.includes('/api/flow') ? { ok: true, nodes: [], links: [], metric: 'realpower', units: 'W' } :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

const nav = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes');
if (!nav) fail('no Nodes tab');
nav.click();
await new Promise(r => setTimeout(r, 200));

const buttons = () => query(getEl('sections'), 'button', true);
const discover = buttons().find(b => b.textContent === 'Discover from MQTT');
if (!discover) fail('no "Discover from MQTT" button on the Nodes tab');
discover.click();
await new Promise(r => setTimeout(r, 50));

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

console.log('discover: importable readings are addable and tagged; unreadable templates and existing nodes '
  + 'are shown disabled with a reason');

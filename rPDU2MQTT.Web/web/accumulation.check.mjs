// Saying, at import time, whether an energy counter runs forever or restarts each day.
//
// The bug this covers: the import wizard stamped every energy topic 'lifetime' and offered no way to say
// otherwise. Five smart plugs publishing "energy today" were imported that way, and because the export
// guards a lifetime counter against running backwards, each midnight reset was read as a meter going
// backwards. A plug that resets at 0.9 kWh never climbs past its own best day again, so it went quiet and
// stayed quiet — six days with nothing published.
//
// Nothing in one sample distinguishes the two, so the panel has to ask. 'lifetime' stays the default.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('accumulation check FAILED: ' + m); process.exit(1); };

// A daily counter and a lifetime one, published by the same device, plus a power reading that has no
// business carrying an accumulation at all.
const pattern = {
  ok: true, scanned: 12, profile: 'esphome',
  readings: [
    { id: 'deep_freezer_energy_d', label: 'deep_freezer energy_d', device: 'deep_freezer',
      topic: 'esphome/devices/deep_freezer/sensor/energy_d/state', metric: 'energy', unit: null,
      units: ['kWh', 'Wh'], canonicalUnit: 'kWh', jsonField: null, sample: '0.912', unsupported: null },
    { id: 'deep_freezer_power', label: 'deep_freezer power', device: 'deep_freezer',
      topic: 'esphome/devices/deep_freezer/sensor/power/state', metric: 'realpower', unit: null,
      units: ['W', 'kW'], canonicalUnit: 'W', jsonField: null, sample: '97.6', unsupported: null },
    { id: 'main_meter_energy', label: 'main_meter energy', device: 'main_meter',
      topic: 'esphome/devices/main_meter/sensor/energy/state', metric: 'energy', unit: null,
      units: ['kWh', 'Wh'], canonicalUnit: 'kWh', jsonField: null, sample: '8231.5', unsupported: null },
  ],
};

const cfg = { EnergyFlow: { Nodes: [], Links: [] } };

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? cfg :
    url.includes('/api/mqtt/profiles') ? { ok: true, profiles: [
      { id: 'esphome', label: 'ESPHome', pattern: 'esphome/devices/{device}/sensor/{measure}/state' },
    ] } :
    url.includes('/api/mqtt/importable/pattern') ? pattern :
    url.includes('/api/mqtt/importable') ? { ok: true, scanned: 0, readings: [] } :
    url.includes('/api/flow/live') ? { ok: true, values: [] } :
    url.includes('/api/flow/withheld') ? { ok: true, sources: [] } :
    url.includes('/api/flow') ? { ok: true, nodes: [], links: [], metric: 'realpower', units: 'W' } :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'MQTT Import').click();
await new Promise(r => setTimeout(r, 200));

const buttons = () => query(getEl('sections'), 'button', true);
const selects = () => query(getEl('sections'), 'select', true);
const optionsOf = (sel) => (sel.children || []).map(o => o.value || (o.attrs && o.attrs.value));

const src = selects().find(s => optionsOf(s).includes('esphome'));
if (!src) fail('no source selector offering the topic profiles');
src.value = 'esphome';
buttons().find(b => b.textContent === 'Scan broker').click();
await new Promise(r => setTimeout(r, 200));

// --- The column exists, and only for the metric it means something for ------------------------------
const header = query(getEl('sections'), 'th', true).map(h => h.textContent);
if (!header.includes('Counter')) fail(`no column for the counter kind: ${header.join(' | ')}`);

const rows = query(getEl('sections'), 'tr', true).filter(r => query(r, 'input', true).length);
const rowFor = (label) => {
  const row = rows.find(r => r.textContent.includes(label));
  if (!row) fail(`no row for ${label}`);
  return row;
};
const accIn = (row) => query(row, 'select', true).find(s => optionsOf(s).includes('period'));

const freezer = rowFor('deep_freezer energy_d');
const freezerAcc = accIn(freezer);
if (!freezerAcc) fail('an energy row offers no way to say the counter resets daily');
if (freezerAcc.value !== 'lifetime') fail(`expected 'lifetime' as the default, got '${freezerAcc.value}'`);

// A power reading accumulates nothing; offering the choice there would be noise.
if (accIn(rowFor('deep_freezer power'))) fail('a power row was offered an accumulation control');

// --- One setter moves every energy row, and reaches the reading, not just the dropdown ---------------
const bulk = selects().filter(s => optionsOf(s).includes('period'))
  .find(s => !rows.some(r => query(r, 'select', true).includes(s)));
if (!bulk) fail('no bulk setter for the energy counters');
bulk.value = 'period';
bulk.onchange({});
await new Promise(r => setTimeout(r, 20));

for (const label of ['deep_freezer energy_d', 'main_meter energy'])
  if (accIn(rowFor(label)).value !== 'period') fail(`the bulk setter missed ${label}`);

// One row goes back to lifetime by hand: the bulk control is a starting point, not a verdict.
const meterAcc = accIn(rowFor('main_meter energy'));
meterAcc.value = 'lifetime';
meterAcc.onchange({});

buttons().find(b => b.textContent === 'Select all').click();
await new Promise(r => setTimeout(r, 20));
buttons().filter(b => /^Add( \d+)? selected$/.test(b.textContent || ''))[0].click();
await new Promise(r => setTimeout(r, 100));

// --- What actually landed in the config ---------------------------------------------------------------
const sourceOn = (id, metric) => {
  const node = cfg.EnergyFlow.Nodes.find(n => n.Id === id);
  if (!node) fail(`${id} was not imported: ${cfg.EnergyFlow.Nodes.map(n => n.Id).join(', ') || 'nothing'}`);
  const s = (node.Sources || []).find(x => x.Metric === metric);
  if (!s) fail(`${id} has no ${metric} binding`);
  return s;
};

// Set in bulk and never touched again — the change has to reach the reading behind the dropdown.
if (sourceOn('deep_freezer', 'energy').Accumulation !== 'period')
  fail(`the daily counter was imported as '${sourceOn('deep_freezer', 'energy').Accumulation}'`);
// Set in bulk, then overridden on the row.
if (sourceOn('main_meter', 'energy').Accumulation !== 'lifetime')
  fail(`the per-row override was lost: '${sourceOn('main_meter', 'energy').Accumulation}'`);
// Accumulation is meaningless off an energy metric and must not be written.
if (sourceOn('deep_freezer', 'realpower').Accumulation !== undefined)
  fail('a power binding was given an accumulation');

console.log('accumulation: the import panel asks whether each energy counter runs forever or resets daily, '
  + 'defaults to lifetime, offers the choice only for energy, drives every energy row from one setter, '
  + 'keeps a per-row override, and carries the answer onto the binding it writes');

// The MQTT and Modbus explorers on their integration pages: ticked readings become a new node, opened in the node editor.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('explorer check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const config = {
  History: { Enabled: false },
  MQTT: {},
  Modbus: { Connections: [{ Id: 'meter_gw', Name: 'Meter gateway', Host: '10.0.0.5', Port: 502, UnitId: 1 }] },
  EnergyFlow: { Nodes: [{ Id: 'taken', Label: 'Taken', Mode: 'none' }], Links: [] },
};
const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? config
    : url.includes('/api/mqtt/topics') ? { ok: true, listening: true, indexed: 2, capacity: 1000, filter: '#', topics: [
        { topic: 'solar/pv/power', value: 4200, unit: 'W', metric: 'realpower' },
        { topic: 'solar/pv/energy', value: 12.5, unit: 'kWh', metric: 'energy' },
        { topic: 'solar/inverter/temperature/state', value: 41, unit: '°C' },
        // A JSON payload: the topic list reports its numeric fields as dotted paths, not objects.
        { topic: 'shelly/em/status', payload: '{"volts":230.5,"amps":4.25}', isJson: true, fields: ['volts', 'amps'] },
      ] }
    : url.includes('/api/modbus/scan') ? { ok: true, rows: [{ register: 0, uint16: 230, int16: 230, uint32: 15073280, float32: null }] }
    : url.includes('/api/flow') ? { ok: true, nodes: [], links: [] }
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(60);

const body = sandbox.document.body;
const navTo = async (label) => {
  const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === label);
  if (!link) fail(`there is no ${label} page; pages: ${query(getEl('nav'), 'a', true).map(a => a.dataset.label).join(', ')}`);
  link.click();
  await wait(200);
  return query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
};
const sheet = (title) => query(body, '.sheet-panel', true).find(p => query(p, 'h4', true).some(h => h.textContent.startsWith(title)));
const button = (root, text) => query(root, 'button', true).find(b => b.textContent === text);
const idInput = (root) => query(root, 'input', true).find(i => (i.attrs.placeholder || i.placeholder) === 'id (e.g. gridboss)');
const nodes = () => config.EnergyFlow.Nodes;

// MQTT: tick two topics and create a node from them.
let sec = await navTo('MQTT');
const exploreTopics = button(sec, 'Explore topics');
if (!exploreTopics) fail('the MQTT page has no Explore topics button');
await exploreTopics.onclick();
await wait(80);
let explorer = sheet('MQTT explorer');
if (!explorer) fail('Explore topics did not open the MQTT explorer');
// The topics are a tree of their segments, not a flat list: solar > pv > power/energy.
const treeRow = (name) => query(explorer, 'tr', true).find(r => query(r, 'code', true).some(c => c.textContent === name));
for (const seg of ['solar', 'pv', 'power', 'energy'])
  if (!treeRow(seg)) fail(`the topic tree has no row for "${seg}"; rows: ${query(explorer, 'tr', true).map(r => query(r, 'code')?.textContent).join(', ')}`);
if (!/3 topic\(s\)/.test(treeRow('solar').textContent)) fail(`a branch does not say how many topics are under it: ${treeRow('solar').textContent}`);
// A chain of single children is one row, not one per segment.
if (!treeRow('inverter/temperature/state')) fail(`a single-child chain was not condensed into one row; rows: ${query(explorer, 'tr', true).map(r => query(r, 'code')?.textContent).join(', ')}`);
if (treeRow('inverter') || treeRow('temperature')) fail('a condensed chain still has a row per segment');
if (!button(explorer, 'Create node').disabled) fail('Create node is enabled with nothing ticked');

// A JSON payload is readable in full: 48 truncated characters say nothing, and there is nowhere else to look.
const jsonRow = treeRow('shelly/em/status');
if (!jsonRow) fail('no row for the JSON topic');
if (!/JSON · 2 field\(s\)/.test(jsonRow.textContent)) fail(`the JSON row does not count its fields: ${jsonRow.textContent}`);
const valueCell = query(jsonRow, 'td', true).find(td => td.classList.contains('num'));
if (!valueCell.onclick) fail('the value cannot be opened');
valueCell.onclick();
const payload = query(explorer, '.payload-row', true)[0];
if (!payload) fail('opening a payload showed nothing');
if (!/"volts": 230.5/.test(payload.textContent)) fail(`the payload is not shown in full: ${payload.textContent}`);
if (!/\n/.test(query(payload, 'pre', true)[0].textContent)) fail('the JSON payload is not laid out to read');
// The fields worth binding, with what each one currently holds.
if (!/volts = 230.5/.test(payload.textContent) || !/amps = 4.25/.test(payload.textContent))
  fail(`the payload does not list its fields and values: ${payload.textContent}`);
valueCell.onclick();
if (query(explorer, '.payload-row', true).length) fail('the payload would not close again');

// Ticking that topic offers its fields by name — they arrive as strings here, not objects.
const jsonBox = query(jsonRow, 'input[type=checkbox]', true)[0];
jsonBox.checked = true; jsonBox.onchange();
button(explorer, 'Create node').onclick();
const jsonDialog = sheet('Create node');
const fieldSel = query(jsonDialog, 'select', true).find(s => (s.children || []).some(o => o.value === 'volts'));
if (!fieldSel) fail('a JSON topic was offered no field to bind');
if (!(fieldSel.children || []).some(o => o.value === 'amps')) fail('the field list is incomplete');
query(jsonDialog, 'button', true).find(b => b.textContent === 'Close').onclick();
jsonBox.checked = false; jsonBox.onchange();

// Collapsing a branch hides what is under it, and opening it again brings it back.
const toggleOf = (name) => query(treeRow(name), 'span', true)[0];
toggleOf('solar').onclick();
if (treeRow('power')) fail('collapsing a branch left its topics on show');
toggleOf('solar').onclick();
if (!treeRow('power')) fail('re-opening a branch did not bring its topics back');

// Ticking a branch ticks every topic under it.
const branchBox = query(treeRow('pv'), 'input[type=checkbox]', true)[0];
branchBox.checked = true; branchBox.onchange();
if (!query(treeRow('power'), 'input[type=checkbox]', true)[0].checked) fail('ticking a branch did not tick the topics under it');
button(explorer, 'Create node').onclick();
let dialog = sheet('Create node');
if (!dialog) fail('Create node did not open the create dialog');
if (idInput(dialog).value !== 'pv') fail(`the suggested id is not the topics' shared prefix: "${idInput(dialog).value}"`);

idInput(dialog).value = 'taken';
button(dialog, 'Create node').onclick();
if (nodes().length !== 1 || !/already exists/.test(dialog.textContent)) fail('a node was created over an existing id');

idInput(dialog).value = 'pv_array';
button(dialog, 'Create node').onclick();
await wait(250);
const pv = nodes().find(n => n.Id === 'pv_array');
if (!pv) fail('Create node did not add the node');
if (JSON.stringify(pv.Sources.map(s => [s.Type, s.Topic, s.Metric])) !== JSON.stringify([['mqtt', 'solar/pv/power', 'realpower'], ['mqtt', 'solar/pv/energy', 'energy']]))
  fail(`the node's bindings are not the ticked topics: ${JSON.stringify(pv.Sources)}`);
if (sheet('MQTT explorer') || sheet('Create node')) fail('the explorer or dialog stayed open after creating the node');
sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!query(sec, 'h2', true).some(h => h.textContent === 'Energy Nodes')) fail('creating a node did not go to the Nodes page');
if (!sheet('Edit node — pv_array')) fail('the new node did not open in the node editor');

// Modbus: tick one decoded register and create a node from it.
sec = await navTo('Modbus TCP');
const exploreRegisters = button(sec, 'Explore registers');
if (!exploreRegisters) fail('the Modbus page has no Explore registers button');
await exploreRegisters.onclick();
await wait(80);
explorer = sheet('Modbus explorer');
if (!explorer) fail('Explore registers did not open the Modbus explorer');
const u32 = query(explorer, 'input[type=checkbox]', true).find(b => (b.attrs.title || b.title) === 'Register 0 as uint32');
if (!u32) fail('register 0 has no uint32 checkbox');
u32.checked = true; u32.onchange();
button(explorer, 'Create node').onclick();
dialog = sheet('Create node');
if (idInput(dialog).value !== 'meter_gw') fail(`the suggested id is not the connection's: "${idInput(dialog).value}"`);
idInput(dialog).value = 'meter';
button(dialog, 'Create node').onclick();
await wait(250);
const src = nodes().find(n => n.Id === 'meter')?.Sources?.[0];
if (!src || src.Type !== 'modbus' || src.Connection !== 'meter_gw' || src.Register !== 0 || src.DataType !== 'uint32' || src.RegisterType !== undefined)
  fail(`the Modbus binding is not the ticked register: ${JSON.stringify(src)}`);

console.log('explorer: the MQTT page shows the broker as a topic tree that opens, closes and ticks a whole branch, '
  + 'reads a JSON payload in full with its fields and values, '
  + 'condenses a single-child chain into one row, the Modbus page explores registers, ticked readings become a new node with a binding each, an existing id is '
  + 'refused, and the node opens in the node editor');
process.exit(0);

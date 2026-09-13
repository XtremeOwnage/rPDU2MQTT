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
const boxes = query(explorer, 'input[type=checkbox]', true);
if (boxes.length !== 2) fail(`expected a checkbox per topic, found ${boxes.length}`);
if (!button(explorer, 'Create node').disabled) fail('Create node is enabled with nothing ticked');
boxes.forEach(b => { b.checked = true; b.onchange(); });
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

console.log('explorer: the MQTT and Modbus pages explore topics and registers, ticked readings become a new node '
  + 'with a binding each, an existing id is refused, and the node opens in the node editor');
process.exit(0);

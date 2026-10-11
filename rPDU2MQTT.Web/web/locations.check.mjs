// Locations page: one nav entry, tree, totals, nodes, add/rename/delete, add-nodes picker, sensors, HA sync and publish.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const page = (f) => readFile(new URL('../../plugins/rPDU2MQTT.Plugin.Locations/wwwroot/locations.' + f, import.meta.url), 'utf8');
const pageJs = await page('js'), css = await page('css');
const pages = [{ id: 'locations', title: 'Locations', group: 'Energy Flow', icon: '⌂', configSection: 'Plugins.locations' }];
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8')).filter(n => n.key !== '_README')
  .concat([{ key: 'locations', label: 'Locations', type: 'object', group: 'Integrations', properties: [] }]);
const fail = (m) => { console.error('locations check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const config = {
  History: { Enabled: false },
  Plugins: {
    locations: {
      Sites: [{ Id: 'home', Name: 'Home', Floors: [{ Id: 'ground', Name: 'Ground', Level: 0,
        Rooms: [{ Id: 'kitchen', Name: 'Kitchen', Climate: { Temperature: ['fridge'], Humidity: [], Combine: 'average' } }, { Id: 'office', Name: 'Office' }],
        Areas: [{ Id: 'front', Name: 'Front', Rooms: ['kitchen', 'office'] }] }] }],
      AutoLocations: [{ Match: 'outlet:rack:*', Location: 'office' }],
    },
  },
  EnergyFlow: {
    Nodes: [{ Id: 'desk', Label: 'Desk', Ext: { locations: { Location: 'office' } } }],
    Panels: [{ Id: 'main', Breakers: [{ Number: 'B06', Ext: { locations: { Rooms: ['kitchen'] } } }] }],
  },
};

const P = (id, kind, value, state = 'known') => ({ id, name: id, kind, site: 'home', floor: kind === 'site' ? null : 'ground', value, state, nodes: [], missing: [], split: [] });
const nodes = [
  { id: 'desk', label: 'Desk', kind: 'load', value: 40, location: 'office', via: 'own' },
  { id: 'outlet:rack:1', label: 'Rack 1', kind: 'outlet', value: 80, location: 'office', via: 'rule' },
  { id: 'fridge', label: 'Fridge', kind: 'load', value: 150, location: 'kitchen', via: 'circuit' },
  { id: 'tv', label: 'TV', kind: 'load', value: 90, location: null, via: null },
];
const totals = (q) => ({ ok: true, metric: 'realpower', units: q ? 'kWh' : 'W', problems: [], message: null, nodes, circuits: [], placements: [],
  places: [P('home', 'site', 270), P('ground', 'floor', 270), { ...P('kitchen', 'room', q ? 1.5 : 150), temperature: 21.5, humidity: null }, P('office', 'room', 120), P('front', 'area', 270)] });

const haPlan = {
  floors: [{ floor: 'ground', name: 'Ground', level: 0, action: 'create', floorId: null, floorName: null, why: 'No floor of this name.' }],
  rooms: [{ room: 'office', name: 'Office', action: 'create', areaId: null, areaName: null, why: 'No area of this name.' }],
  fields: [{ room: 'office', name: 'Office', field: 'temperature', value: 'sensor.x', current: null, action: 'set', why: 'Set to sensor.x.' }],
  devices: [], leftAlone: [{ areaId: 'attic', name: 'Attic' }],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/integrations/locations/totals')) return { ok: true, result: totals(url.includes('period=today')) };
    if (url.includes('/api/integrations/locations/areas-preview')) return { ok: true, result: { ok: true, plan: haPlan } };
    if (url.includes('/api/integrations/locations/areas-apply')) return { ok: true, result: { ok: true, plan: haPlan, linked: { office: 'area_office' }, linkedFloors: { ground: 'floor_ground' }, failed: [], message: 'Published.' } };
    if (url.endsWith('/api/integrations/locations/pages/locations.js')) return pageJs;
    if (url.endsWith('/api/integrations/locations/pages/locations.css')) return css;
    if (url.endsWith('/api/integrations')) return { ok: true, integrations: [{ id: 'locations', pages }] };
    if (url.includes('/api/schema')) return schema;
    if (url.includes('/api/instances')) return { ok: true, instances: [] };
    if (url.includes('/api/config')) return config;
    if (url.includes('/api/flow')) return { ok: true, nodes: [], links: [] };
    return { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(50);

const links = query(getEl('nav'), 'a', true).filter(a => a.dataset.label === 'Locations');
if (links.length !== 1) fail(`${links.length} Locations entries in the nav, not 1`);
const link = links[0];
link.click();
await wait(100);
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('clicking Locations activated no section');
const rows = () => query(sec, '.loc-row', true);
const row = (name) => rows().find(r => (r.textContent || '').startsWith(name));
const button = (text, root = sec) => query(root, 'button', true).find(b => (b.textContent || '').trim() === text || b.title === text);
const textOf = (n) => n?.textContent || '';

if (rows().length !== 5) fail(`tree has ${rows().length} rows, not 5`);
if (!textOf(row('Kitchen')).includes('150')) fail('kitchen row shows no power');
if (!query(row('Front'), '.loc-tag')) fail('area not marked');
if (!query(sec, '.loc-detail h3') || textOf(query(sec, '.loc-detail h3')) !== 'Home') fail('first place not selected by default');

row('Office').click();
const detail = () => query(sec, '.loc-detail');
if (textOf(query(detail(), 'h3')) !== 'Office' || textOf(query(detail(), '.loc-chip')) !== 'room') fail('office detail not shown');
const members = () => query(detail(), '.loc-member', true);
if (!members().some(m => textOf(m).includes('Desk')) || !members().some(m => textOf(m).includes('Rack 1'))) fail('office members missing');
const deskRow = members().find(m => textOf(m).includes('Desk'));
if (!button('Remove', deskRow)) fail('a set member has no Remove');
const rackRow = members().find(m => textOf(m).includes('Rack 1'));
if (button('Remove', rackRow)) fail('a pattern-rule member offers Remove');

row('Front').click();
if (!members().some(m => textOf(m).includes('Fridge') && m.classList.contains('is-inherited'))) fail('area does not list inherited members');

row('Kitchen').click();
if (!textOf(detail()).includes('1.5')) fail('today total not shown');
if (!textOf(query(detail(), '.loc-stats')).includes('Temperature')) fail('temperature not shown');
const climate = query(detail(), '.loc-field', true).find(f => textOf(f).startsWith('Temperature'));
if (!climate || !textOf(climate).includes('Fridge')) fail('temperature sensor not listed');
button('Remove', climate).click();
if (config.Plugins.locations.Sites[0].Floors[0].Rooms[0].Climate.Temperature.length) fail('temperature sensor not removed');

// Add a room, rename it: the id follows the first name.
row('Ground').click();
button('+ Room').click();
const st = { data: config };
let rooms = st.data.Plugins.locations.Sites[0].Floors[0].Rooms;
if (rooms.length !== 3) fail('Add room did not add one');
const nameIn = query(detail(), 'input', true)[0];
nameIn.value = 'Laundry Room'; nameIn.onchange();
if (rooms[2].Id !== 'laundry_room' || rooms[2].Name !== 'Laundry Room') fail(`new room id did not follow its name: ${JSON.stringify(rooms[2])}`);
const nameIn2 = query(detail(), 'input', true)[0];
nameIn2.value = 'Laundry'; nameIn2.onchange();
if (rooms[2].Id !== 'laundry') fail('renaming a new room again did not move its id');

// Existing places keep their id.
row('Kitchen').click();
const kIn = query(detail(), 'input', true)[0];
kIn.value = 'Galley'; kIn.onchange();
if (rooms[0].Id !== 'kitchen' || rooms[0].Name !== 'Galley') fail('renaming an existing room changed its id');

// Add nodes: a config node gets Ext; a discovered node gets an exact rule.
const sheet = () => query(getEl('overlay'), '.sheet');
row('Laundry').click();
button('Add nodes…').click();
const pick = (label) => { const lb = query(sheet(), '.loc-pick-row', true).find(m => textOf(m).includes(label)); const cb = query(lb, 'input'); cb.checked = true; cb.onchange(); };
pick('Desk'); pick('TV');
query(sheet(), 'button', true).find(b => b.textContent === 'Add 2 to Laundry').click();
if (st.data.EnergyFlow.Nodes[0].Ext.locations.Location !== 'laundry') fail('bulk assign did not set the config node');
const rules = st.data.Plugins.locations.AutoLocations;
if (!rules.some(r => r.Match === 'tv' && r.Location === 'laundry')) fail(`bulk assign did not add a rule for a discovered node: ${JSON.stringify(rules)}`);

// Home Assistant sync settings live on the page.
const sched = query(sec, 'select[data-key="Schedule"]') || query(sec, 'select', true).find(s => s.getAttribute?.('data-key') === 'Schedule');
if (!sched) fail('no HA schedule setting');
sched.value = 'interval'; sched.onchange();
if (st.data.Plugins.locations.HomeAssistant.Schedule !== 'interval') fail('schedule not saved');
const mins = query(query(sec, '.loc-sync'), 'input[type="number"]') || query(query(sec, '.loc-sync'), 'input');
if (!mins) fail('interval minutes not offered');

// Publish to Home Assistant: preview, apply, links written.
button('Publish to Home Assistant…').click();
await wait(20);
if (!/Ground.*create/.test(textOf(sheet())) || !/Office · temperature/.test(textOf(sheet()))) fail('preview does not list floors and area settings');
query(sheet(), 'button', true).find(b => /^Apply 3/.test(b.textContent)).click();
await wait(20);
const fl = st.data.Plugins.locations.Sites[0].Floors[0];
if (fl.HaFloor !== 'floor_ground' || fl.Rooms.find(r => r.Id === 'office').HaArea !== 'area_office') fail('apply did not record links');

// Sensors: added from a sheet, kept out of the energy nodes.
button('+ Sensor').click();
const ins = query(sheet(), 'input', true), sels = query(sheet(), 'select', true);
ins[0].value = 'Garage';
sels[0].value = 'mqtt'; sels[0].onchange();
ins[1].value = 'rtl_433/Acurite-Tower/326'; ins[2].value = 'temperature_C';
query(sheet(), 'button', true).find(b => b.textContent === 'Add sensor').click();
const sensors = st.data.Plugins.locations.Sensors || [];
const src = sensors[0]?.Sources?.[0];
if (sensors.length !== 1 || sensors[0].Id !== 'garage' || src?.Topic !== 'rtl_433/Acurite-Tower/326' || src?.Metric !== 'temperature' || src?.JsonField !== 'temperature_C') fail(`sensor not saved: ${JSON.stringify(sensors)}`);
if (st.data.EnergyFlow.Nodes.some(n => /garage/.test(n.Id))) fail('sensor became an energy node');
if (!textOf(query(sec, '.loc-sensors')).includes('Garage')) fail('sensor not listed');

// Delete a room: references go.
row('Office').click();
button('Delete').click();
rooms = st.data.Plugins.locations.Sites[0].Floors[0].Rooms;
if (rooms.some(r => r.Id === 'office')) fail('room not deleted');
if (st.data.Plugins.locations.Sites[0].Floors[0].Areas[0].Rooms.includes('office')) fail('area still takes in a deleted room');
if (rules.some(r => r.Location === 'office')) fail('rule for a deleted room kept');

// Delete the kitchen: breaker rooms drop it.
row('Galley').click();
button('Delete').click();
if (st.data.EnergyFlow.Panels[0].Breakers[0].Ext.locations.Rooms.length) fail('breaker still serves a deleted room');

console.log('locations check passed');

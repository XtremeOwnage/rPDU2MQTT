// "Hide no data" on the Flow diagram: once the gaps are known, a column of nodes nothing measures is clutter.
// What it must NOT hide is a no-data node feeding a measured one — that would cut the measured node off.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('hide-no-data check FAILED: ' + m); process.exit(1); };

// A PDU with a live outlet; a light and a branch of lights nothing measures; and a panel nothing meters whose
// circuit is metered.
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'pdu', label: 'Rack-PDU-1', value: 300 },
    { id: 'live_outlet', label: 'Dell r730XD', value: 240 },
    { id: 'hall_light', label: 'Hallway_Light', value: null },
    { id: 'light_branch', label: 'Lights', value: null },
    { id: 'kitchen_light', label: 'Kitchen_Light', value: null },
    { id: 'unmetered_panel', label: 'Garage Panel', value: null },
    { id: 'metered_circuit', label: 'Garage Circuit', value: 60 },
  ],
  links: [
    { source: 'pdu', target: 'live_outlet', value: 240 },
    { source: 'pdu', target: 'hall_light', value: 0, known: false },
    { source: 'pdu', target: 'light_branch', value: 0, known: false },
    { source: 'light_branch', target: 'kitchen_light', value: 0, known: false },
    { source: 'pdu', target: 'unmetered_panel', value: 60 },
    { source: 'unmetered_panel', target: 'metered_circuit', value: 60 },
  ],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] } } :
    url.includes('/api/flow/live') ? { ok: true, values: [] } :
    url.includes('/api/flow/withheld') ? { ok: true, sources: [] } :
    url.includes('/api/flow') ? graph :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow')?.click();
await new Promise(r => setTimeout(r, 200));
const sec = () => query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const drawn = () => query(sec(), 'text', true).map(t => t.textContent || '').join(' | ');
const counted = () => (query(sec(), 'span', true).find(s => /node\(s\)/.test(s.textContent || '')) || {}).textContent || '';
const switchBox = () => {
  const box = query(sec(), 'label', true).find(l => /Hide no data/.test(l.textContent || ''));
  if (!box) fail('no "Hide no data" switch on the diagram');
  return query(box, 'input', true)[0];
};

// Off out of the box: a node nothing measures is a gap worth seeing until someone chooses otherwise.
if (switchBox().checked) fail('the switch is on by default');
if (!/Hallway_Light/.test(drawn())) fail(`a node with no data is hidden before anyone asked: ${drawn()}`);

// On: the no-data light, and a branch of no-data lights, go.
const cb = switchBox();
cb.checked = true;
cb.onchange({});
await new Promise(r => setTimeout(r, 200));
let labels = drawn();
for (const gone of ['Hallway_Light', 'Kitchen_Light', 'Lights'])
  if (new RegExp(gone).test(labels)) fail(`${gone} has no data and nothing under it does, but it was drawn: ${labels}`);
// A no-data panel above a metered circuit stays, or the circuit would be cut off from its feeder.
if (!/Garage Panel/.test(labels) || !/Garage Circuit/.test(labels))
  fail(`a no-data node feeding a measured one was hidden, cutting the measured node off: ${labels}`);
if (!/Dell r730XD/.test(labels)) fail(`a measured node was hidden: ${labels}`);
// The count still says what is not on screen.
if (!/3 with no data hidden/.test(counted())) fail(`the count does not say how many no-data nodes are hidden: "${counted()}"`);

// Off again brings them back.
switchBox().checked = false;
switchBox().onchange({});
await new Promise(r => setTimeout(r, 200));
if (!/Hallway_Light/.test(drawn())) fail(`turning the switch off did not bring the no-data nodes back: ${drawn()}`);

console.log('hide-no-data: off by default; on, a no-data node and a no-data branch go while a no-data node feeding a '
  + 'measured one stays, and the count says how many were hidden; off brings them back');
process.exit(0);

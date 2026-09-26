// "Hide small" on the Flow diagram (#497): loads carrying next to nothing are hidden below a chosen share of
// what enters the diagram. What it must NOT hide is a node with no data, or a small node that feeds a large
// one — that would cut the large one off from its supply.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('hide-small check FAILED: ' + m); process.exit(1); };

// 1000 W enters at the grid. The fridge is 150 W; the phone charger 3 W (0.3%) and the clock 8 W (0.8%).
// The doorbell transformer reads 4 W but feeds a 400 W heater nothing else meters. The shed nothing measures.
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'grid', label: 'Grid', value: 1000 },
    { id: 'panel', label: 'Main Panel', value: 1000 },
    { id: 'fridge', label: 'Fridge', value: 150 },
    { id: 'charger', label: 'Phone charger', value: 3 },
    { id: 'clock', label: 'Clock', value: 8 },
    { id: 'transformer', label: 'Doorbell transformer', value: 4 },
    { id: 'heater', label: 'Heater', value: 400 },
    { id: 'shed', label: 'Shed', value: null },
  ],
  links: [
    { source: 'grid', target: 'panel', value: 1000 },
    { source: 'panel', target: 'fridge', value: 150 },
    { source: 'panel', target: 'charger', value: 3 },
    { source: 'panel', target: 'clock', value: 8 },
    { source: 'panel', target: 'transformer', value: 4 },
    { source: 'transformer', target: 'heater', value: 400 },
    { source: 'panel', target: 'shed', value: 0 },
  ],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] } } :
    url.includes('/api/flow') ? graph :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
await new Promise(r => setTimeout(r, 200));
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const drawn = () => query(sec, 'text', true).map(t => t.textContent || '').join(' | ');
const picker = () => query(sec, 'label', true).find(l => /Hide small/.test(l.textContent || ''));

// Off out of the box: everything is drawn.
if (!picker()) fail('no Hide small picker beside the other view switches');
const sel = () => query(picker(), 'select', true)[0];
if (sel().value !== '0') fail(`Hide small is on by default (${sel().value})`);
for (const want of ['Phone charger', 'Clock'])
  if (!drawn().includes(want)) fail(`${want} is hidden with Hide small off`);

// Under 1%: the charger (0.3%) and clock (0.8%) go; the fridge stays.
sel().value = '1';
sel().onchange({});
await new Promise(r => setTimeout(r, 200));
const text = drawn();
for (const gone of ['Phone charger', 'Clock'])
  if (text.includes(gone)) fail(`${gone} is still drawn under 1%: ${text}`);
if (!text.includes('Fridge')) fail('the fridge (15%) was hidden');
// A small node above a large one is its supply path, and stays.
if (!text.includes('Doorbell transformer') || !text.includes('Heater')) fail(`a small node feeding a large one was cut: ${text}`);
// No data is not a small reading.
if (!text.includes('Shed')) fail('a node with no data was hidden as small');

// Said beside the node count, so nothing disappears silently.
const counts = query(sec, 'span', true).map(s => s.textContent || '').join(' ');
if (!/2 small hidden/.test(counts)) fail(`how many were hidden is not said: ${counts}`);

// And it is remembered for this viewer.
if (sandbox.localStorage.getItem('rpdu-flow-hide-small') !== '1') fail('the choice is not remembered');

console.log('hide-small: off by default; under 1% hides the loads using next to nothing, keeps a small node feeding a large one and a node with no data, and says how many went');

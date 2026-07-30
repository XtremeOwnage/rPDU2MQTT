// Hierarchy-layout regression check: build the real bundle in the smoke DOM against a topology shaped
// like a solar install (MPPTs -> Solar -> inverter, with Battery and Grid also feeding the inverter), open
// the Flow tab, and read back each node's rendered x to recover its column.
//
// The bug this pins (ToDo.md, image-1.png): Battery and Grid feed the inverter, but longest-path-from-root
// layering left-justified them into column 0 beside the MPPTs — so their links trailed across two columns
// instead of starting next to what they power. A feeder must sit exactly one column left of the earliest
// thing it feeds.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');

const config = {
  EnergyFlow: {
    Nodes: [
      { Id: 'MPPT_1', Label: 'MPPT_1', Kind: 'solar' },
      { Id: 'MPPT_2', Label: 'MPPT_2', Kind: 'solar' },
      { Id: 'MPPT_3', Label: 'MPPT_3', Kind: 'solar' },
      { Id: 'solar', Label: 'Solar (PV)', Kind: 'solar' },
      { Id: 'battery', Label: 'Battery', Kind: 'battery' },
      { Id: 'grid', Label: 'Grid', Kind: 'grid' },
      { Id: 'inverter', Label: 'EG4 FlexBoss 21' },
      { Id: 'main_panel', Label: 'Main Panel' },
    ],
    Links: [
      { From: 'MPPT_1', To: 'solar' }, { From: 'MPPT_2', To: 'solar' }, { From: 'MPPT_3', To: 'solar' },
      { From: 'solar', To: 'inverter' },
      { From: 'battery', To: 'inverter' },
      { From: 'grid', To: 'inverter' },
      { From: 'inverter', To: 'main_panel' },
    ],
  },
};

const { sandbox, getEl, query } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? config :
    url.includes('/api/flow') ? { ok: true, nodes: [], links: [], metric: 'realpower', units: 'W' } :
    { ok: true },
});

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

const nav = getEl('nav');
const flowLink = query(nav, 'a', true).find(a => a.dataset.label === 'Flow');
if (!flowLink) { console.error('layout check FAILED: no Flow tab'); process.exit(1); }
flowLink.click();
await new Promise(r => setTimeout(r, 50));

// Every hierarchy node is a <g dataset.id> translated to its column's x.
const placed = new Map();
for (const g of query(getEl('sections'), 'g', true)) {
  const id = g.dataset?.id, tf = g.attrs?.transform;
  if (!id || !tf) continue;
  const m = /translate\(([-\d.]+),/.exec(tf);
  if (m) placed.set(id, Number(m[1]));
}

const xs = [...new Set([...placed.values()])].sort((a, b) => a - b);
const columnOf = (id) => xs.indexOf(placed.get(id));

const fail = (m) => { console.error('layout check FAILED: ' + m); process.exit(1); };
for (const id of ['MPPT_1', 'solar', 'battery', 'grid', 'inverter', 'main_panel'])
  if (!placed.has(id)) fail(`node "${id}" was never rendered`);

// A feeder sits exactly one column left of the earliest node it feeds.
const expect = (id, want, why) => {
  const got = columnOf(id);
  if (got !== want) fail(`${id} is in column ${got}, expected ${want} — ${why}`);
};
expect('MPPT_1', 0, 'the MPPTs feed Solar, which is in column 1');
expect('solar', 1, 'Solar feeds the inverter in column 2');
expect('battery', 1, 'Battery feeds the inverter, so it belongs beside Solar — not left-justified with the MPPTs');
expect('grid', 1, 'Grid feeds the inverter, so it belongs beside Solar');
expect('inverter', 2, 'the inverter feeds the main panel');
expect('main_panel', 3, 'the main panel is the sink here');

console.log('layout: columns ' + ['MPPT_1', 'solar', 'battery', 'grid', 'inverter', 'main_panel']
  .map(id => `${id}=${columnOf(id)}`).join(' '));

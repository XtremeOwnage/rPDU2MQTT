// What may feed a node. A load is where power is used, so neither the node editor's Fed by picker nor the
// Nodes table's offers one; a circuit that feeds other nodes is a Breaker, which is offered.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('feeders check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const config = {
  History: { Enabled: false },
  EnergyFlow: {
    Nodes: [
      { Id: 'rack_pdu', Label: 'Rack PDU', Kind: 'node' },
      { Id: 'main_panel', Label: 'Main Panel', Kind: 'panel' },
      { Id: 'b06', Label: 'B06 Livingroom', Kind: 'breaker' },
      { Id: 'fridge', Label: 'Fridge', Kind: 'load' },
    ],
    Links: [],
  },
};
const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/config') ? config
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/flow') ? { ok: true, nodes: [], links: [] }
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(60);
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes')?.click();
await wait(250);
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('the Nodes page did not open');

const valuesOf = (sel) => (sel.children || []).map(o => o.value || (o.attrs && o.attrs.value)).filter(Boolean);

// The Nodes table: each row's own Fed by dropdown.
const row = query(sec, 'tr', true).find(r => query(r, 'td', true).some(td => td.textContent === 'rack_pdu'));
if (!row) fail('no table row for rack_pdu');
const tableSel = query(row, 'select', true).find(s => (s.children || []).some(o => o.textContent === '— none —'));
if (!tableSel) fail('the table row has no Fed by dropdown');
if (valuesOf(tableSel).includes('fridge')) fail(`the table offers a load as a feeder: ${valuesOf(tableSel).join(', ')}`);
for (const ok of ['main_panel', 'b06'])
  if (!valuesOf(tableSel).includes(ok)) fail(`the table does not offer ${ok} as a feeder: ${valuesOf(tableSel).join(', ')}`);

// The node editor.
query(row, 'button', true).find(b => b.textContent === 'Edit')?.click();
await wait(250);
const body = sandbox.document.body;
const pickerFor = (title) => {
  const r = query(body, 'div', true).find(d => (d.children || []).some(c => c.tag === 'span' && c.textContent === title)
    && query(d, 'select', true).length);
  if (!r) fail(`the editor has no ${title} row`);
  return query(r, 'select', true)[0];
};
const fedBy = valuesOf(pickerFor('Fed by'));
if (fedBy.includes('fridge')) fail(`Fed by offers a load: ${fedBy.join(', ')}`);
for (const ok of ['main_panel', 'b06'])
  if (!fedBy.includes(ok)) fail(`Fed by does not offer ${ok}: ${fedBy.join(', ')}`);
// A load is still something a node can feed.
const feeds = valuesOf(pickerFor('Feeds'));
if (!feeds.includes('fridge')) fail(`Feeds no longer offers a load: ${feeds.join(', ')}`);

// A panel is fed from one place: a second feeder is refused rather than quietly wired. (A toast cannot be
// read here — the stub's timers fire at once, so it is gone before the check looks — the wiring is the proof.)
const wire = pickerFor('Feeds');
config.EnergyFlow.Links.push({ From: 'b06', To: 'main_panel' });
wire.value = 'main_panel';
wire.onchange();
await wait(80);
const toMain = config.EnergyFlow.Links.filter(l => l.To === 'main_panel');
if (toMain.length !== 1) fail(`a panel was wired a second feeder: ${toMain.map(l => l.From).join(', ')}`);
// …and a node that is not a panel still takes more than one: the refusal is about panels, not about wiring.
config.EnergyFlow.Links.push({ From: 'main_panel', To: 'fridge' });
wire.value = 'fridge';
wire.onchange();
await wait(80);
if (!config.EnergyFlow.Links.some(l => l.From === 'rack_pdu' && l.To === 'fridge'))
  fail('a second feeder into an ordinary node was refused as well');

// Breaker is a kind a node can be.
const kindSel = query(body, 'select', true).find(s => valuesOf(s).includes('panel') && valuesOf(s).includes('load'));
if (!kindSel || !valuesOf(kindSel).includes('breaker')) fail(`Breaker is not offered as a kind: ${kindSel ? valuesOf(kindSel).join(', ') : 'no kind picker'}`);

console.log('feeders: neither the node editor nor the Nodes table offers a load as a feeder, a breaker and a panel are offered, '
  + 'a load can still be fed, a panel is refused a second feeder while an ordinary node takes one, and Breaker is a kind');
process.exit(0);

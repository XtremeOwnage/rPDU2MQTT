// The Balance page: which nodes are the site's Solar, Grid, Battery and Home totals. What a node is (its
// Kind) and what it counts toward are separate, so an inverter's load reading can be Home and the MPPT
// strings beneath a PV total can be left out of Solar.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('balance check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const config = {
  EnergyFlow: {
    Nodes: [
      { Id: 'inverter', Label: 'Inverter', Kind: 'inverter' },
      { Id: 'pv', Label: 'Solar (PV)', Kind: 'solar' },
      { Id: 'mppt_1', Label: 'MPPT 1', Kind: 'solar' },
      { Id: 'battery', Label: 'Battery', Kind: 'battery' },
      { Id: 'grid', Label: 'Grid', Kind: 'grid' },
    ],
    Links: [], Groups: [{ Id: 'pv', Members: ['mppt_1'] }],
  },
};
// With no Balance configured the server counts by kind, once: the PV total, not its string.
const graph = {
  ok: true, metric: 'realpower', units: 'W', links: [],
  nodes: [
    { id: 'inverter', label: 'Inverter', kind: 'inverter', value: 3000 },
    { id: 'pv', label: 'Solar (PV)', kind: 'solar', balance: 'solar', value: 4000 },
    { id: 'mppt_1', label: 'MPPT 1', kind: 'solar', within: 'pv', value: 4000 },
    { id: 'battery', label: 'Battery', kind: 'battery', balance: 'battery', value: 200 },
    { id: 'grid', label: 'Grid', kind: 'grid', balance: 'grid', value: 100 },
  ],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? config
    : url.includes('/api/flow') ? graph
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(150);

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Balance');
if (!link) fail('no Balance page in the nav');
link.click();
await wait(150);
const sec = () => query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const role = (r) => query(sec(), '.balance-role', true).find(c => c.dataset.role === r);
const chipsOf = (r) => query(role(r), '.balance-chip', true).map(c => c.dataset.node);

for (const r of ['solar', 'grid', 'battery', 'home'])
  if (!role(r)) fail(`no ${r} total on the page`);

// Nothing configured: the page says what the kind rule comes to, and offers it as a starting point.
const text = sec().textContent;
if (!/Solar: Solar \(PV\)/.test(text)) fail(`the page does not say what counts as solar by kind: ${text}`);
if (/Solar: [^.]*MPPT 1/.test(text)) fail('the page says a string held by its PV total counts as solar');
const adopt = query(sec(), 'button', true).find(b => /Start from these/.test(b.textContent));
if (!adopt) fail('no way to start from what counts now');
adopt.onclick();
await wait(20);
const b = config.EnergyFlow.Balance;
if (JSON.stringify(b.Solar) !== '["pv"]' || JSON.stringify(b.Grid) !== '["grid"]' || JSON.stringify(b.Battery) !== '["battery"]')
  fail(`starting from the kind rule wrote ${JSON.stringify(b)}`);
if (b.Home.length) fail(`nothing counted as home, yet Home became ${JSON.stringify(b.Home)}`);

// End loads are not offered: an appliance is never a site total, and there are dozens of them.
const offered = () => (query(role('home'), 'select', true)[0].children || []).map(o => o.value || o.attrs?.value);
graph.nodes.push({ id: 'fridge', label: 'Fridge', kind: 'load', value: 150 }, { id: 'outlet:rack:1', label: 'Outlet 1', kind: 'outlet', value: 20 });
link.click();
await wait(150);
if (offered().includes('fridge') || offered().includes('outlet:rack:1')) fail(`end loads are offered as a site total: ${offered().join(', ')}`);
if (!offered().includes('inverter')) fail('the inverter is no longer offered');
// …unless asked for.
const every = query(sec(), 'label', true).find(l => /Offer loads/.test(l.textContent || ''));
if (!every) fail('no way to offer loads for the setup where one is a total');
const everyBox = query(every, 'input', true)[0];
everyBox.checked = true;
everyBox.onchange();
await wait(20);
if (!offered().includes('fridge')) fail('asking for loads did not offer them');
everyBox.checked = false;
everyBox.onchange();

// The inverter's reading is the house load: add it to Home.
const pick = query(role('home'), 'select', true)[0];
pick.value = 'inverter';
pick.onchange();
await wait(20);
if (JSON.stringify(config.EnergyFlow.Balance.Home) !== '["inverter"]') fail(`adding to Home wrote ${JSON.stringify(config.EnergyFlow.Balance)}`);
if (!chipsOf('home').includes('inverter')) fail('the inverter is not shown under Home');
if (!/3,000 W now/.test(role('home').textContent)) fail(`Home does not show what it reads now: ${role('home').textContent}`);

// A node counts toward one total at most: adding the PV total to Home moves it out of Solar.
const pick2 = query(role('home'), 'select', true)[0];
const opt = (pick2.children || []).find(o => (o.value || o.attrs?.value) === 'pv');
if (!opt || !/moves from solar/.test(opt.textContent)) fail('a node listed elsewhere is not marked as moving');
pick2.value = 'pv';
pick2.onchange();
await wait(20);
if (config.EnergyFlow.Balance.Solar.includes('pv')) fail('a node was left under two totals');

// Removing it again.
const pvChip = query(role('home'), '.balance-chip', true).find(c => c.dataset.node === 'pv');
query(pvChip, 'button', true)[0].onclick();
await wait(20);
if (config.EnergyFlow.Balance.Home.includes('pv')) fail('removing a node from a total did not');

// An entry naming no node is called out, not silently short.
config.EnergyFlow.Balance.Grid.push('old_meter');
link.click();
await wait(150);
const missing = query(role('grid'), '.balance-chip', true).find(c => c.dataset.node === 'old_meter');
if (!missing || !missing.classList.contains('is-missing')) fail('an entry naming no node is not marked');

// The node editor's "Counts toward" is the same setting, not a second copy of it.
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes').click();
await wait(200);
const rowFor = (id) => query(sec(), 'tr', true).find(r => query(r, 'td', true)[0]?.textContent?.startsWith(id) && query(r, 'button', true).some(bn => bn.textContent === 'Edit'));
query(rowFor('battery'), 'button', true).find(bn => bn.textContent === 'Edit').click();
await wait(200);
const field = query(sandbox.document.body, 'div', true).find(d => query(d, 'label', true)[0]?.textContent === 'Counts toward');
if (!field) fail('the node editor has no Counts toward field');
const sel = query(field, 'select', true)[0];
if (sel.value !== 'battery') fail(`the editor shows the battery counting toward "${sel.value}"`);
sel.value = 'home';
sel.onchange();
if (config.EnergyFlow.Balance.Battery.includes('battery') || !config.EnergyFlow.Balance.Home.includes('battery'))
  fail(`changing Counts toward did not move the node: ${JSON.stringify(config.EnergyFlow.Balance)}`);

console.log('balance: the page shows what counts by kind and starts from it; a node is added to a total, moves rather than counting twice, and is removed; an entry naming no node is marked; the node editor edits the same list; end loads are only offered when asked for');

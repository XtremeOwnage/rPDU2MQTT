// A right-click on the flow diagram: what the node has been drawing, where its supply comes from, and the
// node itself. A node the bridge derives has no editor, so that entry is offered but disabled rather than
// leading nowhere. The history is one line summed from the node asked for, with a gap where it has no reading.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('flow menu check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'main_panel', label: 'Main Panel', kind: 'panel', value: 900 },
    { id: 'n30_1_5', label: 'Kitchen lights', kind: 'breaker', value: 240 },
    // Derived by the bridge from what it polls: there is no config node to edit.
    { id: 'outlet:rack_pdu:1', label: 'Dell r730XD', kind: 'outlet', value: 240 },
  ],
  links: [
    { source: 'main_panel', target: 'n30_1_5', value: 240 },
    { source: 'main_panel', target: 'outlet:rack_pdu:1', value: 240 },
  ],
};
// What the history backend holds for the node, with one moment it has no reading for.
const SAMPLES = 9, GAP_AT = 4;
const asked = [];
const series = (url) => {
  asked.push(url);
  return {
    ok: true, metric: 'realpower', units: 'W',
    at: Array.from({ length: SAMPLES }, (_, i) => new Date(Date.UTC(2026, 8, 22, 4 + i)).toISOString()),
    series: [
      { node: 'main_panel', label: 'Main Panel', kind: 'panel',
        values: Array.from({ length: SAMPLES }, (_, i) => (i === GAP_AT ? null : 480 + i * 10)) },
      { node: 'n30_1_5', label: 'Kitchen lights', kind: 'breaker',
        values: Array.from({ length: SAMPLES }, (_, i) => (i === GAP_AT ? null : 100 + i * 10)) },
      // The busier of the two children, so the order of the breakdown says something.
      { node: 'outlet:rack_pdu:1', label: 'Dell r730XD', kind: 'outlet',
        values: Array.from({ length: SAMPLES }, () => 300) },
    ],
  };
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/flow/series') ? series(url) :
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? { EnergyFlow: { Nodes: [{ Id: 'main_panel', Label: 'Main Panel', Kind: 'panel' }, { Id: 'n30_1_5', Label: 'Kitchen lights', Kind: 'breaker' }], Links: [] } } :
    url.includes('/api/flow/live') ? { ok: true, values: [] } :
    url.includes('/api/flow/withheld') ? { ok: true, sources: [] } :
    url.includes('/api/flow') ? graph :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(60);

query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow')?.click();
await wait(200);
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('the Flow page did not open');

const barFor = (id) => query(sec, 'rect', true).find(r => (r.attrs || {})['data-node'] === id);
const menu = () => query(sec, '.ctx-menu');
const items = () => query(menu() || {}, '.ctx-menu-item', true);
const itemSaying = (t) => items().find(b => (b.textContent || '') === t);
const rightClick = (id) => {
  const bar = barFor(id);
  if (!bar) fail(`no node drawn for ${id}`);
  if (!bar._on?.contextmenu) fail(`${id} does not answer a right-click`);
  bar._on.contextmenu[0]({ clientX: 120, clientY: 80, preventDefault() { }, stopPropagation() { } });
};

// Nothing is open until it is asked for.
if (menu() && !menu().hidden) fail('the menu is open before anything was right-clicked');
rightClick('n30_1_5');
if (!menu() || menu().hidden) fail('a right-click on a node opened no menu');
if (!query(menu(), '.ctx-menu-head') || !/Kitchen lights/.test(query(menu(), '.ctx-menu-head').textContent || ''))
  fail('the menu does not say which node it is for');
for (const entry of ['History…', 'Trace its supply', 'Edit this node'])
  if (!itemSaying(entry)) fail(`the menu does not offer "${entry}": ${items().map(b => b.textContent).join(', ')}`);
if (itemSaying('Edit this node').disabled) fail('a node of the config cannot be edited from the diagram');

// A redraw does not take the menu out from under the pointer: it is the page's, not the drawing's.
query(sec, 'button', true).find(b => b.textContent === 'Refresh').onclick();
await wait(200);
if (!menu() || menu().hidden) fail('a redraw closed the menu that was open over it');
if (!itemSaying('History…')) fail('the menu survived a redraw with nothing in it');
if (!query(sec, '.flow-stage')?.children?.some?.(c => c === menu()))
  fail('the menu was left behind by the redraw rather than moved into the new diagram');

// A node the bridge derives has no config entry, so its editor entry is dead rather than misleading.
rightClick('outlet:rack_pdu:1');
if (!itemSaying('Edit this node')?.disabled) fail('a derived node offers an editor it does not have');

// The history: one line for the node, over a window picked in the sheet.
rightClick('n30_1_5');
itemSaying('History…').onclick();
await wait(120);
const sheet = () => query(getEl('overlay'), '.sheet');
// Clicking the backdrop is how a sheet is dismissed.
const shut = () => { const o = getEl('overlay'); o.onclick({ target: o }); };
if (!sheet()) fail('History opened no sheet');
if (menu() && !menu().hidden) fail('the menu stayed open behind the sheet');
if (!/Kitchen lights/.test(sheet().textContent || '')) fail('the history sheet does not name the node');
if (!query(sheet(), 'svg')) fail('the history sheet drew no chart');
if (!asked.some(u => /minutes=1440&step=900/.test(u))) fail(`the day window was not asked for: ${asked.join(' | ')}`);
if (!asked.every(u => /metric=realpower/.test(u))) fail(`the history was asked for in the wrong measurement: ${asked.join(' | ')}`);
// 8 of the 9 samples have a reading, and the moment without one is not counted or filled in.
const note = query(sheet(), '.desc', true).map(d => d.textContent || '').join(' ');
if (!/8 of 9 readings/.test(note)) fail(`the sheet does not say how much of the window is known: "${note}"`);
if (!/peak 180 W/.test(note)) fail(`the peak is not the highest reading: "${note}"`);
// Another window is one press away.
query(sheet(), 'button', true).find(b => b.textContent === 'Last 7 days').onclick();
await wait(120);
if (!asked.some(u => /days=7&step=3600/.test(u))) fail(`picking a longer window asked for nothing: ${asked.join(' | ')}`);

// A right-click on bare canvas is about the diagram, not a node. Nothing is traced yet, so there is nothing
// to clear and that entry is dead rather than a no-op.
shut();
const canvas = query(sec, '.sankey-svg');
if (!canvas?._on?.contextmenu) fail('the diagram itself does not answer a right-click');
canvas._on.contextmenu[0]({ clientX: 40, clientY: 40, preventDefault() { } });
for (const entry of ['Clear the trace', 'Fit it to the page', 'Read it again now'])
  if (!itemSaying(entry)) fail(`the canvas menu does not offer "${entry}": ${items().map(b => b.textContent).join(', ')}`);
if (!itemSaying('Clear the trace').disabled) fail('the trace can be cleared when nothing is traced');
// Tracing a node's supply gives it something to clear.
barFor('n30_1_5')._on.click[0]({ stopPropagation() { } });
canvas._on.contextmenu[0]({ clientX: 40, clientY: 40, preventDefault() { } });
if (itemSaying('Clear the trace').disabled) fail('a traced diagram cannot be untraced from the menu');
itemSaying('Clear the trace').onclick();
await wait(60);

// A click anywhere else closes the menu: it must not be left hanging over the page.
rightClick('n30_1_5');
sandbox.document._on?.mousedown?.forEach(fn => fn({ target: getEl('sections') }));
if (!menu().hidden) fail('a click away from the menu left it open');
// …but a click inside it is not a click away from it.
rightClick('n30_1_5');
sandbox.document._on?.mousedown?.forEach(fn => fn({ target: itemSaying('History…') }));
if (menu().hidden) fail('clicking an entry of the menu closed it before the entry ran');
menu().hidden = true;

// A tier's sheet breaks the total down into what it feeds, each on a strip of its own, busiest first.
shut();
rightClick('main_panel');
itemSaying('History…').onclick();
await wait(120);
const parts = () => query(sheet(), '.hs-part', true);
if (parts().length !== 2) fail(`the breakdown shows ${parts().length} of the 2 nodes the panel feeds`);
if (parts()[0].dataset.node !== 'outlet:rack_pdu:1')
  fail(`the breakdown is not ordered by what each drew: ${parts().map(p => p.dataset.node).join(', ')}`);
if (!/300 W/.test(parts()[0].textContent || '')) fail(`a part does not say what it is drawing: "${parts()[0].textContent}"`);
if (!query(parts()[0], 'svg')) fail('a part was listed without its own strip');
// The same reading in another measurement is one pick away, and it asks again for that one.
const metricSel = query(sheet(), '.hs-metric');
if (!metricSel) fail('the history cannot be asked for in another measurement');
metricSel.value = 'current';
metricSel.onchange();
await wait(120);
if (!asked.some(u => /metric=current/.test(u))) fail(`picking amps asked for nothing: ${asked.join(' | ')}`);
// The window picked last time is the one the next sheet opens on.
query(sheet(), 'button', true).find(b => b.textContent === 'Last hour').onclick();
await wait(120);
shut();
asked.length = 0;
rightClick('n30_1_5');
itemSaying('History…').onclick();
await wait(120);
if (!asked.every(u => /minutes=60&step=30/.test(u))) fail(`the window picked last time was not kept: ${asked.join(' | ')}`);
const marked = query(sheet(), 'button', true).filter(b => b.classList.contains('primary')).map(b => b.textContent);
if (marked.join() !== 'Last hour') fail(`the sheet does not show which window it is on: ${marked.join(', ')}`);
shut();

// Escape closes the menu, as it closes everything else.
rightClick('n30_1_5');
sandbox.document._on?.keydown?.forEach(fn => fn({ key: 'Escape' }));
if (!menu().hidden) fail('Escape left the menu open');

// The menu is drawn over the diagram, inside the box it was aimed at.
if (!/\.ctx-menu\s*\{[^}]*position:\s*absolute/.test(await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8')))
  fail('the menu is not positioned over the diagram');

console.log('flow menu: a right-click on a node of the diagram offers its history, a trace of its supply and its editor — '
  + 'disabled for a node the bridge derives — and the history draws one line over a window picked in the sheet, a gap '
  + 'where the node has no reading, what the tier feeds broken out beneath it busiest first, the measurement pickable '
  + 'there, and the window kept for the next one; bare canvas offers the diagram itself, with nothing to clear '
  + 'until something is traced; and Escape, or a click away from it, closes the menu');
process.exit(0);

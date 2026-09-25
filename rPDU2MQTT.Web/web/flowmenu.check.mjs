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
    { id: 'grid', label: 'Grid', kind: 'grid', value: 900 },
    { id: 'main_panel', label: 'Main Panel', kind: 'panel', value: 900 },
    { id: 'shed_panel', label: 'Shed Panel', kind: 'panel', value: 120 },
    { id: 'shed_light', label: 'Shed light', kind: 'load', value: 120 },
    { id: 'n30_1_5', label: 'Kitchen lights', kind: 'breaker', value: 240 },
    // Derived by the bridge from what it polls: there is no config node to edit.
    { id: 'outlet:rack_pdu:1', label: 'Dell r730XD', kind: 'outlet', value: 240 },
  ],
  links: [
    { source: 'grid', target: 'main_panel', value: 900 },
    { source: 'grid', target: 'shed_panel', value: 120 },
    { source: 'main_panel', target: 'n30_1_5', value: 240 },
    { source: 'main_panel', target: 'outlet:rack_pdu:1', value: 240 },
    { source: 'shed_panel', target: 'shed_light', value: 120 },
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

// The zoom and the place on the page belong to the reader: a redraw does not put them back to the fitted
// view (#492). The diagram is drawn at width = its own width x the zoom, so the attribute says where it is.
const stageSvg = () => query(sec, '.sankey-svg');
const drawnWidth = () => Number(stageSvg().attrs.width);
const fitted = drawnWidth();
query(sec, 'button', true).find(b => b.textContent === '+').onclick();
const zoomed = drawnWidth();
if (!(zoomed > fitted)) fail(`zooming in did not enlarge the diagram: ${fitted} then ${zoomed}`);
query(sec, 'button', true).find(b => b.textContent === 'Refresh').onclick();
await wait(200);
if (drawnWidth() !== zoomed) fail(`a redraw threw the reader's zoom away: ${zoomed} became ${drawnWidth()}`);
// …and Fit is still the way back to the whole diagram.
query(sec, 'button', true).find(b => b.textContent === '⤢').onclick();
if (drawnWidth() === zoomed && zoomed !== fitted) fail('Fit no longer fits the diagram to the page');

// Drilling into a node draws it and what is beneath it, and nothing else — not a highlight (#493).
const drawnNodes = () => query(sec, 'rect', true).map(r => (r.attrs || {})['data-node']).filter(Boolean);
const drillSel = () => query(sec, '.flow-drill');
const canvasDbl = () => {
  const on = query(sec, '.sankey-svg')?._on?.dblclick;
  if (!on) fail('the diagram itself does not answer a double-click');
  on[0]({ preventDefault() { }, stopPropagation() { } });
};
if (!drillSel()) fail('there is no way to pick what part of the diagram is drawn');
// What is offered carries something: panels and the PDU, never an end load or an outlet.
const offered = (drillSel().children || []).map(o => o.value);
for (const want of ['main_panel', 'shed_panel'])
  if (!offered.includes(want)) fail(`${want} is not offered to drill into: ${offered.join(', ')}`);
for (const never of ['shed_light', 'n30_1_5', 'outlet:rack_pdu:1'])
  if (offered.includes(never)) fail(`${never} has nothing beneath it and is offered anyway: ${offered.join(', ')}`);
if (!drawnNodes().includes('shed_panel')) fail('the whole diagram is not drawn to start with');

drillSel().value = 'main_panel';
drillSel().onchange();
await wait(200);
const after = drawnNodes();
if (!after.includes('main_panel') || !after.includes('n30_1_5')) fail(`drilling in dropped the node or its children: ${after.join(', ')}`);
if (after.includes('shed_panel') || after.includes('grid')) fail(`drilling in still draws the rest: ${after.join(', ')}`);
// Double-click is the same journey without the menu: into a node, then back out of it.
drillSel().value = '';
drillSel().onchange();
await wait(150);
const dblclick = (id) => {
  const bar = barFor(id);
  if (!bar?._on?.dblclick) fail(`${id} is not drawn, or does not answer a double-click`);
  bar._on.dblclick[0]({ preventDefault() { }, stopPropagation() { } });
};
dblclick('main_panel');
await wait(200);
if (drawnNodes().includes('shed_panel')) fail('double-clicking a node did not drill into it');
// Again on the node now drawn at the top: out one level, to what feeds it.
dblclick('main_panel');
await wait(200);
if (!drawnNodes().includes('shed_panel')) fail('double-clicking what is drilled into did not come back out');
// A node with nothing beneath it stays put rather than drawing itself alone.
dblclick('main_panel');
await wait(200);
dblclick('n30_1_5');
await wait(200);
if (!drawnNodes().includes('main_panel')) fail(`double-clicking a leaf drew it on its own: ${drawnNodes().join(', ') || 'nothing at all'}`);
// Bare canvas: out to the whole diagram.
canvasDbl();
await wait(200);
if (!drawnNodes().includes('shed_panel')) fail('double-clicking the canvas did not show the whole diagram');
drillSel().value = 'main_panel';
drillSel().onchange();
await wait(150);

// It holds across a redraw, as the zoom does.
query(sec, 'button', true).find(b => b.textContent === 'Refresh').onclick();
await wait(200);
if (drawnNodes().includes('shed_panel')) fail('a redraw undid the drill-down');
if (drillSel().value !== 'main_panel') fail('the picker forgot what it is showing');

// Out of it again, from the menu on a node.
rightClick('n30_1_5');
if (!itemSaying('Show the whole diagram')) fail(`no way back out of a drill-down: ${items().map(b => b.textContent).join(', ')}`);
if (!itemSaying('Drill into this').disabled) fail('a node with nothing beneath it can be drilled into');
itemSaying('Show the whole diagram').onclick();
await wait(200);
if (!drawnNodes().includes('shed_panel')) fail('showing the whole diagram left it drilled in');
// …and into it from the menu, which is how a phone reaches it.
rightClick('main_panel');
itemSaying('Drill into this').onclick();
await wait(200);
if (drawnNodes().includes('shed_panel')) fail('the menu did not drill in');
drillSel().value = '';
drillSel().onchange();
await wait(200);

// A reading that arrives while a control is in use waits: a redraw rebuilds the controls, which closes an
// open dropdown under the hand that opened it.
const got = [];
const deliver = sandbox.holdWhileBusy(sec, (d) => got.push(d));
deliver('first');
if (got.join() !== 'first') fail(`an update was held although nothing was in use: ${got.join()}`);
drillSel().focus();
if (!sandbox.busyInSection(sec)) fail('a focused control in the section is not noticed');
deliver('second');
if (got.join() !== 'first') fail(`an update landed while a control was in use: ${got.join()}`);
// Letting go of it draws whatever arrived meanwhile — the newest of it, not every one.
deliver('third');
drillSel().blur();
sec.dispatch('focusout', {});
await wait(30);
if (got.join() !== 'first,third') fail(`the held update was not drawn when the control was let go: ${got.join()}`);
// A control left focused does not freeze the page: past the hold, an update goes through.
const slow = [];
const impatient = sandbox.holdWhileBusy(sec, (d) => slow.push(d), 1);
drillSel().focus();
impatient('held');
await wait(20);
impatient('through');
if (!slow.includes('through')) fail(`a control left focused froze the page: ${slow.join()}`);
drillSel().blur();

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
for (const entry of ['Clear the trace', 'Fit to the page', 'Refresh'])
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
  + 'there, and the window kept for the next one; the reader\u2019s zoom survives a redraw; one node and what is '
  + 'beneath it can be drawn on its own, from the picker, the menu or a double-click \u2014 which comes back out '
  + 'again on a second one, and on the canvas \u2014 and holds across a redraw, with only what '
  + 'carries something offered; a reading arriving while a control is in use waits until it is let go, and a '
  + 'control left focused does not freeze the page; '
  + 'bare canvas offers the diagram itself, with nothing to clear '
  + 'until something is traced; and Escape, or a click away from it, closes the menu');
process.exit(0);

// The Flow page's third view: a treemap, every node a box whose area is its share, nested inside what feeds it.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('treemap check FAILED: ' + m); process.exit(1); };

const N = (id, kind, value) => ({ id, label: id, kind, value, derivation: 'measured' });
const L = (source, target, value) => ({ source, target, value });
// The main panel passes on 1000 of its 1200: 200 W it keeps must show as empty, not be spread over its children.
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [N('pv', 'solar', 1500), N('grid', 'grid', 500), N('inv', 'inverter', 2000), N('main', 'panel', 1200),
          N('sub', 'panel', 800), N('office', 'breaker', 600), N('rack', 'pdu', 400), N('ac', 'load', 500), N('mini', 'load', 300)],
  links: [L('pv', 'inv', 1500), L('grid', 'inv', 500), L('inv', 'main', 1200), L('inv', 'sub', 800),
          L('main', 'office', 600), L('main', 'rack', 400), L('sub', 'ac', 500), L('sub', 'mini', 300)],
};

const fn = (() => {
  const sb = { console, window: {}, localStorage: { getItem: () => null, setItem: () => {} } };
  vm.createContext(sb);
  try { vm.runInContext(code, sb, { filename: 'app.js' }); } catch { /* no DOM: the functions are defined */ }
  if (typeof sb.squarify !== 'function' || typeof sb.layoutTreemap !== 'function') fail('the treemap functions are not in the bundle');
  return sb;
})();
const eps = 1e-6;
const inside = (a, b) => a.x >= b.x - eps && a.y >= b.y - eps && a.x + a.w <= b.x + b.w + eps && a.y + a.h <= b.y + b.h + eps;
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > eps && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > eps;

// --- Squarify tiles its frame exactly, each box its own area, none overlapping --------------------------
{
  const frame = { x: 10, y: 20, w: 600, h: 400 };
  const areas = [100, 60, 40, 30, 20, 10, 5, 2].map(v => v * 600 * 400 / 267);
  const out = fn.squarify(areas.map((a, i) => ({ area: a, item: i })), frame);
  if (out.length !== areas.length) fail(`squarify placed ${out.length} of ${areas.length} boxes`);
  out.forEach(({ item, r }) => {
    if (Math.abs(r.w * r.h - areas[item]) > 1e-3) fail(`box ${item} has area ${r.w * r.h}, not ${areas[item]}`);
    if (!inside(r, frame)) fail(`box ${item} leaves the frame`);
  });
  out.forEach((a, i) => out.slice(i + 1).forEach(b => { if (overlap(a.r, b.r)) fail(`boxes ${a.item} and ${b.item} overlap`); }));
  // Squarified, not sliced: no box is a sliver when the values allow better.
  const worst = Math.max(...out.map(({ r }) => Math.max(r.w / r.h, r.h / r.w)));
  if (worst > 6) fail(`a box has an aspect ratio of ${worst.toFixed(1)}`);
}

// --- The layout: shares, nesting, and what a node keeps ------------------------------------------------
{
  const W = 1000, H = 600;
  const { cells, rests, hub, total } = fn.layoutTreemap(graph.nodes, graph.links, W, H);
  if (hub !== 'inv' || total !== 2000) fail(`the root is ${hub} with ${total}, not the inverter with 2000`);
  const cell = (id) => cells.find(c => c.t.id === id);
  const main = cell('main'), sub = cell('sub');
  if (!main || !sub) fail('the two panels are not drawn');
  const ratio = (main.r.w * main.r.h) / (sub.r.w * sub.r.h);
  if (Math.abs(ratio - 1.5) > 1e-6) fail(`main is ${ratio.toFixed(3)}× sub's area, not 1.5×`);
  ['office', 'rack'].forEach(id => { if (!inside(cell(id).r, main.r)) fail(`${id} is drawn outside the main panel`); });
  ['ac', 'mini'].forEach(id => { if (!inside(cell(id).r, sub.r)) fail(`${id} is drawn outside the sub panel`); });
  if (overlap(cell('office').r, cell('rack').r)) fail('siblings overlap');
  const kept = rests.find(r => inside(r.r, main.r));
  if (!kept || Math.abs(kept.value - 200) > eps) fail('the 200 W the main panel keeps is not left as its own region');
  const officeToKept = (cell('office').r.w * cell('office').r.h) / (kept.r.w * kept.r.h);
  if (Math.abs(officeToKept - 3) > 1e-6) fail(`office is ${officeToKept.toFixed(3)}× what main keeps, not 3×`);
}

// --- The page ------------------------------------------------------------------------------------------
const { sandbox, getEl, storage } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: false } }
    : url.includes('/api/flow/live') ? { ok: true, values: [] }
    : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
    : url.includes('/api/flow') ? graph
    : { ok: true },
});
storage.set('rpdu-flow-mode', 'treemap');
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
await new Promise(r => setTimeout(r, 250));
const sec = query(getEl('sections'), '.section', true).find(x => query(x, '.flow-gestures', true).length > 0);
if (!sec) fail('could not find the Flow section');
if (!query(sec, 'option', true).some(o => o.value === 'treemap')) fail('the header does not offer Treemap');
const boxes = query(sec, '.treemap-cell', true);
if (boxes.length < 6) fail(`the treemap drew ${boxes.length} boxes`);
if (!query(sec, '.treemap-root', false)) fail('there is no root bar to back out with');
if (!query(sec, '.treemap-rest', true).length) fail('what a node keeps is not drawn');
if (query(sec, '.flow-ribbon', true).length || query(sec, '.sunburst-arc', true).length) fail('another view was drawn as well');

const box = (id) => query(sec, '.treemap-cell', true).find(b => b.dataset.node === id);
box('office').dispatch('mouseenter', { clientX: 10, clientY: 10 });
const card = query(sandbox.document.body, '.node-card', false);
if (!card?.classList.contains('show') || !card.textContent.includes('of the total')) fail('hovering a box shows no details');
box('office').dispatch('mouseleave', {});

box('ac').dispatch('click', { stopPropagation() { } });
await new Promise(r => setTimeout(r, 100));
if (query(sec, '.flow-drill', false)?.value) fail('clicking a leaf drilled into it');
box('sub').dispatch('click', { stopPropagation() { } });
await new Promise(r => setTimeout(r, 100));
if (query(sec, '.flow-drill', false)?.value !== 'sub') fail('clicking the sub panel did not open it');
query(sec, '.treemap-root', false).click();
await new Promise(r => setTimeout(r, 100));
// One level out: to what feeds the sub panel.
if (query(sec, '.flow-drill', false)?.value !== 'inv') fail(`the root bar backed out to "${query(sec, '.flow-drill', false)?.value}", not the inverter`);

// Zoom: each chart sits in a pane; + enlarges it.
const maps = query(sec, '.treemap', true);
if (!maps.length || !maps.every(m => query(sec, '.tree-zoom', true).some(p => p.children.includes(m)))) fail('a treemap is not in a zoom pane');
const mw0 = parseFloat(maps[0].style.width);
query(query(sec, '.flow-zoom'), 'button', true).find(b => b.textContent === '+').onclick();
if (!(parseFloat(maps[0].style.width) > mw0)) fail(`zooming in does not enlarge the treemap: ${mw0} -> ${maps[0].style.width}`);
console.log('treemap check passed (squarified tiling, shares, nesting, what a node keeps, hover and opening a box).');

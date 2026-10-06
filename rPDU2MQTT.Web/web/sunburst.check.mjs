// The Flow page's second view: a sunburst, the hub the supply meets at in the middle and each ring outward
// one level of the hierarchy, each arc its share of what its parent passes on.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('sunburst check FAILED: ' + m); process.exit(1); };

const N = (id, kind, value) => ({ id, label: id, kind, value, derivation: 'measured' });
const L = (source, target, value) => ({ source, target, value });
// Solar and grid meet at an inverter, which feeds two panels; the rack is fed from both.
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [N('pv', 'solar', 1500), N('grid', 'grid', 500), N('inv', 'inverter', 2000), N('main', 'panel', 1200),
          N('sub', 'panel', 800), N('office', 'breaker', 400), N('rack', 'pdu', 600), N('ac', 'load', 500)],
  links: [L('pv', 'inv', 1500), L('grid', 'inv', 500), L('inv', 'main', 1200), L('inv', 'sub', 800),
          L('main', 'office', 400), L('main', 'rack', 300), L('sub', 'rack', 300), L('sub', 'ac', 500)],
};

// --- The layout -----------------------------------------------------------------------------------------
const fn = (() => {
  const sb = { console, window: {}, localStorage: { getItem: () => null, setItem: () => {} } };
  vm.createContext(sb);
  try { vm.runInContext(code, sb, { filename: 'app.js' }); } catch { /* no DOM: the functions are defined */ }
  if (typeof sb.findHub !== 'function' || typeof sb.layoutSunburst !== 'function') fail('the sunburst functions are not in the bundle');
  return sb;
})();

const { hub, supply } = fn.findHub(graph.nodes, graph.links);
if (hub !== 'inv') fail(`the hub is ${hub}, not the inverter the supply meets at`);
if ([...supply].sort().join() !== 'grid,pv') fail(`the supply ring is [${supply}], not [grid, pv]`);

const { arcs, total } = fn.layoutSunburst(graph.nodes, graph.links, hub, supply);
const TAU = 2 * Math.PI, eps = 1e-6;
if (total !== 2000) fail(`the total is ${total}, not the 2000 W the inverter passes on`);
const ring1 = arcs.filter(a => a.depth === 1);
if (ring1.map(a => a.id).join() !== 'main,sub') fail(`the first ring is [${ring1.map(a => a.id)}], largest first`);
const span1 = ring1.reduce((s, a) => s + a.a1 - a.a0, 0);
if (Math.abs(span1 - TAU) > eps) fail(`the first ring covers ${span1} rad, not the whole circle`);
const main = ring1[0];
if (Math.abs((main.a1 - main.a0) / TAU - 0.6) > eps) fail('the main panel is not 60% of the circle');
// Every arc sits inside the arc it came from, and the node fed from two panels appears under each.
arcs.filter(a => a.depth > 1).forEach(a => {
  const parent = arcs.find(p => p.depth === a.depth - 1 && p.a0 <= a.a0 + eps && a.a1 <= p.a1 + eps);
  if (!parent) fail(`${a.id} at depth ${a.depth} is outside every arc of the ring inside it`);
});
const racks = arcs.filter(a => a.id === 'rack');
if (racks.length !== 2 || racks.some(r => Math.abs(r.value - 300) > eps)) fail('the rack is not shown under both panels with 300 W each');
// A panel that passes on less than it takes leaves the rest of its arc empty (its own use), not stretched.
const office = arcs.find(a => a.id === 'office');
if (Math.abs((office.a1 - office.a0) - (main.a1 - main.a0) * 400 / 1200) > eps) fail('the office is not a third of the main panel');

// --- The page -------------------------------------------------------------------------------------------
const { sandbox, getEl, storage } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: false } }
    : url.includes('/api/flow/live') ? { ok: true, values: [] }
    : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
    : url.includes('/api/flow') ? graph
    : { ok: true },
});
storage.set('rpdu-flow-mode', 'sunburst');
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
await new Promise(r => setTimeout(r, 250));
const sec = query(getEl('sections'), '.section', true).find(x => query(x, '.flow-gestures', true).length > 0);
if (!sec) fail('could not find the Flow section');

const modes = query(sec, 'option', true).map(o => o.value);
if (!modes.includes('sankey') || !modes.includes('sunburst')) fail('the header does not offer Sankey and Sunburst');
const drawn = query(sec, '.sunburst-arc', true);
if (!drawn.length) fail('the sunburst mode drew no arcs');
if (query(sec, '.sunburst-supply', true).length !== 2) fail('the supply ring does not show solar and grid');
if (!query(sec, '.sunburst-hub', false)) fail('there is no hub');
if (query(sec, '.flow-ribbon', true).length) fail('the Sankey was drawn as well');

// Hovering an arc brings up its details: value, shares and the path down to it.
const { root } = { root: sandbox.document.body };
const rackArc = drawn.find(p => p.dataset.node === 'rack');
rackArc.dispatch('mouseenter', { clientX: 10, clientY: 10 });
const card = query(root, '.node-card', false);
if (!card || !card.classList.contains('show')) fail('hovering an arc shows no details');
for (const want of ['Share', 'of the total', 'inv', '300'])
  if (!card.textContent.includes(want)) fail(`the hover card does not show "${want}": ${card.textContent}`);
if (!drawn.some(p => p.classList.contains('is-dim'))) fail('hovering does not dim what is off the hovered path');
rackArc.dispatch('mouseleave', {});
if (card.classList.contains('show')) fail('the card stays up after the pointer leaves');

// A leaf has nothing beneath it: clicking it must not drill into an empty diagram.
drawn.find(p => p.dataset.node === 'ac').dispatch('click', { stopPropagation() { } });
await new Promise(r => setTimeout(r, 100));
if (query(sec, '.flow-drill', false)?.value) fail('clicking a leaf drilled into it');

// Clicking an arc opens it: the drill picker follows, and the sunburst re-centres there.
const sub = drawn.find(p => p.dataset.node === 'sub');
sub.dispatch('click', { stopPropagation() { } });
await new Promise(r => setTimeout(r, 100));
const drillSel = query(sec, '.flow-drill', false);
if (drillSel?.value !== 'sub') fail(`clicking the sub panel's arc drilled to "${drillSel?.value}"`);
const hubName = query(sec, '.sunburst-hub-name', false);
if (!String(hubName?._text ?? hubName?.textContent).includes('sub')) fail('the hub does not name the sub panel after opening it');

const lab = (label, span, mid, rm, depth) => vm.runInContext(`arcLabel(${JSON.stringify(label)}, ${span}, ${mid}, ${rm}, ${depth})`, sandbox);
let lb = lab('B2-1', 0.05, 0.1, 300, 60);
if (lb.lines.join() !== 'B2-1' || lb.along || Math.abs(lb.deg - (0.1 * 180 / Math.PI - 90)) > 1e-6) fail(`a short label is not radial: ${JSON.stringify(lb)}`);
lb = lab('Solar (PV)', 2.5, 2.0, 150, 60);
if (lb.lines.join() !== 'Solar (PV)') fail(`a wide arc clips its label: ${JSON.stringify(lb)}`);
if (!lb.along || !lb.flip) fail(`a wide arc at the bottom is not drawn along it, upright: ${JSON.stringify(lb)}`);
lb = lab('Livingroom Outlets TV', 0.6, 1.0, 220, 60);
if (lb.lines.length !== 2 || lb.lines.join(' ') !== 'Livingroom Outlets TV') fail(`a deep ring does not wrap: ${JSON.stringify(lb)}`);
const sized = (label, span, depth, max) => vm.runInContext(`arcLabel(${JSON.stringify(label)}, ${span}, 1.0, 150, ${depth}, ${max})`, sandbox);
lb = sized('Solar (PV)', 3.0, 60, 15);
if (lb.size !== 15 || lb.lines.join() !== 'Solar (PV)') fail(`a wide root arc is not drawn larger: ${JSON.stringify(lb)}`);
lb = sized('Main Panel', 0.6, 60, 15);
if (!(lb.size > 11.5 && lb.size < 15) || lb.lines.join() !== 'Main Panel') fail(`a mid-sized root arc does not shrink to fit: ${JSON.stringify(lb)}`);
lb = sized('Fridge / Kitchen', 0.11, 90, 15);
if (!(lb.size < 11.5 && lb.size >= 8) || lb.lines.join(' ') !== 'Fridge / Kitchen') fail(`a label that fits smaller is clipped instead: ${JSON.stringify(lb)}`);
lb = sized('Livingroom Outlets, TV', 0.12, 60, 15);
if (lb.size !== 8 || !/…$/.test(lb.lines.join(' '))) fail(`a label too long for any size is not clipped at the smallest size: ${JSON.stringify(lb)}`);
lb = sized('Main Panel: Untracked', 0.2, 60, 11.5);
if (lb.along || lb.lines.length !== 2 || lb.lines.join(' ') !== 'Main Panel: Untracked') fail(`a radial label does not wrap in a wide enough slice: ${JSON.stringify(lb)}`);
lb = sized('Synology', 0.02, 60, 11.5);
if (lb.lines.length) fail(`a slice too thin for any size is labelled: ${JSON.stringify(lb)}`);
// Zoom: each chart sits in a pane; + enlarges it.
const svgs = query(sec, 'svg', true).filter(x => String(x.attrs.class || '').includes('sunburst-svg'));
if (!svgs.length || !svgs.every(x => query(sec, '.tree-zoom', true).some(p => p.children.includes(x)))) fail('a sunburst is not in a zoom pane');
const w0 = Number(svgs[0].attrs.width);
query(query(sec, '.flow-zoom'), 'button', true).find(b => b.textContent === '+').onclick();
if (!(Number(svgs[0].attrs.width) > w0)) fail(`zooming in does not enlarge the sunburst: ${w0} -> ${svgs[0].attrs.width}`);
console.log(`sunburst check passed (${arcs.length} arcs; the hub, the supply ring and opening an arc).`);

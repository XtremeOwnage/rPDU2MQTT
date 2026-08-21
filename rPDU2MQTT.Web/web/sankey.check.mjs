// Sankey regression check for the night-time case (ToDo.md, image.png): the MPPTs feed a Solar (PV)
// aggregate which feeds the inverter, and after dark every one of them reads 0 W while the grid carries
// the whole load.
//
// What went wrong: the barycenter weighted each feeder by its link value, so a zero-carrying link had no
// pull at all — `w` stayed 0, bary() returned Infinity, and the entire solar chain sorted to the bottom
// of its column while the inverter it feeds stayed up beside the grid. The ribbons joining them scaled to
// 0 px, so nothing visibly connected them either: five orphan markers stranded at the bottom-left.
//
// This asserts the two properties that were violated: the chain stays vertically together, and every link
// is drawn thick enough to see.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');

// Night: solar chain measured at 0 W, grid carrying 2242 W through the inverter to the panel.
const nightGraph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'MPPT_1', label: 'MPPT_1', value: 0 },
    { id: 'MPPT_2', label: 'MPPT_2', value: 0 },
    { id: 'MPPT_3', label: 'MPPT_3', value: 0 },
    { id: 'solar', label: 'Solar (PV)', value: 0 },
    { id: 'grid', label: 'Grid', value: 2242 },
    { id: 'inverter', label: 'EG4 FlexBoss 21', value: 2242 },
    { id: 'panel', label: 'Main Panel', value: 2242 },
  ],
  links: [
    { source: 'MPPT_1', target: 'solar', value: 0 },
    { source: 'MPPT_2', target: 'solar', value: 0 },
    { source: 'MPPT_3', target: 'solar', value: 0 },
    { source: 'solar', target: 'inverter', value: 0 },
    { source: 'grid', target: 'inverter', value: 2242 },
    { source: 'inverter', target: 'panel', value: 2242 },
  ],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] } } :
    url.includes('/api/flow') ? nightGraph :
    { ok: true },
});

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

const nav = getEl('nav');
const flowLink = query(nav, 'a', true).find(a => a.dataset.label === 'Flow');
if (!flowLink) { console.error('sankey check FAILED: no Flow tab'); process.exit(1); }
flowLink.click();
await new Promise(r => setTimeout(r, 50));

const fail = (m) => { console.error('sankey check FAILED: ' + m); process.exit(1); };

/// Render a second graph in a fresh sandbox and return its ribbons.
async function render(graph, want = 'path') {
  const { sandbox: sb, getEl: ge } = makeDom({
    bodies: (url) =>
      url.includes('/api/schema') ? schema :
      url.includes('/api/instances') ? { ok: true, instances: [] } :
      url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] } } :
      url.includes('/api/flow') ? graph :
      { ok: true },
  });
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 40));
  query(ge('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
  await new Promise(r => setTimeout(r, 50));
  if (want === 'rect') return query(ge('sections'), 'rect', true).filter(r => r.attrs['data-node']);
  return query(ge('sections'), 'path', true).filter(p => p.attrs['fill-opacity'] !== undefined);
}

// Node bars are <rect x y width height>; the Sankey's are the ones at the node width (12).
const bars = query(getEl('sections'), 'rect', true)
  .filter(r => r.attrs.width === '12')
  .map(r => ({ x: Number(r.attrs.x), y: Number(r.attrs.y), h: Number(r.attrs.height) }));
if (bars.length < 7) fail(`expected 7 node bars, found ${bars.length}`);

// Columns by x; within the solar chain's columns, the chain must not be flung to the bottom.
const byX = new Map();
for (const b of bars) { const k = b.x; byX.set(k, [...(byX.get(k) || []), b]); }
const xs = [...byX.keys()].sort((a, b) => a - b);
if (xs.length !== 4) fail(`expected 4 columns, got ${xs.length}`);

// Column 0 holds the three MPPTs and the grid; column 1 holds Solar (PV) alone. The MPPTs feed Solar,
// so they must sit level with it. Before the fix they sorted below the grid's full-height bar — measured at
// y=557/580/603 against Solar at y=29, a ~530px climb along ribbons that scaled to nothing.
const solarY = byX.get(xs[1])[0].y;
const drift = Math.max(...byX.get(xs[0]).map(b => b.h < 10 ? Math.abs(b.y - solarY) : 0));
if (drift > 100) fail(`an idle MPPT sits ${Math.round(drift)}px from the Solar node it feeds — the chain drifted apart`);

// Every ribbon must be visible. A zero-valued band used to scale to ~1px at 30% opacity, i.e. nothing.
// (The Flow tab also renders the hierarchy editor, whose edges are stroked paths with no fill-opacity —
// select on that attribute so only the Sankey's filled ribbons are considered.)
const ribbons = query(getEl('sections'), 'path', true).filter(p => p.attrs['fill-opacity'] !== undefined);
if (ribbons.length !== 6) fail(`expected 6 ribbons, found ${ribbons.length}`);
for (const r of ribbons) {
  const op = Number(r.attrs['fill-opacity']);
  if (!(op >= 0.3)) fail(`a ribbon is drawn at ${op} opacity — an idle branch has to stay visible`);
}

// --- The other half of the same trade-off: a column that is already correctly placed must be left alone.
//
// A source whose targets' heights sum to its own stacks its ribbons flush by construction, so those bands
// should leave and arrive at the same y. The drift rescue above used to fire on every column regardless,
// which lifted such targets off the source's edge and bent a straight band into an S — ribbons rising out
// of the top of the panel that fed them before turning back down.
const flat = await render({
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'panel', label: 'Main Panel', value: 100 },
    { id: 'a', label: 'A', value: 60 },
    { id: 'b', label: 'B', value: 40 },
  ],
  links: [
    { source: 'panel', target: 'a', value: 60 },
    { source: 'panel', target: 'b', value: 40 },
  ],
});
// The invariant is direction, not exact flatness: stacked targets sit a gap apart, so a later ribbon drifts
// gently DOWN by the accumulated gaps and that is correct. A ribbon travelling UP means the target column
// was moved above the source feeding it, which is the S — and that is what must never happen.
for (const r of flat) {
  const m = /^M[\d.-]+,([\d.-]+) C[\d.-]+,[\d.-]+ [\d.-]+,([\d.-]+)/.exec(r.attrs.d);
  if (!m) continue;
  const dy = Number(m[2]) - Number(m[1]);
  if (dy < -2)
    fail(`a ribbon rises ${(-dy).toFixed(1)}px out of the node feeding it — the target column sits above its source`);
  if (dy > 40)
    fail(`a ribbon whose targets exactly fill its source drops ${dy.toFixed(1)}px — far more than the stacking gaps`);
}

// --- The unmetered remainder sits below every measured sibling (#366).
//
// It is what is left after the metered children are subtracted, and it changes size as they do, so ordering
// it by magnitude moves it up and down the column between readings.
const withRemainder = await render({
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'panel', label: 'Main Panel', value: 6722 },
    { id: 'panel#unmeasured', label: 'Unmeasured load', kind: 'unmeasured', value: 5915 },
    { id: 'pdu_1', label: 'Rack-PDU-1', value: 500 },
    { id: 'fridge', label: 'fridge', value: 307 },
  ],
  links: [
    { source: 'panel', target: 'panel#unmeasured', value: 5915 },
    { source: 'panel', target: 'pdu_1', value: 500 },
    { source: 'panel', target: 'fridge', value: 307 },
  ],
}, 'rect');

const yOf = (id) => {
  const r = withRemainder.find(x => x.attrs['data-node'] === id);
  if (!r) fail(`no node drawn for ${id}`);
  return Number(r.attrs.y);
};
const remainderY = yOf('panel#unmeasured');
for (const id of ['pdu_1', 'fridge']) {
  if (remainderY < yOf(id))
    fail(`the unmetered remainder is drawn above ${id} — it is the last figure calculated and belongs below`);
}

// --- Two parents, each with a remainder: every child stays in its own parent's block.
//
// Reported from a live diagram: PDU-1's "Unmeasured load" was drawn below PDU-2's devices, so its ribbon
// swept across the whole of PDU-2's block to reach it. The remainder was being sorted below every measured
// node in the COLUMN rather than below its own siblings, which is only the same thing when there is one
// parent — and the check only ever had one.
const twoParents = await render({
  ok: true, metric: 'energytoday', units: 'kWh',
  nodes: [
    { id: 'panel', label: 'Main Panel', value: 138.876 },
    { id: 'pdu_1', label: 'Rack-PDU-1', value: 47.685 },
    { id: 'pdu_2', label: 'Rack-PDU-2', value: 45.897 },
    { id: 'kube01', label: 'Proxmox: Kube01', value: 1.99 },
    { id: 'kube05', label: 'Proxmox: Kube05', value: 1.37 },
    { id: 'nas', label: 'Synology: NAS', value: 1.075 },
    { id: 'pdu_1#unmeasured', label: 'Unmeasured load', kind: 'unmeasured', value: 43.25 },
    { id: 'r730xd', label: 'Dell: r730XD', value: 5.841 },
    { id: 'edgerouter', label: 'Edgerouter', value: 0.321 },
    { id: 'crs504', label: 'CRS504', value: 0.188 },
    { id: 'pdu_2#unmeasured', label: 'Unmeasured load', kind: 'unmeasured', value: 39.547 },
  ],
  links: [
    { source: 'panel', target: 'pdu_1', value: 47.685 },
    { source: 'panel', target: 'pdu_2', value: 45.897 },
    { source: 'pdu_1', target: 'kube01', value: 1.99 },
    { source: 'pdu_1', target: 'kube05', value: 1.37 },
    { source: 'pdu_1', target: 'nas', value: 1.075 },
    { source: 'pdu_1', target: 'pdu_1#unmeasured', value: 43.25 },
    { source: 'pdu_2', target: 'r730xd', value: 5.841 },
    { source: 'pdu_2', target: 'edgerouter', value: 0.321 },
    { source: 'pdu_2', target: 'crs504', value: 0.188 },
    { source: 'pdu_2', target: 'pdu_2#unmeasured', value: 39.547 },
  ],
}, 'rect');

const y2 = (id) => {
  const r = twoParents.find(x => x.attrs['data-node'] === id);
  if (!r) fail(`no node drawn for ${id}`);
  return Number(r.attrs.y);
};
const firstFamily = ['kube01', 'kube05', 'nas', 'pdu_1#unmeasured'].map(y2);
const secondFamily = ['r730xd', 'edgerouter', 'crs504', 'pdu_2#unmeasured'].map(y2);

// Each parent's children occupy a contiguous band: the lowest of PDU-1's is above the highest of PDU-2's.
if (Math.max(...firstFamily) > Math.min(...secondFamily))
  fail('a child of Rack-PDU-1 is drawn below a child of Rack-PDU-2 — the two families interleave, '
     + 'so their ribbons have to cross');

// ...and each remainder is the last of ITS OWN family, not of the column.
if (y2('pdu_1#unmeasured') < Math.max(...['kube01', 'kube05', 'nas'].map(y2)))
  fail("Rack-PDU-1's remainder is drawn above its own measured siblings");
if (y2('pdu_2#unmeasured') < Math.max(...['r730xd', 'edgerouter', 'crs504'].map(y2)))
  fail("Rack-PDU-2's remainder is drawn above its own measured siblings");

// --- Where a column sits against a much larger parent ------------------------------------------------
// A ribbon leaves a bar at its top and stacks downward, so a 3,012 W panel whose drawn children total
// ~640 W carries all of them in the top fifth of its bar. Relaxing the children toward the panel's CENTRE
// aimed at a point no ribbon touches and pushed the column 141px down the canvas (#404 follow-up).
{
  const bigParent = {
    ok: true, metric: 'realpower', units: 'W',
    nodes: [
      { id: 'panel', label: 'Main Panel', value: 3012 },
      { id: 'pdu1', label: 'Rack-PDU-1', value: 309 },
      { id: 'pdu2', label: 'Rack-PDU-2', value: 287 },
      { id: 'fridge', label: 'fridge', value: 44 },
    ],
    links: [
      { source: 'panel', target: 'pdu1', value: 309 },
      { source: 'panel', target: 'pdu2', value: 287 },
      { source: 'panel', target: 'fridge', value: 44 },
    ],
  };
  const dom = makeDom({
    bodies: (url) =>
      url.includes('/api/schema') ? schema :
      url.includes('/api/instances') ? { ok: true, instances: [] } :
      url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] } } :
      url.includes('/api/flow') ? bigParent :
      { ok: true },
  });
  vm.createContext(dom.sandbox);
  vm.runInContext(code, dom.sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 60));
  query(dom.getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
  await new Promise(r => setTimeout(r, 200));

  const bars = Object.fromEntries(query(dom.getEl('sections'), 'rect', true)
    .filter(r => r.attrs['data-node'])
    .map(r => [r.attrs['data-node'], Math.round(+r.attrs.y)]));

  // The panel's own bar starts at the top margin, and so does the first child its ribbons reach.
  if (bars.pdu1 == null || bars.panel == null) fail(`the diagram did not draw: ${JSON.stringify(bars)}`);
  if (bars.pdu1 > bars.panel + 30)
    fail(`the children hang ${bars.pdu1 - bars.panel}px below a parent whose ribbons all leave its top`);
  if (bars.pdu2 < bars.pdu1) fail('the children are out of order');
}

// --- The pane the diagram lives in ------------------------------------------------------------------
// The hierarchy IS the page, so it grows to its own height: a pane capped at 74vh put a scrollbar inside
// the page's scrollbar, and the graph read as an iframe someone had embedded (#395).
const stage = query(getEl('sections'), 'div', true).find(d => (d.attrs?.class || d.className || '') === 'flow-stage');
if (!stage) fail('the diagram is not on a stage, so nothing can be pinned over it');
const pane = (stage.children || [])[0];
if (pane?.style?.maxHeight) fail(`the diagram pane is capped at ${pane.style.maxHeight} — the page scrolls twice`);

// Zoom belongs on the diagram, not in a toolbar under it.
const zoom = query(stage, 'div', true).find(d => (d.attrs?.class || d.className || '') === 'flow-zoom');
if (!zoom) fail('no zoom controls pinned on the diagram');
const labels = (zoom.children || []).map(b => b.textContent);
if (labels.length < 3) fail(`expected zoom in, out and fit; got ${labels.join(' ')}`);
if (!labels.includes('+') || !labels.includes('\u2212')) fail(`no zoom in/out control: ${labels.join(' ')}`);

console.log(`sankey: night-time chain holds together (MPPTs within ${Math.round(drift)}px of Solar), `
  + `${ribbons.length} ribbons all visible; each parent's remainder sits below its OWN siblings and the two families do not interleave; the pane is uncapped and carries its own zoom controls`);

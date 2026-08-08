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

console.log(`sankey: night-time chain holds together (MPPTs within ${Math.round(drift)}px of Solar), `
  + `${ribbons.length} ribbons all visible; the unmetered remainder sits below its measured siblings`);

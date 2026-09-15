// The by-kind layout preview: columns by kind, loads at the far right, and a link that skips a column running
// through it in a lane of its own. The default layout is left exactly as it was.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('tierlayout check FAILED: ' + m); process.exit(1); };

// A main panel with a sub-panel nested under it, a breaker feeding a PDU, and loads at every depth.
const N = (id, kind, value) => ({ id, label: id, kind, value, derivation: 'measured' });
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    N('grid', 'grid', 2000), N('inverter', 'inverter', 2000),
    N('main_panel', 'panel', 1800), N('sub_panel', 'panel', 250),
    N('b_living', 'breaker', 600), N('pdu1', 'pdu', 300), N('dell', 'outlet', 250),
    N('fridge', 'load', 100), N('hvac', 'load', 90), N('n30', 'load', 50),
    // An endpoint of no particular kind — an imported reading left as a plain node — has no tier to place it.
    N('hall_light', 'node', 12),
    // A second branch whose panel has nothing nested under it.
    N('garage_panel', 'panel', 200), N('g_breaker', 'breaker', 150), N('tools', 'load', 150),
  ],
  links: [
    { source: 'grid', target: 'inverter', value: 2000 },
    { source: 'inverter', target: 'main_panel', value: 1800 },
    { source: 'main_panel', target: 'sub_panel', value: 250 },
    { source: 'main_panel', target: 'b_living', value: 600 },
    { source: 'main_panel', target: 'fridge', value: 100 },
    { source: 'sub_panel', target: 'hvac', value: 90 },
    { source: 'sub_panel', target: 'hall_light', value: 12 },
    { source: 'b_living', target: 'pdu1', value: 300 },
    { source: 'b_living', target: 'n30', value: 50 },
    { source: 'pdu1', target: 'dell', value: 250 },
    { source: 'inverter', target: 'garage_panel', value: 200 },
    { source: 'garage_panel', target: 'g_breaker', value: 150 },
    { source: 'g_breaker', target: 'tools', value: 150 },
  ],
};
const real = new Set(graph.nodes.map(n => n.id));

async function render(layout, routing) {
  const store = new Map([...(layout ? [['rpdu-flow-layout', layout]] : []), ...(routing ? [['rpdu-flow-ribbon', routing]] : [])]);
  const { sandbox, getEl } = makeDom({
    bodies: (url) => url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: false } }
      : url.includes('/api/flow/live') ? { ok: true, values: [] }
      : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
      : url.includes('/api/flow') ? graph
      : { ok: true },
  });
  sandbox.localStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 50));
  query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
  await new Promise(r => setTimeout(r, 300));
  const sec = query(getEl('sections'), '.section', true).find(x => query(x, '.flow-gestures', true).length > 0);
  if (!sec) fail('could not find the Flow section');
  const bars = new Map(query(sec, 'rect', true).filter(r => r.attrs && r.attrs['data-node'])
    .map(r => [r.attrs['data-node'], { x: +r.attrs.x, y: +r.attrs.y, h: +r.attrs.height }]));
  const labels = query(sec, 'text', true).filter(t => t.attrs && t.attrs['data-node']).map(t => t.attrs['data-node']);
  const ribbons = query(sec, 'path', true).filter(p => p.attrs && p.attrs['fill-opacity'] !== undefined && p.attrs.d)
    .map(p => ({ src: p.attrs['data-src'], dst: p.attrs['data-dst'], d: p.attrs.d }));
  return { bars, labels, ribbons };
}

const tiers = await render('tiers');
const x = (id) => { const b = tiers.bars.get(id); if (!b) fail(`no bar for ${id}`); return b.x; };

// Loads and outlets end at the far right, whatever depth they hang at.
const right = Math.max(...[...tiers.bars.values()].map(b => b.x));
for (const id of ['fridge', 'hvac', 'n30', 'dell', 'hall_light', 'tools'])
  if (x(id) !== right) fail(`${id} is not in the last column (x=${x(id)}, last is ${right})`);

// Panels nest, and what a panel feeds beyond the next tier sits past it: the breaker is right of the sub-panel.
if (!(x('main_panel') < x('sub_panel'))) fail('a sub-panel is not a column right of the panel feeding it');
if (!(x('sub_panel') < x('b_living'))) fail('the main panel\'s breaker does not pass the nested sub-panel\'s column');
if (!(x('b_living') < x('pdu1'))) fail('the PDU is not right of the breaker feeding it');
// …but only past panels on its own branch: a panel with nothing nested under it keeps its breakers beside it.
if (x('g_breaker') !== x('sub_panel'))
  fail(`a breaker under a panel with nothing nested was pushed past another branch's sub-panel (x=${x('g_breaker')}; the column beside its panel is x=${x('sub_panel')})`);

// A link that skips columns is still ONE band: drawn hop by hop it left a stripe at every column it crossed.
const fridge = tiers.ribbons.filter(r => r.src === 'main_panel' && r.dst === 'fridge');
if (fridge.length !== 1) fail(`main_panel -> fridge crosses several columns and is drawn as ${fridge.length} pieces, not one band`);
const d = fridge[0].d;
if ((d.match(/M/g) || []).length !== 1 || !/Z\s*$/.test(d)) fail(`the pass-through is not one closed band: ${d.slice(0, 120)}…`);

// It runs from the panel's bar to the fridge's, and through every column between them.
const topEdge = d.slice(0, d.indexOf(' L'));
const joints = [...topEdge.matchAll(/C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/g)]
  .map(m => ({ c1: [+m[1], +m[2]], c2: [+m[3], +m[4]], p: [+m[5], +m[6]] }));
const start = topEdge.match(/^M([\d.-]+),([\d.-]+)/).slice(1).map(Number);
if (Math.abs(start[0] - (x('main_panel') + 12)) > 0.5) fail(`the band does not leave the panel's bar: starts at x=${start[0]}`);
if (Math.abs(joints.at(-1).p[0] - x('fridge')) > 0.5) fail(`the band does not reach the fridge's bar: ends at x=${joints.at(-1).p[0]}`);
if (joints.length < 3) fail(`the band crosses ${joints.length - 1} column(s); expected it to pass through several`);

// Through each column it bends smoothly: the curve arriving and the curve leaving share one tangent there.
for (let i = 0; i < joints.length - 1; i++) {
  const [px, py] = joints[i].p, [ax, ay] = joints[i].c2, [bx, by] = joints[i + 1].c1;
  const cross = (px - ax) * (by - py) - (py - ay) * (bx - px);
  if (Math.abs(cross) > 1) fail(`the band kinks where it crosses the column at x=${px}: the curves either side do not share a tangent`);
}

// …and where it crosses a column, its lane is clear of every bar in that column.
const bandH = (() => { const after = d.slice(d.indexOf(' L')).match(/L[\d.-]+,([\d.-]+)/); return +after[1] - joints.at(-1).p[1]; })();
for (let i = 0; i < joints.length - 1; i++) {
  const [cx, cy] = joints[i].p;
  for (const [id, b] of tiers.bars) {
    if (cx < b.x - 1 || cx > b.x + 13) continue;
    if (cy < b.y + b.h && cy + bandH > b.y) fail(`the pass-through cuts across ${id}'s bar at x=${cx}`);
  }
}

// Waypoints are lanes, not nodes: no bar, no label.
if ([...tiers.bars.keys()].some(id => !real.has(id))) fail(`a waypoint was drawn as a bar: ${[...tiers.bars.keys()].filter(id => !real.has(id))}`);
if (tiers.labels.some(id => !real.has(id))) fail('a waypoint was given a label');

// Nothing in a column overlaps, waypoints included in the spacing.
const byCol = new Map();
[...tiers.bars.entries()].forEach(([id, b]) => { if (!byCol.has(b.x)) byCol.set(b.x, []); byCol.get(b.x).push({ id, ...b }); });
for (const [cx, col] of byCol) {
  col.sort((a, b) => a.y - b.y);
  for (let i = 1; i < col.length; i++)
    if (col[i].y < col[i - 1].y + col[i - 1].h) fail(`"${col[i - 1].id}" and "${col[i].id}" overlap at x=${cx}`);
}

// Ribbons crossing a column side by side are laid as one wide band. Lanes with no bar between them may sit
// closer than bars do — closer than the 6 px gap — and none overlap.
const heightOf = (r) => {
  const top = r.d.slice(0, r.d.indexOf(' L'));
  const end = top.match(/([\d.-]+),([\d.-]+)$/);
  const cap = r.d.slice(r.d.indexOf(' L')).match(/L[\d.-]+,([\d.-]+)/);
  return +cap[1] - +end[2];
};
const lanesAt = new Map();
tiers.ribbons.forEach(r => {
  const joins = [...r.d.slice(0, r.d.indexOf(' L')).matchAll(/C[\d.-]+,[\d.-]+ [\d.-]+,[\d.-]+ ([\d.-]+),([\d.-]+)/g)]
    .map(m => [+m[1], +m[2]]).slice(0, -1);
  const h = heightOf(r);
  joins.forEach(([px, py]) => {
    const key = Math.round(px);
    if (!lanesAt.has(key)) lanesAt.set(key, []);
    lanesAt.get(key).push({ id: `${r.src}->${r.dst}`, y: py, h });
  });
});
let bundled = 0;
for (const [cx, lanes] of lanesAt) {
  lanes.sort((a, b) => a.y - b.y);
  for (let i = 1; i < lanes.length; i++) {
    const above = lanes[i - 1], below = lanes[i];
    const space = below.y - (above.y + above.h);
    if (space < -0.5) fail(`the lanes of ${above.id} and ${below.id} overlap where they cross the column at x=${cx}`);
    const barBetween = [...tiers.bars.values()].some(b => cx >= b.x - 1 && cx <= b.x + 13 && b.y < below.y && b.y + b.h > above.y + above.h);
    if (!barBetween && space < 5.9) bundled++;
  }
}
if (!bundled) fail('no two lanes crossing a column sit closer than the gap between bars — ribbons passing through together are fanned out');

// Right-angle routing passes through as one band too.
for (const routing of ['ortho', 'ortho-round']) {
  const r = (await render('tiers', routing)).ribbons.filter(x => x.src === 'main_panel' && x.dst === 'fridge');
  if (r.length !== 1 || (r[0].d.match(/M/g) || []).length !== 1 || !/Z\s*$/.test(r[0].d))
    fail(`${routing}: main_panel -> fridge is not one closed band (${r.length} piece(s))`);
  // …that runs the whole way, from the panel's bar to the fridge's, not just its first hop.
  const xs = [...r[0].d.matchAll(/([\d.-]+),([\d.-]+)/g)].map(m => +m[1]);
  if (Math.abs(Math.min(...xs) - (x('main_panel') + 12)) > 0.5 || Math.abs(Math.max(...xs) - x('fridge')) > 0.5)
    fail(`${routing}: main_panel -> fridge does not run from the panel's bar to the fridge's (x ${Math.min(...xs)} → ${Math.max(...xs)})`);
}

// The default layout is untouched: one ribbon per link.
const hops = await render(null);
if (hops.ribbons.filter(r => r.src === 'main_panel' && r.dst === 'fridge').length !== 1)
  fail('the default layout split a ribbon into segments');
if (hops.bars.get('fridge').x === Math.max(...[...hops.bars.values()].map(b => b.x)) && hops.bars.get('fridge').x === hops.bars.get('dell').x)
  fail('the default layout moved loads to the far right as well');

console.log('tierlayout: by kind, loads and outlets end in the last column, a breaker passes a nested sub-panel\'s '
  + 'column, a skipped column is crossed as one smooth band through a lane clear of every bar, no waypoint is drawn, '
  + 'nothing overlaps, and the default layout is unchanged');
process.exit(0);

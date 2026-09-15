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
  ],
};
const real = new Set(graph.nodes.map(n => n.id));

async function render(layout) {
  const store = new Map(layout ? [['rpdu-flow-layout', layout]] : []);
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
    .map(p => ({ src: p.attrs['data-src'], dst: p.attrs['data-dst'] }));
  return { bars, labels, ribbons };
}

const tiers = await render('tiers');
const x = (id) => { const b = tiers.bars.get(id); if (!b) fail(`no bar for ${id}`); return b.x; };

// Loads and outlets end at the far right, whatever depth they hang at.
const right = Math.max(...[...tiers.bars.values()].map(b => b.x));
for (const id of ['fridge', 'hvac', 'n30', 'dell', 'hall_light'])
  if (x(id) !== right) fail(`${id} is not in the last column (x=${x(id)}, last is ${right})`);

// Panels nest, and what a panel feeds beyond the next tier sits past it: the breaker is right of the sub-panel.
if (!(x('main_panel') < x('sub_panel'))) fail('a sub-panel is not a column right of the panel feeding it');
if (!(x('sub_panel') < x('b_living'))) fail('the main panel\'s breaker does not pass the nested sub-panel\'s column');
if (!(x('b_living') < x('pdu1'))) fail('the PDU is not right of the breaker feeding it');

// A link that skips columns runs through each one in a lane: main panel -> fridge is several segments.
const fridgeSegments = tiers.ribbons.filter(r => r.src === 'main_panel' && r.dst === 'fridge').length;
if (fridgeSegments < 3) fail(`main_panel -> fridge crosses several columns but is drawn as ${fridgeSegments} segment(s)`);

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

// The default layout is untouched: one ribbon per link.
const hops = await render(null);
if (hops.ribbons.filter(r => r.src === 'main_panel' && r.dst === 'fridge').length !== 1)
  fail('the default layout split a ribbon into segments');
if (hops.bars.get('fridge').x === Math.max(...[...hops.bars.values()].map(b => b.x)) && hops.bars.get('fridge').x === hops.bars.get('dell').x)
  fail('the default layout moved loads to the far right as well');

console.log('tierlayout: by kind, loads and outlets end in the last column, a breaker passes a nested sub-panel\'s '
  + 'column, a skipped column is crossed in a lane with no bar or label, nothing overlaps, and the default layout is unchanged');
process.exit(0);

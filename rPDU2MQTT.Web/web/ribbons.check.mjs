// Link routing: the picker offers curved ribbons and two wiring styles.
//
// A curved ribbon is a filled band as thick as its flow. The wiring styles draw each link as a wire on a grid
// instead: a band that thick cannot turn a right angle in a column gap, and every attempt at it came out as
// solid blocks stacked into one another. A wire leaves the middle of its slot on the source bar, runs along
// its source's trunk, and arrives at the middle of its slot on the target bar.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('ribbons check FAILED: ' + m); process.exit(1); };

// One source feeding three targets: one it must reach by going down, one level with it, one going up.
// The upward one is the case that folds if the band is offset the same way in both directions.
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'src', label: 'Source', kind: 'panel', value: 900, derivation: 'measured' },
    { id: 'a', label: 'A', kind: 'load', value: 500, derivation: 'measured' },
    { id: 'b', label: 'B', kind: 'load', value: 300, derivation: 'measured' },
    { id: 'c', label: 'C', kind: 'load', value: 100, derivation: 'measured' },
  ],
  links: [
    { source: 'src', target: 'a', value: 500 },
    { source: 'src', target: 'b', value: 300 },
    { source: 'src', target: 'c', value: 100 },
  ],
};

async function render(style) {
  const store = new Map(style ? [['rpdu-flow-ribbon', style]] : []);
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
  await new Promise(r => setTimeout(r, 250));
  const sec = query(getEl('sections'), '.section', true).find(x => query(x, '.flow-gestures', true).length > 0);
  if (!sec) fail('could not find the Flow section');
  return {
    sec,
    ribbons: query(sec, 'path', true).filter(p => p.attrs && p.attrs['fill-opacity'] !== undefined && p.attrs.d)
      .map(p => ({ d: p.attrs.d, src: p.attrs['data-src'], dst: p.attrs['data-dst'], stroke: p.attrs['stroke-width'] })),
  };
}

// --- The picker is on the page, offering all three -----------------------------------------------------
{
  const { sec } = await render(null);
  // el() assigns `value` as a property (as a browser does), not an attribute.
  const opts = query(sec, 'option', true).map(o => o.value).filter(Boolean);
  ['curved', 'ortho', 'ortho-round'].forEach(id => {
    if (!opts.includes(id)) fail(`the routing picker does not offer "${id}" (offers: ${opts.join(', ')})`);
  });
}

/// The routing functions are pure, so they are exercised directly rather than through whatever bands a
/// particular hierarchy happens to produce. The layout only ever handed us DOWNWARD ribbons, which is
/// exactly the half of the problem that cannot fail — an upward band is where the offsets fold.
const geom = (() => {
  const sb = { console, window: {}, localStorage: { getItem: () => null, setItem: () => {} } };
  vm.createContext(sb);
  try { vm.runInContext(code, sb, { filename: 'app.js' }); } catch { /* no DOM: the bootstrap stops, the functions are defined */ }
  if (typeof sb.ribbonOutline !== 'function' || typeof sb.wirePath !== 'function' || typeof sb.wireWidth !== 'function')
    fail('the routing functions are not in the bundle');
  return sb;
})();

/// The corner points of the shape, with any rounding undone.
///
/// A rounded corner is `L entry Q corner exit`: the CONTROL point is the corner the arc replaced, and the
/// entry and exit are points along its two legs. Reading entry and exit as consecutive vertices makes every
/// rounded corner look like a diagonal run. Folding each arc back to its control point recovers the sharp
/// polygon, which is what the right-angle and turn-count assertions are about — and the rounded outline is
/// strictly inside it, so it is the right shape to test for folds too.
function points(d) {
  const out = [];
  const re = /([MLQ])([^MLQZ]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const nums = m[2].trim().split(/[ ,]+/).filter(Boolean).map(Number);
    if (m[1] === 'Q') { out.pop(); out.push([nums[0], nums[1]]); }   // arc entry -> the corner it rounded
    else for (let i = 0; i < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  }
  // Consecutive duplicates (a corner that fell exactly on a cap) add nothing and upset the turn count.
  return out.filter((p, i) => i === 0 || Math.abs(p[0] - out[i - 1][0]) > 0.01 || Math.abs(p[1] - out[i - 1][1]) > 0.01);
}

// Down, up, level, and a drop shorter than a corner — the shapes a real hierarchy produces.
const WIRES = {
  down:    { x1: 0, sy: 40, x2: 200, ty: 320, trunkX: 100 },
  up:      { x1: 0, sy: 320, x2: 200, ty: 40, trunkX: 100 },
  level:   { x1: 0, sy: 100, x2: 200, ty: 100, trunkX: 100 },
  shallow: { x1: 0, sy: 100, x2: 200, ty: 106, trunkX: 100 },
  // A trunk the renderer put past the corridor's edge is pulled back inside it.
  outside: { x1: 0, sy: 40, x2: 200, ty: 320, trunkX: 260 },
};

for (const style of ['ortho', 'ortho-round']) {
  for (const [name, w] of Object.entries(WIRES)) {
    const d = geom.wirePath(style, w);
    const pts = points(d);
    if (d.includes('C')) fail(`${style}/${name} uses a cubic sweep: ${d}`);
    if (style === 'ortho' && d.includes('Q')) fail(`${style}/${name} rounds a corner it should not: ${d}`);
    // Every run is along one axis.
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = Math.abs(pts[i + 1][0] - pts[i][0]), dy = Math.abs(pts[i + 1][1] - pts[i][1]);
      if (dx > 0.1 && dy > 0.1) fail(`${style}/${name} has a diagonal run ${JSON.stringify([pts[i], pts[i + 1]])}: ${d}`);
    }
    // Out, along the trunk, in: two turns at most.
    let turns = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = Math.abs(pts[i][0] - pts[i - 1][0]) > 0.1 ? 'h' : 'v';
      const b = Math.abs(pts[i + 1][0] - pts[i][0]) > 0.1 ? 'h' : 'v';
      if (a !== b) turns++;
    }
    if (turns > 2) fail(`${style}/${name} turns ${turns} times: ${d}`);
    // From the middle of the source slot to the middle of the target slot, inside the corridor.
    const [first, last] = [pts[0], pts[pts.length - 1]];
    if (Math.abs(first[0] - w.x1) > 0.1 || Math.abs(first[1] - w.sy) > 0.1) fail(`${style}/${name} does not leave (${w.x1},${w.sy}): ${d}`);
    if (Math.abs(last[0] - w.x2) > 0.1 || Math.abs(last[1] - w.ty) > 0.1) fail(`${style}/${name} does not arrive at (${w.x2},${w.ty}): ${d}`);
    const xs = pts.map(p => p[0]);
    if (Math.min(...xs) < w.x1 - 0.1 || Math.max(...xs) > w.x2 + 0.1) fail(`${style}/${name} leaves the corridor: ${d}`);
  }
}
if (!geom.wirePath('ortho-round', WIRES.down).includes('Q')) fail('a rounded wire has no rounded corner');

// Thickness ranks the flows, and is never a slab or a hairline.
{
  const hs = [0, 1.5, 10, 50, 200, 800];
  const ws = hs.map(h => geom.wireWidth(h));
  for (let i = 1; i < ws.length; i++) if (ws[i] < ws[i - 1]) fail(`a larger flow drew a thinner wire: ${ws.join(', ')}`);
  if (Math.min(...ws) < 1.5 || Math.max(...ws) > 10) fail(`wire widths leave 1.5..10: ${ws.join(', ')}`);
}

// --- The default is unchanged --------------------------------------------------------------------------
const curved = await render('curved');
if (!curved.ribbons.every(r => r.d.includes('C'))) fail('the default routing is no longer the curved band');

// --- A wire leaves from inside the slot its curved band would occupy, and arrives inside its target's -----
for (const style of ['ortho', 'ortho-round']) {
  const { ribbons } = await render(style);
  if (ribbons.length !== curved.ribbons.length) fail(`${style} draws ${ribbons.length} links, curved draws ${curved.ribbons.length}`);
  for (const w of ribbons) {
    const band = curved.ribbons.find(r => r.src === w.src && r.dst === w.dst);
    if (!band) fail(`${style}: no curved band for ${w.src}->${w.dst}`);
    const bp = points(band.d), wp = points(w.d);
    const cap = (pts, x) => pts.filter(p => Math.abs(p[0] - x) < 0.5).map(p => p[1]);
    const x1 = Math.min(...bp.map(p => p[0])), x2 = Math.max(...bp.map(p => p[0]));
    const [s0, s1] = [Math.min(...cap(bp, x1)), Math.max(...cap(bp, x1))];
    const [t0, t1] = [Math.min(...cap(bp, x2)), Math.max(...cap(bp, x2))];
    const start = wp[0], end = wp[wp.length - 1];
    if (Math.abs(start[0] - x1) > 0.5 || start[1] < s0 - 0.5 || start[1] > s1 + 0.5)
      fail(`${style}: ${w.src}->${w.dst} leaves at ${start} — outside its slot ${x1},${s0}..${s1}`);
    if (Math.abs(end[0] - x2) > 0.5 || end[1] < t0 - 0.5 || end[1] > t1 + 0.5)
      fail(`${style}: ${w.src}->${w.dst} arrives at ${end} — outside its slot ${x2},${t0}..${t1}`);
    if (!(Number(w.stroke) > 0)) fail(`${style}: ${w.src}->${w.dst} is a wire with no stroke width`);
  }
}

console.log('ribbons: the picker offers curved ribbons and two wiring styles; a wire is axis-aligned, turns at most twice, '
  + 'rounds its corners when asked, stays in its corridor, runs from the middle of its source slot to the middle of its target '
  + 'slot, and its thickness ranks the flows');

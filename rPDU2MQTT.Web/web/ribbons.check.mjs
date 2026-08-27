// Ribbon routing: the picker offers the three strategies, and each one draws a band that actually holds
// together. A ribbon is a FILLED outline, so a routing that gets its offsets wrong does not merely look odd
// — the outline crosses itself and the ribbon renders as a bow tie, and the animated stream, which clips
// against that outline, disappears into the fold.
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
    ribbons: query(sec, 'path', true).filter(p => p.attrs && p.attrs['fill-opacity'] !== undefined)
      .map(p => p.attrs.d).filter(Boolean),
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
  if (typeof sb.ribbonOutline !== 'function' || typeof sb.lanePath !== 'function')
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

/// Do two segments properly cross (not merely touch at a shared endpoint)?
function crosses(p, p2, q, q2) {
  const d = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const shared = [p, p2].some(a => [q, q2].some(b => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01));
  if (shared) return false;
  return d(p, p2, q) !== d(p, p2, q2) && d(q, q2, p) !== d(q, q2, p2);
}

function selfIntersects(pts) {
  for (let i = 0; i < pts.length - 1; i++)
    for (let j = i + 2; j < pts.length - 1; j++)
      if (crosses(pts[i], pts[i + 1], pts[j], pts[j + 1])) return [pts[i], pts[i + 1], pts[j], pts[j + 1]];
  return null;
}

// Down, up, level, and a turn shorter than the band is thick — the shapes a real hierarchy produces.
const BANDS = {
  down:      { x1: 0, sTop: 20, x2: 200, tTop: 300, h: 40 },
  up:        { x1: 0, sTop: 300, x2: 200, tTop: 20, h: 40 },
  level:     { x1: 0, sTop: 100, x2: 200, tTop: 100, h: 40 },
  shallow:   { x1: 0, sTop: 100, x2: 200, tTop: 112, h: 40 },
  hairline:  { x1: 0, sTop: 40, x2: 200, tTop: 260, h: 1.5 },
  // Thicker than the gap is wide, which is ordinary: a 4.6 kW band is 324px in a 163px column gap.
  thickDown: { x1: 0, sTop: 20, x2: 163, tTop: 120, h: 324 },
  thickUp:   { x1: 0, sTop: 120, x2: 163, tTop: 20, h: 324 },
};

for (const style of ['ortho', 'ortho-round']) {
  for (const [name, b] of Object.entries(BANDS)) {
    const d = geom.ribbonOutline(style, b);
    const pts = points(d);

    if (d.includes('C')) fail(`${style}/${name} uses a cubic sweep: ${d}`);
    if (style === 'ortho' && d.includes('Q')) fail(`${style}/${name} rounds a corner it should not: ${d}`);

    // Every straight run is along one axis or the other.
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = Math.abs(pts[i + 1][0] - pts[i][0]), dy = Math.abs(pts[i + 1][1] - pts[i][1]);
      if (dx > 0.1 && dy > 0.1) fail(`${style}/${name} has a diagonal run ${JSON.stringify([pts[i], pts[i + 1]])}: ${d}`);
    }

    // Out, across, in: two bends a side, four for the closed outline. More than that is a staircase.
    let turns = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = Math.abs(pts[i][0] - pts[i - 1][0]) > 0.1 ? 'h' : 'v';
      const bb = Math.abs(pts[i + 1][0] - pts[i][0]) > 0.1 ? 'h' : 'v';
      if (a !== bb) turns++;
    }
    if (turns > 6) fail(`${style}/${name} turns ${turns} times — more than out/across/in a side: ${d}`);

    const fold = selfIntersects(pts);
    if (fold) fail(`${style}/${name} folds over itself at ${JSON.stringify(fold)}: ${d}`);

    // The vertical run has to have width, or the band is two rectangles with nothing joining them: the
    // fill renders both ends and the link between them is invisible.
    const turnXs = [...new Set(pts.slice(0, -1).map((p, i) =>
      Math.abs(pts[i + 1][0] - p[0]) < 0.1 && Math.abs(p[0] - b.x1) > 0.1 && Math.abs(p[0] - b.x2) > 0.1
        ? Math.round(p[0] * 10) / 10 : null).filter(v => v !== null))];
    if (turnXs.length === 1)
      fail(`${style}/${name} steps both edges at the same x (${turnXs[0]}), so its vertical run has no `
         + `width and the two ends are joined by nothing: ${d}`);

    // It has to span the bars it connects, and stay between them. Straying outside the corridor is what
    // drew a black slab out of the side of a panel: the band's corner sat half a THICKNESS from the step,
    // and a thick ribbon is easily thicker than the gap between two columns is wide.
    const xs = pts.map(p => p[0]);
    if (Math.min(...xs) > b.x1 + 0.1 || Math.max(...xs) < b.x2 - 0.1)
      fail(`${style}/${name} does not reach from ${b.x1} to ${b.x2}: ${d}`);
    if (Math.min(...xs) < b.x1 - 0.1 || Math.max(...xs) > b.x2 + 0.1)
      fail(`${style}/${name} leaves the corridor between the bars `
         + `(spans ${Math.min(...xs)}..${Math.max(...xs)}, corridor is ${b.x1}..${b.x2}): ${d}`);
    const startsAt = pts.filter(p => Math.abs(p[0] - b.x1) < 0.1).map(p => p[1]).sort((m, n) => m - n);
    if (Math.abs(startsAt[0] - b.sTop) > 0.1 || Math.abs(startsAt[startsAt.length - 1] - (b.sTop + b.h)) > 0.1)
      fail(`${style}/${name} leaves the source bar at ${JSON.stringify(startsAt)} rather than ${b.sTop}..${b.sTop + b.h}: ${d}`);
    const endsAt = pts.filter(p => Math.abs(p[0] - b.x2) < 0.1).map(p => p[1]).sort((m, n) => m - n);
    if (Math.abs(endsAt[0] - b.tTop) > 0.1 || Math.abs(endsAt[endsAt.length - 1] - (b.tTop + b.h)) > 0.1)
      fail(`${style}/${name} meets the target bar at ${JSON.stringify(endsAt)} rather than ${b.tTop}..${b.tTop + b.h}: ${d}`);
  }
}

// Rounding actually happens where there is room for it, and the lane follows the same route as its band.
if (!geom.ribbonOutline('ortho-round', BANDS.down).includes('Q'))
  fail('a long downward turn was not rounded at all');
for (const style of ['ortho', 'ortho-round']) {
  const lane = geom.lanePath(style, BANDS.up, 0.5);
  if (/[C]/.test(lane)) fail(`the ${style} stream lane is a cubic sweep, so it leaves its own band: ${lane}`);
}

// --- The default is unchanged --------------------------------------------------------------------------
{
  const { ribbons } = await render('curved');
  if (!ribbons.every(d => d.includes('C'))) fail('the default routing is no longer the curved band');
}

// --- Every routing still meets both bars in the same places --------------------------------------------
{
  const ends = {};
  for (const style of ['curved', 'ortho', 'ortho-round']) {
    const { ribbons } = await render(style);
    ends[style] = ribbons.map(d => {
      const pts = points(d);
      return [pts[0][0], pts[0][1]].map(n => Math.round(n)).join(',');
    }).sort().join(' | ');
  }
  if (ends.curved !== ends.ortho || ends.curved !== ends['ortho-round'])
    fail(`the routings start at different places — the band must leave the same bar at the same height:\n`
       + `  curved:      ${ends.curved}\n  ortho:       ${ends.ortho}\n  ortho-round: ${ends['ortho-round']}`);
}

console.log('ribbons: the routing picker offers curved / right angles / rounded angles; the grid routings '
  + 'are axis-aligned, turn at most twice a side, round their corners when asked, and none of them folds '
  + 'over itself going up or down — all three leaving each bar at the same place');

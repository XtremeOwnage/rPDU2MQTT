// Two rules the diagram now has to obey, on the shape that broke them: a main panel with seven circuits
// and a sub-panel with two, hanging off one inverter.
//
// 1. No two bars in a column sit closer than the gap. A node carries a name and a figure on one line, and
//    two bars closer than that put one row's text against the next row's bar.
// 2. Ribbons between the same pair of columns do not cross. They crossed because the layout could only
//    move a whole column at once, so a sub-panel's bar could sit above some of the MAIN panel's circuits
//    and every ribbon it sent had to cut across them to reach its own children.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('nocross check FAILED: ' + m); process.exit(1); };

const MIN_GAP = 13.9;   // the layout's own gap, less a rounding hair

// Values from the live system this was reported on.
const N = (id, kind, value) => ({ id, label: id, kind, value, derivation: 'measured' });
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    N('grid', 'grid', 12100), N('inverter', 'inverter', 12100),
    N('main_panel', 'panel', 1980), N('sub_panel', 'panel', 1300),
    N('livingroom', 'node', 611.99), N('deep_freezer', 'node', 134.9), N('fridge', 'node', 92.4),
    N('light', 'node', 91.59), N('utility', 'node', 1), N('server_ac', 'node', 0.7),
    N('bedroom', 'node', 0.26),
    N('minisplit', 'node', 675.58), N('water_heater', 'node', 1.83),
    N('pdu1', 'pdu', 324.12), N('pdu2', 'pdu', 287.87),
  ],
  links: [
    { source: 'grid', target: 'inverter', value: 12100 },
    { source: 'inverter', target: 'main_panel', value: 1980 },
    { source: 'inverter', target: 'sub_panel', value: 1300 },
    { source: 'main_panel', target: 'livingroom', value: 611.99 },
    { source: 'main_panel', target: 'deep_freezer', value: 134.9 },
    { source: 'main_panel', target: 'fridge', value: 92.4 },
    { source: 'main_panel', target: 'light', value: 91.59 },
    { source: 'main_panel', target: 'utility', value: 1 },
    { source: 'main_panel', target: 'server_ac', value: 0.7 },
    { source: 'main_panel', target: 'bedroom', value: 0.26 },
    { source: 'sub_panel', target: 'minisplit', value: 675.58 },
    { source: 'sub_panel', target: 'water_heater', value: 1.83 },
    { source: 'livingroom', target: 'pdu1', value: 324.12 },
    { source: 'livingroom', target: 'pdu2', value: 287.87 },
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
  await new Promise(r => setTimeout(r, 300));
  const sec = query(getEl('sections'), '.section', true).find(x => query(x, '.flow-gestures', true).length > 0);
  if (!sec) fail('could not find the Flow section');
  return {
    bars: query(sec, 'rect', true).filter(r => r.attrs && r.attrs['data-node'])
      .map(r => ({ id: r.attrs['data-node'], x: +r.attrs.x, y: +r.attrs.y, h: +r.attrs.height })),
    ribbons: query(sec, 'path', true).filter(p => p.attrs && p.attrs['fill-opacity'] !== undefined && p.attrs.d)
      .map(p => ({ src: p.attrs['data-src'], dst: p.attrs['data-dst'], d: p.attrs.d })),
  };
}

/// Where a ribbon leaves its source bar and where it meets its target bar.
function ends(d) {
  const pts = [];
  const re = /([MLQC])([^MLQCZ]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const nums = m[2].trim().split(/[ ,]+/).filter(Boolean).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  }
  const xs = pts.map(p => p[0]);
  const x1 = Math.min(...xs), x2 = Math.max(...xs);
  const at = (x) => {
    const ys = pts.filter(p => Math.abs(p[0] - x) < 0.5).map(p => p[1]);
    return (Math.min(...ys) + Math.max(...ys)) / 2;      // the middle of the band's cap
  };
  return { x1, x2, from: at(x1), to: at(x2) };
}

for (const style of ['curved', 'ortho', 'ortho-round']) {
  const { bars, ribbons } = await render(style);
  if (ribbons.length !== graph.links.length)
    fail(`${style}: expected ${graph.links.length} ribbons, got ${ribbons.length}`);

  // --- Rule 1: nothing in a column is closer than the gap ---------------------------------------------
  const byCol = new Map();
  bars.forEach(b => { if (!byCol.has(b.x)) byCol.set(b.x, []); byCol.get(b.x).push(b); });
  for (const [x, col] of byCol) {
    col.sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) {
      const space = col[i].y - (col[i - 1].y + col[i - 1].h);
      if (space < MIN_GAP)
        fail(`${style}: "${col[i - 1].id}" and "${col[i].id}" in the column at x=${x} are ${space.toFixed(1)}px `
           + `apart — closer than the ${MIN_GAP}px a row of text needs`);
    }
  }

  // --- Rule 2: ribbons between the same two columns do not cross ---------------------------------------
  // Two ribbons spanning the same gap cross exactly when their order at one end is the reverse of their
  // order at the other. That is the whole test, and it does not care how they are routed in between.
  const spans = new Map();
  ribbons.forEach(r => {
    const e = ends(r.d);
    const key = `${Math.round(e.x1)}->${Math.round(e.x2)}`;
    if (!spans.has(key)) spans.set(key, []);
    spans.get(key).push({ ...e, src: r.src, dst: r.dst });
  });
  for (const [key, list] of spans) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if ((a.from - b.from) * (a.to - b.to) < -0.01)
          fail(`${style}: "${a.src}->${a.dst}" and "${b.src}->${b.dst}" cross in the gap ${key} — `
             + `${a.src} leaves at ${a.from.toFixed(0)} and arrives at ${a.to.toFixed(0)}, `
             + `${b.src} leaves at ${b.from.toFixed(0)} and arrives at ${b.to.toFixed(0)}`);
      }
  }
}

// --- Rule 3: every vertical run in a corridor is collinear ---------------------------------------------
//
// Both halves of this are the rule. Letting each band turn half of its OWN thickness from the middle puts
// a thick ribbon's corners in a different place from a thin one's and they interlock — a row of notches
// that read as puzzle pieces. Giving each band a lane of its own instead spreads the turns across the
// corridor and the column comes out as a staircase. One axis and one width is the only arrangement where
// every vertical edge in a corridor falls on one of two lines.
{
  const { ribbons } = await render('ortho');
  const corridors = new Map();
  ribbons.forEach(r => {
    const pts = [...r.d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
    const xs = pts.map(p => p[0]);
    const x1 = Math.min(...xs), x2 = Math.max(...xs);
    const lane = [...new Set(xs.filter(x => Math.abs(x - x1) > 0.5 && Math.abs(x - x2) > 0.5))].sort((a, b) => a - b);
    if (lane.length < 2) return;                        // a straight band has no turn to place
    const key = `${Math.round(x1)}->${Math.round(x2)}`;
    if (!corridors.has(key)) corridors.set(key, []);
    corridors.get(key).push({ src: r.src, dst: r.dst, from: lane[0], to: lane[lane.length - 1] });
  });
  if (!corridors.size) fail('no right-angle ribbon actually turned, so the rule went untested');
  for (const [key, list] of corridors) {
    const first = list[0];
    list.forEach(r => {
      if (Math.abs(r.from - first.from) > 0.5 || Math.abs(r.to - first.to) > 0.5)
        fail(`in the corridor ${key}, "${first.src}->${first.dst}" turns at x ${first.from.toFixed(1)}..${first.to.toFixed(1)} `
           + `but "${r.src}->${r.dst}" turns at ${r.from.toFixed(1)}..${r.to.toFixed(1)} — their vertical runs are not `
           + `collinear, so the column reads as a staircase`);
    });
  }
}

// --- Rule 4: a chain carrying one value has a flat top ------------------------------------------------
//
// A node's incoming and outgoing stacks used to be centred on its bar independently, which lines up their
// CENTRES and not their tops. A node passing on a little less than it receives then started its outgoing
// stack a few pixels lower than its incoming one, and the top edge of a chain stepped down at every node.
{
  const { ribbons } = await render('ortho');
  const topOf = (src, dst) => {
    const r = ribbons.find(x => x.src === src && x.dst === dst);
    if (!r) fail(`no ribbon ${src} -> ${dst}`);
    return Number(/^M(-?[\d.]+),(-?[\d.]+)/.exec(r.d)[2]);
  };
  // grid -> inverter -> main_panel all carry within a whisker of each other's top edge.
  const chain = [['grid', 'inverter'], ['inverter', 'main_panel']].map(([a, b]) => topOf(a, b));
  if (Math.abs(chain[0] - chain[1]) > 0.5)
    fail(`the chain's top edge steps by ${Math.abs(chain[0] - chain[1]).toFixed(1)}px between `
       + `grid->inverter (y=${chain[0]}) and inverter->main_panel (y=${chain[1]}) — it should run flat`);
}

console.log('nocross: on a seven-circuit main panel beside a two-circuit sub-panel, every column keeps '
  + `${MIN_GAP}px between its bars and no two ribbons crossing the same gap swap order — in all three routings, and every right-angle ribbon in a corridor turns on the same vertical line, with the top edge of a chain running flat`);

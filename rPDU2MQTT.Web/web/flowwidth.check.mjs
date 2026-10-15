// The diagram lays out to the width of its pane.
//
// It was a fixed 960px. On a wide pane the columns finished in the left two-thirds and the rest of the
// canvas was empty. The zoom's ResizeObserver only ever shrinks — "wide panes are left alone" — and growing
// by zoom would scale the 11px labels with it, which is not more information.
//
// Laying out wider must spread the columns and nothing else: the bars keep their width, the labels keep
// their size, and the last column still has its gutter to be read in.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('flowwidth check FAILED: ' + m); process.exit(1); };

const N = (id, kind, value) => ({ id, label: id, kind, value, derivation: 'measured' });
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    N('grid', 'grid', 2270), N('inverter', 'inverter', 2270),
    N('main_panel', 'panel', 1750), N('sub_panel', 'panel', 143),
    N('livingroom', 'node', 573), N('pdu1', 'pdu', 303), N('kube05', 'outlet', 87),
  ],
  links: [
    { source: 'grid', target: 'inverter', value: 2270 },
    { source: 'inverter', target: 'main_panel', value: 1750 },
    { source: 'inverter', target: 'sub_panel', value: 143 },
    { source: 'main_panel', target: 'livingroom', value: 573 },
    { source: 'livingroom', target: 'pdu1', value: 303 },
    { source: 'pdu1', target: 'kube05', value: 87 },
  ],
};

/// Draw the Flow page in a pane `paneW` wide, and report where the columns landed.
async function drawIn(paneW) {
  const { sandbox, getEl } = makeDom({
    bodies: (url) => url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: false } }
      : url.includes('/api/flow/live') ? { ok: true, values: [] }
      : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
      : url.includes('/api/flow') ? graph
      : { ok: true },
  });
  // Every div reports the pane width, which is what a real layout would give the diagram's container.
  if (paneW != null) {
    const proto = Object.getPrototypeOf(sandbox.document.createElement('div'));
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return paneW; } });
  }
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 50));
  query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
  await new Promise(r => setTimeout(r, 300));
  const sec = query(getEl('sections'), '.section', true).find(x => query(x, '.flow-gestures', true).length > 0);
  if (!sec) fail('could not find the Flow section');
  const svg = query(sec, 'svg', true).find(s => (s.attrs || {}).viewBox);
  if (!svg) fail('no diagram was drawn');
  const bars = query(sec, 'rect', true).filter(r => r.attrs && r.attrs['data-node'])
    .map(r => ({ id: r.attrs['data-node'], x: +r.attrs.x, w: +r.attrs.width }));
  if (!bars.length) fail('the diagram drew no nodes');
  return {
    viewW: Number(String(svg.attrs.viewBox).split(/\s+/)[2]),
    right: Math.max(...bars.map(b => b.x + b.w)),
    barW: bars[0].w,
    cols: [...new Set(bars.map(b => Math.round(b.x)))].sort((a, b) => a - b),
  };
}

const narrow = await drawIn(1000);   // pane no wider than the old fixed layout
const wide = await drawIn(1600);     // a pane like the one this was reported on

// --- The layout follows the pane ----------------------------------------------------------------------
if (!(wide.viewW > narrow.viewW))
  fail(`a wider pane did not widen the diagram (${narrow.viewW} -> ${wide.viewW})`);
if (wide.viewW > 1600)
  fail(`the diagram is wider than its pane (${wide.viewW} in 1600)`);
// It has to actually use most of it, or the complaint stands.
if (wide.viewW < 1400)
  fail(`a 1600px pane produced only ${wide.viewW}px of diagram — the space is still going unused`);

// --- …by spreading the columns, not by inflating the parts ---------------------------------------------
if (wide.barW !== narrow.barW)
  fail(`the bars changed width with the pane (${narrow.barW} -> ${wide.barW}) — only the spacing should`);
if (wide.cols.length !== narrow.cols.length)
  fail(`the number of columns changed with the pane (${narrow.cols.length} -> ${wide.cols.length})`);
const spread = (c) => c[c.length - 1] - c[0];
if (!(spread(wide.cols) > spread(narrow.cols)))
  fail('the columns did not spread into the extra width');

// --- The last column keeps its gutter, or the labels run off the edge ----------------------------------
for (const r of [narrow, wide]) {
  const gutter = r.viewW - r.right;
  if (gutter < 200) fail(`only ${gutter}px left for the labels beside the last column`);
}

// --- A narrow pane is not stretched, and an unmeasurable one falls back --------------------------------
// A pane below the base layout is not squeezed to fit — the zoom already handles that, and squeezing the
// columns would put the labels back on top of each other.
const tiny = await drawIn(400);
if (tiny.viewW !== 960)
  fail(`a 400px pane produced a ${tiny.viewW}px layout — it should hold the 960 floor and scroll`);
const unmeasured = await drawIn(null);
if (unmeasured.viewW !== 960)
  fail(`without a measurable pane the diagram is ${unmeasured.viewW}px, not the 960 the other checks pin`);

console.log(`flowwidth: the diagram lays out to its pane (${narrow.viewW}px at 1000, ${wide.viewW}px at 1600) `
  + 'by spreading the columns rather than resizing the bars, keeps the label gutter, is not stretched in a '
  + 'pane narrower than its base, and falls back to 960 where the width cannot be measured');

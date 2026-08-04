// Gauges on the Energy tiles (#292), asserted on the real bundle's rendered output.
//
// A gauge claims proportion — "this much of what is possible" — so it is only as honest as the ceiling it is
// drawn against. Nothing here may invent one: a node with no Max shows its plain reading, because a needle
// with nothing behind it looks like information and isn't. A reading past the ceiling draws full and says so
// rather than running off the end or silently rescaling the maximum the operator set.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('gauge check FAILED: ' + m); process.exit(1); };
// HTML elements here carry className; only SVG goes through setAttribute. Read both.
// `||`, not `??`: HTML nodes carry className (default '') while SVG carries a class attribute, and `??`
// stops at the empty string instead of falling through — which made every SVG here look class-less.
const cn = (e) => String((e && (e.className || (e.attrs && e.attrs.class))) || '');

// solar has a ceiling and sits at half; grid has one and is over it; battery has none at all.
const cfg = {
  EnergyFlow: {
    Nodes: [
      { Id: 'solar', Kind: 'solar', Max: 9200 },
      { Id: 'grid', Kind: 'grid', Max: 5000 },
      { Id: 'battery', Kind: 'battery' },
    ],
    Links: [],
  },
};
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'solar', label: 'Solar', kind: 'solar', value: 4600 },
    { id: 'grid', label: 'Grid', kind: 'grid', value: 7000 },
    { id: 'battery', label: 'Battery', kind: 'battery', value: 1200 },
  ],
  links: [],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? cfg :
    url.includes('/api/flow/live') ? { ok: true, values: [] } :
    url.includes('/api/flow') ? graph :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));
const navLinks = query(getEl('nav'), 'a', true);
const link = navLinks.find(a => a.dataset.label === 'Energy');
if (!link) fail('no Energy tab; labels: ' + navLinks.map(a => a.dataset.label).join(' | '));
link.click();
await new Promise(r => setTimeout(r, 400));

const tiles = query(getEl('sections'), 'div', true).filter(d => cn(d).includes('energy-tile'));
if (!tiles.length) {
  const all = query(getEl('sections'), 'div', true);
  const cls = [...new Set(all.map(cn).filter(Boolean))];
  fail(`no energy tiles; ${all.length} divs, classes=[${cls.slice(0, 20).join(' | ')}]`);
}

const gaugeIn = (cls) => {
  const t = tiles.find(x => cn(x).includes(cls));
  if (!t) return null;
  return query(t, 'svg', true).filter(s => cn(s) === 'gauge');
};

// --- A node with a stated Max gets a dial.
const solar = gaugeIn('solar');
if (!solar) fail('no solar tile at all; tile classes: ' + tiles.map(cn).join(' | '));
if (solar.length !== 1) {
  const t = tiles.find(x => cn(x).includes('solar'));
  const wrap = query(t, 'div', true).find(d => cn(d) === 'gauge-wrap');
  const inner = (wrap && wrap.children || []).map(c => `${c.tag}:${cn(c)}`);
  fail(`solar has a Max but ${solar.length} gauge(s); gauge-wrap children: [${inner.join(' | ')}]`);
}

// --- A node with no Max gets none: the ceiling must never be inferred from the reading.
const batt = gaugeIn('battery');
if (batt && batt.length !== 0) fail('battery has no Max but a gauge was drawn — a ceiling was invented');

// --- Over the ceiling: still drawn, marked, and never past full.
const gridGauge = gaugeIn('grid');
if (!gridGauge || gridGauge.length !== 1) fail('grid has a Max but no gauge was drawn');
const over = query(gridGauge[0], 'path', true).filter(p => cn(p).includes('over'));
if (over.length !== 1) fail('a reading past its ceiling was not marked as over');

// The fill arc must never sweep further than the track.
for (const g of [...solar, ...gridGauge]) {
  const paths = query(g, 'path', true);
  const track = paths.find(p => cn(p).includes('gauge-track'));
  const fill = paths.find(p => cn(p).includes('gauge-fill'));
  if (!track || !fill) continue;
  const largeArc = (d) => Number(/A[\d.]+,[\d.]+ 0 ([01])/.exec(d)?.[1] ?? 0);
  if (largeArc(fill.attrs.d) > largeArc(track.attrs.d))
    fail('a fill arc sweeps further than its own track — the needle ran past full');
}

console.log('gauge: drawn only against a stated max, never invented, clamped and flagged when exceeded');

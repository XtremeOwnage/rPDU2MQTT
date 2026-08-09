// A node whose figure its own flows contradict has to be impossible to miss.
//
// The bug this exists for: an inverter carried a 129.9 kWh gap — more energy arriving than it accounted for
// by two orders of magnitude — and the only signal was a small "⚠" appended to a label printed in exactly
// the same weight as every honest number on the chart. The contradiction was computed, displayed, and
// ignored for a day. A node 3% out looked identical to one that could not possibly be right.
//
// So: past a quarter of throughput unaccounted for, the node is named above the chart. Below it, nothing
// changes — small gaps are rounding and sampling skew, and a banner that cries wolf gets scrolled past.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('contradiction check FAILED: ' + m); process.exit(1); };
const cn = (e) => String((e && (e.className || (e.attrs && e.attrs.class))) || '');

const cfg = { EnergyFlow: { Nodes: [], Links: [] } };

// `imbalance` is what the server reports as unaccounted for. inverter is the live case (a reading of 2.1
// with 129.9 passing through it); panel is 4% out, which is ordinary.
const graph = (inverterImbalance, metric = 'energytoday') => ({
  ok: true, metric, units: 'kWh',
  nodes: [
    { id: 'solar', label: 'Solar (PV)', kind: 'solar', value: 129.9, derivation: 'measured', imbalance: null },
    // 200 passes through the node, 127.8 of it unaccounted for, and its own sensor reads 2.1. The share is
    // of the throughput the server states. Reconstructed as reading + imbalance it would be 129.9, and the
    // same node would read as 98% instead of 64% — an arithmetic that was right only while a measured
    // node's imbalance meant "throughput - reading", and went on looking plausible after it stopped.
    { id: 'inverter', label: 'EG4 FlexBoss 21', kind: 'inverter', value: 2.1, derivation: 'measured',
      imbalance: inverterImbalance, throughput: 200 },
    { id: 'panel', label: 'Main Panel', kind: 'panel', value: 2.1, derivation: 'measured', imbalance: 0.09 },
  ],
  links: [
    { source: 'solar', target: 'inverter', value: 129.9 },
    { source: 'inverter', target: 'panel', value: 2.1 },
  ],
});

async function render(inverterImbalance, metric, withheld = []) {
  const { sandbox, getEl } = makeDom({
    bodies: (url) =>
      url.includes('/api/schema') ? schema :
      url.includes('/api/instances') ? { ok: true, instances: [] } :
      url.includes('/api/config') ? cfg :
      url.includes('/api/flow/live') ? { ok: true, values: [] } :
      url.includes('/api/flow/withheld') ? { ok: true, sources: withheld } :
      url.includes('/api/flow') ? graph(inverterImbalance, metric) :
      { ok: true },
  });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 50));
  const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow');
  if (!link) fail('no Flow tab');
  link.click();
  await new Promise(r => setTimeout(r, 400));
  return getEl('sections');
}

// --- The live case: 127.8 of a 129.9 throughput unaccounted for.
let sections = await render(127.8);
const banners = query(sections, 'div', true).filter(d => cn(d).includes('flow-contradiction'));
if (banners.length !== 1) fail(`expected one contradiction banner, got ${banners.length}`);
// The share is of the throughput the server states — 127.8 / 129.9 — not of a figure rebuilt from the
// reading. Rebuilt, the same node reads as 100% because 127.8 dwarfs its 2.1 reading.
if (!/64%/.test(banners[0].textContent))
  fail(`the share is not a share of the node's throughput: ${banners[0].textContent.slice(0, 160)}`);

const text = banners[0].textContent;
if (!text.includes('EG4 FlexBoss 21')) fail('the banner does not name the node it is about');
if (!/\bcontradicted\b/.test(text)) fail('the banner does not say the figure is contradicted');
// The share is the point — "something is off" is not actionable, "98% unaccounted" is.
if (!/\d+% unaccounted/.test(text)) fail('the banner does not quantify how much is unaccounted for');

// The node's own label is marked too, so following the banner to the chart lands somewhere obvious.
const marked = query(sections, 'text', true).filter(t => cn(t).includes('flow-contradicted'));
if (!marked.length) fail('the contradicted node is not marked on the chart itself');
if (!marked.some(t => t.textContent.includes('EG4 FlexBoss 21'))) fail('the wrong node is marked on the chart');

// The reading is still shown. Hiding a number the hardware actually gave would be its own kind of lying —
// the point is that it stops being presented as settled, not that it disappears.
if (!marked.some(t => t.textContent.includes('2.1'))) fail('the contradicted node stopped showing its reading');

// The node that is 4% out must NOT be named: a banner that fires on rounding gets scrolled past, and then
// it is worth nothing on the day it matters.
if (text.includes('Main Panel')) fail('an ordinary 4% gap was reported as a contradiction');

// --- The same graph with an ordinary gap: no banner at all.
sections = await render(0.12);   // 5% of a 2.22 throughput
const quiet = query(sections, 'div', true).filter(d => cn(d).includes('flow-contradiction'));
if (quiet.length) fail(`a ${'5%'} gap raised a contradiction banner — the threshold is not being applied`);

// --- Lifetime energy: the same enormous gap, and deliberately silent.
//
// Those counters started whenever each device or binding was first seen — a PDU's outlet totals have been
// running for years, an inverter's for weeks — so the two sides of a node describe different spans and a
// large gap is the expected result. Checked against the live system: a main panel read 96% "unaccounted"
// for exactly that reason. Banner-ing it would be the crying wolf this threshold exists to avoid, and the
// ⚠ tooltip already explains it and points at "Energy today".
sections = await render(129.9, 'energy');
const lifetime = query(sections, 'div', true).filter(d => cn(d).includes('flow-contradiction'));
if (lifetime.length) fail('a lifetime-energy gap raised a contradiction banner — those counters start at different times');

// --- A withheld source is announced, not silently absent.
//
// The bridge drops readings it can show to be wrong — a counter declared daily that never resets. Doing it
// silently leaves the node reading "no data", which is indistinguishable from a binding nobody configured,
// and sends the operator hunting for a fault in the wrong place entirely.
sections = await render(0.12, 'energytoday', [{
  node: 'solar',
  source: 'solar_assistant/total/pv_energy/state',
  metric: 'energytoday',
  reason: 'Configured as a daily (period) counter, but it did not reset when the day rolled over.',
}]);
const notices = query(sections, 'div', true).filter(d => cn(d).includes('flow-contradiction'));
if (!notices.length) fail('a withheld source was dropped without saying so anywhere on the page');
const notice = notices.map(n => n.textContent).join(' ');
if (!notice.includes('solar_assistant/total/pv_energy/state')) fail('the notice does not name the withheld binding');
if (!notice.includes('did not reset')) fail('the notice does not say why the binding is withheld');

// And nothing is announced when nothing is being withheld.
sections = await render(0.12, 'energytoday', []);
if (query(sections, 'div', true).filter(d => cn(d).includes('flow-contradiction')).length)
  fail('a notice appeared with nothing withheld and no contradiction');

console.log('contradiction: contradicted nodes are named above the chart and marked on it; withheld sources '
  + 'are announced with their reason; ordinary and lifetime-counter gaps stay quiet');

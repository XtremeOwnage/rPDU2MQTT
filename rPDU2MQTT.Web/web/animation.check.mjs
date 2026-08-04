// The flow animation's rules, asserted on the real bundle's rendered geometry (#292).
//
// Motion is a claim. A ribbon that moves says energy is moving through it, so anything the diagram does not
// actually know must stay still: an unknown link (no data) and a measured zero both draw as hairlines, and
// animating either would make "nothing" look busier than a real reading. Speed follows intensity — flow per
// unit of ribbon width — not raw value, or the widest ribbon would simply march fastest for being wide and
// say the same thing twice.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');

// grid carries the load; solar is a measured zero (night); battery's share is unknown.
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'grid', label: 'Grid', value: 2000 },
    { id: 'solar', label: 'Solar', value: 0 },
    { id: 'battery', label: 'Battery', value: null },
    { id: 'inverter', label: 'Inverter', value: 2000 },
    { id: 'panel', label: 'Main Panel', value: 2000 },
  ],
  links: [
    { source: 'grid', target: 'inverter', value: 2000 },
    { source: 'solar', target: 'inverter', value: 0 },
    { source: 'battery', target: 'inverter', value: 0, known: false },
    { source: 'inverter', target: 'panel', value: 2000 },
  ],
};

const fail = (m) => { console.error('animation check FAILED: ' + m); process.exit(1); };

async function render(animate) {
  const { sandbox, getEl } = makeDom({
    bodies: (url) =>
      url.includes('/api/schema') ? schema :
      url.includes('/api/instances') ? { ok: true, instances: [] } :
      url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] } } :
      url.includes('/api/flow') ? graph :
      { ok: true },
  });
  sandbox.localStorage.setItem('rpdu2mqtt.flow.animate', animate ? '1' : '0');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 50));
  const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow');
  if (!link) fail('no Flow tab');
  link.click();
  await new Promise(r => setTimeout(r, 60));
  return query(getEl('sections'), 'path', true).filter(p => (p.attrs.class || '') === 'flow-stream');
}

// --- Off by default: no streams at all.
const off = await render(false);
if (off.length !== 0) fail(`animation is off but ${off.length} stream(s) were drawn`);

// --- On: only the links that carry a known, non-zero value.
const on = await render(true);
if (on.length !== 2) fail(`expected 2 streams (grid->inverter, inverter->panel), got ${on.length}`);

const pairs = on.map(p => `${p.attrs['data-src']}->${p.attrs['data-dst']}`).sort();
const want = ['grid->inverter', 'inverter->panel'];
if (JSON.stringify(pairs) !== JSON.stringify(want)) fail(`streamed the wrong links: ${pairs.join(', ')}`);

// The two that must never move: a measured zero, and a link with no data.
if (pairs.some(p => p.startsWith('solar->'))) fail('a measured zero was animated — 0 W must not look busy');
if (pairs.some(p => p.startsWith('battery->'))) fail('an unknown link was animated — "no data" must not look busy');

// --- Every stream has a finite, sane duration.
for (const p of on) {
  const d = parseFloat((p.style && p.style.animationDuration) || '');
  if (!(d >= 0.9 && d <= 6)) fail(`stream duration ${d}s is outside the 0.9–6s clamp`);
}

console.log(`animation: ${on.length} streams on known flow, none on unknown or zero, durations clamped`);

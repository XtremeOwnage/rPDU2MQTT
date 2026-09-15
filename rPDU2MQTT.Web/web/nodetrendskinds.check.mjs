// Node Trends by kind: a chip per kind of node, a default that charts one kind rather than grid beside
// everything it feeds, and the kinds chosen remembered for next time.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('node trends kinds check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const dayEnd = (i) => new Date(Date.UTC(2026, 6, 31, 5) + i * 86_400_000).toISOString();
const S = (node, kind, k) => ({ node, label: node, kind, values: Array.from({ length: 8 }, (_, i) => 10 * k + i * k) });
const series = {
  ok: true, metric: 'energy', units: 'kWh', source: 'prometheus',
  days: Array.from({ length: 8 }, (_, i) => dayEnd(i).slice(0, 10)),
  at: Array.from({ length: 8 }, (_, i) => dayEnd(i)),
  series: [
    S('grid', 'grid', 9), S('main_panel', 'panel', 8), S('n30_1', 'breaker', 4), S('n30_2', 'breaker', 3),
    S('fridge', 'load', 2), S('office', 'load', 2), S('pdu1', 'pdu', 1),
  ],
};

async function open(carry) {
  const dom = makeDom({
    bodies: (url) =>
      url.includes('/api/flow/series') ? structuredClone(series)
      : url.includes('/api/flow/metrics') ? { ok: true, metrics: [{ metric: 'realpower', units: 'W', epoch: 'instant' }, { metric: 'energy', units: 'kWh', epoch: 'lifetime' }] }
      : url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: true } }
      : { ok: true },
  });
  if (carry) for (const [k, v] of carry) dom.storage.set(k, v);
  vm.createContext(dom.sandbox);
  vm.runInContext(code, dom.sandbox, { filename: 'app.js' });
  await wait(50);
  query(dom.getEl('nav'), 'a', true).find(a => a.dataset.label === 'Node Trends').click();
  await wait(300);
  const sec = query(dom.getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
  return { ...dom, sec };
}

const kindChips = (sec) => query(sec, 'button', true).filter(b => /^[●○] .+ \(\d+\)$/.test(b.textContent || ''));
const kindChip = (sec, name) => kindChips(sec).find(b => b.textContent.slice(2).startsWith(name + ' ('));
const charted = (sec) => query(sec, 'button', true)
  .filter(b => /^● /.test(b.textContent || '') && !/\(\d+\)$/.test(b.textContent)).map(b => b.textContent.slice(2)).sort();

let page = await open();

// A chip per kind on the page, with how many nodes it holds.
const names = kindChips(page.sec).map(b => b.textContent.slice(2));
for (const want of ['Grid (1)', 'Electrical panel (1)', 'Breaker / circuit (2)', 'PDU (1)', 'Load (2)'])
  if (!names.includes(want)) fail(`no "${want}" kind chip: ${names.join(', ')}`);

// It opens on the circuits alone — not grid beside everything grid feeds.
if (JSON.stringify(charted(page.sec)) !== JSON.stringify(['n30_1', 'n30_2']))
  fail(`the page does not open on one kind: ${charted(page.sec).join(', ')}`);

// Kinds combine: adding loads keeps the circuits.
kindChip(page.sec, 'Load').onclick();
await wait(60);
if (JSON.stringify(charted(page.sec)) !== JSON.stringify(['fridge', 'n30_1', 'n30_2', 'office']))
  fail(`adding a kind did not add to what was charted: ${charted(page.sec).join(', ')}`);

// …and a kind comes off as a whole.
kindChip(page.sec, 'Breaker / circuit').onclick();
await wait(60);
if (JSON.stringify(charted(page.sec)) !== JSON.stringify(['fridge', 'office']))
  fail(`taking a kind off did not take its nodes off: ${charted(page.sec).join(', ')}`);

// The kinds chosen are remembered: the page opens as it was left.
page = await open(page.storage);
if (JSON.stringify(charted(page.sec)) !== JSON.stringify(['fridge', 'office']))
  fail(`the page did not open on the kinds last chosen: ${charted(page.sec).join(', ')}`);

// Reset returns to the default, and forgets the choice.
query(page.sec, 'button', true).find(b => b.textContent === 'Reset').onclick();
await wait(60);
if (JSON.stringify(charted(page.sec)) !== JSON.stringify(['n30_1', 'n30_2']))
  fail(`Reset did not return to the default kind: ${charted(page.sec).join(', ')}`);
page = await open(page.storage);
if (JSON.stringify(charted(page.sec)) !== JSON.stringify(['n30_1', 'n30_2']))
  fail(`Reset did not forget the kinds chosen: ${charted(page.sec).join(', ')}`);

console.log('node trends kinds: a chip per kind with its count; opens on circuits alone rather than grid beside everything; '
  + 'kinds combine and come off whole; the choice is remembered, and Reset returns to the default and forgets it');
process.exit(0);

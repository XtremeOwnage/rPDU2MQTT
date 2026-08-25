// The landing page. It is the first thing anyone sees, so what it says has to be what was measured: a
// figure nothing reported is a dash, never a zero, and a component in trouble is not a small green dot.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('overview check FAILED: ' + m); process.exit(1); };

// Solar is producing, the grid is importing, the battery is bound but nothing reports its charge, and
// there is no reading at all for the load.
const power = { ok: true, units: 'W', nodes: [
  { id: 'solar', label: 'Solar', kind: 'solar', value: 4820 },
  { id: 'grid', label: 'Grid', kind: 'grid', value: 1310 },
  { id: 'battery', label: 'Battery', kind: 'battery', value: 0 },
] };
const energy = { ok: true, units: 'kWh', nodes: [
  { id: 'solar', label: 'Solar', kind: 'solar', value: 28.9 },
  { id: 'grid', label: 'Grid', kind: 'grid', value: 23 },
  { id: 'grid#in', label: 'Grid (export)', kind: 'grid', value: 4.2 },
  { id: 'battery', label: 'Battery', kind: 'battery', value: 0 },
] };
let board = { ok: true, cards: [
  { id: 'mqtt', level: 'good', title: 'MQTT', state: 'Connected', detail: '' },
  { id: 'prom', level: 'good', title: 'Prometheus', state: 'Scraped', detail: '' },
] };
let period = { ok: true, period: { tracked: true, carriedOver: 4, accumulatingSinceUtc: null, store: 'cache' } };
let live = { ok: true, values: [
  { node: 'battery', metric: 'soc', value: 74 },
  { node: 'battery', metric: 'voltage', value: 53.4 },
] };

// A day of readings behind the strips: solar rises and falls, the battery sits flat at zero.
const n = 96;
const day = { ok: true, units: 'W', stepSeconds: 900,
  at: Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - i) * 900e3).toISOString()),
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', values: Array.from({ length: n }, (_, i) => Math.max(0, Math.round(9600 * Math.sin(Math.PI * (i - 24) / 48)))) },
    { node: 'battery', label: 'Battery', kind: 'battery', values: Array.from({ length: n }, (_, i) => i === 10 ? null : 0) },
  ] };

const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/time')) return period;
    if (url.includes('/api/flow/live')) return live;
    if (url.includes('/api/status/board')) return board;
    if (url.includes('/api/flow/series')) return day;
    if (url.includes('/api/flow')) return url.includes('energytoday') ? energy : power;
    return url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: true } }
      : { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 400));

const links = query(getEl('nav'), 'a', true);
const labels = links.map(a => a.dataset.label);

// The first page is the one about the system, not the one about the bridge's own plumbing.
if (labels[0] !== 'Overview') fail(`the landing page is "${labels[0]}", not Overview`);
if (!labels.includes('Status')) fail('the status board is gone rather than moved');
if (labels.indexOf('Status') < labels.indexOf('Trends'))
  fail('the status board is still above the energy pages instead of down in System');

const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('no section is open');
const text = () => (sec.textContent || '');

// Home is the balance of what was measured: 4820 + 1310 = 6.1 kW.
if (!/6\.1 kW/.test(text())) fail(`the home figure is not the balance of the measured sources: ${text().slice(0, 300)}`);
// A battery reading of zero was measured, so it is a zero — not a dash.
if (!/0 W/.test(text())) fail('a measured zero is not shown');

// Today: 28.9 solar, 23 imported less 4.2 exported, so the house took 47.7 kWh.
if (!/28\.9 kWh/.test(text())) fail(`today's solar is missing: ${text().slice(0, 300)}`);
if (!/47\.7 kWh/.test(text())) fail(`the house's own use is not the balance of the day: ${text().slice(0, 400)}`);

// The battery: how full, in the place people look for it.
if (!/74%/.test(text())) fail('the battery percentage is not shown');

// Totals that carried over are the day's totals, and say so.
if (!/since the day rolled over/.test(text())) fail('a carried-over total does not say it covers the day');
if (query(sec, '.ov-alert', true).length) fail('a healthy carry-over is raising an alert');

// The pack's voltage, which is how a sagging battery is told from a full one — the percentage never says it.
if (!/53\.4 V/.test(text())) fail(`the battery voltage is not shown: ${text().slice(0, 300)}`);

// Each 24-hour strip is a tile in its own right: what it is now, and the peak behind it.
const strips = query(sec, 'div', true).filter(d => /ov-strip/.test(d.attrs?.class || d.className || ''));
// Solar and battery reported; the house is the balance of them. Grid has no node at all in this system,
// and a kind nothing reports is not a strip of zeros.
if (strips.length !== 3) fail(`expected strips for solar, battery and home, got ${strips.length}`);
if (strips.some(s => /Grid/.test(s.textContent))) fail('a kind with no nodes was charted as zeros');
const homeStrip = strips.find(s => /Home/.test(s.textContent));
if (!homeStrip) fail(`the house's own 24 hours is missing: ${strips.map(s => s.textContent.slice(0, 20)).join(' | ')}`);
// The battery missed one reading, so the balance is unknown for that step — 95 of 96, not 96 with a dip.
if (!/95 of 96 readings/.test(homeStrip.textContent))
  fail(`a step missing part of the balance was filled in rather than left out: ${homeStrip.textContent}`);
for (const s of strips) {
  if (!/peak/.test(s.textContent)) fail(`a strip does not say its peak: ${s.textContent.slice(0, 80)}`);
  if (!/readings/.test(s.textContent)) fail(`a strip does not say how much of the window it covers: ${s.textContent.slice(0, 80)}`);
}
// A strip must not borrow the layout class of the panel beside it: `ov-` + kind once collided with the
// battery card's own container, and the battery strip laid itself out sideways (#395).
const sideClass = (query(sec, 'div', true).find(d => /ov-batt-side/.test(d.attrs?.class || d.className || '')) || {});
if (!sideClass.attrs && !sideClass.className) fail('the battery panel lost its container');
for (const s of strips)
  if (/\bov-batt-side\b/.test(s.attrs?.class || s.className || '')) fail('a strip is wearing the battery panel’s layout class');

// Everything healthy is one line, not a wall of green cards.
if (query(sec, '.ov-alert', true).length) fail('a healthy system is raising alerts');
if (!/All 2 components healthy/.test(text())) fail(`a healthy system does not say so: ${text().slice(0, 200)}`);

// --- The totals did not carry over --------------------------------------------------------------------
// A restart with nothing in the store starts today's figures again. "0 kWh since the day rolled over" is
// then a claim about a day nobody measured — indistinguishable, on a tile, from a genuine zero.
period = { ok: true, period: { tracked: true, carriedOver: 0, accumulatingSinceUtc: '2026-08-24T19:40:00Z', store: 'file' } };
query(sec, 'button', true).find(b => b.textContent === 'Refresh').click();
await new Promise(r => setTimeout(r, 400));

if (/since the day rolled over/.test(text()))
  fail('the figures claim to cover the day after the totals restarted with the process');
if (!/did not carry over/.test(text())) fail(`the tiles do not say what they actually cover: ${text().slice(0, 400)}`);
const warned = query(sec, '.ov-note', true).find(a => /restarted with the process/.test(a.textContent));
if (!warned) fail('nothing says the totals restarted');
if (!/file inside the container/.test(warned.textContent))
  fail(`the warning does not say where the totals were kept: ${warned.textContent}`);

// --- Something is wrong -----------------------------------------------------------------------------
board = { ok: true, cards: [
  { id: 'mqtt', level: 'good', title: 'MQTT', state: 'Connected', detail: '' },
  { id: 'pdu', level: 'bad', title: 'Rack-PDU-2', state: 'Unreachable', detail: 'connection refused' },
  { id: 'emon', level: 'warn', title: 'EmonCMS', state: 'Stale', detail: 'no write for 20 minutes' },
] };
live = { ok: true, values: [] };
// …and the grid stops reporting entirely. A house whose supply is unknown has an unknown total.
power.nodes = power.nodes.map(n => n.id === 'grid' ? { ...n, value: null } : n);
query(sec, 'button', true).find(b => b.textContent === 'Refresh').click();
await new Promise(r => setTimeout(r, 400));

const alerts = query(sec, '.ov-alert', true);
if (alerts.length !== 2) fail(`expected the two unhealthy components to be raised, got ${alerts.length}`);
// The broken one comes first: a warning above an outage buries the outage.
if (!/Rack-PDU-2/.test(alerts[0].textContent)) fail(`the outage is not first: ${alerts[0].textContent}`);
if (!/connection refused/.test(alerts[0].textContent)) fail('the alert does not say what went wrong');
if (/All \d+ components healthy/.test(text())) fail('the page claims health while raising alerts');

// With no charge source reporting, the battery says so rather than showing a made-up percentage.
if (/74%/.test(text())) fail('a stale battery percentage is still on screen');
if (!/no charge source bound|—/.test(text())) fail('an unknown battery charge is not admitted');

// The home figure was the balance of solar, grid and battery. One of them is now unknown, so the balance
// is unknown — filling the gap with a zero would report the house drawing exactly what solar made, which
// is why the count matters: 4.8 kW belongs to solar alone.
if (/6\.1 kW/.test(text())) fail('the home figure survived the loss of the source it was computed from');
const solarFigures = (text().match(/4\.8 kW/g) || []).length;
if (solarFigures !== 1) fail(`solar's figure appears ${solarFigures} times — the home total is echoing it`);

console.log('overview: the landing page is what the system is doing; home is the balance of what was '
  + 'measured; a measured zero is a zero and an unmeasured figure is a dash; the battery says how full it '
  + 'is or why it cannot; health is one line until something is wrong, and then it is a card; and today\'s '
  + 'figures say so when they cover only part of the day');

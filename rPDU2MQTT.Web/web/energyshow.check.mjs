// The Energy board's Show toggle (#371): power now, or energy for the day so far.
//
// Two properties matter. A node's Max is a full-scale power figure, so no dial is drawn against a kWh
// reading. And the grid's day figure is the NET — import minus export, signed — because a magnitude reads
// the same for a day that imported 5 kWh and one that exported 5.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('energy-show check FAILED: ' + m); process.exit(1); };
const cn = (e) => String((e && (e.className || (e.attrs && e.attrs.class))) || '');

const cfg = { EnergyFlow: { Nodes: [{ Id: 'grid', Kind: 'grid', Max: 9000 }, { Id: 'solar', Kind: 'solar', Max: 9000 }], Links: [] } };

const power = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [{ id: 'solar', label: 'Solar', kind: 'solar', value: 4600 }, { id: 'grid', label: 'Grid', kind: 'grid', value: 1200 }],
  links: [],
};
// Exported more than imported today: out 2.0, in 7.5 -> net -5.5 kWh.
const today = {
  ok: true, metric: 'energytoday', units: 'kWh',
  nodes: [{ id: 'solar', label: 'Solar', kind: 'solar', value: 41.2 }, { id: 'grid', label: 'Grid', kind: 'grid', value: 2.0 }],
  links: [],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? cfg :
    url.includes('/api/flow/live') ? { ok: true, values: [{ node: 'grid', metric: 'energytoday#in', value: 7.5 }] } :
    url.includes('metric=energytoday') ? today :
    url.includes('/api/flow') ? power :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Energy').click();
await new Promise(r => setTimeout(r, 400));

const tiles = () => query(getEl('sections'), 'div', true).filter(d => cn(d).includes('energy-tile'));
const tileText = (label) => {
  const t = tiles().find(x => x.textContent.includes(label));
  if (!t) fail(`no ${label} tile`);
  return t;
};

// History is off in this config, so there is no moment to pick — a date control whose every answer would
// be "history is turned off" is worse than no control.
const histBar = query(getEl('sections'), 'div', true).filter(d => cn(d).includes('history-bar'));
if (!histBar.length) fail('the board never built a history control');
if (!histBar.every(b => cn(b).includes('is-hidden')))
  fail('the date picker is offered while the History feature is off');

// Power: dials are drawn against the stated Max.
if (!query(getEl('sections'), 'svg', true).some(g => cn(g).includes('gauge'))) fail('no gauge on the power view');

const show = query(getEl('sections'), 'select', true)
  .find(s => (s.children || []).some(o => (o.value || (o.attrs && o.attrs.value)) === 'energytoday'));
if (!show) fail('no Show selector offering energy today');
show.value = 'energytoday';
show.onchange({});
await new Promise(r => setTimeout(r, 400));

const solarTile = tileText('Solar');
if (!solarTile.textContent.includes('41.2')) fail(`the solar tile did not switch to the day's energy: ${solarTile.textContent}`);
if (!solarTile.textContent.includes('kWh')) fail('the energy tile does not carry its unit');

// No dial: a Max is a power ceiling and means nothing against kWh.
if (query(getEl('sections'), 'svg', true).some(g => cn(g).includes('gauge')))
  fail('a gauge was drawn against a power ceiling while showing energy');

// The grid figure is the signed net: 2.0 out - 7.5 in = -5.5.
const gridTile = tileText('Grid');
if (!/-5\.5/.test(gridTile.textContent)) fail(`the grid tile does not show the day's net: ${gridTile.textContent}`);

// Self-sufficiency covers the window the board is showing, and is a share of the very tiles above it.
// It used to be fetched separately as lifetime energy, so the bar described all time while the tiles
// described the day, and the two contradicted each other on one screen.
//
// Home = 41.2 solar + (2.0 imported - 7.5 exported) = 35.7 kWh, of which 2.0 came from the grid: 94%.
// (Grid import, not the net: a house that imports 10 and exports 10 has not covered its own load.)
const ss = query(getEl('sections'), 'div', true).find(d => cn(d).includes('energy-selfsuff'));
if (!ss) fail('no self-sufficiency figure on the energy view');
if (!ss.textContent.includes('94%')) fail(`self-sufficiency is not the day's: ${ss.textContent}`);
if (!/today/.test(ss.textContent) || /lifetime/.test(ss.textContent))
  fail(`self-sufficiency does not say it covers the day being shown: ${ss.textContent}`);

console.log('energy-show: the board switches between power and energy today; no dial against a power '
  + 'ceiling on kWh; the grid shows the signed net for the day; self-sufficiency covers that same day');

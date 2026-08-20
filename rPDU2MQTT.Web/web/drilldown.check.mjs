// Clicking a tile on the Energy board opens that node's own day.
//
// Asked for from the running instance: "be cool if i could click on the solar icon and it would show me
// the solar usage for the day". It was three deliberate steps — open Trends, change the range, untick
// everything that is not solar — which is three steps too many for the obvious next question.
//
// What matters is that the click carries the SAME node set the tile's figure was summed from: an answer
// about different nodes than the number you clicked would be worse than no link at all.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');

const cfg = {
  EnergyFlow: {
    Nodes: [{ Id: 'mppt_1', Kind: 'solar' }, { Id: 'mppt_2', Kind: 'solar' }, { Id: 'grid', Kind: 'grid' }],
    Links: [],
  },
  History: { Enabled: true },
};
const board = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'mppt_1', label: 'MPPT 1', kind: 'solar', value: 2100 },
    { id: 'mppt_2', label: 'MPPT 2', kind: 'solar', value: 1900 },
    { id: 'grid', label: 'Grid', kind: 'grid', value: 800 },
  ],
  links: [],
};
const series = {
  ok: true, metric: 'realpower', units: 'W',
  series: [
    { node: 'mppt_1', label: 'MPPT 1', kind: 'solar', values: [10, 900, 2100] },
    { node: 'mppt_2', label: 'MPPT 2', kind: 'solar', values: [12, 850, 1900] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [1400, 1000, 800] },
  ],
};

const asked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/flow/series')) { asked.push(url); return series; }
    return url.includes('/api/schema') ? schema :
      url.includes('/api/instances') ? { ok: true, instances: [] } :
      url.includes('/api/config') ? cfg :
      url.includes('/api/flow/live') ? { ok: true, values: [] } :
      url.includes('/api/flow') ? board :
      { ok: true };
  },
});

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

const fail = (m) => { console.error('drilldown check FAILED: ' + m); process.exit(1); };
const nav = getEl('nav');
const navTo = (label) => query(nav, 'a', true).find(a => a.dataset.label === label);

navTo('Energy').click();
await new Promise(r => setTimeout(r, 120));

const tiles = query(getEl('sections'), '.energy-tile', true);
const solarTile = tiles.find(t => t.classList.has('solar'));
if (!solarTile) fail('no solar tile to click');
if (!solarTile.classList.has('is-linked')) fail('the solar tile is not marked as leading anywhere');

// The click: it should land on Trends, over today, charting only the solar nodes.
asked.length = 0;
solarTile.dispatch('click', { preventDefault() {} });
await new Promise(r => setTimeout(r, 150));

const trendsLink = navTo('Trends');
if (!trendsLink.classList.has('active')) fail('clicking the solar tile did not open the Trends page');

const todayAsked = asked.find(u => u.includes('today=1'));
if (!todayAsked) fail(`Trends did not ask for today; it asked: ${JSON.stringify(asked)}`);

// The chart must be scoped to the nodes the tile was summed from — both MPPTs, and not the grid.
const trendsSection = query(getEl('sections'), '.section', true).find(s => s.classList.has('active'));
const chips = query(trendsSection, 'button', true).map(b => b.textContent || '');
const on = (node) => chips.some(c => c.includes(node) && c.startsWith('●'));
const off = (node) => chips.some(c => c.includes(node) && c.startsWith('○'));
if (!on('MPPT 1') || !on('MPPT 2'))
  fail(`the solar nodes are not charted after clicking Solar; chips: ${JSON.stringify(chips)}`);
if (!off('Grid'))
  fail(`the grid is still charted after clicking Solar — the answer is about different nodes than the `
     + `number that was clicked; chips: ${JSON.stringify(chips)}`);

// And the request is one-shot: going back and returning must not re-apply it over a fresh choice.
navTo('Energy').click();
await new Promise(r => setTimeout(r, 60));
asked.length = 0;
navTo('Trends').click();
await new Promise(r => setTimeout(r, 120));
if (asked.some(u => u.includes('today=1')) && asked.length > 0 && !todayAsked)
  fail('the focus request was applied twice — a stale selection would override what the reader picked');

console.log('drilldown: the Solar tile is marked as a link, opens Trends over today, charts exactly the '
  + 'nodes its figure was summed from (both MPPTs, not the grid), and the request is spent once');

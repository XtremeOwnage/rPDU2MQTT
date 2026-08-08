// The Trends page: daily energy over time.
//
// The property worth pinning is what happens to a day the backend has nothing for. Drawing it as a
// zero-height bar states that nothing was used that day; leaving it out of the axis silently shortens the
// month. It is an empty slot, counted, and left out of the totals — and the totals say how many days they
// actually cover, because a total over 5 of 7 days is not a week.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('trends check FAILED: ' + m); process.exit(1); };

// Seven days; the backend has nothing at all for two of them, and solar alone is missing on a third.
const series = {
  ok: true, metric: 'energytoday', units: 'kWh', source: 'prometheus',
  days: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'],
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', values: [30, 32, null, null, 28, null, 35] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [5, 4, null, null, 9, 6, 3] },
  ],
};

const asked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/flow/series')) { asked.push(url); return series; }
    return url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: true } }
      : { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Trends');
if (!link) fail('no Trends page');
link.click();
await new Promise(r => setTimeout(r, 300));

const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('clicking Trends activated no section');
if (!asked.length) fail('the page charted nothing — no series was requested');
if (!/days=30/.test(asked[0])) fail(`the default range was not requested: ${asked[0]}`);

// The chart exists and is drawn from the values, not from a placeholder.
const bars = query(sec, 'rect', true);
if (!bars.length) fail('no bars were drawn');

// Two days have no reading from anything. They are slots on the axis, marked, not bars of zero.
const gapBars = bars.filter(r => (r.attrs.opacity || '') !== '' && Number(r.attrs.opacity) < 1);
if (gapBars.length !== 2) fail(`expected 2 empty days, drew ${gapBars.length}`);
for (const g of gapBars) {
  const t = query(g, 'title');
  if (!t || !/no reading/.test(t.textContent)) fail('an empty day does not say why it is empty');
}

// And it is said in words too, not only in the drawing.
const status = query(sec, 'span', true).map(s => s.textContent).join(' ');
if (!/2 with no reading/.test(status)) fail(`the missing days are not counted: ${status.slice(0, 200)}`);

// The totals cover the days that reported, and say how many that was: solar has 4 of 7 (30+32+28+35=125),
// grid 5 of 7. A total presented as a week when it covers four days is how a gap becomes a saving.
const rows = query(sec, 'tr', true);
const solarRow = rows.find(r => r.textContent.includes('Solar'));
if (!solarRow) fail('no totals row for solar');
if (!solarRow.textContent.includes('125')) fail(`solar's total is not the sum of the days it had: ${solarRow.textContent}`);
if (!/4 of 7/.test(solarRow.textContent)) fail(`solar's total does not say how many days it covers: ${solarRow.textContent}`);
const gridRow = rows.find(r => r.textContent.includes('Grid'));
if (!/5 of 7/.test(gridRow.textContent)) fail(`grid's day count is wrong: ${gridRow.textContent}`);

// Its peak day is named, so "when did this happen" does not need a spreadsheet.
if (!solarRow.textContent.includes('2026-08-07')) fail(`solar's peak day is not named: ${solarRow.textContent}`);

// A node can be taken off the chart — a hierarchy counts the same watts at several tiers, so charting
// everything at once and stacking would draw a total that is true of nothing.
const gridChip = query(sec, 'button', true).find(b => b.textContent.includes('Grid'));
if (!gridChip) fail('no way to take a node off the chart');
const before = query(sec, 'rect', true).length;
gridChip.click();
await new Promise(r => setTimeout(r, 50));
if (query(sec, 'rect', true).length >= before) fail('taking a node off the chart changed nothing');
if (query(sec, 'tr', true).some(r => r.textContent.includes('Grid') && r.textContent.includes('of 7')))
  fail('a node taken off the chart is still in the totals');

console.log('trends: daily bars over the chosen range; days with no reading are empty slots, counted, and '
  + 'left out of totals that say how many days they cover');

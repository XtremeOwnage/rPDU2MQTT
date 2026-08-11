// The Trends page: daily energy over time. A day the backend has nothing for is an empty slot, counted and
// left out of the totals, and the totals say how many days they actually cover.
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
  // The last one has not ended: it is today so far, and must not be read as a finished day.
  partial: '2026-08-07',
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', tags: ['roof'], values: [30, 32, null, null, 28, null, 35] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [5, 4, null, null, 9, 6, 3] },
    // The return lanes, which the exporter now publishes: charge and export are measurements, and they are
    // the other direction — the chart has to subtract them, not add them.
    { node: 'battery', label: 'Battery', kind: 'battery', values: [8, 9, null, null, 7, 2, 6] },
    { node: 'battery#in', label: 'Battery (charging)', kind: 'battery', values: [10, 11, null, null, 9, 3, 8] },
    { node: 'grid#in', label: 'Grid (export)', kind: 'grid', values: [1, 2, null, null, 4, 0, 1] },
  ],
};

// The same window asked about within a day: power every 5 minutes, not a daily total. A cumulative daily
// counter charted through the day only ever climbs, so this is a different metric, not a finer one.
// Instants, not labels: a moment within a day is named in the viewer's clock, and the server does not know
// it. Formatting them server-side stamped every intra-day tick with the container's timezone — UTC unless
// someone set TZ — so a chart ending at this minute read as ending hours ago.
const at = ['2026-08-08T18:00:00Z', '2026-08-08T18:05:00Z', '2026-08-08T18:10:00Z', '2026-08-08T18:15:00Z'];
const power = {
  ok: true, metric: 'realpower', units: 'W', source: 'prometheus', stepSeconds: 300,
  at,
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', tags: ['roof'], values: [4200, 4400, null, 3900] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [0, 0, null, 120] },
  ],
};

const asked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/flow/series')) {
      asked.push(url);
      return (url.includes('minutes=') || url.includes('today=1')) ? power : series;
    }
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
if (!/stepSeconds|days=/.test(asked[0])) fail('the range was not expressed in the query');

// The charts are found by their headings — several are drawn from one fetch, and each is a different
// question about the same days.
const charts = query(sec, 'svg', true);
if (charts.length < 2) fail(`expected several charts, drew ${charts.length}`);
const headings = query(sec, 'h3', true).map(h => h.textContent);
for (const want of ['Daily energy by node', 'Grid per day', 'Self-sufficiency per day'])
  if (!headings.includes(want)) fail(`no "${want}" chart (got: ${headings.join(', ')})`);

const byNode = charts[0];
const bars = query(byNode, 'rect', true);
if (!bars.length) fail('no bars were drawn');

// Two days have no reading from anything. They are slots on the axis, marked, not bars of zero.
const gapBars = bars.filter(r => (r.attrs.class || '') === 'trend-gap');
if (gapBars.length !== 2) fail(`expected 2 empty days, drew ${gapBars.length}`);
for (const g of gapBars) {
  const t = query(g, 'title');
  if (!t || !/no reading/.test(t.textContent)) fail('an empty day does not say why it is empty');
}

// Hovering a day says what you are looking at. Hovering the bar itself is a game of skill — a stacked
// segment can be a pixel tall — so the whole day column is the target.
const hits = query(byNode, 'rect', true).filter(r => (r.attrs.class || '') === 'trend-hit');
if (hits.length !== series.days.length) fail(`expected one hover target per day, found ${hits.length}`);
const dayFive = hits.find(h => h.attrs['data-day'] === '2026-08-05');
dayFive.dispatch('mouseenter', { clientX: 100, clientY: 100 });
const cardEl = query(sandbox.document.body, '.trend-card');
if (!cardEl || !cardEl.classList.contains('show')) fail('hovering a day showed nothing');
const cardText = cardEl.textContent;
for (const want of ['2026-08-05', 'Solar', '28', 'Grid', '9'])
  if (!cardText.includes(want)) fail(`the hover card does not say what is being looked at: "${cardText}"`);
// Stacked, so the day's total belongs on the card — and it nets: 28 solar + 9 import + 7 discharge
// - 9 charge - 4 export = 31. Unsigned it would read 57, the same energy counted on the way in and out.
if (!cardText.includes('31')) fail(`the hover card omits or miscounts the day's total: "${cardText}"`);

// A day nothing reported says so rather than showing a row of zeroes.
hits.find(h => h.attrs['data-day'] === '2026-08-03').dispatch('mouseenter', { clientX: 10, clientY: 10 });
if (!/no reading/.test(query(sandbox.document.body, '.trend-card').textContent))
  fail('hovering an empty day does not say it is empty');

// Self-sufficiency is a percentage of the home's energy, and only for days that have both figures. On
// 2026-08-05 the home is what it actually took: 28 solar + (7 discharge - 9 charge) + (9 import - 4
// export) = 31. Of that, 9 came from the grid — the import, not the net, because exporting 4 did not
// avoid drawing anything: (31-9)/31 = 70.97%.
const ssChart = charts[headings.indexOf('Self-sufficiency per day')];
const ssHits = query(ssChart, 'rect', true).filter(r => (r.attrs.class || '') === 'trend-hit');
ssHits.find(h => h.attrs['data-day'] === '2026-08-05').dispatch('mouseenter', { clientX: 10, clientY: 10 });
const ssText = query(sandbox.document.body, '.trend-card').textContent;
if (!ssText.includes('70.97')) fail(`self-sufficiency for the day is wrong: "${ssText}"`);

// A day with no grid figure has no percentage: 2026-08-06 has grid but no solar, so the home cannot be
// determined and estimating one would put a number nobody measured on a chart.
ssHits.find(h => h.attrs['data-day'] === '2026-08-06').dispatch('mouseenter', { clientX: 10, clientY: 10 });
const ssGap = query(sandbox.document.body, '.trend-card').textContent;
if (!/no reading|—/.test(ssGap)) fail(`a day missing an input was given a percentage anyway: "${ssGap}"`);

// Tags select what to chart: one click charts exactly the nodes carrying that tag.
const tagChip = query(sec, 'button', true).find(b => b.textContent.includes('roof'));
if (!tagChip) fail('no tag chips to select by');
tagChip.click();
await new Promise(r => setTimeout(r, 50));
if (query(sec, 'tr', true).some(r => r.textContent.includes('Grid') && r.textContent.includes('of 7')))
  fail('selecting a tag left untagged nodes on the chart');
if (!query(sec, 'tr', true).some(r => r.textContent.includes('Solar')))
  fail('selecting a tag took its own node off the chart');
const allChip = query(sec, 'button', true).find(b => b.textContent === 'All');
allChip.click();
await new Promise(r => setTimeout(r, 50));

// Charge and export are the other direction, so they are drawn below the line and subtract. Counted as
// supply they inflate the day: the same energy shows up once as produced and again as given back.
const supplyChart = charts[headings.indexOf('Where the day’s energy came from')];
const supplyHits = query(supplyChart, 'rect', true).filter(r => (r.attrs.class || '') === 'trend-hit');
supplyHits.find(h => h.attrs['data-day'] === '2026-08-05').dispatch('mouseenter', { clientX: 5, clientY: 5 });
const supplyText = query(sandbox.document.body, '.trend-card').textContent;
if (!/-9|−9/.test(supplyText)) fail(`battery charge is not shown as negative: "${supplyText}"`);
if (!/-4|−4/.test(supplyText)) fail(`grid export is not shown as negative: "${supplyText}"`);
// 28 solar + 7 discharge + 9 import - 9 charge - 4 export = 31, not the 57 an unsigned stack would total.
if (!supplyText.includes('31')) fail(`the day's energy does not net out: "${supplyText}"`);

// The zero line is where the two sides meet, so a bar's side of it is the sign.
const zeroLines = query(supplyChart, 'line', true).filter(l => l.attrs.stroke === 'var(--muted)');
if (!zeroLines.length) fail('no zero line on a chart that draws both signs');

// The period still in progress is a real reading of an unfinished day. Drawn beside finished ones at full
// strength it reads as a quiet day rather than an early one, and averaged in with them it drags the mean
// down by however early you happen to be looking.
const todayHit = hits.find(h => h.attrs['data-day'] === '2026-08-07');
todayHit.dispatch('mouseenter', { clientX: 5, clientY: 5 });
const todayText = query(sandbox.document.body, '.trend-card').textContent;
if (!/so far|in progress/.test(todayText)) fail(`the unfinished day is not marked: "${todayText}"`);
const faded = query(byNode, 'rect', true).filter(r => r.attrs.opacity === '0.55');
if (!faded.length) fail('the unfinished day is drawn exactly like a finished one');

// And it is said in words too, not only in the drawing.
const status = query(sec, 'span', true).map(s => s.textContent).join(' ');
if (!/2 with no reading/.test(status)) fail(`the missing days are not counted: ${status.slice(0, 200)}`);

// The totals cover the days that reported, and say how many that was: solar has 4 of 7 (30+32+28+35=125),
// grid 5 of 7. A total presented as a week when it covers four days is how a gap becomes a saving.
const rows = query(sec, 'tr', true);
const solarRow = rows.find(r => r.textContent.includes('Solar'));
if (!solarRow) fail('no totals row for solar');
if (!solarRow.textContent.includes('90')) fail(`solar's total is not the sum of its finished days: ${solarRow.textContent}`);
if (/125/.test(solarRow.textContent)) fail(`the day still in progress was counted in the total: ${solarRow.textContent}`);
if (!/3 of 6/.test(solarRow.textContent)) fail(`solar's total does not say how many finished days it covers: ${solarRow.textContent}`);
const gridRow = rows.find(r => r.textContent.includes('Grid'));
if (!/4 of 6/.test(gridRow.textContent)) fail(`grid's day count is wrong: ${gridRow.textContent}`);

// Its peak day is named, so "when did this happen" does not need a spreadsheet.
if (!solarRow.textContent.includes('2026-08-02')) fail(`solar's peak day is not named: ${solarRow.textContent}`);

// The node selection governs the by-node chart and the totals — and nothing else. Emptying it used to hide
// every chart, which said the selection drove them all, while they went on summing every node regardless.
const noneBtn = query(sec, 'button', true).find(b => b.textContent === 'None');
if (!noneBtn) fail('no way to clear the node selection');
noneBtn.click();
await new Promise(r => setTimeout(r, 50));
const emptyHeads = query(sec, 'h3', true).map(h => h.textContent);
for (const want of ['Grid per day', 'Self-sufficiency per day'])
  if (!emptyHeads.includes(want)) fail(`clearing the node selection hid "${want}", which is not about the selection`);
if (query(sec, 'tr', true).some(r => r.textContent.includes('of 7')))
  fail('the totals still list nodes after the selection was cleared');
if (!sec.textContent.includes('No nodes selected')) fail('nothing says the by-node chart is empty on purpose');

// Reset puts back what the page opened with, rather than leaving you to tick nodes one at a time.
const resetBtn = query(sec, 'button', true).find(b => b.textContent === 'Reset');
if (!resetBtn) fail('no way to reset the node selection');
resetBtn.click();
await new Promise(r => setTimeout(r, 50));
const backRows = query(sec, 'tr', true).map(r => r.textContent).join(' ');
if (!backRows.includes('Solar') || !backRows.includes('Grid')) fail(`Reset did not restore the default selection: ${backRows}`);

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

// "Today so far" starts where the counters last re-based — the configured boundary, not a fixed 24 hours
// and not the browser's midnight. A chart of today anchored anywhere else covers a different day from the
// totals beside it.
const todayOpt = query(sec, 'select', true)
  .find(x => (x.children || []).some(o => (o.value || '').includes('today=1')));
if (!todayOpt) fail('no "today so far" range offered');
todayOpt.value = 'today=1&step=300';
todayOpt.onchange({});
await new Promise(r => setTimeout(r, 300));
if (!/today=1/.test(decodeURIComponent(asked.at(-1)))) fail(`"today" was not asked for as the period: ${asked.at(-1)}`);
// It is a moment-in-the-day view, so it charts power like the other intra-day ranges.
if (!query(sec, 'h3', true).map(h => h.textContent).includes('Power by node'))
  fail('"today so far" is not charted as power');

// --- Within a day: power, sampled, and no self-sufficiency ------------------------------------------
const rangeSel = query(sec, 'select', true).find(x => (x.children || []).some(o => (o.value || '').includes('minutes=')));
if (!rangeSel) fail('no intra-day range offered');
rangeSel.value = 'minutes=360&step=300';
rangeSel.onchange({});
await new Promise(r => setTimeout(r, 300));

const intra = decodeURIComponent(asked.at(-1));
if (!/minutes=360/.test(intra) || !/step=300/.test(intra)) fail(`the intra-day window was not requested: ${intra}`);

const intraHeads = query(sec, 'h3', true).map(h => h.textContent);
if (!intraHeads.includes('Power by node')) fail(`the intra-day view is not labelled as power: ${intraHeads.join(', ')}`);
// Self-sufficiency is a share of energy over a period. The same arithmetic on instantaneous power is a
// different quantity, and giving it the same name invites reading a momentary grid draw as a bad day.
if (intraHeads.includes('Self-sufficiency per day'))
  fail('self-sufficiency was drawn from instantaneous power');

// A total of power samples is a number in watts that is a quantity of nothing, so the column is the peak —
// and the quantity people actually want, kWh, is integrated from the samples instead.
const intraRows = query(sec, 'th', true).map(h => h.textContent);
if (!intraRows.some(h => /Peak \(W\)/.test(h))) fail(`power samples are being totalled: ${intraRows.join(', ')}`);
if (!intraRows.some(h => /Samples with data/.test(h))) fail(`the intra-day table still counts days: ${intraRows.join(', ')}`);
if (!intraRows.some(h => /Energy \(kWh/.test(h))) fail(`no energy column on the power view: ${intraRows.join(', ')}`);

// Solar: 4200 + 4400 + 3900 = 12,500 W of samples, each holding for a 300s step —
// 12500 * 300 / 3,600,000 = 1.042 kWh. The missing sample contributes nothing rather than being filled in.
const solarIntra = query(sec, 'tr', true).find(r => r.textContent.includes('Solar'));
if (!solarIntra.textContent.includes('1.042')) fail(`the energy estimate is wrong: ${solarIntra.textContent}`);

// The axis is the clock — this browser's clock, whatever the server's is.
const local = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const intraCard = query(sec, 'rect', true).filter(r => (r.attrs.class || '') === 'trend-hit');
const want = local(at[1]);
const hit = intraCard.find(h => h.attrs['data-day'] === want);
if (!hit) fail(`the axis is not in this browser's clock: expected "${want}", got ${intraCard.map(h => h.attrs['data-day']).join(', ')}`);
hit.dispatch('mouseenter', { clientX: 5, clientY: 5 });
const intraText = query(sandbox.document.body, '.trend-card').textContent;
if (!intraText.includes(want) || !intraText.includes('4,400')) fail(`the intra-day hover is wrong: "${intraText}"`);

// …and so are the labels under it. Charting a day key drops its year, and doing that to a clock label left
// the axis reading "AM" — the one part of the chart that says which hours it covers (#378).
const axisText = query(sec, 'text', true).map(t => t.textContent);
if (!axisText.includes(local(at[0]))) fail(`the axis is not labelled with the clock: ${axisText.join(', ')}`);

// Columns sort. Twelve nodes over ninety days is a table you read by scanning for the biggest number.
// Every node back on first: a one-row table is sorted whatever the code does, which is no test at all.
query(sec, 'button', true).find(b => b.textContent === 'All').click();
await new Promise(r => setTimeout(r, 50));
if (query(sec, 'tbody tr', true).length < 2) fail('the sort test needs more than one row to mean anything');
const heads = query(sec, 'th', true);
const nameHead = heads.find(h => h.textContent.startsWith('Node'));
nameHead.onclick();
await new Promise(r => setTimeout(r, 50));
const order = () => query(sec, 'tbody tr', true).map(r => query(r, 'td')?.textContent);
const byName = order();
if (byName.join() !== [...byName].sort().join()) fail(`sorting by node did not order the rows: ${byName.join(', ')}`);
nameHead.onclick();
await new Promise(r => setTimeout(r, 50));
if (order().join() !== [...byName].reverse().join()) fail('clicking the same column again did not reverse it');

// Yesterday is the period before the one in progress, on the same boundary — the server knows where that
// boundary is, so the page asks for a period back rather than subtracting 24 hours itself (#378).
const yesterdaySel = query(sec, 'select', true).find(x => (x.children || []).some(o => (o.value || '').includes('back=1')));
if (!yesterdaySel) fail('no "yesterday" range offered');
yesterdaySel.value = 'today=1&back=1&step=300';
yesterdaySel.onchange({});
await new Promise(r => setTimeout(r, 300));
const askedYesterday = decodeURIComponent(asked.at(-1));
if (!/today=1/.test(askedYesterday) || !/back=1/.test(askedYesterday))
  fail(`yesterday was not asked for as the previous period: ${askedYesterday}`);

console.log('trends: several charts over the chosen range; hovering a day says what is on it; tags select '
  + 'what to chart; days with no reading are empty slots, counted, and left out of totals that say how '
  + 'many days they cover; within a day it charts power on a clock axis and integrates kWh; yesterday is '
  + 'the period before this one; the table sorts');

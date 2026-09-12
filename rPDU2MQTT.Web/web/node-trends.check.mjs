// Node Trends: each node's own series over the chosen window. A day the backend has nothing for is an empty
// slot, counted and left out of the totals, and the totals say how many days they actually cover.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('node trends check FAILED: ' + m); process.exit(1); };

// Day-end readings of the energy counter: one before the window, then seven days. Nothing read at the end of
// the third day, which empties the third and fourth, since each day is the rise from the reading before it.
const series = {
  ok: true, metric: 'energy', units: 'kWh', source: 'prometheus',
  days: ['2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'],
  partial: '2026-08-07',
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', tags: ['roof'], values: [100, 130, 162, null, 200, 228, 262, 297] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [50, 55, 59, null, 70, 79, 85, 88] },
    { node: 'battery', label: 'Battery', kind: 'battery', values: [20, 28, 37, null, 50, 57, 59, 65] },
    { node: 'battery#in', label: 'Battery (charging)', kind: 'battery', values: [30, 40, 51, null, 60, 69, 72, 80] },
    { node: 'grid#in', label: 'Grid (export)', kind: 'grid', values: [5, 6, 8, null, 10, 14, 14, 15] },
  ],
};

// Power every 5 minutes, named in the viewer's clock rather than the server's.
const at = ['2026-08-08T18:00:00Z', '2026-08-08T18:05:00Z', '2026-08-08T18:10:00Z', '2026-08-08T18:15:00Z'];
const power = {
  ok: true, metric: 'realpower', units: 'W', source: 'prometheus', stepSeconds: 300,
  at,
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', tags: ['roof'], values: [4200, 4400, null, 3900] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [0, 0, null, 120] },
  ],
};

// A whole day of five-minute samples — 288 of them, which is what "yesterday" returns.
const dayStart = new Date(2026, 7, 19, 0, 0, 0);
const wholeDay = {
  ok: true, metric: 'realpower', units: 'W', source: 'prometheus', stepSeconds: 300,
  at: Array.from({ length: 288 }, (_, i) => new Date(dayStart.getTime() + i * 300_000).toISOString()),
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', values: Array.from({ length: 288 },
        (_, i) => Math.max(0, Math.round(5000 * Math.sin(Math.PI * (i - 84) / 120))) ) },
    { node: 'grid', label: 'Grid', kind: 'grid', values: Array.from({ length: 288 }, () => 400) },
  ],
};

// A cumulative counter, which climbs and must never be summed.
const counter = {
  ok: true, metric: 'energy_d', units: 'kWh', source: 'prometheus', stepSeconds: 300,
  at,
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', values: [10, 12, 14, 16] },
    // This one's counter re-based partway through the window.
    { node: 'grid', label: 'Grid', kind: 'grid', values: [8, 9, 1, 3] },
  ],
};

const asked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/flow/series')) {
      asked.push(url);
      if (url.includes('back=1')) return structuredClone(wholeDay);
      if (/metric=energy(_d)?(&|$)/.test(url) && url.includes('minutes=')) return structuredClone(counter);
      if (url.includes('minutes=') || url.includes('today=1') || url.includes('step=')) return structuredClone(power);
      return structuredClone(series);
    }
    if (url.includes('/api/flow/metrics'))
      return { ok: true, metrics: [
        { metric: 'realpower', units: 'W', epoch: 'instant' },
        { metric: 'energy', units: 'kWh', epoch: 'lifetime' },
        { metric: 'energy_d', units: 'kWh', epoch: 'period' }] };
    return url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: true } }
      : { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Node Trends');
if (!link) fail('no Node Trends page');
asked.length = 0;
link.click();
await new Promise(r => setTimeout(r, 300));

const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('clicking Node Trends activated no section');
if (!asked.length) fail('the page charted nothing — no series was requested');
// Thirty days of the energy counter: one more day-end is asked for, so the first day has a reading before it.
if (!/days=31/.test(asked[0]) || !/metric=energy(&|$)/.test(asked[0])) fail(`the default range was not requested as the energy counter: ${asked[0]}`);
// Across days, auto means one total per day, so no step is sent.
if (/step=/.test(asked[0])) fail(`a per-day window was sampled instead of totalled: ${asked[0]}`);

const charts = query(sec, 'svg', true);
const headings = query(sec, 'h3', true).map(h => h.textContent);
if (!headings.includes('Daily energy by node')) fail(`no "Daily energy by node" chart (got: ${headings.join(', ')})`);
// The whole-system charts are the Trends page's, not this one's.
for (const other of ['Grid per day', 'Self-sufficiency per day'])
  if (headings.includes(other)) fail(`"${other}" is drawn on the per-node page`);

const byNode = charts[0];
const totalsRow = (name) => query(sec, 'tbody tr', true).find(r => query(r, 'td')?.textContent === name);
const bars = query(byNode, 'rect', true);
if (!bars.length) fail('no bars were drawn');

// Two days have no reading from anything. They are slots on the axis, marked, not bars of zero.
const gapBars = bars.filter(r => (r.attrs.class || '') === 'trend-gap');
if (gapBars.length !== 2) fail(`expected 2 empty days, drew ${gapBars.length}`);
for (const g of gapBars) {
  const t = query(g, 'title');
  if (!t || !/no reading/.test(t.textContent)) fail('an empty day does not say why it is empty');
}

const hits = query(byNode, 'rect', true).filter(r => (r.attrs.class || '') === 'trend-hit');
if (hits.length !== series.days.length - 1) fail(`expected one hover target per day, found ${hits.length}`);
hits.find(h => h.attrs['data-day'] === '2026-08-05').dispatch('mouseenter', { clientX: 100, clientY: 100 });
const cardEl = query(sandbox.document.body, '.trend-card');
if (!cardEl || !cardEl.classList.contains('show')) fail('hovering a day showed nothing');
const cardText = cardEl.textContent;
for (const want of ['2026-08-05', 'Solar', '28', 'Grid', '9'])
  if (!cardText.includes(want)) fail(`the hover card does not say what is being looked at: "${cardText}"`);
// Stacked and signed: 28 + 9 + 7 - 9 - 4 = 31.
if (!cardText.includes('31')) fail(`the hover card omits or miscounts the day's total: "${cardText}"`);

hits.find(h => h.attrs['data-day'] === '2026-08-03').dispatch('mouseenter', { clientX: 10, clientY: 10 });
if (!/no reading/.test(query(sandbox.document.body, '.trend-card').textContent))
  fail('hovering an empty day does not say it is empty');

// Tags select what to chart: one click charts exactly the nodes carrying that tag.
const tagChip = query(sec, 'button', true).find(b => b.textContent.includes('roof'));
if (!tagChip) fail('no tag chips to select by');
tagChip.click();
await new Promise(r => setTimeout(r, 50));
if (totalsRow('Grid')) fail('selecting a tag left untagged nodes on the chart');
if (!query(sec, 'tr', true).some(r => r.textContent.includes('Solar'))) fail('selecting a tag took its own node off the chart');
query(sec, 'button', true).find(b => b.textContent === 'All').click();
await new Promise(r => setTimeout(r, 50));

// The period in progress is faded and said in words.
const todayHit = query(query(sec, 'svg', true)[0], 'rect', true).find(h => (h.attrs.class || '') === 'trend-hit' && h.attrs['data-day'] === '2026-08-07');
todayHit.dispatch('mouseenter', { clientX: 5, clientY: 5 });
if (!/so far|in progress/.test(query(sandbox.document.body, '.trend-card').textContent)) fail('the unfinished day is not marked');
if (!query(query(sec, 'svg', true)[0], 'rect', true).some(r => r.attrs.opacity === '0.55')) fail('the unfinished day is drawn exactly like a finished one');

const status = query(sec, 'span', true).map(s => s.textContent).join(' ');
if (!/2 with no reading/.test(status)) fail(`the missing days are not counted: ${status.slice(0, 200)}`);

// Totals cover the days that reported, today included, and say how many: solar 5 of 7 (159), grid 5 of 7.
const rows = query(sec, 'tr', true);
const solarRow = rows.find(r => r.textContent.includes('Solar'));
if (!solarRow) fail('no totals row for solar');
if (!solarRow.textContent.includes('159')) fail(`the day still in progress is missing from the total: ${solarRow.textContent}`);
if (!/5 of 7/.test(solarRow.textContent)) fail(`solar's total does not say how many days it covers: ${solarRow.textContent}`);
if (!/5 of 7/.test(rows.find(r => r.textContent.includes('Grid')).textContent)) fail('grid\'s day count is wrong');
if (!/counts in the totals/.test(sec.textContent)) fail('nothing says the unfinished day is in the totals');
if (!solarRow.textContent.includes('2026-08-07') || !/so far/.test(solarRow.textContent)) fail(`solar's peak day is not named as unfinished: ${solarRow.textContent}`);

// Clearing the selection empties the chart and the totals, and says so.
query(sec, 'button', true).find(b => b.textContent === 'None').click();
await new Promise(r => setTimeout(r, 50));
if (query(sec, 'tbody tr', true).length) fail('the totals still list nodes after the selection was cleared');
if (!sec.textContent.includes('No nodes selected')) fail('nothing says the by-node chart is empty on purpose');

query(sec, 'button', true).find(b => b.textContent === 'Reset').click();
await new Promise(r => setTimeout(r, 50));
const backRows = query(sec, 'tr', true).map(r => r.textContent).join(' ');
if (!backRows.includes('Solar') || !backRows.includes('Grid')) fail(`Reset did not restore the default selection: ${backRows}`);

const gridChip = query(sec, 'button', true).find(b => b.textContent.includes('Grid'));
const before = query(sec, 'rect', true).length;
gridChip.click();
await new Promise(r => setTimeout(r, 50));
if (query(sec, 'rect', true).length >= before) fail('taking a node off the chart changed nothing');
if (totalsRow('Grid')) fail('a node taken off the chart is still in the totals');

// "Today so far" is asked for as the period, sampled at a step fitted to the chart, and charted as power.
const rangeSelect = () => query(sec, 'select', true).find(x => (x.children || []).some(o => (o.value || '').includes('minutes=')));
const rangeSel = rangeSelect();
if (!rangeSel) fail('no range control');
rangeSel.value = 'today=1';
rangeSel.onchange({});
await new Promise(r => setTimeout(r, 300));
if (!/today=1/.test(decodeURIComponent(asked.at(-1)))) fail(`"today" was not asked for as the period: ${asked.at(-1)}`);
if (!/step=\d+/.test(asked.at(-1))) fail(`"today" was not sampled at any step: ${asked.at(-1)}`);
if (!query(sec, 'h3', true).map(h => h.textContent).includes('Power by node')) fail('"today so far" is not charted as power');

// --- Within a day: power, sampled ---------------------------------------------------------------------
rangeSel.value = 'minutes=360';
rangeSel.onchange({});
await new Promise(r => setTimeout(r, 300));
const intra = decodeURIComponent(asked.at(-1));
// Six hours fitted to a 1200px chart at 6px a bar is 189 bars, so the step snaps up to 5 minutes.
if (!/minutes=360/.test(intra) || !/step=300/.test(intra)) fail(`the intra-day window was not fitted to the chart: ${intra}`);

const intraHeads = query(sec, 'th', true).map(h => h.textContent);
if (!intraHeads.some(h => /Peak \(W\)/.test(h))) fail(`power samples are being totalled: ${intraHeads.join(', ')}`);
if (!intraHeads.some(h => /Samples with data/.test(h))) fail(`the intra-day table still counts days: ${intraHeads.join(', ')}`);
if (!intraHeads.some(h => /Energy \(kWh/.test(h))) fail(`no energy column on the power view: ${intraHeads.join(', ')}`);
// 4200 + 4400 + 3900 W, each held for 300s: 1.042 kWh.
if (!query(sec, 'tr', true).find(r => r.textContent.includes('Solar')).textContent.includes('1.042')) fail('the energy estimate is wrong');

const local = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const intraHits = query(sec, 'rect', true).filter(r => (r.attrs.class || '') === 'trend-hit');
const hit = intraHits.find(h => h.attrs['data-day'] === local(at[1]));
if (!hit) fail(`the axis is not in this browser's clock: expected "${local(at[1])}"`);
hit.dispatch('mouseenter', { clientX: 5, clientY: 5 });
if (!query(sandbox.document.body, '.trend-card').textContent.includes('4,400')) fail('the intra-day hover is wrong');
if (!query(sec, 'text', true).map(t => t.textContent).includes(local(at[0]))) fail('the axis is not labelled with the clock');

// Columns sort, with more than one row so the order means something.
query(sec, 'button', true).find(b => b.textContent === 'All').click();
await new Promise(r => setTimeout(r, 50));
if (query(sec, 'tbody tr', true).length < 2) fail('the sort test needs more than one row to mean anything');
const nameHead = query(sec, 'th', true).find(h => h.textContent.startsWith('Node'));
nameHead.onclick();
await new Promise(r => setTimeout(r, 50));
const order = () => query(sec, 'tbody tr', true).map(r => query(r, 'td')?.textContent);
const byName = order();
if (byName.join() !== [...byName].sort().join()) fail(`sorting by node did not order the rows: ${byName.join(', ')}`);
query(sec, 'th', true).find(h => h.textContent.startsWith('Node')).onclick();
await new Promise(r => setTimeout(r, 50));
if (order().join() !== [...byName].reverse().join()) fail('clicking the same column again did not reverse it');

// Yesterday is the period before this one; a whole day fits on screen and opens at its start.
rangeSel.value = 'today=1&back=1';
rangeSel.onchange({});
await new Promise(r => setTimeout(r, 300));
if (!/back=1/.test(decodeURIComponent(asked.at(-1)))) fail(`yesterday was not asked for as the previous period: ${asked.at(-1)}`);
const dayChart = query(sec, 'svg', true).find(x => (x.attrs.class || '') === 'trend-chart');
if (!(Number(dayChart.attrs.width) > 0 && Number(dayChart.attrs.width) <= 1200)) fail(`a day of samples was drawn ${dayChart.attrs.width}px wide`);
const axis = query(dayChart, 'text', true).filter(t => t.attrs['text-anchor'] === 'middle').map(t => t.textContent).filter(Boolean);
if (axis.length < 8) fail(`a day of samples carries ${axis.length} axis label(s)`);
if (axis[0] !== local(wholeDay.at[0])) fail(`the axis does not start at the window's start: ${axis[0]}`);
if (query(sec, 'div', true).some(d => 'scrollLeft' in d)) fail('a finished day was opened scrolled to its right-hand end');
const dayStatus = query(sec, 'span', true).map(x => x.textContent).join(' ');
if (!/Aug 19/.test(dayStatus) || !/→/.test(dayStatus)) fail(`the status line does not say what window is charted: ${dayStatus}`);

// --- What the page says it is showing is what it is showing -------------------------------------------
const blurb = () => (query(sec, '.desc', true).map(d => d.textContent)[0] || '');
if (!/power/i.test(blurb())) fail(`the page describes a chart of watts as: ${blurb().slice(0, 120)}`);

rangeSel.value = 'minutes=360';
rangeSel.onchange({});
await new Promise(r => setTimeout(r, 300));
const metricSel = query(sec, 'select', true).find(x => (x.children || []).some(o => o.value === 'realpower'));
if (!metricSel) fail('no way to choose what is charted');
// Power and energy are the choices; energy since the period began is not offered.
const offered = (metricSel.children || []).map(o => o.value);
if (offered.join() !== 'realpower,energy') fail(`the metric choices are not power and energy: ${offered.join(', ')}`);
metricSel.value = 'energy';
metricSel.onchange({});
await new Promise(r => setTimeout(r, 300));
if (!/metric=energy(&|$)/.test(decodeURIComponent(asked.at(-1)))) fail(`the chosen metric was not asked for: ${asked.at(-1)}`);

// A counter's readings are differenced: 2 + 2 + 2 = 6 over three intervals; a re-base is a gap, not negative.
const solarCells = query(query(sec, 'tr', true).find(r => r.textContent.includes('Solar')), 'td', true).map(t => t.textContent);
if (solarCells.includes('52') || solarCells.includes('16')) fail(`the counter itself was charted or summed: ${solarCells.join(' | ')}`);
if (!solarCells.includes('6') || !solarCells.some(c => /3 of 4/.test(c))) fail(`the intervals do not add up: ${solarCells.join(' | ')}`);
const gridCells = query(query(sec, 'tr', true).find(r => r.textContent.includes('Grid')), 'td', true).map(t => t.textContent);
if (gridCells.some(c => /-/.test(c))) fail(`a counter re-base was charted as negative energy: ${gridCells.join(' | ')}`);
if (!gridCells.includes('3') || !gridCells.some(c => /2 of 4/.test(c))) fail(`the intervals either side of the re-base are wrong: ${gridCells.join(' | ')}`);
if (!/changed between two readings/.test(blurb())) fail(`the page does not say it charted differences: ${blurb().slice(0, 160)}`);
if (query(sec, 'th', true).some(h => /kWh, est/.test(h.textContent))) fail('energy readings were integrated as if they were watts');


// --- Search: a filter over the node chips --------------------------------------------------------------
const search = query(sec, 'input', true).find(i => i.type === 'search');
if (!search) fail('no node filter');
search.value = 'sol';
search.oninput();
const nodeChips = () => query(sec, 'button', true).map(b => b.textContent || '').filter(t => /^[●○] /.test(t));
if (!nodeChips().some(t => t.includes('Solar'))) fail(`filtering by "sol" hid Solar: ${nodeChips().join(' | ')}`);
if (nodeChips().some(t => t.includes('Grid'))) fail(`filtering by "sol" still lists Grid: ${nodeChips().join(' | ')}`);
search.value = '';
search.oninput();
if (!nodeChips().some(t => t.includes('Grid'))) fail('clearing the filter did not bring the other nodes back');

// --- Overlay: another series drawn as a line over the chart --------------------------------------------
const overlaySel = query(sec, 'select', true).find(x => (x.children || []).some(o => o.textContent === 'nothing'));
if (!overlaySel) fail('no overlay control');
if (overlaySel.value !== '') fail('the overlay does not default to nothing');
if (query(query(sec, 'svg', true)[0], 'polyline', true).concat(query(query(sec, 'svg', true)[0], 'circle', true))
  .some(e => e.attrs.class === 'trend-overlay')) fail('an overlay was drawn before one was chosen');
overlaySel.value = 'grid';
overlaySel.onchange({});
await new Promise(r => setTimeout(r, 50));
const lead = query(sec, 'svg', true)[0];
if (!query(lead, 'polyline', true).concat(query(lead, 'circle', true)).some(e => e.attrs.class === 'trend-overlay')) fail('choosing an overlay drew no line');
if (!sec.textContent.includes('Grid (overlay)')) fail('the overlay is not named in the legend');
overlaySel.value = '';
overlaySel.onchange({});
await new Promise(r => setTimeout(r, 50));

// --- Interval: chosen, and widened only when the chart cannot draw it ---------------------------------
const intervalSel = query(sec, 'select', true).find(x => (x.children || []).some(o => o.value === 'day'));
if (!intervalSel) fail('no interval control');
const perDayOpt = (intervalSel.children || []).find(o => o.value === 'day');
if (!perDayOpt.disabled) fail('"per day" is offered within a day');

rangeSel.value = 'days=7';
rangeSel.onchange({});
await new Promise(r => setTimeout(r, 300));
if (perDayOpt.disabled) fail('"per day" is not offered across days');
intervalSel.value = '3600';
intervalSel.onchange({});
await new Promise(r => setTimeout(r, 300));
// Seven days at an hour is 168 bars, which a 1200px chart can draw.
if (!/days=7/.test(asked.at(-1)) || !/step=3600/.test(asked.at(-1))) fail(`seven days at an hour was not asked for: ${asked.at(-1)}`);

rangeSel.value = 'days=90';
rangeSel.onchange({});
await new Promise(r => setTimeout(r, 300));
// Ninety days at an hour is 2160 bars; fitted to 189 it snaps up to 12 hours, and the page says so.
if (!/days=90/.test(asked.at(-1)) || !/step=43200/.test(asked.at(-1))) fail(`ninety days at an hour was not widened to fit: ${asked.at(-1)}`);
if (!/widened from 1 hour to 12 hours/.test(query(sec, 'span', true).map(x => x.textContent).join(' ')))
  fail('the page does not say the interval was widened');

console.log('node trends: per-node chart over the chosen range with empty days marked and counted; tags, a text filter '
  + 'and chips select what is charted; totals cover the days that reported; power within a day on a clock axis '
  + 'with kWh integrated; counters differenced; an overlay line on request; the interval is chosen, and widened '
  + 'only when the chart cannot draw it, saying so');

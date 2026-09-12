// Trends: the whole system over the chosen window — the grid, self-sufficiency, and where the energy came from.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('trends check FAILED: ' + m); process.exit(1); };

// Day-end readings of the energy counter: one before the window, then seven days. Nothing read at the end of
// the third day, which empties the third and fourth, since each day is the rise from the reading before it.
const series = {
  ok: true, metric: 'energy', units: 'kWh', source: 'prometheus',
  days: ['2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'],
  partial: '2026-08-07',
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', values: [100, 130, 162, null, 200, 228, 262, 297] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [50, 55, 59, null, 70, 79, 85, 88] },
    { node: 'battery', label: 'Battery', kind: 'battery', values: [20, 28, 37, null, 50, 57, 59, 65] },
    { node: 'battery#in', label: 'Battery (charging)', kind: 'battery', values: [30, 40, 51, null, 60, 69, 72, 80] },
    { node: 'grid#in', label: 'Grid (export)', kind: 'grid', values: [5, 6, 8, null, 10, 14, 14, 15] },
  ],
};

const power = {
  ok: true, metric: 'realpower', units: 'W', source: 'prometheus', stepSeconds: 300,
  at: ['2026-08-08T18:00:00Z', '2026-08-08T18:05:00Z', '2026-08-08T18:10:00Z', '2026-08-08T18:15:00Z'],
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', values: [4200, 4400, null, 3900] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [0, 0, null, 120] },
  ],
};

const asked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/flow/series')) {
      asked.push(url);
      return (url.includes('minutes=') || url.includes('today=1') || url.includes('step=')) ? structuredClone(power) : structuredClone(series);
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

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Trends');
if (!link) fail('no Trends page');
asked.length = 0;
link.click();
await new Promise(r => setTimeout(r, 300));

const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('clicking Trends activated no section');
if (!asked.length || !/days=31/.test(asked[0]) || !/metric=energy(&|$)/.test(asked[0])) fail(`the default range was not requested as the energy counter: ${asked[0]}`);

const charts = query(sec, 'svg', true);
const headings = query(sec, 'h3', true).map(h => h.textContent);
for (const want of ['Grid per day', 'Self-sufficiency per day', 'Where the day’s energy came from'])
  if (!headings.includes(want)) fail(`no "${want}" chart (got: ${headings.join(', ')})`);

// Nothing here is about a selection: the per-node chart, its picker and its totals are the Node Trends page.
if (headings.some(h => /by node/.test(h))) fail(`a per-node chart is drawn on the whole-system page: ${headings.join(', ')}`);
const buttons = query(sec, 'button', true).map(b => b.textContent);
if (buttons.includes('None') || buttons.includes('Reset')) fail('the whole-system page offers a node selection');
if (query(sec, 'tbody tr', true).length) fail('the whole-system page lists per-node totals');

// Self-sufficiency on 2026-08-05: home 28 + (7 - 9) + (9 - 4) = 31, of which 9 was imported: 70.97%.
const ssChart = charts[headings.indexOf('Self-sufficiency per day')];
const ssHits = query(ssChart, 'rect', true).filter(r => (r.attrs.class || '') === 'trend-hit');
ssHits.find(h => h.attrs['data-day'] === '2026-08-05').dispatch('mouseenter', { clientX: 10, clientY: 10 });
if (!query(sandbox.document.body, '.trend-card').textContent.includes('70.97')) fail('self-sufficiency for the day is wrong');
// 2026-08-03 has no reading from anything, so no percentage is given.
ssHits.find(h => h.attrs['data-day'] === '2026-08-03').dispatch('mouseenter', { clientX: 10, clientY: 10 });
if (!/no reading|—/.test(query(sandbox.document.body, '.trend-card').textContent)) fail('a day missing an input was given a percentage anyway');

// Charge and export are below the line and subtract: 28 + 7 + 9 - 9 - 4 = 31.
const supplyChart = charts[headings.indexOf('Where the day’s energy came from')];
query(supplyChart, 'rect', true).filter(r => (r.attrs.class || '') === 'trend-hit')
  .find(h => h.attrs['data-day'] === '2026-08-05').dispatch('mouseenter', { clientX: 5, clientY: 5 });
const supplyText = query(sandbox.document.body, '.trend-card').textContent;
if (!/-9|−9/.test(supplyText) || !/-4|−4/.test(supplyText)) fail(`charge and export are not negative: "${supplyText}"`);
if (!supplyText.includes('31')) fail(`the day's energy does not net out: "${supplyText}"`);
if (!query(supplyChart, 'line', true).some(l => l.attrs.stroke === 'var(--muted)')) fail('no zero line on a chart that draws both signs');

// Days nothing at all reported are counted.
if (!/2 with no reading/.test(query(sec, 'span', true).map(s => s.textContent).join(' '))) fail('the missing days are not counted');

// The interval applies here too: seven days at an hour.
const rangeSel = query(sec, 'select', true).find(x => (x.children || []).some(o => (o.value || '').includes('minutes=')));
const intervalSel = query(sec, 'select', true).find(x => (x.children || []).some(o => o.value === 'day'));
if (!intervalSel) fail('no interval control on the whole-system page');
rangeSel.value = 'days=7';
rangeSel.onchange({});
await new Promise(r => setTimeout(r, 300));
intervalSel.value = '3600';
intervalSel.onchange({});
await new Promise(r => setTimeout(r, 300));
if (!/days=7/.test(asked.at(-1)) || !/step=3600/.test(asked.at(-1))) fail(`seven days at an hour was not asked for: ${asked.at(-1)}`);

// Self-sufficiency is a share of energy; instantaneous power is a different quantity and is not charted as one.
intervalSel.value = 'auto';
rangeSel.value = 'minutes=360';
rangeSel.onchange({});
await new Promise(r => setTimeout(r, 300));
const intraHeads = query(sec, 'h3', true).map(h => h.textContent);
if (!intraHeads.includes('Grid')) fail(`the grid is not charted within a day: ${intraHeads.join(', ')}`);
if (intraHeads.some(h => /Self-sufficiency/.test(h))) fail('self-sufficiency was drawn from instantaneous power');

// The chart type applies here too. Stacking is not a choice on this page: import and export, supply and
// return have to net against each other.
const chartSel = query(sec, 'select', true).find(x => (x.children || []).some(o => o.value === 'line'));
if (!chartSel) fail('no chart type control on the whole-system page');
if (query(sec, 'input', true).some(i => i.type === 'checkbox')) fail('the whole-system page offers unstacking');
chartSel.value = 'line';
chartSel.onchange({});
await new Promise(r => setTimeout(r, 50));
const gridSvg = query(sec, 'svg', true)[query(sec, 'h3', true).map(h => h.textContent).indexOf('Grid')];
if (!['polyline', 'circle'].flatMap(t => query(gridSvg, t, true)).some(e => e.attrs.class === 'trend-line')) fail('choosing lines drew no line on the grid chart');

console.log('trends: the whole system over the chosen window — grid, self-sufficiency and where the energy came from, '
  + 'signed and netted, with no per-node selection on the page; empty days counted; the interval applies here too');

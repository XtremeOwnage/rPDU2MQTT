// Cost (#515): energy on the Trends pages priced at the per-kWh rate from the GUI settings.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('cost check FAILED: ' + m); process.exit(1); };

// Day-end readings of the energy counter: one before the window, then three days.
const series = {
  ok: true, metric: 'energy', units: 'kWh', source: 'prometheus',
  days: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'],
  series: [
    { node: 'solar', label: 'Solar', kind: 'solar', balance: 'solar', values: [100, 110, 125, 130] },
    { node: 'grid', label: 'Grid', kind: 'grid', balance: 'grid', values: [50, 60, 62, 70] },
  ],
};

const open = async (gui) => {
  const asked = [];
  const { sandbox, getEl } = makeDom({
    bodies: (url) => {
      if (url.includes('/api/flow/series')) { asked.push(url); return structuredClone(series); }
      if (url.includes('/api/flow/metrics'))
        return { ok: true, metrics: [
          { metric: 'realpower', units: 'W', epoch: 'instant' },
          { metric: 'energy', units: 'kWh', epoch: 'lifetime' }] };
      return url.includes('/api/schema') ? schema
        : url.includes('/api/instances') ? { ok: true, instances: [] }
        : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: true }, Gui: gui }
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
  const metricSel = query(sec, 'select', true).find(x => (x.children || []).some(o => o.value === 'energy'));
  if (!metricSel) fail('no metric control');
  return { sec, metricSel, asked };
};

// No price set: cost is not offered.
{
  const { metricSel } = await open({});
  if (metricSel.children.some(o => o.value === 'cost')) fail('cost is offered with no price set');
}

// A price set: cost is offered in the currency, read as the energy counter, and every figure is priced.
{
  const { sec, metricSel, asked } = await open({ EnergyPrice: 0.25, Currency: '€' });
  const opt = metricSel.children.find(o => o.value === 'cost');
  if (!opt) fail('cost is not offered with a price set');
  if (opt.textContent !== 'cost (€)') fail(`cost is not labelled with the currency: ${opt.textContent}`);
  metricSel.value = 'cost';
  metricSel.onchange({});
  await new Promise(r => setTimeout(r, 300));
  if (!/metric=energy(&|$)/.test(asked.at(-1))) fail(`cost was not read as the energy counter: ${asked.at(-1)}`);
  const table = query(sec, '.trend-table');
  if (!table) fail('no table for cost');
  const heads = query(query(table, 'thead'), 'th', true).map(h => h.textContent);
  if (!heads.includes('Solar (€)')) fail(`the table is not in the currency: ${heads.join(' | ')}`);
  const row = query(query(table, 'tbody'), 'tr', true).find(r => r.dataset.day === '2026-08-03');
  const cells = query(row, 'td', true).map(td => td.textContent);
  // Solar rose 15 kWh and the grid 2: 3.75 and 0.5 at 0.25 a kWh.
  if (!cells.includes('3.75') || !cells.includes('0.5')) fail(`the day is not priced: ${cells.join('|')}`);
}

// The Flow view: Cost, read as the energy it prices and drawn in the currency.
{
  const graph = {
    ok: true, metric: 'energy_d', units: 'kWh',
    nodes: [{ id: 'grid', label: 'Grid', kind: 'grid', value: 10, derivation: 'measured' },
            { id: 'dryer', label: 'Dryer', kind: 'load', value: 4, derivation: 'measured' },
            { id: 'rack', label: 'Rack', kind: 'load', value: 6, derivation: 'measured' }],
    links: [{ source: 'grid', target: 'dryer', value: 4 }, { source: 'grid', target: 'rack', value: 6 }],
  };
  const openFlow = async (gui) => {
    const asked = [];
    const { sandbox, getEl } = makeDom({
      bodies: (url) => {
        if (url.includes('/api/flow')) { asked.push(url); return structuredClone(graph); }
        return url.includes('/api/schema') ? schema
          : url.includes('/api/instances') ? { ok: true, instances: [] }
          : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, Gui: gui }
          : { ok: true };
      },
    });
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'app.js' });
    await new Promise(r => setTimeout(r, 50));
    const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow');
    if (!link) fail('no Flow page');
    link.click();
    await new Promise(r => setTimeout(r, 100));
    const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
    const metricSel = query(sec, 'select', true).find(x => (x.children || []).some(o => o.value === 'energy_d'));
    if (!metricSel) fail('no metric control on Flow');
    return { sec, metricSel, asked };
  };

  const plain = await openFlow({});
  if (plain.metricSel.children.some(o => o.value === 'cost_d' || o.value === 'cost')) fail('Flow offers cost with no price set');

  const { sec, metricSel, asked } = await openFlow({ EnergyPrice: 0.5, Currency: '€' });
  const labels = metricSel.children.map(o => o.textContent);
  if (!labels.includes('Cost (€)')) fail(`Flow does not offer cost: ${labels.join(' | ')}`);
  if (metricSel.children.some(o => o.value === 'energy' || o.value === 'cost')) fail(`Flow still offers lifetime: ${labels.join(' | ')}`);
  metricSel.value = 'cost_d';
  metricSel.onchange({});
  await new Promise(r => setTimeout(r, 100));
  const flowAsk = asked.filter(u => /\/api\/flow(\?|$)/.test(u)).at(-1) || '';
  if (!/metric=energy_d(&|$)/.test(flowAsk)) fail(`Cost was not read as the daily energy: ${flowAsk}`);
  // The rack's 6 kWh at 0.5 a kWh.
  const text = query(sec, 'text', true).map(t => t.textContent).join(' ') + ' '
    + query(sec, 'title', true).map(t => t.textContent).join(' ');
  if (!text.includes('€3.00')) fail(`the rack is not drawn as cost: ${text.slice(0, 400)}`);
  if (/kWh/.test(text)) fail('a cost diagram still reads kWh');
}

console.log('cost: offered on Trends and Flow only once a price per kWh is set, labelled with the currency, read as the energy it prices and drawn to the cent');

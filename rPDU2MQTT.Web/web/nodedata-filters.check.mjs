// Node Data (#495): pick the metrics shown and filter by tag, both remembered; columns sort.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('node data filters check FAILED: ' + m); process.exit(1); };

const config = {
  EnergyFlow: { Nodes: [
    { Id: 'b1', Label: 'Breaker 1', Tags: ['n30', 'panel'], Mqtt: [
      { Topic: 'b1/power', Metric: 'realpower' }, { Topic: 'b1/current', Metric: 'current' }] },
    { Id: 'b2', Label: 'Breaker 2', Tags: ['n30'], Mqtt: [
      { Topic: 'b2/power', Metric: 'realpower' }, { Topic: 'b2/current', Metric: 'current' }] },
    { Id: 'inv', Label: 'Inverter', Mqtt: [
      { Topic: 'inv/power', Metric: 'realpower' }, { Topic: 'inv/voltage', Metric: 'voltage' }] },
  ], Links: [] },
};

const run = async (storage) => {
  const { sandbox, getEl } = makeDom({
    bodies: (url, opts) => {
      if (url.includes('/api/flow/live')) {
        const q = JSON.parse(opts?.body || '[]');
        return { ok: true, values: q.map(x => ({ node: x.Node, metric: x.Metric, value: 5, reported: 5,
          atUtc: new Date().toISOString(), ageSeconds: 1, fresh: true, staleAfterSeconds: 60 })) };
      }
      return url.includes('/api/schema') ? schema
        : url.includes('/api/instances') ? { ok: true, instances: [] }
        : url.includes('/api/config') ? config
        : { ok: true };
    },
  });
  if (storage) storage.forEach(([k, v]) => sandbox.localStorage.setItem(k, v));
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 50));
  query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Node Data').click();
  await new Promise(r => setTimeout(r, 30));
  const sec = query(getEl('sections'), '.section', true).find(x => x.classList.contains('active'));
  if (!sec) fail('Node Data did not open');
  return { sandbox, sec };
};

const rowsOf = (sec) => query(sec, 'tbody tr', true).map(tr => query(tr, 'td', true).slice(0, 2).map(td => td.textContent).join(' / '));
const chip = (sec, name) => query(sec, 'button', true).find(b => b.textContent.endsWith(' ' + name));

let { sandbox, sec } = await run();
if (rowsOf(sec).length !== 6) fail(`expected every reading by default, got ${rowsOf(sec).length}`);
for (const m of ['Power', 'Current', 'Voltage']) if (!chip(sec, m)) fail(`no chip for ${m}`);

// Only power.
chip(sec, 'Current').click();
chip(sec, 'Voltage').click();
if (rowsOf(sec).length !== 3 || rowsOf(sec).some(r => !r.includes('Power'))) fail(`only power: ${JSON.stringify(rowsOf(sec))}`);

// Tag n30.
const tagSel = query(sec, 'select', true).find(s => query(s, 'option', true).some(o => o.value === 'n30'));
if (!tagSel) fail('no tag picker');
tagSel.value = 'n30';
tagSel.dispatch('change');
const r = rowsOf(sec);
if (r.length !== 2 || r.some(x => x.includes('Inverter'))) fail(`tag n30: ${JSON.stringify(r)}`);

// Remembered in a new page load.
const saved = ['rpdu-nodedata-metrics-off', 'rpdu-nodedata-tag'].map(k => [k, sandbox.localStorage.getItem(k)]);
({ sec } = await run(saved));
const r2 = rowsOf(sec);
if (r2.length !== 2 || r2.some(x => !x.includes('Power') || x.includes('Inverter'))) fail(`not remembered: ${JSON.stringify(r2)}`);

// All brings every metric back.
query(sec, 'button', true).find(b => b.textContent === 'All').click();
if (rowsOf(sec).length !== 4) fail(`All did not restore metrics: ${JSON.stringify(rowsOf(sec))}`);

// Headers sort: Node descending on a second click.
const th = (name) => query(sec, 'th', true).find(t => t.textContent.startsWith(name));
th('Node').click();
if (!rowsOf(sec)[0].startsWith('Breaker 1')) fail(`Node ascending: ${JSON.stringify(rowsOf(sec))}`);
th('Node').click();
if (!rowsOf(sec)[0].startsWith('Breaker 2')) fail(`Node descending: ${JSON.stringify(rowsOf(sec))}`);
th('Metric').click();
if (!rowsOf(sec)[0].includes('Current')) fail(`Metric ascending: ${JSON.stringify(rowsOf(sec))}`);

console.log('node data filters check: OK');

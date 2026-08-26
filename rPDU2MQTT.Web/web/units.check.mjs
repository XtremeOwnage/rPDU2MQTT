// A reading is shown at a scale a person reads. "6,744 W" is four digits of precision nobody asked for on
// a diagram whose point is proportion; "6.74 kW" is the same fact. The scaling only goes up, only past a
// thousand, and only for units where a reading realistically crosses that line — amps and volts stay put.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('units check FAILED: ' + m); process.exit(1); };

/// Render one flow graph and hand back every label the diagram drew.
const labelsFor = async (units, values) => {
  const nodes = Object.entries(values).map(([id, value], i) => ({
    id, label: id, kind: i === 0 ? 'grid' : 'load', value, derivation: 'measured',
  }));
  const first = Object.keys(values)[0];
  const graph = {
    ok: true, metric: 'realpower', units,
    nodes,
    links: Object.keys(values).slice(1).map(id => ({ source: first, target: id, value: values[id] })),
  };
  const { sandbox, getEl } = makeDom({
    bodies: (url) => url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: false } }
      : url.includes('/api/flow/live') ? { ok: true, values: [] }
      : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
      : url.includes('/api/flow') ? graph
      : { ok: true },
  });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 50));
  query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
  await new Promise(r => setTimeout(r, 300));

  const sec = query(getEl('sections'), '.section', true).find(x => query(x, '.flow-gestures', true).length > 0);
  if (!sec) fail('could not find the Flow section');
  return query(sec, 'text', true).map(t => t.textContent || '').join(' | ');
};

const must = (haystack, needle, why) => {
  if (!haystack.includes(needle)) fail(`${why} — expected "${needle}" in: ${haystack.slice(0, 200)}`);
};
const mustNot = (haystack, needle, why) => {
  if (haystack.includes(needle)) fail(`${why} — did not expect "${needle}" in: ${haystack.slice(0, 200)}`);
};

// --- Watts step to kilowatts past a thousand, and not before ------------------------------------------
{
  const l = await labelsFor('W', { grid: 6744, big: 1038.87, small: 250, tiny: 1.77 });
  must(l, '6.74 kW', 'a six-kilowatt supply is still being written out in watts');
  must(l, '1.04 kW', 'a reading just past a thousand did not step up');
  must(l, '250 W', 'a 250 W load must stay in watts rather than become "0.25 kW"');
  must(l, '1.77 W', 'a small reading keeps its precision');
  mustNot(l, '6,744 W', 'the unscaled figure is still being drawn');
}

// --- Kilowatt-hours step to megawatt-hours ------------------------------------------------------------
{
  const l = await labelsFor('kWh', { grid: 8682.303, day: 16.489 });
  must(l, '8.68 MWh', 'a kWh total past a thousand did not step to MWh');
  must(l, '16.489 kWh', 'a kWh total below a thousand must keep its own precision');
}

// --- Units with no ladder are left exactly as they are ------------------------------------------------
{
  const l = await labelsFor('V', { grid: 1200, leg: 240 });
  must(l, '1,200 V', 'volts must not be rescaled — 1.2 kV is not how this is read');
  must(l, '240 V', 'an ordinary voltage was altered');
}

console.log('units: watts step to kW past a thousand (6,744 W -> 6.74 kW) and not below it, kWh steps to '
  + 'MWh, and a unit with no ladder (V) is left alone');

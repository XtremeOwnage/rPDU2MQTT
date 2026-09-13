// A dictionary of scalars in the config form: one row per entry — key, value, Remove — and a renamed key
// keeps its own value rather than writing it back under the old name.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('maprow check FAILED: ' + m); process.exit(1); };

const config = {
  History: { Enabled: false },
  MQTT: {
    ImportProfiles: [{
      Name: 'ESPHome', Filter: 'esphome/#', Pattern: 'esphome/devices/{device}/sensor/{measure}/state',
      Metrics: { power: 'realpower', energy_d: 'energy_d' },
    }],
  },
  Pdus: { default: { Connection: { Host: 'pdu1' } } },
};
const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? config
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

const navTo = async (label) => {
  const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === label);
  if (!link) fail(`there is no ${label} page`);
  link.click();
  await new Promise(r => setTimeout(r, 200));
  return query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
};

const page = await navTo('MQTT');
const rows = query(page, '.map-entry', true).filter(r => r.classList.contains('inline'));
if (rows.length !== 2) fail(`expected a row per mapped measure, got ${rows.length}`);

// Two unlabelled boxes say nothing about which side is which, so the columns are headed from the schema.
const heads = query(page, '.map-head', true);
if (!heads.length) fail('a map of scalars has no column headings');
const headText = heads[0].textContent;
if (!/Captured \{measure\}/.test(headText) || !/Metric it supplies/.test(headText))
  fail(`the columns are not headed with what they hold: "${headText}"`);
// And a worked entry, which says more than another sentence about the shape of one.
if (!query(page, '.map-example', true).some(e => /sensor\/power\/state/.test(e.textContent)))
  fail('the map does not show a worked example');

// One line: the key, the control it names, and Remove — no card, no second label saying "value".
const row = rows.find(r => query(r, 'input', true).some(i => i.value === 'power'));
if (!row) fail('no row for the "power" measure');
const shape = row.children.map(c => c.tag);
if (JSON.stringify(shape) !== JSON.stringify(['input', 'div', 'button']))
  fail(`a scalar entry is not one row of key, value and Remove: ${shape.join(', ')}`);
if (query(row, 'label', true).some(l => l.textContent === 'value')) fail('the row still labels its value "value"');
if (!query(row, 'select', true).length) fail('the row lost its value control');

// A map of objects keeps its card: each PDU has far too much in it for one line.
const pduPage = await navTo('Vertiv rPDU');
const cards = query(pduPage, '.map-entry', true).filter(r => !r.classList.contains('inline'));
if (!cards.length) fail('a dictionary of objects was flattened into a row');
if (!query(cards[0], '.head', true).length) fail('an object entry lost its heading row');

// Renaming a key takes the value with it: bound to the old key, the control would write the entry straight
// back under the name that was just changed.
const keyIn = query(row, 'input', true).find(i => i.value === 'power');
keyIn.value = 'watts';
keyIn.onchange();
const sel = query(row, 'select', true)[0];
sel.value = 'apparentpower';
sel.onchange();
const metrics = config.MQTT.ImportProfiles[0].Metrics;
if (metrics.power !== undefined) fail(`editing a renamed entry put the old key back: ${JSON.stringify(metrics)}`);
if (metrics.watts !== 'apparentpower') fail(`the renamed entry did not take the edit: ${JSON.stringify(metrics)}`);

console.log('maprow: a dictionary of scalars is one row per entry — key, value, Remove — under headings and a '
  + 'worked example from the schema, a dictionary of objects keeps its card, and a renamed key keeps its own value');
process.exit(0);

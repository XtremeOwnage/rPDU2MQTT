// A binding that is worked out rather than read: current = power ÷ voltage, for a meter that reports watts
// and volts but no amps. It depends on OTHER bindings, so it is the only one that can be filled in
// completely and still produce nothing — which is why the row says what it still needs.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('derived check FAILED: ' + m); process.exit(1); };

const mqtt = (metric) => ({ Type: 'mqtt', Metric: metric, Topic: `x/${metric}` });
const derived = (metric = 'current') => ({ Type: 'derived', Metric: metric });

/// Open the Nodes page on a grid node with these bindings, click Edit, and read the binding rows back.
const rowsFor = async (sources) => {
  const config = {
    History: { Enabled: false },
    EnergyFlow: { Nodes: [{ Id: 'grid', Label: 'Grid', Kind: 'grid', Sources: sources }], Links: [] },
  };
  const { sandbox, getEl } = makeDom({
    bodies: (url) => url.includes('/api/schema') ? schema
      : url.includes('/api/config') ? config
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : { ok: true },
  });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 60));

  const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes');
  if (!link) fail('no Nodes page');
  link.click();
  await new Promise(r => setTimeout(r, 200));

  const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
  const edit = query(sec, 'button', true).find(b => b.textContent === 'Edit');
  if (!edit) fail('no node to edit');
  edit.click();
  await new Promise(r => setTimeout(r, 200));

  const rows = query(sandbox.document.body, 'tr', true).map(r => r.textContent || '');
  if (process.env.DEBUG_DERIVED) console.log('ROWS', rows.length, JSON.stringify(rows.slice(0, 8)));
  return rows;
};

// Everything it needs: the row states the rule and asks for nothing.
// The row's text includes every option of its own dropdowns, so the assertions read the sentence the row
// adds rather than the row.
const needs = (row) => (/Needs a ([^.]*)\./.exec(row) || [, ''])[1];

let rows = await rowsFor([mqtt('realpower'), mqtt('voltage'), derived()]);
let row = rows.find(r => /= power ÷ voltage/.test(r));
if (!row) fail(`the calculated row does not say what it works out: ${rows.length} rows`);
if (needs(row)) fail(`a binding with both readings is asking for one: ${needs(row)}`);

// Voltage missing: named, on its own.
rows = await rowsFor([mqtt('realpower'), derived()]);
row = rows.find(r => /= power ÷ voltage/.test(r)) || '';
if (!needs(row)) fail('a calculated current with no voltage says nothing');
if (!/Voltage/i.test(needs(row))) fail(`the missing voltage is not named: ${needs(row)}`);
if (/Power/i.test(needs(row))) fail(`power is bound but reported missing: ${needs(row)}`);

// Neither: both named.
rows = await rowsFor([derived()]);
row = rows.find(r => /= power ÷ voltage/.test(r)) || '';
if (!needs(row)) fail('a calculated current with nothing behind it says nothing');
if (!/Power/i.test(needs(row)) || !/Voltage/i.test(needs(row)))
  fail(`only one of the two missing readings is named: ${needs(row)}`);

// Nothing else can be worked out from what we hold, and asking is a mistake worth saying out loud.
rows = await rowsFor([mqtt('realpower'), mqtt('voltage'), derived('energy')]);
if (!rows.some(r => /cannot be calculated/.test(r)))
  fail('a calculated energy binding was accepted silently');

console.log('derived: a calculated current states its rule, names the bindings it still needs, and refuses '
  + 'to be anything other than current');

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

// What the backend serves: one entry per metric that can be worked out, and the pairs it can use.
const derivations = { ok: true, metrics: [
  { metric: 'apparentpower', name: 'apparent power', units: 'VA', from: [
    { a: 'voltage', b: 'current', label: 'voltage × current' },
    { a: 'realpower', b: 'powerfactor', label: 'power ÷ power factor' }] },
  { metric: 'voltage', name: 'voltage', units: 'V', from: [
    { a: 'apparentpower', b: 'current', label: 'apparent power ÷ current' },
    { a: 'realpower', b: 'current', label: 'power ÷ current', assumes: 'a power factor of 1' }] },
  { metric: 'current', name: 'current', units: 'A', from: [
    { a: 'apparentpower', b: 'voltage', label: 'apparent power ÷ voltage' },
    { a: 'realpower', b: 'voltage', label: 'power ÷ voltage', assumes: 'a power factor of 1' }] },
  { metric: 'realpower', name: 'power', units: 'W', from: [
    { a: 'apparentpower', b: 'powerfactor', label: 'apparent power × power factor' },
    { a: 'voltage', b: 'current', label: 'voltage × current', assumes: 'a power factor of 1' }] },
  { metric: 'powerfactor', name: 'power factor', units: '', from: [
    { a: 'realpower', b: 'apparentpower', label: 'power ÷ apparent power' }] },
] };

const mqtt = (metric) => ({ Type: 'mqtt', Metric: metric, Topic: `x/${metric}` });
const derived = (metric = 'current') => ({ Type: 'derived', Metric: metric });

/// Open the Nodes page on a grid node with these bindings, click Edit, and read the binding rows back.
const rowsFor = async (sources) => {
  const config = {
    History: { Enabled: false },
    EnergyFlow: { Nodes: [{ Id: 'grid', Label: 'Grid', Kind: 'grid', Sources: sources }], Links: [] },
  };
  const { sandbox, getEl } = makeDom({
    bodies: (url) => url.includes('/api/flow/derivations') ? derivations
      : url.includes('/api/schema') ? schema
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

// The row's text includes every option of its own dropdowns, so the assertions read the sentences the row
// adds rather than the row.
const sums = (row) => (/= ([a-z ]+?[×÷][a-z ]+?)(?=assumes|Needs|no source|$)/.exec(row) || [, ''])[1].trim();
const needs = (row) => (/Needs ([^.]*)\./.exec(row) || [, ''])[1];
const rowOf = (rows) => rows.find(r => /[×÷]/.test(r)) || '';

// Power and voltage: the only pair available, and it is the one that assumes a power factor of 1 — said
// out loud, because P = V × I is exact for a DC string and an approximation for an AC feeder.
let row = rowOf(await rowsFor([mqtt('realpower'), mqtt('voltage'), derived('current')]));
if (sums(row) !== 'power ÷ voltage') fail(`the wrong sum was offered: ${sums(row) || row.slice(0, 60)}`);
if (needs(row)) fail(`a binding with a pair to work from is asking for one: ${needs(row)}`);
if (!/assumes a power factor of 1/.test(row)) fail('the unity-power-factor assumption is not stated');

// Apparent power and voltage: exact, so no caveat.
row = rowOf(await rowsFor([mqtt('apparentpower'), mqtt('voltage'), derived('current')]));
if (sums(row) !== 'apparent power ÷ voltage') fail(`an exact pair was not preferred: ${sums(row)}`);
if (/assumes/.test(row)) fail(`an exact relation is claiming an assumption: ${row.slice(-80)}`);

// With a power factor to hand the exact route is reached in two steps — S = P ÷ PF, then I = S ÷ V — and
// taking the shortcut would under-report the current by that factor.
row = rowOf(await rowsFor([mqtt('realpower'), mqtt('voltage'), mqtt('powerfactor'), derived('current')]));
if (sums(row) !== 'apparent power ÷ voltage') fail(`the power factor was ignored in favour of the shortcut: ${sums(row)}`);
if (/assumes/.test(row)) fail('an exact two-step route is claiming an assumption');

// Half a pair is nothing to work from, and the row names the pairs that would do.
row = rowOf(await rowsFor([mqtt('realpower'), derived('current')]));
if (!needs(row)) fail('a calculated current with no second reading says nothing');
if (!/voltage/i.test(needs(row))) fail(`the pairs that would work are not named: ${needs(row)}`);

// Nothing at all bound: same, and it still names them rather than going quiet.
row = rowOf(await rowsFor([derived('current')]));
if (!needs(row)) fail('a calculated current with nothing behind it says nothing');

// Every metric in a relation can be worked out, not just current.
row = rowOf(await rowsFor([mqtt('voltage'), mqtt('current'), derived('realpower')]));
if (sums(row) !== 'voltage × current') fail(`power is not offered from volts and amps: ${sums(row)}`);
row = rowOf(await rowsFor([mqtt('realpower'), mqtt('apparentpower'), derived('powerfactor')]));
if (sums(row) !== 'power ÷ apparent power') fail(`power factor is not offered from W and VA: ${sums(row)}`);

// Energy follows from none of the relations, and saying so beats a binding that quietly never works.
const rows = await rowsFor([mqtt('realpower'), mqtt('voltage'), derived('energy')]);
if (!rows.some(r => /cannot be calculated/.test(r))) fail('a calculated energy binding was accepted silently');

console.log('derived: a calculated binding states the sum it will actually do, prefers an exact relation '
  + 'over one that assumes a power factor of 1 and says so when it cannot, names the pairs that would work '
  + 'when it has none, and refuses a metric no relation covers');

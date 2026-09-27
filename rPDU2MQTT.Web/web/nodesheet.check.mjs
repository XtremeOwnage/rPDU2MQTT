// The node editor's bindings, and saving from the editor.
//
// The bindings were a table of up to eleven columns, about 1,640px, which a phone could only show by
// scrolling sideways (#401). Each binding is now a card of its own, carrying only the settings that mean
// something for its metric. And the page's save bar sits under the dialog's backdrop, so saving meant
// closing the editor first with nothing to say so: the dialog carries its own Save.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('node-sheet check FAILED: ' + m); process.exit(1); };

const mqtt = (metric, extra = {}) => ({ Type: 'mqtt', Metric: metric, Topic: `x/${metric}`, ...extra });

/// Open the editor on a node with these bindings.
const sheetFor = async (kind, sources) => {
  const config = {
    History: { Enabled: false },
    EnergyFlow: { Nodes: [{ Id: 'n', Label: 'N', Kind: kind, Sources: sources }], Links: [] },
  };
  const posts = [];
  const { sandbox, getEl } = makeDom({
    bodies: (url, opts) => {
      if (url.includes('/api/config') && opts?.method === 'POST') { posts.push(JSON.parse(opts.body)); return { ok: true, message: 'Saved.' }; }
      return url.includes('/api/schema') ? schema
        : url.includes('/api/config') ? config
        : url.includes('/api/status') ? { ok: true, configWritable: true }
        : url.includes('/api/instances') ? { ok: true, instances: [] }
        : { ok: true };
    },
  });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 60));
  query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes')?.click();
  await new Promise(r => setTimeout(r, 200));
  const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
  query(sec, 'button', true).find(b => b.textContent === 'Edit')?.click();
  await new Promise(r => setTimeout(r, 200));

  const body = sandbox.document.body;
  const editor = query(body, '.node-editor', false);
  if (!editor) fail('the editor did not open');
  const cards = query(editor, '.ne-binding', true).map(c => ({
    metric: query(c, '.ne-metric', false)?.value,
    fields: query(c, '.ne-slot', true).map(s => s.dataset.field),
  }));
  return { sandbox, body, editor, cards, posts };
};
const card = (s, metric) => s.cards.find(c => c.metric === metric) || fail(`no card for ${metric}`);
const has = (c, f) => c.fields.includes(f);

// --- One card per binding, no table to scroll sideways ---------------------------------------------------
let s = await sheetFor('grid', [mqtt('realpower', { Direction: 'split' }), mqtt('energy'), mqtt('voltage')]);
if (query(s.editor, 'table', true).length) fail('the editor still lays its bindings out as a table');
if (s.cards.length !== 3) fail(`3 bindings drew ${s.cards.length} cards`);
for (const c of s.cards) if (!has(c, 'source')) fail(`the ${c.metric} card says nothing about where it reads from`);

// --- Each card carries only what means something for its metric ------------------------------------------
if (!has(card(s, 'energy'), 'counter')) fail('an energy binding does not ask whether its counter resets daily');
if (has(card(s, 'realpower'), 'counter') || has(card(s, 'voltage'), 'counter')) fail('Counter is offered where nothing accumulates');
if (!has(card(s, 'realpower'), 'direction') || !has(card(s, 'energy'), 'direction')) fail('a grid binding with a direction is not asked for it');
if (has(card(s, 'voltage'), 'direction')) fail('Direction is offered for voltage, which has none');
if (!has(card(s, 'realpower'), 'invert')) fail('power has a sign, and Invert is missing');
if (has(card(s, 'voltage'), 'invert') || has(card(s, 'energy'), 'invert')) fail('Invert is offered where a reading has no sign');

s = await sheetFor('load', [mqtt('realpower'), mqtt('voltage')]);
if (s.cards.some(c => has(c, 'direction'))) fail('Direction is offered on a node that only flows one way');

// --- Save from the editor -------------------------------------------------------------------------------
const foot = query(s.body, '.sheet-sticky-foot', false);
if (!foot) fail('the editor has no footer of its own');
const save = query(foot, 'button', true).find(b => b.textContent === 'Save');
const status = query(foot, '.sheet-dirty', false);
if (!save || !status) fail('the footer has no Save, or does not say what is unsaved');
if (!save.disabled) fail('Save is offered with nothing to save');

const name = query(s.editor, 'input', true)[0];
name.value = 'Renamed';
name.dispatch('change', {});
await new Promise(r => setTimeout(r, 20));
if (!/1 unsaved change/.test(status.textContent)) fail(`an edit is not reported in the editor: "${status.textContent}"`);
if (save.disabled) fail('Save stays disabled after an edit');

save.click();
await new Promise(r => setTimeout(r, 60));
if (!s.posts.length) fail('Save in the editor wrote nothing');
if (s.posts[0].EnergyFlow.Nodes[0].Label !== 'Renamed') fail('Save wrote the configuration without the edit');
if (!query(s.body, '.node-editor', false)) fail('saving closed the editor');
if (!/saved/i.test(status.textContent) || !save.disabled) fail(`after saving the footer still reports: "${status.textContent}"`);

// Done closes it.
query(foot, 'button', true).find(b => b.textContent === 'Done').click();
await new Promise(r => setTimeout(r, 20));
if (query(s.body, '.node-editor', false)) fail('Done did not close the editor');

console.log('node-sheet: each binding is a card with only the settings its metric uses (Direction, Counter, '
  + 'Invert where they mean something), no table to scroll sideways, and the editor saves from its own '
  + 'footer, which says what is unsaved, without closing');

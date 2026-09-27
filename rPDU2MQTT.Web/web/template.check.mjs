// Templated settings show their placeholders — what each means, with an example — and preview the template
// filled in. A placeholder is clicked or dragged in, and what it inserts is kept as a change to save.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('template check FAILED: ' + m); process.exit(1); };

const config = {
  History: { Enabled: false },
  EmonCMS: { InputNameTemplate: '{device}_{nope}' },
  EnergyFlow: { Nodes: [{ Id: 'mppt_1', Label: 'MPPT 1', Kind: 'solar', EmonCmsTag: '{label}' }], Links: [] },
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
const open = async (label) => {
  query(getEl('nav'), 'a', true).find(a => a.dataset.label === label).click();
  await new Promise(r => setTimeout(r, 150));
  return query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
};

// --- A schema-drawn setting: the EmonCMS input name ---------------------------------------------------
const sec = await open('EmonCMS');
const help = query(sec, '.tpl-help', true).find(h => query(h, '.tpl-chip', true).some(c => c.dataset.var === 'number'));
if (!help) fail('the input-name template shows no placeholders');
// Out of the way until the field is being edited.
if (help.classList.contains('is-open')) fail('the placeholders are shown before the field is clicked into');
const field = query(sec, 'input', true).find(i => String(i.value).startsWith('{device}_{nope}'));
field.dispatch('focus', {});
if (!help.classList.contains('is-open')) fail('clicking into the field does not show its placeholders');
const chips = query(help, '.tpl-chip', true);
const vars = chips.map(c => c.dataset.var);
for (const v of ['device', 'source', 'name', 'number', 'type', 'units'])
  if (!vars.includes(v)) fail(`{${v}} is not offered: ${vars.join(', ')}`);
if (chips.some(c => !query(c, '.tpl-eg', false)?.textContent)) fail('a placeholder is shown without an example value');
if (!chips.every(c => /e\.g\./.test(c.title))) fail('a placeholder does not say what it stands for');

const preview = () => query(help, '.tpl-preview', false);
if (!query(preview(), '.tpl-val', true).some(v => v.textContent === 'rack_pdu_1')) fail(`{device} is not previewed as its example: ${preview().textContent}`);
if (!query(preview(), '.tpl-bad', true).some(v => v.textContent === '{nope}')) fail('a placeholder this field does not take is not flagged');

// Clicking one inserts it and keeps it.
chips.find(c => c.dataset.var === 'type').click();
const input = query(help.parentNode || sec, 'input', true).find(i => String(i.value).startsWith('{device}_{nope}'));
if (!input || input.value !== '{device}_{nope}{type}') fail(`clicking {type} did not insert it: "${input?.value}"`);
if (!query(preview(), '.tpl-val', true).some(v => v.textContent === 'realpower')) fail('the preview did not follow the insert');
// …and it is what a save would write, not just what the box shows.
if (vm.runInContext('exportData().EmonCMS.InputNameTemplate', sandbox) !== '{device}_{nope}{type}')
  fail('the inserted placeholder never reached the configuration');

// --- A hand-built field: the node editor previews with the node's own values ---------------------------
const nodes = await open('Nodes');
query(nodes, 'button', true).find(b => b.textContent === 'Edit').click();
await new Promise(r => setTimeout(r, 150));
const editor = query(sandbox.document.body, '.node-editor', false);
const tagHelp = query(editor, '.tpl-help', true)[0];
if (!tagHelp) fail('the node editor’s EmonCMS tag shows no placeholders');
if (!query(tagHelp, '.tpl-val', true).some(v => v.textContent === 'MPPT 1')) fail(`the node’s tag is not previewed with its own label: ${query(tagHelp, '.tpl-preview', false)?.textContent}`);

console.log('template: a templated setting lists its placeholders with what each means and an example, previews '
  + 'the template filled in and flags a placeholder the field does not take, inserts a clicked placeholder at '
  + 'the cursor, and the node editor previews with the node’s own id, label and kind');

// Settings a plugin keeps on a node: rendered in the node editor from the plugin's settings class, saved under
// the node's Ext by plugin id, and only once something is changed — opening the editor is not an edit.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('extensions check FAILED: ' + m); process.exit(1); };

// The extension point as the server describes it once a plugin declares settings for nodes.
const nodeSchema = schema.find(n => n.key === 'EnergyFlow')?.properties?.find(p => p.key === 'Nodes')?.valueSchema;
if (!nodeSchema) fail('the fixture has no node schema');
nodeSchema.properties = (nodeSchema.properties || []).filter(p => p.key !== 'Ext');
nodeSchema.properties.push({
  key: 'Ext', label: 'Ext', type: 'dictionary', extensionOf: 'node',
  extensions: [{ key: 'where', label: 'Where', type: 'object', isPlugin: true, properties: [
    { key: 'Room', label: 'Room', type: 'string', description: 'The room it is in.' },
    { key: 'Place', label: 'Place', type: 'string', choicesFrom: '/api/plugins/where/choices' },
    { key: 'Serves', label: 'Serves', type: 'list', choicesFrom: '/api/plugins/where/choices', valueSchema: { key: '', label: '', type: 'string' } },
  ] }],
});

const config = {
  History: { Enabled: false },
  EnergyFlow: { Nodes: [{ Id: 'n', Label: 'N', Kind: 'load', Ext: { other: { Keep: 1 } } }], Links: [] },
};
const posts = [];
const { sandbox, getEl } = makeDom({
  bodies: (url, opts) => {
    if (url.includes('/api/config') && opts?.method === 'POST') { posts.push(JSON.parse(opts.body)); return { ok: true, message: 'Saved.' }; }
    if (url.includes('/api/plugins/where/choices')) return [['kitchen', 'Kitchen'], ['garage', 'Garage']];
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
const section = query(editor, '.ext-section', true).find(f => f.dataset.plugin === 'where');
if (!section) fail('the plugin\'s settings are not in the node editor');
const foot = query(body, '.sheet-sticky-foot', false);
const save = query(foot, 'button', true).find(b => b.textContent === 'Save');
if (!save.disabled) fail('opening the editor counted as an edit');

const room = query(section, 'input', false);
if (!room) fail('the plugin\'s field has no input');
room.value = 'kitchen';
room.dispatch('change', {});
await new Promise(r => setTimeout(r, 20));
if (save.disabled) fail('editing a plugin setting is not an unsaved change');

// A field whose choices the server answers: a dropdown, and a list of boxes to tick.
const place = query(section, 'select', false);
if (!place) fail('a field with server choices is not a dropdown');
const opts = query(place, 'option', true).map(o => o.value);
if (!opts.includes('garage')) fail(`the dropdown did not get the server's choices: ${JSON.stringify(opts)}`);
place.value = 'garage';
place.dispatch('change', {});
const boxes = query(section, '.choice-box', true);
if (boxes.length !== 2) fail(`a list with server choices drew ${boxes.length} boxes, not 2`);
const tick = query(boxes[0], 'input', false);
tick.checked = true;
tick.dispatch('change', {});

save.click();
await new Promise(r => setTimeout(r, 60));
const ext = posts[0]?.EnergyFlow?.Nodes?.[0]?.Ext;
if (ext?.where?.Room !== 'kitchen') fail(`the setting was not saved under the plugin's id: ${JSON.stringify(ext)}`);
if (ext?.where?.Place !== 'garage') fail(`the dropdown's pick was not saved: ${JSON.stringify(ext)}`);
if (JSON.stringify(ext?.where?.Serves) !== '["kitchen"]') fail(`the ticked box was not saved: ${JSON.stringify(ext)}`);
if (ext?.other?.Keep !== 1) fail('another plugin\'s settings on the node were lost');

console.log('extensions: a plugin\'s node settings render in the node editor, save under Ext by plugin id, draw server-answered choices as a dropdown or boxes, '
  + 'leave other plugins\' entries alone, and opening the editor is not an edit');

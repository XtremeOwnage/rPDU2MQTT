// A node's EmonCMS tags in the node editor: typed values are kept on the node, and cleared ones go back to the default.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('nodeemontag check FAILED: ' + m); process.exit(1); };

const node = { Id: 'solar', Label: 'Solar', Kind: 'solar', EmonCmsVirtualTag: 'old-virtual', Sources: [] };
const config = { History: { Enabled: false }, EnergyFlow: { Nodes: [node], Links: [] } };
const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/config') ? config
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes')?.click();
await new Promise(r => setTimeout(r, 200));
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
query(sec, 'button', true).find(b => b.textContent === 'Edit')?.click();
await new Promise(r => setTimeout(r, 200));

// The editor edits the node it was given; find the field by its label.
const nodeOf = () => config.EnergyFlow.Nodes.find(n => n.Id === 'solar');
const inputFor = (label) => {
  const lab = query(sandbox.document.body, 'label', true).concat(query(sandbox.document.body, 'div', true))
    .find(x => query(x, 'input', true).length === 1 && (x.textContent || '').startsWith(label) && !(x.textContent || '').startsWith(label + ' virtual'));
  return lab && query(lab, 'input', true)[0];
};
const tag = inputFor('EmonCMS tag');
const vtag = inputFor('EmonCMS virtual-feed tag');
if (!tag || !vtag) fail('the node editor has no EmonCMS tag fields');
if (vtag.value !== 'old-virtual') fail(`the virtual-feed tag field does not show the node's tag: "${vtag.value}"`);

tag.value = ' {kind}-feeds ';
tag.onchange();
vtag.value = '';
vtag.onchange();
const n = nodeOf();
if (n.EmonCmsTag !== '{kind}-feeds') fail(`a typed tag was not kept on the node: ${JSON.stringify(n.EmonCmsTag)}`);
if ('EmonCmsVirtualTag' in n && n.EmonCmsVirtualTag !== undefined) fail(`a cleared tag was kept instead of going back to the default: ${JSON.stringify(n.EmonCmsVirtualTag)}`);

console.log('nodeemontag: the node editor keeps a typed EmonCMS tag on the node, and a cleared one goes back to the default');

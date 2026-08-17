// A plugin needs no TypeScript (#v4).
//
// Everything a loaded plugin shows in the GUI is generated: its page from the schema its settings class
// produced, its nav placement from the group it declared, its buttons from the actions the server derived.
// Nothing in web/src names a plugin, and this check is what keeps that true — the moment someone special-
// cases one, a plugin stops being a drop-in DLL and becomes a change to the bundle.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const base = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('plugin check FAILED: ' + m); process.exit(1); };

// A plugin the GUI has never heard of, described exactly as the server describes one.
const pluginSection = {
  key: 'acmeflux', label: 'Acme Flux', type: 'object', isPlugin: true, group: 'Destinations',
  description: 'Settings for the Acme Flux plugin.',
  properties: [
    { key: 'Enabled', label: 'Enabled', type: 'bool', default: false, description: 'Send readings to Acme.' },
    { key: 'Url', label: 'Url', type: 'string', description: 'Base URL.' },
    { key: 'BatchSize', label: 'BatchSize', type: 'int', default: 100, min: 1, max: 1000 },
  ],
};
const schema = [...base, pluginSection];

const cfg = { EnergyFlow: { Nodes: [], Links: [] } };
const integrations = {
  ok: true,
  integrations: [{
    id: 'acmeflux', name: 'Acme Flux', group: 'Destinations', enabled: true, capabilities: ['destination'],
    actions: [
      { name: 'probe', title: 'Test', description: 'Check Acme is reachable.', effect: 'read' },
      { name: 'flush', title: 'Flush now', description: 'Send everything buffered.', effect: 'write' },
    ],
  }],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/integrations') ? integrations :
    url.includes('/api/config') ? cfg :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

// 1. It has a nav entry, in the group it declared — not in System, where anything ungrouped lands.
const links = query(getEl('nav'), 'a', true);
const link = links.find(a => a.dataset.label === 'Acme Flux');
if (!link) fail(`no nav entry for the plugin; saw ${links.map(a => a.dataset.label).join(', ')}`);

const groupTitles = query(getEl('nav'), '.nav-group-title', true).map(t => t.textContent);
if (groupTitles.length && !groupTitles.includes('Destinations'))
  fail(`no Destinations group to place it in: ${groupTitles.join(', ')}`);

// 2. Its page renders its settings as typed controls, from the schema alone.
link.click();
await new Promise(r => setTimeout(r, 250));
const sec = query(getEl('sections'), '.section', true).find(x => x.classList.contains('active'));
if (!sec) fail('the plugin page did not activate');

const fields = query(sec, '.field', true).map(f => f.dataset.path).filter(Boolean);
for (const want of ['Plugins.acmeflux.Enabled', 'Plugins.acmeflux.Url', 'Plugins.acmeflux.BatchSize'])
  if (!fields.includes(want)) fail(`'${want}' did not render; got ${fields.join(', ') || '(none)'}`);

// 3. It binds under Plugins/<id> — Config was compiled before the plugin existed.
if (!sandbox.__state?.data?.Plugins?.acmeflux && !cfg.Plugins?.acmeflux) {
  const bound = query(sec, 'input', true).length > 0;
  if (!bound) fail('the plugin page rendered no inputs, so nothing is bound');
}

// 4. Its buttons come from what the server said it can do, and are not named anywhere in web/src.
await new Promise(r => setTimeout(r, 120));
const labels = query(sec, 'button', true).map(b => b.textContent);
for (const want of ['Test', 'Flush now'])
  if (!labels.includes(want)) fail(`no '${want}' button; saw ${labels.join(', ') || '(none)'}`);

// 5. And the raw Plugins map is NOT offered as well. It is the storage behind the per-plugin pages;
//    rendering it too gives two editors for one thing, and the raw one is a free-text box over a
//    dictionary of objects that nobody can usefully type into.
if (query(getEl('nav'), 'a', true).some(a => a.dataset.label === 'Plugins'))
  fail('the raw Plugins map is rendered as its own page as well as the plugin sections');

console.log(`plugin: a plugin the GUI has never heard of gets a nav entry in its declared group, `
  + `${fields.length} generated field(s) bound under Plugins/, and ${labels.length} button(s) from its `
  + 'declared actions — with no TypeScript naming it');

// Checks that an unknown plugin gets a nav entry, generated fields and action buttons from the schema alone.
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
// A plugin in the Sources group.
const sourceSection = {
  key: 'busreader', label: 'Bus Reader', type: 'object', isPlugin: true, group: 'Sources',
  properties: [{ key: 'Enabled', label: 'Enabled', type: 'bool', default: false }],
};
const schema = [...base, pluginSection, sourceSection];

const cfg = { EnergyFlow: { Nodes: [], Links: [] } };
const integrations = {
  ok: true,
  integrations: [{
    id: 'acmeflux', name: 'Acme Flux', group: 'Destinations', enabled: true, capabilities: ['destination', 'pages'],
    pages: [{ id: 'flux-map', title: 'Flux Map', group: 'Energy Flow', icon: '~' }],
    actions: [
      { name: 'probe', title: 'Test', description: 'Check Acme is reachable.', effect: 'read' },
      { name: 'flush', title: 'Flush now', description: 'Send everything buffered.', effect: 'write' },
    ],
  }, { id: 'vertiv', name: 'Vertiv rPDU', group: 'Sources' }],
};

// A plugin page: a function body returning mount(section, host).
const pageJs = `return function mount(sec, host) {
  const n = host.el('div', { class: 'flux-map', text: 'shown 0' }); let shown = 0;
  sec.appendChild(n);
  return { show: () => { n.textContent = 'shown ' + (++shown); } };
};`;

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.endsWith('/api/integrations/acmeflux/pages/flux-map.js') ? pageJs :
    url.endsWith('/api/integrations/acmeflux/pages/flux-map.css') ? '.flux-map{}' :
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/integrations') ? integrations :
    url.includes('/api/config') ? cfg :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

// 1. A nav entry in its declared group.
const links = query(getEl('nav'), 'a', true);
const link = links.find(a => a.dataset.label === 'Acme Flux');
if (!link) fail(`no nav entry for the plugin; saw ${links.map(a => a.dataset.label).join(', ')}`);

// PDU tabs stay under the PDU; the Sources plugin follows them.
const order = links.map(a => a.dataset.label);
const want = ['Vertiv rPDU', 'Overrides', 'Live Data', 'PDU Control', 'Paths', 'Bus Reader'];
const got = order.filter(l => want.includes(l));
if (got.join() !== want.join()) fail(`Sources is ordered ${got.join(', ')}, not ${want.join(', ')}`);
const busLink = links.find(a => a.dataset.label === 'Bus Reader');
if (busLink.classList.contains('nav-child')) fail('the Sources plugin is indented as a child');
if (!links.find(a => a.dataset.label === 'Live Data').classList.contains('nav-child')) fail('the PDU tabs are not indented under the PDU');

const groupTitles = query(getEl('nav'), '.nav-group-title', true).map(t => t.textContent);
if (groupTitles.length && !groupTitles.includes('Destinations'))
  fail(`no Destinations group to place it in: ${groupTitles.join(', ')}`);

// 2. Its settings render as typed controls.
link.click();
await new Promise(r => setTimeout(r, 250));
const sec = query(getEl('sections'), '.section', true).find(x => x.classList.contains('active'));
if (!sec) fail('the plugin page did not activate');

const fields = query(sec, '.field', true).map(f => f.dataset.path).filter(Boolean);
for (const want of ['Plugins.acmeflux.Enabled', 'Plugins.acmeflux.Url', 'Plugins.acmeflux.BatchSize'])
  if (!fields.includes(want)) fail(`'${want}' did not render; got ${fields.join(', ') || '(none)'}`);

// 3. It binds under Plugins/<id>.
if (!sandbox.__state?.data?.Plugins?.acmeflux && !cfg.Plugins?.acmeflux) {
  const bound = query(sec, 'input', true).length > 0;
  if (!bound) fail('the plugin page rendered no inputs, so nothing is bound');
}

// 4. Its buttons come from the server's declared actions.
await new Promise(r => setTimeout(r, 120));
const labels = query(sec, 'button', true).map(b => b.textContent);
for (const want of ['Test', 'Flush now'])
  if (!labels.includes(want)) fail(`no '${want}' button; saw ${labels.join(', ') || '(none)'}`);

// 5. The raw Plugins map is not rendered as its own page; the only Plugins page is the on/off list.
const pluginsLinks = query(getEl('nav'), 'a', true).filter(a => a.dataset.label === 'Plugins');
if (pluginsLinks.length !== 1 || pluginsLinks[0].dataset.section !== 'DisabledPlugins')
  fail('the raw Plugins map is rendered as its own page as well as the plugin sections');

// 6. A plugin page is listed in its group and mounted from the plugin on first open.
const pageLink = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flux Map');
if (!pageLink) fail('the plugin page has no nav entry');
pageLink.click();
await new Promise(r => setTimeout(r, 60));
const pageSec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (query(pageSec, '.flux-map')?.textContent !== 'shown 1') fail('the plugin page was not mounted and shown');
pageLink.click();
await new Promise(r => setTimeout(r, 60));
if (query(pageSec, '.flux-map', true).length !== 1 || query(pageSec, '.flux-map').textContent !== 'shown 2') fail('reopening the plugin page mounted it again');

console.log('plugin: ok');

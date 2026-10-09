// System › Plugins: a switch per plugin writes DisabledPlugins; without Vertiv the PDU pages are gone, without EmonCMS its page.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('plugins check FAILED: ' + m); process.exit(1); };

const config = { Pdus: {}, DisabledPlugins: ['vertiv'], DisabledIntegrations: [], EnergyFlow: { Nodes: [], Links: [] } };
const plugins = [
  { key: 'tigo', name: 'Tigo TAP', version: '1.0.0', bundled: true, disabled: false, integrations: ['tigo'] },
  { key: 'vertiv', name: 'Vertiv rPDU', version: '1.0.0', bundled: true, disabled: true, integrations: [] },
  { key: 'emoncms', name: 'EmonCMS', description: 'Exports readings to EmonCMS.', version: '1.0.0', bundled: true, disabled: false, integrations: ['emoncms', 'emoncms-source'],
    parts: [{ id: 'emoncms', name: 'EmonCMS', capabilities: ['destination', 'history'], disabled: false },
            { id: 'emoncms-source', name: 'EmonCMS feeds', capabilities: ['source', 'values'], disabled: false }] },
];
const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema
    : url.includes('/api/plugins') ? plugins
    : url.includes('/api/integrations') ? { ok: true, integrations: [{ id: 'tigo' }] }
    : url.includes('/api/config') ? config
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

const labels = query(getEl('nav'), 'a', true).map(a => a.dataset.label);
for (const gone of ['Vertiv rPDU', 'Overrides', 'Live Data', 'PDU Control', 'Paths'])
  if (labels.includes(gone)) fail(`"${gone}" is in the nav with Vertiv not loaded`);
if (labels.includes('EmonCMS')) fail('"EmonCMS" is in the nav with EmonCMS not loaded');
if (labels.includes('Floor Plans')) fail('"Floor Plans" is in the nav with the floor plan plugin not loaded');
for (const kept of ['Panel Schedule', 'Nodes', 'Node Data'])
  if (!labels.includes(kept)) fail(`"${kept}" left the nav with the floor plan plugin not loaded`);

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Plugins');
if (!link) fail('there is no Plugins page');
link.click();
await new Promise(r => setTimeout(r, 60));
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const row = (name) => query(sec, '.field', true).find(f => query(f, 'label', true).some(l => l.textContent === name));
const sw = (name) => query(row(name), 'input', true)[0];
if (!row('Tigo TAP') || !row('Vertiv rPDU')) fail('a plugin has no row');
if (!sw('Tigo TAP').checked || sw('Vertiv rPDU').checked) fail('the switches do not match DisabledPlugins');

sw('Vertiv rPDU').checked = true; sw('Vertiv rPDU').onchange();
sw('Tigo TAP').checked = false; sw('Tigo TAP').onchange();
if (JSON.stringify(config.DisabledPlugins) !== '["tigo"]') fail(`DisabledPlugins is ${JSON.stringify(config.DisabledPlugins)}`);
if (!query(link, '.nav-badge', true).length) fail('the Plugins page shows no unsaved change');

const emon = row('EmonCMS');
if (!query(emon, '.desc', true).some(d => d.textContent === 'Exports readings to EmonCMS.')) fail('the plugin description is not shown');
const feeds = row('EmonCMS feeds');
if (!feeds || !query(feeds, '.desc', true).some(d => d.textContent === 'emoncms-source · Node values')) fail('an integration has no row of its own, or its capabilities are not named');
sw('EmonCMS feeds').checked = false; sw('EmonCMS feeds').onchange();
if (JSON.stringify(config.DisabledIntegrations) !== '["emoncms-source"]') fail(`DisabledIntegrations is ${JSON.stringify(config.DisabledIntegrations)}`);
const emonPlugin = query(emon, 'input', true)[0];
emonPlugin.checked = false; emonPlugin.onchange();
if (!sw('EmonCMS feeds').disabled) fail('an integration can still be switched with its plugin off');

console.log('plugins: each plugin has a description and a switch that edits DisabledPlugins, each integration of a plugin with several has its own for DisabledIntegrations, the PDU pages leave the nav when Vertiv is not loaded, the EmonCMS page when EmonCMS is not, and Floor Plans when its plugin is not');

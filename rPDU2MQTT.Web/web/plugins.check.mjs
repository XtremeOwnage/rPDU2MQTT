// System › Plugins: a switch per plugin writes DisabledPlugins; without Vertiv the PDU pages are gone, without EmonCMS its page.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('plugins check FAILED: ' + m); process.exit(1); };

const config = { Pdus: {}, DisabledPlugins: ['vertiv'], EnergyFlow: { Nodes: [], Links: [] } };
const plugins = [
  { key: 'tigo', name: 'Tigo TAP', version: '1.0.0', bundled: true, disabled: false, integrations: ['tigo'] },
  { key: 'vertiv', name: 'Vertiv rPDU', version: '1.0.0', bundled: true, disabled: true, integrations: [] },
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

console.log('plugins: each plugin has a switch that edits DisabledPlugins, the PDU pages leave the nav when Vertiv is not loaded, and the EmonCMS page when EmonCMS is not');

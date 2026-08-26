// A binding valued from an EmonCMS feed. The row has to offer the feed, say what that feed currently
// reads, and say so plainly when the name does not identify one — a wrong feed name is otherwise
// indistinguishable from a working binding until the node quietly shows no data.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('emoncms check FAILED: ' + m); process.exit(1); };

// What the server holds. "energy" exists under two tags on purpose — that is the case a bare name cannot
// address, and the one the row has to refuse rather than guess at.
const feeds = [
  { id: '945', name: '1_power', tag: 'IotaWatt', unit: 'W', value: 122.43, at: '2026-08-25T12:00:00Z' },
  { id: '948', name: '2_power', tag: 'IotaWatt', unit: 'W', value: 930.57, at: '2026-08-25T12:00:00Z' },
  { id: '946', name: 'energy', tag: 'solar', unit: 'kWh', value: 11, at: '2026-08-25T12:00:00Z' },
  { id: '947', name: 'energy', tag: 'grid', unit: 'kWh', value: 22, at: '2026-08-25T12:00:00Z' },
];

let feedRequests = 0;

/// Open the Nodes page on a node with these bindings, click Edit, and hand back the sheet.
const openEditor = async (sources) => {
  feedRequests = 0;
  const config = {
    History: { Enabled: false },
    EnergyFlow: { Nodes: [{ Id: 'rack', Label: 'Rack', Kind: 'load', Sources: sources }], Links: [] },
  };
  const { sandbox, getEl } = makeDom({
    bodies: (url) => {
      if (url.includes('/api/integrations/emoncms-source/feeds')) { feedRequests++; return { ok: true, result: { ok: true, feeds } }; }
      return url.includes('/api/schema') ? schema
        : url.includes('/api/config') ? config
        : url.includes('/api/instances') ? { ok: true, instances: [] }
        : url.includes('/api/flow/derivations') ? { ok: true, metrics: [] }
        : { ok: true };
    },
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
  await new Promise(r => setTimeout(r, 250));
  return sandbox;
};

const binding = (feed, metric = 'realpower') => ({ Type: 'emoncms', Metric: metric, Feed: feed });
const sheetText = (sandbox) => query(sandbox.document.body, 'tr', true).map(r => r.textContent || '').join('\n');

// --- The type is on offer at all --------------------------------------------------------------------
{
  const sandbox = await openEditor([binding('1_power')]);
  const options = query(sandbox.document.body, 'option', true).map(o => o.textContent || '');
  if (!options.includes('EmonCMS feed')) fail('the source-type dropdown does not offer an EmonCMS feed');
  if (!options.includes('Home Assistant entity')) fail('the source-type dropdown does not offer a Home Assistant entity');
}

// --- A named feed says what it currently reads ------------------------------------------------------
{
  const sandbox = await openEditor([binding('1_power')]);
  const inputs = query(sandbox.document.body, 'input', true).filter(i => i.value === '1_power');
  if (!inputs.length) fail('the feed name is not in an editable field');

  const text = sheetText(sandbox);
  if (!/122\.43/.test(text)) fail(`the row does not show the feed's current value: ${text}`);
  if (!query(sandbox.document.body, 'button', true).some(b => b.textContent === 'Browse…'))
    fail('there is no way to browse the server\'s feeds');
  if (feedRequests !== 1) fail(`the feed list was fetched ${feedRequests} times for one binding, expected 1`);
}

// --- A name that is not there, and one that is not unique --------------------------------------------
{
  const sandbox = await openEditor([binding('typo_power')]);
  const text = sheetText(sandbox);
  if (!/No feed on the server is called/.test(text)) fail(`a missing feed is not reported: ${text}`);
}
{
  const sandbox = await openEditor([binding('energy', 'energy')]);
  const text = sheetText(sandbox);
  if (!/names 2 feeds/.test(text)) fail(`an ambiguous feed name is not reported: ${text}`);
  if (!/solar\/energy/.test(text) || !/grid\/energy/.test(text))
    fail(`the ambiguous name does not name the feeds it matched: ${text}`);
}

// --- Several bindings share one fetch ----------------------------------------------------------------
{
  await openEditor([binding('1_power'), binding('2_power', 'apparentpower'), binding('energy', 'energy')]);
  if (feedRequests !== 1) fail(`three bindings asked the server for its feed list ${feedRequests} times, expected 1`);
}

console.log('emoncms: the node editor offers EmonCMS feeds, shows what the named feed currently reads, '
  + 'reports a name that is missing or matches several tags, and asks the server for its feed list once '
  + 'however many bindings are on the node');

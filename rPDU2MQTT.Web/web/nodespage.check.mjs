// The Nodes page is for the nodes. Groups have a page of their own and the rules that tag PDUs and outlets
// live with the tags they apply, so what is left is one table — with a filter, because a real hierarchy is
// longer than a screen.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('nodes page check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const config = {
  History: { Enabled: false },
  EnergyFlow: {
    Nodes: [
      { Id: 'main_panel', Label: 'Main Panel', Kind: 'panel', Tags: ['indoors'] },
      { Id: 'mppt_1', Label: 'MPPT One', Kind: 'solar', Tags: ['roof'] },
      { Id: 'mppt_2', Label: 'MPPT Two', Kind: 'solar', Tags: ['roof'] },
      { Id: 'freezer', Label: 'Garage Freezer', Kind: 'load', Tags: ['critical'] },
    ],
    Links: [],
    Groups: [{ Id: 'pv', Label: 'Incoming PV', Members: ['mppt_1', 'mppt_2'] }],
    AutoTags: [{ Match: 'outlet:rack_pdu_1:*', Tags: ['rack-1'] }],
  },
};

const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? config
        : url.includes('/api/flow') ? { ok: true, nodes: [{ id: 'outlet:rack_pdu_1:1', label: 'Outlet 1', kind: 'outlet' }], links: [] }
          : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(60);

const openPage = async (label) => {
  const a = query(getEl('nav'), 'a', true).find(x => x.dataset.label === label);
  if (!a) fail(`no ${label} page`);
  a.click();
  await wait(220);
  return query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
};

// --- The Nodes page: one table, and a way to find things in it ----------------------------------------
let sec = await openPage('Nodes');
const hunt = () => query(sec, '.nd-hunt');
const rowsOf = () => query(sec, 'tbody', true).flatMap(b => query(b, 'tr', true))
  .map(r => (query(r, 'code') || {}).textContent).filter(Boolean);
const shown = () => (query(sec, '.nd-shown') || {}).textContent || '';

if (!hunt()) fail('the Nodes page cannot be searched');
if (rowsOf().length !== 4) fail(`the table does not list every node: ${rowsOf().join(', ')}`);
if (shown()) fail(`nothing is filtered, yet the page says "${shown()}"`);

// By id or name…
hunt().value = 'mppt';
hunt().oninput({});
await wait(60);
if (JSON.stringify(rowsOf()) !== JSON.stringify(['mppt_1', 'mppt_2'])) fail(`filtering by id kept ${rowsOf().join(', ')}`);
if (!/2 of 4 nodes shown/.test(shown())) fail(`the page does not say what it is showing: "${shown()}"`);
hunt().value = 'garage';
hunt().oninput({});
await wait(60);
if (JSON.stringify(rowsOf()) !== JSON.stringify(['freezer'])) fail(`filtering by name kept ${rowsOf().join(', ')}`);
// …by kind, as the editor words it…
hunt().value = 'solar';
hunt().oninput({});
await wait(60);
if (rowsOf().length !== 2) fail(`filtering by kind kept ${rowsOf().join(', ')}`);
// …and by a tag, which is how a set of nodes is usually named.
hunt().value = 'critical';
hunt().oninput({});
await wait(60);
if (JSON.stringify(rowsOf()) !== JSON.stringify(['freezer'])) fail(`filtering by tag kept ${rowsOf().join(', ')}`);
// Nothing matching says so rather than looking like an empty hierarchy.
hunt().value = 'zzz';
hunt().oninput({});
await wait(60);
if (rowsOf().length) fail('a filter matching nothing still listed nodes');
if (!/Nothing matches/.test(sec.textContent || '')) fail('a filter matching nothing does not say so');
hunt().value = '';
hunt().oninput({});
await wait(60);
if (rowsOf().length !== 4) fail(`clearing the filter did not bring the nodes back: ${rowsOf().join(', ')}`);

// --- What is no longer here, and where it went --------------------------------------------------------
const nodesText = () => sec.textContent || '';
if (/Incoming PV/.test(nodesText())) fail('the group editor is still on the Nodes page');
if (/Tags for PDUs and outlets/.test(nodesText())) fail('the PDU/outlet tag rules are still on the Nodes page');
if (!/Groups page/.test(nodesText()) || !/Tags page/.test(nodesText()))
  fail('the Nodes page does not say where groups and tags went');

// --- Groups, on a page of their own -------------------------------------------------------------------
sec = await openPage('Groups');
if (!/Incoming PV/.test(sec.textContent || '')) fail('the Groups page does not hold the groups');
if (!query(sec, 'button', true).some(b => b.textContent === 'Save')) fail('the Groups page offers no way to save');
if (!/1 group\(s\)/.test(sec.textContent || '')) fail('the Groups page does not say how many there are');
// It edits the same config the Nodes page does.
const label = query(sec, 'input', true).find(i => (i.value || '') === 'Incoming PV');
if (!label) fail('a group cannot be renamed on its own page');
label.value = 'Roof array';
label.onchange({});
if (config.EnergyFlow.Groups[0].Label !== 'Roof array') fail('renaming a group did not reach the config');

// --- …and the tag rules, with the tags they apply -----------------------------------------------------
sec = await openPage('Tags');
if (!/Tags for PDUs and outlets/.test(sec.textContent || '')) fail('the tag rules did not land on the Tags page');
if (!query(sec, 'input', true).some(i => (i.value || '').includes('outlet:rack_pdu_1:*')))
  fail('the rules on the Tags page are not editable');

console.log('nodes page: one table, filtered by id, name, kind or tag, saying what it is showing and when nothing '
  + 'matches; groups have a page of their own that edits the same config; the PDU/outlet tag rules sit with the '
  + 'tags they apply; and the Nodes page says where both went');
process.exit(0);

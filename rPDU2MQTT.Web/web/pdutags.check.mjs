// PDU tags on the Vertiv rPDU page: default tags for every PDU and outlet, and each one's own, kept as tag rules.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('pdutags check FAILED: ' + m); process.exit(1); };

const config = {
  History: { Enabled: false },
  Pdus: {},
  EnergyFlow: {
    AutoTags: [{ Match: 'outlet:rack_pdu_1:*', Tags: ['panel'] }],
    Nodes: [],
    Links: [],
  },
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? config
    : url.includes('/api/flow/live') ? { ok: true, values: [] }
    : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
    : url.includes('/api/flow') ? { ok: true, links: [], metric: 'realpower', units: 'W', nodes: [
        { id: 'pdu:rack_pdu_1', label: 'Rack PDU 1', kind: 'pdu' },
        { id: 'outlet:rack_pdu_1:0', label: 'Outlet 1', kind: 'outlet' },
        { id: 'outlet:rack_pdu_1:1', label: 'Outlet 2', kind: 'outlet' },
      ] }
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

const original = structuredClone(config.EnergyFlow.AutoTags);
const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Vertiv rPDU');
if (!link) fail('there is no Vertiv rPDU page in the nav');
link.click();
await new Promise(r => setTimeout(r, 250));
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('the Vertiv rPDU section did not activate');

const box = query(sec, 'div', true).find(d => String(d.className || '').includes('pdu-tags'));
if (!box) fail('the Vertiv rPDU page has no tags panel');
if (JSON.stringify(config.EnergyFlow.AutoTags) !== JSON.stringify(original)) fail('opening the page changed the tag rules');
if (!/Circuits are not nodes/.test(box.textContent || '')) fail('the panel does not say circuits cannot carry tags');

const rowFor = (text) => query(box, 'tr', true).find(r => query(r, 'td', true).some(td => td.textContent === text));
const typeInto = (row, tag) => {
  const input = query(row, 'input', true).find(i => String(i.className || (i.attrs && i.attrs.class) || '').includes('tag-new'));
  if (!input) fail('a tags row has no tag box');
  input.value = tag;
  input.onblur();
};
const rule = (match) => (config.EnergyFlow.AutoTags || []).find(r => r.Match === match);

// Every PDU and outlet the bridge has discovered gets a row, beside the defaults for all of them.
for (const label of ['All PDUs', 'All outlets', 'Rack PDU 1', 'Outlet 1', 'Outlet 2'])
  if (!rowFor(label)) fail(`no tags row for "${label}"`);

typeInto(rowFor('All outlets'), 'pdu_outlet');
typeInto(rowFor('All PDUs'), 'pdu');
typeInto(rowFor('outlet:rack_pdu_1:0'), 'critical');
if (JSON.stringify(rule('outlet:*')?.Tags) !== '["pdu_outlet"]') fail(`a default outlet tag did not become the outlet:* rule: ${JSON.stringify(config.EnergyFlow.AutoTags)}`);
if (JSON.stringify(rule('pdu:*')?.Tags) !== '["pdu"]') fail(`a default PDU tag did not become the pdu:* rule: ${JSON.stringify(config.EnergyFlow.AutoTags)}`);
if (JSON.stringify(rule('outlet:rack_pdu_1:0')?.Tags) !== '["critical"]') fail(`an outlet's own tag did not become a rule for that outlet: ${JSON.stringify(config.EnergyFlow.AutoTags)}`);
if (JSON.stringify(rule('outlet:rack_pdu_1:*')?.Tags) !== '["panel"]') fail('editing PDU tags changed an unrelated pattern rule');

// A rule with no tags left is removed rather than kept empty.
const remove = query(rowFor('All outlets'), 'button', true).find(x => x.textContent === '✕');
if (!remove) fail('a default tag cannot be removed');
remove.onclick();
if (rule('outlet:*')) fail('removing the last default outlet tag left an empty outlet:* rule');

console.log('pdutags: the Vertiv rPDU page tags every PDU and outlet by default and each one on its own, as rules; '
  + 'opening it writes nothing, other rules are untouched, and a rule with no tags left is removed');

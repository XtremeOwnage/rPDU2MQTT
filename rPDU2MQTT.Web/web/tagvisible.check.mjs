// Tags have to be visible where they take effect.
//
// Two gaps this covers, both reported from the running GUI:
//
// 1. Adding a tag to a node offered a bare text box. The existing tags were on a <datalist>, which shows
//    nothing until you type and so reads as "retype it from memory" — and a second spelling of a tag that
//    already exists is a filter that silently matches nothing.
// 2. The Home Assistant Energy Mapping page said nothing about the export tag filter. Sync pushes what the
//    MQTT export publishes, so a node the filter drops can never be mapped; on that page it looked like the
//    sync quietly missing things, with the filter neither named nor linked.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('tagvisible check FAILED: ' + m); process.exit(1); };

// Three MPPTs kept off the export, a solar node that must still go, and an untagged panel.
const config = {
  History: { Enabled: false },
  HomeAssistant: { EnergyDashboard: { Url: 'http://ha.local:8123', Enabled: true } },
  EnergyFlow: {
    MqttExport: true,
    MqttExportTags: { Include: [], Exclude: ['local-only'] },
    AutoTags: [{ Match: 'outlet:rack_pdu_1:*', Tags: ['rack'] }],
    Nodes: [
      { Id: 'eg4-flexboss21-solar', Label: 'Solar (PV)', Kind: 'solar', Tags: [] },
      { Id: 'MPPT_1', Label: 'MPPT_1', Kind: 'node', Tags: ['local-only'] },
      { Id: 'MPPT_2', Label: 'MPPT_2', Kind: 'node', Tags: ['local-only'] },
      { Id: 'MPPT_3', Label: 'MPPT_3', Kind: 'node', Tags: ['local-only'] },
      { Id: 'main_panel', Label: 'Main Panel', Kind: 'panel', Tags: ['panel'] },
    ],
    Links: [],
  },
};

const open = async (label) => {
  const { sandbox, getEl } = makeDom({
    bodies: (url) =>
      url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? config
      : url.includes('/api/flow/derivations') ? { ok: true, metrics: [] }
      : url.includes('/api/flow/live') ? { ok: true, values: [] }
      : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
      : url.includes('/api/flow') ? { ok: true, nodes: [], links: [], metric: 'realpower', units: 'W' }
      : { ok: true },
  });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 60));
  const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === label);
  if (!link) fail(`no ${label} page in the nav`);
  link.click();
  await new Promise(r => setTimeout(r, 250));
  const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
  if (!sec) fail(`the ${label} section did not activate`);
  return { sandbox, sec };
};

// --- 1. The Energy Mapping page names the filter and what it drops ------------------------------------
{
  const { sec } = await open('HA Energy Mapping');
  const text = sec.textContent || '';

  if (!/local-only/.test(text))
    fail('the Energy Mapping page never names the tag the export filter excludes');
  for (const n of ['MPPT_1', 'MPPT_2', 'MPPT_3'])
    if (!text.includes(n)) fail(`the page does not say ${n} will not reach Home Assistant`);
  if (!/will not reach Home Assistant/i.test(text))
    fail('the page lists nodes without saying what being excluded means for them');
  // A node that IS exported must not be listed as dropped.
  const warn = query(sec, '.ov-note', true).map(w => w.textContent || '').join(' ');
  if (/Main Panel/.test(warn)) fail('an exported node was listed among the excluded');
  if (/Solar/.test(warn)) fail('the solar node was listed among the excluded — it carries no excluded tag');
  // Auto-tag rules reach PDUs and outlets, which have no Tags of their own; say so rather than imply the
  // list above is exhaustive.
  if (!/auto-tag rule/i.test(text)) fail('the page does not mention that auto-tag rules also feed the filter');
  // And a way to change it ON this page. A link to a page that does not carry the field is worse than
  // nothing: it asserts the setting lives somewhere it does not.
  const picker = query(sec, 'select', true)
    .find(x => (x.children || []).some(o => (o.value || (o.attrs && o.attrs.value)) === 'panel'));
  if (!picker) fail('the page states the filter but gives no control to change it');
  if (!/Prometheus and EmonCMS keep their own/i.test(text))
    fail('the page does not say the filter governs this destination only');
  if (query(sec, 'a', true).some(a => /change it/i.test(a.textContent || '')))
    fail('the page still links away for the filter instead of carrying it');
}

// --- 2. With no filter set, the page says so plainly rather than staying silent ------------------------
{
  config.EnergyFlow.MqttExportTags = { Include: [], Exclude: [] };
  const { sec } = await open('HA Energy Mapping');
  const text = sec.textContent || '';
  if (!/no tag filter is set|Every node is exported/i.test(text))
    fail('with no filter set the page says nothing about the filter at all');
  // The control is there whether or not anything is excluded yet — that is how the first one gets added.
  if (!query(sec, 'select', true).some(x => (x.children || []).some(o => (o.value || (o.attrs && o.attrs.value)) === 'panel')))
    fail('with no filter set there is no way to start one');
  if (/will not reach Home Assistant/i.test(text))
    fail('nothing is excluded, yet the page warns that something is');
  config.EnergyFlow.MqttExportTags = { Include: [], Exclude: ['local-only'] };
}

// --- 3. A node's tag field offers the tags that already exist ------------------------------------------
{
  const { sec } = await open('Nodes');
  const edit = query(sec, 'button', true).find(b => b.textContent === 'Edit');
  if (!edit) fail('no node to edit');
  edit.click();
  await new Promise(r => setTimeout(r, 250));

  const picks = query(sec.ownerDocument ? sec.ownerDocument.body : sec, 'select', true)
    .filter(s => (s.children || []).some(o => (o.value || (o.attrs && o.attrs.value)) === 'local-only'));
  if (!picks.length)
    fail('the node editor offers no control listing the tags that already exist — only a box to retype one');

  const opts = (picks[0].children || []).map(o => o.value || (o.attrs && o.attrs.value));
  for (const t of ['local-only', 'panel'])
    if (!opts.includes(t)) fail(`the tag picker does not offer the existing tag "${t}": ${opts.join(', ')}`);
}

console.log('tagvisible: the Energy Mapping page names the export filter, lists the nodes it keeps out of '
  + 'Home Assistant, mentions the auto-tag rules that also feed it and links to where it is changed — and '
  + 'a node\'s tag field offers the tags that already exist instead of only a box to retype one');

// The Tags page (#424): define a tag, see what carries it, and see what it decides.
//
// A tag means nothing on its own — it matters because a destination filter names it. The old manager was a
// panel at the bottom of the Nodes page: no way to reach it, no way to define a tag before something
// carried it (so a filter could not be set up ahead of the nodes it selects), holders behind a tooltip, and
// nothing anywhere saying what a tag was for.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('tagspage check FAILED: ' + m); process.exit(1); };

const config = {
  History: { Enabled: false },
  Prometheus: { NodeTags: { Include: [], Exclude: [] } },
  EnergyFlow: {
    // 'local-only' is declared and doing work; 'orphan' is declared and doing nothing; 'panel' is carried
    // but never declared — all three have to be distinguishable at a glance.
    Tags: [{ Name: 'local-only', Description: 'kept out of Home Assistant' }, { Name: 'orphan', Description: '' }],
    MqttExportTags: { Include: [], Exclude: ['local-only'] },
    AutoTags: [{ Match: 'outlet:rack_pdu_1:*', Tags: ['panel'] }],
    Nodes: [
      { Id: 'MPPT_1', Label: 'MPPT_1', Kind: 'node', Tags: ['local-only'] },
      { Id: 'MPPT_2', Label: 'MPPT_2', Kind: 'node', Tags: ['local-only'] },
      { Id: 'main_panel', Label: 'Main Panel', Kind: 'panel', Tags: ['panel'] },
    ],
    Links: [],
  },
};

const open = async () => {
  const { sandbox, getEl } = makeDom({
    bodies: (url) =>
      url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? config
      : url.includes('/api/flow/live') ? { ok: true, values: [] }
      : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
      : url.includes('/api/flow') ? { ok: true, nodes: [], links: [], metric: 'realpower', units: 'W' }
      : { ok: true },
  });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 60));
  const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Tags');
  if (!link) fail('there is no Tags page in the nav');
  link.click();
  await new Promise(r => setTimeout(r, 250));
  const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
  if (!sec) fail('the Tags section did not activate');
  return { sandbox, sec, getEl };
};

// --- Every tag is listed, declared or not -------------------------------------------------------------
{
  const { sec } = await open();
  const text = sec.textContent || '';
  // A tag's name is an editable field, so it lives in a value rather than in the page's text.
  const values = query(sec, 'input', true).map(i => String(i.value || ''));
  for (const t of ['local-only', 'orphan', 'panel'])
    if (!values.includes(t)) fail(`the page does not list the tag "${t}": ${values.join(', ')}`);

  // A tag nothing declared still works, and the page says which is which.
  if (!/not declared/i.test(text))
    fail('a tag that is carried but never declared is not distinguished from a declared one');

  // Holders named, not counted behind a tooltip.
  if (!text.includes('MPPT_1') || !text.includes('MPPT_2'))
    fail('the page does not name what carries a tag');
  if (/node\(s\)\/rule\(s\)/.test(text))
    fail('holders are still reported as a bare count');

  // What a tag DOES: the destinations that decide on it.
  if (!/MQTT export exclude/i.test(text))
    fail('the page does not say which destination filter names the tag');
  if (!/changes nothing/i.test(text))
    fail('a tag no destination names is not flagged as doing nothing');

  // And what it is for.
  const descs = query(sec, 'input', true).map(i => i.value || '');
  if (!descs.some(v => /kept out of Home Assistant/.test(v)))
    fail('the declared description is not shown');
}

// --- A tag can be defined before anything carries it --------------------------------------------------
{
  const { sec } = await open();
  const define = query(sec, 'button', true).find(b => b.textContent === 'Define tag');
  if (!define) fail('there is no way to define a tag');

  const inputs = query(sec, 'input', true);
  const nameBox = inputs.find(i => (i.attrs && i.attrs.placeholder) === 'tag name');
  if (!nameBox) fail('the define control has no name field');
  nameBox.value = 'future-tag';
  define.click();
  await new Promise(r => setTimeout(r, 60));

  const declared = (config.EnergyFlow.Tags || []).map(t => t.Name);
  if (!declared.includes('future-tag'))
    fail(`defining a tag did not record it: ${declared.join(', ')}`);

  // …and it is offered wherever tags are picked, or it could not then be put to use.
  const { sandbox: s2, sec: sec2 } = await open();
  void sec2;
  const anyPicker = query(s2.document.body, 'option', true).map(o => o.value || (o.attrs && o.attrs.value));
  if (!anyPicker.includes('future-tag'))
    fail('a tag defined with nothing carrying it is not offered in the pickers');
  config.EnergyFlow.Tags = config.EnergyFlow.Tags.filter(t => t.Name !== 'future-tag');
}

// --- Removing a tag reaches the declaration, the holders and the filters -------------------------------
{
  const { sec, sandbox } = await open();
  sandbox.confirm = () => true;
  const rows = query(sec, 'tr', true)
    .filter(r => query(r, 'input', true).some(i => String(i.value || '') === 'local-only'));
  if (!rows.length) fail('no row for local-only');
  const del = query(rows[0], 'button', true).find(b => b.textContent === 'Remove');
  if (!del) fail('no Remove control on the tag row');
  del.click();
  await new Promise(r => setTimeout(r, 60));

  if ((config.EnergyFlow.Tags || []).some(t => t.Name === 'local-only'))
    fail('removing a tag left it declared');
  if (config.EnergyFlow.MqttExportTags.Exclude.includes('local-only'))
    fail('removing a tag left it in a destination filter — the filter now names a tag nothing carries');
  if ((config.EnergyFlow.Nodes[0].Tags || []).includes('local-only'))
    fail('removing a tag left it on a node');
}

console.log('tagspage: the Tags page lists every tag declared or merely carried, names what carries each '
  + 'and which destinations decide on it, flags one that decides nothing, lets a tag be defined before '
  + 'anything carries it and offered in the pickers, and removes one from the declaration, its holders and '
  + 'every filter at once');

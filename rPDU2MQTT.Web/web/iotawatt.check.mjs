// A binding valued from an IoTaWatt series: picked from dropdowns filled from the device, not typed as
// key/value settings.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('iotawatt check FAILED: ' + m); process.exit(1); };

// The server appends a plugin's type to the binding Type choices, with its own label.
const typeNode = (function find(nodes) {
  for (const n of nodes || []) {
    if (n.key === 'Type' && Array.isArray(n.enumValues)) return n;
    const d = find(n.properties || (n.valueSchema ? [n.valueSchema] : []));
    if (d) return d;
  }
  return null;
})(schema.find(n => n.key === 'EnergyFlow')?.properties);
if (!typeNode) fail('no binding Type in the schema fixture');
typeNode.enumValues = [...typeNode.enumValues, 'iotawatt'];
typeNode.enumLabels = { iotawatt: 'IoTaWatt series' };

const devices = [
  { device: 'main', ok: true, series: [
    { name: 'Input_0', unit: 'Volts', value: 126.5 },
    { name: 'MainPanel', unit: 'Watts', value: 1436 },
    { name: 'Subpanel', unit: 'Watts', value: 253 },
  ] },
  { device: 'shop', ok: true, series: [{ name: 'Welder', unit: 'Watts', value: 4000 }] },
];

let seriesRequests = 0;

const openEditor = async (sources, configured) => {
  seriesRequests = 0;
  const config = {
    History: { Enabled: false },
    Plugins: { iotawatt: { Enabled: true, Devices: configured } },
    EnergyFlow: { Nodes: [{ Id: 'main_panel', Label: 'Main panel', Kind: 'panel', Sources: sources }], Links: [] },
  };
  const { sandbox, getEl } = makeDom({
    bodies: (url) => {
      if (url.includes('/api/integrations/iotawatt/series')) { seriesRequests++; return { ok: true, result: { ok: true, devices } }; }
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

const binding = (settings, metric = 'realpower') => ({ Type: 'iotawatt', Metric: metric, Settings: settings });
const rows = (sandbox) => query(sandbox.document.body, '.ne-binding', true);
const seriesSelect = (sandbox) => query(rows(sandbox)[0], 'select', true)
  .find(s => query(s, 'option', true).some(o => o.value === 'MainPanel' || o.value === 'Welder'));

// --- One device: the series is a dropdown with live values, and no device picker ---------------------
{
  const sandbox = await openEditor([binding({ Series: 'MainPanel' })], [{ Id: 'main', Url: 'http://iotawatt' }]);
  const typeSel = query(rows(sandbox)[0], 'select', true).find(x => query(x, 'option', true).some(o => o.value === 'iotawatt'));
  if (!typeSel || typeSel.value !== 'iotawatt') fail('the binding type is not iotawatt');
  if (!query(typeSel, 'option', true).some(o => o.value === 'iotawatt' && o.textContent === 'IoTaWatt series'))
    fail('the type dropdown shows the raw id instead of the plugin\'s label');
  const sel = seriesSelect(sandbox);
  if (!sel) fail('the series is not offered as a dropdown');
  if (sel.value !== 'MainPanel') fail(`the bound series is not selected: ${sel.value}`);
  const labels = query(sel, 'option', true).map(o => o.textContent || '');
  if (!labels.some(l => /Subpanel/.test(l) && /253/.test(l))) fail(`series are not listed with their value: ${labels}`);
  if (query(rows(sandbox)[0], 'input', true).some(i => i.value === 'Series'))
    fail('the generic key/value editor is still shown');
  const deviceSel = query(rows(sandbox)[0], 'select', true).find(s => query(s, 'option', true).some(o => o.value === 'main'));
  if (deviceSel && deviceSel.style.display !== 'none') fail('a device picker is shown with only one device');

  sel.value = 'Subpanel';
  sel.onchange();
  await new Promise(r => setTimeout(r, 30));
  const text = rows(sandbox).map(r => r.textContent || '').join('\n');
  if (!/253/.test(text)) fail(`picking a series does not show its value: ${text}`);
}

// --- Several devices: pick the device, and its series follow ------------------------------------------
{
  const sandbox = await openEditor([binding({ Series: 'Welder', Device: 'shop' })],
    [{ Id: 'main', Url: 'http://a' }, { Id: 'shop', Url: 'http://b' }]);
  const sel = seriesSelect(sandbox);
  if (!sel || sel.value !== 'Welder') fail('the second device\'s series is not selected');
  if (query(sel, 'option', true).some(o => o.value === 'MainPanel')) fail('another device\'s series are offered');
}

// --- Several bindings share one fetch ----------------------------------------------------------------
{
  await openEditor([binding({ Series: 'MainPanel' }), binding({ Series: 'Input_0' }, 'voltage')], [{ Id: 'main', Url: 'http://a' }]);
  if (seriesRequests !== 1) fail(`two bindings asked for the series list ${seriesRequests} times, expected 1`);
}

console.log('iotawatt: the node editor picks an IoTaWatt series from a dropdown filled from the device, with its current value, '
  + 'offers a device picker only when there are several, and fetches the series list once');

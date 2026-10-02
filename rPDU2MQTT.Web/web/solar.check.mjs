// Solar Array: Tigo optimizers arranged into strings, strings wired to MPPTs, each panel live.
//
// Everything the page does is flow configuration — a panel is a node bound to its optimizer, a string a node
// the panels feed — so the check reads the configuration a save would write, not just what is on screen.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('solar check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const serial = (i) => '04C05B4000ABCD' + String(i).padStart(2, '0');
const nodes = [
  { Id: 'mppt_1', Label: 'MPPT 1', Kind: 'node' }, { Id: 'mppt_2', Label: 'MPPT 2', Kind: 'node' },
  { Id: 'pv_a', Label: 'A', Kind: 'solar', Tags: ['pv-string'] }, { Id: 'pv_b', Label: 'B', Kind: 'solar', Tags: ['pv-string'] },
];
const links = [{ From: 'pv_a', To: 'mppt_1' }, { From: 'pv_b', To: 'mppt_2' }];
for (let i = 1; i <= 4; i++) {
  const id = 'tigo_' + serial(i).toLowerCase();
  nodes.push({ Id: id, Label: 'A' + i, Kind: 'solar', Sources: [{ Type: 'tigo', Metric: 'realpower', Settings: { Optimizer: serial(i) } }] });
  links.push({ From: id, To: 'pv_a' });
}
const reading = (i, power, ageSeconds = 2) => ({ serial: serial(i), connection: 'roof', nodeId: i, named: true, vin: 35, vout: 36, iin: power / 35, power, temp: 40, duty: 90, rssi: 170, ageSeconds, reports: 10 });
let snapshot = {
  ok: true, staleSeconds: 180,
  connections: [{ id: 'roof', name: 'Roof', mode: 'listen', connected: true, standby: false, gatewayId: '1209', lastAnswerSeconds: 0.5, otherController: false }],
  optimizers: [reading(1, 300), reading(2, 310), reading(3, 120), reading(4, 0, 900), reading(5, 305), reading(6, 299)],
};
let pluginLoaded = true;

const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/integrations/tigo/optimizers')
      ? (pluginLoaded ? { ok: true, result: snapshot } : { ok: false, message: "No integration called 'tigo'." })
    : url.includes('/api/schema') ? schema
    : url.includes('/api/config') ? { History: { Enabled: false }, EnergyFlow: { Nodes: nodes, Links: links } }
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : { ok: true },
});
let promptAnswer = null;
sandbox.prompt = () => promptAnswer;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(50);
const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Solar Array');
if (!link) fail('there is no Solar Array page');
const open = async () => { link.click(); await wait(60); };
await open();
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const flow = () => vm.runInContext('exportData().EnergyFlow', sandbox);
const tiles = (stringId) => query(query(sec, '.sa-string', true).find(s => s.dataset.node === stringId), '.sa-panel', true);
const button = (text, scope = sec) => query(scope, 'button', true).find(b => b.textContent === text);

// --- The array as wired, live ------------------------------------------------------------------------------
if (query(sec, '.sa-string', true).length !== 2) fail('the two strings are not drawn');
const a = tiles('pv_a');
if (a.map(t => t.dataset.node).join() !== [1, 2, 3, 4].map(i => 'tigo_' + serial(i).toLowerCase()).join()) fail('string A is not in wired order');
if (!/300 W/.test(a[0].textContent)) fail(`a panel does not show its power: ${a[0].textContent}`);
if (!a[2].classList.contains('is-low')) fail('a panel well under its string’s output is not flagged');
if (!a[3].classList.contains('is-quiet')) fail('a panel that stopped reporting is not shown as quiet');
if (!/kW/.test(query(sec, '.sa-string-total').textContent)) fail('a string does not total its panels');
if (!/listening/.test(query(sec, '.sa-bus').textContent)) fail('the bus state is not shown');

// --- Optimizers not in the array are offered, and adopting one wires it ------------------------------------
const loose = query(sec, '.sa-loose-row', true);
if (loose.length !== 2) fail(`${loose.length} unassigned optimizers listed, not 2`);
const pick = query(loose[0], 'select');
pick.value = 'pv_b';
pick.onchange({});
const adopted = flow().Nodes.find(n => n.Id === 'tigo_' + serial(5).toLowerCase());
if (!adopted) fail('adopting an optimizer did not create its panel node');
if (adopted.Kind !== 'solar' || adopted.Label !== 'B1') fail(`the new panel is ${adopted.Kind} "${adopted.Label}", not solar "B1"`);
const metrics = (adopted.Sources || []).filter(s => s.Type === 'tigo' && s.Settings?.Optimizer === serial(5)).map(s => s.Metric).sort();
if (metrics.join() !== 'current,realpower,temperature,voltage') fail(`the panel is not bound to its optimizer for every reading: ${metrics}`);
if (!flow().Links.some(l => l.From === adopted.Id && l.To === 'pv_b')) fail('the new panel does not feed its string');
if (query(sec, '.sa-loose-row', true).length !== 1) fail('an adopted optimizer is still offered');

// --- Arranging -------------------------------------------------------------------------------------------
button('Arrange').onclick();
const order = () => flow().Links.filter(l => l.To === 'pv_a').map(l => l.From);
const first = order()[0];
button('›', tiles('pv_a')[0]).onclick({ stopPropagation() { } });
if (order()[1] !== first) fail(`moving a panel right did not reorder the string: ${order()}`);

// To another string.
const mover = query(tiles('pv_a')[0], 'select.sa-panel-move');
mover.value = 'pv_b';
mover.onchange({});
if (flow().Links.filter(l => l.To === 'pv_b').length !== 2) fail('moving a panel to another string did not rewire it');
if (order().length !== 3) fail('the moved panel still feeds its old string');

// Out of the array: its node goes, and its optimizer is offered again.
const outer = query(tiles('pv_a')[0], 'select.sa-panel-move');
const outId = tiles('pv_a')[0].dataset.node;
outer.value = '__remove';
outer.onchange({});
if (flow().Nodes.some(n => n.Id === outId) || flow().Links.some(l => l.From === outId)) fail('taking a panel out left its node or its link behind');

// A string feeds an MPPT, chosen here.
const mppt = query(query(sec, '.sa-string', true).find(s => s.dataset.node === 'pv_a'), 'select.sa-mppt');
mppt.value = 'mppt_2';
mppt.onchange({});
const from = flow().Links.filter(l => l.From === 'pv_a');
if (from.length !== 1 || from[0].To !== 'mppt_2') fail(`rewiring a string to another MPPT left ${JSON.stringify(from)}`);

// A new string.
promptAnswer = 'South roof';
button('+ New string').onclick();
const made = flow().Nodes.find(n => n.Label === 'South roof');
if (!made || !(made.Tags || []).includes('pv-string') || made.Kind !== 'solar') fail('a new string was not created as a tagged solar node');
if (query(sec, '.sa-string', true).length !== 3) fail('the new, empty string is not drawn');

// --- Without the plugin, the page says so -------------------------------------------------------------------
pluginLoaded = false;
snapshot = null;
await open();
if (!/plugin is not loaded/.test(query(sec, '.sa-buses').textContent)) fail(`a missing plugin is not reported: "${query(sec, '.sa-buses').textContent}"`);

console.log('solar: strings drawn in wired order with each panel live, a low panel flagged and a quiet one dimmed; '
  + 'an optimizer heard on the bus becomes a solar node bound for power, voltage, current and temperature and '
  + 'wired into its string; panels reorder, move between strings and come out of the array; a string is wired to '
  + 'its MPPT here; a new string is a tagged node; and a missing plugin is said');

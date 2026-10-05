// Solar Array page check.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const page = (f) => readFile(new URL('../../plugins/rPDU2MQTT.Plugin.Tigo/wwwroot/solar-array.' + f, import.meta.url), 'utf8');
const pageJs = await page('js'), pageCss = await page('css');
const typesJs = await readFile(new URL('../../plugins/rPDU2MQTT.Plugin.Tigo/wwwroot/panel-types.js', import.meta.url), 'utf8');
const pages = [{ id: 'solar-array', title: 'Solar Array', group: 'Energy Flow', icon: '☀', configSection: 'EnergyFlow' },
  { id: 'panel-types', title: 'Panel Types', group: 'Energy Flow', icon: '▦', configSection: 'Plugins' }];
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
  connections: [{ id: 'roof', name: 'Roof', mode: 'listen', connected: true, standby: false, gatewayId: '1209', lastAnswerSeconds: 0.5, otherController: false, state: { level: 'good', summary: 'TAP answering', detail: 'TAP 1209 answered 0 s ago; 2 optimizer(s) seen, 2 reporting' } }],
  optimizers: [reading(1, 300), reading(2, 310), reading(3, 120), reading(4, 0, 900), reading(5, 305), reading(6, 299)],
};

const seriesAsked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/flow/series') && (seriesAsked.push(url), true) ? { ok: true, at: ['2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z'],
      series: [{ node: 'pv_a', label: 'A', values: [500, 600] }, { node: 'mppt_1', values: [9, 9] }] }
    : url.endsWith('/api/flow/live') ? { ok: true, values: [
      { node: 'mppt_1', metric: 'voltage', value: 400 }, { node: 'mppt_1', metric: 'current', value: 2.5 }, { node: 'mppt_1', metric: 'realpower', value: 1000 }] }
    : url.includes('/api/flow/live?at=') ? { ok: true, historical: true, values: [1, 2, 3, 4, 5, 6].flatMap(i => [
      { node: 'tigo_' + serial(i).toLowerCase(), metric: 'realpower', value: 111 + i },
      { node: 'tigo_' + serial(i).toLowerCase(), metric: 'voltage', value: 30 }]) }
    : url.includes('/api/integrations/tigo/optimizers') ? { ok: true, result: snapshot }
    : url.endsWith('/api/integrations/tigo/pages/solar-array.js') ? pageJs
    : url.endsWith('/api/integrations/tigo/pages/solar-array.css') ? pageCss
    : url.endsWith('/api/integrations/tigo/pages/panel-types.js') ? typesJs
    : url.endsWith('/api/integrations') ? { ok: true, integrations: [{ id: 'tigo', pages }] }
    : url.includes('/api/schema') ? schema
    : url.includes('/api/config') ? { History: { Enabled: false }, EnergyFlow: { Nodes: nodes, Links: links },
      Plugins: { tigo: { PanelTypes: [{ Id: 'q', Manufacturer: 'Q', Model: 'PEAK 400', Watts: 400, Voc: 45.3, Isc: 11.1 }] } } }
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
if (/Solar Array|sa-panel/.test(code)) fail('the Solar Array page is still in the host bundle');
const open = async () => { link.click(); await wait(60); };
await open();
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const flow = () => vm.runInContext('exportData().EnergyFlow', sandbox);
const tiles = (stringId) => query(query(sec, '.sa-string', true).find(s => s.dataset.node === stringId), '.sa-panel', true);
const button = (text, scope = sec) => query(scope, 'button', true).find(b => b.textContent === text);

if (query(sec, '.sa-string', true).length !== 1) fail('an empty string is drawn outside Edit');
const a = tiles('pv_a');
if (a.map(t => t.dataset.node).join() !== [1, 2, 3, 4].map(i => 'tigo_' + serial(i).toLowerCase()).join()) fail('string A is not in wired order');
if (!/300 W/.test(a[0].textContent)) fail(`a panel does not show its power: ${a[0].textContent}`);
if (!a[2].classList.contains('is-low')) fail('a panel well under its string’s output is not flagged');
if (!a[3].classList.contains('is-quiet')) fail('a panel that stopped reporting is not shown as quiet');
if (!/kW/.test(query(sec, '.sa-string-total').textContent)) fail('a string does not total its panels');
if (!/TAP answering/.test(query(sec, '.sa-bus').textContent)) fail('the bus state is not shown');

// The MPPT's own readings show on the strings it feeds.
await wait(30);
const boxOf = (stringId) => query(sec, '.sa-mppt-box', true).find(b => query(b, '.sa-string', true).some(x => x.dataset.node === stringId));
const aBox = boxOf('pv_a');
if (!aBox || !/^MPPT 1/.test(query(aBox, '.sa-mppt-head').textContent)) fail(`string A is not inside its MPPT's box: ${aBox?.textContent}`);
if (!/400 V · 2.5 A · 1.00 kW/.test(query(aBox, '.sa-mppt-now')?.textContent || '')) fail(`the MPPT box does not show its readings: ${query(aBox, '.sa-mppt-now')?.textContent}`);
if (boxOf('pv_b') === aBox) fail('strings on different MPPTs share a box');

// Temperatures follow Gui.TemperatureUnits.
vm.runInContext("state.data.Gui = { TemperatureUnits: 'fahrenheit' }", sandbox);
button('Temp').onclick();
if (!/104 °F/.test(tiles('pv_a')[0].textContent)) fail(`a temperature is not shown in °F: ${tiles('pv_a')[0].textContent}`);
vm.runInContext("state.data.Gui = { TemperatureUnits: 'celsius' }", sandbox);
button('Temp').onclick();
if (!/40 °C/.test(tiles('pv_a')[0].textContent)) fail(`a temperature is not shown in °C: ${tiles('pv_a')[0].textContent}`);
vm.runInContext('delete state.data.Gui', sandbox);
button('Power').onclick();

// History: the timeline picks a moment; unticking returns to live.
const pastOn = query(query(sec, '.sa-time'), 'input');
pastOn.checked = true;
pastOn.onchange({});
await wait(40);
if (!/112 W/.test(tiles('pv_a')[0].textContent)) fail(`the timeline's moment does not show recorded values: ${tiles('pv_a')[0].textContent}`);
if (!/Showing/.test(query(sec, '.sa-buses').textContent)) fail('the page does not say it is showing a past time');
if (query(sec, '.trend-timeline').hidden) fail('the timeline is not shown');
if (!/nodes=pv_a%2Cpv_b|nodes=pv_a,pv_b/.test(seriesAsked.at(-1) || '')) fail(`the timeline asks for every node, not the strings: ${seriesAsked.at(-1)}`);
pastOn.checked = false;
pastOn.onchange({});
await wait(30);
if (!/300 W/.test(tiles('pv_a')[0].textContent)) fail('unticking does not return to live values');

// Adopting an optimizer.
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

// Arranging.
button('Edit').onclick();
const order = () => flow().Links.filter(l => l.To === 'pv_a').map(l => l.From);
const first = order()[0];
button('›', tiles('pv_a')[0]).onclick({ stopPropagation() { } });
if (order()[1] !== first) fail(`moving a panel right did not reorder the string: ${order()}`);

// Moving to another string.
const mover = query(tiles('pv_a')[0], 'select.sa-panel-move');
mover.value = 'pv_b';
mover.onchange({});
if (flow().Links.filter(l => l.To === 'pv_b').length !== 2) fail('moving a panel to another string did not rewire it');
if (order().length !== 3) fail('the moved panel still feeds its old string');

// Removing a panel from the array.
const outer = query(tiles('pv_a')[0], 'select.sa-panel-move');
const outId = tiles('pv_a')[0].dataset.node;
outer.value = '__remove';
outer.onchange({});
if (flow().Nodes.some(n => n.Id === outId) || flow().Links.some(l => l.From === outId)) fail('taking a panel out left its node or its link behind');

// Rewiring a string's MPPT.
const mppt = query(query(sec, '.sa-string', true).find(s => s.dataset.node === 'pv_a'), 'select.sa-mppt');
mppt.value = 'mppt_2';
mppt.onchange({});
const from = flow().Links.filter(l => l.From === 'pv_a');
if (from.length !== 1 || from[0].To !== 'mppt_2') fail(`rewiring a string to another MPPT left ${JSON.stringify(from)}`);

// Panel types: a whole string, then one panel.
const aCard = () => query(sec, '.sa-string', true).find(s => s.dataset.node === 'pv_a');
const kinds = query(query(aCard(), '.sa-string-head'), 'select.sa-type');
kinds.value = 'q';
kinds.onchange({});
const typed = flow().Nodes.filter(n => order().includes(n.Id));
if (!typed.length || !typed.every(n => n.Sources.every(s => s.Settings?.PanelType === 'q'))) fail('setting a string’s panel type did not reach every panel');
const rating = () => query(aCard(), '.sa-string-rating')?.textContent || '';
if (!/Voc 91 V/.test(rating()) || !/Isc 11\.1 A/.test(rating()) || !/0\.80 kWp/.test(rating())) fail(`the string rating is wrong: ${rating()}`);
const one = query(tiles('pv_a')[0], 'select.sa-type');
one.value = '';
one.onchange({});
if (!/1\/2 typed/.test(rating())) fail(`clearing one panel's type is not reflected: ${rating()}`);
const untracked = query(aCard(), '.sa-untracked-edit');
query(untracked, 'input').value = '2';
const untrackedType = query(untracked, 'select.sa-type');
untrackedType.value = 'q';
untrackedType.onchange({});
const stored = vm.runInContext('exportData().Plugins.tigo.StringPanels', sandbox);
if (stored?.pv_a?.Panels !== 2 || stored.pv_a.PanelType !== 'q') fail(`panels without optimizers stored as ${JSON.stringify(stored)}`);
if (!/Voc 136 V/.test(rating()) || !/3\/4 typed/.test(rating())) fail(`panels without optimizers are not in the rating: ${rating()}`);
if (query(aCard(), '.is-untracked', true).length !== 2) fail('panels without optimizers are not drawn');

// MPPT limits: a string's Voc over the maximum is an error on the string and on its MPPT.
const mpptCard = query(sec, '.sa-mppt-card', true).find(c => /MPPT 2/.test(c.textContent));
if (!mpptCard) fail('there is no MPPT card for the MPPT string A feeds');
const maxV = query(mpptCard, 'input', true)[0];
maxV.value = '100';
maxV.onchange({});
const limits = () => vm.runInContext('exportData().Plugins.tigo.Mppts', sandbox) || {};
if (limits().mppt_2?.MaxVoltage !== 100) fail(`MPPT limits stored as ${JSON.stringify(limits())}`);
if (!query(aCard(), '.is-bad', true).some(x => /Voc 136 V at STC exceeds the 100 V maximum/.test(x.textContent))) fail(`string A does not warn that its Voc is too high: ${aCard().textContent}`);
const tempIn = query(query(sec, '.sa-mppts'), 'input');
tempIn.value = '-20';
tempIn.onchange({});
if (vm.runInContext('exportData().Plugins.tigo.DesignMinTempC', sandbox) !== -20) fail('the coldest temperature is not stored');
const maxVAgain = query(query(sec, '.sa-mppt-card', true).find(c => /MPPT 2/.test(c.textContent)), 'input', true)[0];
maxVAgain.value = '';
maxVAgain.onchange({});
if (limits().mppt_2) fail(`clearing the only limit left ${JSON.stringify(limits().mppt_2)}`);

// Reordering strings: only the strings move among themselves.
const stringOrder = () => flow().Nodes.filter(n => (n.Tags || []).includes('pv-string')).map(n => n.Id);
const others = () => flow().Nodes.filter(n => !(n.Tags || []).includes('pv-string')).map(n => n.Id).join();
const before = others();
const bHead = query(query(sec, '.sa-string', true).find(x => x.dataset.node === 'pv_b'), '.sa-string-head');
query(bHead, 'button', true).find(b => b.title === 'Move string left').onclick();
if (stringOrder().join() !== 'pv_b,pv_a') fail(`moving a string left gave ${stringOrder()}`);
if (others() !== before) fail('reordering strings moved other nodes');
if (query(sec, '.sa-string', true)[0].dataset.node !== 'pv_b') fail('the reordered strings are not drawn in their new order');

// Columns and Hidden, stored per string.
const cardOf = (id) => query(sec, '.sa-string', true).find(x => x.dataset.node === id);
const colsSel = query(cardOf('pv_a'), 'select.sa-cols');
colsSel.value = '4';
colsSel.onchange({});
const layout = () => vm.runInContext('exportData().Plugins.tigo.Strings', sandbox) || {};
if (layout().pv_a?.Columns !== 4) fail(`columns stored as ${JSON.stringify(layout())}`);
if (query(cardOf('pv_a'), '.sa-panels').style.getPropertyValue?.('--sa-cols') === '3') fail('columns are not applied in Edit');
const hideBox = query(query(cardOf('pv_b'), '.sa-hide'), 'input');
hideBox.checked = true;
hideBox.onchange({});
if (layout().pv_b?.Hidden !== true) fail('Hidden is not stored');
if (!cardOf('pv_b')) fail('a hidden string is not shown in Edit');
button('Done').onclick();
if (cardOf('pv_b')) fail('a hidden string is shown outside Edit');
button('Edit').onclick();
query(query(cardOf('pv_b'), '.sa-hide'), 'input').checked = false;
query(query(cardOf('pv_b'), '.sa-hide'), 'input').onchange({});
if (layout().pv_b) fail(`un-hiding left ${JSON.stringify(layout().pv_b)}`);

// Group panels by string.
const groupBox = query(query(sec, '.sa-head'), 'input');
groupBox.checked = true;
groupBox.onchange({});
const groups = () => (flow().Groups || []);
const ga = groups().find(g => g.Id === 'pv_a');
if (!ga || ga.Members.join() !== order().join()) fail(`string A's group is ${JSON.stringify(ga)}, not its panels ${order()}`);
if (!groups().find(g => g.Id === 'pv_b')) fail('string B has no group');
const firstA = order()[0];
const mv = query(tiles('pv_a')[0], 'select.sa-panel-move');
mv.value = 'pv_b';
mv.onchange({});
if (groups().find(g => g.Id === 'pv_a')?.Members.includes(firstA)) fail('a moved panel stayed in its old string’s group');
if (!groups().find(g => g.Id === 'pv_b')?.Members.includes(firstA)) fail('a moved panel is not in its new string’s group');
groupBox.checked = false;
groupBox.onchange({});
if (groups().some(g => g.Id === 'pv_a' || g.Id === 'pv_b')) fail('turning grouping off left string groups behind');

// A new string.
promptAnswer = 'South roof';
button('+ New string').onclick();
const made = flow().Nodes.find(n => n.Label === 'South roof');
if (!made || !(made.Tags || []).includes('pv-string') || made.Kind !== 'solar') fail('a new string was not created as a tagged solar node');
if (query(sec, '.sa-string', true).length !== 3) fail('the new, empty string is not drawn');

// The Panel Types page.
const typesLink = query(getEl('nav'), 'a', true).find(x => x.dataset.label === 'Panel Types');
if (!typesLink) fail('there is no Panel Types page');
typesLink.click(); await wait(60);
const tsec = query(getEl('sections'), '.section', true).find(x => x.classList.contains('active'));
if (query(tsec, '.pt-card', true).length !== 1) fail('the existing panel type is not listed');
button('+ Add type', tsec).onclick();
const made2 = query(tsec, '.pt-card', true)[1];
const maker = query(made2, 'input');
maker.value = 'REC';
maker.onchange({});
const saved = vm.runInContext('exportData().Plugins.tigo.PanelTypes', sandbox);
if (saved.length !== 2 || saved[1].Manufacturer !== 'REC' || saved[1].Id !== 'rec') fail(`adding a panel type wrote ${JSON.stringify(saved)}`);
if (!query(query(tsec, '.pt-card', true)[0], 'button').disabled) fail('a panel type in use can be removed');

console.log('solar: ok');

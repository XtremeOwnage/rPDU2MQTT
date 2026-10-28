// Floor Plans' network layer: wall jacks labelled with their port, patch panels and switches with numbered ports,
// a cable from a patch panel putting a jack on its first free port, the patch cord to a switch port, the layer
// hidden under Show, and the port schedule printed as a PDF.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const page = (f) => readFile(new URL('../../plugins/rPDU2MQTT.Plugin.Locations/wwwroot/floor-plans.' + f, import.meta.url), 'utf8');
const pageJs = await page('js'), css = await page('css');
const pages = [{ id: 'floor-plans', title: 'Floor Plans', group: 'Energy Flow', icon: '⌗', configSection: 'Plugins.locations' }];
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8')).filter(n => n.key !== '_README');
const fail = (m) => { console.error('network check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const rect = (x1, y1, x2, y2) => [{ X: x1, Y: y1 }, { X: x2, Y: y1 }, { X: x2, Y: y2 }, { X: x1, Y: y2 }];
const config = {
  History: { Enabled: false },
  Gui: { DistanceUnits: 'imperial' },
  Plugins: {
    locations: {
      Sites: [{
        Id: 'home', Name: 'Home',
        Floors: [{
          Id: 'ground', Name: 'Ground', Level: 0, Width: 1000, Height: 700, Image: '',
          Rooms: [{ Id: 'office', Name: 'Office', Shape: rect(0, 0, 400, 300) }, { Id: 'closet', Name: 'Closet', Shape: rect(400, 0, 700, 300) }],
        }],
      }],
      Placements: [
        { Id: 'patch_panel_1', Kind: 'patch-panel', Label: '', Room: 'closet', Floor: 'ground', X: 550, Y: 150, Ports: 24 },
        { Id: 'network_switch_1', Kind: 'network-switch', Label: 'Core', Room: 'closet', Floor: 'ground', X: 550, Y: 220, Ports: 8 },
        { Id: 'jack_1', Kind: 'jack', Label: '', Room: 'office', Floor: 'ground', X: 0, Y: 150, Facing: 0, Port: 'patch_panel_1/3' },
      ],
    },
  },
  EnergyFlow: { Nodes: [], Links: [], Panels: [] },
};
const loc = () => config.Plugins.locations;
const item = (id) => loc().Placements.find(p => p.Id === id);

const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    const action = (result) => ({ ok: true, result });
    if (url.includes('/api/integrations/locations/totals'))
      return action({ ok: true, metric: 'realpower', units: 'W', problems: [], message: null, places: [], circuits: [], nodes: [], placements: [] });
    if (url.includes('/api/plans/storage')) return { ok: true, persistent: true, configWritable: true };
    if (url.endsWith('/api/integrations/locations/pages/floor-plans.js')) return pageJs;
    if (url.endsWith('/api/integrations/locations/pages/floor-plans.css')) return css;
    if (url.endsWith('/api/integrations')) return { ok: true, integrations: [{ id: 'locations', pages }] };
    if (url.includes('/api/schema')) return schema;
    if (url.includes('/api/instances')) return { ok: true, instances: [] };
    if (url.includes('/api/config')) return config;
    if (url.includes('/api/flow')) return { ok: true, nodes: [], links: [] };
    return { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(50);

query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Floor Plans').click();
await wait(100);
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const svg = query(sec, 'svg.fp-svg');
svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1060, height: 760 });
const at = (x, y) => ({ clientX: x + 30, clientY: y + 30 });
const textOf = (n) => (n?.textContent || '').replace(/\s+/g, ' ');
const button = (text, root = sec) => query(root, 'button', true).find(b => (b.textContent || '').trim() === text);
const toolBtn = (name) => query(sec, '.fp-tool', true).find(b => b.getAttribute('aria-label') === name);
const itemEl = (id) => query(sec, 'g', true).find(g => g.dataset?.item === id && g.classList.contains('fp-item'));
const labels = () => query(sec, 'text', true).map(t => t.textContent);
const side = () => query(sec, '.fp-side');
const sheet = () => query(getEl('overlay'), '.sheet');
const key = (k, extra = {}) => sandbox.window.dispatch('keydown', { key: k, target: { tagName: 'BODY' }, preventDefault() { }, ...extra });
let pid = 1;
const tap = (target, x, y) => {
  const id = pid++;
  svg.dispatch('pointerdown', { ...at(x, y), pointerId: id, button: 0, target });
  svg.dispatch('pointerup', { ...at(x, y), pointerId: id, target });
};
const pick = (ss, text) => {
  query(ss, 'button', false).onclick();
  const opt = query(ss, '.ss-opt', true).find(o => textOf(o).includes(text));
  if (!opt) fail(`no "${text}" to pick: ${query(ss, '.ss-opt', true).map(textOf).join(' | ')}`);
  opt.onclick();
};

// Every jack is labelled with its port on the plan; the patch panel and switch with their names.
if (!labels().includes('PP1-03')) fail(`the jack is not labelled with its port: ${JSON.stringify(labels())}`);
if (!labels().includes('Patch panel 1') || !labels().includes('Core')) fail(`the patch panel and switch are not named: ${JSON.stringify(labels())}`);
if (!/Network/.test(textOf(query(sec, '.fp-legend'))) || !/Patch panel 1\s*1\/24/.test(textOf(query(sec, '.fp-legend')))) fail(`the legend does not list the patch panel and how full it is: ${textOf(query(sec, '.fp-legend'))}`);
if (itemEl('jack_1').classList.contains('is-unknown')) fail('a jack on a port is marked unknown');

// Edit's Network mode: a jack placed by the office's bottom wall sits on it, and is on no port yet.
button('Edit').onclick();
query(sec, '.fp-layer', true).find(b => textOf(b) === 'Network').onclick();
toolBtn('Item').onclick();
const jackKind = query(sec, '.fp-kind', true).find(b => b.getAttribute('aria-label') === 'Network jack');
if (!jackKind || !/Network/.test(textOf(query(sec, '.fp-kinds')))) fail('the item picker has no Network group with a jack');
if (query(sec, '.fp-kind', true).some(b => b.getAttribute('aria-label') === 'Outlet')) fail('the Network mode offers outlets to place');
jackKind.onclick();
tap(svg, 100, 290);
const jack2 = loc().Placements.at(-1);
if (jack2.Kind !== 'jack' || jack2.Y !== 300 || jack2.Facing !== 270) fail(`a jack dropped by a wall did not sit on it facing the room: ${JSON.stringify(jack2)}`);
if (!itemEl(jack2.Id).classList.contains('is-unknown')) fail('a jack on no port is not marked as unknown');
query(sec, '.fp-kind', true).find(b => b.getAttribute('aria-label') === 'Patch panel').onclick();
tap(svg, 600, 100);
if (loc().Placements.at(-1).Ports !== 24) fail(`a new patch panel does not have 24 ports: ${JSON.stringify(loc().Placements.at(-1))}`);
key('z', { ctrlKey: true });

// A cable from the patch panel to the new jack, drawn as a circuit wire, is a network cable, and puts the jack on the
// panel's first free port.
toolBtn('Wire').onclick();
tap(itemEl('patch_panel_1'), 550, 150);
tap(svg, 300, 150);
tap(itemEl(jack2.Id), 100, 300);
const cable = loc().Runs?.at(-1);
if (!cable || cable.Kind !== 'network' || cable.Circuit !== '' || cable.From !== 'patch_panel_1' || cable.To !== jack2.Id) fail(`the cable is not a network cable from the panel to the jack: ${JSON.stringify(cable)}`);
if (item(jack2.Id).Port !== 'patch_panel_1/1') fail(`cabling the jack did not put it on the first free port: ${item(jack2.Id).Port}`);
if (!labels().includes('PP1-01')) fail('the cabled jack is not labelled with its new port');
if (!query(sec, 'g', true).some(g => g.classList.contains('fp-run') && g.classList.contains('is-network'))) fail('the network cable is not drawn');

// The jack's panel picks its patch panel port and the switch port its cord goes to.
toolBtn('Select').onclick();
tap(itemEl(jack2.Id), 100, 300);
const [portPick, swPick] = query(side(), '.ss', true);
if (!portPick || !swPick) fail(`the jack's panel has no port and switch port pickers: ${textOf(side())}`);
pick(swPick, 'Core · port 2');
if (JSON.stringify(item('patch_panel_1').Patches) !== JSON.stringify([{ Port: 1, Switch: 'network_switch_1/2' }])) fail(`the patch cord was not kept on the patch panel: ${JSON.stringify(item('patch_panel_1').Patches)}`);
// Putting it on a port another jack has takes that jack off it, and says so.
pick(query(side(), '.ss', true)[0], 'Patch panel 1 · port 3');
if (item(jack2.Id).Port !== 'patch_panel_1/3' || item('jack_1').Port !== '') fail(`two jacks share a port: ${item(jack2.Id).Port}, ${item('jack_1').Port}`);
key('z', { ctrlKey: true });
if (item(jack2.Id).Port !== 'patch_panel_1/1' || item('jack_1').Port !== 'patch_panel_1/3') fail('undo did not put both jacks back on their ports');

// The patch panel lists its ports: the jack on each and the switch port it is patched to.
tap(itemEl('patch_panel_1'), 550, 150);
const ports = query(side(), '.fp-port', true);
if (ports.length !== 24) fail(`the patch panel does not list its 24 ports: ${ports.length}`);
if (!/^1\s*PP1-01 · Office/.test(textOf(ports[0])) || query(ports[0], 'select', false)?.value !== 'network_switch_1/2') fail(`port 1 does not show its jack and its cord: ${textOf(ports[0])}`);
// Selecting it brings its jacks forward.
if (itemEl('jack_1').classList.contains('is-dim') || !itemEl('network_switch_1').classList.contains('is-dim')) fail('selecting the patch panel did not bring its jacks forward');
key('Escape');

// Show › Network hides the jacks, the gear and the cables.
const netBox = query(query(sec, '.fp-show-menu'), 'label', true).find(l => textOf(l).trim() === 'Network');
if (!netBox) fail('Show has no Network choice');
const netIn = query(netBox, 'input', false);
netIn.checked = false; netIn.onchange();
if (itemEl('jack_1') || query(sec, 'g', true).some(g => g.classList.contains('is-network'))) fail('hiding the network left jacks or cables drawn');
const back = query(query(query(sec, '.fp-show-menu'), 'label', true).find(l => textOf(l).trim() === 'Network'), 'input', false);
back.checked = true; back.onchange();
if (!itemEl('jack_1')) fail('showing the network again did not draw the jacks');

// Deleting the patch panel leaves its jacks on no port.
tap(itemEl('patch_panel_1'), 550, 150);
key('Delete');
if (item('jack_1').Port !== '' || item(jack2.Id).Port !== '') fail('jacks still name a patch panel that is gone');
key('z', { ctrlKey: true });

// The port schedule: every port of every patch panel and switch, as a PDF, saved or printed.
button('View').onclick();
const saves = [];
sandbox.Blob = class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type; } };
sandbox.URL = { createObjectURL: (b) => { saves.push(b); return 'blob:export'; }, revokeObjectURL() { } };
const downloads = [];
const made = sandbox.document.createElement;
sandbox.document.createElement = (t) => { const e = made(t); if (t === 'a') e.click = () => downloads.push(e.download); return e; };
button('Export…').onclick();
const opt = query(getEl('overlay'), 'button', true).find(b => b.textContent === 'Network port schedule');
if (!opt) fail('Export offers no port schedule');
await opt.onclick();
if (!/2 patch panels and switches, 3 of 32 ports in use/.test(textOf(sheet()))) fail(`the schedule sheet does not say what it holds: ${textOf(sheet())}`);
button('Save PDF', sheet()).onclick();
if (downloads.at(-1) !== 'port-schedule.pdf' || saves.at(-1)?.type !== 'application/pdf') fail(`the schedule was not saved as a PDF: ${downloads.at(-1)}`);
const pdf = Buffer.from(saves.at(-1).parts[0]).toString('latin1');
if (!pdf.startsWith('%PDF-1.4') || !pdf.trimEnd().endsWith('%%EOF')) fail('the schedule is not a PDF');
for (const t of ['Network port schedule', 'Patch panel 1', 'PP1-01', 'PP1-03', 'Core-2', 'Office', 'SWITCH PORT', 'PATCHED FROM'])
  if (!pdf.includes(`(${t}) Tj`)) fail(`the schedule does not print ${t}`);

console.log('network check: jacks labelled by port, cabling to a free port, patch cords, ports listed, Show, delete and the port schedule OK');

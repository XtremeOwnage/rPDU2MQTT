// "Hide empty" on the Flow diagram: a rack of switched-off outlets is most of the picture and none of the
// information. What it must NOT hide is a node with no data (a gap in the model, not an empty branch) or a
// zero node still on a live supply path (the solar chain after dark).
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('hide-empty check FAILED: ' + m); process.exit(1); };

// A PDU carrying 3 A: one live outlet, one switched off, a dead branch below it, a modelled node nothing
// measures, and a solar chain reading zero into a live inverter.
const graph = {
  ok: true, metric: 'current', units: 'A',
  nodes: [
    { id: 'pdu', label: 'Rack-PDU-1', value: 3 },
    { id: 'live_outlet', label: 'Dell r730XD', value: 3 },
    { id: 'off_outlet', label: 'outlet_9', value: 0 },
    { id: 'dead_branch', label: 'Sub Board', value: 0 },
    { id: 'dead_twig', label: 'Outlet 6', value: 0 },
    { id: 'unmodelled', label: 'Sub Panel', value: null },
    { id: 'mppt', label: 'MPPT_1', value: 0 },
    { id: 'solar', label: 'Solar (PV)', value: 0 },
    { id: 'inverter', label: 'EG4 FlexBoss 21', value: 3 },
  ],
  links: [
    { source: 'pdu', target: 'live_outlet', value: 3 },
    { source: 'pdu', target: 'off_outlet', value: 0 },
    { source: 'pdu', target: 'dead_branch', value: 0 },
    { source: 'dead_branch', target: 'dead_twig', value: 0 },
    { source: 'pdu', target: 'unmodelled', value: 0 },
    { source: 'mppt', target: 'solar', value: 0 },
    { source: 'solar', target: 'inverter', value: 0 },
    { source: 'inverter', target: 'pdu', value: 3 },
  ],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] } } :
    url.includes('/api/flow') ? graph :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

const flowLink = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow');
if (!flowLink) fail('no Flow tab');
flowLink.click();
await new Promise(r => setTimeout(r, 200));

const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const drawn = () => query(sec, 'text', true).map(t => t.textContent || '').join(' | ');

// The switch is on out of the box, and it is where the other view switches are.
const box = query(sec, 'label', true).find(l => /Hide empty/.test(l.textContent || ''));
if (!box) fail('no "Hide empty" switch on the diagram');
const cb = query(box, 'input', true)[0];
if (!cb?.checked) fail('the switch is not on by default');

let labels = drawn();
if (/outlet_9/.test(labels)) fail(`a switched-off outlet was drawn: ${labels}`);
if (/Sub Board|Outlet 6/.test(labels)) fail(`a branch carrying nothing was drawn: ${labels}`);
if (!/Dell r730XD/.test(labels)) fail(`a live outlet was hidden: ${labels}`);

// A node nothing measures says "no data" and stays: hiding it buries the gap.
if (!/Sub Panel/.test(labels)) fail(`a node with no data was hidden as though it were empty: ${labels}`);

// The solar chain after dark reads zero all the way to a live inverter, and is still the supply path.
if (!/MPPT_1/.test(labels) || !/Solar/.test(labels))
  fail(`a zero chain feeding a live node was cut off: ${labels}`);

// The one-click periods belong on every page with a time control, this one included.
const periodNames = ['Today', 'Yesterday', 'This week', 'This month', 'This year'];
const buttons = query(sec, 'button', true).map(b => b.textContent);
const missing = periodNames.filter(n => !buttons.includes(n));
if (missing.length) fail(`the Flow page has no ${missing.join(', ')} button — the date box is not a period`);

// Turning it off brings everything back.
cb.checked = false;
cb.onchange({});
await new Promise(r => setTimeout(r, 200));
labels = drawn();
if (!/outlet_9/.test(labels)) fail(`the switch does not turn the filter off: ${labels}`);

console.log('hide-empty: on by default; a switched-off outlet and a branch carrying nothing go, a node '
  + 'with no data stays, and a zero chain feeding something live stays connected');

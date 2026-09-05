// An alert on the Overview page opens onto the bindings behind it.
//
// The complaint this covers: the page said "MQTT sources — No data yet / 2 of 46 binding(s) withheld" and
// stopped there. A count is not a diagnosis — it reports that something is wrong and nothing about what,
// while the reason was already known and merely lived on another page. IWithheldSources exists precisely
// because "a value that quietly vanishes is its own kind of dishonesty"; a count is the same silence with
// a number in front of it.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('withheld-detail check FAILED: ' + m); process.exit(1); };

// Two ingests are withholding something, for different reasons. Only the MQTT ones belong to the MQTT card.
const withheld = { ok: true, sources: [
  { node: 'deep_freezer', source: 'esphome/devices/deep_freezer/sensor/energy_d/state', metric: 'energy',
    reason: 'declared as a lifetime counter but it restarts each day, so it is not the total it claims',
    integration: 'mqtt-source' },
  { node: 'eg4-flexboss21-solar', source: 'solar_assistant/total/pv_energy/state', metric: 'energy',
    reason: '335.4 is below the 432.24 already published', integration: 'mqtt-source' },
  { node: 'main_panel', source: 'unit 1 · register 40088', metric: 'realpower',
    reason: 'the device has not answered since 09:14', integration: 'modbus-source' },
] };

const board = { ok: true, cards: [
  { id: 'mqtt-source', title: 'MQTT sources', level: 'warn', state: 'Some sources stale',
    detail: '2 of 46 binding(s) withheld' },
  { id: 'pdu', title: 'Vertiv rPDU', level: 'good', state: 'Polling', detail: '2 device(s)' },
] };

const power = { ok: true, units: 'W', nodes: [{ id: 'solar', label: 'Solar', kind: 'solar', value: 4820 }] };
const energy = { ok: true, units: 'kWh', nodes: [{ id: 'solar', label: 'Solar', kind: 'solar', value: 28.9 }] };

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: false } } :
    url.includes('/api/flow/withheld') ? withheld :
    url.includes('/api/status/board') ? board :
    url.includes('/api/flow/series') ? { ok: true, series: [] } :
    url.includes('/api/flow/live') ? { ok: true, values: [] } :
    url.includes('metric=energytoday') ? energy :
    url.includes('/api/flow') ? power :
    url.includes('/api/time') ? { ok: true, period: null } :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Overview');
if (!link) fail('no Overview page in the nav');
link.click();
await new Promise(r => setTimeout(r, 400));

const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('the Overview section did not activate');

// --- The alert is still there, and still says how many ------------------------------------------------
const alert = query(sec, '.ov-alert', true).find(a => (a.textContent || '').includes('MQTT sources'));
if (!alert) fail('the MQTT sources alert is not on the page');
if (!alert.textContent.includes('2 of 46')) fail('the alert stopped reporting the count');

// --- …and it can be opened, which is the whole point --------------------------------------------------
const more = query(alert, 'button', true)[0];
if (!more) fail('the alert offers no way to see which bindings are being withheld');
if (!/withheld binding/i.test(more.textContent || ''))
  fail(`the control does not say what it opens: "${more.textContent}"`);

const detail = query(alert, '.ov-alert-detail', true)[0];
if (!detail) fail('the alert has no detail region');
if (!detail.hidden) fail('the detail is open before it is asked for');

more.click();
await new Promise(r => setTimeout(r, 20));
if (detail.hidden) fail('clicking the control did not reveal the bindings');

// --- What it reveals is the reason, not another count -------------------------------------------------
const text = detail.textContent || '';
for (const want of ['deep_freezer', 'restarts each day', 'eg4-flexboss21-solar', 'below the 432.24'])
  if (!text.includes(want)) fail(`the detail does not name "${want}": ${text}`);
// The topic is what you go and fix, so it has to be there verbatim.
if (!text.includes('esphome/devices/deep_freezer/sensor/energy_d/state'))
  fail('the detail does not give the topic to go and fix');

// --- One card shows its own bindings, not every ingest's ----------------------------------------------
if (text.includes('main_panel') || text.includes('register 40088'))
  fail('the MQTT card is showing a Modbus binding — a card must account for its own withheld readings only');

// --- It closes again ----------------------------------------------------------------------------------
more.click();
await new Promise(r => setTimeout(r, 20));
if (!detail.hidden) fail('the detail cannot be closed again');

// --- A healthy card is not given a control it has nothing to show behind -------------------------------
const good = query(sec, '.ov-alert', true).find(a => (a.textContent || '').includes('Vertiv rPDU'));
if (good && query(good, 'button', true).length) fail('a card with nothing withheld was given a disclosure control');

console.log('withheld-detail: the Overview alert keeps its count and opens onto the bindings behind it — '
  + 'each with its node, metric, topic and the reason it is being dropped — showing only the bindings '
  + 'belonging to that card, and closing again when asked');

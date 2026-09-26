// Which schema sections get a page of their own.
//
// Health, PlanStorage, Api and Cache do not: they are deployment settings — ports, a directory, a bucket, a
// cache endpoint — declared in the config file or the chart's values beside the volume, service or
// container that backs them. Debug's switches are on Diagnostics with the state they are used to read, and
// the feature switches are not edited in the GUI at all, so there is no Features page either.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('pages check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const config = { Debug: { PublishMessages: true }, Health: { Port: 8081 }, PlanStorage: { Directory: '' },
                 Api: { Enabled: true }, Cache: { Enabled: true }, Gui: { Enabled: true } };
const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? config
    : url.includes('/api/restart/targets') ? { ok: true, method: 'local', targets: [] }
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(150);

const pages = query(getEl('nav'), 'a', true).map(a => a.dataset.label);
for (const gone of ['Health', 'PlanStorage', 'Debug', 'API', 'Cache', 'Features'])
  if (pages.includes(gone)) fail(`${gone} still has a page of its own: ${pages.join(', ')}`);
// …while the pages that answer a question are all still there.
for (const kept of ['MQTT', 'History', 'Diagnostics', 'GUI', 'Status'])
  if (!pages.includes(kept)) fail(`${kept} lost its page: ${pages.join(', ')}`);

// The settings themselves are not gone — they are set in the config file and the chart's values, so the
// schema (and with it the CRD) must still carry them.
for (const section of ['Health', 'PlanStorage', 'Debug', 'Api', 'Cache'])
  if (!schema.some(n => n.key === section)) fail(`${section} is missing from the schema, so nothing can set it`);

// A page whose feature is switched elsewhere says where, and offers no switch of its own.
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'GUI').click();
await wait(100);
const gui = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const pointer = query(gui, '.feature-pointer')?.textContent || '';
if (!/configuration file/.test(pointer) || !/values/.test(pointer))
  fail(`the page does not say where its switch is: "${pointer}"`);
if (query(gui, '.field', true).some(f => f.dataset?.key === 'Enabled'))
  fail('the feature switch is still rendered on the page');

// Debug's switches are on Diagnostics, and an edit there is an edit to the config like any other.
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Diagnostics').click();
await wait(150);
const diag = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!diag) fail('the Diagnostics page did not open');
const debugBox = query(diag, '.diag-debug');
if (!debugBox) fail('the Debug settings are not on the Diagnostics page');
const fields = query(debugBox, '.field', true).map(f => f.textContent || '');
if (!fields.some(f => /Publish to MQTT/.test(f))) fail(`the Debug settings did not render: ${fields.join(' | ')}`);
if (!fields.some(f => /Discovery Payloads/.test(f))) fail(`only part of the Debug settings rendered: ${fields.join(' | ')}`);

const toggle = query(debugBox, 'input', true).find(i => i.type === 'checkbox');
if (!toggle) fail('the Debug switches did not render as switches');
toggle.checked = false;
toggle.onchange({});
await wait(50);
if (config.Debug.PublishMessages !== false) fail(`an edit on the Diagnostics page did not reach the config: ${JSON.stringify(config.Debug)}`);
const counted = getEl('save-count')?.textContent || '';
if (!/unsaved change/.test(counted)) fail(`the edit was not counted as an unsaved change: "${counted}"`);

console.log('pages: Health, PlanStorage, Api, Cache, Debug and Features have no page of their own, the schema '
  + 'still carries them, a page whose feature is switched elsewhere says where and offers no switch, and '
  + 'Debug\u2019s switches are on Diagnostics where an edit counts as an unsaved change');
process.exit(0);

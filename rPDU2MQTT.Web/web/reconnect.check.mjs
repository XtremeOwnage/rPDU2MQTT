// Coming back from a restart. The bridge going away is expected — an update, a switch, applying settings —
// but the tab used to sit there stale until someone reloaded it by hand.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('reconnect check FAILED: ' + m); process.exit(1); };
const tick = () => new Promise(r => setTimeout(r, 60));

let version = '1.0.0';
const config = { History: { Enabled: false }, MQTT: { ClientID: 'rpdu2mqtt' } };
const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? config
    : url.includes('/api/status') ? {
        ok: true, version, mqttConnected: true,
        restart: { required: true, settings: ['MQTT.ClientID'] },
      }
    : { ok: true },
});
let reloads = 0;
sandbox.location.reload = () => { reloads++; };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await tick();

// A toast's dismissal timer fires immediately under the stub's synchronous setTimeout, so they are
// recorded as they are raised rather than read off the tree afterwards.
const raised = [];
const host = getEl('toasts');
const appendToast = host.appendChild.bind(host);
host.appendChild = (c) => { raised.push(c.textContent || ''); return appendToast(c); };
const toasts = () => raised;
const restartPill = getEl('st-restart');
if (!restartPill.onclick) fail('the restart-required pill does nothing');

/// Take the bridge away and bring it back on `to`, the way the Restart button does.
const restartTo = async (to) => {
  const before = toasts().length;
  // What the bridge comes back as; the page polls for it the moment the restart is asked for.
  version = to;
  await restartPill.onclick();
  await tick();
  return toasts().slice(before);
};

// Restarted onto the same build: the page is still valid, so it reconnects rather than reloading.
let said = await restartTo('1.0.0');
if (reloads) fail('a restart onto the same build reloaded the page');
if (!said.some(t => /bridge is back/i.test(t))) fail(`nothing said the bridge came back: ${said.join(' | ')}`);

// Updated to a different build: this tab is running the old assets, so only a reload is honest.
said = await restartTo('1.1.0');
if (reloads !== 1) fail(`an update to a new build did not reload the page (reloads: ${reloads})`);
if (!said.some(t => /1\.1\.0/.test(t))) fail(`the reload was not explained: ${said.join(' | ')}`);

// …unless there is unsaved work, which a reload would throw away.
const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'MQTT');
link.click();
await new Promise(r => setTimeout(r, 200));
const field = query(getEl('sections'), '.field', true).find(f => f.dataset.path === 'MQTT.ClientID');
if (!field) fail('no MQTT.ClientID field to edit');
const input = query(field, 'input', true)[0];
input.value = 'edited';
input.onchange();
// The save bar's count is its own element in the stub's registry, not a child of the bar.
if (!/unsaved change/.test(getEl('save-count').textContent || ''))
  fail(`editing a field did not register as an unsaved change: "${getEl('save-count').textContent}"`);

said = await restartTo('1.2.0');
if (reloads !== 1) fail('the page reloaded over unsaved changes');
if (!said.some(t => /save or discard/i.test(t)))
  fail(`nothing told the operator their changes are holding the reload up: ${said.join(' | ')}`);

console.log('reconnect: a restart onto the same build reconnects in place, an update to a new build reloads '
  + 'the tab that is now running old assets, and unsaved changes hold that reload until they are dealt with');
process.exit(0);

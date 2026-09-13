// EmonCMS cleanup buttons: old inputs and feeds are listed and confirmed by name before anything is deleted.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('emoncmscleanup check FAILED: ' + m); process.exit(1); };

const asked = [];
let stale = { ok: true, inputs: ['rpdu2mqtt/old_outlet_power'], feeds: ['rpdu2mqtt/old_outlet_power', 'Virtual/Old outlet power'] };
const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/integrations/emoncms/')) {
      asked.push(url);
      if (url.includes('/stale')) return { ok: true, result: stale };
      return { ok: true, result: { ok: true, message: 'Deleted.' } };
    }
    return url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EmonCMS: { Enabled: true, Url: 'http://emon', Node: 'rpdu2mqtt' }, History: { Enabled: false } }
      : { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'EmonCMS');
if (!link) fail('there is no EmonCMS page');
link.click();
await new Promise(r => setTimeout(r, 150));
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const button = (text) => query(sec, 'button', true).find(b => b.textContent === text);
for (const t of ['Delete old inputs', 'Delete old feeds', 'Delete all feeds'])
  if (!button(t)) fail(`no "${t}" button on the EmonCMS page`);

const prompts = [];
sandbox.confirm = (m) => { prompts.push(m); return true; };

// Feeds: listed by name and warned about before the sweep is called.
asked.length = 0;
await button('Delete old feeds').onclick();
await new Promise(r => setTimeout(r, 50));
if (!asked.some(u => u.includes('/stale'))) fail('old feeds were deleted without being listed first');
if (!prompts.some(m => m.includes('Virtual/Old outlet power') && /history/.test(m))) fail(`the confirmation does not name the feeds or warn about their history: ${prompts.join(' | ')}`);
if (!asked.some(u => u.includes('/sweep-feeds'))) fail(`confirming did not delete the old feeds: ${asked.join(', ')}`);
if (asked.some(u => u.includes('/sweep-inputs') || u.includes('/delete-all-feeds'))) fail('deleting old feeds called another cleanup');

// Declined: nothing is deleted.
asked.length = 0;
sandbox.confirm = () => false;
await button('Delete old inputs').onclick();
await new Promise(r => setTimeout(r, 50));
if (asked.some(u => u.includes('/sweep-inputs'))) fail('declining the confirmation still deleted inputs');

// Nothing stale: nothing is asked and nothing is deleted.
asked.length = 0;
stale = { ok: true, inputs: [], feeds: [] };
let confirmed = false;
sandbox.confirm = () => { confirmed = true; return true; };
await button('Delete old inputs').onclick();
await new Promise(r => setTimeout(r, 50));
if (confirmed || asked.some(u => u.includes('/sweep-inputs'))) fail('with no old inputs it still asked to delete some');

// Delete all feeds goes to its own action, not the stale sweep.
asked.length = 0;
sandbox.confirm = () => true;
sandbox.prompt = () => 'DELETE';
await button('Delete all feeds').onclick();
await new Promise(r => setTimeout(r, 50));
if (!asked.some(u => u.includes('/delete-all-feeds'))) fail(`"Delete all feeds" did not call delete-all-feeds: ${asked.join(', ')}`);

console.log('emoncmscleanup: old inputs and feeds are listed and confirmed by name before deletion, declining or '
  + 'finding nothing deletes nothing, and Delete all feeds is its own action');

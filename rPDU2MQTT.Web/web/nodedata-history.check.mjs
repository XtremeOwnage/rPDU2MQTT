// Node Data at a past moment (#514): a timeline to pick the moment on, and the table read from history then.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('node data history check FAILED: ' + m); process.exit(1); };

const config = {
  History: { Enabled: true },
  EnergyFlow: { Nodes: [{ Id: 'mppt1', Label: 'MPPT 1', Mqtt: [
    { Topic: 'solar/mppt1/power', Metric: 'realpower' },
    { Topic: 'solar/mppt1/voltage', Metric: 'voltage' },
  ] }], Links: [] },
};
const at = ['2026-09-27T10:00:00Z', '2026-09-27T10:05:00Z', '2026-09-27T10:10:00Z'];
const series = { ok: true, metric: 'realpower', units: 'W', source: 'local', stepSeconds: 300, at,
  series: [{ node: 'mppt1', label: 'MPPT 1', kind: 'solar', values: [100, 200, 300] }] };
const byAt = { [at[0]]: 111, [at[1]]: 222, [at[2]]: 333 };

const asked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url, opts) => {
    if (url.includes('/api/flow/live')) {
      asked.push(url);
      const m = /at=([^&]+)/.exec(url);
      const q = JSON.parse(opts?.body || '[]');
      if (!m) return { ok: true, values: q.map(x => ({ node: x.Node, metric: x.Metric, value: 5, reported: 5,
        atUtc: new Date().toISOString(), ageSeconds: 1, fresh: true, staleAfterSeconds: 60 })) };
      const when = new Date(decodeURIComponent(m[1])).toISOString().replace('.000', '');
      return { ok: true, historical: true, values: q.map(x => ({ node: x.Node, metric: x.Metric,
        value: x.Metric === 'realpower' ? byAt[when] ?? null : null })) };
    }
    if (url.includes('/api/flow/series')) { asked.push(url); return series; }
    return url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? config
      : { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));
const tick = () => new Promise(r => setTimeout(r, 30));

query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Node Data').click();
await tick();
const sec = query(getEl('sections'), '.section', true).find(x => x.classList.contains('active'));
if (!sec) fail('Node Data did not open');
const heads = () => query(sec, 'th', true).map(t => t.textContent);
if (heads().includes('Source')) fail('the Source column is still there');
if (!heads().includes('Updated')) fail('the live view lost its Updated column');

const toggle = query(sec, 'input', true).find(i => i.parent?.tag === 'label' && i.parent.textContent.includes('Point in time'));
if (!toggle) fail('no "Point in time" switch while history is on');
const strip = query(sec, '.trend-timeline', false);
if (!strip || !strip.hidden) fail('the timeline shows before a past moment was asked for');

toggle.checked = true;
toggle.dispatch('change');
await tick();
if (!asked.some(u => u.includes('/api/flow/series') && u.includes('metric=realpower'))) fail('the timeline was not loaded');
if (strip.hidden) fail('the timeline is hidden in point-in-time mode: ' + JSON.stringify(asked) + ' / ' + sec.textContent.slice(-300));
const last = asked.filter(u => u.includes('/api/flow/live')).pop();
if (!last.includes('at=' + encodeURIComponent(new Date(at[2]).toISOString()))) fail(`opened on the wrong moment: ${last}`);
if (!sec.textContent.includes('333')) fail('the value at the newest moment is not shown');
if (heads().includes('Updated')) fail('a past moment still shows an age column');

// A click on the timeline's left edge picks the oldest reading.
const svg = query(strip, 'svg', false);
svg.dispatch('pointerdown', { clientX: 0, pointerId: 1 });
sandbox.window.dispatch('pointerup', { pointerId: 1 });
await tick();
if (!sec.textContent.includes('111')) fail(`clicking the timeline did not show that moment: ${asked.at(-1)}`);

// The arrows step reading by reading.
const later = query(strip, 'button', true).find(b => b.textContent === '▶');
later.click();
await tick();
if (!sec.textContent.includes('222')) fail('▶ did not step to the next reading');

toggle.checked = false;
toggle.dispatch('change');
await tick();
if (asked.filter(u => u.includes('/api/flow/live')).pop().includes('at=')) fail('switching back still asks for a past moment');
if (!strip.hidden) fail('the timeline stays after switching back to live');
if (!heads().includes('Updated')) fail('switching back did not restore the Updated column');

console.log('node data history check: OK'); if (process.env.DBG) console.log(asked);

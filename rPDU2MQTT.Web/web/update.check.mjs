// Regression check for the auto-update notice (#304, #327).
//
// AutoUpdate rolls on the operator's own schedule, so there is no click to hang an expectRestart() on: the
// page's only warning would otherwise be the stream dying, which paints a red "Offline" for something
// entirely routine.
//
// #304 shipped a transition table in its description and no test for it, and the gap that hid in there was
// the one that mattered: it watched the applied *tag*. Tracking a moving channel — `unstable`, `main`,
// `edge`, the default and the common case — swaps the digest under an unchanged tag, so the tag reads the
// same before and after an update and the notice never fired for anyone on a channel. The operator now
// stamps when it actually rolled; this pins both signals, and the cases where firing would be wrong.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
// The bundle bootstraps a full page on load; give it the shapes it expects so the run reaches our function
// rather than dying in build(). We are testing one exported predicate, not the page.
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const bodies = (url) =>
  url.includes('/api/schema') ? schema :
  url.includes('/api/instances') ? { ok: true, instances: [] } :
  url.includes('/api/config') ? {} :
  { ok: true };

const { sandbox } = makeDom({ bodies });
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 30));

const fn = sandbox.appliedTagChanged;
const fail = (m) => { console.error('update check FAILED: ' + m); process.exit(1); };
if (typeof fn !== 'function') fail('appliedTagChanged is not reachable from the bundle');

let passed = 0;
const expect = (want, label, ...args) => {
  const got = fn(...args);
  if (got !== want) fail(`${label} — expected ${want}, got ${got}`);
  passed++;
};

// --- A moving channel: the tag never changes, only the roll timestamp. This is the case that was broken.
expect(false, 'first report is never a roll',            'unstable', '2026-08-03T01:00:00Z');
expect(false, 'same roll reported again is not a roll',  'unstable', '2026-08-03T01:00:00Z');
expect(true,  'a new roll on the SAME tag fires',        'unstable', '2026-08-03T02:00:00Z');
expect(false, 'steady after the roll is quiet',          'unstable', '2026-08-03T02:00:00Z');
// The operator can stop reporting mid-restart; that is not a roll, and must not lose what we know.
expect(false, 'an absent timestamp is not a roll',       'unstable', null);
expect(false, 'the prior roll is still remembered',      'unstable', '2026-08-03T02:00:00Z');
expect(true,  'the next genuine roll still fires',       'unstable', '2026-08-03T03:00:00Z');

// --- An operator too old to send a timestamp: fall back to the tag, exactly as before.
const { sandbox: s2 } = makeDom({ bodies });
vm.createContext(s2);
vm.runInContext(code, s2, { filename: 'app.js' });
const legacy = s2.appliedTagChanged;
const expectLegacy = (want, label, ...args) => {
  const got = legacy(...args);
  if (got !== want) fail(`${label} — expected ${want}, got ${got}`);
  passed++;
};
expectLegacy(false, 'legacy: first report is quiet',        'unstable');
expectLegacy(false, 'legacy: same tag is quiet',            'unstable');
expectLegacy(false, 'legacy: an absent tag is not a change', null);
expectLegacy(false, 'legacy: the prior tag is remembered',   'unstable');
expectLegacy(true,  'legacy: a real tag switch fires',       'main');

console.log(`update: auto-update notice fires on a moving channel and stays quiet otherwise (${passed} transitions)`);

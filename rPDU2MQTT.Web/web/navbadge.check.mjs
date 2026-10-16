// Nav badges count only the edits under each page's paths.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const fail = (m) => { console.error('nav badge check FAILED: ' + m); process.exit(1); };
const { sandbox } = makeDom({ bodies: (url) => url.includes('/api/schema') ? [] : { ok: true } });
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });

const counts = vm.runInContext(`(() => {
  state.data = { EnergyFlow: { Groups: [{ Id: 'g', Label: 'G', Members: ['a'] }], Nodes: [{ Id: 'a', Label: 'A' }], Aggregation: {} } };
  setBaseline();
  state.data.EnergyFlow.Groups[0].ExpandChildren = true;
  refreshDirty();
  const claimed = ['EnergyFlow.Groups', 'EnergyFlow.Nodes', 'EnergyFlow.*'];
  const c = (s) => changeCountFor(s, claimed);
  const first = { groups: c('EnergyFlow.Groups'), nodes: c('EnergyFlow.Nodes,EnergyFlow.Links'), rest: c('EnergyFlow.*'), whole: c('EnergyFlow') };
  state.data.EnergyFlow.Aggregation.PeriodTimeZone = 'UTC';
  refreshDirty();
  return { ...first, restAfter: c('EnergyFlow.*'), groupsAfter: c('EnergyFlow.Groups') };
})()`, sandbox);
if (counts.groups !== 1) fail(`a group edit counts ${counts.groups} on Groups`);
if (counts.nodes !== 0) fail(`a group edit counts ${counts.nodes} on Nodes`);
if (counts.rest !== 0) fail(`a claimed edit counts on the fallback page`);
if (counts.whole !== 1) fail('a whole-section entry misses the edit');
if (counts.restAfter !== 1) fail('an unclaimed edit does not count on the fallback page');
if (counts.groupsAfter !== 1) fail('an unclaimed edit counts on Groups');
console.log('nav badges: ok');
process.exit(0);

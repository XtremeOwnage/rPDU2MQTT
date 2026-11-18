// Kiosk: theme from the URL, and the top-loads list.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const fail = (m) => { console.error('kiosk check FAILED: ' + m); process.exit(1); };
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8')).filter(n => n.key !== '_README');
const { sandbox } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: false } }
    : { ok: true },
});
sandbox.URLSearchParams = URLSearchParams;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));
const run = (js) => vm.runInContext(js, sandbox);

if (run("kioskTheme('?theme=dark')") !== 'dark') fail('?theme=dark is not dark');
if (run("kioskTheme('?theme=light')") !== 'light') fail('?theme=light is not light');
if (run("kioskTheme('?theme=blue')") !== null) fail('an unknown theme is not ignored');
if (run("kioskTheme('')") !== null) fail('no theme does not follow the system');

const graph = {
  nodes: [
    { id: 'grid', kind: 'grid', balance: 'grid', value: 900 },
    { id: 'panel', kind: 'panel', value: 900 },
    { id: 'hvac', kind: 'node', value: 600 },
    { id: 'rack', kind: 'node', value: 250 },
    { id: 'idle', kind: 'node', value: 0 },
    { id: 'untracked:grid', kind: 'unmeasured', value: 50 },
    { id: 'panel#unmeasured', kind: 'node', value: 50 },
  ],
  links: [{ source: 'grid', target: 'panel' }, { source: 'panel', target: 'hvac' }, { source: 'panel', target: 'rack' }],
};
const ids = run(`topLoads(${JSON.stringify(graph)}, 5).map(n => n.id).join(',')`);
if (ids !== 'hvac,rack') fail(`top loads are ${ids}, not hvac,rack`);
if (run(`topLoads(${JSON.stringify(graph)}, 1).length`) !== 1) fail('the limit is not applied');
console.log('kiosk: theme from the URL, top loads are measured leaves, largest first');

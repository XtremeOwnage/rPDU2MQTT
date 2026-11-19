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
for (const [v, want] of [[0, 0], [7.2, 8], [1800, 2000], [2300, 2500], [4100, 5000], [9600, 10000]])
  if (run(`kkNice(${v})`) !== want) fail(`the axis above ${v} is ${run(`kkNice(${v})`)}, not ${want}`);

const split = (p) => run(`JSON.stringify(kkSplit(${JSON.stringify(p)}))`);
let s = JSON.parse(split({ solar: 6800, home: 2600, battery: -2400, grid: -1800 }));
if (s.solarHome !== 2600 || s.solarBattery !== 2400 || s.solarGrid !== 1800 || s.gridHome || s.batteryHome) fail('midday split ' + JSON.stringify(s));
s = JSON.parse(split({ solar: 400, home: 2900, battery: 1200, grid: 1300 }));
if (s.solarHome !== 400 || s.batteryHome !== 1200 || s.gridHome !== 1300 || s.solarGrid) fail('evening split ' + JSON.stringify(s));
s = JSON.parse(split({ solar: 0, home: 1000, battery: -2000, grid: 3000 }));
if (s.gridHome !== 1000 || s.gridBattery !== 2000) fail('grid charging split ' + JSON.stringify(s));

if (run('kkSocLevel(82)') !== 'good' || run('kkSocLevel(46)') !== 'warn' || run('kkSocLevel(12)') !== 'bad' || run('kkSocLevel(null)') !== 'none') fail('battery colour levels');

const graph = {
  nodes: [
    { id: 'solar', label: 'Solar', kind: 'solar', value: 3000 },
    { id: 'grid', label: 'Grid', kind: 'grid', value: 1000 },
    { id: 'panel', label: 'Panel', kind: 'panel', value: 4000 },
    { id: 'hvac', label: 'HVAC', kind: 'node', value: 2500 },
    { id: 'rack', label: 'Rack', kind: 'node', value: 1500 },
    { id: 'ups', label: 'UPS', kind: 'node', value: 1200 },
    { id: 'rack#unmeasured', label: 'Unmeasured load', kind: 'unmeasured', value: 300, synthetic: true },
  ],
  links: [
    { source: 'solar', target: 'panel', value: 3000 }, { source: 'grid', target: 'panel', value: 1000 },
    { source: 'panel', target: 'hvac', value: 2500 }, { source: 'panel', target: 'rack', value: 1500 },
    { source: 'rack', target: 'ups', value: 1200 }, { source: 'rack', target: 'rack#unmeasured', value: 300 },
  ],
};
const loads = JSON.parse(run(`JSON.stringify(kkLoads(${JSON.stringify(graph.nodes)}, ${JSON.stringify(graph.links)}))`));
if (loads.map(l => l.label).join() !== 'HVAC,UPS') fail('loads now ' + JSON.stringify(loads));
const split2 = JSON.parse(run(`JSON.stringify(kkLoads([{id:'s',kind:'solar',balance:'solar',value:5},{id:'g',kind:'grid',balance:'grid',value:5},{id:'a',kind:'node',value:3},{id:'b',kind:'node',value:4}], [{source:'s',target:'a',value:3},{source:'g',target:'b',value:4}]))`));
if (split2.map(l => l.label).join() !== 'b,a') fail('loads with no common hub ' + JSON.stringify(split2));
console.log('kiosk: theme from the URL, round axes, power split, battery levels, loads');

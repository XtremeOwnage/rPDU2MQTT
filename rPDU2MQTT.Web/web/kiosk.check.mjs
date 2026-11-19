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
if (run("kioskStyle('?style=glow&theme=dark')") !== 'glow') fail('?style=glow is not glow');
if (run("kioskStyle('?style=minimal')") !== 'minimal') fail('?style=minimal is not minimal');
if (run("kioskStyle('?style=x')") !== 'classic' || run("kioskStyle('')") !== 'classic') fail('the default style is not classic');

for (const [v, want] of [[0, 0], [7.2, 8], [1800, 2000], [2300, 2500], [4100, 5000], [9600, 10000]])
  if (run(`kkNice(${v})`) !== want) fail(`the axis above ${v} is ${run(`kkNice(${v})`)}, not ${want}`);

const graph = {
  nodes: [
    { id: 'solar', label: 'Solar', kind: 'solar', value: 3000 },
    { id: 'grid', label: 'Grid', kind: 'grid', value: 1000 },
    { id: 'panel', label: 'Panel', kind: 'panel', value: 4000 },
    { id: 'hvac', label: 'HVAC', kind: 'node', value: 2500 },
    { id: 'rack', label: 'Rack', kind: 'node', value: 1500 },
    { id: 'ups', label: 'UPS', kind: 'node', value: 1200 },
  ],
  links: [
    { source: 'solar', target: 'panel', value: 3000 }, { source: 'grid', target: 'panel', value: 1000 },
    { source: 'panel', target: 'hvac', value: 2500 }, { source: 'panel', target: 'rack', value: 1500 },
    { source: 'rack', target: 'ups', value: 1200 },
  ],
};
const bars = run(`(() => { const s = kkSankey(${JSON.stringify(graph)}.nodes, ${JSON.stringify(graph)}.links, 1800, 500, 'W'); return s.querySelectorAll ? s.querySelectorAll('rect').length : (s.children || s.childNodes).filter(c => c.tagName === 'rect').length; })()`);
if (bars !== 6) fail(`the Sankey draws ${bars} bars, not 6 (two sources, the panel, two branches, one beneath)`);
console.log('kiosk: theme from the URL, round axes, Sankey from supply to what it feeds');

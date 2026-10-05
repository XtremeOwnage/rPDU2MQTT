// The sunburst and treemap hub, and hidden nodes.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const fail = (m) => { console.error('flow hub check FAILED: ' + m); process.exit(1); };
const { sandbox } = makeDom({ bodies: (url) => url.includes('/api/schema') ? [] : { ok: true } });
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });

const hubOf = (links) => {
  const ids = [...new Set(links.flat())];
  sandbox.__g = { nodes: ids.map(id => ({ id, value: 1 })), links: links.map(([source, target]) => ({ source, target, value: 1 })) };
  return vm.runInContext('findHub(__g.nodes, __g.links)', sandbox);
};

let r = hubOf([['p1', 's1'], ['p2', 's1'], ['p3', 's2'], ['s1', 'm1'], ['s2', 'm2'], ['m1', 'inv'], ['m2', 'inv'], ['grid', 'inv'], ['inv', 'export'], ['inv', 'panel'], ['panel', 'load']]);
if (r.hub !== 'inv') fail(`panels and strings: hub ${r.hub}`);
if ([...r.supply].sort().join() !== 'grid,m1,m2') fail(`panels and strings: supply ${r.supply}`);
r = hubOf([['grid', 'main'], ['main', 'a'], ['main', 'b']]);
if (r.hub !== 'main' || r.supply.join() !== 'grid') fail(`a chain: ${JSON.stringify(r)}`);
r = hubOf([['a', 'x'], ['b', 'y']]);
if (r.hub !== null) fail(`two separate trees have hub ${r.hub}`);
sandbox.__g = { nodes: ['p1', 'a1', 'm1', 'inv'].map(id => ({ id })), links: [['p1', 'a1'], ['a1', 'm1'], ['m1', 'inv']].map(([source, target]) => ({ source, target })) };
const shown = vm.runInContext(`state.data = { EnergyFlow: { Nodes: [{ Id: 'a1', Hidden: true }] } }; hideHiddenNodes(__g.nodes, __g.links)`, sandbox);
if (shown.nodes.map(n => n.id).join() !== 'm1,inv') fail(`hidden node and its only feeder: drew ${shown.nodes.map(n => n.id)}`);
if (shown.links.length !== 1) fail(`hidden node links: ${JSON.stringify(shown.links)}`);
console.log('flow hub: ok');
process.exit(0);

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
sandbox.__g = {
  nodes: ['p1', 'p2', 's1', 'm1', 'inv', 'load', 'export', 'tiny', 'a1', 'other'].map(id => ({ id, value: 1 })),
  links: [['p1', 's1', 300], ['p2', 's1', 300], ['s1', 'm1', 600], ['m1', 'inv', 600], ['inv', 'load', 500], ['inv', 'export', 100],
          ['tiny', 'other', 0.08], ['a1', 'm1', 0]].map(([source, target, value]) => ({ source, target, value })),
};
r = vm.runInContext('findHub(__g.nodes, __g.links)', sandbox);
if (r.hub !== 'inv') fail(`a stray tiny root and an empty one: hub ${r.hub}`);
const src = vm.runInContext(`(() => { const t = flowTree(__g.nodes.map(n => ({ ...n, value: { p1: 300, p2: 300, s1: 600, m1: 600, inv: 600 }[n.id] })), __g.links, 'inv', 'in');
  const walk = (x) => x.id + (x.children.length ? '(' + x.children.map(walk).join(',') + ')' : ''); return t.top.map(walk).join(); })()`, sandbox);
if (src !== 'm1(s1(p1,p2))') fail(`sources tree: ${src}`);
const hues = vm.runInContext(`(() => {
  const nodes = [{ id: 'pv', kind: 'solar', value: 5 }, { id: 'p1', value: 5 }, { id: 'gi', kind: 'grid', value: 1 }, { id: 'inv', value: 6 },
                 { id: 'ge', kind: 'grid', value: 2 }, { id: 'bat', kind: 'battery', value: 1 }, { id: 'load', value: 3 }];
  const links = [['p1','pv',5],['pv','inv',5],['gi','inv',1],['inv','ge',2],['inv','bat',1],['inv','load',3]].map(([source, target, value]) => ({ source, target, value }));
  const all = (ts) => ts.flatMap(t => [t, ...all(t.children)]);
  const hue = (tree) => Object.fromEntries(all(tree.top).map(t => [t.id, t.hue]));
  return { src: hue(flowTree(nodes, links, 'inv', 'in')), dst: hue(flowTree(nodes, links, 'inv', 'out')) };
})()`, sandbox);
if (hues.src.pv !== 46 || hues.src.p1 !== 46) fail(`solar and what feeds it are not yellow: ${JSON.stringify(hues.src)}`);
if (hues.src.gi !== 2) fail(`grid import is not red: ${hues.src.gi}`);
if (hues.dst.ge !== 140 || hues.dst.bat !== 212 || hues.dst.load !== null) fail(`destination hues: ${JSON.stringify(hues.dst)}`);
sandbox.__g = { nodes: ['p1', 'a1', 'm1', 'inv'].map(id => ({ id })), links: [['p1', 'a1'], ['a1', 'm1'], ['m1', 'inv']].map(([source, target]) => ({ source, target })) };
const shown = vm.runInContext(`state.data = { EnergyFlow: { Nodes: [{ Id: 'a1', Hidden: true }] } }; hideHiddenNodes(__g.nodes, __g.links)`, sandbox);
if (shown.nodes.map(n => n.id).join() !== 'm1,inv') fail(`hidden node and its only feeder: drew ${shown.nodes.map(n => n.id)}`);
if (shown.links.length !== 1) fail(`hidden node links: ${JSON.stringify(shown.links)}`);
console.log('flow hub: ok');
process.exit(0);

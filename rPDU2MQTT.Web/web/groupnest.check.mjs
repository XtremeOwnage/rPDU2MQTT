// Nested groups fold into a collapsed parent.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const fail = (m) => { console.error('group nesting check FAILED: ' + m); process.exit(1); };
const { sandbox } = makeDom({ bodies: (url) => url.includes('/api/schema') ? [] : { ok: true } });
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });

sandbox.__flow = {
  Groups: [
    { Id: 'solar', Label: 'Solar', Members: ['m1', 'm2'] },
    { Id: 's1', Label: 'S1', Members: ['p1', 'p2'], Parent: 'solar' },
    { Id: 'a1', Label: 'A1', Members: [], Parent: 'solar' },
  ],
};
const run = (collapsed) => vm.runInContext(`(() => {
  state.data = { EnergyFlow: __flow };
  collapsedGroups.clear(); ${JSON.stringify(collapsed)}.forEach(id => collapsedGroups.add(id));
  const nodes = ['solar', 'm1', 'm2', 's1', 'p1', 'p2', 'a1', 'home'].map(id => ({ id, label: id, kind: 'solar', value: 1 }));
  const links = [['p1','s1'],['p2','s1'],['s1','m1'],['m1','solar'],['m2','solar'],['a1','m1'],['solar','home']].map(([source, target]) => ({ source, target, value: 1 }));
  const g = collapseGraph(nodes, links);
  return { nodes: g.nodes.map(n => n.id).sort().join(), chips: [...(groupChips(() => {})?.children || [])].map(c => c.textContent).join('|') };
})()`, sandbox);

let r = run(['solar', 's1']);
if (r.nodes !== 'home,solar') fail(`collapsed parent drew ${r.nodes}`);
if (/S1/.test(r.chips)) fail(`a nested group's chip shows while its parent is collapsed: ${r.chips}`);
r = run(['solar']);
if (r.nodes !== 'home,solar') fail(`an expanded child of a collapsed parent drew ${r.nodes}`);
r = run(['s1']);
if (r.nodes !== 'a1,home,m1,m2,s1,solar') fail(`expanded parent with collapsed child drew ${r.nodes}`);
if (!/S1/.test(r.chips)) fail('a nested group has no chip while its parent is expanded');
if (/A1/.test(r.chips)) fail('an empty nested group has a chip');
r = run([]);
if (r.nodes !== 'a1,home,m1,m2,p1,p2,s1,solar') fail(`all expanded drew ${r.nodes}`);
console.log('group nesting: ok');
process.exit(0);

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
const empty = vm.runInContext(`(() => {
  state.data = { EnergyFlow: __flow };
  collapsedGroups.clear(); ['a1', 's1'].forEach(id => collapsedGroups.add(id));
  const g = collapseGraph([{ id: 'a1', label: 'a1', value: 1 }, { id: 'm1', label: 'm1', value: 1 }], [{ source: 'a1', target: 'm1', value: 1 }]);
  return !!g.nodes.find(n => n.id === 'a1')?.group;
})()`, sandbox);
if (empty) fail('an empty collapsed group is drawn as a group node');

const toggled = vm.runInContext(`(() => {
  state.data = { EnergyFlow: __flow };
  collapsedGroups.clear(); ['solar', 's1', 'a1'].forEach(id => collapsedGroups.add(id));
  const solar = __flow.Groups[0];
  toggleGroup(solar); const plain = [...collapsedGroups].sort().join();
  toggleGroup(solar); solar.ExpandChildren = true; toggleGroup(solar); const all = [...collapsedGroups].join();
  toggleGroup(solar); const back = [...collapsedGroups].sort().join(); delete solar.ExpandChildren;
  return { plain, all, back };
})()`, sandbox);
if (toggled.plain !== 'a1,s1') fail(`expanding left ${toggled.plain} collapsed`);
if (toggled.all !== '') fail(`Expand all children left ${toggled.all} collapsed`);
if (toggled.back !== 'a1,s1,solar') fail(`collapsing with Expand all children left ${toggled.back}`);

const nest = (mode) => vm.runInContext(`(() => {
  state.data = { EnergyFlow: { Groups: [{ Id: 'pv', Label: 'PV', Members: ['b1', 'b2'], Expand: '${mode}' }] } };
  collapsedGroups.clear();
  const nodes = ['b1', 'b2', 'mp1', 'mp2'].map(id => ({ id, label: id, value: 2 }));
  const links = [['b1','mp1'],['b2','mp2']].map(([source, target]) => ({ source, target, value: 2 }));
  const x = explodeExpandedGroups(nodes, links);
  const g = nestExpandedGroups(x.nodes, x.links);
  return { nodes: g.nodes.map(n => n.id).sort().join(), links: g.links.map(l => l.source + '>' + l.target + ':' + l.value).sort().join() };
})()`, sandbox);
let n = nest('parents');
if (n.links !== 'b1>pv:2,b2>pv:2,pv>mp1:2,pv>mp2:2') fail(`parents mode drew ${n.links}`);
n = nest('children');
if (n.links !== 'b1>mp1:2,b2>mp2:2,pv>b1:2,pv>b2:2') fail(`children mode drew ${n.links}`);
n = nest('replace');
if (n.nodes !== 'b1,b2,mp1,mp2') fail(`replace mode drew ${n.nodes}`);

console.log('group nesting: ok');
process.exit(0);

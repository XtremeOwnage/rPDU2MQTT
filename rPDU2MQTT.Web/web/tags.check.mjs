// Tag chips on the diagram (#342).
//
// The chips highlight; they do not filter. Removing nodes from a Sankey removes the ribbons into them too,
// so a node whose feeders were hidden reads as unsourced and the totals along the remaining chain stop
// adding up. Dimming answers "which of these are tagged X" without altering a single figure — this pins
// that every node is still drawn, and still shows its own value, while a tag is active.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('tags check FAILED: ' + m); process.exit(1); };
const cn = (e) => String((e && (e.className || (e.attrs && e.attrs.class))) || '');

const cfg = { EnergyFlow: { Nodes: [], Links: [] } };
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'solar', label: 'Solar', kind: 'solar', value: 800, derivation: 'measured', tags: ['roof', 'critical'] },
    { id: 'inverter', label: 'Inverter', kind: 'inverter', value: 800, derivation: 'measured', tags: ['critical'] },
    { id: 'panel', label: 'Panel', kind: 'panel', value: 800, derivation: 'measured' },
  ],
  links: [
    { source: 'solar', target: 'inverter', value: 800 },
    { source: 'inverter', target: 'panel', value: 800 },
  ],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? cfg :
    url.includes('/api/flow/live') ? { ok: true, values: [] } :
    url.includes('/api/flow/withheld') ? { ok: true, sources: [] } :
    url.includes('/api/flow') ? graph :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));
const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow');
if (!link) fail('no Flow tab');
link.click();
await new Promise(r => setTimeout(r, 400));

const sections = getEl('sections');
const buttons = () => query(sections, 'button', true);

// One chip per distinct tag, and none for the untagged node.
const chips = buttons().filter(b => ['roof', 'critical'].includes(b.textContent));
if (chips.length !== 2) fail(`expected chips for 'roof' and 'critical', got ${chips.map(b => b.textContent).join(', ')}`);

const nodesDrawn = () => query(sections, 'rect', true).filter(r => r.attrs['data-node']);
const before = nodesDrawn().length;
if (before < 3) fail(`expected the three nodes to be drawn, got ${before}`);

// Activate 'roof': only solar carries it.
chips.find(b => b.textContent === 'roof').click();
await new Promise(r => setTimeout(r, 50));

const lit = nodesDrawn().filter(r => cn(r).includes('on-path')).map(r => r.attrs['data-node']);
if (JSON.stringify(lit) !== JSON.stringify(['solar'])) fail(`expected only solar highlighted, got ${lit.join(', ') || '(none)'}`);

// Nothing is removed, and nothing loses its reading — the whole point of dimming rather than filtering.
if (nodesDrawn().length !== before) fail('activating a tag removed nodes from the diagram');
const labels = query(sections, 'text', true).map(t => t.textContent).join(' ');
for (const want of ['Solar', 'Inverter', 'Panel'])
  if (!labels.includes(want)) fail(`'${want}' disappeared while a tag was active`);
if (!labels.includes('800')) fail('a dimmed node stopped showing its reading');

// Clicking the active chip clears the highlight.
buttons().find(b => b.textContent === 'roof').click();
await new Promise(r => setTimeout(r, 50));
if (nodesDrawn().some(r => cn(r).includes('on-path'))) fail('clicking the active tag did not clear the highlight');

console.log(`tags: ${chips.length} chips from the graph; highlighting dims without removing any node or reading`);

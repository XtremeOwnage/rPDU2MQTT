// Wiring the hierarchy by dragging a node onto the one that should feed it. Replacing wiring is
// destructive, so it is named and confirmed first; a loop is refused; a click is not a drag.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('hierarchy check FAILED: ' + m); process.exit(1); };

const config = {
  History: { Enabled: false },
  EnergyFlow: {
    Nodes: [
      { Id: 'grid', Label: 'Grid', Kind: 'grid' },
      { Id: 'sub_panel', Label: 'Sub Panel', Kind: 'panel' },
      { Id: 'main_panel', Label: 'Main Panel', Kind: 'panel' },
      { Id: 'fridge', Label: 'fridge', Kind: 'load' },
    ],
    Links: [{ From: 'grid', To: 'main_panel' }],
  },
};
const nodes = [
  { id: 'grid', label: 'Grid', kind: 'grid' },
  { id: 'sub_panel', label: 'Sub Panel', kind: 'panel' },
  { id: 'main_panel', label: 'Main Panel', kind: 'panel' },
  { id: 'fridge', label: 'fridge', kind: 'load' },
];
const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? config
    : url.includes('/api/flow/live') ? { ok: true, values: [] }
    : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
    : url.includes('/api/flow') ? { ok: true, metric: 'realpower', units: 'W', nodes, links: [] }
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Hierarchy');
if (!link) fail('there is no Hierarchy page');
link.click();
await new Promise(r => setTimeout(r, 250));
const page = () => query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));

// Toasts dismiss themselves immediately under the stub's synchronous setTimeout, so record them as raised.
const said = [];
const host = getEl('toasts');
const appendToast = host.appendChild.bind(host);
host.appendChild = (c) => { said.push(c.textContent || ''); return appendToast(c); };

let asked = [];
sandbox.confirm = (m) => { asked.push(m); return answer; };
let answer = true;

const groupFor = (id) => query(page(), 'g', true).find(g => g.dataset && g.dataset.id === id);
const linksOf = () => config.EnergyFlow.Links.map(l => `${l.From}->${l.To}`).sort();

/// Drag `child` onto `parent`, the way a mouse does it: press on the node, move, release over the target.
const dropOn = (child, parent, { move = true } = {}) => {
  const svg = query(page(), 'svg', true)[0];
  const down = (svg._on?.mousedown || [])[0];
  if (!down) fail('the hierarchy canvas has no mousedown handler');
  // In a browser the press lands on the rect or the label inside the node's group.
  down({ target: { closest: () => groupFor(child), getAttribute: () => null }, clientX: 10, clientY: 10, preventDefault() { } });
  sandbox.document.elementFromPoint = () => ({ closest: () => groupFor(parent) });
  // A real click jitters a pixel or two before the release; only a deliberate drag should rewire anything.
  sandbox.window.dispatch('mousemove', move ? { clientX: 200, clientY: 120 } : { clientX: 11, clientY: 12 });
  sandbox.window.dispatch('mouseup', { clientX: 200, clientY: 120 });
};

// A node with nothing feeding it takes the new feeder without asking: nothing is being replaced.
dropOn('fridge', 'main_panel');
if (asked.length) fail(`replacing nothing still asked: ${asked[0]}`);
if (!linksOf().includes('main_panel->fridge')) fail(`dropping a node on another did not wire it: ${linksOf().join(', ')}`);

// A node that already has a feeder is a replacement, so it says what it would undo — and declining keeps it.
answer = false; asked = [];
dropOn('main_panel', 'sub_panel');
if (!asked.length) fail('replacing an existing feeder went ahead without asking');
if (!/already fed by Grid/.test(asked[0])) fail(`the warning does not name what it would replace: ${asked[0]}`);
if (!/drag Sub Panel’s ● onto Main Panel/.test(asked[0])) fail(`the warning does not say how to keep both: ${asked[0]}`);
if (!linksOf().includes('grid->main_panel')) fail('declining the warning still rewired the node');

// Accepting replaces it, and says what was undone.
answer = true; asked = [];
dropOn('main_panel', 'sub_panel');
if (linksOf().includes('grid->main_panel')) fail(`accepting left the old feeder in place: ${linksOf().join(', ')}`);
if (!linksOf().includes('sub_panel->main_panel')) fail(`accepting did not wire the new feeder: ${linksOf().join(', ')}`);
if (!said.some(t => /in place of Grid/.test(t))) fail(`nothing said what was replaced: ${said.join(' | ')}`);

// A feeder that is already downstream would be a loop, and is refused rather than wired.
const before = linksOf().join(', ');
asked = [];
dropOn('sub_panel', 'main_panel');
if (linksOf().join(', ') !== before) fail(`a loop was wired: ${linksOf().join(', ')}`);
if (!said.some(t => /loop/i.test(t))) fail('nothing explained why the drop was refused');

// A click that jitters a pixel is still a click — it renames, selects, but never rewires.
asked = [];
dropOn('fridge', 'grid', { move: false });
if (linksOf().join(', ') !== before) fail(`a click rewired the hierarchy: ${linksOf().join(', ')}`);

console.log('hierarchy: dropping a node on another sets what feeds it, replacing an existing feeder only '
  + 'after naming it, refusing a loop, and never on a click that did not move');
process.exit(0);

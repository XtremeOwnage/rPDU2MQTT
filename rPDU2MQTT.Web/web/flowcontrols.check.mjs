// The Flow page's controls pack onto shared lines instead of stacking.
//
// Refresh/metric, the period buttons, the historical picker, the view toggles and the tag chips were five
// separate full-width rows, each a block with a margin under it and each using about a quarter of the line.
// On a wide screen that pushed the diagram — the thing the page is for — most of a screen down.
//
// They are flex items in a wrapping strip now: side by side where there is room, folding only where there
// is not. A DOM stub does no layout, so this reads the structure and the stylesheet.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const css = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('flowcontrols check FAILED: ' + m); process.exit(1); };

// --- The strip is a wrapping row, and its children bring no margins of their own --------------------
const strip = /(^|[\s},])\.flow-controls\s*\{([^}]*)\}/m.exec(css);
if (!strip) fail('no .flow-controls rule — the control rows have nothing packing them');
const decl = strip[2];
for (const [prop, why] of [
  ['display\\s*:\\s*flex', 'the strip is not a flex row, so its rows still stack'],
  ['flex-wrap\\s*:\\s*wrap', 'the strip does not wrap, so a narrow screen would push controls off the side'],
])
  if (!new RegExp(prop).test(decl)) fail(why);
if (!/(^|[\s},])\.flow-controls\s*>\s*\*\s*\{[^}]*margin\s*:\s*0/m.test(css))
  fail('the rows keep their own margins inside the strip, which puts the stacking back');

// --- Every control row above the diagram is in a strip -------------------------------------------------
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'grid', label: 'Grid', kind: 'grid', value: 2360, derivation: 'measured' },
    { id: 'panel', label: 'Main Panel', kind: 'panel', value: 1780, derivation: 'measured' },
  ],
  links: [{ source: 'grid', target: 'panel', value: 1780 }],
};
const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? { History: { Enabled: false }, EnergyFlow: { Nodes: [], Links: [] } }
    : url.includes('/api/flow/live') ? { ok: true, values: [] }
    : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
    : url.includes('/api/flow') ? graph
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
await new Promise(r => setTimeout(r, 300));
const sec = query(getEl('sections'), '.section', true).find(x => query(x, '.flow-gestures', true).length > 0);
if (!sec) fail('could not find the Flow section');

const strips = query(sec, '.flow-controls', true);
if (!strips.length) fail('the page renders no control strip');

// The metric/refresh row, the period buttons and the historical picker belong to one strip, not three.
const first = strips[0];
if ((first.children || []).length < 3)
  fail(`the first strip holds ${(first.children || []).length} rows — the page-level controls are still separate`);

// Nothing is left as a loose block row.
const inStrips = strips.flatMap(s => query(s, '.ld-toolbar', true));
const loose = query(sec, '.ld-toolbar', true).filter(t => !inStrips.includes(t));
if (loose.length) fail(`${loose.length} control row(s) still sit outside a strip`);

console.log(`flowcontrols: the Flow page's controls sit in ${strips.length} wrapping strips rather than five `
  + 'stacked block rows, the strip wraps so a narrow screen still folds them, and the rows carry no margins '
  + 'of their own to stack with');

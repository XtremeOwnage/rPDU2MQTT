// The editing dialog on a phone.
//
// Reported from one: the dialogs are unusable and nothing can be edited. The panel was styled inline with
// `overflowX: hidden`, on the reasoning that "the table below manages its own width". Nothing did — there
// was no horizontal scroller anywhere inside it. Its own comment puts the widest row at ~1,640px, so on a
// 390px screen the panel clipped at ~340px and the rest of every row was on screen and unreachable.
//
// A DOM stub applies no CSS, so this reads the stylesheet and the markup the way css.check.mjs does.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const css = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('phonedialog check FAILED: ' + m); process.exit(1); };

/// The declarations of every rule whose selector list mentions `sel`. A selector can share a rule with
/// others, so this reads the list rather than expecting the name to sit immediately before the brace.
const declsFor = (sel) => {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1].split(',').map(x => x.trim());
    if (selectors.some(x => x === sel || x.endsWith(' ' + sel) || x.startsWith(sel + ' ') || x === sel))
      out.push(m[2]);
  }
  return out;
};
const rule = (sel) => { const d = declsFor(sel); return d.length ? d.join(';') : null; };

// --- The panel does not clip what it cannot fit -------------------------------------------------------
const panel = rule('.sheet-panel');
if (!panel) fail('.sheet-panel has no stylesheet rule — it is styled inline and a phone cannot be told apart');
if (/overflow-x\s*:\s*hidden/.test(panel))
  fail('.sheet-panel still hides its horizontal overflow, so a row wider than the panel cannot be reached');
if (!/overflow\s*:\s*auto/.test(panel))
  fail('.sheet-panel does not scroll, so anything past its width is unreachable');

// A table wider than the panel gets its own scroller, so the head and the buttons do not scroll away with
// the columns — on a phone that would carry the Close button off the side.
// Either scroller will do — .bindings-scroll predates this and already wraps the widest table of all.
for (const sel of ['.sheet-scroll', '.bindings-scroll']) {
  const d = rule(sel);
  if (!d || !/overflow-x\s*:\s*auto/.test(d))
    fail(`${sel} wraps a table but does not scroll — the wrapper is inert and the table overflows`);
}
// …and a scroll container around table.ld must unstick the header, or it parks inside the table on row 1.
const th = rule('.sheet-panel table.ld th');
if (!th || !/position\s*:\s*static/.test(th))
  fail('.sheet-panel table.ld th is still sticky inside a scroll container');

// --- One phone breakpoint, carrying the dialog rules ---------------------------------------------------
const blocks = [...css.matchAll(/@media \(max-width: *560px\)/g)];
if (blocks.length !== 1)
  fail(`${blocks.length} phone breakpoints — the rules are split, and whichever is read first wins`);
const phone = /@media \(max-width: *560px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(css);
if (!phone) fail('no phone breakpoint');
const p = phone[1];

// A dialog centred in the viewport is pushed off it when the keyboard opens.
if (!/\.sheet-backdrop[^{]*\{[^}]*align-items\s*:\s*flex-start/.test(p) &&
    !/align-items\s*:\s*flex-start/.test(p))
  fail('the dialog is still centred on a phone, so the keyboard pushes it off screen');
if (!/\.sheet-panel\s*\{[^}]*width\s*:\s*100%/.test(p))
  fail('the panel does not take the width of a phone screen');
// A control that keeps its desktop max-width pushes its row off the side.
if (!/\.sheet-panel input[^{]*\{[^}]*max-width\s*:\s*none/.test(p))
  fail('controls inside the dialog keep a desktop max-width on a phone');

// --- The markup actually carries the classes the rules target ------------------------------------------
const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? { History: { Enabled: false }, EnergyFlow: {
        Nodes: [{ Id: 'grid', Label: 'Grid', Kind: 'grid',
                  Sources: [{ Type: 'mqtt', Metric: 'energy', Topic: 'sa/grid' }] }], Links: [] } }
    : url.includes('/api/flow/derivations') ? { ok: true, metrics: [] }
    : url.includes('/api/flow/live') ? { ok: true, values: [] }
    : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
    : url.includes('/api/flow') ? { ok: true, nodes: [], links: [], metric: 'realpower', units: 'W' }
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes').click();
await new Promise(r => setTimeout(r, 200));
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const edit = query(sec, 'button', true).find(b => b.textContent === 'Edit');
if (!edit) fail('no node to edit');
edit.click();
await new Promise(r => setTimeout(r, 250));

const body = sandbox.document.body;
if (!query(body, '.sheet-backdrop', true).length)
  fail('the dialog backdrop carries no class, so no breakpoint can reach it');
if (!query(body, '.sheet-panel', true).length)
  fail('the dialog panel carries no class');
// An inline overflow would outrank the breakpoint, so the panel must carry none.
const styleOf = (x) => JSON.stringify((x.attrs && x.attrs.style) || x.style || '');
if (query(body, '.sheet-panel', true).some(x => /overflow/i.test(styleOf(x))))
  fail('the panel still sets its overflow inline, which no breakpoint can override');
// The widest table — the bindings, eleven columns and about 1,640px of them — carries its own scroller, so
// the columns move without taking the Close button off the side with them. The panel scrolling covers the
// rest; a table narrower than the panel needs nothing.
const wrappers = query(body, '.sheet-scroll', true).concat(query(body, '.bindings-scroll', true));
if (!wrappers.length)
  fail('no table in the dialog has a scroller, so reaching a wide row scrolls the whole panel');
if (!wrappers.some(w => query(w, 'table', true).length))
  fail('the scroller in the dialog wraps no table');

console.log('phonedialog: the editing dialog scrolls both ways instead of clipping, its tables scroll '
  + 'within it so the Close button stays put, the panel and backdrop are styled by class rather than '
  + 'inline, and one phone breakpoint gives the dialog the screen and drops the desktop control widths');

// The node editor's bindings table. Eleven columns in a sheet sized for the page put the Remove button off
// the right-hand edge, rendering as "Re…", and scrolling the sheet to reach it took the title and the Close
// button along with it (#401).
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('node-sheet check FAILED: ' + m); process.exit(1); };

const mqtt = (metric, extra = {}) => ({ Type: 'mqtt', Metric: metric, Topic: `x/${metric}`, ...extra });

/// Open the editor on a node with these bindings and report what the table looks like.
const sheetFor = async (kind, sources) => {
  const config = {
    History: { Enabled: false },
    EnergyFlow: { Nodes: [{ Id: 'n', Label: 'N', Kind: kind, Sources: sources }], Links: [] },
  };
  const { sandbox, getEl } = makeDom({
    bodies: (url) => url.includes('/api/schema') ? schema
      : url.includes('/api/config') ? config
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : { ok: true },
  });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 60));
  query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes')?.click();
  await new Promise(r => setTimeout(r, 200));
  const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
  query(sec, 'button', true).find(b => b.textContent === 'Edit')?.click();
  await new Promise(r => setTimeout(r, 200));

  const body = sandbox.document.body;
  const box = query(body, 'div', true).find(d => (d.attrs?.class || d.className || '') === 'bindings-scroll');
  // Scoped to the bindings table: the Nodes table behind the sheet has headers of its own.
  const scope = box || body;
  const headers = query(scope, 'th', true).map(t => t.textContent);
  const rows = query(scope, 'tr', true).filter(r => query(r, 'td', true).length);
  return { box, headers, cells: rows.map(r => query(r, 'td', true).length) };
};

// The table manages its own width, so the sheet does not have to scroll sideways to reach a row's actions.
let s = await sheetFor('grid', [mqtt('realpower', { Direction: 'split' }), mqtt('energy'), mqtt('voltage')]);
if (!s.box) fail('the bindings table is not in its own scroll container — the whole sheet scrolls instead');

// A column every row fills with a dash is width spent saying "not applicable" once per row.
if (!s.headers.includes('Counter')) fail(`a node with an energy binding has no Counter column: ${s.headers.join(', ')}`);
if (!s.headers.includes('Invert')) fail(`a node with a signed metric has no Invert column: ${s.headers.join(', ')}`);

s = await sheetFor('load', [mqtt('realpower'), mqtt('voltage')]);
if (s.headers.includes('Counter')) fail(`Counter is shown where nothing accumulates: ${s.headers.join(', ')}`);
if (s.headers.includes('Direction')) fail(`Direction is shown on a node that only flows one way: ${s.headers.join(', ')}`);
if (!s.headers.includes('Invert')) fail('Invert was dropped where power is bound, and power has a sign');

s = await sheetFor('load', [mqtt('voltage'), mqtt('frequency')]);
if (s.headers.includes('Invert')) fail(`Invert is shown where no metric has a sign: ${s.headers.join(', ')}`);
if (s.headers.includes('Counter')) fail(`Counter is shown where nothing accumulates: ${s.headers.join(', ')}`);

// Whatever the columns are, every row has to have exactly that many cells.
for (const n of s.cells)
  if (n !== s.headers.length) fail(`a row has ${n} cells against ${s.headers.length} columns — they are misaligned`);

console.log(`node-sheet: the bindings table carries its own width; Counter, Direction and Invert appear only `
  + `where a binding on that node uses them (${s.headers.length} columns for a voltage/frequency node), and `
  + `every row matches the header`);

// The Flow page puts the diagram first.
//
// A paragraph, a metric row, the period buttons, the date picker, the view switches, the group chips and the
// tag chips stacked above the diagram and put it half way down the screen. Now one header line carries the
// title, what is drawn and two buttons; the past and the view options open from those buttons, and are
// closed by default.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const css = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('flowcontrols check FAILED: ' + m); process.exit(1); };

const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'grid', label: 'Grid', kind: 'grid', value: 2360, derivation: 'measured' },
    { id: 'panel', label: 'Main Panel', kind: 'panel', value: 1780, derivation: 'measured', tags: ['meter'] },
  ],
  links: [{ source: 'grid', target: 'panel', value: 1780 }],
};
const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? { History: { Enabled: true }, EnergyFlow: { Nodes: [], Links: [], Groups: [{ Id: 'g', Label: 'PV', Members: ['grid'] }] } }
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
const cn = (e) => String((e && (e.className || (e.attrs && e.attrs.class))) || '');

// No paragraph over the diagram.
if (query(sec, 'div', true).some(d => cn(d) === 'desc' && /Outlet.PDU is auto-derived/.test(d.textContent || '')))
  fail('the explanatory paragraph is back over the diagram');

// One header line: the title and the controls together.
const head = query(sec, 'div', true).find(d => cn(d).includes('flow-head'));
if (!head) fail('no header line');
const buttons = query(head, 'button', true).map(b => b.textContent || '');
for (const want of [/^History/, /^View/, /^Refresh$/])
  if (!buttons.some(b => want.test(b))) fail(`the header has no ${want} button: ${buttons.join(', ')}`);
if (!query(head, 'select', true).length) fail('what is drawn is not chosen in the header');

// Everything else behind the two buttons, closed until asked for.
const panels = query(sec, 'div', true).filter(d => cn(d).includes('flow-panel'));
if (panels.length !== 2) fail(`expected the History and View panels, found ${panels.length}`);
if (panels.some(p => !p.hidden)) fail('a panel is open over the diagram before anyone asked for it');
const view = panels[1];
const titles = query(view, 'div', true).filter(d => cn(d).includes('flow-view-title')).map(d => d.textContent);
for (const want of ['Display', 'Groups', 'Tags'])
  if (!titles.includes(want)) fail(`the View panel has no ${want} section: ${titles.join(', ')}`);
// The switches live in it, not over the diagram.
if (!query(view, 'label', true).some(l => /Hide empty/.test(l.textContent || ''))) fail('the view switches are not in the View panel');
const viewBtn = query(head, 'button', true).find(b => /^View/.test(b.textContent || ''));
viewBtn.onclick();
if (view.hidden) fail('View did not open its panel');

console.log('flowcontrols: the Flow page has one header line (title, metric, drill, History, View, Refresh); the past and the view options (display, groups, tags) sit in panels behind two buttons, closed by default');

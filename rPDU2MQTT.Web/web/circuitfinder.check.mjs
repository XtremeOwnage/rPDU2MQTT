// Circuit Finder (#471): switching the load on and off finds the channel that steps with it. A channel that
// moves once for its own reasons drops out on the next toggle; a 240 V load reports both legs; and the page
// says what it can and cannot see at the PDU's sampling rate. Built for a phone: one button, no tables.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('circuit finder check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Every channel on the panel, and what each reads right now. The check moves these between taps.
const power = { grid: 3000, main_panel: 2000, untracked: 200, n30_1: 100, n30_2: 100, n30_3: 100, n30_4: 100 };
const graph = () => ({
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'grid', label: 'Grid', kind: 'grid', value: power.grid },
    { id: 'main_panel', label: 'Main Panel', kind: 'panel', value: power.main_panel },
    { id: 'n30_1', label: 'Bedroom Circuit', kind: 'breaker', value: power.n30_1 },
    { id: 'n30_2', label: 'Kitchen Circuit', kind: 'breaker', value: power.n30_2 },
    { id: 'n30_3', label: 'Garage Circuit', kind: 'breaker', value: power.n30_3 },
    { id: 'n30_4', label: 'Garage Circuit B', kind: 'breaker', value: power.n30_4 },
    // A virtual node standing for what the panel does not meter: it moves with the load, but nothing is
    // plugged into it, so it is never the answer.
    { id: 'untracked', label: 'Untracked remainder', kind: 'node', value: power.untracked },
    // The builder's own unmetered remainder, which is not a node anyone can name either.
    { id: 'main_panel#unmeasured', label: 'Unmeasured load', kind: 'unmeasured', value: 400 },
  ],
  links: [],
});

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { Pdus: { rack: { PollInterval: 5 } }, EnergyFlow: { Nodes: [], Links: [] } }
      : url.includes('/api/flow') ? graph()
      : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(50);

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Circuit Finder');
if (!link) fail('no Circuit Finder page');
link.click();
await wait(100);
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('clicking Circuit Finder activated no section');

const tap = () => query(sec, '.cf-tap');
const verdict = () => query(sec, '.cf-verdict').textContent || '';
const rows = () => query(sec, '.cf-row', true).map(r => r.textContent || '');
const named = (label) => rows().find(r => r.startsWith(label));
const press = async () => { await tap().onclick(); await wait(60); };

// What the PDU's polling can and cannot see, said before anything is measured.
const rate = query(sec, '.cf-rate').textContent || '';
if (!/every 5 s/.test(rate) || !/10 s/.test(rate))
  fail(`the page does not say the sampling rate and the shortest switch it can see: "${rate}"`);
// A phone holds one column: the readings are rows, not a table.
if (query(sec, 'table', true).length) fail('Circuit Finder renders a table — a phone cannot hold one');
const tapRule = /\.cf-tap\s*\{([^}]*)\}/.exec(css);
if (!tapRule) fail('no .cf-tap rule in the stylesheet');
const minHeight = /min-height\s*:\s*(\d+)px/.exec(tapRule[1]);
if (!minHeight || Number(minHeight[1]) < 44) fail(`the tap target is ${minHeight ? minHeight[1] + 'px' : 'unsized'}; a finger needs 44px`);
if (!/width\s*:\s*100%/.test(tapRule[1])) fail('the tap button does not span the width it is given');

// Nothing is claimed before the first toggle.
if (!/switch the load off, then tap/i.test(verdict())) fail(`the page does not open by asking for the load to be switched off: "${verdict()}"`);

// Toggle 1 — the load goes on: the kitchen circuit rises by 1,500 W. The garage circuit rises too, for its
// own reasons, and the bedroom circuit wobbles below the noise floor.
await press();
if (!/nothing to compare/i.test(verdict())) fail(`one reading is not a toggle: "${verdict()}"`);
power.n30_2 = 1600;
power.n30_3 = 500;
power.n30_1 = 103;
// Everything upstream of the circuit carries the load too.
power.main_panel = 3500;
power.grid = 4500;
power.untracked = 1700;
await press();
if (!named('Kitchen Circuit')) fail(`the channel that stepped with the load is not listed: ${rows().join(' | ')}`);
if (named('Bedroom Circuit')) fail(`a 3 W wobble was counted as a step: ${rows().join(' | ')}`);
if (!named('Garage Circuit')) fail('a channel that did rise was not listed as a candidate');
// The panel, the grid and the virtual node all stepped as well, being upstream — none of them is a circuit.
for (const upstream of ['Main Panel', 'Grid', 'Untracked remainder', 'Unmeasured load'])
  if (named(upstream)) fail(`${upstream} is not a circuit but was offered as one: ${rows().join(' | ')}`);
// …and they are one tick away for anyone who wants them, without re-running the session.
const everyBox = query(sec, 'input[type=checkbox]', true)[0];
if (!everyBox || everyBox.checked) fail('the page does not default to circuits only');
everyBox.checked = true;
everyBox.onchange({});
await wait(30);
if (!named('Main Panel') || !named('Grid') || !named('Untracked remainder')) fail(`showing every channel did not bring the upstream nodes back: ${rows().join(' | ')}`);
everyBox.checked = false;
everyBox.onchange({});
await wait(30);
if (named('Main Panel')) fail('unticking the box did not go back to circuits only');
if (/Kitchen Circuit —/.test(verdict())) fail(`one toggle named a channel outright: "${verdict()}"`);

// Toggle 2 — the load goes off: the kitchen circuit falls back, the garage circuit stays where it is.
power.n30_2 = 100;
power.main_panel = 2000;
power.grid = 3000;
power.untracked = 200;
await press();
if (!/^Kitchen Circuit/.test(named('Kitchen Circuit') || '')) fail('the kitchen circuit dropped out of the list');
if (!/2 of 2 toggles/.test(named('Kitchen Circuit'))) fail(`the kitchen circuit did not follow both toggles: ${named('Kitchen Circuit')}`);
if (!/1 of 2 toggles/.test(named('Garage Circuit'))) fail(`the unrelated rise did not drop out: ${named('Garage Circuit')}`);
if (!/Kitchen Circuit/.test(verdict()) || !/2 toggles/.test(verdict()))
  fail(`two toggles with one survivor did not name it: "${verdict()}"`);
if (rows().indexOf(named('Kitchen Circuit')) !== 0) fail(`the match is not at the top: ${rows().join(' | ')}`);

// A tap holds the button down while the channels are read again: a second tap inside the same reading proves
// nothing, since the PDU has not looked at the circuit yet.
const inFlight = tap().onclick();
if (!tap().disabled) fail('the button can be tapped again before the channels have been read');
if (query(sec, '.cf-cooldown').hidden) fail('nothing shows how long the button stays down');
if (!/Reading channels/.test(tap().textContent || '')) fail(`the button does not say it is waiting: "${tap().textContent}"`);
const cool = Number(tap().dataset.cooldown);
if (!(cool >= 3 && cool <= 5)) fail(`the cooldown is ${cool} s; it should be 3-5 s while the PDU is read`);
await inFlight;
await wait(30);
if (tap().disabled || !query(sec, '.cf-cooldown').hidden) fail('the button never came back after the cooldown');
const fill = /\.cf-cooldown\s*>\s*span\s*\{([^}]*)\}/.exec(css);
if (!fill || !/animation\s*:/.test(fill[1])) fail('the cooldown bar does not animate, so it reads as a stuck bar');

// Finding a circuit is how you come to name it, so a row opens that node's editor.
const row = query(sec, '.cf-row', true)[0];
if (row.tag !== 'button') fail(`a result row is a ${row.tag}, so it cannot be tapped to open the node`);
if (!/Edit/.test(row.textContent || '')) fail(`a row does not offer to edit the node: "${row.textContent}"`);
row.onclick();
await wait(60);
const nodesLink = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes');
if (!nodesLink.classList.contains('active')) fail('tapping a result did not open the Nodes page to edit it');
link.click();
await wait(60);

// An expected draw rules out a channel that steps by the wrong amount: a 60 W lamp is not a 1,500 W step.
query(sec, 'button', true).find(b => b.textContent === 'Start over').onclick();
await wait(30);
if (rows().length) fail('Start over left the old candidates on screen');
const drawInput = query(sec, 'input[type=number]', true)[0];
drawInput.value = '60';
drawInput.onchange({});
power.n30_2 = 100; power.n30_3 = 500;
await press();
power.n30_2 = 162;   // the lamp
power.n30_3 = 2000;  // something large switching on at the same moment
await press();
if (!named('Kitchen Circuit')) fail(`a 62 W step was not matched against a 60 W load: ${rows().join(' | ')}`);
if (named('Garage Circuit')) fail(`a 1,500 W step was accepted for a 60 W load: ${rows().join(' | ')}`);

// A 240 V load steps both legs of its double-pole breaker, and both are reported.
query(sec, 'button', true).find(b => b.textContent === 'Start over').onclick();
drawInput.value = '';
drawInput.onchange({});
power.n30_3 = 100; power.n30_4 = 100; power.n30_2 = 100;
await press();
power.n30_3 = 1300; power.n30_4 = 1250;
await press();
power.n30_3 = 100; power.n30_4 = 100;
await press();
if (!/240 V/.test(verdict()) || !/Garage Circuit/.test(verdict()) || !/Garage Circuit B/.test(verdict()))
  fail(`a load stepping two channels together was not reported as both legs: "${verdict()}"`);

console.log('circuit finder: offers circuits rather than the panel and grid that carry them, with every channel one tick away; says the sampling rate and the shortest switch it can see; a channel that steps with '
  + 'every toggle is named and ranked first, one that moves once drops out, a step of the wrong size is refused '
  + 'against a known draw, both legs of a 240 V breaker are reported, and the page is one column of rows with a '
  + 'finger-sized button; the button holds itself down for 3-5 s with an animated bar while the channels are read again, and a result row opens that node in the editor');
process.exit(0);

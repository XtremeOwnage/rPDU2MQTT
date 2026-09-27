// Circuit Finder (#471, #494): switching the load on and off finds the channel that steps with it.
//
// The server records every channel while the page is open, so a tap is a timestamp: there is no cooldown,
// a state is every reading taken while it was held (the phone may sleep in between), and a step counts when
// it clears the channel's own noise. Near-misses are ranked, and when nothing matches the page says why in
// watts. Built for a phone: one button, no tables.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('circuit finder check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// --- A pretend server: a clock, the channels, and the recorder -------------------------------------------
const clock = { t: Date.UTC(2026, 8, 27, 12, 0, 0) };
const CHANNELS = [
  ['grid', 'Grid', 'grid'], ['main_panel', 'Main Panel', 'panel'],
  ['n30_1', 'Bedroom Circuit', 'breaker'], ['n30_2', 'Kitchen Circuit', 'breaker'],
  ['n30_3', 'Garage Circuit', 'breaker'], ['n30_4', 'Garage Circuit B', 'breaker'],
  // A virtual node standing for what the panel does not meter: it moves with the load, but nothing is
  // plugged into it, so it is never the answer.
  ['untracked', 'Untracked remainder', 'node'],
  // What is plugged in, not the circuit it is on: a PDU outlet and a metered appliance.
  ['pdu_7', 'Proxmox: Kube04', 'outlet'], ['kettle', 'Kettle plug', 'load'],
];
const power = { grid: 3000, main_panel: 2000, n30_1: 100, n30_2: 100, n30_3: 100, n30_4: 100, untracked: 200, pdu_7: 90, kettle: 0 };
/// How much each channel wanders reading to reading; the bedroom circuit is a noisy one.
const wander = { n30_1: 15 };
let recorded = [];
let tick = 0;
/// Let `seconds` pass with the load as it is: one reading every 5 s, each with its channel's own wander.
const hold = (seconds) => {
  for (let s = 0; s < seconds; s += 5) {
    clock.t += 5000;
    tick++;
    const v = {};
    for (const [id, val] of Object.entries(power)) {
      const w = wander[id] ?? 2;
      v[id] = val + w * [0, 1, -1, 0.5, -0.5][tick % 5];
    }
    recorded.push({ t: clock.t, v });
  }
};
/// Time passing between switching the load and tapping.
const fumble = (ms = 1500) => { clock.t += ms; };

const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/circuit-finder/samples')) {
      const since = Number(new URL('http://x' + url).searchParams.get('since') || 0);
      return {
        ok: true, now: clock.t, pollSeconds: 5, keepMinutes: 30,
        channels: CHANNELS.map(([id, label, kind]) => ({ id, label, kind })),
        samples: recorded.filter(s => s.t > since),
      };
    }
    return url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { Pdus: { rack: { PollInterval: 5 } }, EnergyFlow: { Nodes: [], Links: [] } }
      : { ok: true };
  },
});
sandbox.__clock = clock;
vm.createContext(sandbox);
vm.runInContext('Date.now = () => __clock.t;', sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(50);

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Circuit Finder');
if (!link) fail('no Circuit Finder page');
/// Opening the page (again) fetches what the server recorded since the last look.
const look = async () => { link.click(); await wait(40); };
await look();
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('clicking Circuit Finder activated no section');

const tap = () => query(sec, '.cf-tap');
const verdict = () => query(sec, '.cf-verdict').textContent || '';
const held = () => query(sec, '.cf-held').textContent || '';
const rows = () => query(sec, '.cf-row', true);
const named = (label) => rows().find(r => (query(r, '.cf-name')?.textContent || '') === label);
const press = async () => { tap().onclick(); await wait(40); };
const button = (text) => query(sec, 'button', true).find(b => b.textContent === text);

// --- The page, before anything happens --------------------------------------------------------------------
if (query(sec, 'table', true).length) fail('Circuit Finder renders a table — a phone cannot hold one');
const tapRule = /\.cf-tap\s*\{([^}]*)\}/.exec(css);
if (!tapRule) fail('no .cf-tap rule in the stylesheet');
const minHeight = /min-height\s*:\s*(\d+)px/.exec(tapRule[1]);
if (!minHeight || Number(minHeight[1]) < 44) fail(`the tap target is ${minHeight ? minHeight[1] + 'px' : 'unsized'}; a finger needs 44px`);
if (!/width\s*:\s*100%/.test(tapRule[1])) fail('the tap button does not span the width it is given');
if (!/every 5 s/.test(query(sec, '.cf-rate').textContent || '')) fail('the page does not say how often the PDU reports');
if (!/switch the load off, then tap/i.test(verdict())) fail(`the page does not open by asking for the load to be switched off: "${verdict()}"`);

// --- No cooldown: a tap is a timestamp -----------------------------------------------------------------------
hold(20);
await press();                                  // OFF
if (tap().disabled) fail('the button locks after a tap — there is nothing to wait for any more');
if (query(sec, '.cf-fill', true).length || /wait \d+ s/i.test(tap().textContent || '')) fail('a countdown is still shown on the button');
hold(20);
await look();
// Progress in place of a countdown: which state, how long, how many readings.
if (!/Load OFF · held 20 s · [34] readings/.test(held())) fail(`the open state does not report its progress: "${held()}"`);

// --- Toggle 1: the load goes on. The kitchen circuit rises 1,500 W; the garage rises for its own reasons;
// the noisy bedroom circuit drifts up 20 W, inside its ±15 W wander. Everything upstream carries the load.
power.n30_2 = 1600; power.n30_3 = 500; power.n30_1 = 120;
power.main_panel = 3500; power.grid = 4500; power.untracked = 1700; power.pdu_7 = 400; power.kettle = 1500;
hold(5); fumble();                              // switched, a reading taken, then tapped
await press();                                  // ON
// The phone goes to sleep for half a minute: the server keeps recording, and nothing is lost.
hold(30);
await look();
if (!/Load ON · held 3\d s/.test(held())) fail(`time held while the phone was away is not counted: "${held()}"`);
if (!named('Kitchen Circuit')) fail(`the channel that stepped with the load is not listed: ${rows().map(r => r.textContent).join(' | ')}`);
if (!named('Garage Circuit')) fail('a channel that did rise was not listed as a candidate');
const bedroom = named('Bedroom Circuit');
if (bedroom && !/followed 0 of/.test(query(bedroom, '.cf-meta').textContent)) fail(`a 20 W drift inside ±15 W of noise was counted as a step: ${bedroom.textContent}`);
// The panel, the grid and the virtual node all stepped as well, being upstream — none of them is a circuit.
for (const other of ['Main Panel', 'Grid', 'Untracked remainder', 'Proxmox: Kube04', 'Kettle plug'])
  if (named(other)) fail(`${other} is not a breaker but was offered as a circuit`);
// …and they are one tick away for anyone who wants them.
const everyBox = query(sec, 'input[type=checkbox]', true)[0];
if (!everyBox || everyBox.checked) fail('the page does not default to circuits only');
everyBox.checked = true; everyBox.onchange({});
if (!named('Main Panel') || !named('Grid') || !named('Kettle plug')) fail('showing every channel did not bring the other channels back');
everyBox.checked = false; everyBox.onchange({});
if (named('Main Panel')) fail('unticking the box did not go back to circuits only');
if (/Kitchen Circuit —/.test(verdict())) fail(`one toggle named a channel outright: "${verdict()}"`);

// --- Toggle 2: the load goes off. The kitchen falls back; the garage stays up. ------------------------------
power.n30_2 = 100; power.n30_1 = 100; power.main_panel = 2000; power.grid = 3000; power.untracked = 200; power.pdu_7 = 90; power.kettle = 0;
hold(5); fumble();
await press();                                  // OFF
hold(20);
await look();
if (!/followed 2 of 2/.test(query(named('Kitchen Circuit'), '.cf-meta').textContent)) fail('the kitchen circuit did not follow both toggles');
if (!/followed 1 of 2/.test(query(named('Garage Circuit'), '.cf-meta').textContent)) fail('the garage circuit is not marked down for the toggle it missed');
if (rows()[0] !== named('Kitchen Circuit')) fail('the match is not at the top');
if (!/^Kitchen Circuit —/.test(verdict())) fail(`two toggles with one clear leader did not name it: "${verdict()}"`);
if (!named('Kitchen Circuit').classList.contains('is-found')) fail('the circuit found is not marked');
// Every row charts its channel over the session: the eye finds the steps that line up with the taps.
if (!query(named('Kitchen Circuit'), 'svg.cf-spark', false)) fail('a row has no chart of its channel');
if (!query(named('Kitchen Circuit'), '.cf-spark-on', true).length) fail('the chart does not shade the ON states');
if (!/noise/.test(query(named('Kitchen Circuit'), '.cf-meta').textContent)) fail('a row does not say how noisy its channel is');
// Three states, each with readings enough.
const chips = query(sec, '.cf-state', true);
if (chips.length !== 3) fail(`${chips.length} state chips for three states`);

// --- A mis-tap can be taken back ---------------------------------------------------------------------------
await press();
if (query(sec, '.cf-state', true).length !== 4) fail('a tap did not open a state');
button('Undo tap').onclick();
if (query(sec, '.cf-state', true).length !== 3) fail('Undo did not take the last tap back');

// --- A state held too briefly says so -----------------------------------------------------------------------
await press();                                  // ON, but not held
if (!/hold a little longer/.test(held())) fail(`a state with under two readings does not ask to be held longer: "${held()}"`);
if (!query(sec, '.cf-state', true).at(-1).classList.contains('is-thin')) fail('a thin state is not marked on its chip');

// --- A result row opens that node in the editor --------------------------------------------------------------
button('Undo tap').onclick();
const row = rows()[0];
if (row.tag !== 'button') fail(`a result row is a ${row.tag}, so it cannot be tapped to open the node`);
row.onclick();
await wait(60);
if (!query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes').classList.contains('active')) fail('tapping a result did not open the Nodes page');
await look();

// --- An expected draw rules out a step of the wrong size ------------------------------------------------------
button('Start over').onclick();
if (rows().length) fail('Start over left the old candidates on screen');
const drawInput = query(sec, 'input[type=number]', true)[0];
drawInput.value = '60'; drawInput.onchange({});
hold(10); await press();
power.n30_2 = 162; power.n30_3 = 2000;          // the lamp, and something large at the same moment
hold(5); fumble(); await press(); hold(20); await look();
if (!named('Kitchen Circuit') || !/followed 1 of 1/.test(query(named('Kitchen Circuit'), '.cf-meta').textContent)) fail('a 62 W step was not matched against a 60 W load');
if (named('Garage Circuit')) fail('a 1,500 W step was offered for a 60 W load');

// --- A load too small to see: the page says why, in watts --------------------------------------------------
button('Start over').onclick();
drawInput.value = ''; drawInput.onchange({});
power.n30_2 = 100; power.n30_3 = 100; power.n30_1 = 100;
hold(20); await press();
power.n30_1 = 108;                               // an 8 W night light on the noisy circuit
hold(5); fumble(); await press(); hold(20);
power.n30_1 = 100;
hold(5); fumble(); await press(); hold(20); await look();
if (!/No channel stands out/.test(verdict())) fail(`an 8 W load inside ±15 W of noise was found anyway: "${verdict()}"`);
if (!/has to draw about \d+ W/.test(verdict())) fail(`a miss does not say why in watts: "${verdict()}"`);

// --- A load that does not show on every toggle is still found ------------------------------------------
// A slow poll or a load that cycles misses a toggle. That costs it a little, not the verdict.
button('Start over').onclick();
power.n30_1 = 100; power.n30_2 = 100; power.n30_3 = 100; power.n30_4 = 100;
hold(20); await press();
power.n30_2 = 1100; hold(5); fumble(); await press(); hold(20);
power.n30_2 = 100; hold(5); fumble(); await press(); hold(20);
/* the third switch never showed: the load cycled off on its own before the reading */
fumble(); await press(); hold(20);
power.n30_2 = 1100; fumble(); /* back on for real */ hold(5);
power.n30_2 = 100; hold(5); fumble(); await press(); hold(20); await look();
if (!/^Kitchen Circuit —/.test(verdict())) fail(`a load that missed one toggle was not found: "${verdict()}"`);
if (!/followed [234] of 4/.test(query(named('Kitchen Circuit'), '.cf-meta').textContent)) fail(`the missed toggle is not shown: ${named('Kitchen Circuit').textContent}`);

// --- Several channels drifting a few watts together is not a load ---------------------------------------
button('Start over').onclick();
hold(20); await press();
power.n30_1 += 7; power.n30_2 += 7; power.n30_3 += 7; power.n30_4 += 7;
hold(5); fumble(); await press(); hold(20);
power.n30_1 -= 7; power.n30_2 -= 7; power.n30_3 -= 7; power.n30_4 -= 7;
hold(5); fumble(); await press(); hold(20); await look();
if (!/No channel stands out/.test(verdict())) fail(`four channels shifting 7 W together produced a winner: "${verdict()}"`);
if (!/together/.test(verdict())) fail(`a shift across the panel is not called one: "${verdict()}"`);

// --- A 240 V load steps both legs, and both are reported ---------------------------------------------------
button('Start over').onclick();
hold(20); await press();
power.n30_3 = 1300; power.n30_4 = 1250;
hold(5); fumble(); await press(); hold(20);
power.n30_3 = 100; power.n30_4 = 100;
hold(5); fumble(); await press(); hold(20); await look();
if (!/240 V/.test(verdict()) || !/Garage Circuit/.test(verdict()) || !/Garage Circuit B/.test(verdict()))
  fail(`a load stepping two channels together was not reported as both legs: "${verdict()}"`);

// --- A state's edges are left out: the stale reading before the PDU saw the switch, and the one after the
// next switch but before its tap. A short state is where that decides the answer.
{
  const t = 1_000_000;
  const samples = [
    { t: t + 1000, v: { k: 100 } },    // the PDU has not read the switch yet
    { t: t + 6000, v: { k: 1600 } },   // the state itself
    { t: t + 8500, v: { k: 100 } },    // switched off again, not yet tapped
  ];
  const [on] = vm.runInContext('levelsFrom', sandbox)(samples, [{ t, on: true }, { t: t + 10000, on: false }], { now: t + 20000, settleMs: 5000, guardMs: 3000 });
  if (on.mean.k !== 1600) fail(`a short state was judged by its edges (${on.mean.k} W) rather than the reading inside it`);
}

console.log('circuit finder: a tap is a timestamp — no cooldown — and each state is every reading the server '
  + 'recorded while it was held, the phone asleep or not; the open state reports how long and how many readings; '
  + 'a step counts when it clears the channel\'s own noise, so a drift inside it is not a match; near-misses stay '
  + 'listed and marked; a miss says the largest step against the noise and what a load must draw to be seen; a '
  + 'mis-tap can be undone; circuits are offered rather than the panel and grid that carry them; a known draw '
  + 'refuses a step of the wrong size; both legs of a 240 V breaker are reported; and a row opens the node');
process.exit(0);

// The panel schedule (#453): the panel drawn as it is — odd slots down the left, even down the right, a
// double-pole across the two slots it holds, a tandem as two halves of one — with the power of the node
// measuring each breaker (#454), never a zero where nothing measures it. The slot count, the breakers, a
// second breaker sharing a slot, and which node measures each leg are all edited here.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('panel schedule check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// The directory as config holds it. The API stands in for the bridge: it resolves the same config, so an edit
// made on the page comes back drawn.
const config = {
  History: { Enabled: false },
  EnergyFlow: {
    Nodes: [], Links: [],
    Panels: [{
      Id: 'main_panel', Name: 'Main Panel', Slots: 12,
      Breakers: [
        { Slot: 1, Number: '1,3', Poles: 2, Amps: 60, Description: 'AC Heat Strips', State: 'identified' },
        { Slot: 6, Number: 'B06', Wire: 'W11', Amps: 20, Description: 'Lights, Garage, Kitchen', State: 'identified' },
        { Slot: 9, Number: 'B09', Wire: 'W04', Description: 'Bathroom Lights', State: 'unknown' },
      ],
    }],
    Clamps: [
      { Label: 'C2', Panel: 'main_panel', Breaker: '1,3', Leg: 1, Wire: 'W01', Channel: 'n30_1_1' },
      { Label: 'C3', Panel: 'main_panel', Breaker: '1,3', Leg: 2, Wire: 'W02', Channel: 'n30_1_2' },
      { Label: 'C1', Panel: 'main_panel', Breaker: 'B06', Leg: 1, Wire: 'W11', Channel: 'n30_1_5' },
    ],
  },
};

// What each monitor channel reads.
const reading = { n30_1_1: 1100, n30_1_2: 1150, n30_1_5: 240, n30_1_8: 100 };
const nodes = [
  { id: 'n30_1_1', label: 'N30 1-1', kind: 'breaker', value: 1100 },
  { id: 'n30_1_2', label: 'N30 1-2', kind: 'breaker', value: 1150 },
  { id: 'n30_1_5', label: 'N30 1-5', kind: 'breaker', value: 240 },
  { id: 'n30_1_8', label: 'N30 1-8', kind: 'breaker', value: 100 },
  { id: 'main_panel', label: 'Main Panel', kind: 'panel', value: 2600 },
  { id: 'main_panel#unmeasured', label: 'Unmeasured load', kind: 'unmeasured', value: 60 },
];

/// The bridge's own resolution, as /api/panels reports it: the chain per leg, and a power only when every
/// link of it is there. GET answers from the saved directory; POST from whatever the page is holding.
const resolve = (flow) => ({
  ok: true, metric: 'realpower',
  panels: flow.Panels.map(p => ({
    id: p.Id, name: p.Name, slots: p.Slots, rows: Math.ceil(p.Slots / 2),
    breakers: (p.Breakers || []).map(b => {
      const legs = [];
      for (let leg = 1; leg <= (b.Poles || 1); leg++) {
        const c = (flow.Clamps || []).find(x => x.Panel === p.Id && x.Breaker === b.Number && (x.Leg || 1) === leg);
        legs.push({ leg, wire: c?.Wire || b.Wire || '', clamp: c?.Label ?? null, channel: c?.Channel ?? null, reversed: !!c?.Reversed });
      }
      let sum = 0, gap = 'none';
      for (const l of legs) {
        if (!l.clamp) { gap = 'noclamp'; break; }
        if (!l.channel) { gap = 'nochannel'; break; }
        if (reading[l.channel] == null) { gap = 'noreading'; break; }
        sum += reading[l.channel];
      }
      return {
        slot: b.Slot, occupies: (b.Poles || 1) === 2 ? [b.Slot, b.Slot + 2] : [b.Slot],
        number: b.Number, poles: b.Poles || 1, half: b.Half ?? null, amps: b.Amps ?? null,
        wire: b.Wire || '', description: b.Description || '', state: b.State || 'unknown',
        power: gap === 'none' ? sum : null, gap, legs,
      };
    }),
  })),
});

// What the bridge has on disk. Nothing in this check ever saves, so it never changes: an edit that shows up
// on the page can only have come from the page sending what it is holding.
const saved = structuredClone(config);

const { sandbox, getEl } = makeDom({
  bodies: (url, opts) => url.includes('/api/panels/resolve') ? resolve(JSON.parse(opts.body).EnergyFlow)
    : url.includes('/api/panels') ? resolve(saved.EnergyFlow)
    : url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
        : url.includes('/api/config') ? config
          : url.includes('/api/flow') ? { ok: true, nodes, links: [] }
            : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(50);

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Panel Schedule');
if (!link) fail('no Panel Schedule page');
link.click();
await wait(200);
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('clicking Panel Schedule activated no section');

const cells = () => query(sec, '.ps-cell', true);
const cellAt = (slot) => cells().find(c => (query(c, '.ps-slot') || {}).textContent?.startsWith(String(slot)));
const textOf = (c) => (c?.textContent || '').replace(/\s+/g, ' ');
const halves = (slot) => query(cellAt(slot), '.ps-half', true);
const breakerIn = (number) => config.EnergyFlow.Panels[0].Breakers.find(b => b.Number === number);
const clampFor = (number, leg = 1) => (config.EnergyFlow.Clamps || []).find(c => c.Breaker === number && (c.Leg || 1) === leg);
const sheet = () => query(getEl('overlay'), '.sheet');
const apply = async () => { query(sheet(), 'button', true).find(b => b.textContent === 'Apply').onclick(); await wait(100); };

// The panel is drawn as it is: odd down the left column, even down the right.
if (!cells().length) fail('the panel drew no slots');
const placed = (slot) => (cellAt(slot)?.style || {});
if (placed(1).gridColumn !== '1' || placed(2).gridColumn !== '2')
  fail(`odd and even slots are not in their own columns: ${placed(1).gridColumn} / ${placed(2).gridColumn}`);
if (placed(5).gridRow !== '3 / span 1') fail(`slot 5 is not in the third row down its column: ${placed(5).gridRow}`);

// A double-pole is drawn across the two slots it holds, and the slot it reaches into is not drawn again.
if (placed(1).gridRow !== '1 / span 2') fail(`the double-pole does not span its two slots: ${placed(1).gridRow}`);
if (cells().some(c => (query(c, '.ps-slot') || {}).textContent === '3'))
  fail('slot 3 is drawn again beneath the double-pole that already holds it');
if (!/1\+3/.test(textOf(cellAt(1)))) fail(`the double-pole does not say which slots it holds: ${textOf(cellAt(1))}`);

// It reads as a panel: an enclosure with a bus bar down the middle and a handle on every breaker.
if (!query(sec, '.ps-panel')) fail('the schedule is not drawn inside a panel enclosure');
if (!query(sec, '.ps-bus')) fail('the panel has no bus bar down the middle');
if (!query(cellAt(6), '.ps-handle')) fail('a breaker has no handle');
if (!query(cellAt(9), '.ps-handle').classList.contains('is-unknown'))
  fail('an unidentified breaker’s handle does not show it');
if (!cellAt(1).classList.contains('is-left') || !cellAt(2).classList.contains('is-right'))
  fail('the cells do not know which side of the bus they are on, so the handles cannot face it');
for (const rule of ['.ps-bus', '.ps-handle'])
  if (!new RegExp(rule.replace('.', '\\.') + '\\s*\\{').test(css)) fail(`the stylesheet has no ${rule} rule`);

// Power comes from the node measuring the breaker; a breaker nothing measures reads no data, never zero.
if (!/240 W/.test(textOf(cellAt(6)))) fail(`the mapped breaker does not show its power: ${textOf(cellAt(6))}`);
if (!/2,250 W/.test(textOf(cellAt(1)))) fail(`the double-pole does not show both legs summed: ${textOf(cellAt(1))}`);
const unmapped = () => cellAt(9);
if (!/no data/.test(textOf(unmapped()))) fail(`an unmapped breaker does not read "no data": ${textOf(unmapped())}`);
if (/\b0 W/.test(textOf(unmapped()))) fail(`an unmapped breaker reads as zero: ${textOf(unmapped())}`);
if (!/measuring this breaker/i.test(halves(9)[0].title || ''))
  fail(`nothing says why the power is missing: "${halves(9)[0].title}"`);

// The gaps in the directory are visible at a glance.
if (!/\?\?\?\?/.test(textOf(unmapped()))) fail(`an unknown breaker is not marked as unidentified: ${textOf(unmapped())}`);
const empty = () => cells().find(c => c.classList.contains('is-empty'));
if (!empty() || !/empty/.test(textOf(empty()))) fail('slots with nothing recorded are not drawn as empty');

// How many slots the panel has is the panel's own setting, and the drawing follows it at once.
const slotsIn = query(sec, '.ps-slots');
if (!slotsIn || slotsIn.value !== '12') fail(`the panel does not offer its slot count: ${slotsIn?.value}`);
slotsIn.value = '6';
slotsIn.onchange({});
await wait(60);
if (config.EnergyFlow.Panels[0].Slots !== 6) fail(`the slot count did not reach the config: ${config.EnergyFlow.Panels[0].Slots}`);
if (cellAt(9)) fail('slot 9 is still drawn on a six-slot panel');
// An odd count would leave half a row, so it is rounded up to whole rows.
slotsIn.value = '11';
slotsIn.onchange({});
await wait(60);
if (config.EnergyFlow.Panels[0].Slots !== 12) fail(`an odd slot count was not rounded to whole rows: ${config.EnergyFlow.Panels[0].Slots}`);
if (!cellAt(9)) fail('growing the panel did not draw the slots it gained');

// Two separate breakers can share one slot: the tandem button adds the second half.
const tandemBtn = query(cellAt(6), '.ps-tandem');
if (!tandemBtn) fail('a slot with one breaker offers no way to add a second sharing it');
tandemBtn.onclick();
await wait(100);
if (!sheet()) fail('adding a tandem half did not open an editor for it');
const halfSel = query(sheet(), 'select', true).find(s => (s.children || []).some(o => o.textContent === 'tandem, lower half'));
if (halfSel.value !== '2') fail(`the second breaker in the slot is not preset to the lower half: ${halfSel.value}`);
const numberIn = query(sheet(), 'input', true)[0];
numberIn.value = '6.2';
query(sheet(), 'input', true).find(i => i.attrs.placeholder === 'what it feeds').value = 'Freezer';
await apply();
if (breakerIn('B06').Half !== 1) fail('the breaker already in the slot was not made the upper half');
const second = breakerIn('6.2');
if (!second || second.Slot !== 6 || second.Half !== 2) fail('the second breaker did not land in the same slot as a tandem half');
if (halves(6).length !== 2) fail(`the slot is not drawn as two breakers: ${textOf(cellAt(6))}`);
// Each half is edited on its own, not just the first.
halves(6)[1].onclick();
await wait(100);
if (!/6\.2/.test(query(sheet(), 'input', true)[0].value)) fail('tapping the lower half opened the upper half instead');

// A breaker is pointed at the node its circuit is on, and the chain behind it is written for it.
const nodeSel = () => query(sheet(), '.ps-node', true)[0];
if (!nodeSel()) fail('the editor offers no node to measure the breaker');
const offered = (nodeSel().children || []).map(o => o.value);
if (!offered.includes('n30_1_8')) fail(`the circuit nodes are not offered: ${offered.join(', ')}`);
if (offered.includes('main_panel')) fail('the panel carrying the breaker is offered as the thing measuring it');
if (offered.includes('main_panel#unmeasured')) fail('an unmetered remainder is offered as a circuit');
nodeSel().value = 'n30_1_8';
await apply();
const mapped = clampFor('6.2');
if (!mapped || mapped.Channel !== 'n30_1_8') fail('picking a node did not record what measures the breaker');
if (mapped.Panel !== 'main_panel' || (mapped.Leg || 1) !== 1) fail('the record does not say which breaker and leg it is for');
if (!/100 W/.test(textOf(cellAt(6)))) fail(`the breaker did not take its power from the node picked: ${textOf(cellAt(6))}`);

// A node already measuring another breaker is offered, but said to be taken.
halves(9)[0].onclick();
await wait(100);
const taken = (nodeSel().children || []).find(o => o.value === 'n30_1_8');
if (!/already on/.test(taken.textContent || '')) fail(`a node already measuring another breaker is not flagged: "${taken.textContent}"`);
// …and clearing the pick takes the record away again rather than leaving a dangling one.
nodeSel().value = '';
await apply();
halves(6)[1].onclick();
await wait(100);
nodeSel().value = '';
await apply();
if (clampFor('6.2')) fail('clearing the node left the record behind');
if (!/no data/.test(textOf(cellAt(6)))) fail('clearing the node did not take the power away with it');

// A breaker is edited in place, and the edit lands on the config entry rather than the drawn copy.
halves(6)[0].onclick();
await wait(100);
const desc = query(sheet(), 'input', true).find(i => i.value === 'Lights, Garage, Kitchen');
if (!desc) fail('the editor does not carry what the breaker feeds');
desc.value = 'Garage lights only';
await apply();
if (breakerIn('B06').Description !== 'Garage lights only') fail('the edit did not reach the config');
if (sheet()) fail('the editor stayed open after applying');

// A slot nobody has recorded can be filled in.
const filledSlot = query(empty(), '.ps-slot').textContent;
query(empty(), '.ps-half').onclick();
await wait(100);
query(sheet(), 'input', true)[0].value = 'B02';
query(sheet(), 'input', true).find(i => i.attrs.placeholder === 'what it feeds').value = 'Fridge';
await apply();
if (!breakerIn('B02') || breakerIn('B02').Description !== 'Fridge') fail('filling in an empty slot did not add a breaker');

// None of the above was ever saved: the page draws the directory it is holding, so an edit shows without a
// save and a page refresh.
if (saved.EnergyFlow.Panels[0].Breakers.some(b => b.Number === 'B02'))
  fail('the check saved the directory, so drawing it proves nothing');
if (!/Fridge/.test(textOf(cellAt(filledSlot)))) fail('an unsaved breaker is not drawn — it takes a save and a refresh to appear');
if (saved.EnergyFlow.Panels[0].Slots !== 12 || config.EnergyFlow.Panels[0].Slots !== 12)
  fail('the slot count was not the one being edited');

// A phone holds one column, and that has to outrank the placement written on each cell.
const rules = [...css.matchAll(/@media \(max-width: *560px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map(m => m[1]).join('\n');
if (!/\.ps-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(rules)) fail('the panel keeps two columns on a phone');
if (!/\.ps-cell\s*\{[^}]*grid-column:\s*1\s*!important/.test(rules))
  fail('the cells keep their two-column placement on a phone — inline placement outranks the media query');

console.log('panel schedule: drawn as a panel — enclosure, bus bar and a handle per breaker, odd left and even right, '
  + 'a double-pole across both its slots, a tandem as two halves; the slot count is the panel’s own setting and rounds '
  + 'to whole rows; a second breaker can be added to a slot and each half edited on its own; a breaker is pointed at the '
  + 'node measuring it (upstream nodes not offered, a taken one flagged, clearing it removes the record) and takes its '
  + 'power from it, reading no data rather than zero without one; edits land in the config; and a phone gets one column');
process.exit(0);

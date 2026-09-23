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
    Nodes: [],
    // The circuit on n30_1_1 hangs off the grid today, so mapping it to a breaker has something to replace.
    Links: [{ From: 'grid', To: 'n30_1_1' }],
    Panels: [{
      Id: 'main_panel', Name: 'Main Panel', Slots: 12,
      Breakers: [
        { Slot: 1, Number: '1,3', Poles: 2, Amps: 60, Description: 'AC Heat Strips', State: 'identified' },
        { Slot: 6, Number: 'B06', Wire: 'W11', Gauge: '12 AWG THWN', Conductor: 'copper', Amps: 20, Description: 'Lights, Garage, Kitchen', State: 'identified' },
        { Slot: 9, Number: 'B09', Wire: 'W04', Description: 'Bathroom Lights', State: 'unknown' },
        { Slot: 10, Number: 'B10', Wire: 'W13', Amps: 15, Description: 'Garage Freezer', State: 'identified' },
        // Measured, but nobody has written down what breaker holds it.
        { Slot: 12, Number: 'B12', Wire: 'W14', Description: 'Hall lights', State: 'identified' },
      ],
    }],
    Clamps: [
      { Label: 'C2', Panel: 'main_panel', Breaker: '1,3', Leg: 1, Wire: 'W01', Channel: 'n30_1_1' },
      { Label: 'C3', Panel: 'main_panel', Breaker: '1,3', Leg: 2, Wire: 'W02', Channel: 'n30_1_2' },
      { Label: 'C1', Panel: 'main_panel', Breaker: 'B06', Leg: 1, Wire: 'W11', Channel: 'n30_1_5' },
      { Label: 'C5', Panel: 'main_panel', Breaker: 'B10', Leg: 1, Wire: 'W13', Channel: 'n30_1_8' },
      { Label: 'C6', Panel: 'main_panel', Breaker: 'B12', Leg: 1, Wire: 'W14', Channel: 'n30_1_9' },
    ],
  },
};

// What each monitor channel reads.
const reading = { n30_1_1: 1100, n30_1_2: 1150, n30_1_5: 240, n30_1_8: 100, n30_1_9: 150, main_panel: 2600 };
// What each channel reads in amps: the kitchen circuit is working hard against its 20 A breaker.
const amps = { n30_1_1: 9.2, n30_1_2: 9.4, n30_1_5: 17.2, n30_1_8: 9.5, n30_1_9: 1.3 };
// What the mains are sitting at, where anything measures it.
const voltage = { main_panel: 241.3 };
const nodes = [
  { id: 'n30_1_1', label: 'N30 1-1', kind: 'breaker', value: 1100 },
  { id: 'n30_1_2', label: 'N30 1-2', kind: 'breaker', value: 1150 },
  { id: 'n30_1_5', label: 'N30 1-5', kind: 'breaker', value: 240 },
  { id: 'n30_1_8', label: 'N30 1-8', kind: 'breaker', value: 100 },
  { id: 'n30_1_9', label: 'N30 1-9', kind: 'breaker', value: 150 },
  { id: 'main_panel', label: 'Main Panel', kind: 'panel', value: 2600 },
  { id: 'grid', label: 'Grid', kind: 'grid', value: 3000 },
  { id: 'main_panel#unmeasured', label: 'Unmeasured load', kind: 'unmeasured', value: 60 },
];

/// The bridge's own resolution, as /api/panels reports it: the chain per leg, and a power only when every
/// link of it is there. GET answers from the saved directory; POST from whatever the page is holding.
const resolve = (flow) => ({
  ok: true, metric: 'realpower',
  // What the bridge's own check says about the mapping (#457): here, a channel claimed by two breakers.
  findings: Object.entries((flow.Clamps || []).reduce((acc, c) => { (acc[c.Channel] ||= []).push(`${c.Panel}/${c.Breaker}`); return acc; }, {}))
    .filter(([, on]) => on.length > 1)
    .map(([ch, on]) => ({ kind: 'channel-shared', severity: 'bad', channels: [ch], breakers: on,
      message: `${ch} is mapped to ${on.length} breakers: ${on.join(', ')}. Only one of them is measured by it.` })),
  panels: flow.Panels.map(p => ({
    id: p.Id, name: p.Name, slots: p.Slots, rows: Math.ceil(p.Slots / 2),
    node: p.Node || '',
    incoming: p.Node && reading[p.Node] != null ? reading[p.Node] : null,
    volts: p.Node && voltage[p.Node] != null ? voltage[p.Node] : null,
    breakers: (p.Breakers || []).map(b => {
      const legs = [];
      for (let leg = 1; leg <= (b.Poles || 1); leg++) {
        const c = (flow.Clamps || []).find(x => x.Panel === p.Id && x.Breaker === b.Number && (x.Leg || 1) === leg);
        legs.push({ leg, wire: c?.Wire || b.Wire || '', clamp: c?.Label ?? null, channel: c?.Channel ?? null, reversed: !!c?.Reversed, whole: !!c?.Whole });
      }
      // One CT measuring the whole circuit is the breaker's power; the other leg is then not expected.
      const counted = legs.some(l => l.whole) ? legs.filter(l => l.whole) : legs;
      let sum = 0, gap = 'none', current = null;
      for (const l of counted) {
        if (!l.clamp) { gap = 'noclamp'; break; }
        if (!l.channel) { gap = 'nochannel'; break; }
        if (reading[l.channel] == null) { gap = 'noreading'; break; }
        sum += reading[l.channel];
        // Both legs of a 240 V circuit carry the same current, so the breaker's figure is the larger leg's.
        if (amps[l.channel] != null) current = Math.max(current ?? 0, amps[l.channel]);
      }
      return {
        slot: b.Slot, occupies: (b.Poles || 1) === 2 ? [b.Slot, b.Slot + 2] : [b.Slot],
        number: b.Number, poles: b.Poles || 1, half: b.Half ?? null, amps: b.Amps ?? null,
        wire: b.Wire || '', gauge: b.Gauge || '', conductor: b.Conductor || '',
        description: b.Description || '', state: b.State || 'unknown',
        power: gap === 'none' ? sum : null, current: gap === 'none' ? current : null, gap, legs,
        // The breaker as a tier of the flow (#458): its own node unless it names one.
        node: b.Node || (counted.some(l => l.channel) ? `breaker:${p.Id}:${b.Number}` : null),
        derived: !b.Node,
      };
    }),
  })),
});

// What the bridge has on disk. Nothing in this check ever saves, so it never changes: an edit that shows up
// on the page can only have come from the page sending what it is holding.
const saved = structuredClone(config);

// What the history backend holds, and every window the page asks it for.
const series = [];
const when = (i) => new Date(Date.UTC(2026, 8, 20, 4 + i)).toISOString();
// Dense enough that where the pointer lands matters: 21 samples, one of them missing, rising to 180 W.
const SAMPLES = 21, GAP_AT = 7;
const seriesBody = () => ({
  ok: true, metric: 'realpower', units: 'W',
  at: Array.from({ length: SAMPLES }, (_, i) => when(i)),
  series: [{
    node: 'n30_1_5', label: 'N30 1-5', kind: 'breaker',
    values: Array.from({ length: SAMPLES }, (_, i) => (i === GAP_AT ? null : 100 + i * 4)),
  }],
});
// The chart's own coordinates: a gutter down the left for the scale, then the plot.
const CHART_W = 560, PAD_L = 44, PAD_R = 3;
const stepX = (CHART_W - PAD_L - PAD_R) / (SAMPLES - 1);
const atX = (i) => PAD_L + i * stepX;

const { sandbox, getEl } = makeDom({
  bodies: (url, opts) => url.includes('/api/flow/series') ? (series.push(url), seriesBody())
    : url.includes('/api/panels/resolve') ? resolve(JSON.parse(opts.body).EnergyFlow)
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
const cellAt = (slot) => cells().find(c => c.dataset?.slot === String(slot));
const gutters = () => query(sec, '.ps-nums', true);
const gutterAt = (row, col = '1') => gutters().find(g => (g.style.gridRow || '').startsWith(`${row} /`) && g.style.gridColumn === col);
const numbersIn = (g) => query(g, 'span', true).map(s => s.textContent);
const textOf = (c) => (c?.textContent || '').replace(/\s+/g, ' ');
const halves = (slot) => query(cellAt(slot), '.ps-open', true);
const readings = (slot) => query(cellAt(slot), '.ps-power', true);
const breakerIn = (number) => config.EnergyFlow.Panels[0].Breakers.find(b => b.Number === number);
const clampFor = (number, leg = 1) => (config.EnergyFlow.Clamps || []).find(c => c.Breaker === number && (c.Leg || 1) === leg);
const sheet = () => query(getEl('overlay'), '.sheet');
// Clicking the backdrop is how a sheet is dismissed.
const shut = () => getEl('overlay').onclick({ target: getEl('overlay') });
const apply = async () => { query(sheet(), 'button', true).find(b => b.textContent === 'Apply').onclick(); await wait(100); };

// The panel is drawn as it is: odd down the left column, even down the right.
if (!cells().length) fail('the panel drew no slots');
const placed = (slot) => (cellAt(slot)?.style || {});
// Columns 1 and 4 are the number stamps down the frame's edges; the breakers sit in 2 and 3 between them.
if (placed(1).gridColumn !== '2' || placed(2).gridColumn !== '3')
  fail(`odd and even slots are not in their own columns: ${placed(1).gridColumn} / ${placed(2).gridColumn}`);
if (placed(5).gridRow !== '3 / span 1') fail(`slot 5 is not in the third row down its column: ${placed(5).gridRow}`);

// A double-pole is drawn across the two slots it holds, and the slot it reaches into is not drawn again.
if (placed(1).gridRow !== '1 / span 2') fail(`the double-pole does not span its two slots: ${placed(1).gridRow}`);
// …and those two rows are each a slot tall, so it stands twice as tall as a single-pole. Left to size
// themselves, the rows a double spans hold nothing else and split its height between them instead.
const rowTemplate = query(sec, '.ps-grid').style.gridTemplateRows || '';
if (!/minmax\(var\(--ps-row\)/.test(rowTemplate)) fail(`the panel's rows are not a slot tall: "${rowTemplate}"`);
if (!/--ps-row:\s*\d+px/.test(css)) fail('the stylesheet does not say how tall a slot is');
if (cells().some(c => c.dataset?.slot === '3'))
  fail('slot 3 is drawn again beneath the double-pole that already holds it');

// The slot numbers are stamped down the outside edges of the frame, one per slot, counted down the column —
// not inside the breaker.
if (query(sec, '.ps-slot', true).length) fail('the slot number is still drawn inside the breaker');
const stamps = (row, col) => JSON.stringify(numbersIn(gutterAt(row, col) || {}));
if (!gutterAt(1, '1')) fail('the left column has no number stamped outside it');
if (!gutterAt(1, '4')) fail('the right column has no number stamped outside it');
// A double-pole is stamped with both of the slots it holds, one under the other.
if (stamps(1, '1') !== JSON.stringify(['1', '3'])) fail(`the double-pole is not stamped with both its slots: ${stamps(1, '1')}`);
// Odd numbers count down the left edge, even down the right, a row at a time.
if (stamps(3, '1') !== JSON.stringify(['5'])) fail(`the left edge does not count down in odd slots: ${stamps(3, '1')}`);
if (stamps(1, '4') !== JSON.stringify(['2'])) fail(`the right edge does not start at slot 2: ${stamps(1, '4')}`);
if (stamps(3, '4') !== JSON.stringify(['6'])) fail(`the right edge does not count down in even slots: ${stamps(3, '4')}`);
// A number that only repeats the slots stamped beside it is not drawn on the breaker as well.
if (/1,3/.test(textOf(cellAt(1)))) fail(`the breaker number repeats the slots it is already stamped with: ${textOf(cellAt(1))}`);
if (query(cellAt(1), '.ps-num', true).length) fail('a breaker numbered after its own slots still draws its number');
// …but a number that says something the slots do not is kept.
if (!/B06/.test(textOf(cellAt(6)))) fail(`a breaker's own number is not shown: ${textOf(cellAt(6))}`);

// It reads as a panel: an enclosure with a bus bar down the middle and a handle on every breaker.
if (!query(sec, '.ps-panel')) fail('the schedule is not drawn inside a panel enclosure');
if (!query(sec, '.ps-bus')) fail('the panel has no bus bar down the middle');
if (!query(cellAt(6), '.ps-breaker')) fail('a breaker is not drawn as one');
// A double-pole is two handles tied together, as it is on the wall; a single-pole is one and no tie.
const polesIn = (slot) => query(cellAt(slot), '.ps-pole', true).length;
if (polesIn(1) !== 2) fail(`the double-pole is drawn with ${polesIn(1)} handles`);
if (!query(cellAt(1), '.ps-tie')) fail('the double-pole\u2019s handles are not tied together');
if (polesIn(6) !== 1) fail(`a single-pole breaker is drawn with ${polesIn(6)} handles`);
if (query(cellAt(6), '.ps-tie')) fail('a single-pole breaker was given a tie');
// The rating is stamped on the handle, as it is on the real thing.
const stamped = query(cellAt(1), '.ps-throw', true).map(t => t.textContent);
if (JSON.stringify(stamped) !== JSON.stringify(['60', '60'])) fail(`the rating is not stamped on both handles: ${stamped.join(',')}`);
if (query(cellAt(9), '.ps-throw')?.textContent) fail('a breaker with no rating stamped something on its handle');
// The handle is how a breaker looks, not a control: nothing here can switch one, so it carries no wording
// and is hidden from anything reading the page aloud.
const handle = query(cellAt(6), '.ps-breaker');
if (handle.attrs['aria-hidden'] !== 'true') fail('the drawn breaker is not hidden from assistive tech');
if (handle.tag === 'button') fail('the breaker is a button, but nothing can switch one from here');
if (!query(cellAt(9), '.ps-pole').classList.contains('is-unknown'))
  fail('an unidentified breaker’s handle does not show it');
if (!cellAt(1).classList.contains('is-left') || !cellAt(2).classList.contains('is-right'))
  fail('the cells do not know which side of the bus they are on, so the handles cannot face it');
for (const rule of ['.ps-bus', '.ps-pole', '.ps-tie'])
  if (!new RegExp(rule.replace('.', '\\.') + '\\s*\\{').test(css)) fail(`the stylesheet has no ${rule} rule`);

// Power comes from the node measuring the breaker; a breaker nothing measures reads no data, never zero.
if (!/240 W/.test(textOf(cellAt(6)))) fail(`the mapped breaker does not show its power: ${textOf(cellAt(6))}`);
if (!/2,250 W/.test(textOf(cellAt(1)))) fail(`the double-pole does not show both legs summed: ${textOf(cellAt(1))}`);
const unmapped = () => cellAt(9);
if (!/no data/.test(textOf(unmapped()))) fail(`an unmapped breaker does not read "no data": ${textOf(unmapped())}`);
if (/\b0 W/.test(textOf(unmapped()))) fail(`an unmapped breaker reads as zero: ${textOf(unmapped())}`);
// The gap lives on the reading itself, which is what someone taps to ask why.
if (!/measuring this breaker/i.test(readings(9)[0].title || ''))
  fail(`nothing says why the power is missing: "${readings(9)[0].title}"`);

// The same reading in the unit the question is being asked in, and coloured by how hard the circuit is
// working against the breaker holding it.
const unit = () => query(sec, '.ps-unit');
if (!unit()) fail('there is no way to switch between watts and amps');
if (!/240 W/.test(textOf(cellAt(6)))) fail('the panel does not open in watts');
const power6 = () => readings(6)[0];
// 17.2 A of a 20 A breaker is 86% of it; 9.5 of 15 is 63%; 9.4 of 60 is 16%.
if (!power6().classList.contains('is-over')) fail(`17.2 A of a 20 A breaker is not marked as over: ${power6().className}`);
if (!readings(10)[0].classList.contains('is-busy')) fail(`9.5 A of a 15 A breaker is not marked as busy: ${readings(10)[0].className}`);
if (!readings(1)[0].classList.contains('is-easy')) fail(`9.4 A of a 60 A breaker is not marked as easy: ${readings(1)[0].className}`);
if (!/17\.2 A of 20 A/.test(power6().title || '')) fail(`the reading does not say how it sits against the rating: "${power6().title}"`);
// A breaker with no rating is reading 1.3 A, and is still not coloured: how hard it is working is a
// question about its rating, and inventing one would answer it with a number nobody wrote down.
if (/is-(easy|busy|over)/.test(readings(12)[0].className || ''))
  fail(`a breaker with no rating was coloured anyway: ${readings(12)[0].className}`);
unit().value = 'A';
unit().onchange({});
await wait(60);
if (!/17\.2 A/.test(textOf(cellAt(6)))) fail(`switching to amps did not change the reading: ${textOf(cellAt(6))}`);
if (/240 W/.test(textOf(cellAt(6)))) fail('the watts reading stayed after switching to amps');
unit().value = 'W';
unit().onchange({});
await wait(60);

// The wire's gauge is on the row, beside its label and rating.
if (!/12 AWG THWN/.test(textOf(cellAt(6)))) fail(`the wire's gauge is not shown: ${textOf(cellAt(6))}`);

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

// Two separate breakers can share one slot. Saying so is the editor's business — there is no button on the
// panel for it, since a slot that is not shared should not be inviting one.
if (query(sec, '.ps-tandem', true).length) fail('the panel still offers a tandem button of its own');
halves(6)[0].onclick();
await wait(100);
const halfSel = query(sheet(), 'select', true).find(s => (s.children || []).some(o => o.textContent === 'tandem, lower half'));
if (!halfSel) fail('the breaker editor cannot say a slot is shared');
halfSel.value = '1';
await apply();
if (breakerIn('B06').Half !== 1) fail('setting the breaker as a tandem half did not reach the config');
// Its slot now shows the other half as somewhere to fill in.
const otherHalf = query(cellAt(6), '.ps-open', true).find(b => /empty lower half/.test(b.textContent || ''));
if (!otherHalf) fail(`a tandem half leaves nowhere to put the other one: ${textOf(cellAt(6))}`);
otherHalf.onclick();
await wait(100);
if (!sheet()) fail('the empty half of a tandem opened no editor');
const preset = query(sheet(), 'select', true).find(s => (s.children || []).some(o => o.textContent === 'tandem, lower half'));
if (preset.value !== '2') fail(`the empty half is not preset to the half it is: ${preset.value}`);
const numberIn = query(sheet(), 'input', true)[0];
numberIn.value = '6.2';
query(sheet(), 'input', true).find(i => i.attrs.placeholder === 'what it feeds').value = 'Freezer';
await apply();
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
// A house has more channels than anyone wants to scroll, so the list is typed down.
const hunt = () => query(sheet(), '.ps-hunt');
const shownCount = () => (query(sheet(), 'span', true).map(s => s.textContent).find(t => /channels$/.test(t || '')) || '');
const optionsOf = () => (nodeSel().children || []).map(o => o.value).filter(Boolean);
if (!hunt()) fail('the channel picker cannot be searched');
if (!/5 of 5 channels/.test(shownCount())) fail(`the picker does not say what it is showing: "${shownCount()}"`);
hunt().value = '1_8';
hunt().oninput({});
await wait(30);
if (JSON.stringify(optionsOf()) !== JSON.stringify(['n30_1_8'])) fail(`typing did not narrow the list: ${optionsOf().join(', ')}`);
if (!/1 of 5 channels/.test(shownCount())) fail(`the count does not follow the filter: "${shownCount()}"`);
// A filter that matches nothing must not quietly unpick what is already chosen.
nodeSel().value = 'n30_1_8';
hunt().value = 'zzz';
hunt().oninput({});
await wait(30);
if (nodeSel().value !== 'n30_1_8') fail('narrowing the list unpicked the channel that was already chosen');
if (!optionsOf().includes('n30_1_8')) fail('the chosen channel was filtered out from under the person looking at it');
// Clearing it brings the rest back.
hunt().value = '';
hunt().oninput({});
await wait(30);
if (optionsOf().length !== 5) fail(`clearing the filter did not bring the channels back: ${optionsOf().join(', ')}`);

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

// A 240 V circuit is often measured by one CT. That clamp is the whole breaker, not half of it.
halves(1)[0].onclick();
await wait(100);
if (query(sheet(), '.ps-node', true).length !== 2) fail('a double-pole does not ask for a node per leg');
const wholeBox = query(sheet(), '.ps-whole');
if (!wholeBox || wholeBox.checked) fail('a double-pole does not offer that one CT measures the whole circuit');
wholeBox.checked = true;
wholeBox.onchange({});
await wait(30);
if (query(sheet(), '.ps-node', true).length !== 1) fail('with one CT on the circuit the editor still asks for two');
query(sheet(), '.ps-node', true)[0].value = 'n30_1_5';
await apply();
const wholeClamp = clampFor('1,3');
if (!wholeClamp?.Whole) fail('the clamp was not recorded as measuring the whole circuit');
if (clampFor('1,3', 2)) fail('a second leg was recorded for a circuit measured by one CT');
if (!/240 W/.test(textOf(cellAt(1)))) fail(`one CT on the circuit did not give the breaker its power: ${textOf(cellAt(1))}`);

// Untick it and the breaker wants both legs again, so one clamp is no longer the whole answer.
halves(1)[0].onclick();
await wait(100);
query(sheet(), '.ps-whole').checked = false;
query(sheet(), '.ps-whole').onchange({});
await wait(30);
await apply();
if (!/no data/.test(textOf(cellAt(1)))) fail('half a double-pole was reported as the whole breaker');

// The panel is itself a node in the flow: its reading is the power coming into the panel.
const links = () => config.EnergyFlow.Links;
const panelNodeSel = () => query(sec, '.ps-panel-node');
const incomingText = () => query(sec, '.ps-incoming').textContent || '';
if (!panelNodeSel()) fail('the panel cannot be told which node it is');
if (!/No node is mapped/.test(incomingText())) fail(`a panel with no node claims an incoming figure: "${incomingText()}"`);
panelNodeSel().value = 'main_panel';
panelNodeSel().onchange({});
await wait(100);
if (config.EnergyFlow.Panels[0].Node !== 'main_panel') fail('the panel\u2019s node did not reach the config');
if (!/2,600 W/.test(incomingText())) fail(`the power coming into the panel is not drawn: "${incomingText()}"`);

// The mains voltage is shown beside the power, where whatever measures the panel reports one.
if (!/241\.3 V/.test(incomingText())) fail(`the mains voltage is not shown: "${incomingText()}"`);

// A panel whose node has no reading says so, rather than drawing a zero.
panelNodeSel().value = 'grid';
panelNodeSel().onchange({});
await wait(100);
if (!/no data/.test(incomingText())) fail(`a panel node with no reading does not say so: "${incomingText()}"`);
if (/\b0 W/.test(incomingText())) fail(`a panel with no reading draws zero: "${incomingText()}"`);
// …and a node that reports no voltage is not given one.
if (/ V\b/.test(incomingText())) fail(`a voltage was shown for a node that reports none: "${incomingText()}"`);
panelNodeSel().value = 'main_panel';
panelNodeSel().onchange({});
await wait(100);

// What feeds the panel is picked here as well, and taken away here.
const feedAdd = () => query(sec, '.ps-feed-add');
feedAdd().value = 'grid';
feedAdd().onchange({});
await wait(60);
if (!links().some(l => l.From === 'grid' && l.To === 'main_panel')) fail('picking a feeder did not connect it to the panel');
const chip = () => query(sec, '.ps-chip');
if (!/Grid/.test(chip()?.textContent || '')) fail('the panel does not show what feeds it');
// A panel is fed from one place, so nothing offers to add a second.
if (!feedAdd().hidden) fail('a panel that already has a feeder still offers to add another');
query(chip(), '.ps-chip-x').onclick();
await wait(60);
if (links().some(l => l.From === 'grid' && l.To === 'main_panel')) fail('dropping the feeder left the connection behind');
if (feedAdd().hidden) fail('dropping the feeder left no way to pick another');
feedAdd().value = 'grid';
feedAdd().onchange({});
await wait(60);

// A breaker mapped to a channel records the clamp; the breaker is a tier of the flow in its own right (#458),
// so nothing is wired from the panel to the channel by hand.
halves(9)[0].onclick();
await wait(100);
nodeSel().value = 'n30_1_1';
await apply();
if (clampFor('B09')?.Channel !== 'n30_1_1') fail('mapping the breaker did not record what measures it');
if (links().some(l => l.From === 'main_panel' && l.To === 'n30_1_1')) fail('mapping a breaker still wires the panel straight to the channel');
if (!links().some(l => l.From === 'grid' && l.To === 'n30_1_1')) fail('mapping a breaker rewrote the links the operator had');

// …and the breaker's editor says which node it is on the flow.
halves(9)[0].onclick();
await wait(100);
if (!/breaker:main_panel:B09/.test(textOf(sheet()))) fail(`the breaker does not say which node it is: ${textOf(sheet())}`);
if (!/beneath Main Panel/.test(textOf(sheet()))) fail('the breaker does not say where it sits on the flow');
shut();

// What the mapping contradicts is reported on the page, each finding leading to the breaker it names (#457).
const checks = () => query(sec, '.ps-check', true);
if (!checks().length) fail('the checks on the mapping are not shown');
const shared = checks().find(c => /two breakers/.test(textOf(c)));
if (!shared) fail(`the channel mapped to two breakers is not reported: ${checks().map(textOf).join(' | ')}`);
if (!shared.classList.contains('is-bad')) fail('a contradiction is not marked as one');
query(shared, 'button', true)[0].onclick();
await wait(60);
if (!/B06|B09/.test(textOf(sheet()))) fail('a finding does not lead to the breaker it names');
shut();

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
const filledSlot = empty().dataset.slot;
query(empty(), '.ps-open').onclick();
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

// What a circuit is drawing is also the way into what it has been drawing: the reading is its own target.
const drawingNow = readings(6)[0];
if (!drawingNow || drawingNow.tag !== 'button') fail('the reading is not something you can tap');
drawingNow.onclick();
await wait(120);
if (!sheet()) fail('tapping the reading opened nothing');
if (!/B06/.test(sheet().textContent || '')) fail('the chart does not say which breaker it is for');
const charted = query(sheet(), 'svg', true);
if (!charted.length) fail(`no chart was drawn: "${(sheet().textContent || '').slice(0, 120)}"`);
if (!/from n30_1_5/.test(sheet().textContent || '')) fail('the chart does not say which channel it came from');
if (!/peak 180 W/.test(sheet().textContent || '')) fail('the chart does not summarise what it drew');
// A moment the backend has no reading for is a gap in the chart, not a zero in it: the fixture holds 6
// samples, one of them missing.
if (!/20 of 21 readings/.test(sheet().textContent || ''))
  fail(`a missing reading was counted rather than left as a gap: "${(sheet().textContent || '').slice(0, 140)}"`);

// A light grid behind the line: the scale down the side, the time along the bottom.
const plotted = query(sheet(), 'svg', true)[0];
const gridLines = query(plotted, 'line', true).filter(l => l.attrs.class === 'spark-grid');
const axis = query(plotted, 'text', true).filter(t => t.attrs.class === 'spark-axis').map(t => t.textContent);
if (gridLines.length < 4) fail(`the chart has no grid behind it: ${gridLines.length} lines`);
if (!axis.some(t => /W$/.test(t || ''))) fail(`the grid does not say what the scale is in: ${axis.join(' | ')}`);
if (!axis.some(t => /:/.test(t || ''))) fail(`the grid has no times along the bottom: ${axis.join(' | ')}`);
// Stretching a strip is fine for a bare line, but it would stretch the labels with it.
if (plotted.attrs.preserveAspectRatio === 'none') fail('the gridded chart is stretched, so its labels are too');

// The line is named rather than left to be guessed.
const key = query(sheet(), '.ps-legend');
if (!key) fail('the chart has no legend');
if (!query(key, '.trend-swatch')) fail('the legend has no colour to tie to the line');
if (!/B06/.test(key.textContent || '') || !/n30_1_5/.test(key.textContent || ''))
  fail(`the legend does not name the breaker and the channel: "${key.textContent}"`);

// Hovering the chart says what it was reading at that moment — and the card has to sit above the sheet it is
// drawn in, which is what a z-index of 45 under an overlay of 50 did not do.
const hit = query(sheet(), 'rect', true).find(r => r.attrs.class === 'spark-hit');
if (!hit) fail('the chart has no hover target');
const plot = query(sheet(), 'svg', true)[0];
// Drawn at its own size, so a client x is a chart x.
plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: CHART_W, height: 160 });
hit._on.mousemove[0]({ clientX: atX(SAMPLES - 1), clientY: 80 });
const hover = query(sandbox.document.body, '.node-card', true)[0];
if (!hover) fail('hovering the chart showed no card');
if (!hover.classList.contains('show')) fail('the hover card was built but never shown');
if (!/180 W/.test(hover.textContent || '')) fail(`the hover card does not say the reading: "${hover.textContent}"`);
// …and the chart says where that reading is: a line down through the pointer, and a dot on the point.
const svgPart = (cls) => query(plot, '*', true).find(e => e.attrs && e.attrs.class === cls)
  || query(plot, 'line', true).concat(query(plot, 'circle', true)).find(e => e.attrs.class === cls);
const cross = () => svgPart('spark-cross'), cursor = () => svgPart('spark-cursor');
if (!cross() || cross().attrs.visibility !== 'visible') fail('nothing marks where the pointer is on the chart');
if (!cursor() || cursor().attrs.visibility !== 'visible') fail('no dot sits on the reading being named');
// The line lands under the pointer, wherever it is. The plot starts past the scale down the side, and
// measuring across the whole box instead slid every reading right — by that gutter at the left, by nothing
// at the right, which is a gap that grows the further left you go.
for (const i of [0, 1, 5, 10, 15, SAMPLES - 1]) {
  const pointer = atX(i);
  hit._on.mousemove[0]({ clientX: pointer, clientY: 80 });
  const drawn = Number(cross().attrs.x1);
  if (Math.abs(drawn - pointer) > stepX / 2 + 1)
    fail(`at sample ${i} the pointer is at ${pointer.toFixed(1)} but the line is at ${drawn.toFixed(1)}`);
  const want = i === GAP_AT ? 'no reading' : `${100 + i * 4} W`;
  if (!hover.textContent.includes(want)) fail(`hovering sample ${i} reads "${hover.textContent}", not ${want}`);
}
const cardRule = /\.node-card\s*\{([^}]*)\}/.exec(css), overlayRule = /\.overlay\s*\{([^}]*)\}/.exec(css);
const zOf = (r) => Number((/z-index:\s*(\d+)/.exec(r ? r[1] : '') || [])[1]);
if (!(zOf(cardRule) > zOf(overlayRule)))
  fail(`the hover card (z-index ${zOf(cardRule)}) sits under the sheet it is drawn in (${zOf(overlayRule)})`);
// …and it still lands under the pointer when the chart is stretched to fill the sheet, which is how it is
// actually drawn: a client x is then twice a chart x.
plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: CHART_W * 2, height: 320 });
for (const i of [0, 4, 12, SAMPLES - 1]) {
  hit._on.mousemove[0]({ clientX: atX(i) * 2, clientY: 80 });
  const drawn = Number(cross().attrs.x1);
  if (Math.abs(drawn - atX(i)) > stepX / 2 + 1)
    fail(`stretched, sample ${i} should draw at ${atX(i).toFixed(1)} but drew at ${drawn.toFixed(1)}`);
}
plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: CHART_W, height: 160 });

// A reading the backend does not have says so rather than showing a number.
hit._on.mousemove[0]({ clientX: atX(GAP_AT), clientY: 80 });
if (!/no reading/.test(hover.textContent || '')) fail(`a gap in the chart hovers as a value: "${hover.textContent}"`);
// Over a gap the line still says where you are, but there is no reading to put a dot on.
if (cross().attrs.visibility !== 'visible') fail('the crosshair vanished over a gap');
if (cursor().attrs.visibility !== 'hidden') fail('a dot was drawn on a reading that does not exist');
// Leaving the chart takes all of it away.
hit._on.mouseleave[0]({});
if (cross().attrs.visibility !== 'hidden' || cursor().attrs.visibility !== 'hidden')
  fail('the crosshair stayed behind after the pointer left');
if (hover.classList.contains('show')) fail('the hover card stayed up after the pointer left');

// The node measuring it is one tap away, beside the breaker's own editor.
const toNode = query(sheet(), 'button', true).find(b => b.textContent === 'Edit node');
if (!toNode || toNode.hidden) fail('the chart offers no way to open the node measuring the breaker');
toNode.onclick();
await wait(80);
if (!query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Nodes').classList.contains('active'))
  fail('Edit node did not open the Nodes page');
link.click();
await wait(120);
drawingNow.onclick();
await wait(120);
// The window is picked here, and asked for at the step that window deserves.
const asks = () => series.slice();
if (!asks().some(u => /minutes=1440&step=900/.test(u))) fail(`the day window was not asked for: ${asks().join(' | ')}`);
query(sheet(), 'button', true).find(b => b.textContent === 'Last 7 days').onclick();
await wait(120);
if (!asks().some(u => /days=7&step=3600/.test(u))) fail(`picking a longer window asked for nothing: ${asks().join(' | ')}`);
// A breaker nothing measures says what is missing instead of drawing an empty chart. The tandem half had its
// node cleared earlier, so nothing is on it.
shut();
readings(6)[1].onclick();
await wait(120);
if (query(sheet(), 'svg', true).length) fail('a breaker with no channel still drew a chart');
if (!/measuring this breaker/i.test(sheet().textContent || ''))
  fail(`an unmeasured breaker does not say what is missing: "${(sheet().textContent || '').slice(0, 120)}"`);
shut();

// A phone holds one column, and that has to outrank the placement written on each cell.
const rules = [...css.matchAll(/@media \(max-width: *560px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map(m => m[1]).join('\n');
// One column of breakers on a phone, with the numbers still stamped beside them.
if (!/\.ps-grid\s*\{[^}]*grid-template-columns:\s*auto\s+1fr\s*[;}]/.test(rules)) fail('the panel keeps two columns of breakers on a phone');
if (!/\.ps-cell\s*\{[^}]*grid-column:\s*2\s*!important/.test(rules))
  fail('the cells keep their two-column placement on a phone — inline placement outranks the media query');
if (!/\.ps-nums\s*\{[^}]*grid-column:\s*1\s*!important/.test(rules))
  fail('the number stamps keep their frame-edge placement on a phone, leaving the breakers nowhere to go');

console.log('panel schedule: a breaker\u2019s reading opens what it has been drawing, over a window picked there; the panel is a node whose reading is drawn as the power coming in, with what feeds it picked and dropped here; a mapped breaker is a tier of the flow in its own right, so nothing is wired from the panel by hand; what the mapping contradicts is reported and leads to the breaker it names; drawn as a panel — enclosure, bus bar and a handle per breaker, odd left and even right, '
  + 'a double-pole across both its slots, a tandem as two halves; the slot count is the panel’s own setting and rounds '
  + 'to whole rows; a second breaker can be added to a slot and each half edited on its own; a breaker is pointed at the '
  + 'node measuring it (upstream nodes not offered, a taken one flagged, clearing it removes the record) and takes its '
  + 'power from it, reading no data rather than zero without one; edits land in the config; and a phone gets one column');
process.exit(0);

// The panel schedule (#453): the panel drawn as it is — odd slots down the left, even down the right, a
// double-pole across the two slots it holds, a tandem as two halves of one — with the power of the channel
// measuring each breaker (#454), never a zero where there is no channel. Editable in place, and one column
// on a phone.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('panel schedule check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// The directory as config holds it, and as the API reports it once the chain to each channel is resolved.
const config = {
  History: { Enabled: false },
  EnergyFlow: {
    Nodes: [], Links: [],
    Panels: [{
      Id: 'main_panel', Name: 'Main Panel', Slots: 12,
      Breakers: [
        { Slot: 1, Number: '1,3', Poles: 2, Amps: 60, Description: 'AC Heat Strips', State: 'identified' },
        { Slot: 6, Number: 'B06', Wire: 'W11', Amps: 20, Description: 'Lights, Garage, Kitchen', State: 'identified' },
        { Slot: 8, Half: 1, Number: '8.1', Wire: 'W21', Amps: 15, Description: 'Servers', State: 'identified' },
        { Slot: 8, Half: 2, Number: '8.2', Wire: 'W22', State: 'unused' },
        { Slot: 9, Number: 'B09', Wire: 'W04', Description: 'Bathroom Lights', State: 'unknown' },
      ],
    }],
    Clamps: [{ Label: 'C1', Panel: 'main_panel', Breaker: 'B06', Channel: 'n30_1_5' }],
  },
};
const panels = {
  ok: true, metric: 'realpower',
  panels: [{
    id: 'main_panel', name: 'Main Panel', slots: 12, rows: 6,
    breakers: [
      { slot: 1, occupies: [1, 3], number: '1,3', poles: 2, half: null, amps: 60, wire: '', description: 'AC Heat Strips', state: 'identified', power: 2250, gap: 'none', legs: [{ leg: 1, wire: 'W01', clamp: 'C2', channel: 'n30_1_1', reversed: false }, { leg: 2, wire: 'W02', clamp: 'C3', channel: 'n30_1_2', reversed: false }] },
      { slot: 6, occupies: [6], number: 'B06', poles: 1, half: null, amps: 20, wire: 'W11', description: 'Lights, Garage, Kitchen', state: 'identified', power: 240, gap: 'none', legs: [{ leg: 1, wire: 'W11', clamp: 'C1', channel: 'n30_1_5', reversed: false }] },
      { slot: 8, occupies: [8], number: '8.1', poles: 1, half: 1, amps: 15, wire: 'W21', description: 'Servers', state: 'identified', power: 100, gap: 'none', legs: [{ leg: 1, wire: 'W21', clamp: 'C4', channel: 'n30_1_8', reversed: false }] },
      { slot: 8, occupies: [8], number: '8.2', poles: 1, half: 2, amps: null, wire: 'W22', description: '', state: 'unused', power: null, gap: 'noclamp', legs: [{ leg: 1, wire: 'W22', clamp: null, channel: null, reversed: false }] },
      { slot: 9, occupies: [9], number: 'B09', poles: 1, half: null, amps: null, wire: 'W04', description: 'Bathroom Lights', state: 'unknown', power: null, gap: 'noclamp', legs: [{ leg: 1, wire: 'W04', clamp: null, channel: null, reversed: false }] },
    ],
  }],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/panels') ? panels
    : url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
        : url.includes('/api/config') ? config
          : url.includes('/api/flow') ? { ok: true, nodes: [], links: [] }
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

// A tandem is two halves of one slot.
const tandem = cellAt(8);
if (query(tandem, '.ps-half', true).length !== 2) fail(`a tandem is not drawn as two halves: ${textOf(tandem)}`);
if (!/8\.1/.test(textOf(tandem)) || !/8\.2/.test(textOf(tandem))) fail(`the tandem halves are not both named: ${textOf(tandem)}`);

// Power comes from the channel measuring the breaker; a breaker nothing measures reads no data, never zero.
if (!/240 W/.test(textOf(cellAt(6)))) fail(`the mapped breaker does not show its power: ${textOf(cellAt(6))}`);
if (!/2,250 W/.test(textOf(cellAt(1)))) fail(`the double-pole does not show both legs summed: ${textOf(cellAt(1))}`);
const unmapped = cellAt(9);
if (!/no data/.test(textOf(unmapped))) fail(`an unmapped breaker does not read "no data": ${textOf(unmapped)}`);
if (/\b0 W/.test(textOf(unmapped))) fail(`an unmapped breaker reads as zero: ${textOf(unmapped)}`);
if (!/clamp/i.test(query(unmapped, '.ps-power').parent.title || query(unmapped, '.ps-half').title || ''))
  fail('nothing says which link of the chain is missing');

// The gaps in the directory are visible at a glance.
if (!unmapped.classList.contains('is-unknown')) fail('a breaker nobody has identified is not marked as such');
// The directory's own mark, so a guessed circuit is not read as a confirmed one.
if (!/\?\?\?\?/.test(textOf(unmapped))) fail(`an unknown breaker is not marked as unidentified: ${textOf(unmapped)}`);
if (!cellAt(8).classList.contains('is-unused') && !/Unused/.test(textOf(cellAt(8))))
  fail(`an unused slot is not marked: ${textOf(cellAt(8))}`);
const empty = cells().find(c => c.classList.contains('is-empty'));
if (!empty || !/empty/.test(textOf(empty))) fail('slots with nothing recorded are not drawn as empty');

// A breaker is edited in place, and the edit lands on the config entry rather than the drawn copy.
cellAt(6).onclick();
await wait(100);
const sheet = query(getEl('overlay'), '.sheet');
if (!sheet) fail('tapping a slot did not open its editor');
const inputs = query(sheet, 'input', true);
const desc = inputs.find(i => i.value === 'Lights, Garage, Kitchen');
if (!desc) fail(`the editor does not carry what the breaker feeds: ${inputs.map(i => i.value).join(' | ')}`);
const wire = inputs.find(i => i.value === 'W11');
if (!wire) fail('the editor does not carry the wire label');
if (!/n30_1_5/.test(sheet.textContent || '')) fail('the editor does not show the chain to the channel measuring it');
desc.value = 'Garage lights only';
query(sheet, 'button', true).find(b => b.textContent === 'Apply').onclick();
await wait(100);
const saved = config.EnergyFlow.Panels[0].Breakers.find(b => b.Number === 'B06');
if (saved.Description !== 'Garage lights only') fail(`the edit did not reach the config: ${saved.Description}`);
if (query(getEl('overlay'), '.sheet')) fail('the editor stayed open after applying');

// A slot nobody has recorded can be filled in, and the new breaker lands in the panel it was drawn in.
empty.onclick();
await wait(100);
const blank = query(getEl('overlay'), '.sheet');
const number = query(blank, 'input', true)[0];
number.value = 'B02';
query(blank, 'input', true).find(i => i.attrs.placeholder === 'what it feeds').value = 'Freezer';
query(blank, 'button', true).find(b => b.textContent === 'Apply').onclick();
await wait(100);
const added = config.EnergyFlow.Panels[0].Breakers.find(b => b.Number === 'B02');
if (!added || added.Description !== 'Freezer') fail('filling in an empty slot did not add a breaker to the panel');

// A phone holds one column, and that has to outrank the placement written on each cell.
const phone = /@media \(max-width: *560px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
const rules = [...css.matchAll(phone)].map(m => m[1]).join('\n');
if (!/\.ps-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(rules)) fail('the panel keeps two columns on a phone');
if (!/\.ps-cell\s*\{[^}]*grid-column:\s*1\s*!important/.test(rules))
  fail('the cells keep their two-column placement on a phone — inline placement outranks the media query');

console.log('panel schedule: the panel is drawn as it is — odd left, even right, a double-pole across both its slots '
  + 'and not redrawn beneath, a tandem as two halves; power comes from the mapped channel and an unmapped breaker '
  + 'reads no data rather than zero, with the missing link named; unknown, unused and empty slots are marked; a slot '
  + 'is edited or filled in place and the edit lands in the config; and a phone gets one column');
process.exit(0);

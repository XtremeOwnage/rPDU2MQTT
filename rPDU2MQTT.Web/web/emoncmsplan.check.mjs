// The EmonCMS feed planner (#441): the Calculations box can be put back to its defaults in one click, and
// "Show feed plan" draws each input's processlist with the calculated steps marked.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('emoncmsplan check FAILED: ' + m); process.exit(1); };

// The section as the schema emits it; spliced in so the check does not wait on a fixture regeneration.
const bool = (key, def) => ({ key, label: key, type: 'bool', required: false, default: def, radio: false });
const calculations = {
  key: 'Calculations', label: 'Calculations', type: 'object', required: false, radio: false, resettable: true,
  properties: [bool('EnergyFromPower', true), bool('PowerFromEnergy', true), bool('PowerFromVoltageAndCurrent', false)],
};
const feeds = schema.find(n => n.key === 'EmonCMS').properties.find(p => p.key === 'Feeds');
feeds.properties = [...feeds.properties.filter(p => p.key !== 'Calculations'), calculations];

const cfg = { EmonCMS: { Feeds: { Calculations: { EnergyFromPower: false, PowerFromEnergy: true, PowerFromVoltageAndCurrent: true } } } };
const plan = {
  ok: true,
  result: {
    ok: true, feeds: 3,
    inputs: [{ input: 'pdu_o0_current', steps: [
      { process: 'Log to feed', target: 'pdu_o0_current', input: false },
      { process: 'x input', target: 'pdu_o0_voltage', input: true },
      { process: 'Log to feed', target: 'pdu_o0_realpower', input: false },
    ] }],
  },
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/integrations/emoncms/plan') ? plan :
    url.includes('/api/integrations') ? { ok: true, integrations: [{ id: 'emoncms' }] } :
    url.includes('/api/config') ? cfg :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'EmonCMS');
if (!link) fail('no EmonCMS tab');
link.click();
await new Promise(r => setTimeout(r, 300));
const sections = getEl('sections');

// The innermost box: the Feeds box around it holds the same legend further down.
const box = query(sections, 'fieldset', true)
  .filter(f => query(f, 'legend', true).some(l => String(l.textContent || '') === 'Calculations')).at(-1);
if (!box) fail('no Calculations box on the EmonCMS page');
const switches = () => query(box, 'input', true).filter(i => i.type === 'checkbox').map(i => i.checked);
if (JSON.stringify(switches()) !== '[false,true,true]') fail(`the box did not show the saved settings: ${switches()}`);

const reset = query(box, 'button', true).find(b => b.textContent === 'Reset to defaults');
if (!reset) fail('the Calculations box has no Reset to defaults');
reset.click();
if (JSON.stringify(switches()) !== '[true,true,false]') fail(`Reset did not restore the defaults: ${switches()}`);

const show = query(sections, 'button', true).find(b => b.textContent === 'Show feed plan');
if (!show) fail('no Show feed plan button');
show.click();
await new Promise(r => setTimeout(r, 50));
const overlay = getEl('overlay');
const rows = query(overlay, 'div', true).filter(d => String(d.className || '') === 'emon-plan-row');
if (rows.length !== 1) fail(`expected one input in the plan, found ${rows.length}`);
const calc = query(rows[0], 'span', true).filter(s => String(s.className || '').includes('calc'));
if (calc.length !== 1 || !String(calc[0].textContent).includes('pdu_o0_voltage'))
  fail('the x input step was not marked as calculated, or did not name the input it reads');

console.log('emoncmsplan: Calculations resets to its defaults, and the feed plan draws each input with its calculated steps marked');

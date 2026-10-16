// Temperatures are stored in °C and shown in Gui.TemperatureUnits.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const fail = (m) => { console.error('temperature units check FAILED: ' + m); process.exit(1); };
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8')).filter(n => n.key !== '_README');
const { sandbox } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: false } }
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));
const run = (js) => vm.runInContext(js, sandbox);

run("state.data = { Gui: { TemperatureUnits: 'fahrenheit' } }");
if (run('fmtTemp(40)') !== '104 °F') fail(`40 °C in fahrenheit is ${run('fmtTemp(40)')}`);
if (run('fmtTemp(-17.8)') !== '0 °F') fail(`-17.8 °C in fahrenheit is ${run('fmtTemp(-17.8)')}, not 0 °F`);
if (Math.abs(run('fromTemp(32)')) > 1e-9) fail('32 °F is not 0 °C');
run("state.data = { Gui: { TemperatureUnits: 'celsius' } }");
if (run('fmtTemp(40)') !== '40 °C') fail(`40 °C in celsius is ${run('fmtTemp(40)')}`);
if (run('tempUnit()') !== '°C') fail('celsius does not show °C');
console.log('temperature units: stored in °C, shown in the chosen unit, no "-0"');

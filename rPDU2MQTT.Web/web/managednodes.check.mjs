// The Nodes page hides integration-managed nodes by default.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8')).filter(n => n.key !== '_README');
const fail = (m) => { console.error('managed nodes check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const config = {
  History: { Enabled: false },
  EnergyFlow: {
    Nodes: [
      { Id: 'inverter', Label: 'Inverter', Kind: 'inverter' },
      { Id: 'b1_1', Label: 'B1-1', Kind: 'solar', Sources: [{ Type: 'tigo', Settings: { Optimizer: '4-ABC' } }] },
      { Id: 'b1', Label: 'B1', Kind: 'solar', Tags: ['pv-string'] },
    ],
    Links: [],
  },
};
const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/integrations') ? { ok: true, integrations: [{ id: 'tigo', managedNodes: [{ sourceType: 'tigo' }, { tag: 'pv-string' }] }] }
        : url.includes('/api/config') ? config
          : url.includes('/api/flow') ? { ok: true, nodes: [], links: [] }
            : { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(60);

const a = query(getEl('nav'), 'a', true).find(x => x.dataset.label === 'Nodes');
if (!a) fail('no Nodes page');
a.click();
await wait(220);
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
const rows = () => query(sec, 'tbody', true).flatMap(b => query(b, 'tr', true)).map(r => (query(r, 'code') || {}).textContent).filter(Boolean);
const box = query(query(sec, '.nd-managed'), 'input');
if (!box) fail('no Hide managed checkbox');
if (!box.checked) fail('Hide managed is not on by default');
if (rows().join() !== 'inverter') fail(`managed nodes are listed: ${rows()}`);
if (!/2 managed hidden/.test(sec.textContent || '')) fail('the page does not say managed nodes are hidden');
box.checked = false;
box.onchange({});
await wait(60);
if (rows().length !== 3) fail(`unticking did not list every node: ${rows()}`);
console.log('managed nodes: ok');
process.exit(0);

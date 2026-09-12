// A fixed list is the set the build ships, not a collection to add to. The EmonCMS measurement types are
// one: power, energy, daily energy, voltage and the rest are what EmonCMS understands, and an entry someone
// typed in is an entry nothing downstream can act on. So the page offers no Add and no Remove, titles each
// entry by the type it configures, and does not offer that type as a field to edit.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('fixedlist check FAILED: ' + m); process.exit(1); };

const cfg = {
  EmonCMS: {
    Feeds: {
      Types: [
        { Type: 'realpower', Enabled: true, Calculation: 'PreferLocal', Suffix: '_realpower', Units: 'W', IntervalSeconds: 10 },
        { Type: 'energy_d', Enabled: true, Calculation: 'ForceEmonCms', Suffix: '_energy_d', Units: 'kWh', IntervalSeconds: 86400 },
      ],
    },
  },
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? cfg :
    { ok: true },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

const navLinks = query(getEl('nav'), 'a', true);
const link = navLinks.find(a => a.dataset.label === 'EmonCMS');
if (!link) fail('no EmonCMS tab; labels: ' + navLinks.map(a => a.dataset.label).join(' | '));
link.click();
await new Promise(r => setTimeout(r, 300));

const sections = getEl('sections');
// Scoped to the Types fieldset: every section is in the DOM at once, so a page-wide scan sees every
// other list's Add button and proves nothing about this one.
const types = query(sections, 'fieldset', true)
  .find(f => query(f, 'div', true).some(d => String(d.className || '') === 'list-entry')
          && query(f, 'legend', true).some(l => String(l.textContent || '').includes('Types')));
if (!types) fail('no Types fieldset with list entries on the EmonCMS page');

const entries = query(types, 'div', true).filter(d => String(d.className || '') === 'list-entry');
if (entries.length !== 2) fail(`expected the two configured types, got ${entries.length} list entries`);

// Neither button: a type cannot be invented, and removing one would leave a reading with nowhere to go.
const labels = query(types, 'button', true).map(b => b.textContent);
if (labels.some(t => t === '+ Add')) fail(`a fixed list offered Add: ${labels.join(' | ')}`);
if (labels.some(t => t === 'Remove')) fail(`a fixed list offered Remove: ${labels.join(' | ')}`);

// Each entry says which type it configures, in the words the rest of the GUI uses.
const heads = entries.map(e => query(e, 'strong', true).map(s => s.textContent).join(''));
if (!heads.includes('Power')) fail(`no entry titled "Power": ${heads.join(' | ')}`);
if (!heads.includes('Energy Daily')) fail(`no entry titled "Energy Daily": ${heads.join(' | ')}`);

// And does not offer the naming field as something to edit.
const fieldLabels = entries.flatMap(e => query(e, 'label', true).map(l => String(l.textContent || '')));
if (fieldLabels.some(t => t.trim() === 'Type')) fail(`the fixed list still offers Type as a field: ${fieldLabels.join(' | ')}`);
// The rest of the entry is still editable.
if (!fieldLabels.some(t => t.includes('Suffix'))) fail(`the entry lost its editable fields: ${fieldLabels.join(' | ')}`);

console.log('fixedlist: the EmonCMS types render as the fixed set they are — titled by type, no Add, no Remove, type not editable, everything else still is');

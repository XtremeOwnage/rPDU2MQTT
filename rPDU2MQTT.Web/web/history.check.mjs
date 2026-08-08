// The "show a past moment" control on the Flow page (#372).
//
// A historical view is the same diagram built from the values of that instant, so the risk is that it
// looks exactly like the live one. The page has to request the moment and then say it is showing one.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('history check FAILED: ' + m); process.exit(1); };

const live = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [{ id: 'grid', label: 'Grid', kind: 'grid', value: 7080, derivation: 'measured' },
          { id: 'panel', label: 'Panel', kind: 'panel', value: 7080, derivation: 'measured' }],
  links: [{ source: 'grid', target: 'panel', value: 7080 }],
};
const past = {
  ok: true, metric: 'realpower', units: 'W', historical: true,
  at: '2026-08-07T12:00:00Z', source: 'prometheus',
  nodes: [{ id: 'grid', label: 'Grid', kind: 'grid', value: 1234, derivation: 'measured' },
          { id: 'panel', label: 'Panel', kind: 'panel', value: 1234, derivation: 'measured' }],
  links: [{ source: 'grid', target: 'panel', value: 1234 }],
};

const asked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/flow?') || url.endsWith('/api/flow')) asked.push(url);
    return url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] } }
      : url.includes('/api/flow/live') ? { ok: true, values: [] }
      : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
      : url.includes('at=') ? past
      : url.includes('/api/flow') ? live
      : { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
await new Promise(r => setTimeout(r, 300));

// Both the Flow and Energy pages carry the control, so scope to the Flow section — its pan/zoom footer
// is the marker.
const flowSection = () => query(getEl('sections'), '.section', true).find(x => x.textContent.includes('Drag to pan'));
if (!flowSection()) fail('could not find the Flow section');

const labels = () => query(flowSection(), 'text', true).map(t => t.textContent).join(' ');
if (!labels().includes('7,080')) fail(`the live view did not render: ${labels().slice(0, 120)}`);

const at = query(flowSection(), 'input', true).find(i => i.attrs?.type === 'datetime-local' || i.type === 'datetime-local');
if (!at) fail('no moment control on the Flow page');

at.value = '2026-08-07T12:00';
at.onchange({});
await new Promise(r => setTimeout(r, 300));

// The request carried the moment, as an absolute instant rather than the browser's wall clock.
const withAt = asked.filter(u => u.includes('at='));
if (!withAt.length) fail(`no request carried the moment: ${asked.join(' | ')}`);
if (!/at=\d{4}-\d{2}-\d{2}T[^&]*Z/.test(decodeURIComponent(withAt.at(-1))))
  fail(`the moment was not sent as a UTC instant: ${withAt.at(-1)}`);

// The diagram is the past one...
if (!labels().includes('1,234')) fail('the diagram did not switch to the historical values');
// ...and the page says so, rather than looking exactly like the live view.
const shown = query(flowSection(), 'span', true).map(s => s.textContent).join(' ');
if (!/showing .* from prometheus/.test(shown)) fail(`the page does not say it is showing a past moment: ${shown.slice(0, 160)}`);

// Live returns to now and drops the note.
const liveBtn = query(flowSection(), 'button', true).find(b => b.textContent === 'Live');
if (!liveBtn) fail('no Live control to return to now');
liveBtn.click();
await new Promise(r => setTimeout(r, 300));
if (!labels().includes('7,080')) fail('Live did not return to the current values');
if (/showing .* from/.test(query(flowSection(), 'span', true).map(s => s.textContent).join(' ')))
  fail('the historical note survived returning to live');

console.log('history: the Flow page requests a moment as a UTC instant, renders it, says which backend it '
  + 'came from, and returns to live');

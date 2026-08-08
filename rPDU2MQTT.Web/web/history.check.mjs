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
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: true } }
      : url.includes('/api/flow/live') ? { ok: true, values: [] }
      : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
      : url.includes('at=') ? past
      : url.includes('/api/flow') ? live
      : { ok: true };
  },
});
// This check is the one place the push channel has to be real: the bug it guards against is a live push
// landing on a page that is showing a past moment. The shared stub leaves EventSource out so every other
// check exercises the polling fallback, so the stream is supplied here and nowhere else.
const streams = [];
sandbox.EventSource = class {
  constructor(url) { this.url = url; this._on = {}; streams.push(this); setTimeout(() => this.onopen?.(), 0); }
  addEventListener(type, fn) { (this._on[type] ||= []).push(fn); }
  close() { this.closed = true; }
};
const pushLive = (data) => {
  const open = streams.filter(s => !s.closed);
  if (!open.length) fail('the page never opened a push stream, so the live-update path is untested');
  let delivered = 0;
  open.forEach(s => Object.values(s._on).forEach(fns => fns.forEach(fn => { delivered++; fn({ data: JSON.stringify(data) }); })));
  if (!delivered) fail('the push stream carried no feed, so the live-update path is untested');
};

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

// A date, not a datetime: a datetime-local reads '' until both halves are filled, so picking a day and
// leaving the time blank sent nothing and the page silently stayed live.
const at = query(flowSection(), 'input', true).find(i => (i.attrs?.type || i.type) === 'date');
if (!at) fail('no day control on the Flow page');

at.value = '2026-08-03';
at.onchange({});
await new Promise(r => setTimeout(r, 300));

// The request carried the moment, as an absolute instant rather than the browser's wall clock.
const withAt = asked.filter(u => u.includes('at='));
if (!withAt.length) fail(`no request carried the day: ${asked.join(' | ')}`);
if (!/at=\d{4}-\d{2}-\d{2}T[^&]*Z/.test(decodeURIComponent(withAt.at(-1))))
  fail(`the day was not sent as a UTC instant: ${withAt.at(-1)}`);
// A past day is an energy question, so the metric moved with it.
if (!withAt.at(-1).includes('metric=energytoday'))
  fail(`choosing a day did not switch the metric to energy: ${withAt.at(-1)}`);

// The arrows step a day without touching the picker.
const stepBack = query(flowSection(), 'button', true).find(b => b.textContent === '◀');
if (!stepBack) fail('no previous-day control');
stepBack.click();
await new Promise(r => setTimeout(r, 300));
if (at.value !== '2026-08-02') fail(`the previous-day arrow did not step the date: ${at.value}`);

// The diagram is the past one...
if (!labels().includes('1,234')) fail('the diagram did not switch to the historical values');
// ...and the page says so, rather than looking exactly like the live view.
const shown = query(flowSection(), 'span', true).map(s => s.textContent).join(' ');
if (!/showing .* from prometheus/.test(shown)) fail(`the page does not say it is showing a past moment: ${shown.slice(0, 160)}`);

// A live push must not overwrite a past view: it carries the current readings, and painting them under a
// chosen date shows live figures labelled as that date.
pushLive(live);
await new Promise(r => setTimeout(r, 100));
if (labels().includes('7,080')) fail('a live update replaced the historical view');
if (!labels().includes('1,234')) fail('the historical view was lost');

// An optional time: blank means the end of the day, so the day's totals are complete.
const instantOf = (u) => Date.parse(decodeURIComponent(u).match(/at=([^&]+)/)[1]);
const endOfDay = instantOf(asked.filter(u => u.includes('at=')).at(-1));

const timeIn = query(flowSection(), 'input', true).find(i => (i.attrs?.type || i.type) === 'time');
if (!timeIn) fail('no optional time control beside the day');
timeIn.value = '06:30:00';
timeIn.onchange({});
await new Promise(r => setTimeout(r, 200));
const withTime = instantOf(asked.filter(u => u.includes('at=')).at(-1));
// 06:30:00 rather than the 23:59:59 a blank time means — the same day, 17h29m59s earlier.
if (endOfDay - withTime !== 62999_000)
  fail(`a chosen time was not the moment asked for: ${new Date(withTime).toISOString()} vs end of day ${new Date(endOfDay).toISOString()}`);

// Live returns to now and drops the note.
const liveBtn = query(flowSection(), 'button', true).find(b => b.textContent === 'Live');
if (!liveBtn) fail('no Live control to return to now');
liveBtn.click();
await new Promise(r => setTimeout(r, 300));
if (!labels().includes('7,080')) fail('Live did not return to the current values');
if (/showing .* from/.test(query(flowSection(), 'span', true).map(s => s.textContent).join(' ')))
  fail('the historical note survived returning to live');

// --- The settings page shows the chosen provider's settings, and only those --------------------------
//
// It carried the Prometheus URL whichever provider was picked, which reads as the URL that will be queried.
const historyLink = query(getEl('nav'), 'a', true).find(a => a.dataset.section === 'History');
if (!historyLink) fail('no History settings page');
historyLink.click();
await new Promise(r => setTimeout(r, 100));
const historySection = query(getEl('sections'), '.section', true).find(s => query(s, 'h2').textContent === 'History');

const hidden = (elm) => elm.classList.contains('is-hidden');
const promField = query(historySection, '.field', true).find(f => f.textContent.includes('PrometheusUrl'));
const emonPointer = query(historySection, '.feature-pointer', true).find(d => d.textContent.includes('EmonCMS history'));
if (!promField) fail('the History page does not render the Prometheus URL at all');
if (!emonPointer) fail('the History page never points at where EmonCMS is configured');

// Unset provider means the default (prometheus), not "no provider" — its URL still has to be reachable.
if (hidden(promField)) fail('the Prometheus URL is hidden while Prometheus is the provider');
if (!hidden(emonPointer)) fail('the EmonCMS pointer shows while Prometheus is the provider');

const provider = query(historySection, 'select', true)[0];
if (!provider) fail('no provider control on the History page');
provider.value = 'emoncms';
provider.onchange({});
await new Promise(r => setTimeout(r, 100));
if (!hidden(promField)) fail('the Prometheus URL stayed on the page after switching to EmonCMS');
if (hidden(emonPointer)) fail('switching to EmonCMS did not say where EmonCMS is configured');

provider.value = 'prometheus';
provider.onchange({});
await new Promise(r => setTimeout(r, 100));
if (hidden(promField)) fail('switching back to Prometheus did not bring its URL back');

console.log('history: the Flow page requests a moment as a UTC instant, renders it, says which backend it '
  + 'came from, and returns to live; the settings page shows only the chosen provider\'s settings');

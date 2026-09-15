// Recent windows on the Trends pages: the last hour, 6 hours or 24 hours up to now are one click beside the calendar
// periods, and the dropdown offers hour windows short of 6 hours.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('trends recent check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const power = {
  ok: true, metric: 'realpower', units: 'W', source: 'prometheus', stepSeconds: 60,
  at: Array.from({ length: 4 }, (_, i) => new Date(Date.UTC(2026, 8, 15, 12, i)).toISOString()),
  series: [{ node: 'n30_1', label: 'n30_1', kind: 'breaker', values: [100, 110, 120, 130] }],
};
const daily = {
  ok: true, metric: 'energy', units: 'kWh', source: 'prometheus',
  days: ['2026-09-13', '2026-09-14', '2026-09-15'],
  at: ['2026-09-14T05:00:00Z', '2026-09-15T05:00:00Z', '2026-09-16T05:00:00Z'],
  series: [{ node: 'n30_1', label: 'n30_1', kind: 'breaker', values: [1, 2, 3] }],
};

const asked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/flow/series')) { asked.push(decodeURIComponent(url)); return structuredClone(url.includes('days=') ? daily : power); }
    return url.includes('/api/flow/metrics') ? { ok: true, metrics: [{ metric: 'realpower', units: 'W', epoch: 'instant' }, { metric: 'energy', units: 'kWh', epoch: 'lifetime' }] }
      : url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: true } }
      : url.includes('/api/flow') ? { ok: true, nodes: [], links: [] }
      : { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(50);

const pages = query(getEl('nav'), 'a', true).filter(a => / ?Trends$/.test(a.dataset.label || ''));
if (pages.length < 2) fail(`expected both Trends pages: ${pages.map(a => a.dataset.label).join(', ')}`);

for (const link of pages) {
  const name = link.dataset.label;
  link.click();
  await wait(300);
  const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
  const button = (text) => query(sec, 'button', true).find(b => b.textContent === text);
  const rangeSel = query(sec, 'select', true).find(x => (x.children || []).some(o => (o.value || '').includes('minutes=')));
  const offered = (rangeSel.children || []).map(o => o.textContent);

  // Hour windows short of six hours are in the dropdown.
  for (const want of ['last hour', 'last 3 hours', 'last 6 hours', 'last 12 hours', 'last 24 hours'])
    if (!offered.includes(want)) fail(`${name}: the Show dropdown has no "${want}": ${offered.join(', ')}`);

  // One click each, beside the calendar periods.
  for (const want of ['Last hour', 'Last 6 hours', 'Last 24 hours'])
    if (!button(want)) fail(`${name}: no "${want}" button`);

  // Last hour asks for the hour up to now, and says so in the dropdown and on the button.
  asked.length = 0;
  button('Last hour').onclick();
  await wait(100);
  if (!asked.length || !/minutes=60(&|$)/.test(asked.at(-1))) fail(`${name}: Last hour did not ask for the last 60 minutes: ${asked.at(-1)}`);
  if (rangeSel.value !== 'minutes=60') fail(`${name}: the dropdown does not read "last hour" after the button: ${rangeSel.value}`);
  if (!button('Last hour').classList.contains('primary')) fail(`${name}: the Last hour button is not marked as the one shown`);
  if (button('Last 6 hours').classList.contains('primary')) fail(`${name}: Last 6 hours is marked while the last hour is shown`);

  // Picking the same window from the dropdown marks its button too.
  rangeSel.value = 'minutes=360';
  rangeSel.onchange({});
  await wait(100);
  if (!button('Last 6 hours').classList.contains('primary') || button('Last hour').classList.contains('primary'))
    fail(`${name}: picking last 6 hours in the dropdown did not move the mark to its button`);

  // A calendar period takes the mark away.
  button('This week').onclick();
  await wait(100);
  if (button('Last 6 hours').classList.contains('primary')) fail(`${name}: This week left Last 6 hours marked`);

  // Zooming out past the whole timeline loads the next longer range, and the dropdown reads it back. Node Trends has the timeline.
  if (name !== 'Node Trends') continue;
  button('Last hour').onclick();
  await wait(100);
  const minus = () => query(sec, 'button', true).find(b => b.textContent === '−');
  if (!minus() || minus().disabled) fail(`${name}: − is disabled at the whole range, so the timeframe cannot zoom out`);
  asked.length = 0;
  minus().onclick();
  await wait(100);
  if (rangeSel.value !== 'minutes=180' || !/minutes=180(&|$)/.test(asked.at(-1) || ''))
    fail(`${name}: − at the whole last hour did not load the last 3 hours: ${rangeSel.value}, ${asked.at(-1)}`);
  // The wheel does the same.
  const strip = query(sec, 'svg', true).find(s => s.attrs?.class === 'trend-timeline-svg');
  strip._on.wheel[0]({ deltaY: 120, clientX: 50, preventDefault() { } });
  await wait(400);
  if (rangeSel.value !== 'minutes=360') fail(`${name}: wheeling out at the whole range did not load the next longer range: ${rangeSel.value}`);
  // Past the longest range there is nothing to load.
  rangeSel.value = 'days=90';
  rangeSel.onchange({});
  await wait(100);
  if (!minus().disabled) fail(`${name}: − is offered at the longest range, where there is nothing longer to load`);
}

console.log('trends recent: both Trends pages offer hour windows from the last hour up in the dropdown, and Last hour, 6 hours and 24 hours '
  + 'as one click that asks for that window, reads back in the dropdown and marks the button; a calendar period clears the mark; on Node Trends, zooming out past the whole timeline by − or the wheel loads the next longer range');
process.exit(0);

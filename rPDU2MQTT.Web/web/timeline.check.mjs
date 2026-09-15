// The Node Trends timeline: the whole loaded range drawn above the dashboard, and a window on it — drawn,
// moved, resized, zoomed and cleared — that sets the stretch of time the dashboard shows.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('timeline check FAILED: ' + m); process.exit(1); };
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

// Day-end readings of the energy counter, one before the window then seven days, each ending at 05:00 UTC.
const dayEnd = (i) => new Date(Date.UTC(2026, 6, 31, 5) + i * 86_400_000).toISOString();
const nodes = [
  { node: 'solar', label: 'Solar', kind: 'solar' },
  { node: 'grid', label: 'Grid', kind: 'grid' },
  { node: 'battery', label: 'Battery', kind: 'battery' },
];
const whole = {
  ok: true, metric: 'energy', units: 'kWh', source: 'prometheus',
  days: Array.from({ length: 8 }, (_, i) => dayEnd(i).slice(0, 10)),
  at: Array.from({ length: 8 }, (_, i) => dayEnd(i)),
  series: nodes.map((n, k) => ({ ...n, values: Array.from({ length: 8 }, (_, i) => 100 * (k + 1) + i * 10 * (k + 1)) })),
};
// A picked stretch comes back sampled, not as daily totals.
const detail = {
  ok: true, metric: 'energy', units: 'kWh', source: 'prometheus', stepSeconds: 3600,
  at: ['2026-08-02T00:00:00Z', '2026-08-02T01:00:00Z', '2026-08-02T02:00:00Z', '2026-08-02T03:00:00Z'],
  series: nodes.map((n, k) => ({ ...n, values: [10 * (k + 1), 11 * (k + 1), 13 * (k + 1), 16 * (k + 1)] })),
};

const asked = [];
const { sandbox, getEl } = makeDom({
  bodies: (url) => {
    if (url.includes('/api/flow/series')) {
      asked.push(url);
      return structuredClone(url.includes('from=') ? detail : whole);
    }
    if (url.includes('/api/flow/metrics'))
      return { ok: true, metrics: [
        { metric: 'realpower', units: 'W', epoch: 'instant' },
        { metric: 'energy', units: 'kWh', epoch: 'lifetime' }] };
    return url.includes('/api/schema') ? schema
      : url.includes('/api/instances') ? { ok: true, instances: [] }
      : url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] }, History: { Enabled: true } }
      : { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await tick(50);

const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Node Trends');
if (!link) fail('no Node Trends page');
link.click();
await tick(300);
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));

const strip = () => query(sec, '.trend-timeline');
const svg = () => query(strip(), 'svg');
const frame = () => query(svg(), 'rect', true).find(r => r.attrs.class === 'trend-timeline-window');
const headings = () => query(sec, 'h3', true).map(h => h.textContent);
const wholeButton = () => query(strip(), 'button', true).find(b => b.textContent === 'Show the whole range');
const picks = () => asked.filter(u => u.includes('from='));
const spanOf = (url) => {
  const q = new URL('http://x' + url).searchParams;
  return { from: Date.parse(q.get('from')), to: Date.parse(q.get('to')) };
};

// The whole loaded range, drawn above the dashboard as the selected nodes' lines.
if (!strip() || strip().hidden) fail('Node Trends has no timeline');
if (query(svg(), 'polyline', true).filter(p => p.attrs.class === 'trend-timeline-line').length !== 3)
  fail('the timeline does not draw a line per selected node');
if (frame().attrs.visibility !== 'hidden') fail('a window is shown before anything was picked');
if (!headings().includes('Daily energy by node')) fail(`the dashboard does not open on the whole range: ${headings().join(', ')}`);

// The range is seven days ending 05:00 on Aug 7; the strip is 1,200 px across.
const t0 = Date.UTC(2026, 6, 31, 5), range = 7 * 86_400_000;
const at = (px) => t0 + (px / 1200) * range;
const near = (a, b, what) => { if (Math.abs(a - b) > 60_000) fail(`${what}: ${new Date(a).toISOString()} is not ${new Date(b).toISOString()}`); };
// The strip measures a pointer against its on-screen box; here that box is the 1,200 px the strip is drawn at.
const boxed = () => { const s = svg(); s.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 72 }); return s; };
const drag = async (fromPx, toPx) => {
  const down = boxed()._on.pointerdown[0];
  down({ clientX: fromPx, pointerId: 1, preventDefault() { } });
  sandbox.window.dispatch('pointermove', { clientX: toPx, pointerId: 1 });
  sandbox.window.dispatch('pointerup', { clientX: toPx, pointerId: 1 });
  await tick();
};

// A press that does not move is a click, and picks nothing.
await drag(300, 301);
if (picks().length) fail('a click on the timeline picked a window');

// Drag across it: that stretch is fetched on its own, and the dashboard shows it.
await drag(100, 600);
if (picks().length !== 1) fail(`drawing a window fetched ${picks().length} stretches`);
let s = spanOf(picks()[0]);
near(s.from, at(100), 'the window starts where the drag began');
near(s.to, at(600), 'the window ends where the drag ended');
if (!/step=\d+/.test(picks()[0])) fail('the picked stretch was not given a step to fit it');
if (!headings().includes('Energy by node') || headings().includes('Daily energy by node'))
  fail(`the dashboard did not follow the window: ${headings().join(', ')}`);
if (frame().attrs.visibility !== 'visible') fail('the picked window is not drawn on the timeline');
if (wholeButton()?.hidden !== false) fail('there is no way back to the whole range');

// Each edge carries a grip, drawn where the window ends.
const grips = () => query(svg(), 'rect', true).filter(r => r.attrs.class === 'trend-timeline-grip');
if (grips().length !== 2 || grips().some(g => g.attrs.visibility !== 'visible')) fail('the window has no visible grips on its edges');
const middleOf = (g) => Number(g.attrs.x) + Number(g.attrs.width) / 2;
if (Math.abs(middleOf(grips()[0]) - 100) > 1 || Math.abs(middleOf(grips()[1]) - 600) > 1)
  fail(`the grips are not on the window's edges: ${grips().map(middleOf).join(', ')}`);

// The cursor says what a press would do before it is made: resize near an edge, grab inside, draw outside.
const hoverAt = (px) => { const s = boxed(); s._on.pointermove[0]({ clientX: px, clientY: 30 }); return s.style.cursor; };
if (hoverAt(610) !== 'ew-resize') fail(`10 px off the right edge does not offer to resize: ${hoverAt(610)}`);
if (hoverAt(92) !== 'ew-resize') fail(`8 px off the left edge does not offer to resize: ${hoverAt(92)}`);
if (hoverAt(350) !== 'grab') fail(`inside the window does not offer to move it: ${hoverAt(350)}`);
if (hoverAt(1000) !== 'crosshair') fail(`outside the window does not offer to draw one: ${hoverAt(1000)}`);

// A click inside the window that jitters a pixel is still a click: the window stays put and nothing is fetched again.
const beforeClick = picks().length;
await drag(350, 351);
if (picks().length !== beforeClick) fail('a click inside the window nudged it and fetched the stretch again');

// Drag the window: it moves, and keeps its length.
await drag(350, 450);
const moved = spanOf(picks().at(-1));
near(moved.from, s.from + (100 / 1200) * range, 'moving the window moves its start');
near(moved.to - moved.from, s.to - s.from, 'moving the window keeps its length');
s = moved;

// Drag its right edge, from 10 px off it: only that end moves.
await drag(710, 900);
const resized = spanOf(picks().at(-1));
near(resized.from, s.from, 'resizing the right edge left the start alone');
near(resized.to, at(900) + (at(700) - at(710)), 'resizing the right edge moves the end by the drag');
s = resized;

// Scroll over it to zoom: the window narrows about the pointer.
const before = picks().length;
boxed()._on.wheel[0]({ deltaY: -120, clientX: 550, preventDefault() { } });
await tick();
if (picks().length === before) fail('zooming the window fetched nothing');
const zoomed = spanOf(picks().at(-1));
if (!(zoomed.to - zoomed.from < s.to - s.from)) fail('scrolling to zoom did not narrow the window');
if (!(zoomed.from > s.from && zoomed.to < s.to)) fail('the zoomed window did not stay about the pointer');

// Shift-scroll pans it: same length, later.
boxed()._on.wheel[0]({ deltaY: 120, shiftKey: true, clientX: 550, preventDefault() { } });
await tick();
const panned = spanOf(picks().at(-1));
near(panned.to - panned.from, zoomed.to - zoomed.from, 'panning keeps the length');
if (!(panned.from > zoomed.from)) fail('shift-scrolling did not pan the window');

// Double-click zooms in about the pointer, as a map does: to a third of the length, around where it landed.
const pxAt = (t) => ((t - t0) / range) * 1200;
const inside = (panned.from + panned.to) / 2;
boxed()._on.dblclick[0]({ clientX: pxAt(inside) });
await tick();
const dz = spanOf(picks().at(-1));
near(dz.to - dz.from, (panned.to - panned.from) / 3, 'double-clicking the window zooms in to a third');
if (!(dz.from <= inside && inside <= dz.to)) fail('double-clicking zoomed away from where it was clicked');

// A stretch short of a third of the range zooms the timeline itself: to three times the stretch about it, fetched at
// its own step, with the window drawn across the middle third so its edges can still be dragged.
const viewOf = (w) => {
  const len = 3 * (w.to - w.from);
  const from = Math.min(Math.max(t0, 2 * w.from - w.to), t0 + range - len);
  return { from, to: from + len };
};
const view = viewOf(dz);
const around = asked.filter(u => u.includes('from=')).at(-2);
const aroundSpan = spanOf(around);
near(aroundSpan.from, view.from, 'the zoomed timeline starts a stretch before the window');
near(aroundSpan.to, view.to, 'the zoomed timeline ends a stretch after the window');
const inView = (t) => ((t - view.from) / (view.to - view.from)) * 1200;
if (Math.abs(Number(frame().attrs.x) - inView(dz.from)) > 1 || Math.abs(Number(frame().attrs.width) - (inView(dz.to) - inView(dz.from))) > 1)
  fail(`the window is not drawn on the zoomed timeline: x ${frame().attrs.x}, width ${frame().attrs.width}`);

// Double-clicking outside the window zooms into that part of the timeline instead: any section is two clicks away.
const far = inView(inside) < 600 ? 1100 : 100;
const farAt = view.from + (far / 1200) * (view.to - view.from);
boxed()._on.dblclick[0]({ clientX: far });
await tick();
const jumped = spanOf(picks().at(-1));
near(jumped.to - jumped.from, (view.to - view.from) / 3, 'double-clicking outside the window zooms into the timeline shown');
if (!(jumped.from <= farAt && farAt <= jumped.to)) fail('double-clicking outside the window did not go to where it was clicked');

// Show the whole range clears it, without fetching a stretch.
const count = picks().length;
wholeButton().onclick();
await tick();
if (picks().length !== count) fail('clearing the window fetched a stretch');
if (!headings().includes('Daily energy by node')) fail(`clearing the window did not bring the whole range back: ${headings().join(', ')}`);
if (frame().attrs.visibility !== 'hidden') fail('the cleared window is still drawn');

// A window from one range means nothing in another: changing the range clears it.
await drag(100, 400);
const rangeSel = query(sec, 'select', true).find(x => (x.children || []).some(o => o.value === 'days=7'));
const last = asked.length;
rangeSel.value = 'days=7';
rangeSel.onchange({});
await tick(120);
if (asked.slice(last).some(u => u.includes('from='))) fail('changing the range kept fetching the old window');
if (frame().attrs.visibility !== 'hidden') fail('changing the range left the old window drawn');

// Two fingers spreading apart narrow the window about the point between them, as a pinch-zoom does elsewhere.
await drag(200, 800);
const beforePinch = spanOf(picks().at(-1));
const fingers = boxed();
fingers._on.pointerdown[0]({ clientX: 450, pointerId: 11, preventDefault() { } });
fingers._on.pointerdown[0]({ clientX: 550, pointerId: 12, preventDefault() { } });
sandbox.window.dispatch('pointermove', { clientX: 400, pointerId: 11 });
sandbox.window.dispatch('pointermove', { clientX: 600, pointerId: 12 });
sandbox.window.dispatch('pointerup', { pointerId: 11 });
sandbox.window.dispatch('pointerup', { pointerId: 12 });
await tick();
const pinched = spanOf(picks().at(-1));
if (!(pinched.to - pinched.from < beforePinch.to - beforePinch.from)) fail('spreading two fingers did not narrow the window');

// The axis names the time: dates at midnight, and each label is the period it names.
const ticks = () => query(strip(), 'button', true).filter(b => String(b.className || '').includes('trend-timeline-tick'));
if (ticks().length < 5) fail(`the timeline has no time axis worth reading: ${ticks().length} labels`);
const dateTick = ticks().find(b => String(b.className).includes('major'));
if (!dateTick) fail('no label marks a date on the axis');
dateTick.onclick();
await tick();
const day = spanOf(picks().at(-1));
if (day.to - day.from !== 86_400_000) fail(`clicking a date did not show that day: ${(day.to - day.from) / 3_600_000} h`);
if (new Date(day.from).getHours() !== 0 || new Date(day.from).getMinutes() !== 0) fail(`the day shown does not start at midnight: ${new Date(day.from)}`);

// A length, snapped to a clean boundary, about the window's middle.
const toolButton = (text) => query(strip(), 'button', true).find(b => b.textContent === text);
toolButton('6 h').onclick();
await tick();
const six = spanOf(picks().at(-1));
if (six.to - six.from !== 6 * 3_600_000) fail(`6 h picked ${(six.to - six.from) / 3_600_000} h`);
if (new Date(six.from).getMinutes() !== 0) fail('6 h did not start on the hour');
if (!(six.from >= day.from && six.to <= day.to)) fail('6 h was not taken from the middle of the window it narrowed');
// The dashboard redraws the strip after every pick. This strip's box is the stub's 100 px — a phone's worth — where
// 8 px of a week is thirteen hours, far wider than 6 h; the window must survive that redraw all the same.
if (frame().attrs.visibility !== 'visible') fail('a 6 h window vanished when the dashboard redrew the strip');

// + halves the window about its middle, − doubles it, and zooming out past the whole range shows all of it.
toolButton('+').onclick();
await tick();
const halved = spanOf(picks().at(-1));
if (halved.to - halved.from !== 3 * 3_600_000) fail(`+ zoomed to ${(halved.to - halved.from) / 3_600_000} h, not 3 h`);
if ((halved.from + halved.to) / 2 !== (six.from + six.to) / 2) fail('+ did not zoom about the middle');
toolButton('−').onclick();
await tick();
const doubled = spanOf(picks().at(-1));
if (doubled.from !== six.from || doubled.to !== six.to) fail(`− did not undo + : ${new Date(doubled.from)} → ${new Date(doubled.to)}`);

// Stepping moves the window by its own length.
toolButton('◀').onclick();
await tick();
const back = spanOf(picks().at(-1));
if (back.from !== six.from - 6 * 3_600_000 || back.to !== six.from) fail(`◀ did not step back one window: ${new Date(back.from)} → ${new Date(back.to)}`);
toolButton('▶').onclick();
await tick();
if (spanOf(picks().at(-1)).from !== six.from) fail('▶ did not step forward one window');
// A length whose middle is not on an hour is still started on one: 12:00 less half an hour is 11:30, shown from 11:00.
toolButton('1 h').onclick();
await tick();
const hour = spanOf(picks().at(-1));
if (hour.to - hour.from !== 3_600_000) fail(`1 h picked ${(hour.to - hour.from) / 60_000} min`);
if (new Date(hour.from).getMinutes() !== 0) fail(`1 h did not start on the hour: ${new Date(hour.from)}`);
if (!/\(1 h\)/.test(query(strip(), '.desc').textContent)) fail(`the window's length is not shown: ${query(strip(), '.desc').textContent}`);
// − widens the stretch step by step until it covers the loaded range, which is then shown whole — the range itself stays.
const rangeBefore = rangeSel.value;
for (let i = 0; i < 12 && frame().attrs.visibility === 'visible'; i++) { toolButton('−').onclick(); await tick(); }
if (frame().attrs.visibility !== 'hidden' || !headings().includes('Daily energy by node')) fail('zooming out past the whole range did not show all of it');
if (rangeSel.value !== rangeBefore) fail(`zooming a picked stretch out loaded a different range: ${rangeBefore} → ${rangeSel.value}`);

console.log('timeline: Node Trends draws the whole range above the dashboard; dragging across it picks a stretch '
  + 'the dashboard then shows, fetched at its own step; the window moves, resizes by either edge, zooms about the '
  + 'pointer (faster), zooms in on a double-click, pans and pinches; a short stretch zooms the timeline to three times it; + and − halve and double it, zooming out past the range shows all of it; its edges carry grips and a 12 px grab zone the cursor announces; the axis names '
  + 'dates and times, each a period to click; lengths snap to hours and midnights; ◀ ▶ step by the window; a click picks nothing; Show the whole range and a range change return to the whole range');
process.exit(0);

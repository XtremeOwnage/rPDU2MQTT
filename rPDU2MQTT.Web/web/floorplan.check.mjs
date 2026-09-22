// Floor Plans (#470): rooms shaded by what they draw and never zero where nothing is metered (#466); rooms drawn,
// sized in feet and inches, snapped, moved and undone (#463); doors, windows and outdoor zones; items placed,
// moved, left outdoors and wired to one another (#464); the scale set by measuring; tags brought in as rooms
// with a preview (#461); and rooms published to Home Assistant as areas (#467).
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8')).filter(n => n.key !== '_README');
const fail = (m) => { console.error('floor plan check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const rect = (x1, y1, x2, y2) => [{ X: x1, Y: y1 }, { X: x2, Y: y1 }, { X: x2, Y: y2 }, { X: x1, Y: y2 }];
const config = {
  History: { Enabled: false },
  Gui: { DistanceUnits: 'imperial' },
  EnergyFlow: {
    Nodes: [{ Id: 'desk', Label: 'Desk', Tags: ['office'] }],
    Links: [],
    Sites: [{
      Id: 'home', Name: 'Home',
      Floors: [{
        Id: 'ground', Name: 'Ground', Level: 0, Width: 1000, Height: 700, Image: '',
        Rooms: [
          { Id: 'kitchen', Name: 'Kitchen', Shape: rect(0, 0, 400, 300) },
          { Id: 'office', Name: 'Office', Shape: rect(400, 0, 800, 300) },
          { Id: 'garage', Name: 'Garage', Shape: [] },
        ],
        Areas: [{ Id: 'front', Name: 'Front', Rooms: ['kitchen', 'office'], Shape: [] }],
      }],
    }],
    Placements: [{ Id: 'fridge', Kind: 'appliance', Label: 'Fridge', Room: 'kitchen', Floor: 'ground', X: 100, Y: 100, Circuit: 'main/B06', Node: 'plug_fridge' }],
    Panels: [{ Id: 'main', Name: 'Main Panel', Slots: 12, Breakers: [{ Slot: 6, Number: 'B06', Description: 'Kitchen', Rooms: ['kitchen'] }] }],
    Clamps: [{ Panel: 'main', Breaker: 'B06', Channel: 'ch5' }],
  },
};

// The bridge's rollup as /api/locations reports it: the kitchen known, the office waiting on a reading, the garage with nothing metered.
const places = [
  { id: 'home', name: 'Home', kind: 'site', site: 'home', floor: null, value: 500, state: 'known', nodes: [], missing: [], split: [] },
  { id: 'ground', name: 'Ground', kind: 'floor', site: 'home', floor: 'ground', value: 500, state: 'known', nodes: [], missing: [], split: [] },
  { id: 'kitchen', name: 'Kitchen', kind: 'room', site: 'home', floor: 'ground', value: 300, state: 'known', nodes: [{ id: 'ch5', label: 'N30 1-5' }], missing: [], split: [] },
  { id: 'office', name: 'Office', kind: 'room', site: 'home', floor: 'ground', value: null, state: 'unknown', nodes: [{ id: 'printer', label: 'Printer' }], missing: [{ id: 'printer', label: 'Printer' }], split: [] },
  { id: 'garage', name: 'Garage', kind: 'room', site: 'home', floor: 'ground', value: null, state: 'unmetered', nodes: [], missing: [], split: [] },
  { id: 'front', name: 'Front', kind: 'area', site: 'home', floor: 'ground', value: null, state: 'unknown', nodes: [], missing: [{ id: 'printer', label: 'Printer' }], split: [] },
];
const circuits = [{
  ref: 'main/B06', panel: 'main', panelName: 'Main Panel', number: 'B06', description: 'Kitchen', amps: 20, state: 'identified',
  node: 'ch5', channels: ['ch5'], power: 500, gap: 'none', devices: [{ node: 'plug_fridge', label: 'Fridge plug', value: 150 }],
  remainder: 350, remainderState: 'known', exceeded: false, rooms: ['kitchen'], placements: ['fridge'],
}];
const nodes = [
  { id: 'ch5', label: 'N30 1-5', kind: 'breaker', value: 500, location: 'kitchen', placed: 'kitchen', circuit: null },
  { id: 'plug_fridge', label: 'Fridge plug', kind: 'load', value: 150, location: 'kitchen', placed: 'kitchen', circuit: null },
];
const locations = (flow) => ({
  ok: true, metric: 'realpower', units: 'W', problems: [], message: null, places, circuits, nodes,
  placements: (flow.Placements || []).map(p => ({ id: p.Id, value: p.Node === 'plug_fridge' ? 150 : null, circuitKnown: p.Circuit === 'main/B06' })),
});
const migrateTags = [{ tag: 'office', count: 1, suggest: 'room', id: 'office', name: 'Office' }, { tag: 'critical', count: 2, suggest: 'skip', id: 'critical', name: 'Critical' }];
const migratePlan = {
  creates: [{ id: 'laundry', name: 'Laundry', kind: 'room', floor: 'ground', tag: 'laundry' }],
  nodes: [{ node: 'desk', location: 'office', tags: ['office'], note: null }],
  rules: [{ match: 'outlet:rack:*', location: 'office', tag: 'office' }],
  removeTags: ['office'],
  skipped: [{ what: "room 'office'", why: 'Already exists as a room.' }],
};
const posted = {};
const haPlan = {
  rooms: [{ room: 'kitchen', name: 'Kitchen', action: 'create', areaId: null, areaName: null, why: 'No area of this name exists, so one is created.' }],
  devices: [{ deviceId: 'd1', deviceName: 'Fridge plug', roomId: 'kitchen', room: 'Kitchen', action: 'set', currentArea: null, why: "Put in 'Kitchen'." }],
  leftAlone: [{ areaId: 'attic', name: 'Attic' }],
};

const { sandbox, getEl } = makeDom({
  bodies: (url, opts) => {
    if (url.includes('/api/locations/resolve')) return locations(JSON.parse(opts.body).EnergyFlow);
    if (url.includes('/api/locations/migrate')) { const b = JSON.parse(opts.body); posted.migrate = b; return { ok: true, tags: migrateTags, plan: b.mappings ? migratePlan : { creates: [], nodes: [], rules: [], removeTags: [], skipped: [] } }; }
    if (url.includes('/api/ha/areas/preview')) return { ok: true, plan: haPlan };
    if (url.includes('/api/ha/areas/apply')) return { ok: true, plan: haPlan, linked: { kitchen: 'area_kitchen' }, failed: [], message: 'Published 1 room(s) as areas.' };
    if (url.includes('/api/plans/storage')) return { ok: true, where: 'the directory /app/plans', limits: 'PNG, JPEG, WebP or SVG, up to 10 MB.', persistent: false, configWritable: true, why: 'No plan storage is configured, so uploaded plan images are lost when it restarts.' };
    if (url.includes('/api/schema')) return schema;
    if (url.includes('/api/instances')) return { ok: true, instances: [] };
    if (url.includes('/api/config')) return config;
    if (url.includes('/api/flow')) return { ok: true, nodes, links: [] };
    return { ok: true };
  },
});
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await wait(50);

// --- The geometry, the units and the history the editor stands on ---
const { planSnap, planShapeAt, planContains, planRect, planCentroid, planParseLen, planFmtLen, planUnitSystem, planHistory } = sandbox;
if (typeof planSnap !== 'function') fail('the plan geometry is not in the bundle');
const office = rect(400, 0, 800, 300);
const s1 = planSnap({ X: 405, Y: 4 }, [office], 12, 10);
if (s1.to !== 'corner' || s1.pt.X !== 400 || s1.pt.Y !== 0) fail(`a point beside a corner did not snap to it: ${JSON.stringify(s1)}`);
const s2 = planSnap({ X: 395, Y: 150 }, [office], 12, 10);
if (s2.to !== 'edge' || s2.pt.X !== 400 || s2.pt.Y !== 150) fail(`a point beside an edge did not snap onto it: ${JSON.stringify(s2)}`);
if (!planContains(office, { X: 500, Y: 100 }) || planContains(office, { X: 100, Y: 100 })) fail('containment is wrong');
if (planShapeAt([{ Id: 'office', Shape: office }, { Id: 'closet', Shape: rect(420, 20, 480, 80) }], { X: 450, Y: 50 })?.Id !== 'closet') fail('a point in a closet inside a room is not in the closet');
const c = planCentroid(planRect({ X: 0, Y: 0 }, { X: 100, Y: 50 }));
if (c.X !== 50 || c.Y !== 25) fail(`the centre of a rectangle is not its middle: ${JSON.stringify(c)}`);
const near = (a, b) => Math.abs(a - b) < 1e-6;
const ft = 0.3048, inch = 0.0254;
[[`12' 6"`, 12 * ft + 6 * inch], ['12ft 6in', 12 * ft + 6 * inch], ['12 6', 12 * ft + 6 * inch], ['150"', 150 * inch], ['12', 12 * ft], ['12′ 6″', 12 * ft + 6 * inch]]
  .forEach(([t, m]) => { if (!near(planParseLen(t, 'imperial'), m)) fail(`"${t}" did not read as ${m} m: ${planParseLen(t, 'imperial')}`); });
[['3.75 m', 3.75], ['3m 75cm', 3.75], ['375 cm', 3.75], ['3750mm', 3.75], ['3.75', 3.75], ['3,75', 3.75]]
  .forEach(([t, m]) => { if (!near(planParseLen(t, 'metric'), m)) fail(`"${t}" did not read as ${m} m: ${planParseLen(t, 'metric')}`); });
if (planParseLen('twelve', 'imperial') !== null) fail('nonsense read as a length');
if (planFmtLen(12 * ft + 6 * inch, 'imperial') !== '12′ 6″') fail(`12 ft 6 in was written ${planFmtLen(12 * ft + 6 * inch, 'imperial')}`);
if (planFmtLen(0.85, 'metric') !== '85 cm' || planFmtLen(3.75, 'metric') !== '3.75 m') fail('metric lengths are not written as a tape reads them');
if (planUnitSystem('auto', 'en-US') !== 'imperial' || planUnitSystem('auto', 'en-GB') !== 'metric' || planUnitSystem('metric', 'en-US') !== 'metric') fail('the unit setting is not followed');
const box = { v: 1 };
const h = planHistory(() => box, v => { box.v = v.v; });
h.push(); box.v = 2; h.push(); box.v = 3;
h.undo(); if (box.v !== 2) fail('undo did not go back one step');
h.undo(); if (box.v !== 1) fail('undo did not go back two steps');
h.redo(); if (box.v !== 2) fail('redo did not come forward');
h.push(); box.v = 9; if (h.canRedo()) fail('a new change did not clear what could be redone');

// --- The constraint solver ---
const { planSolve } = sandbox;
const sq = () => ({ Id: 'a', Shape: rect(0, 0, 400, 300) });
const near1 = (a, b) => Math.abs(a - b) <= 1;
{
  const a = sq();
  const r = planSolve([a], [{ Id: 'c', Kind: 'length', Refs: [{ Room: 'a', Edge: 0 }], Value: 500 }], new Set(['a#0', 'a#3']));
  if (!near1(Math.hypot(a.Shape[1].X - a.Shape[0].X, a.Shape[1].Y - a.Shape[0].Y), 500) || r.unmet.length) fail(`a fixed length did not hold: ${JSON.stringify(a.Shape)}`);
  if (a.Shape[0].X !== 0 || a.Shape[0].Y !== 0) fail('a held corner moved');
}
{
  const a = { Id: 'a', Shape: [{ X: 0, Y: 0 }, { X: 100, Y: 12 }, { X: 60, Y: 90 }] };
  planSolve([a], [{ Id: 'h', Kind: 'horizontal', Refs: [{ Room: 'a', Edge: 0 }] }]);
  if (!near1(a.Shape[0].Y, a.Shape[1].Y)) fail(`a level wall is not level: ${JSON.stringify(a.Shape)}`);
}
{
  const a = { Id: 'a', Shape: [{ X: 0, Y: 0 }, { X: 100, Y: 0 }, { X: 60, Y: 90 }] };
  planSolve([a], [{ Id: 'g', Kind: 'angle', Refs: [{ Room: 'a', Corner: 1 }], Value: 90 * Math.sign(sandbox.planCornerAngle(a, 1)) }], new Set(['a#0', 'a#1']));
  if (!near1(Math.abs(sandbox.planCornerAngle(a, 1)), 90)) fail(`a square corner is not square: ${sandbox.planCornerAngle(a, 1)}`);
}
{
  const a = { Id: 'a', Shape: rect(0, 0, 100, 100) }, b = { Id: 'b', Shape: [{ X: 200, Y: 0 }, { X: 300, Y: 30 }, { X: 300, Y: 100 }, { X: 200, Y: 100 }] };
  planSolve([a, b], [{ Id: 'p', Kind: 'perpendicular', Refs: [{ Room: 'a', Edge: 0 }, { Room: 'b', Edge: 0 }] }], new Set(['a#0', 'a#1', 'a#2', 'a#3']));
  const d = Math.atan2(b.Shape[1].Y - b.Shape[0].Y, b.Shape[1].X - b.Shape[0].X) * 180 / Math.PI;
  if (!near1(Math.abs(d), 90)) fail(`two walls held square are not: ${d}°`);
}
{
  const a = { Id: 'a', Shape: rect(0, 0, 100, 100) }, b = { Id: 'b', Shape: rect(150, 10, 250, 110) };
  planSolve([a, b], [{ Id: 'l', Kind: 'colinear', Refs: [{ Room: 'a', Edge: 0 }, { Room: 'b', Edge: 0 }] }], new Set(['a#0', 'a#1', 'a#2', 'a#3']));
  if (!near1(b.Shape[0].Y, 0) || !near1(b.Shape[1].Y, 0)) fail(`two walls held in line are not: ${JSON.stringify(b.Shape)}`);
}
{
  // Rooms sharing a wall share its corners: a length held on one room's wall moves the corner in both.
  const a = { Id: 'a', Shape: rect(0, 0, 400, 300) }, b = { Id: 'b', Shape: rect(400, 0, 800, 300) };
  planSolve([a, b], [{ Id: 'k', Kind: 'length', Refs: [{ Room: 'a', Edge: 0 }], Value: 450 }], new Set(['a#0', 'a#3', 'b#1', 'b#2']));
  if (!near1(a.Shape[1].X, 450) || !near1(b.Shape[0].X, 450)) fail(`a shared corner did not move in both rooms: ${a.Shape[1].X}, ${b.Shape[0].X}`);
}
{
  const a = { Id: 'a', Shape: rect(0, 0, 400, 300), Locked: true };
  const r = planSolve([a], [{ Id: 'k', Kind: 'length', Refs: [{ Room: 'a', Edge: 0 }], Value: 500 }]);
  if (a.Shape[1].X !== 400) fail('a locked room was moved by a constraint');
  if (!r.unmet.includes('k')) fail('a constraint a lock prevents is not reported as unmet');
  const b = { Id: 'b', Shape: rect(0, 0, 400, 300) };
  const c = planSolve([b], [{ Id: 'x', Kind: 'length', Refs: [{ Room: 'b', Edge: 0 }], Value: 500 }, { Id: 'y', Kind: 'length', Refs: [{ Room: 'b', Edge: 0 }], Value: 300 }]);
  if (!c.unmet.length) fail('two lengths for one wall are not reported as conflicting');
}

// --- The page ---
const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Floor Plans');
if (!link) fail('no Floor Plans page in the nav');
link.click();
await wait(100);
const sec = query(getEl('sections'), '.section', true).find(s => s.classList.contains('active'));
if (!sec) fail('clicking Floor Plans activated no section');
const svg = query(sec, 'svg.fp-svg');
if (!svg) fail('no plan drawn');
// The plan fits the floor with a 3% margin, so a 1060×760 box is one pixel to one unit, offset by 30.
svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1060, height: 760 });
const at = (x, y) => ({ clientX: x + 30, clientY: y + 30 });
const buttons = (root = sec) => query(root, 'button', true);
const button = (text, root = sec) => buttons(root).find(b => (b.textContent || '').trim() === text);
const toolBtn = (name) => query(sec, '.fp-tool', true).find(b => b.getAttribute('aria-label') === name);
const polygonFor = (room) => query(sec, 'polygon', true).find(p => p.dataset?.room === room);
const itemEl = (id) => query(sec, 'g', true).find(g => g.dataset?.item === id);
const labels = () => query(sec, 'text', true).map(t => t.textContent);
const side = () => query(sec, '.fp-side');
const sheet = () => query(getEl('overlay'), '.sheet');
const shut = () => getEl('overlay').onclick({ target: getEl('overlay') });
const textOf = (n) => (n?.textContent || '').replace(/\s+/g, ' ');
const key = (k, extra = {}) => sandbox.window.dispatch('keydown', { key: k, target: { tagName: 'BODY' }, preventDefault() { }, ...extra });
const floor = () => config.EnergyFlow.Sites[0].Floors[0];
const roomById = (id) => floor().Rooms.find(r => r.Id === id);
const undoButton = () => buttons().find(b => b.getAttribute('aria-label') === 'Undo');
let pid = 1;
const tap = (target, x, y) => {
  const id = pid++;
  svg.dispatch('pointerdown', { ...at(x, y), pointerId: id, button: 0, target });
  svg.dispatch('pointerup', { ...at(x, y), pointerId: id, target });
};
const drag = (target, from, to) => {
  const id = pid++;
  svg.dispatch('pointerdown', { ...at(...from), pointerId: id, button: 0, target });
  svg.dispatch('pointermove', { ...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), pointerId: id, target });
  svg.dispatch('pointermove', { ...at(...to), pointerId: id, target });
  svg.dispatch('pointerup', { ...at(...to), pointerId: id, target });
};

// View: the kitchen shaded by what it draws, the office unknown, the garage unmetered — and no zero anywhere.
const kitchen = polygonFor('kitchen');
if (!kitchen?.classList.contains('is-known')) fail(`the kitchen is not shaded as known: ${kitchen?.className}`);
if (!/color-mix/.test(kitchen.style.fill || '')) fail(`the kitchen is not shaded by its reading: ${kitchen.style.fill}`);
if (!polygonFor('office')?.classList.contains('is-unknown')) fail('the office, waiting on a reading, is not drawn as unknown');
if (!labels().some(t => /Kitchen\s*300 W/.test(t))) fail(`the kitchen's label does not carry its reading: ${JSON.stringify(labels())}`);
if (!labels().some(t => /Office\s*no data/.test(t))) fail(`the office does not read "no data": ${JSON.stringify(labels())}`);
if (labels().some(t => /Office\s*0 W/.test(t))) fail('an unknown room is labelled 0 W');
if (!/Garage\s*unmetered/.test(textOf(side()))) fail(`the garage is not listed as unmetered: ${textOf(side())}`);
const legend = textOf(query(sec, '.fp-legend'));
if (!/unmetered/.test(legend) || !/no data/.test(legend)) fail(`the legend does not say what unshaded rooms mean: ${legend}`);
if (!itemEl('fridge') || itemEl('fridge').classList.contains('is-unknown')) fail('the fridge is not on the plan, or is marked unknown');
if (!query(sec, '.fp-scalebar-text')?.textContent) fail('there is no scale bar');
if (!query(sec, '.fp-palette').hidden) fail('the drawing tools show while only viewing');

// A metered item shows its reading under it while viewing.
if (!labels().some(t => t === '150 W')) fail(`the fridge's reading is not shown on the plan: ${JSON.stringify(labels())}`);

// Tapping an outlet while viewing brings its whole circuit forward: its items, and the rooms it serves.
tap(itemEl('fridge'), 100, 100);
if (!itemEl('fridge').classList.contains('is-focus')) fail('tapping an item did not highlight its circuit');
if (!polygonFor('kitchen').classList.contains('is-circuit')) fail('the room the circuit serves is not highlighted');
key('Escape');

// Tapping a room: its total, the circuits serving it and what is in it.
tap(kitchen, 200, 150);
if (!/Kitchen/.test(textOf(query(side(), 'h3')))) fail(`tapping the kitchen did not select it: ${textOf(side())}`);
if (!/Main Panel · B06/.test(textOf(side()))) fail(`the kitchen does not list the circuit serving it: ${textOf(side())}`);
if (!/Floor area/.test(textOf(side()))) fail('the kitchen does not give its floor area');
query(side(), '.fp-list-row', true).find(b => /B06/.test(textOf(b))).onclick();
if (!/Unmetered remainder\s*350 W/.test(textOf(sheet()))) fail(`the circuit does not report its unmetered remainder: ${textOf(sheet())}`);
if (!/Placed on it.*Fridge/.test(textOf(sheet()))) fail('the circuit does not list what is placed on it');
// Which rooms the circuit serves is set here — and undone with Ctrl+Z, and redone with Ctrl+Y.
const officeBox = query(query(sheet(), 'label', true).find(l => /Office/.test(textOf(l))), 'input', false);
officeBox.checked = true; officeBox.onchange();
const served = () => config.EnergyFlow.Panels[0].Breakers[0].Rooms;
if (!served().includes('office')) fail('ticking a room the circuit serves did not record it on the breaker');
shut();
key('z', { ctrlKey: true });
if (served().includes('office')) fail('Ctrl+Z did not undo ticking a room');
key('y', { ctrlKey: true });
if (!served().includes('office')) fail('Ctrl+Y did not redo it');
key('Escape');

// Edit: the tools appear. Draw the garage, which has no outline, by selecting it and dragging.
button('Edit', sec).onclick();
if (query(sec, '.fp-palette').hidden) fail('the tools do not show in Edit');
button('‹ All rooms', side())?.onclick();
query(side(), '.fp-list-row', true).find(b => /Garage/.test(textOf(b))).onclick();
if (query(side(), '.fp-name')?.value !== 'Garage') fail('the garage could not be selected from the list');
button('Draw outline', side()).onclick();
drag(svg, [850, 50], [950, 250]);
// Corners snap to a 3-inch grid, so the garage lands within a snap of where it was dragged.
const drawn = roomById('garage').Shape, meant = rect(850, 50, 950, 250);
if (drawn.length !== 4 || drawn.some((q, i) => Math.abs(q.X - meant[i].X) > 7.62 || Math.abs(q.Y - meant[i].Y) > 7.62)) fail(`the garage was not given the rectangle drawn: ${JSON.stringify(drawn)}`);

// A room added by its inside measurements, in feet and inches.
toolBtn('Room').onclick();
button('Add a room by size…', sec).onclick();
const [nameIn, wIn, hIn] = query(sheet(), 'input', true);
nameIn.value = 'Den'; wIn.value = `12' 6"`; hIn.value = '10';
button('Add room', sheet()).onclick();
const den = floor().Rooms.find(r => r.Name === 'Den');
if (!den) fail('adding a room by size made no room');
const widthOf = (r) => Math.max(...r.Shape.map(p => p.X)) - Math.min(...r.Shape.map(p => p.X));
const depthOf = (r) => Math.max(...r.Shape.map(p => p.Y)) - Math.min(...r.Shape.map(p => p.Y));
if (Math.abs(widthOf(den) - 381) > 0.2 || Math.abs(depthOf(den) - 304.8) > 0.2) fail(`the den is not 12' 6" by 10': ${widthOf(den)} × ${depthOf(den)} units at 100 units a metre`);
const widthIn = query(side(), 'input', true).find(i => i.classList.contains('fp-len'));
if (widthIn?.value !== '12′ 6″') fail(`the den's width does not read back in feet and inches: ${widthIn?.value}`);
widthIn.value = '14'; widthIn.onchange();
const denNow = () => floor().Rooms.find(r => r.Name === 'Den');
if (Math.abs(widthOf(denNow()) - 14 * ft * 100) > 0.2) fail(`typing a new width did not resize the room: ${widthOf(denNow())}`);
if (!labels().some(t => /′/.test(t))) fail('the selected room shows no wall lengths');
key('z', { ctrlKey: true });
if (Math.abs(widthOf(denNow()) - 381) > 0.2) fail(`undo did not put the width back: ${widthOf(denNow())}`);

// An outline drawn corner by corner: a nearly level wall comes out exactly level.
toolBtn('Outline').onclick();
tap(svg, 820, 330); tap(svg, 960, 336); tap(svg, 960, 420);
button('Finish outline', sec).onclick();
const traced = floor().Rooms[floor().Rooms.length - 1];
if (traced.Shape.length !== 3 || traced.Shape[1].Y !== traced.Shape[0].Y) fail(`a nearly level wall was not made level: ${JSON.stringify(traced.Shape)}`);
if (traced.Shape[2].X !== traced.Shape[1].X) fail(`a nearly plumb wall was not made plumb: ${JSON.stringify(traced.Shape)}`);
key('z', { ctrlKey: true });

// Items: an outlet in the kitchen, a light outdoors that belongs to no room, and a utility pole.
toolBtn('Item').onclick();
query(sec, '.fp-kind', true).find(b => b.getAttribute('aria-label') === 'Outlet').onclick();
tap(svg, 300, 200);
const placement = (kind) => config.EnergyFlow.Placements.find(p => p.Kind === kind);
if (placement('outlet')?.Room !== 'kitchen' || placement('outlet').Floor !== 'ground') fail(`the outlet is not in the room it was placed in: ${JSON.stringify(placement('outlet'))}`);
query(sec, '.fp-kind', true).find(b => b.getAttribute('aria-label') === 'Light').onclick();
tap(svg, 600, 600);
const porch = placement('fixture');
if (!porch || porch.Room !== '' || porch.Floor !== 'ground') fail(`a light placed outdoors is not kept outdoors on the floor: ${JSON.stringify(porch)}`);
if (!itemEl(porch.Id)) fail('the outdoor light is not drawn');
query(sec, '.fp-kind', true).find(b => b.getAttribute('aria-label') === 'Utility pole').onclick();
tap(svg, 950, 650);
if (!placement('pole')) fail('a utility pole could not be placed');

// Select: drag the outlet into the office; it moves there.
toolBtn('Select').onclick();
const outletId = placement('outlet').Id;
drag(itemEl(outletId), [300, 200], [600, 100]);
if (placement('outlet').Room !== 'office' || Math.abs(placement('outlet').X - 600) > 15) fail(`dragging the outlet into the office did not move it there: ${JSON.stringify(placement('outlet'))}`);

// An outlet dropped beside a wall sits on it, and Ctrl+D copies it.
toolBtn('Item').onclick();
query(sec, '.fp-kind', true).find(b => b.getAttribute('aria-label') === 'Outlet').onclick();
tap(svg, 50, 290);
const wallOutlet = config.EnergyFlow.Placements[config.EnergyFlow.Placements.length - 1];
if (wallOutlet.Kind !== 'outlet' || wallOutlet.Y !== 300 || wallOutlet.Room !== 'kitchen') fail(`an outlet dropped by the kitchen's wall did not sit on it: ${JSON.stringify(wallOutlet)}`);
// …on the kitchen's side of it: it faces up into the kitchen, and is drawn beside the wall rather than across it.
if (wallOutlet.Facing !== 270) fail(`the wall outlet does not face into the kitchen: ${wallOutlet.Facing}`);
const drawnAt = (itemEl(wallOutlet.Id).getAttribute('transform') || '').match(/translate\(([-\d.]+),([-\d.]+)\)/);
if (!drawnAt || !(Number(drawnAt[2]) < 300)) fail(`the wall outlet is drawn across its wall rather than beside it: ${itemEl(wallOutlet.Id).getAttribute('transform')}`);
if (!query(sec, 'line', true).some(l => l.classList.contains('fp-item-stub'))) fail('the wall outlet is not joined to its wall');
const before = config.EnergyFlow.Placements.length;
key('d', { ctrlKey: true });
if (config.EnergyFlow.Placements.length !== before + 1) fail('Ctrl+D did not duplicate the selected outlet');
key('z', { ctrlKey: true });
if (config.EnergyFlow.Placements.length !== before) fail('undo did not remove the duplicate');

// A door tapped beside the kitchen's right wall sits in it, lying along it.
toolBtn('Door').onclick();
tap(svg, 396, 150);
const door = floor().Openings?.[0];
if (!door || door.X !== 400 || Math.abs(Math.abs(door.Angle) - 90) > 0.01) fail(`the door did not snap into the wall: ${JSON.stringify(door)}`);
if (Math.abs(door.Width - 91.4) > 0.2) fail(`a door is not 36 inches wide by default: ${door.Width}`);
if (!query(sec, 'g', true).some(g => g.classList.contains('fp-op'))) fail('the door is not drawn');
toolBtn('Window').onclick();
tap(svg, 200, 4);
if (floor().Openings.length !== 2 || floor().Openings[1].Kind !== 'window') fail('a window could not be put in the wall');

// Several at once: a box dragged across empty plot selects everything wholly inside it.
toolBtn('Select').onclick();
key('Escape');
drag(svg, [-20, -20], [405, 305]);
if (!/\d+ selected/.test(textOf(side()))) fail(`a box drag did not select several things: ${textOf(side())}`);
const boxed = Number(textOf(query(side(), 'h3')).match(/(\d+) selected/)[1]);
if (boxed < 4) fail(`the box caught only ${boxed} things`);
// Shift-click adds one more, and dragging any of them moves them all together.
tap(polygonFor('office'), 600, 150);
svg.dispatch('pointerdown', { ...at(600, 150), pointerId: 900, button: 0, target: polygonFor('office'), shiftKey: true });
svg.dispatch('pointerup', { ...at(600, 150), pointerId: 900, target: polygonFor('office'), shiftKey: true });
drag(svg, [-20, -20], [405, 305]);
svg.dispatch('pointerdown', { ...at(600, 150), pointerId: 901, button: 0, target: polygonFor('office'), shiftKey: true });
svg.dispatch('pointerup', { ...at(600, 150), pointerId: 901, target: polygonFor('office'), shiftKey: true });
if (Number(textOf(query(side(), 'h3')).match(/(\d+) selected/)?.[1]) !== boxed + 1) fail(`Shift-click did not add the office to the selection: ${textOf(query(side(), 'h3'))}`);
const fridgeY = config.EnergyFlow.Placements.find(p => p.Id === 'fridge').Y;
drag(polygonFor('kitchen'), [200, 150], [200, 250]);
const fridgeMoved = config.EnergyFlow.Placements.find(p => p.Id === 'fridge').Y - fridgeY;
const officeMoved = roomById('office').Shape[0].Y;
if (fridgeMoved < 90 || officeMoved < 90) fail(`dragging the kitchen did not move the rest of the selection with it: fridge ${fridgeMoved}, office ${officeMoved}`);
key('z', { ctrlKey: true });
if (roomById('office').Shape[0].Y !== 0 || config.EnergyFlow.Placements.find(p => p.Id === 'fridge').Y !== fridgeY) fail('undo did not put the whole group back');
key('a', { ctrlKey: true });
if (!/\d+ selected/.test(textOf(side()))) fail('Ctrl+A did not select everything');
key('Escape');

// The plot's edges drag it bigger; the left edge grows it leftwards and carries the drawing so nothing moves on screen.
const plotHandle = (side) => query(sec, 'rect', true).find(r => r.dataset?.plot === side);
drag(plotHandle('r'), [1000, 350], [1100, 350]);
if (!(floor().Width > 1090 && floor().Width < 1110)) fail(`dragging the right edge did not widen the plot: ${floor().Width}`);
key('z', { ctrlKey: true });
drag(plotHandle('l'), [0, 350], [-100, 350]);
if (!(floor().Width > 1090) || !(roomById('kitchen').Shape[0].X > 90)) fail(`dragging the left edge did not grow the plot leftwards: ${floor().Width}, kitchen at ${roomById('kitchen').Shape[0].X}`);
key('z', { ctrlKey: true });
if (floor().Width !== 1000 || roomById('kitchen').Shape[0].X !== 0) fail('undo did not put the plot back');

// The wheel zooms about the pointer; with Shift it pans.
key('0');
const vbBefore = svg.getAttribute('viewBox');
const vbWidth = () => Number(svg.getAttribute('viewBox').split(' ')[2]);
svg.dispatch('wheel', { deltaX: 0, deltaY: -120, deltaMode: 0, preventDefault() { }, clientX: 300, clientY: 300 });
if (!(vbWidth() < Number(vbBefore.split(' ')[2]))) fail('the wheel did not zoom in');
key('0');
svg.dispatch('wheel', { deltaX: 0, deltaY: 120, deltaMode: 0, shiftKey: true, preventDefault() { }, clientX: 300, clientY: 300 });
if (svg.getAttribute('viewBox') === vbBefore || vbWidth() !== Number(vbBefore.split(' ')[2])) fail('Shift+wheel did not pan without zooming');
key('0');
if (svg.getAttribute('viewBox') !== vbBefore) fail('0 did not fit the floor back into view');

// The circuit and meter pickers open with a search box, and list only what can be one.
tap(itemEl(wallOutlet.Id), 50, 290);
const pickers = query(side(), '.ss', true);
if (pickers.length < 2) fail('the item panel has no searchable pickers');
const [circuitPick, meterPick] = pickers;
query(circuitPick, 'button', false).onclick();
const search = query(circuitPick, 'input', false);
if (!search || !search.classList.contains('ss-search')) fail('opening the circuit picker shows no search box');
search.value = 'kitch'; search.oninput();
const offered = query(circuitPick, '.ss-opt', true);
if (offered.length !== 1 || !/B06/.test(textOf(offered[0]))) fail(`searching the circuits did not narrow them: ${offered.map(textOf).join(' | ')}`);
offered[0].onclick();
if (config.EnergyFlow.Placements.find(p => p.Id === wallOutlet.Id).Circuit !== 'main/B06') fail('picking from the searched list did not set the circuit');
query(query(side(), '.ss', true)[1], 'button', false).onclick();
const meters = query(query(side(), '.ss', true)[1], '.ss-opt', true).map(textOf);
if (meters.some(t => /N30 1-5/.test(t))) fail(`a breaker's channel is offered as the meter for an outlet: ${meters.join(' | ')}`);
if (!meters.some(t => /Fridge plug/.test(t))) fail(`a smart plug is not offered as a meter: ${meters.join(' | ')}`);
key('Escape');

// A wire from the fridge to the outlet: the outlet, on no circuit, takes the fridge's.
toolBtn('Wire').onclick();
tap(itemEl('fridge'), 100, 100);
tap(svg, 300, 100);
tap(itemEl(outletId), 600, 100);
const run = config.EnergyFlow.Runs?.[0];
if (!run || run.From !== 'fridge' || run.To !== outletId || run.Points.length !== 1) fail(`the wire was not drawn between the two: ${JSON.stringify(run)}`);
if (run.Circuit !== 'main/B06' || placement('outlet').Circuit !== 'main/B06') fail(`wiring the outlet to the fridge did not put it on the fridge's circuit: ${placement('outlet').Circuit}`);
if (!query(sec, 'polyline', true).some(p => p.classList.contains('fp-run-line'))) fail('the wire is not drawn');

// The circuit legend brings one circuit forward and fades everything else.
const chip = query(sec, '.fp-chip', true).find(b => /B06/.test(textOf(b)));
if (!chip) fail('the circuits on the floor are not listed');
toolBtn('Select').onclick();
key('Escape');
chip.onclick();
if (!itemEl(porch.Id).classList.contains('is-dim') || itemEl('fridge').classList.contains('is-dim')) fail('picking a circuit did not fade what is not on it');
query(sec, '.fp-chip', true).find(b => /B06/.test(textOf(b))).onclick();
if (itemEl(porch.Id).classList.contains('is-dim')) fail('picking the circuit again did not bring everything back');
if (!button('Print', sec)) fail('there is no way to print the plan');

// The circuit's sheet says how much cable is drawn for it.
tap(itemEl('fridge'), 100, 100);
query(side(), '.fp-list-row', true).find(b => /B06/.test(textOf(b))).onclick();
if (!/Cable drawn\s*\d/.test(textOf(sheet()))) fail(`the circuit does not say how much cable is drawn for it: ${textOf(sheet())}`);
shut();

// A wire's bend lands on a wall corner when one is near, however the straight-line help would have placed it.
toolBtn('Wire').onclick();
tap(svg, 394, 6);
tap(svg, 520, 12);
button('Finish here', sec).onclick();
const cornerRun = config.EnergyFlow.Runs[config.EnergyFlow.Runs.length - 1];
if (cornerRun.Points[0].X !== 400 || cornerRun.Points[0].Y !== 0) fail(`a bend next to a wall corner did not land on it: ${JSON.stringify(cornerRun.Points)}`);
key('z', { ctrlKey: true });

// The middle button pans in Select, even starting over a room, and moves nothing.
key('0');
const vbStill = svg.getAttribute('viewBox');
const kitchenBefore = JSON.stringify(roomById('kitchen').Shape);
svg.dispatch('pointerdown', { ...at(200, 150), pointerId: 950, button: 1, target: polygonFor('kitchen'), preventDefault() { } });
svg.dispatch('pointermove', { ...at(260, 190), pointerId: 950, target: polygonFor('kitchen') });
svg.dispatch('pointerup', { ...at(260, 190), pointerId: 950, target: polygonFor('kitchen') });
if (svg.getAttribute('viewBox') === vbStill) fail('a middle-button drag did not pan the plan');
if (JSON.stringify(roomById('kitchen').Shape) !== kitchenBefore) fail('a middle-button drag moved the room under it');
key('0');

// A corner or a wire bend goes with a double-tap, or with Delete once it is picked.
toolBtn('Select').onclick();
const denId = floor().Rooms.find(r => r.Name === 'Den').Id;
tap(polygonFor(denId), 500, 350);
const cornerHandle = (i) => query(sec, 'circle', true).find(c => c.dataset?.corner === String(i));
tap(cornerHandle(1), 0, 0); tap(cornerHandle(1), 0, 0);
if (roomById(denId).Shape.length !== 3) fail(`double-tapping a corner did not remove it: ${roomById(denId).Shape.length} corners`);
if (!query(side(), '.fp-name')) fail('tapping a corner deselected the room');
key('z', { ctrlKey: true });
tap(cornerHandle(2), 0, 0);
key('Delete');
if (roomById(denId).Shape.length !== 3 || !roomById(denId)) fail('Delete on a picked corner did not remove just that corner');
key('z', { ctrlKey: true });
tap(query(sec, 'polyline', true).find(p => p.dataset?.run === config.EnergyFlow.Runs[0].Id), 300, 100);
const bendHandle = query(sec, 'circle', true).find(c => c.dataset?.runpt === '0');
tap(bendHandle, 0, 0); tap(bendHandle, 0, 0);
if (config.EnergyFlow.Runs[0].Points.length !== 0) fail(`double-tapping a wire bend did not remove it: ${JSON.stringify(config.EnergyFlow.Runs[0].Points)}`);
key('z', { ctrlKey: true });
key('Escape');

// A GFCI: marked from the outlet's panel, wired to the wall outlet, and everything downstream of it lights up.
toolBtn('Select').onclick();
tap(itemEl(outletId), 600, 100);
const gfciBox = query(side(), 'label', true).find(l => /GFCI outlet/.test(textOf(l)));
if (!gfciBox) fail('an outlet cannot be marked as a GFCI');
const gfciInput = query(gfciBox, 'input', false);
gfciInput.checked = true; gfciInput.onchange();
if (!placement('outlet').Gfci) fail('ticking GFCI did not mark the outlet');
if (!query(itemEl(outletId), 'g', true).some(g => g.classList.contains('fp-gfci'))) fail('a GFCI outlet is not marked on the plan');
toolBtn('Wire').onclick();
tap(itemEl(outletId), 600, 100);
tap(itemEl(wallOutlet.Id), 50, 290);
toolBtn('Select').onclick();
tap(itemEl(outletId), 600, 100);
if (!/Protects/.test(textOf(side())) || !/1 downstream/.test(textOf(side()))) fail(`the GFCI does not list what it protects: ${textOf(side())}`);
if (!itemEl(wallOutlet.Id).classList.contains('is-protected')) fail('what the GFCI protects is not shown on the plan');
if (!itemEl(porch.Id).classList.contains('is-dim')) fail('what the GFCI does not protect is not faded');
tap(itemEl(wallOutlet.Id), 50, 290);
if (!/Protected by\s*GFCI/.test(textOf(side()))) fail(`a protected outlet does not say which GFCI protects it: ${textOf(side())}`);
key('Escape');

// Measure a wall and say how long it really is: the scale follows, and the undo button takes it back.
toolBtn('Measure').onclick();
tap(svg, 0, 0); tap(svg, 400, 0);
if (!/13′ 1″/.test(textOf(query(sec, '.fp-opts')))) fail(`the measured line does not read its length: ${textOf(query(sec, '.fp-opts'))}`);
query(query(sec, '.fp-opts'), 'input', false).value = `20'`;
button('Set scale', sec).onclick();
if (Math.abs(floor().Scale - 400 / (20 * ft)) > 0.01) fail(`setting the scale from a 20 ft wall did not: ${floor().Scale}`);
undoButton().onclick();
if (floor().Scale !== undefined && floor().Scale !== 100) fail(`the undo button did not put the scale back: ${floor().Scale}`);

// An outdoor zone is drawn as ground, with a texture.
toolBtn('Outdoor').onclick();
drag(svg, [50, 400], [350, 650]);
const yard = floor().Rooms.find(r => r.Outdoor);
if (!yard || yard.Surface !== 'grass') fail(`an outdoor zone was not made, or not grass: ${JSON.stringify(yard)}`);
if (!query(sec, 'polygon', true).some(p => p.getAttribute('fill') === 'url(#fp-tex-grass)')) fail('the yard is not drawn with a grass texture');
if (!query(sec, 'pattern', true).some(p => p.getAttribute('id') === 'fp-tex-wood')) fail('the textures are not defined');

// Delete removes the selection, and Ctrl+Z brings it back.
toolBtn('Select').onclick();
tap(itemEl(porch.Id), 600, 600);
key('Delete');
if (config.EnergyFlow.Placements.some(p => p.Id === porch.Id)) fail('Delete did not remove the selected item');
key('z', { ctrlKey: true });
if (!config.EnergyFlow.Placements.some(p => p.Id === porch.Id)) fail('Ctrl+Z did not bring the deleted item back');

// The background image is a button of its own, with a place to drop the file.
button('Background', sec).onclick();
if (!query(sheet(), '.fp-drop') || !button('Choose an image…', sheet())) fail('the background sheet offers nowhere to upload an image');
shut();

// Tools › Rooms from tags: suggestions shown, the plan previewed, then applied.
button('Tools…', sec).onclick();
button('Rooms from tags…', sheet()).onclick();
await wait(20);
if (query(sheet(), 'select', true)[0].value !== 'room') fail('a tag that reads like a room is not suggested as one');
button('Preview', sheet()).onclick();
await wait(20);
if (!/Places created.*Laundry/.test(textOf(sheet()))) fail(`the preview does not say what would change: ${textOf(sheet())}`);
if (floor().Rooms.some(r => r.Id === 'laundry')) fail('previewing wrote something');
button('Apply', sheet()).onclick();
if (!floor().Rooms.some(r => r.Id === 'laundry')) fail('applying did not create the room');
if (config.EnergyFlow.Nodes[0].Location !== 'office' || config.EnergyFlow.Nodes[0].Tags.includes('office')) fail('applying did not place the node and drop its tag');

// Tools › Home Assistant: the plan shown, then applied, and each room remembers its area.
button('Tools…', sec).onclick();
button('Publish rooms to Home Assistant…', sheet()).onclick();
await wait(20);
if (!/Kitchen.*create/.test(textOf(sheet())) || !/Attic/.test(textOf(sheet()))) fail('the Home Assistant preview does not say what it would do');
buttons(sheet()).find(b => /^Apply/.test(b.textContent)).onclick();
await wait(20);
if (roomById('kitchen').HaArea !== 'area_kitchen') fail('the kitchen did not remember the area it was published as');

// A door's panel sizes it in feet; dragging it along to the office's far wall turns it to lie along that wall.
toolBtn('Select').onclick();
const doorId = floor().Openings[0].Id;
tap(query(sec, 'rect', true).find(r => r.dataset?.opening === doorId), 400, 150);
const doorWidth = query(side(), 'input', true).find(i => i.classList.contains('fp-len'));
if (doorWidth?.value !== '3′') fail(`the door's width does not read in feet: ${doorWidth?.value}`);
drag(query(sec, 'rect', true).find(r => r.dataset?.opening === doorId), [400, 150], [600, 297]);
const moved = floor().Openings[0];
if (moved.Y !== 300 || Math.abs(moved.Angle) % 180 !== 0) fail(`dragging the door onto the office's bottom wall did not line it up with it: ${JSON.stringify(moved)}`);
button('Rotate 90°', side()).onclick();
if (floor().Openings[0].Angle === moved.Angle && Math.abs(floor().Openings[0].Angle) % 180 === 0) fail('rotating the door did nothing');

// The wire's panel gives its length on the plan and its circuit.
tap(query(sec, 'polyline', true).find(p => p.dataset?.run), 300, 100);
if (!/Length on the plan/.test(textOf(side())) || !/Supply side\s*Fridge/.test(textOf(side()))) fail(`the wire's panel does not describe it: ${textOf(side())}`);

// Rooms sharing a wall share its corners: dragging the kitchen's corner moves the office's with it.
toolBtn('Select').onclick();
key('Escape');
tap(polygonFor('kitchen'), 200, 150);
const kCorner = (i) => query(sec, 'circle', true).find(c => c.dataset?.corner === String(i));
drag(kCorner(1), [400, 0], [420, 0]);
if (!(Math.abs(roomById('office').Shape[0].X - roomById('kitchen').Shape[1].X) < 0.01) || !(roomById('kitchen').Shape[1].X > 410)) fail(`a shared corner did not move in both rooms: kitchen ${JSON.stringify(roomById('kitchen').Shape[1])}, office ${JSON.stringify(roomById('office').Shape[0])}`);
key('z', { ctrlKey: true });
// Dragging a wall's middle slides the wall, and the neighbour sharing it follows.
tap(polygonFor('office'), 600, 150);
const wallMid = (i) => query(sec, 'circle', true).find(c => c.dataset?.mid === String(i));
drag(wallMid(3), [400, 150], [430, 150]);
const oS = roomById('office').Shape, kS = roomById('kitchen').Shape;
if (!(oS[0].X > 420 && oS[3].X > 420 && Math.abs(oS[0].X - oS[3].X) < 0.01)) fail(`sliding the office's wall did not move it square: ${JSON.stringify(oS)}`);
if (!(Math.abs(kS[1].X - oS[0].X) < 0.01 && Math.abs(kS[2].X - oS[3].X) < 0.01)) fail(`the kitchen did not follow the wall it shares: ${JSON.stringify(kS)}`);
key('z', { ctrlKey: true });

// Constraints: the kitchen's top wall fixed at its length holds while its far corner is dragged.
toolBtn('Constrain').onclick();
tap(svg, 200, 2);
if (!/Kitchen wall 1/.test(textOf(query(sec, '.fp-opts')))) fail(`tapping a wall with Constrain did not pick it: ${textOf(query(sec, '.fp-opts'))}`);
button('Fix length', sec).onclick();
const fixedLen = floor().Constraints?.find(c => c.Kind === 'length');
if (!fixedLen || Math.abs(fixedLen.Value - 400) > 0.5) fail(`fixing a wall's length did not record it: ${JSON.stringify(floor().Constraints)}`);
if (!query(sec, 'g', true).some(g => g.classList.contains('fp-cons'))) fail('the constraint is not shown on the plan');
tap(svg, 2, 150);
tap(svg, 200, 298);
button('Parallel', sec).onclick();
if (!floor().Constraints.some(c => c.Kind === 'parallel')) fail('two walls could not be held parallel');
toolBtn('Select').onclick();
tap(polygonFor('kitchen'), 200, 150);
drag(kCorner(0), [0, 0], [-0, 40]);
const k0 = roomById('kitchen').Shape;
if (Math.abs(Math.hypot(k0[1].X - k0[0].X, k0[1].Y - k0[0].Y) - 400) > 1) fail(`the fixed wall did not keep its length: ${JSON.stringify(k0)}`);
if (!/Constraints/.test(textOf(side())) || !/fixed at/.test(textOf(side()))) fail('the room does not list its constraints');
key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); key('z', { ctrlKey: true });
if ((floor().Constraints || []).length) fail(`undo did not take the constraints back: ${JSON.stringify(floor().Constraints)}`);

// A locked room does not move, reshape or delete.
tap(polygonFor('kitchen'), 200, 150);
button(' Lock', side())?.onclick?.() ?? query(side(), 'button', true).find(b => b.classList.contains('fp-lock')).onclick();
if (!roomById('kitchen').Locked) fail('the room could not be locked');
const kBefore = JSON.stringify(roomById('kitchen').Shape);
drag(polygonFor('kitchen'), [200, 150], [260, 200]);
if (JSON.stringify(roomById('kitchen').Shape) !== kBefore) fail('a locked room moved');
key('Delete');
if (!roomById('kitchen')) fail('a locked room was deleted');
query(side(), 'button', true).find(b => b.classList.contains('fp-lock')).onclick();
if (roomById('kitchen').Locked) fail('the room could not be unlocked');
// …and a single wall can be locked.
query(side(), '.fp-wall-row', true)[0].querySelectorAll('button')[1].onclick();
if (!(roomById('kitchen').LockedWalls || []).includes(0)) fail('a wall could not be locked');
drag(kCorner(1), [400, 0], [420, 30]);
if (roomById('kitchen').Shape[1].X !== 400) fail('a corner of a locked wall moved');
key('z', { ctrlKey: true });

// The carpet's colour: a surface recoloured draws in a pattern of its own.
act_surface: {
  const surfaceSel = query(side(), 'select', true).find(x => query(x, 'option', true).some(o => o.value === 'carpet'));
  surfaceSel.value = 'carpet'; surfaceSel.onchange();
  const colour = query(side(), 'input', true).find(i => i.classList.contains('fp-colour'));
  colour.value = '#aa3344'; colour.onchange();
  if (roomById('kitchen').SurfaceColor !== '#aa3344') fail('the carpet colour was not kept');
  if (!query(sec, 'pattern', true).some(p => p.getAttribute('id') === 'fp-tex-carpet-aa3344')) fail('the recoloured carpet has no pattern of its own');
  if (!query(sec, 'polygon', true).some(p => p.getAttribute('fill') === 'url(#fp-tex-carpet-aa3344)')) fail('the kitchen is not drawn in its carpet colour');
}

// Nowhere persistent to keep plan images: said above everything.
if (query(sec, '.fp-banner').hidden || !/will not be kept/.test(textOf(query(sec, '.fp-banner')))) fail(`there is no warning that plan images will be lost: ${textOf(query(sec, '.fp-banner'))}`);
// Export: pictures of the floor, and every plan as a file to import again.
button('Export…', sec).onclick();
['This floor as SVG', 'This floor as PNG', 'All floor plans (JSON)', 'Import floor plans…'].forEach(t => { if (!button(t, sheet())) fail(`the export sheet has no "${t}"`); });
shut();

// Floor settings: the plot is sized in feet, and the ground can be grass.
button('Floor settings', sec).onclick();
const plotW = query(sheet(), 'input', true).find(i => i.classList.contains('fp-len'));
plotW.value = '40'; plotW.onchange();
if (Math.abs(floor().Width - 40 * ft * 100) > 1) fail(`setting the plot width to 40 ft did not: ${floor().Width}`);
const groundSel = query(sheet(), 'select', true).find(x => query(x, 'option', true).some(o => o.value === 'grass'));
groundSel.value = 'grass'; groundSel.onchange();
if (floor().Ground !== 'grass') fail('the ground could not be set to grass');
shut();
if (!query(sec, 'rect', true).some(r => r.getAttribute('fill') === 'url(#fp-tex-grass)' && r.classList.contains('fp-paper'))) fail('the ground is not drawn as grass');

// A second floor, added from its own sheet with a plot in feet.
button('+ Floor', sec).onclick();
query(sheet(), 'input', true).find(i => (i.placeholder || i.getAttribute('placeholder')) === 'Ground floor').value = 'Upstairs';
button('Add floor', sheet()).onclick();
const upstairs = config.EnergyFlow.Sites[0].Floors.find(f => f.Name === 'Upstairs');
if (!upstairs || Math.abs(upstairs.Width - 60 * ft * 100) > 1) fail(`adding a floor did not make a 60 ft plot: ${JSON.stringify(upstairs)}`);
if (!query(sec, '.fp-empty').hidden) fail('the empty-floor card covers the plan while drawing');
button('View', sec).onclick();
if (query(sec, '.fp-empty').hidden) fail('an empty floor does not say how to start');

// Usable on a tablet and a phone: the side panel drops below the plan, the tools run across, pinch is ours.
if (!/\.fp-svg\s*\{[^}]*touch-action:\s*none/.test(css)) fail('the plan does not take over touch, so a pinch would zoom the page');
if (!/@media \(max-width:\s*1100px\)\s*\{\s*\.fp-body,\s*\.fp-body\.is-editing\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css)) fail('the layout does not drop to one column on a narrow screen');

console.log('floor plan check: shading, sizes in feet, undo and redo, drawing, items indoors and out, doors and windows, wires, scale, textures, tags and Home Assistant OK');

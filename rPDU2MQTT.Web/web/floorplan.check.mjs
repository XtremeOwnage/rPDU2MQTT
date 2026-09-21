// Floor Plans (#470): rooms shaded by what they draw and never zero where nothing is metered (#466), rooms
// drawn and snapped (#463), items placed and linked to circuits (#464), tags brought in as rooms with a
// preview (#461), and rooms published to Home Assistant as areas (#467).
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
    Placements: [{ Id: 'fridge', Kind: 'appliance', Label: 'Fridge', Room: 'kitchen', X: 100, Y: 100, Circuit: 'main/B06', Node: 'plug_fridge' }],
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
    if (url.includes('/api/plans/storage')) return { ok: true, where: 'the directory /data/plans', limits: 'PNG, JPEG, WebP or SVG, up to 10 MB.' };
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

// --- The geometry the editor stands on ---
const { planSnap, planShapeAt, planContains, planRect, planCentroid } = sandbox;
if (typeof planSnap !== 'function') fail('the plan geometry is not in the bundle');
const office = rect(400, 0, 800, 300);
const s1 = planSnap({ X: 405, Y: 4 }, [office], 12, 10);
if (s1.to !== 'corner' || s1.pt.X !== 400 || s1.pt.Y !== 0) fail(`a point beside a corner did not snap to it: ${JSON.stringify(s1)}`);
const s2 = planSnap({ X: 395, Y: 150 }, [office], 12, 10);
if (s2.to !== 'edge' || s2.pt.X !== 400 || s2.pt.Y !== 150) fail(`a point beside an edge did not snap onto it: ${JSON.stringify(s2)}`);
const s3 = planSnap({ X: 123, Y: 456 }, [office], 12, 10);
if (s3.to !== 'grid' || s3.pt.X !== 120 || s3.pt.Y !== 460) fail(`a point far from every room did not snap to the grid: ${JSON.stringify(s3)}`);
if (!planContains(office, { X: 500, Y: 100 }) || planContains(office, { X: 100, Y: 100 })) fail('containment is wrong');
const closet = { Id: 'closet', Shape: rect(420, 20, 480, 80) };
if (planShapeAt([{ Id: 'office', Shape: office }, closet], { X: 450, Y: 50 })?.Id !== 'closet') fail('a point in a closet inside a room is not in the closet');
const c = planCentroid(planRect({ X: 0, Y: 0 }, { X: 100, Y: 50 }));
if (c.X !== 50 || c.Y !== 25) fail(`the centre of a rectangle is not its middle: ${JSON.stringify(c)}`);

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
const polygonFor = (room) => query(sec, 'polygon', true).find(p => p.dataset?.room === room);
const labels = () => query(sec, 'text', true).map(t => t.textContent);
const side = () => query(sec, '.fp-side');
const textOf = (n) => (n?.textContent || '').replace(/\s+/g, ' ');
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
if (!kitchen) fail('the kitchen is not drawn');
if (!kitchen.classList.contains('is-known')) fail(`the kitchen is not shaded as known: ${kitchen.className}`);
if (!/color-mix/.test(kitchen.style.fill || '')) fail(`the kitchen is not shaded by its reading: ${kitchen.style.fill}`);
if (!polygonFor('office')?.classList.contains('is-unknown')) fail('the office, waiting on a reading, is not drawn as unknown');
if (!labels().some(t => /Kitchen\s*300 W/.test(t))) fail(`the kitchen's label does not carry its reading: ${JSON.stringify(labels())}`);
if (!labels().some(t => /Office\s*no data/.test(t))) fail(`the office does not read "no data": ${JSON.stringify(labels())}`);
if (labels().some(t => /Office\s*0 W/.test(t))) fail('an unknown room is labelled 0 W');
if (polygonFor('garage')) fail('a room with no outline was drawn');
if (!/Garage\s*unmetered/.test(textOf(side()))) fail(`the garage is not listed as unmetered: ${textOf(side())}`);
const legend = textOf(query(sec, '.fp-legend'));
if (!/unmetered/.test(legend) || !/no data/.test(legend)) fail(`the legend does not say what unshaded rooms mean: ${legend}`);
const fridgeIcon = query(sec, 'g', true).find(g => g.dataset?.item === 'fridge');
if (!fridgeIcon) fail('the fridge is not on the plan');
if (fridgeIcon.classList.contains('is-unknown')) fail('an item on a known circuit is marked unknown');

// Tapping a room: its total, the circuits serving it and what is in it.
tap(kitchen, 200, 150);
if (!/Kitchen/.test(textOf(query(side(), 'h3')))) fail(`tapping the kitchen did not select it: ${textOf(side())}`);
if (!/Main Panel · B06/.test(textOf(side()))) fail(`the kitchen does not list the circuit serving it: ${textOf(side())}`);
if (!/Fridge/.test(textOf(side()))) fail('the kitchen does not list what is in it');
// And tapping that circuit: what is metered on it, the remainder, and what is placed on it.
button('Main Panel · B06 — Kitchen500 W', side())?.onclick?.() ?? query(side(), '.fp-list-row', true).find(b => /B06/.test(textOf(b))).onclick();
const sheet = () => query(getEl('overlay'), '.sheet');
if (!/Unmetered remainder\s*350 W/.test(textOf(sheet()))) fail(`the circuit does not report its unmetered remainder: ${textOf(sheet())}`);
if (!/Placed on it.*Fridge/.test(textOf(sheet()))) fail('the circuit does not list what is placed on it');
// Which rooms the circuit serves is set here, and is written to the breaker.
const serveOffice = query(sheet(), 'label', true).find(l => /Office/.test(textOf(l)));
const officeBox = query(serveOffice, 'input', false);
officeBox.checked = true; officeBox.onchange();
if (!config.EnergyFlow.Panels[0].Breakers[0].Rooms.includes('office')) fail('ticking a room the circuit serves did not record it on the breaker');
getEl('overlay').onclick({ target: getEl('overlay') });

// Rooms: select the garage, which has no outline, and draw it.
button('Rooms', sec).onclick();
button('‹ All rooms', side()).onclick();
query(side(), '.fp-list-row', true).find(b => /Garage/.test(textOf(b)))?.onclick();
if (query(side(), '.fp-name')?.value !== 'Garage') fail('the garage could not be selected from the list');
button('Draw outline', side()).onclick();
drag(svg, [850, 50], [950, 250]);
const garage = config.EnergyFlow.Sites[0].Floors[0].Rooms.find(r => r.Id === 'garage');
if (JSON.stringify(garage.Shape) !== JSON.stringify(rect(850, 50, 950, 250))) fail(`the garage was not given the rectangle drawn: ${JSON.stringify(garage.Shape)}`);
if (config.EnergyFlow.Sites[0].Floors[0].Rooms.length !== 3) fail('drawing an outline for a room made a new room instead');

// A new room drawn as an outline, one corner at a time, snapping onto the office's corner.
button('Outline', sec).onclick();
tap(svg, 805, 4); tap(svg, 900, 0); tap(svg, 900, 60); tap(svg, 805, 5);
const made = config.EnergyFlow.Sites[0].Floors[0].Rooms[3];
if (!made) fail('closing an outline made no room');
if (made.Shape.length !== 3) fail(`the outline does not have the corners tapped: ${JSON.stringify(made.Shape)}`);
if (made.Shape[0].X !== 800 || made.Shape[0].Y !== 0) fail(`the first corner did not snap to the office's corner: ${JSON.stringify(made.Shape[0])}`);
if (!/^Room \d/.test(made.Name)) fail(`a new room is not named for someone to rename: ${made.Name}`);

// Moving a corner, then removing it.
const handles = () => query(sec, 'circle', true).filter(h => h.dataset?.corner != null);
if (handles().length !== 3) fail(`the selected room shows ${handles().length} corner handles`);
drag(handles()[2], [900, 60], [903, 120]);
if (made.Shape[2].Y !== 120) fail(`dragging a corner did not move it: ${JSON.stringify(made.Shape[2])}`);

// Place: arm outlets and tap inside the kitchen.
button('Place', sec).onclick();
const outletBtn = query(sec, '.fp-kind', true).find(b => /Outlet/.test(textOf(b)));
outletBtn.onclick();
tap(svg, 300, 200);
const dropped = config.EnergyFlow.Placements.find(p => p.Id !== 'fridge');
if (!dropped) fail('tapping the plan with outlets armed placed nothing');
if (dropped.Room !== 'kitchen' || dropped.Kind !== 'outlet') fail(`the outlet is not in the room it was dropped in: ${JSON.stringify(dropped)}`);
const newIcon = query(sec, 'g', true).find(g => g.dataset?.item === dropped.Id);
if (!newIcon?.classList.contains('is-unknown')) fail('an outlet on an unknown circuit is not marked as such');
// Its circuit, picked from the breakers.
const circuitSel = query(side(), 'select', true).find(s => query(s, 'option', true).some(o => o.value === 'main/B06'));
if (!circuitSel) fail('the item offers no circuit to pick');
circuitSel.value = 'main/B06'; circuitSel.onchange();
if (dropped.Circuit !== 'main/B06') fail('picking a circuit did not link the outlet to it');
// Dragging it into the office moves it there.
outletBtn.onclick();
drag(query(sec, 'g', true).find(g => g.dataset?.item === dropped.Id), [300, 200], [500, 200]);
if (dropped.Room !== 'office' || dropped.X !== 500) fail(`dragging the outlet into the office did not move it there: ${JSON.stringify(dropped)}`);

// Tools › Rooms from tags: suggestions shown, the plan previewed, then applied.
button('Tools…', sec).onclick();
button('Rooms from tags…', sheet()).onclick();
await wait(20);
if (!/office/.test(textOf(sheet())) || !/critical/.test(textOf(sheet()))) fail('the tags in use are not listed');
const firstAs = query(sheet(), 'select', true)[0];
if (firstAs.value !== 'room') fail(`a tag that reads like a room is not suggested as one: ${firstAs.value}`);
button('Preview', sheet()).onclick();
await wait(20);
if (!Array.isArray(posted.migrate?.mappings)) fail('previewing did not send the mappings');
if (!/Places created.*Laundry/.test(textOf(sheet())) || !/Left alone/.test(textOf(sheet()))) fail(`the preview does not say what would change: ${textOf(sheet())}`);
if (config.EnergyFlow.Sites[0].Floors[0].Rooms.some(r => r.Id === 'laundry')) fail('previewing wrote something');
button('Apply', sheet()).onclick();
if (!config.EnergyFlow.Sites[0].Floors[0].Rooms.some(r => r.Id === 'laundry')) fail('applying did not create the room');
if (config.EnergyFlow.Nodes[0].Location !== 'office') fail('applying did not place the node');
if (config.EnergyFlow.Nodes[0].Tags.includes('office')) fail('the tag asked to be removed is still there');
if (!config.EnergyFlow.AutoLocations?.some(r => r.Match === 'outlet:rack:*')) fail('applying did not add the rule for derived nodes');

// Tools › Home Assistant: the plan shown, then applied, and each room remembers its area.
button('Tools…', sec).onclick();
button('Publish rooms to Home Assistant…', sheet()).onclick();
await wait(20);
if (!/Kitchen.*create/.test(textOf(sheet())) || !/Attic/.test(textOf(sheet()))) fail(`the Home Assistant preview does not say what it would do: ${textOf(sheet())}`);
buttons(sheet()).find(b => /^Apply/.test(b.textContent)).onclick();
await wait(20);
if (config.EnergyFlow.Sites[0].Floors[0].Rooms[0].HaArea !== 'area_kitchen') fail('the kitchen did not remember the area it was published as');

// The page is usable on a tablet and a phone: the side panel drops below the plan, and pinch is ours.
if (!/\.fp-svg\s*\{[^}]*touch-action:\s*none/.test(css)) fail('the plan does not take over touch, so a pinch would zoom the page');
if (!/@media \(max-width:\s*1100px\)\s*\{\s*\.fp-body\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css)) fail('the side panel does not drop below the plan on a narrow screen');

console.log('floor plan check: shading, unknown and unmetered rooms, drawing and snapping, placing and linking, tag migration and Home Assistant areas OK');

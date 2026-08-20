// The trend behind each Energy tile.
//
// A tile showed one instant with no shape to it: 4.6 kW, and no way to tell a clear morning from a cloud
// that just passed. These assert the sparkline is drawn from the readings the backend actually has — and,
// more importantly, what it does when it does NOT have them.
//
// The honesty rules, which are the same ones the rest of the flow follows:
//   · no readings          -> no line at all, never a flat zero
//   · a gap in the middle  -> a gap in the line, never joined through
//   · a partial sum        -> a gap, because three MPPTs with one missing is not the array's output
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');

const cfg = {
  EnergyFlow: {
    Nodes: [{ Id: 'solar_a', Kind: 'solar' }, { Id: 'solar_b', Kind: 'solar' }, { Id: 'grid', Kind: 'grid' }],
    Links: [],
  },
  History: { Enabled: true },
};

const board = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'solar_a', label: 'Array A', kind: 'solar', value: 2300 },
    { id: 'solar_b', label: 'Array B', kind: 'solar', value: 2300 },
    { id: 'grid', label: 'Grid', kind: 'grid', value: 1200 },
  ],
  links: [],
};

const fail = (m) => { console.error('sparkline check FAILED: ' + m); process.exit(1); };

/// Render the Energy page with a given /api/flow/series answer, and hand back its tiles.
async function render(series) {
  const { sandbox, getEl } = makeDom({
    bodies: (url) =>
      url.includes('/api/schema') ? schema :
      url.includes('/api/instances') ? { ok: true, instances: [] } :
      url.includes('/api/config') ? cfg :
      url.includes('/api/flow/series') ? series :
      url.includes('/api/flow/live') ? { ok: true, values: [] } :
      url.includes('/api/flow') ? board :
      { ok: true },
  });
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 60));
  const link = query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Energy');
  if (!link) fail('no Energy tab');
  link.click();
  await new Promise(r => setTimeout(r, 120));
  return getEl('sections');
}

const sparks = (root) => query(root, 'svg', true).filter(s => (s.attrs.class || '').includes('spark'));
// (svg attrs are set with setAttribute, so class lives in attrs there; HTML elements use classList.)
const empties = (root) => query(root, '.spark-empty', true);
// A drawn line is a <path> with a stroke; the area beneath it is the one with a fill-opacity.
const lines = (svg) => query(svg, 'path', true).filter(p => p.attrs.stroke && p.attrs.stroke !== 'none');

// --- With readings: a line per tile whose nodes all reported.
const withData = {
  ok: true, metric: 'realpower', units: 'W',
  series: [
    { node: 'solar_a', label: 'Array A', kind: 'solar', values: [100, 400, 900, 1600, 2300] },
    { node: 'solar_b', label: 'Array B', kind: 'solar', values: [110, 420, 880, 1580, 2300] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [1800, 1600, 1400, 1300, 1200] },
  ],
};
const drawn = await render(withData);
if (sparks(drawn).length < 2)
  fail(`expected a trend on the solar and grid tiles, found ${sparks(drawn).length}`);
for (const s of sparks(drawn)) {
  if (!lines(s).length) fail('a trend was rendered with no line in it');
  for (const p of lines(s))
    if (p.attrs['stroke-width'] !== '2') fail(`a trend line is ${p.attrs['stroke-width']}px — the spec is 2`);
}

// --- No readings at all: no line, and nothing pretending to be one.
const none = await render({ ok: true, metric: 'realpower', units: 'W', series: [] });
if (sparks(none).length)
  fail('a trend was drawn from a backend with no series — a chart of nothing is worse than no chart');

// --- A gap in the middle stays a gap: two runs, not one line joined through the hole.
const gapped = {
  ok: true, metric: 'realpower', units: 'W',
  series: [
    { node: 'solar_a', label: 'Array A', kind: 'solar', values: [100, 400, null, 1600, 2300] },
    { node: 'solar_b', label: 'Array B', kind: 'solar', values: [110, 420, null, 1580, 2300] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [1800, 1600, 1400, 1300, 1200] },
  ],
};
const withGap = await render(gapped);
const solarSpark = sparks(withGap)[0];
if (!solarSpark) fail('no trend rendered for the gapped series');
if (lines(solarSpark).length !== 2)
  fail(`a gap in the middle produced ${lines(solarSpark).length} line segment(s) — it must break the line, `
     + 'not draw straight through the missing reading');

// --- A partial sum is a gap. One array reporting while the other does not is not the array's output.
const partial = {
  ok: true, metric: 'realpower', units: 'W',
  series: [
    { node: 'solar_a', label: 'Array A', kind: 'solar', values: [100, 400, 900, 1600, 2300] },
    { node: 'solar_b', label: 'Array B', kind: 'solar', values: [null, null, null, null, null] },
    { node: 'grid', label: 'Grid', kind: 'grid', values: [1800, 1600, 1400, 1300, 1200] },
  ],
};
const half = await render(partial);
// Solar has no complete step, so it gets no line; the grid, which reported throughout, still does.
const tiles = query(half, '.energy-tile', true);
const solarTile = tiles.find(t => t.classList.has('solar'));
if (!solarTile) fail(`no solar tile; tiles present: ${JSON.stringify(tiles.map(t => t.className))}`);
if (sparks(solarTile).length)
  fail("the solar trend was drawn while one of its two arrays reported nothing — that line is the half "
     + 'that answered, presented as the whole array');
const gridTile = tiles.find(t => t.classList.has('grid'));
if (gridTile && !sparks(gridTile).length)
  fail('the grid trend vanished, though the grid reported at every step');

console.log(`sparkline: a trend per tile from real readings (${sparks(drawn).length} drawn, 2px), `
  + 'nothing at all when the backend has none, a gap left as a gap, and a partial sum refused');

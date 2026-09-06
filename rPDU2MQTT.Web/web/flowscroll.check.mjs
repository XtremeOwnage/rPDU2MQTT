// A refresh does not throw the reader back to the top of the page.
//
// draw() empties `wrap` and rebuilds it. Emptying a container as tall as the diagram collapses the page,
// and any layout read taken while it is empty makes the browser clamp the scroll position to the shrunken
// height — the pane measurement added for the width-to-pane layout was exactly such a read, taken right
// after the clear. The scroll never came back, so every refresh jumped to the top.
//
// Two things keep it still: the height is held across the rebuild so the page never shrinks, and the
// measurement is taken before the clear, off a container that is not emptied.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('flowscroll check FAILED: ' + m); process.exit(1); };

const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'grid', label: 'Grid', kind: 'grid', value: 2380, derivation: 'measured' },
    { id: 'panel', label: 'Main Panel', kind: 'panel', value: 1730, derivation: 'measured' },
    { id: 'pdu', label: 'Rack-PDU-1', kind: 'pdu', value: 339, derivation: 'measured' },
  ],
  links: [
    { source: 'grid', target: 'panel', value: 1730 },
    { source: 'panel', target: 'pdu', value: 339 },
  ],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) => url.includes('/api/schema') ? schema
    : url.includes('/api/instances') ? { ok: true, instances: [] }
    : url.includes('/api/config') ? { History: { Enabled: false }, EnergyFlow: { Nodes: [], Links: [] } }
    : url.includes('/api/flow/live') ? { ok: true, values: [] }
    : url.includes('/api/flow/withheld') ? { ok: true, sources: [] }
    : url.includes('/api/flow') ? graph
    : { ok: true },
});

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 60));
query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
await new Promise(r => setTimeout(r, 300));

const sec = query(getEl('sections'), '.section', true).find(x => query(x, '.flow-gestures', true).length > 0);
if (!sec) fail('could not find the Flow section');

// Redrawing has to leave the page standing: a refresh is the thing that used to jump.
const refresh = query(sec, 'button', true).find(b => b.textContent === 'Refresh');
if (!refresh) fail('no Refresh control');
refresh.click();
await new Promise(r => setTimeout(r, 300));
if (!query(sec, '.flow-stage', true).length) fail('the refresh left no diagram behind');

// --- The pane is measured BEFORE the container is emptied ----------------------------------------------
// A layout read taken while the container is empty is what collapses the page and clamps the scroll. The
// stub does no layout, so the order is read off the built source — it is the order that decides.
const src = code;
// `wrap.innerHTML = ''` appears in more than one module, so anchor on the held height, which is unique to
// this rebuild, and compare against the clear that follows it.
const anchor = src.indexOf('const held =');
if (anchor < 0) fail('the container does not hold its height across the rebuild');
const measure = src.indexOf('const paneW =', anchor);
const clear = src.indexOf("wrap.innerHTML = ''", anchor);
if (measure < 0) fail('the pane is never measured');
if (clear < 0) fail('could not find the container clear');
if (measure > clear)
  fail('the pane is measured after the container is emptied — that read collapses the page and the browser '
     + 'clamps the scroll position to the top');
// …and off something that is not the container being emptied.
if (!/const paneW = [^;]*\bsec\b[^;]*clientWidth/.test(src))
  fail('the pane is measured off the container that gets emptied, so the reading is of a collapsed page');

// --- The height is held across the rebuild, and released afterwards ------------------------------------
// Held during: a container that empties without a floor lets the page shrink even without a read of ours,
// because anything else on the page may force layout in the same task.
if (!/minHeight\s*=\s*held\s*\+\s*'px'/.test(src))
  fail('the container does not hold its height across the rebuild');
if (!/minHeight\s*=\s*''/.test(src))
  fail('the held height is never released, so the container keeps the tallest size it ever had');
// Released after the content is back, not before it.
if (src.indexOf("minHeight = held") > src.indexOf("minHeight = ''"))
  fail('the height is released before it is held');

console.log('flowscroll: a refresh rebuilds the diagram without measuring the page while the container is '
  + 'empty, and holds the container height across the rebuild so the page never collapses and the scroll '
  + 'position is never clamped to the top');

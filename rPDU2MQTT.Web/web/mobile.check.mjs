// The flow chart on a phone. Reported from a real one: "looks really bad on mobile, I cannot pan or zoom
// very well either."
//
// Two causes, both visible from here without a browser. The diagram was drawn at its natural width — well
// over a thousand pixels — so a ~390px screen opened on a sliver of it. And the only zoom gesture was
// Ctrl/⌘ + wheel, which a touch device has neither half of: there was no way to zoom at all, and one-finger
// panning fought the container's own scrolling.
//
// This asserts what a phone needs: the chart opens fitted to the pane it is in, a two-finger pinch zooms it,
// and the container leaves ordinary scrolling to the browser.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom, query } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');

// A hierarchy wide enough to need scrolling: four columns of it.
const graph = {
  ok: true, metric: 'realpower', units: 'W',
  nodes: [
    { id: 'grid', label: 'Grid', value: 2000 },
    { id: 'inverter', label: 'EG4 FlexBoss 21', value: 2000 },
    { id: 'panel', label: 'Main Panel', value: 2000 },
    { id: 'pdu_1', label: 'Rack-PDU-1', value: 1200 },
    { id: 'pdu_2', label: 'Rack-PDU-2', value: 800 },
    { id: 'kube01', label: 'Proxmox: Kube01', value: 700 },
    { id: 'nas', label: 'Synology: NAS', value: 500 },
    { id: 'r730xd', label: 'Dell: r730XD', value: 800 },
  ],
  links: [
    { source: 'grid', target: 'inverter', value: 2000 },
    { source: 'inverter', target: 'panel', value: 2000 },
    { source: 'panel', target: 'pdu_1', value: 1200 },
    { source: 'panel', target: 'pdu_2', value: 800 },
    { source: 'pdu_1', target: 'kube01', value: 700 },
    { source: 'pdu_1', target: 'nas', value: 500 },
    { source: 'pdu_2', target: 'r730xd', value: 800 },
  ],
};

const { sandbox, getEl } = makeDom({
  bodies: (url) =>
    url.includes('/api/schema') ? schema :
    url.includes('/api/instances') ? { ok: true, instances: [] } :
    url.includes('/api/config') ? { EnergyFlow: { Nodes: [], Links: [] } } :
    url.includes('/api/flow') ? graph :
    { ok: true },
});

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
await new Promise(r => setTimeout(r, 50));

const fail = (m) => { console.error('mobile check FAILED: ' + m); process.exit(1); };

query(getEl('nav'), 'a', true).find(a => a.dataset.label === 'Flow').click();
await new Promise(r => setTimeout(r, 80));

// The scroll container is the one holding the Sankey; the stub reports every pane as 100px wide, which is
// the phone case in miniature — the diagram is many times that.
const svg = query(getEl('sections'), 'svg', true).find(s => s.attrs.viewBox && Number(s.attrs.width) > 0);
if (!svg) fail('no flow chart was drawn');

const base = Number(svg.attrs.viewBox.split(' ')[2]);
const drawn = Number(svg.attrs.width);
if (!(base > 100)) fail(`the fixture is not wide enough to test fitting (viewBox width ${base})`);
if (drawn >= base)
  fail(`the chart opened at its full ${drawn}px inside a 100px pane — on a phone that is a sliver of it, `
     + 'and nothing about the diagram is legible');

// Fitted to the pane, unless that would take it below the legibility floor — past a point, shrinking
// further trades one unreadable diagram for another, and scrolling is the better answer. The stub reports
// every pane as 100px, which is well past that floor; a real phone (~390px on a ~1200px diagram) fits
// outright.
const floor = 0.15 * base;
if (drawn > Math.max(100, floor) + 1)
  fail(`the chart opened at ${drawn}px in a 100px pane — neither fitted nor at the ${Math.round(floor)}px floor`);

// The container must leave ordinary scrolling to the browser: a phone pans by swiping, and taking that over
// with our own handler is what made panning feel like it was fighting back.
const scroll = svg.parent;
const touchAction = (scroll.style && scroll.style.touchAction) || '';
if (!touchAction.includes('pan'))
  fail(`the chart's container does not allow native panning (touch-action: '${touchAction}')`);

// ...and a two-finger pinch has to zoom it, since a phone has no wheel and no Ctrl key.
const before = Number(svg.attrs.width);
const pt = (id, x, y) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0, preventDefault() { } });
scroll.dispatch('pointerdown', pt(1, 20, 40));
scroll.dispatch('pointerdown', pt(2, 60, 40));
scroll.dispatch('pointermove', pt(2, 100, 40));   // fingers spread: 40px apart -> 80px
const after = Number(svg.attrs.width);
if (!(after > before))
  fail(`a two-finger pinch did not zoom the chart (width stayed at ${before}px) — on touch there is no other way`);

// And pinching back in shrinks it again, rather than only ever growing.
scroll.dispatch('pointermove', pt(2, 45, 40));
const back = Number(svg.attrs.width);
if (!(back < after)) fail(`pinching back in did not shrink the chart (${after}px -> ${back}px)`);

// The gesture line has to describe what this device can do, and the Fit control has to be reachable.
const footer = query(getEl('sections'), '.flow-gestures', true)[0];
if (!footer) fail('no gesture footer on the flow chart');
if (!footer.textContent.toLowerCase().includes('pinch'))
  fail(`the gesture hint does not mention pinching: "${footer.textContent}"`);
if (!query(footer, 'button', true).some(b => (b.textContent || '').includes('Fit')))
  fail('no Fit control — a reader who has zoomed in has no way back to the whole diagram');

console.log(`mobile: the chart opens scaled to the pane (${base}px diagram drawn at ${drawn}px in a 100px pane), `
  + `a two-finger pinch zooms it ${before}px -> ${after}px -> ${back}px, native panning is left to the browser, `
  + 'and Fit is one tap away');

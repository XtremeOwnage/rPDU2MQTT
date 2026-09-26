// The flow diagram's view survives a live redraw (#492, and the reports on #509).
//
// Two ways it did not, both mostly seen on a phone:
// - A redraw builds a new pane and a new zoom, and the zoom's resize observer reports once as soon as it is
//   attached. Re-fitting on that report reset the pane to its top-left corner whenever the new drawing came
//   out a different width from the last — which "Hide small" makes routine: a load crossing the threshold
//   appears or disappears, and with it a label column.
// - A redraw landing mid-swipe or mid-pinch replaced the pane under the finger.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');
const fail = (m) => { console.error('flowview check FAILED: ' + m); process.exit(1); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// A resize observer the test fires by hand, as a browser does once on attach.
const observers = [];
const { sandbox } = makeDom({ bodies: (url) => url.includes('/api/schema') ? schema : { ok: true } });
sandbox.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
if (typeof sandbox.attachZoom !== 'function') fail('attachZoom is not reachable in the bundle');

/// A phone-width pane whose scroll extent follows the diagram's drawn size, as a browser's does.
const pane = (clientWidth = 360, clientHeight = 600) => {
  const listeners = {};
  const p = {
    clientWidth, clientHeight, scrollLeft: 0, scrollTop: 0, style: {},
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: clientWidth, height: clientHeight }; },
    fire(t, e = {}) { (listeners[t] || []).forEach(f => f({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 0, clientY: 0, ...e })); },
  };
  return p;
};
const svgFor = (p) => ({
  setAttribute(k, v) {
    if (k === 'width') p.scrollWidth = Math.max(p.clientWidth, Number(v));
    if (k === 'height') p.scrollHeight = Math.max(p.clientHeight, Number(v));
  },
});

// --- The first drawing: fitted to the phone, then panned to the middle by the reader. ------------------
const a = pane();
const zoomA = sandbox.attachZoom(a, svgFor(a), 1640, 12000, true);
const fitA = a.scrollWidth / 1640;
a.scrollLeft = (a.scrollWidth - a.clientWidth) / 2;
a.scrollTop = (a.scrollHeight - a.clientHeight) / 2;
const kept = zoomA.view();

// --- The next live drawing is wider: a load crossed the Hide small threshold and its column came back. --
const b = pane();
observers.length = 0;
const zoomB = sandbox.attachZoom(b, svgFor(b), 1900, 12000, true);
zoomB.setView(kept);
// The observer's report on attach: the pane has not changed width, so nothing may move.
observers.forEach(o => o.cb([]));
// Fitted to the width, a phone scrolls the diagram up and down: that is the position to keep.
if (!(b.scrollHeight > b.clientHeight)) fail('the fixture diagram does not scroll, so it proves nothing');
const midY = b.scrollTop / (b.scrollHeight - b.clientHeight);
if (Math.abs(midY - 0.5) > 0.02) fail(`a redraw moved the reader from halfway down to ${midY.toFixed(2)}`);
// A view that was only ever the fit is the fit of the new drawing.
if (Math.abs(zoomB.view().z - (b.clientWidth - 6) / 1900) > 0.002) fail(`the new drawing is not fitted (${zoomB.view().z} vs ${fitA})`);

// A zoom the reader chose is kept exactly.
const c = pane();
const zoomC = sandbox.attachZoom(c, svgFor(c), 1652, 12000, true);
zoomC.setView({ ...kept, z: 0.6, chosen: true });
if (zoomC.view().z !== 0.6) fail('a zoom the reader set was replaced by the fit');

// A real change of width (a rotation) still re-fits, and keeps the place rather than jumping to the corner.
b.clientWidth = 740;
observers.forEach(o => o.cb([]));
if (Math.abs(zoomB.view().z - (740 - 6) / 1900) > 0.002) fail('a rotation did not re-fit the diagram');
const afterRotate = b.scrollTop / (b.scrollHeight - b.clientHeight);
if (Math.abs(afterRotate - 0.5) > 0.02) fail(`a rotation sent the reader from halfway down to ${afterRotate.toFixed(2)}`);

// --- Moving the pane holds the redraw. ------------------------------------------------------------------
const d = pane();
const zoomD = sandbox.attachZoom(d, svgFor(d), 1640, 12000, true);
if (zoomD.busy()) fail('a pane nobody has touched reads as busy');
d.fire('pointerdown');
if (!zoomD.busy()) fail('a finger on the pane does not hold the redraw');
d.fire('pointerup');
if (!zoomD.busy()) fail('a swipe that has just been let go (and is still coasting) does not hold the redraw');
await wait(900);
if (zoomD.busy()) fail('the pane still reads as busy long after it stopped moving');
d.fire('scroll');
if (!zoomD.busy()) fail('a pane still scrolling does not hold the redraw');
await wait(900);
// Putting the view back after a redraw scrolls the pane, and that is not the reader moving it.
zoomD.setView(zoomD.view());
d.fire('scroll');
if (zoomD.busy()) fail('the redraw\'s own scroll holds the next redraw, so it would never draw');

// …and the Flow page uses it: a live reading arriving mid-gesture waits.
if (!/zoom\?\.busy\?\.\(\)\) \{ heldGraph = body; drawWhenStill\(\)/.test(code))
  fail('the Flow page draws a live reading even while the reader is moving the diagram');

// A touch screen gets no floating zoom buttons (it pinches, and Fit is under the diagram), and each device is
// told only the gestures it has: a mouse cannot pinch, and a phone has no Ctrl key.
const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
const touch = /@media \(hover: none\) and \(pointer: coarse\)\s*\{([^}]*\}[^}]*\}[^}]*\}[^}]*)\}/.exec(css)?.[1] || '';
if (!/\.flow-zoom\s*\{\s*display:\s*none/.test(touch)) fail('the floating zoom buttons still show on a touch screen');
if (!/\.flow-gestures \.on-mouse\s*\{\s*display:\s*none/.test(touch)) fail('a touch screen is still told to use Ctrl + scroll');
if (!/^\s*\.flow-gestures \.on-touch\s*\{\s*display:\s*none/m.test(css)) fail('a mouse is still told to pinch');
if (!/class: 'on-touch', text: '[^']*pinch/.test(code) || /class: 'on-mouse', text: '[^']*pinch/.test(code))
  fail('pinching is not confined to the touch line');

console.log('flowview: a live redraw keeps the reader where they were, even when the drawing comes out wider; a '
  + 'chosen zoom is kept; a rotation re-fits in place; a reading arriving mid-swipe or mid-pinch waits until the pane is still');

// Behavioral smoke test for the bundled GUI: stub a minimal DOM + fetch, run app.js, and let
// load() -> build() construct every section. Catches cross-module wiring/reference errors that a mere
// syntax check would miss. Not a substitute for a browser, but it exercises the whole setup path.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');

function fakeEl() {
  const node = {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { return c; }, append() {}, removeChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    click() {}, focus() {}, select() {}, setSelectionRange() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    getScreenCTM() { return { inverse() { return {}; } }; },
    append: function () {},
  };
  return new Proxy(node, { get(t, k) { return k in t ? t[k] : undefined; }, set() { return true; } });
}

const bodies = (url) =>
  url.includes('/api/schema') ? [] :
  url.includes('/api/instances') ? { ok: true, instances: [] } :
  { ok: true };

const sandbox = {
  console,
  document: {
    getElementById: () => fakeEl(), createElement: () => fakeEl(), createElementNS: () => fakeEl(),
    createTextNode: () => fakeEl(), querySelector: () => fakeEl(), querySelectorAll: () => [],
    elementFromPoint: () => null,
  },
  window: { addEventListener() {}, removeEventListener() {} },
  navigator: { clipboard: { writeText() {} } },
  DOMPoint: class { matrixTransform() { return { x: 0, y: 0 }; } },
  setTimeout: () => 0, setInterval: () => 0, clearInterval() {},
  fetch: async (url) => ({ ok: true, text: async () => '', json: async () => bodies(String(url)) }),
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
// load() is async; give its awaited fetches a tick to resolve so build() runs.
await new Promise(r => setTimeout(r, 50));
console.log('smoke: bundle evaluated and build() ran without throwing');

// Behavioral smoke test for the bundled GUI: stub a minimal DOM + fetch, run app.js, and let
// load() -> build() construct every section. Catches cross-module wiring/reference errors that a mere
// syntax check would miss. Not a substitute for a browser, but it exercises the whole setup path.
//
// The schema is the REAL one (schema.fixture.json, dumped from ConfigSchema.Build()), not an empty list:
// an empty schema renders no sections at all, which made this test pass no matter what build() did with
// them. Regenerate the fixture when config sections change — see the header note in that file.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
// The leading _README node carries the fixture's regeneration note (JSON has no comments); it isn't
// part of the schema, so drop it before handing it to the app.
const schema = JSON.parse(await readFile(new URL('./schema.fixture.json', import.meta.url), 'utf8'))
  .filter(n => n.key !== '_README');

// --- A small fake DOM that actually keeps a tree, so we can assert on what was rendered -------------
// (The previous stub discarded every appendChild, so nothing about the output could be checked.)
function matches(node, sel) {
  sel = sel.trim();
  const attr = sel.match(/^(\w+)\[type=(\w+)\]$/);
  if (attr) return node.tag === attr[1] && node.attrs.type === attr[2];
  if (sel.startsWith('.')) return node.classList.has(sel.slice(1));
  const tagClass = sel.match(/^(\w+)\.([\w-]+)$/);
  if (tagClass) return node.tag === tagClass[1] && node.classList.has(tagClass[2]);
  return node.tag === sel;
}
// Supports the selector shapes the GUI actually uses: "a", ".field", "nav a", "input[type=checkbox]",
// and comma lists like "input, select, textarea".
function query(root, sel, all) {
  const out = [];
  for (const branch of sel.split(',')) {
    const parts = branch.trim().split(/\s+/);
    let cur = [root];
    for (const p of parts) {
      const next = [];
      for (const n of cur) for (const d of descendants(n)) if (matches(d, p)) next.push(d);
      cur = next;
    }
    out.push(...cur);
  }
  return all ? out : (out[0] ?? null);
}
function* descendants(node) {
  for (const c of node.children) { yield c; yield* descendants(c); }
}

function makeEl(tag = 'div') {
  const node = {
    tag, children: [], attrs: {}, style: {}, dataset: {}, _text: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => x && this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      has(c) { return this._s.has(c); },
    },
    get className() { return [...this.classList._s].join(' '); },
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get textContent() { return this._text || this.children.map(c => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    set innerHTML(v) { if (!v) this.children = []; },
    get innerHTML() { return ''; },
    appendChild(c) { if (c && c.tag) this.children.push(c); return c; },
    append(...cs) { cs.forEach(c => { if (c && c.tag) this.children.push(c); }); },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() {}, insertBefore(c) { this.children.push(c); return c; },
    // Node.contains(): self or any descendant (used to tell Oidc fields from Basic ones).
    contains(n) { if (n === this) return true; for (const d of descendants(this)) if (d === n) return true; return false; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    click() { if (typeof this.onclick === 'function') this.onclick({ preventDefault() {}, stopPropagation() {} }); },
    focus() {}, select() {}, setSelectionRange() {},
    querySelector(s) { return query(this, s, false); },
    querySelectorAll(s) { return query(this, s, true); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    getScreenCTM() { return { inverse() { return {}; } }; },
  };
  // classList.has is used by our matcher; keep `contains` as the DOM-facing name.
  return node;
}

const root = makeEl('body');
const byId = {};
const getEl = (id) => (byId[id] ||= Object.assign(makeEl(id === 'nav' ? 'nav' : 'div'), { id }));
// nav + sections live in the tree so `document.querySelectorAll('nav a')` can find the links.
root.appendChild(getEl('nav'));
root.appendChild(getEl('sections'));

const bodies = (url) =>
  url.includes('/api/schema') ? schema :
  url.includes('/api/instances') ? { ok: true, instances: [] } :
  url.includes('/api/config') ? {} :
  { ok: true };

const sandbox = {
  console,
  document: {
    body: root,
    getElementById: (id) => getEl(id),
    createElement: (t) => makeEl(t), createElementNS: (_ns, t) => makeEl(t),
    createTextNode: () => makeEl('#text'),
    querySelector: (s) => query(root, s, false),
    querySelectorAll: (s) => query(root, s, true),
    elementFromPoint: () => null,
  },
  window: { addEventListener() {}, removeEventListener() {} },
  // protocol/hostname are read when building the API docs links (#190).
  location: { hash: '', protocol: 'http:', hostname: 'localhost' },
  navigator: { clipboard: { writeText() {} } },
  DOMPoint: class { matrixTransform() { return { x: 0, y: 0 }; } },
  setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  setInterval: () => 0, clearInterval() {},
  fetch: async (url) => ({ ok: true, text: async () => '', json: async () => bodies(String(url)) }),
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
// load() is async; give its awaited fetches a tick to resolve so build() runs.
await new Promise(r => setTimeout(r, 50));

// --- Assertions -------------------------------------------------------------------------------------
const fail = (m) => { console.error('smoke FAILED: ' + m); process.exit(1); };

const nav = getEl('nav');
const linkText = query(nav, 'a', true).map(a => a.textContent);
const groups = query(nav, '.nav-group', true).map(g => g.textContent);

if (!linkText.length) fail('no nav links were rendered');
for (const g of ['Data Sources', 'Destinations', 'System', 'Tools'])
  if (!groups.includes(g)) fail(`nav group "${g}" missing (got: ${groups.join(', ')})`);

// Every non-hidden schema section must reach the nav. "Api" is deliberately in no NAV_GROUPS list, so
// this also pins the catch-all: without it, ungrouped sections vanish from the UI entirely.
for (const key of ['MQTT', 'Pdus', 'EmonCMS', 'HomeAssistant', 'Prometheus', 'Api'])
  if (!linkText.some(t => t.replace(/\s/g, '').toLowerCase().includes(key.toLowerCase())))
    fail(`schema section "${key}" has no nav link (got: ${linkText.join(', ')})`);

// EnergyFlow is hidden from the schema-driven nav in favour of the bespoke Flow tab.
if (linkText.includes('EnergyFlow')) fail('EnergyFlow should be hidden from the config nav');

if (!query(getEl('sections'), '.section', true).length) fail('no sections were rendered');

console.log(`smoke: build() rendered ${linkText.length} nav links across ${groups.length} groups; sections OK`);

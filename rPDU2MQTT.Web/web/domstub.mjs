// The fake DOM the GUI tests run against: a real tree, so what was rendered can be asserted on, plus the
// browser globals the bundle touches. Shared by smoke.mjs and layout.check.mjs — one stub, so a gap in it
// gets fixed once and both tests get the fix.
//
// Where it models a browser, it models the awkward version: EventSource is deliberately absent, so the
// no-push fallback path stays exercised. A stub that only does the convenient thing is how a bug hides.

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
export function query(root, sel, all) {
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

export function makeEl(tag = 'div') {
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
    addEventListener() { }, removeEventListener() { },
    click() { if (typeof this.onclick === 'function') this.onclick({ preventDefault() { }, stopPropagation() { } }); },
    focus() { }, select() { }, setSelectionRange() { },
    querySelector(s) { return query(this, s, false); },
    querySelectorAll(s) { return query(this, s, true); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    getScreenCTM() { return { inverse() { return {}; } }; },
  };
  // classList.has is used by our matcher; keep `contains` as the DOM-facing name.
  return node;
}

// Build a sandbox whose fetch answers from `bodies(url)`. Returns the pieces a test needs to drive it.
export function makeDom({ bodies }) {
  const root = makeEl('body');
  const byId = {};
  const getEl = (id) => (byId[id] ||= Object.assign(makeEl(id === 'nav' ? 'nav' : 'div'), { id }));
  // nav + sections live in the tree so `document.querySelectorAll('nav a')` can find the links.
  root.appendChild(getEl('nav'));
  root.appendChild(getEl('sections'));

  // A tiny localStorage, so the theme can persist the way it does in a browser.
  const storage = new Map();

  const sandbox = {
    console,
    document: {
      body: root,
      // The theme sets data-theme here; nothing else touches it.
      documentElement: makeEl('html'),
      getElementById: (id) => getEl(id),
      createElement: (t) => makeEl(t), createElementNS: (_ns, t) => makeEl(t),
      createTextNode: () => makeEl('#text'),
      querySelector: (s) => query(root, s, false),
      querySelectorAll: (s) => query(root, s, true),
      elementFromPoint: () => null,
    },
    window: { addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; }, prompt: () => null },
    // protocol/hostname are read when building the API docs links (#190).
    location: { hash: '', protocol: 'http:', hostname: 'localhost' },
    navigator: { clipboard: { writeText() { } } },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    DOMPoint: class { matrixTransform() { return { x: 0, y: 0 }; } },
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout() { },
    setInterval: () => 0, clearInterval() { },
    confirm: () => true,
    fetch: async (url) => ({ ok: true, status: 200, text: async () => '', json: async () => bodies(String(url)) }),
    // EventSource is deliberately absent: it exercises the no-push path, where every section must still
    // work off its manual refresh / polling fallback.
  };
  sandbox.globalThis = sandbox;

  return { sandbox, root, byId, getEl, query, makeEl, storage };
}

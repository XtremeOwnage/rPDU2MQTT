// Fake DOM and browser globals for the GUI checks.

function matches(node, sel) {
  sel = sel.trim();
  const attr = sel.match(/^(\w+)\[type=(\w+)\]$/);
  if (attr) return node.tag === attr[1] && node.attrs.type === attr[2];
  // Bare attribute selector, e.g. [data-node].
  const bare = sel.match(/^\[([\w-]+)\]$/);
  if (bare) return node.attrs[bare[1]] !== undefined;
  if (sel.startsWith('.')) return node.classList.has(sel.slice(1));
  const tagClass = sel.match(/^(\w+)\.([\w-]+)$/);
  if (tagClass) return node.tag === tagClass[1] && node.classList.has(tagClass[2]);
  return node.tag === sel;
}

// Supports "a", ".field", "nav a", "input[type=checkbox]" and comma lists.
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

// A text node, as append()/appendChild() create for a bare string.
export function textNode(t) { return Object.assign(makeEl('#text'), { _text: String(t ?? '') }); }

function asNode(c) { return typeof c === 'string' || typeof c === 'number' ? textNode(c) : c; }

// Shared focus target for focus()/blur() and document.activeElement.
let focused = null;

export function makeEl(tag = 'div') {
  const node = {
    tag, tagName: String(tag).toUpperCase(), children: [], attrs: {}, style: {}, dataset: {}, _text: '',
    // Form-control properties a real element always has.
    value: '', checked: false, disabled: false,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => x && this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) { const on = force === undefined ? !this._s.has(c) : !!force; if (on) this._s.add(c); else this._s.delete(c); return on; },
      has(c) { return this._s.has(c); },
    },
    get className() { return [...this.classList._s].join(' '); },
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get textContent() { return this._text || this.children.map(c => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    set innerHTML(v) { if (!v) this.children = []; },
    get innerHTML() { return ''; },
    // Parentage is tracked so remove() detaches.
    parent: null,
    appendChild(c) {
      c = asNode(c);
      if (c && c.tag) { c.parent = this; this.children.push(c); this._adoptOption(c); }
      return c;
    },
    // A <select> takes its first option's value until one is set.
    _adoptOption(c) {
      if (this.tag !== 'select' || !c || c.tag !== 'option' || this._adopted) return;
      this._adopted = true;
      this.value = c.value || (c.attrs && c.attrs.value) || '';
    },
    append(...cs) { cs.forEach(c => { c = asNode(c); if (c && c.tag) { c.parent = this; this.children.push(c); this._adoptOption(c); } }); },
    removeChild(c) { this.children = this.children.filter(x => x !== c); if (c) c.parent = null; },
    remove() { if (this.parent) this.parent.removeChild(this); },
    replaceWith(next) {
      const p = this.parent;
      if (!p) return;
      const i = p.children.indexOf(this);
      if (i < 0) return;
      if (next && next.tag) { next.parent = p; p.children[i] = next; } else p.children.splice(i, 1);
      this.parent = null;
    },
    insertBefore(c) { if (c && c.tag) { c.parent = this; this.children.push(c); } return c; },
    focus() { focused = this; },
    blur() { if (focused === this) focused = null; },
    contains(n) { if (n === this) return true; for (const d of descendants(this)) if (d === n) return true; return false; },
    // A `class` attribute sets the class list.
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    // Listeners are recorded so a test can fire them.
    _on: {},
    addEventListener(type, fn) { (this._on[type] ||= []).push(fn); },
    removeEventListener(type, fn) { this._on[type] = (this._on[type] || []).filter(f => f !== fn); },
    // Bubbles only the DOM's bubbling events; stopPropagation stops it.
    dispatch(type, ev) {
      const BUBBLES = ['change', 'input', 'click', 'keydown', 'keyup', 'submit', 'focusin', 'focusout'];
      let stopped = false;
      const e = ev && typeof ev === 'object' ? ev : {};
      const inner = e.stopPropagation;
      e.stopPropagation = function () { stopped = true; if (typeof inner === 'function') inner.call(this); };
      for (let node = this; node; node = node.parent) {
        // Both the on<type> property and addEventListener.
        const prop = node['on' + type];
        if (typeof prop === 'function') prop.call(node, e);
        (node._on?.[type] || []).slice().forEach(f => f(e));
        if (stopped || !BUBBLES.includes(type)) break;
      }
    },
    click() { if (typeof this.onclick === 'function') this.onclick({ preventDefault() { }, stopPropagation() { } }); },
    select() { }, setSelectionRange() { },
    querySelector(s) { return query(this, s, false); },
    querySelectorAll(s) { return query(this, s, true); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    getScreenCTM() { return { inverse() { return {}; } }; },
  };
  return node;
}

// Build a sandbox whose fetch answers from `bodies(url)`. Returns the pieces a test needs to drive it.
export function makeDom({ bodies }) {
  const root = makeEl('body');
  const byId = {};
  const getEl = (id) => (byId[id] ||= Object.assign(makeEl(id === 'nav' ? 'nav' : 'div'), { id }));
  // nav and sections are in the tree so document queries find them.
  root.appendChild(getEl('nav'));
  root.appendChild(getEl('sections'));

  const storage = new Map();

  const sandbox = {
    console,
    document: {
      body: root,
      get activeElement() { return focused; },
      set activeElement(e) { focused = e; },
      documentElement: makeEl('html'),
      getElementById: (id) => getEl(id),
      createElement: (t) => makeEl(t), createElementNS: (_ns, t) => makeEl(t),
      createTextNode: (t) => textNode(t),
      querySelector: (s) => query(root, s, false),
      querySelectorAll: (s) => query(root, s, true),
      elementFromPoint: () => null,
      _on: {},
      addEventListener(type, fn) { (this._on[type] ||= []).push(fn); },
      removeEventListener(type, fn) { this._on[type] = (this._on[type] || []).filter(f => f !== fn); },
      dispatch(type, ev) { (this._on[type] || []).slice().forEach(f => f(ev)); },
    },
    // Window listeners are recorded; dispatchEvent stays inert.
    window: {
      _on: {},
      addEventListener(type, fn) { (this._on[type] ||= []).push(fn); },
      removeEventListener(type, fn) { this._on[type] = (this._on[type] || []).filter(f => f !== fn); },
      dispatch(type, ev) { (this._on[type] || []).slice().forEach(f => f(ev)); },
      dispatchEvent() { return true; },
      prompt: () => null,
    },
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
    fetch: async (url, opts) => ({ ok: true, status: 200, text: async () => { const b = bodies(String(url), opts); return typeof b === 'string' ? b : ''; }, json: async () => bodies(String(url), opts) }),
    // EventSource is deliberately absent so the polling fallback is exercised.
  };
  sandbox.globalThis = sandbox;

  return { sandbox, root, byId, getEl, query, makeEl, storage };
}

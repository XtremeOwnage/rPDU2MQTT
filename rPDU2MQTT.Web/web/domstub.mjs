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
  // Bare attribute selector, e.g. [data-node] — how the focus code finds what it may dim. Without it the
  // focus matched nothing under test while working fine in a browser, which makes any assertion useless.
  const bare = sel.match(/^\[([\w-]+)\]$/);
  if (bare) return node.attrs[bare[1]] !== undefined;
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

// A text node with its text. The browser's append()/appendChild() accept a bare string; the stub used to
// drop it, so a label built as el('label', {}, checkbox, ' Track daily totals') rendered as a checkbox with
// no words next to it here while reading correctly in a browser — and any assertion on that text was
// vacuous rather than failing.
export function textNode(t) { return Object.assign(makeEl('#text'), { _text: String(t ?? '') }); }

// What append()/appendChild() were handed: an element, or text to wrap in a node.
function asNode(c) { return typeof c === 'string' || typeof c === 'number' ? textNode(c) : c; }

export function makeEl(tag = 'div') {
  const node = {
    tag, children: [], attrs: {}, style: {}, dataset: {}, _text: '',
    // Form-control properties a real element always has. el() assigns a prop when `k in e` and falls back
    // to setAttribute otherwise, so without these an input's value silently became an attribute here while
    // being a property in the browser — and a test reading either one would disagree with the app.
    value: '', checked: false, disabled: false,
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
    // Parentage is tracked so remove() actually detaches: a panel mounted on <body> and later closed has
    // to leave the tree, or a test can't tell an open modal from a closed one.
    parent: null,
    appendChild(c) {
      c = asNode(c);
      if (c && c.tag) { c.parent = this; this.children.push(c); this._adoptOption(c); }
      return c;
    },
    // A <select> reports its first option's value until something sets another — including when that
    // value is the empty string, which is how a leading "— pick —" option works.
    _adoptOption(c) {
      if (this.tag !== 'select' || !c || c.tag !== 'option' || this._adopted) return;
      this._adopted = true;
      this.value = c.value || (c.attrs && c.attrs.value) || '';
    },
    append(...cs) { cs.forEach(c => { c = asNode(c); if (c && c.tag) { c.parent = this; this.children.push(c); this._adoptOption(c); } }); },
    removeChild(c) { this.children = this.children.filter(x => x !== c); if (c) c.parent = null; },
    remove() { if (this.parent) this.parent.removeChild(this); },
    // Swap this node for another in the parent's child list, keeping its position — used where a toolbar
    // rebuilds itself in place.
    replaceWith(next) {
      const p = this.parent;
      if (!p) return;
      const i = p.children.indexOf(this);
      if (i < 0) return;
      if (next && next.tag) { next.parent = p; p.children[i] = next; } else p.children.splice(i, 1);
      this.parent = null;
    },
    insertBefore(c) { if (c && c.tag) { c.parent = this; this.children.push(c); } return c; },
    // Node.contains(): self or any descendant (used to tell Oidc fields from Basic ones).
    contains(n) { if (n === this) return true; for (const d of descendants(this)) if (d === n) return true; return false; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    // Listeners are recorded, not discarded, so a test can fire one — the hover card and the focus
    // highlight are only reachable through events, and an untested interaction rots unnoticed.
    _on: {},
    addEventListener(type, fn) { (this._on[type] ||= []).push(fn); },
    removeEventListener(type, fn) { this._on[type] = (this._on[type] || []).filter(f => f !== fn); },
    // Events that bubble, do — and stopPropagation stops them, or a handler that guards against its own
    // ancestor (the diagram's "click the canvas to unfocus") would be undone by the ancestor it guarded
    // against. Only the DOM's own bubbling events are listed: mouseenter/mouseleave do not bubble, and
    // pretending they did would make a hover test pass where a pointer never reached the element.
    dispatch(type, ev) {
      const BUBBLES = ['change', 'input', 'click', 'keydown', 'keyup', 'submit', 'focusin', 'focusout'];
      let stopped = false;
      const e = ev && typeof ev === 'object' ? ev : {};
      const inner = e.stopPropagation;
      e.stopPropagation = function () { stopped = true; if (typeof inner === 'function') inner.call(this); };
      for (let node = this; node; node = node.parent) {
        // Both ways of listening, as the DOM does: the `on<type>` property and addEventListener.
        const prop = node['on' + type];
        if (typeof prop === 'function') prop.call(node, e);
        (node._on?.[type] || []).slice().forEach(f => f(e));
        if (stopped || !BUBBLES.includes(type)) break;
      }
    },
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
      createTextNode: (t) => textNode(t),
      querySelector: (s) => query(root, s, false),
      querySelectorAll: (s) => query(root, s, true),
      elementFromPoint: () => null,
      // Document-level listeners are how a modal picks up Escape; record them so a test can fire one.
      _on: {},
      addEventListener(type, fn) { (this._on[type] ||= []).push(fn); },
      removeEventListener(type, fn) { this._on[type] = (this._on[type] || []).filter(f => f !== fn); },
      dispatch(type, ev) { (this._on[type] || []).slice().forEach(f => f(ev)); },
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

// ── state.ts ────────────────────────────────────────────────────
// Shared, mutable app state: the config schema and the editable config document, both set on load(), plus
// the relations a calculated binding can use — served by the backend rather than restated here, because a
// second copy of the electrics is a second thing to be wrong about.
// (Authored as ES modules; the build bundles them into one shared scope, as the GUI has always run.)
const state                                                   = { schema: [], data: {}, derivations: [] };

/// One page asking another to open on something specific — "show me Solar for today".
///
/// Set by whoever is navigating, consumed once by the page that lands. Deliberately not in the URL: the
/// hash is the tab, and a node set encoded into it would be a second router to keep honest. A request that
/// is never collected simply expires the next time one is made.
const focus                                                                         =
  { nodes: null, range: null, label: null };

/// Ask a page to open focused on these nodes. `range` is a Trends range value, e.g. 'today=1&step=300'.
function requestFocus(nodes          , range               , label               ) {
  focus.nodes = nodes.length ? [...nodes] : null;
  focus.range = range;
  focus.label = label;
}

/// Take the pending request, if there is one. Reading it clears it — landing on the page twice should not
/// re-apply a selection the reader has since changed.
function takeFocus() {
  if (!focus.nodes) return null;
  const taken = { nodes: focus.nodes, range: focus.range, label: focus.label };
  focus.nodes = null; focus.range = null; focus.label = null;
  return taken;
}

// ── helpers.ts ──────────────────────────────────────────────────
// Generic, dependency-free helpers: fetch wrapper, DOM builders, the toast, tab activation, the SVG
// zoom helper, and the multi-PDU instance selector.

// `status` is carried so a caller can say *why* a call failed when the response had no message of its
// own — an empty or non-JSON body reads as a bare "couldn't load it" otherwise, which says nothing.
const api = (p        , opt      ) => fetch(p, opt).then(async r => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));

function ensure(obj     , key        , fallback     ) { if (obj[key] === undefined || obj[key] === null) obj[key] = fallback; return obj[key]; }

// --- DOM helpers ---------------------------------------------------------------------------------
// Create an element with optional props and children, to cut createElement/append boilerplate.
function el(tag        , props      , ...children       )      {
  const e      = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k === 'text') e.textContent = v;
    else if (k in e) e[k] = v; else e.setAttribute(k, v       );
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
// A small ".small" button (add a class like "danger"/"primary" via cls).
function btn(label        , cls         )      { return el('button', { class: 'small' + (cls ? ' ' + cls : ''), text: label }); }

function formatNum(v     ) { return (typeof v === 'number' && Number.isFinite(v)) ? v.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(v); }

// SVG element helper (separate namespace from el()).
function svgEl(tag        , attrs      )      {
  const e      = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v       );
  return e;
}

// Stacked, self-dismissing toasts. The old one was a single <span> in the save bar: a second message
// silently replaced the first, and anything raised while you were scrolled down was never seen at all.
// Same signature, so every existing caller keeps working.
function toast(msg        , good          ) {
  const host      = document.getElementById('toasts');
  if (!host || !msg) return;
  const cls = 'toast ' + (good ? 'good' : 'bad');
  // Repeating the same message (a per-item loop reporting each result) just refreshes the existing one.
  const last      = host.lastChild;
  if (last && last.dataset && last.dataset.msg === msg) { clearTimeout(last._timer); last.className = cls; last._timer = setTimeout(() => dismissToast(last), toastLife(msg)); return; }

  const t      = el('div', { class: cls });
  t.dataset.msg = msg;
  t.append(
    el('span', { class: 'toast-icon', text: good ? '✓' : '✕' }),
    el('span', { class: 'toast-msg', text: msg }),
    el('button', { class: 'toast-close', title: 'Dismiss', text: '✕', onclick: () => dismissToast(t) }),
  );
  host.appendChild(t);
  // Cap the stack so a chatty loop can't paper over the page.
  while (host.children.length > 4) host.removeChild(host.children[0]);
  t._timer = setTimeout(() => dismissToast(t), toastLife(msg));
}
// Long messages need longer to read; failures stay put longer than confirmations.
function toastLife(msg        ) { return Math.min(14000, 4000 + msg.length * 45); }
function dismissToast(t     ) {
  if (!t || t._gone) return;
  t._gone = true; clearTimeout(t._timer); t.classList.add('leaving');
  setTimeout(() => t.remove(), 200);
}

// --- Overlay sheet -------------------------------------------------------------------------------
// A centered modal panel used by the command palette and the change review. Returns { close }.
// Only one is open at a time; Esc and a backdrop click both dismiss it.
function openSheet(opts     ) {
  const overlay      = document.getElementById('overlay');
  if (!overlay) return { close() { } };
  closeSheet();

  const sheet = el('div', { class: 'sheet' + (opts.wide ? ' wide' : '') });
  const close = () => closeSheet();

  if (opts.title || opts.search) {
    const head = el('div', { class: 'sheet-head' });
    if (opts.search) head.appendChild(opts.search);
    else head.appendChild(el('div', { class: 'sheet-title', text: opts.title }));
    head.appendChild(el('button', { class: 'icon-btn', title: 'Close', text: '✕', onclick: close }));
    sheet.appendChild(head);
  }
  const body = el('div', { class: 'sheet-body' });
  if (opts.body) body.appendChild(opts.body);
  sheet.appendChild(body);
  if (opts.footer) { const f = el('div', { class: 'sheet-foot' }); (opts.footer         ).forEach(b => f.appendChild(b)); sheet.appendChild(f); }

  overlay.innerHTML = '';
  overlay.appendChild(sheet);
  overlay.classList.remove('is-hidden');
  overlay.onclick = (e     ) => { if (e.target === overlay) close(); };
  openSheetEsc = opts.onClose;
  return { close, body };
}
let openSheetEsc      = null;
function closeSheet() {
  const overlay      = document.getElementById('overlay');
  if (!overlay || overlay.classList.contains('is-hidden')) return;
  overlay.classList.add('is-hidden');
  overlay.innerHTML = '';
  const fn = openSheetEsc; openSheetEsc = null;
  if (typeof fn === 'function') fn();
}
function sheetIsOpen() {
  const overlay      = document.getElementById('overlay');
  return !!overlay && !overlay.classList.contains('is-hidden');
}

// Copy text, and say honestly whether it worked. navigator.clipboard only exists in a secure context, and
// this GUI is usually reached over plain http on a LAN — so fall back to the old selection trick rather than
// silently doing nothing while claiming "Copied".
async function copyText(text        )                   {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// Make an element copy some text when clicked, with the feedback that goes with it.
function copyOnClick(node     , text        , label         ) {
  node.style.cursor = 'pointer';
  node.title = 'Click to copy';
  node.onclick = async () => {
    const ok = await copyText(text);
    toast(ok ? `Copied: ${label || text}` : 'Could not copy — your browser blocked it (try selecting the text).', ok);
  };
  return node;
}

// A URL-friendly slug for a nav label (used to put the active tab in the address bar).
function slug(text        )         {
  return (text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// A nav entry: a leading glyph, the label, and room for a badge. The label also lives in `dataset.label`
// because textContent now includes the glyph — everything that identifies a page (hash slugs, the
// palette, the tests) reads navLabel(), never the raw text.
function navLink(nav     , label        , icon         ) {
  const a      = el('a');
  a.dataset.label = label;
  // These are clickable <a>s with no href, so they need the focus + keyboard behaviour spelled out.
  a.tabIndex = 0;
  a.setAttribute('role', 'link');
  a.onkeydown = (e     ) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.click(); } };
  a.append(el('span', { class: 'nav-icon', text: icon || '•' }), el('span', { class: 'nav-label', text: label }));
  nav.appendChild(a);
  return a;
}
function navLabel(link     ) { return (link?.dataset?.label || link?.textContent || '')          ; }

function activate(link     , sec     ) {
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  link.classList.add('active'); sec.classList.add('active');
  // Reflect the active tab in the URL hash so a refresh (or a shared link) reopens it. Only write when it
  // actually changes, to avoid spurious history entries / hashchange loops (see the listener in main.ts).
  const s = slug(navLabel(link));
  if (s && decodeURIComponent((location.hash || '').slice(1)) !== s) location.hash = s;
  // Anything that only runs for the visible page (the live-feed subscriptions) re-evaluates here, so a
  // section never has to watch the nav itself.
  try { window.dispatchEvent?.(new CustomEvent('rpdu:activate')); } catch { /* no CustomEvent: sections just keep polling */ }
}

// Mouse-wheel zoom for an SVG inside a scroll container. The SVG must carry a viewBox of its base size;
// we scale by setting its width/height and keep the point under the cursor fixed. Returns a detach fn.
// Zoom + (optionally) pan a large SVG inside a scroll container. Plain wheel scrolls the container the way
// any overflow does; only Ctrl/⌘+wheel zooms. The old version preventDefault-ed *every* wheel to zoom, which
// left a diagram taller than the viewport with no way to scroll it — it felt frozen. With `pan`, dragging the
// background moves the view like a map (kept off where the SVG has its own drag interactions, e.g. the editor).
function attachZoom(scroll     , svg     , baseW        , baseH        , pan = false) {
  let z = 1; const min = 0.15, max = 6;
  // True once the reader has zoomed themselves: after that we never re-fit under them on a resize.
  let chosen = false;
  const apply = () => { svg.setAttribute('width', Math.round(baseW * z)); svg.setAttribute('height', Math.round(baseH * z)); };
  apply();

  const width = () => scroll.clientWidth || scroll.getBoundingClientRect?.().width || 0;

  /// Scale the diagram down until it fits the pane's width. Never scales UP: a small diagram is not
  /// improved by being blown up to fill the pane.
  const fit = () => {
    const w = width();
    if (!w || !baseW) return;
    const next = Math.min(1, Math.max(min, (w - 6) / baseW));
    if (Math.abs(next - z) < 0.005) return;
    z = next; apply(); scroll.scrollLeft = 0; scroll.scrollTop = 0;
  };

  /// Zoom about a point given in client coordinates, keeping whatever is under it still.
  const zoomAbout = (clientX        , clientY        , factor        ) => {
    const r = scroll.getBoundingClientRect();
    const cx = scroll.scrollLeft + (clientX - r.left), cy = scroll.scrollTop + (clientY - r.top);
    const prev = z;
    z = Math.min(max, Math.max(min, z * factor));
    if (z === prev) return;
    chosen = true;
    apply();
    const k = z / prev;
    scroll.scrollLeft = cx * k - (clientX - r.left);
    scroll.scrollTop = cy * k - (clientY - r.top);
  };

  // A phone has no wheel and no Ctrl, so the desktop gesture leaves touch with no zoom at all — and the
  // diagram is far wider than the screen, which is the state it opened in. Let the browser scroll (that is
  // the pan, with its own inertia) and take the two-finger gesture for ourselves.
  try { scroll.style.touchAction = 'pan-x pan-y'; } catch { /* older stub styles */ }

  const onWheel = (e     ) => {
    if (!(e.ctrlKey || e.metaKey)) return;   // plain wheel: let the container scroll normally
    e.preventDefault();
    zoomAbout(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  };
  scroll.addEventListener('wheel', onWheel, { passive: false });
  const cleanups = [() => scroll.removeEventListener('wheel', onWheel)];

  // --- Pinch, for touch and trackpad-as-pointer. Two live pointers own the gesture; one is a pan.
  const pts = new Map                                  ();
  let pinchFrom = 0;
  const spread = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e     ) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) pinchFrom = spread();
  };
  const onPointerMove = (e     ) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size !== 2 || !pinchFrom) return;
    e.preventDefault?.();
    const now = spread();
    if (!now) return;
    const m = mid();
    zoomAbout(m.x, m.y, now / pinchFrom);
    pinchFrom = now;
  };
  const forget = (e     ) => { pts.delete(e.pointerId); if (pts.size < 2) pinchFrom = 0; };

  scroll.addEventListener('pointerdown', onPointerDown);
  scroll.addEventListener('pointermove', onPointerMove, { passive: false });
  scroll.addEventListener('pointerup', forget);
  scroll.addEventListener('pointercancel', forget);
  cleanups.push(() => {
    scroll.removeEventListener('pointerdown', onPointerDown);
    scroll.removeEventListener('pointermove', onPointerMove);
    scroll.removeEventListener('pointerup', forget);
    scroll.removeEventListener('pointercancel', forget);
  });

  if (pan) {
    // `armed` on press, but only actually pan once the pointer passes a small threshold. Without that, a plain
    // click nudged the scroll by a pixel, moved the target out from under the cursor, and the browser dropped
    // the click — so clickable nodes (expand a group) never fired.
    let armed = false, panning = false, sx = 0, sy = 0, sl = 0, st = 0;
    scroll.style.cursor = 'grab';
    const onDown = (e     ) => {
      if (e.button !== 0 || pts.size > 1) return;
      armed = true; panning = false; sx = e.clientX; sy = e.clientY; sl = scroll.scrollLeft; st = scroll.scrollTop;
    };
    // Track on window so a drag that runs past the container edge keeps panning until release.
    const onMove = (e     ) => {
      // Two fingers is a pinch, and on touch the browser is already scrolling for us.
      if (!armed || pts.size > 1) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!panning && Math.hypot(dx, dy) < 4) return;   // still within click tolerance — leave the click alone
      panning = true; scroll.style.cursor = 'grabbing';
      scroll.scrollLeft = sl - dx; scroll.scrollTop = st - dy;
    };
    const onUp = () => { if (!armed) return; armed = false; if (panning) { panning = false; scroll.style.cursor = 'grab'; } };
    scroll.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    cleanups.push(() => {
      scroll.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    });
  }

  // Open fitted when the pane cannot show the diagram at its own size — which on a phone is always. Wide
  // panes are left alone: shrinking a diagram that already fits only makes it harder to read.
  if (width() && width() < baseW) fit();

  // Follow a rotation or a pane resize, unless the reader has since set their own zoom.
  let ro      = null;
  try {
    ro = new (globalThis       ).ResizeObserver(() => { if (!chosen) fit(); });
    ro.observe(scroll);
    cleanups.push(() => ro.disconnect());
  } catch { /* no ResizeObserver: the fit on open is what matters */ }

  const detach = () => cleanups.forEach(f => f());
  (detach       ).fit = () => { chosen = false; fit(); };
  /// Zoom from a button rather than a gesture: about the middle of the pane, which is what someone looking
  /// at the pane is looking at.
  (detach       ).zoomBy = (factor        ) => {
    const r = scroll.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    zoomAbout(r.left + r.width / 2, r.top + r.height / 2, factor);
  };
  return detach;
}

// --- Multi-PDU: per-tab instance selector ---
let _instancesCache      = null;
async function getInstances() {
  if (_instancesCache) return _instancesCache;
  const r = await api('/api/instances');
  _instancesCache = (r.body && r.body.ok) ? (r.body.instances || []) : [];
  return _instancesCache;
}
// A per-tab PDU instance picker. Returns { wrap, get } — append `wrap` to a toolbar; `get()` is the
// selected instance id. Stays hidden when only one instance is configured (single-PDU UX unchanged);
// then get() === '' so the backend falls back to the primary. `onChange` fires when the user switches.
function instanceSelector(onChange                       ) {
  const sel      = el('select');
  const wrap = el('label', { class: 'ld-inst', style: { display: 'none' } }, 'Instance ', sel);
  getInstances().then((list       ) => {
    if (list.length <= 1) return;
    list.forEach(i => sel.appendChild(el('option', { value: i.id, text: i.id + (i.primary ? ' (primary)' : '') })));
    sel.value = (list.find(i => i.primary) || list[0]).id;
    wrap.style.display = '';
  });
  sel.onchange = () => onChange && onChange(sel.value);
  return { wrap, get: () => sel.value || '' };
}
// Append `?instance=<id>` to a path when an instance is selected (empty -> primary, omit the param).
function withInstance(path        , instSel     ) {
  const v = instSel.get();
  return v ? path + (path.includes('?') ? '&' : '?') + 'instance=' + encodeURIComponent(v) : path;
}

// ── theme.ts ────────────────────────────────────────────────────
// Light / dark / follow-the-system theming.
//
// The GUI was dark-only, which is fine at 2am in a rack room and rough on a laptop in daylight. The
// stylesheet carries both palettes; this file only decides which one is in force, by setting
// `data-theme` on <html> (absent = follow the OS). index.html applies the stored choice inline before
// first paint so a reload never flashes the wrong palette.
//
// Anything that paints from the tokens (the flow SVG reads var(--accent) & friends) is repainted by
// listening for the `rpdu:theme` event.

const THEME_KEY = 'rpdu-theme';
const THEME_ORDER = ['system', 'dark', 'light'];
const THEME_GLYPH                         = { system: '◐', dark: '☾', light: '☀' };
const THEME_NAME                         = { system: 'Follow system', dark: 'Dark', light: 'Light' };

function readTheme()         {
  try { const v = localStorage.getItem(THEME_KEY); return THEME_ORDER.includes(v       ) ? (v          ) : 'system'; }
  catch { return 'system'; }
}

function applyTheme(theme        ) {
  const root      = document.documentElement;
  if (!root) return;
  // No attribute = the stylesheet's prefers-color-scheme branch decides.
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode: the choice just won't persist */ }
  window.dispatchEvent?.(new CustomEvent('rpdu:theme', { detail: { theme } }));
}

// Wire the app-bar button: click cycles system -> dark -> light, and the glyph says where you are.
function initTheme() {
  const btn      = document.getElementById('st-theme');
  let theme = readTheme();
  const paint = () => {
    if (!btn) return;
    btn.textContent = THEME_GLYPH[theme];
    btn.title = `Theme: ${THEME_NAME[theme]} — click to switch`;
  };
  applyTheme(theme);
  paint();
  if (btn) btn.onclick = () => {
    theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    applyTheme(theme);
    paint();
  };
}

// ── realtime.ts ─────────────────────────────────────────────────
// The browser end of the push channel (#281).
//
// One EventSource carries every feed. A caller says which feed it wants and gets a callback whenever
// the server pushes a new value; the connection is (re)opened with exactly the set of feeds currently
// wanted, so nothing is computed for a tab you aren't looking at.
//
// Why SSE rather than SignalR/WebSockets: the bundle is built with the Node binary alone (no npm), so a
// client library can't be pulled in — and EventSource is already in every browser, with reconnection,
// which is most of what a hub would have bought us. See Gui/GuiEventHub.cs for the server half.
//
// Every consumer must still work without this: `realtimeLive()` reports whether the stream is actually
// carrying data, and each section keeps its manual refresh (and its polling fallback) for when it isn't.

const rtHandlers = new Map                                  ();
const rtStateWatchers = new Set                         ();
let rtSource      = null;
let rtOpenKeys = '';
let rtReopen      = null;
let rtState = 'idle';   // idle | connecting | live | down

// Whether the push stream is currently delivering. Sections use it to decide between "stay live" and
// "poll on a timer" — never assume it's up.
function realtimeLive() { return rtState === 'live'; }

function onRealtimeState(fn                         ) {
  rtStateWatchers.add(fn);
  fn(rtState);
  return () => rtStateWatchers.delete(fn);
}

function setRtState(s        ) {
  if (s === rtState) return;
  rtState = s;
  rtStateWatchers.forEach(fn => { try { fn(s); } catch { /* a broken watcher must not stop the rest */ } });
}

// A restart we asked for, so the disconnection that follows can be explained instead of alarming.
//
// Switching version, forcing a re-pull or restarting a tier all take the bridge away for a few seconds.
// The stream drops, and the app bar went bright red "Offline — the live update stream dropped", which is
// true and useless: it reads as a fault at the exact moment the thing is working as instructed, and the
// page looks hung rather than busy. Anyone who has just clicked "Switch" knows why it went away; the UI
// should too.
//
// Deliberately time-boxed. If the bridge doesn't come back inside the window, the honest report is that
// it is down — an "Updating…" that never clears would hide a rollout that actually failed.
let restartUntil = 0;
let restartWhy = '';

function expectRestart(why        , seconds = 150) {
  restartWhy = why;
  restartUntil = Date.now() + seconds * 1000;
  // Re-render watchers now: the drop usually lands a moment later, but the pill should change the
  // instant the action is taken, not when the socket happens to notice.
  rtStateWatchers.forEach(fn => { try { fn(rtState); } catch { /* as above */ } });
}

/// The reason we're expecting a gap, or null once the window has passed.
function expectedRestart()                {
  if (Date.now() >= restartUntil) return null;
  return restartWhy;
}

/// Clear the window early — the stream is back, so the restart is over.
function restartFinished() {
  if (!restartUntil) return;
  restartUntil = 0; restartWhy = '';
}

// Subscribe to a feed key ("status", "board", "livedata:pdu2", "flow:realpower"). Returns an
// unsubscribe function; the connection re-opens with the reduced feed set when the last one goes.
function subscribeLive(key        , handler                     ) {
  if (typeof EventSource === 'undefined') return () => { };   // no push here; callers fall back to polling
  let set = rtHandlers.get(key);
  if (!set) { set = new Set(); rtHandlers.set(key, set); }
  set.add(handler);
  scheduleReopen();
  return () => {
    const s = rtHandlers.get(key);
    if (!s) return;
    s.delete(handler);
    if (!s.size) rtHandlers.delete(key);
    scheduleReopen();
  };
}

// Subscriptions arrive in bursts (a tab opening wires several at once), so coalesce them into one
// reconnect rather than tearing the stream down per handler.
function scheduleReopen() {
  clearTimeout(rtReopen);
  rtReopen = setTimeout(openStream, 30);
}

function openStream() {
  const keys = [...rtHandlers.keys()].sort();
  const wanted = keys.join(',');
  if (wanted === rtOpenKeys && rtSource) return;

  if (rtSource) { rtSource.close(); rtSource = null; }
  rtOpenKeys = wanted;
  if (!wanted) { setRtState('idle'); return; }

  setRtState('connecting');
  const src = new EventSource('/api/events?topics=' + encodeURIComponent(wanted));
  rtSource = src;

  src.onopen = () => { if (rtSource === src) setRtState('live'); };
  // EventSource retries on its own (the server sends `retry:`), so a drop is "down" until it re-opens.
  src.onerror = () => { if (rtSource === src) setRtState('down'); };

  for (const key of keys) {
    src.addEventListener(key, (ev     ) => {
      if (rtSource !== src) return;
      setRtState('live');
      let data     ;
      try { data = JSON.parse(ev.data); } catch { return; }
      const set = rtHandlers.get(key);
      if (!set) return;
      // Copy first: a handler may unsubscribe itself (a tab closing) while we're iterating.
      [...set].forEach(fn => { try { fn(data); } catch (e) { console.error('live handler failed for ' + key, e); } });
    });
  }
}

// Keep a section live for as long as it is on screen: subscribes on activation, drops on the way out,
// so nothing is computed for a page nobody is looking at. `keyOf()` is re-read on every check, so a
// section can change what it watches (a different PDU instance, a different metric) just by returning a
// different key and calling the returned sync().
function liveWhileActive(sec     , keyOf              , handler                     ) {
  let off      = null;
  let key = '';
  const sync = () => {
    const want = sec.classList.contains('active') ? keyOf() : '';
    if (want === key) return;
    key = want;
    if (off) { off(); off = null; }
    if (want) off = subscribeLive(want, handler);
  };
  // activate() announces every tab switch, so this needs no knowledge of the nav.
  window.addEventListener?.('rpdu:activate', sync);
  sync();
  return sync;
}

// ── dirty.ts ────────────────────────────────────────────────────
// Unsaved-change tracking.
//
// The form binds straight to `state.data`, so editing was invisible: the Save button looked identical
// whether you'd changed nothing or rewritten half the config, there was no way to see what a save would
// write, and no way back short of a reload. This module keeps a baseline of the config as loaded, diffs
// the live document against it, and lets the shell say exactly what is pending — per field, per page,
// and as a reviewable list.
//
// The diff runs over the *pruned* document (the same shape that gets POSTed), so the empty objects the
// renderer creates on the way past — ensure(obj, key, {}) — never register as edits.

let dirtyBaseline      = {};
let dirtyChanges        = [];
const dirtyWatchers = new Set                          ();
// path.join('.') -> the .field element, so an edited setting can be marked where it lives.
const dirtyFields = new Map             ();
// Paths whose values must never be shown in the review list.
const dirtySecrets = new Set        ();

function pathKey(path          ) { return path.join('.'); }

// Take the current document as "saved" — on load, and again after a successful save.
function setBaseline(data      ) {
  dirtyBaseline = JSON.parse(JSON.stringify(data ?? exportData()));
  refreshDirty();
}

// Register a rendered scalar field so it can be marked when its value differs from the baseline.
// Called by the form renderer; the map is cleared on every rebuild.
function registerField(path          , fieldEl     , secret          ) {
  dirtyFields.set(pathKey(path), fieldEl);
  if (secret) dirtySecrets.add(pathKey(path));
}
function clearFieldRegistry() { dirtyFields.clear(); dirtySecrets.clear(); }

function changes() { return dirtyChanges; }
function isDirty() { return dirtyChanges.length > 0; }

function onDirty(fn                          ) {
  dirtyWatchers.add(fn);
  fn(dirtyChanges);
  return () => dirtyWatchers.delete(fn);
}

// Recompute the diff and tell everyone. Called after any edit, and after load/save/discard.
function refreshDirty() {
  dirtyChanges = diffConfig(dirtyBaseline, exportData());

  const changed = new Set(dirtyChanges.map(c => pathKey(c.path)));
  dirtyFields.forEach((fieldEl, key) => {
    // A container's field is marked when anything under it changed, so a nested edit isn't invisible.
    const hit = changed.has(key) || [...changed].some(c => c.startsWith(key + '.'));
    if (fieldEl.classList) fieldEl.classList[hit ? 'add' : 'remove']('dirty');
  });

  dirtyWatchers.forEach(fn => { try { fn(dirtyChanges); } catch { /* one bad watcher must not block the rest */ } });
}

// Throw the edits away and go back to the last saved document. The caller rebuilds the form from it.
function discardChanges() {
  state.data = JSON.parse(JSON.stringify(dirtyBaseline));
  return state.data;
}

// Count of pending edits inside one top-level config section (drives the nav badges).
function changeCountFor(sectionKey        ) {
  return dirtyChanges.filter(c => c.path[0] === sectionKey).length;
}

// --- Diff ------------------------------------------------------------------------------------------

function isPlainObject(v     ) { return v != null && typeof v === 'object' && !Array.isArray(v); }

// Empty is empty however it's spelled: an absent key, null, '', {} and [] all mean "not set", and the
// renderer produces all of them. Without this, opening a tab would look like an edit.
function prune(v     )      {
  if (v === null || v === undefined || v === '') return undefined;
  if (Array.isArray(v)) {
    const arr = v.map(prune).filter(x => x !== undefined);
    return arr.length ? arr : undefined;
  }
  if (isPlainObject(v)) {
    const out      = {};
    for (const k of Object.keys(v)) { const p = prune(v[k]); if (p !== undefined) out[k] = p; }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
}

function same(a     , b     ) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }

function diffConfig(before     , after     ) {
  const out        = [];
  walk(prune(before), prune(after), [], out);
  return out;
}

function walk(a     , b     , path          , out       ) {
  if (same(a, b)) return;

  // Recurse while both sides are object-shaped (or absent), so a whole new section still reports one
  // row per setting rather than a wall of JSON.
  const objectish = (v     ) => v === undefined || isPlainObject(v);
  if ((isPlainObject(a) || isPlainObject(b)) && objectish(a) && objectish(b)) {
    const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
    for (const k of keys) walk((a || {})[k], (b || {})[k], [...path, k], out);
    return;
  }

  out.push({ path, key: pathKey(path), from: a, to: b, secret: dirtySecrets.has(pathKey(path)) });
}

// --- Display ---------------------------------------------------------------------------------------

// One change's value, as a short readable string. Secrets never show their contents.
function formatValue(v     , secret          ) {
  if (v === undefined || v === null) return '(not set)';
  if (secret) return '••••••';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'entry' : 'entries'}`;
  if (isPlainObject(v)) {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  }
  return String(v);
}

// ── tags.ts ─────────────────────────────────────────────────────
// The one place tags are spelled. Every tag in the document, a chip editor that completes from that list,
// and the rename/remove that keeps every reference in step.
//
// Tags are free-form on purpose (#342), but a filter that names a tag nothing carries silently sends
// nothing — and a typo in an exclude list is indistinguishable from a working one. So a tag is typed once,
// where it is defined, and chosen from a list everywhere it is referenced.

/// Where a tag can be defined: on a node, or on a rule that tags derived PDUs/outlets.
function tagHolders()                                                                                                 {
  const flow = (state.data || {}).EnergyFlow || {};
  const out        = [];
  (flow.Nodes || []).forEach((n     ) => out.push({
    list: () => n.Tags, set: (v          ) => { n.Tags = v.length ? v : undefined; },
    what: 'node', name: n.Label || n.Id || '(unnamed)',
  }));
  (flow.AutoTags || []).forEach((r     ) => out.push({
    list: () => r.Tags, set: (v          ) => { r.Tags = v; },
    what: 'rule', name: r.Match || '(empty match)',
  }));
  return out;
}

/// Where a tag is only referred to — the per-destination filters. Renaming has to reach these too, or a
/// rename quietly turns a working filter into one that matches nothing.
function tagReferences()                                                                                    {
  const d = state.data || {};
  const filters                  = [
    [(d.Prometheus || {}).NodeTags, 'Prometheus'],
    [(d.EmonCMS || {}).NodeTags, 'EmonCMS'],
    [(d.EnergyFlow || {}).MqttExportTags, 'MQTT export'],
    [((d.HomeAssistant || {}).EnergyDashboard || {}).NodeTags, 'HA Energy Dashboard'],
  ];
  const out        = [];
  filters.forEach(([f, where]) => {
    if (!f) return;
    out.push({ list: () => f.Include, set: (v          ) => { f.Include = v; }, where: where + ' include' });
    out.push({ list: () => f.Exclude, set: (v          ) => { f.Exclude = v; }, where: where + ' exclude' });
  });
  return out;
}

/// Every tag the document defines, in a stable order.
function knownTags()           {
  const seen = new Map                ();
  tagHolders().forEach(h => (h.list() || []).forEach(t => {
    const k = String(t || '').trim();
    if (k && !seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), k);
  }));
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/// How many things carry a tag, and what they are.
function tagUsage(tag        )                                              {
  const same = (t        ) => t.trim().toLowerCase() === tag.trim().toLowerCase();
  return {
    holders: tagHolders().filter(h => (h.list() || []).some(same)).map(h => `${h.what}: ${h.name}`),
    references: tagReferences().filter(r => (r.list() || []).some(same)).map(r => r.where),
  };
}

/// Rename a tag everywhere it appears — definitions and filters alike.
function renameTag(from        , to        ) {
  const same = (t        ) => t.trim().toLowerCase() === from.trim().toLowerCase();
  const swap = (v                      ) => {
    if (!v) return undefined;
    const out           = [];
    v.forEach(t => { const next = same(t) ? to.trim() : t; if (next && !out.some(x => x.toLowerCase() === next.toLowerCase())) out.push(next); });
    return out;
  };
  [...tagHolders(), ...tagReferences()].forEach((h     ) => {
    const current = h.list();
    if (!current || !current.some(same)) return;
    h.set(swap(current) || []);
  });
}

/// Remove a tag from everything that carries or names it.
function removeTag(tag        ) {
  const same = (t        ) => t.trim().toLowerCase() === tag.trim().toLowerCase();
  [...tagHolders(), ...tagReferences()].forEach((h     ) => {
    const current = h.list();
    if (!current || !current.some(same)) return;
    h.set(current.filter((t        ) => !same(t)));
  });
}

// The shared <datalist> every free-entry tag box completes from. One element, rebuilt whenever the set of
// tags changes, so a tag defined on the Nodes page is offered on every other page without a reload.
const DATALIST_ID = 'rpdu-known-tags';
function syncTagDatalist() {
  let dl      = document.getElementById(DATALIST_ID);
  if (!dl) {
    dl = el('datalist', { id: DATALIST_ID });
    document.body.appendChild(dl);
  }
  dl.innerHTML = '';
  knownTags().forEach(t => dl.appendChild(el('option', { value: t })));
  return dl;
}

                                          

/// A chip editor for a list of tags: the tags themselves, each removable, and one control to add another.
/// `arr` is edited in place, so the caller's config object is always current.
function tagInput(arr          , opts                  = {})              {
  const wrap = el('div', { class: 'tag-input' });
  const changed = () => { syncTagDatalist(); refreshDirty(); opts.onChange?.(); draw(); };

  const add = (raw        ) => {
    const t = (raw || '').trim();
    if (!t) return false;
    if (arr.some(x => String(x).trim().toLowerCase() === t.toLowerCase())) return true;   // already there
    arr.push(t);
    changed();
    return true;
  };

  const draw = () => {
    wrap.innerHTML = '';
    arr.forEach((t, i) => {
      const chip = el('span', { class: 'tag-chip' }, el('span', { text: String(t) }));
      const x = el('button', { class: 'tag-x', title: `Remove “${t}”`, text: '✕' });
      x.onclick = () => { arr.splice(i, 1); changed(); };
      chip.appendChild(x);
      // A filter naming a tag nothing defines matches nothing — worth seeing at a glance, not at 2am.
      if (opts.strict && !knownTags().some(k => k.toLowerCase() === String(t).trim().toLowerCase())) {
        chip.classList.add('tag-unknown');
        chip.title = `No node or rule carries “${t}”, so this line does nothing.`;
      }
      wrap.appendChild(chip);
    });

    const known = knownTags().filter(k => !arr.some(x => String(x).trim().toLowerCase() === k.toLowerCase()));

    if (opts.strict) {
      // Chosen, never typed: the whole point of the strict form.
      if (!known.length) {
        wrap.appendChild(el('span', {
          class: 'desc', style: { margin: '0' },
          text: arr.length ? 'every tag is already listed' : 'no tags defined yet — tag a node or add a rule on the Nodes page',
        }));
        return;
      }
      const sel = el('select', { class: 'tag-pick' })                     ;
      sel.appendChild(el('option', { value: '', text: '+ add tag…' }));
      known.forEach(k => sel.appendChild(el('option', { value: k, text: k })));
      sel.onchange = () => { if (sel.value) add(sel.value); };
      wrap.appendChild(sel);
      return;
    }

    // Free entry, completing from the tags that already exist — this is where a tag is born.
    syncTagDatalist();
    const input = el('input', {
      type: 'text', class: 'tag-new', placeholder: opts.placeholder || 'add tag…', list: DATALIST_ID,
    })                    ;
    input.onkeydown = (ev     ) => {
      if (ev.key !== 'Enter' && ev.key !== ',' && ev.key !== 'Tab') return;
      if (ev.key === 'Tab' && !input.value.trim()) return;   // let Tab move on when there's nothing to commit
      ev.preventDefault();
      if (add(input.value)) input.value = '';
      // Redrawing replaced this element, so put the cursor back where it was.
      (wrap.querySelector('.tag-new')                    )?.focus();
    };
    // Committing on blur too: typing a tag and clicking Save should not lose it.
    input.onblur = () => { if (input.value.trim()) { add(input.value); input.value = ''; } };
    wrap.appendChild(input);
  };

  draw();
  return wrap;
}

/// The "every tag, and what carries it" panel: rename or retire a tag across the whole config in one place.
function renderTagManager(rerender            )              {
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Tags in use', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', {
    class: 'desc',
    text: 'Every tag this configuration defines, and what carries it. Renaming one here rewrites it on every '
        + 'node, every rule and every destination filter at once — which is the only way a rename does not '
        + 'quietly turn a working filter into one that matches nothing.',
  }));

  const tags = knownTags();
  if (!tags.length) {
    box.appendChild(el('div', { class: 'desc', style: { marginTop: '8px' }, text: 'No tags yet. Add one to a node below, or to a rule for PDUs and outlets.' }));
    return box;
  }

  const t = el('table', { class: 'ld' });
  const head = el('tr');
  ['Tag', 'Carried by', 'Filtered on', ''].forEach(h => head.appendChild(el('th', { text: h })));
  t.appendChild(el('thead', {}, head));
  const tb = el('tbody');

  tags.forEach(tag => {
    const use = tagUsage(tag);
    const tr = el('tr');

    const name = el('input', { type: 'text', value: tag })                    ;
    name.onchange = () => {
      const next = name.value.trim();
      if (!next || next === tag) { name.value = tag; return; }
      renameTag(tag, next);
      refreshDirty(); rerender();
    };
    tr.appendChild(el('td', {}, name));

    tr.appendChild(el('td', {}, el('span', {
      class: 'desc', style: { margin: '0' },
      text: `${use.holders.length} node(s)/rule(s)`,
      title: use.holders.join('\n') || 'nothing',
    })));

    tr.appendChild(el('td', {}, el('span', {
      class: 'desc', style: { margin: '0' },
      text: use.references.length ? use.references.join(', ') : '—',
      title: use.references.length ? 'Destinations whose filter names this tag.' : 'No destination filter names this tag.',
    })));

    const del = btn('Remove', 'danger');
    del.title = 'Take this tag off everything that carries it, and out of every filter that names it.';
    del.onclick = () => { removeTag(tag); refreshDirty(); rerender(); };
    tr.appendChild(el('td', {}, del));
    tb.appendChild(tr);
  });

  t.appendChild(tb);
  box.appendChild(t);
  return box;
}

// ── flow-vocabulary.ts ──────────────────────────────────────────
// The shared vocabulary: metrics, node kinds, node modes, source types, Modbus shapes.
const METRICS                                       = [
  ['realpower', 'Power', 'W', ['W', 'kW', 'MW']],
  ['apparentpower', 'Apparent power', 'VA', ['VA', 'kVA']],
  ['energy', 'Energy', 'kWh', ['Wh', 'kWh', 'MWh']],
  ['current', 'Current', 'A', ['A', 'mA']],
  ['voltage', 'Voltage', 'V', ['mV', 'V', 'kV']],
  ['frequency', 'Frequency', 'Hz', ['Hz']],
  ['powerfactor', 'Power factor', '', ['']],
  ['soc', 'State of charge', '%', ['%', 'fraction']],
  ['percent', 'Percentage', '%', ['%', 'fraction']],
  ['temperature', 'Temperature', '°C', ['°C', 'K']],
];
// Which metrics the flow may sum from the leaves upward. Mirrors FlowUnits.IsAdditive.
const ADDITIVE_METRICS = new Set(['realpower', 'apparentpower', 'energy', 'energytoday', 'current']);
const isAdditiveMetric = (key         ) => ADDITIVE_METRICS.has(key || '');
const SOURCE_METRICS = METRICS.map(m => m[0]);
const metricMeta = (key         ) => METRICS.find(m => m[0] === key) || METRICS[0];
// Metrics the diagram can be drawn by but nothing can be *bound* to, so they stay out of METRICS.
const DERIVED_METRIC_LABELS                         = { energytoday: 'Energy today' };
const metricLabel = (key         ) => DERIVED_METRIC_LABELS[key || ''] || metricMeta(key)[1];
// The live-cache key a source reads under, given its direction.
const sourceMetricKey = (src     ) => { const m = src.Metric || 'realpower'; return src.Direction === 'in' ? m + '#in' : m; };

// What a virtual node represents — mirrors [AllowedValues] on EnergyFlowNode.Kind.
const NODE_KINDS                               = [
  ['node', 'Virtual node', SOURCE_METRICS],
  ['panel', 'Electrical panel', ['realpower', 'apparentpower', 'current', 'voltage', 'energy', 'powerfactor']],
  ['inverter', 'Inverter', SOURCE_METRICS],
  ['battery', 'Battery', ['realpower', 'energy', 'current', 'voltage', 'soc']],
  ['solar', 'Solar / PV', ['realpower', 'energy', 'current', 'voltage']],
  ['grid', 'Grid', SOURCE_METRICS],
  ['load', 'Load', ['realpower', 'apparentpower', 'energy', 'current', 'voltage', 'powerfactor']],
];
const kindMeta = (kind         ) => NODE_KINDS.find(k => k[0] === (kind || 'node')) || NODE_KINDS[0];

// Source binding types — mirrors [AllowedValues] on EnergyFlowSource.Type.
// The built-in source types, and their labels. A plugin's type is appended from the schema at render
// time (see sourceTypes()), so contributing one needs no edit here.
const BUILTIN_SOURCE_TYPES                     = [
  ['mqtt', 'MQTT topic'], ['modbus', 'Modbus TCP'], ['derived', 'Calculated'],
];

/// Every source type on offer: the built-ins, plus whatever the server says a plugin contributed.
///
/// Read from the schema rather than kept in step by hand — the server already fills the Type field's
/// choices with the plugin types it loaded, and duplicating that list here is how the dropdown ends up
/// missing a type the backend accepts.
function sourceTypes(schema       )                     {
  const known = new Map                (BUILTIN_SOURCE_TYPES);
  // EnergyFlow -> Nodes -> Sources -> Type carries the enum the server built.
  const find = (nodes       )      => {
    for (const n of nodes || []) {
      if (n.key === 'Type' && Array.isArray(n.enumValues)) return n;
      const deeper = find(n.properties || (n.valueSchema ? [n.valueSchema] : []));
      if (deeper) return deeper;
    }
    return null;
  };
  const flow = (schema || []).find((n     ) => n.key === 'EnergyFlow');
  const typeNode = flow ? find(flow.properties || []) : null;
  (typeNode?.enumValues || []).forEach((v        ) => {
    if (v && !known.has(v)) known.set(v, v);
  });
  return [...known.entries()]                      ;
}

// Metrics whose sign carries direction, so inverting one is meaningful (export vs import, charge vs discharge).
const SIGNED_METRICS = ['realpower', 'apparentpower', 'current'];
// Metrics where an in/out direction means anything at all.
const DIRECTIONAL_METRICS = [...SIGNED_METRICS, 'energy'];

// Why a "Current" cell can sit empty — the thing every new binding trips over.
const LIVE_HINT = 'Live value from the running ingest. It appears when the source next reports: an MQTT binding when the publisher sends, a Modbus one on the worker’s next poll — and a new or edited binding is not read at all until you Save. Nothing here is missing because the page needs reloading.';
const MODBUS_REGISTER_TYPES = ['holding', 'input'];
const MODBUS_DATATYPES = ['uint16', 'int16', 'uint32', 'int32', 'float32'];
const MODBUS_WORDORDERS = ['big', 'little'];

// How an unmeasured node is valued — mirrors [AllowedValues] on EnergyFlowNode.Mode.
const NODE_MODES                             = [
  ['none', 'None (nothing inferred)', 'Never inferred — contributes nothing unless it has a real value or children, so an unmeasured node simply drops out instead of showing a fabricated figure. The default for a new node.'],
  ['auto', 'Auto (aggregate)', 'Sums its children. As a feeder it carries a node’s unmet demand only when it is the single path into it — where conservation leaves no other answer. It never splits a load between several unmeasured feeders: that would be inventing a number. Mark one feeder “residual” to say where the remainder actually comes from.'],
  ['static', 'Static (fixed value)', 'A fixed leaf valued at the number you enter (still superseded by a bound live source). Reveals the Fixed value field.'],
  ['residual', 'Residual (untracked feeder)', 'The designated absorber on the feeder side: carries the demand still needed after every measured feeder has supplied its part. This is how you tell the diagram where unaccounted power comes from — without it, competing unmeasured feeders all read “no data”.'],
  ['untracked', 'Untracked (child of a measured parent)', 'Place under a parent that has a measured total (a bound source or fixed value): shows the slice of that total its tracked siblings don’t account for. Contributes nothing if the parent has no measured total.'],
];

// ── source-editors.ts ───────────────────────────────────────────
// Which editor a source binding gets, keyed by its type.
//
// A binding's Source and Details columns are type-specific: MQTT wants a topic picker and a JSON field,
// Modbus wants a connection and a register spec. Those two are built into this bundle because they are
// genuinely bespoke — a topic browser and a register scanner are not a form.
//
// Everything else falls back to the generic editor, which reads and writes the binding's open `Settings`
// bag. That is what lets a plugin contribute a source type without shipping any TypeScript: it declares
// the type on the server, the node editor offers it in the dropdown, and its settings are editable here
// as ordinary key/value rows. A plugin that later wants a bespoke editor registers one; nothing else has
// to change.

/// Renders the Source and Details cells for one binding. Returns the two cells, in order.

const editors = new Map                      ();

/// Register a bespoke editor for a source type. Built-ins call this; a future plugin editor would too.
function registerSourceEditor(type        , editor              ) {
  editors.set(type.toLowerCase(), editor);
}

/// The editor for a type, or null when it should use the generic one.
function sourceEditorFor(type                    )                      {
  return editors.get((type || 'mqtt').toLowerCase()) || null;
}

/// The generic editor: the binding's own Settings, as editable rows.
///
/// Deliberately shows what is there rather than guessing what should be — the server knows a plugin's
/// source type exists but nothing describes its fields, and inventing a form for fields nobody declared
/// would be worse than an honest key/value list.
function genericSourceEditor(src     , onChange            )             {
  if (!src.Settings) src.Settings = {};

  const rows = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } });

  const draw = () => {
    rows.innerHTML = '';
    Object.keys(src.Settings).forEach(key => {
      const row = el('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } });
      const k = el('input', { type: 'text', value: key, style: { width: '110px' } })                    ;
      const v = el('input', { type: 'text', value: String(src.Settings[key] ?? ''), style: { width: '150px' } })                    ;
      k.onchange = () => {
        if (!k.value.trim() || k.value === key) { k.value = key; return; }
        src.Settings[k.value.trim()] = src.Settings[key];
        delete src.Settings[key];
        onChange(); draw();
      };
      v.onchange = () => { src.Settings[key] = v.value; onChange(); };
      const del = btn('✕', 'danger');
      del.title = `Remove '${key}'`;
      del.onclick = () => { delete src.Settings[key]; onChange(); draw(); };
      row.append(k, v, del);
      rows.appendChild(row);
    });

    const add = btn('+ setting');
    add.onclick = () => {
      let name = 'setting', n = 1;
      while (name in src.Settings) name = `setting${++n}`;
      src.Settings[name] = '';
      onChange(); draw();
    };
    rows.appendChild(add);
  };
  draw();

  return [
    el('td', {}, el('span', { class: 'desc', style: { margin: '0' }, text: 'plugin source' })),
    el('td', {}, rows),
  ];
}

// ── energy.ts ───────────────────────────────────────────────────
// The energy arithmetic shared by the Energy Overview and Trends: what the home took.

                                                    

/// What the home actually took over the window.
function homeEnergy(parts             )                {
  if (parts.load !== undefined) return parts.load;

  const present = ([parts.solar, parts.battery, parts.grid]                                 )
    .filter(v => v !== undefined)                     ;
  if (!present.length) return null;
  if (present.some(v => v == null)) return null;
  return present.reduce((a, b) => a  + b , 0);
}

/// The share of the home's energy that did not come from the grid, 0–100, or null when it cannot be said.
function selfSufficiencyPct(home               , gridImport               )                {
  if (home == null || gridImport == null || home <= 0) return null;
  const covered = home - Math.max(0, gridImport);
  return Math.max(0, Math.min(100, (covered / home) * 100));
}

/// How much of the home's energy solar and battery covered, in the same units.
function coveredEnergy(home               , gridImport               )                {
  if (home == null || gridImport == null) return null;
  return Math.max(0, home - Math.max(0, gridImport));
}

/// Add up a set of readings, treating "no reading" as absent rather than zero.
function sumKnown(values                               )                {
  const known = values.filter(v => v != null)            ;
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

// ── history-control.ts ──────────────────────────────────────────
// The "show a past moment" control, its query (`at`, `span`) and the sentence describing what came back.

/// The periods people actually ask for. One click each, rather than a date, a time and a span to assemble.

const PERIODS                        = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'],
  ['month', 'This month'], ['year', 'This year'],
];

/// Which day a period ends on, and how many days it covers — in the reader's own calendar, because that is
/// the calendar the words "this month" were said in.
function periodWindow(key           , now       = new Date())                                {
  const iso = (d      ) => d.toLocaleDateString('en-CA');
  if (key === 'yesterday') {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - 1);
    return { day: iso(d), days: 1 };
  }
  if (key === 'week') return { day: iso(now), days: now.getDay() + 1 };
  if (key === 'month') return { day: iso(now), days: now.getDate() };
  if (key === 'year') {
    const jan1 = new Date(now.getFullYear(), 0, 1);
    // Whole days between two local midnights: the difference in ms divided by a day is off by an hour
    // twice a year, and rounding puts it back.
    return { day: iso(now), days: Math.round((now.setHours(0, 0, 0, 0) - jan1.getTime()) / 86_400_000) + 1 };
  }
  return { day: iso(now), days: 1 };
}

/// A row of one-click periods, with the one being shown marked.
function periodRow(onPick                          )                                                              {
  const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px', margin: '0 0 8px' } });
  row.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Period:' }));
  const buttons = PERIODS.map(([key, label]) => {
    const b = btn(label);
    b.dataset.period = key;
    b.onclick = () => onPick(key);
    row.appendChild(b);
    return b;
  });
  return {
    row,
    mark: (key) => buttons.forEach(b => b.classList[b.dataset.period === key ? 'add' : 'remove']('primary')),
  };
}

/// The `at`/`span` part of a flow query, and the sentence that says what came back.
function historyQuery(hist                                          )         {
  const at = hist.at();
  if (!at) return '';
  const span = hist.span();
  return '&at=' + encodeURIComponent(at) + (span > 1 ? '&span=' + span : '');
}

function historyNote(body     )         {
  if (!body || !body.historical) return '';
  const when = new Date(body.at).toLocaleString();
  const days = Number(body.spanDays) || 1;
  const what = days > 1 ? `${days} days to ${new Date(body.at).toLocaleDateString()}` : when;
  // A window with days missing from it is not that window.
  const short = (body.incomplete || [])                                    ;
  const gap = short.length
    ? ` · incomplete: ${short.slice(0, 4).map(x => `${x.node} ${x.days}/${days}d`).join(', ')}${short.length > 4 ? `, +${short.length - 4} more` : ''}`
    : '';
  return `showing ${what} from ${body.source}${gap}`;
}

/// Which part of the moment was just changed, so the caller can tell a whole day from an instant.

/// A "show this moment instead of now" control (#372). Returns the ISO instant to request, or '' for live.
function historyControl(onChange                             )

  {
  const row = el('div', { class: 'ld-toolbar history-bar', style: { flexWrap: 'wrap', gap: '8px', margin: '0 0 8px' } });
  // Separate date and time inputs, not a datetime-local: that control reports '' until both halves are filled.
  const input = el('input', { type: 'date' })                    ;
  const timeIn = el('input', { type: 'time', step: '1' })                    ;
  const prev = btn('◀');
  const next = btn('▶');
  const live = btn('Live', 'primary');
  // Which of the two things you are looking at, said plainly and in the same place every time.
  const badge = el('span', { class: 'pill good', text: 'LIVE' });
  const note = el('span', { class: 'desc', style: { margin: '0' } });

  live.title = 'Back to the current reading';

  const today = () => new Date().toLocaleDateString('en-CA');   // yyyy-mm-dd in local time
  const spanDays = () => Math.max(1, Number(spanSel.value) || 1);

  // The arrows move by whatever is being shown: a day at a time on a single day.
  const step = (dir        ) => {
    const from = input.value || today();
    const d = new Date(from + 'T12:00:00');   // midday, so a DST shift cannot land on the previous day
    d.setDate(d.getDate() + dir * spanDays());
    const iso = d.toLocaleDateString('en-CA');
    input.value = iso > today() ? today() : iso;   // no future days: there is nothing recorded there
    onChange('day');
  };

  input.onchange = () => onChange('day');
  timeIn.onchange = () => onChange('time');
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  const stepLabel = () => { const n = spanDays(); return n === 1 ? 'day' : n === 7 ? 'week' : `${n} days`; };
  live.onclick = () => { input.value = ''; timeIn.value = ''; spanSel.value = '1'; syncSpan(); note.textContent = ''; onChange('live'); };

  // The picker exists only if there is a backend to read from.
  const historyOn = () => !!((state.data && state.data.History) || {}).Enabled;
  const syncEnabled = () => {
    const on = historyOn();
    row.classList[on ? 'remove' : 'add']('is-hidden');
    // A day still selected when the feature is switched off has to stop being requested.
    if (!on && input.value) { input.value = ''; timeIn.value = ''; spanSel.value = '1'; note.textContent = ''; onChange('live'); }
  };

  // One control rather than five: the arrows and inputs share a border and only the outer corners round.
  const group = el('div', { class: 'input-group' }, prev, input, timeIn, next);

  // How much of the past to add up.
  const spanSel = el('select', { title: 'Add up the daily totals over this many days, ending on the chosen day.' })                     ;
  [['1', 'that day'], ['7', '7 days to it'], ['30', '30 days to it']]
    .forEach(([v, t]) => spanSel.appendChild(el('option', { value: v, text: t })));
  spanSel.onchange = () => { syncSpan(); onChange('span'); };

  // A time within the day says nothing about a week of them, so the two cannot both be set.
  const syncSpan = () => {
    prev.title = 'Previous ' + stepLabel();
    next.title = 'Next ' + stepLabel();
    const many = spanDays() > 1;
    timeIn.disabled = many;
    if (many) timeIn.value = '';
    timeIn.title = many
      ? 'Not used over a span of days — each day is counted whole.'
      : 'Optional. Leave blank for the end of the day — the day’s complete totals.';
  };

  row.append(badge, el('span', { class: 'desc', style: { margin: '0' }, text: 'At:' }), group,
    el('span', { class: 'desc', style: { margin: '0' }, text: 'covering' }), spanSel, live, note);
  syncSpan();
  syncEnabled();
  window.addEventListener?.('rpdu:activate', syncEnabled);
  return {
    row,
    /// Show a period: the day it ends on, and how many days it covers. A span the fixed list does not offer
    /// (this month is however many days into the month it is) is added to it, so the control still reads as
    /// one setting rather than going blank.
    set: (day        , days        ) => {
      input.value = day;
      timeIn.value = '';
      const want = String(Math.max(1, days));
      if (!Array.from(spanSel.children).some((o     ) => o.value === want))
        spanSel.appendChild(el('option', { value: want, text: `${want} days to it` }));
      spanSel.value = want;
      syncSpan();
    },
    /// The instant to ask for.
    at: () => {
      if (!historyOn() || !input.value) return '';
      const when = new Date(`${input.value}T${timeIn.value || '23:59:59'}`);
      const now = new Date();
      return (when > now ? now : when).toISOString();
    },
    day: () => (historyOn() ? input.value : ''),
    time: () => timeIn.value,
    /// Days to add up, ending on the chosen day. 1 is the plain "that moment" view.
    span: () => (historyOn() && input.value ? spanDays() : 1),
    setNote: (t        ) => {
      note.textContent = t;
      // The badge follows what was actually rendered.
      const past = !!t;
      badge.className = 'pill ' + (past ? 'warn' : 'good');
      badge.textContent = past ? 'HISTORICAL' : 'LIVE';
      badge.title = past ? t : 'These are the latest readings.';
    },
  };
}

// The tag selected on the diagram, kept across redraws: the Sankey repaints on every live push.

// ── charts.ts ───────────────────────────────────────────────────
// Day-by-day bar charts: axis, empty days, signed values, hover card.

// The kinds worth a colour of their own; anything else shares the neutral run.
const KIND_COLOR                         = {
  solar: 'var(--warn, #d08700)',
  battery: 'var(--good, #46c46a)',
  grid: 'var(--accent, #4f8cff)',
  load: '#b06fd0',
  outlet: '#7f8ea3',
  pdu: '#5c7fa3',
  panel: '#c98b3f',
  inverter: '#3fb0a8',
};
const colorFor = (kind        , i        ) =>
  KIND_COLOR[kind] || ['#4f8cff', '#46c46a', '#d08700', '#b06fd0', '#3fb0a8', '#c05c5c'][i % 6];

/// One drawable series: a name, a colour, and one value per day — null where there is no reading.

const SVG = 'http://www.w3.org/2000/svg';
const svgTag = (tag        , attrs                     ) => {
  const e = document.createElementNS(SVG, tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
  return e;
};

/// The hover card. One card for the page, moved and refilled — a card per chart would leak one per redraw.
let card      = null;
function hoverCard()      {
  if (!card) {
    card = el('div', { class: 'node-card trend-card' });
    document.body.appendChild(card);
  }
  return card;
}
function hideCard() { if (card) card.classList.remove('show'); }

// A day-by-day bar chart. `stacked` adds the day's series into one bar, otherwise they sit side by side; a
// day where every series is null is drawn as an empty slot and reported, never as a bar of zero.
function barChart(opts

                                

                                           

 )                             {
  const { days, lines, units, stacked } = opts;
  const has = (d        ) => lines.some(l => l.values[d] != null);
  const dayTotal = (d        ) => lines.reduce((s, l) => s + (l.values[d] ?? 0), 0);

  // Charge and export are negative quantities — energy leaving in the other direction.
  const posOf = (d        ) => lines.reduce((s, l) => s + Math.max(0, l.values[d] ?? 0), 0);
  const negOf = (d        ) => lines.reduce((s, l) => s + Math.min(0, l.values[d] ?? 0), 0);
  const peak = opts.max ?? Math.max(
    stacked ? Math.max(...days.map((_, d) => (has(d) ? posOf(d) : 0)), 0)
      : Math.max(...lines.flatMap(l => l.values.map(v => v ?? 0)), 0),
    0);
  const trough = Math.min(
    stacked ? Math.min(...days.map((_, d) => (has(d) ? negOf(d) : 0)), 0)
      : Math.min(...lines.flatMap(l => l.values.map(v => v ?? 0)), 0),
    0);
  const span = (peak - trough) || 1;

  // Fitted charts take the whole pane: at a fixed 26px a bar, thirty days was a 780px chart marooned in a
  // 2,200px page. Bars stretch to fill it, but only so far — a seven-bar week at full width would be slabs.
  const W = opts.fitTo && opts.fitTo > 0 ? Math.max(360, opts.fitTo) : Math.max(720, days.length * 26);
  const H = opts.height && opts.height > 0 ? opts.height : 240;
  const padL = 56, padB = 40, padT = 12, padR = 8;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / days.length;
  const x = (d        ) => padL + slot * d;
  const barW = Math.min(Math.max(3, slot * 0.72), 48);
  const y = (v        ) => padT + plotH - ((v - trough) / span) * plotH;
  const zeroY = y(0);

  const svg = svgTag('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'trend-chart' });

  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = trough + (span / ticks) * i, yy = y(v);
    svg.appendChild(svgTag('line', { x1: padL, y1: yy, x2: W - padR, y2: yy, stroke: 'var(--line)', 'stroke-width': 1 }));
    const t = svgTag('text', { x: padL - 6, y: yy + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 });
    t.textContent = formatNum(Number(v.toFixed(peak < 10 ? 2 : 0))) + (opts.pct ? '%' : '');
    svg.appendChild(t);
  }

  let gaps = 0;
  days.forEach((day, d) => {
    if (!has(d)) {
      gaps++;
      const g = svgTag('rect', {
        x: x(d) + (slot - barW) / 2, y: padT, width: barW, height: plotH,
        fill: 'var(--line)', opacity: 0.25, class: 'trend-gap',
      });
      const title = document.createElementNS(SVG, 'title');
      title.textContent = `${day} — no reading from the history backend`;
      g.appendChild(title);
      svg.appendChild(g);
    } else {
      // The period still in progress is drawn faded: it is a real reading of an unfinished day.
      const partial = day === opts.partial;
      const paint = (attrs                     ) => {
        const r = svgTag('rect', partial ? { ...attrs, opacity: 0.55 } : attrs);
        if (partial) {
          const t = document.createElementNS(SVG, 'title');
          t.textContent = `${day} — still in progress, not a full day`;
          r.appendChild(t);
        }
        svg.appendChild(r);
      };
      if (stacked) {
        // Each sign stacks away from zero on its own side.
        let up = 0, down = 0;
        lines.forEach(l => {
          const v = l.values[d];
          if (v == null || v === 0) return;
          const from = v > 0 ? up : down;
          const to = from + v;
          paint({
            x: x(d) + (slot - barW) / 2, y: Math.min(y(from), y(to)), width: barW,
            height: Math.max(1, Math.abs(y(to) - y(from))), fill: l.color,
          });
          if (v > 0) up = to; else down = to;
        });
      } else {
        const each = barW / lines.length;
        lines.forEach((l, i) => {
          const v = l.values[d];
          if (v == null || v === 0) return;
          paint({
            x: x(d) + (slot - barW) / 2 + each * i, y: Math.min(zeroY, y(v)),
            width: Math.max(1, each - 1), height: Math.max(1, Math.abs(y(v) - zeroY)), fill: l.color,
          });
        });
      }
    }

    const every = Math.ceil(days.length / 12);
    if (d % every === 0) {
      const t = svgTag('text', { x: x(d) + slot / 2, y: H - padB + 16, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11 });
      // A day key is charted without its year; a clock label (an intra-day moment) is already what to show.
      t.textContent = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(5) : day;
      svg.appendChild(t);
    }
  });

  // The axis sits at zero, not at the bottom, so which side of it a bar is on is the point.
  svg.appendChild(svgTag('line', { x1: padL, y1: zeroY, x2: W - padR, y2: zeroY, stroke: 'var(--muted)', 'stroke-width': 1 }));

  // A full-height hit area per day, over the bars.
  days.forEach((day, d) => {
    const hit = svgTag('rect', {
      x: x(d), y: padT, width: slot, height: plotH, fill: 'transparent', class: 'trend-hit', 'data-day': day,
    });
    const show = (ev     ) => {
      const c = hoverCard();
      c.innerHTML = '';
      c.appendChild(el('div', { class: 'nh-title', text: day + (day === opts.partial ? ' · so far' : '') }));
      if (day === opts.partial)
        c.appendChild(el('div', { class: 'desc', style: { margin: '0 0 2px' }, text: 'still in progress — not a full day' }));
      if (!has(d)) {
        c.appendChild(el('div', { class: 'nh-warn', text: 'no reading from the history backend' }));
      } else {
        lines.forEach(l => {
          const v = l.values[d];
          c.appendChild(el('div', { class: 'nh-row' },
            el('span', { class: 'nh-name' },
              el('span', { class: 'trend-swatch', style: { background: l.color } }),
              l.label),
            el('span', { class: 'nh-num', text: v == null ? '—' : `${formatNum(Number(v.toFixed(2)))}${opts.pct ? '%' : ' ' + units}` })));
        });
        if (stacked && lines.length > 1)
          c.appendChild(el('div', { class: 'nh-row nh-total' },
            el('span', { class: 'nh-name', text: 'Total' }),
            el('span', { class: 'nh-num', text: `${formatNum(Number(dayTotal(d).toFixed(2)))} ${units}` })));
      }
      c.classList.add('show');
      const px = (ev && ev.clientX) || 0, py = (ev && ev.clientY) || 0;
      c.style.left = Math.max(8, px + 14) + 'px';
      c.style.top = Math.max(8, py + 14) + 'px';
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('mousemove', show);
    hit.addEventListener('mouseleave', hideCard);
    svg.appendChild(hit);
  });

  return { svg, gaps };
}

// Gradient ids have to be unique in a document: two sparklines sharing one would paint the second in the
// first's colour.
let sparkSeq = 0;

/// A tile's trend: one series, no axes, no legend — the tile's own label names it.
///
/// It answers "and what has it been doing?", which a single instantaneous figure cannot. Deliberately not a
/// chart in the full sense: axes and a legend on a 44px-tall plot cost more room than the shape is worth,
/// and the number it sits under is the headline.
///
/// Gaps stay gaps. A reading the backend does not have is a break in the line, never a drop to zero joined
/// up to its neighbours — the same rule the rest of the flow follows, and the reason the line is drawn as
/// runs of consecutive points rather than one path.
function sparkline(opts

 )      {
  const { values, color, units } = opts;
  const w = opts.width ?? 132, h = opts.height ?? 40;
  const pad = 3;                                   // room for the 2px stroke and the hover dot's ring

  const known = values.filter((v)              => v != null && Number.isFinite(v));
  if (known.length < 2) {
    // One point is not a trend, and none is not a zero. Say so rather than draw a flat line through nothing.
    const empty = el('div', { class: 'spark spark-empty', text: known.length ? '—' : '' });
    empty.title = known.length ? 'Only one reading in this window' : 'No readings stored for this window';
    return empty;
  }

  const lo = Math.min(...known, 0), hi = Math.max(...known);
  const span = hi - lo || 1;
  const x = (i        ) => pad + (values.length === 1 ? 0 : (i * (w - pad * 2)) / (values.length - 1));
  const y = (v        ) => h - pad - ((v - lo) / span) * (h - pad * 2);

  const svg = svgTag('svg', {
    viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'spark',
    preserveAspectRatio: 'none', role: 'img',
    'aria-label': `Trend: ${formatNum(known[0])} to ${formatNum(known[known.length - 1])} ${units}`,
  });

  // The area fades from the line down to nothing. A flat wash reads as a solid block of colour and buries
  // the shape it is meant to sit under; a fade keeps the line the thing you look at.
  const fillId = 'sparkfill-' + (++sparkSeq);
  const defs = svgTag('defs', {});
  const grad = svgTag('linearGradient', { id: fillId, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.appendChild(svgTag('stop', { offset: '0', 'stop-color': color, 'stop-opacity': '0.38' }));
  grad.appendChild(svgTag('stop', { offset: '1', 'stop-color': color, 'stop-opacity': '0.02' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  // A baseline, so a line that runs near the floor is seen to be near the floor.
  svg.appendChild(svgTag('line', {
    x1: pad, y1: (h - pad).toFixed(1), x2: w - pad, y2: (h - pad).toFixed(1),
    stroke: 'var(--line)', 'stroke-width': 1, 'stroke-opacity': '0.7',
  }));

  // Consecutive runs, so a gap in the data is a gap in the line.
  const runs                               = [];
  let run                             = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { if (run.length) runs.push(run); run = []; return; }
    run.push({ i, v: v           });
  });
  if (run.length) runs.push(run);

  for (const r of runs) {
    if (r.length === 1) {
      // A lone reading between gaps is a dot: a segment needs two points, and inventing the second one
      // would be drawing a trend nobody measured.
      svg.appendChild(svgTag('circle', { cx: x(r[0].i), cy: y(r[0].v), r: 1.6, fill: color, class: 'spark-dot' }));
      continue;
    }
    const line = r.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' L');
    // The area first, so the line sits on top of it.
    svg.appendChild(svgTag('path', {
      d: `M${line} L${x(r[r.length - 1].i).toFixed(1)},${h - pad} L${x(r[0].i).toFixed(1)},${h - pad} Z`,
      fill: `url(#${fillId})`, stroke: 'none',
    }));
    svg.appendChild(svgTag('path', {
      d: `M${line}`, fill: 'none', stroke: color, 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'spark-line',
    }));
  }

  // The latest reading, marked: it is the one the tile's big number is showing.
  const last = known[known.length - 1];
  const lastAt = values.length - 1 - [...values].reverse().findIndex(v => v != null && Number.isFinite(v          ));
  svg.appendChild(svgTag('circle', {
    cx: x(lastAt), cy: y(last), r: 2.4, fill: color, stroke: 'var(--panel2)', 'stroke-width': '1.5',
  }));

  // The hover layer. The plot is 40px tall, so the target is the whole strip and the nearest point wins —
  // asking someone to hit a 2px line with a mouse is asking them not to bother.
  const hit = svgTag('rect', { x: 0, y: 0, width: w, height: h, fill: 'transparent', class: 'spark-hit' });
  svg.appendChild(hit);
  hit.addEventListener('mousemove', (ev     ) => {
    const box = svg.getBoundingClientRect?.() ?? { left: 0, width: w };
    const frac = box.width ? (ev.clientX - box.left) / box.width : 0;
    const i = Math.max(0, Math.min(values.length - 1, Math.round(frac * (values.length - 1))));
    const v = values[i];
    const c = hoverCard();
    c.innerHTML = '';
    c.appendChild(el('div', { class: 'nc-title', text: opts.at ? opts.at(i) : `Point ${i + 1}` }));
    c.appendChild(el('div', { text: v == null ? 'no reading' : `${formatNum(v)} ${units}` }));
    c.classList.add('show');
    c.style.left = `${ev.clientX + 12}px`;
    c.style.top = `${ev.clientY + 12}px`;
  });
  hit.addEventListener('mouseleave', () => hideCard());

  return svg;
}

// ── energy-diagram.ts ───────────────────────────────────────────
// The animated energy diagram: a hub with an arm per source, dots travelling the way the power is going.
// Shared, because the home page and the Energy page must not draw the same system two different ways.

// A central hub with Solar (top), Grid (left), Battery (right), Home (bottom).
const HUB = { x: 220, y: 150 };
const NODEPOS                                           = {
  solar: { x: 220, y: 46 }, grid: { x: 66, y: 150 }, battery: { x: 374, y: 150 }, home: { x: 220, y: 254 },
};

/// Draw the arms into `target`, replacing whatever was there. `onOpen`, when given, makes a node clickable.
function drawEnergyFlow(target     , arms           , onOpen                                     ) {
    target.innerHTML = '';
    // Frame only the arms that exist.
    const ys = arms.map(a => NODEPOS[a.key].y);
    // Below a node sits its label (+42) and value (+57); above it, the ring (r 26).
    const y0 = Math.min(HUB.y, ...ys) - 40, y1 = Math.max(HUB.y, ...ys) + 70;
    const svg = svgEl('svg', {
      viewBox: `12 ${y0} 416 ${y1 - y0}`,
      width: '100%', preserveAspectRatio: 'xMidYMid meet', class: 'energy-flow-svg',
    });
    const lines = svgEl('g', {}); const dots = svgEl('g', {}); const nodes = svgEl('g', {});
    svg.append(lines, dots, nodes);

    arms.forEach(a => {
      const p = NODEPOS[a.key];
      // Base connector (always visible, dim) between the node and the hub.
      lines.appendChild(svgEl('line', { x1: p.x, y1: p.y, x2: HUB.x, y2: HUB.y, class: 'energy-arm' }));

      // Direction: >0 supplies the hub (node→hub); <0 draws from it (hub→node). Home only ever consumes.
      const toHub = a.key === 'home' ? false : (a.flow ?? 0) >= 0;
      const mag = Math.abs(a.flow ?? 0);
      if (a.flow != null && mag > 1) {
        const [sx, sy, ex, ey] = toHub ? [p.x, p.y, HUB.x, HUB.y] : [HUB.x, HUB.y, p.x, p.y];
        const kw = mag / 1000;
        const dur = Math.max(2.2, 6 - Math.min(3.5, kw * 0.9));       // more power → faster
        const count = Math.min(5, Math.max(2, Math.round(1 + kw)));    // …and denser
        for (let i = 0; i < count; i++) {
          const dot = svgEl('circle', { r: 3.4, fill: a.color, class: 'energy-dot' });
          dot.appendChild(svgEl('animateMotion', { dur: `${dur}s`, repeatCount: 'indefinite', begin: `-${(dur / count) * i}s`, path: `M${sx},${sy} L${ex},${ey}` }));
          dots.appendChild(dot);
        }
      }

      // Node: a coloured ring with its icon, a label and the live figure.
      const g = svgEl('g', { class: 'energy-node' + (a.flow != null && mag > 1 ? ' live' : '') });
      g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 26, class: 'energy-node-ring', style: `stroke:${a.color}` }));
      const icon = svgEl('text', { x: p.x, y: p.y + 1, class: 'energy-node-icon' }); icon.textContent = a.icon; g.appendChild(icon);
      const lab = svgEl('text', { x: p.x, y: p.y + 42, class: 'energy-node-label' }); lab.textContent = a.label; g.appendChild(lab);
      const val = svgEl('text', { x: p.x, y: p.y + 57, class: 'energy-node-val' }); val.textContent = a.text; g.appendChild(val);
      // Click through to this node's own day. The whole group is the target — asking anyone to hit the
      // 26px ring exactly is asking them not to bother.
      if (onOpen && a.ids && a.ids.length) onOpen(a, g);
      nodes.appendChild(g);
    });

    // A small hub dot where the arms meet.
    nodes.appendChild(svgEl('circle', { cx: HUB.x, cy: HUB.y, r: 5, class: 'energy-hub' }));
    target.appendChild(svg);
  }

// ── flow-banners.ts ─────────────────────────────────────────────
// The banners above the flow chart: sources the bridge is withholding.

/// The banner naming every binding the bridge is dropping, and why.
function withheldBanner(sources       )              {
  const box = el('div', { class: 'flow-contradiction' });
  box.appendChild(el('strong', {
    text: sources.length === 1
      ? '1 source is being withheld'
      : `${sources.length} sources are being withheld`,
  }));
  box.appendChild(el('div', {
    class: 'desc',
    style: { margin: '2px 0 6px' },
    text: 'These bindings are reporting, but what they report can be shown to be wrong, so it is not being '
        + 'used. The nodes below show no data for them rather than a figure that is not what it claims.',
  }));
  sources.forEach((w     ) => {
    const row = el('div', { class: 'nh-warn', style: { margin: '3px 0' } });
    row.appendChild(el('strong', { text: `${w.node} · ${w.source}: ` }));
    row.appendChild(el('span', { text: w.reason || '' }));
    box.appendChild(row);
  });
  return box;
}

/// The banner naming every node whose figure its own flows contradict, drawn above the chart.
function contradictionBanner(items                                                , onFocus                      )              {
  const box = el('div', { class: 'flow-contradiction' });
  const n = items.length;
  box.appendChild(el('strong', {
    text: n === 1
      ? '1 node’s figure is contradicted by its own flows'
      : `${n} nodes’ figures are contradicted by their own flows`,
  }));
  box.appendChild(el('div', {
    class: 'desc',
    style: { margin: '2px 0 6px' },
    text: 'More than a quarter of what passes through them is unaccounted for — too much to be rounding or '
        + 'sampling skew. Usually a source scaled wrongly, a sensor measuring one leg of the node, or a '
        + 'counter that is not the kind it was configured as. The readings are still shown; treat them as '
        + 'suspect until the gap is explained.',
  }));
  const row = el('div', { class: 'ld-toolbar', style: { gap: '6px', flexWrap: 'wrap' } });
  items.forEach(it => {
    const b = btn(`${it.label} · ${Math.round(it.share * 100)}% unaccounted`);
    b.onclick = () => onFocus(it.id);
    row.appendChild(b);
  });
  box.appendChild(row);
  return box;
}

/// What fraction of a node's throughput its own flows cannot account for, or null when there is no gap.
function contradictionShare(n     , reading               )                {
  if (n.imbalance == null || reading == null || !isFinite(reading)) return null;
  // The denominator is what the node is handling — the larger of its two sides.
  const throughput = typeof n.throughput === 'number' ? n.throughput : reading;
  if (!(throughput > 0)) return null;
  return Math.min(1, Math.abs(n.imbalance) / throughput);
}

// Show the "Unmeasured load" node on the diagram?

// ── flow-focus.ts ───────────────────────────────────────────────
// Highlighting on the flow chart: the supply path behind a node, the nodes carrying a tag.

let activeTag                = null;

/// Chips for every tag in use, highlighting the nodes carrying it (#342).
function tagToggles(nodes       , svg     , apply                              )                     {
  const all = new Map                ();   // lower-case key -> first spelling seen
  nodes.forEach(n => (n.tags || []).forEach((t        ) => {
    const k = t.toLowerCase();
    if (!all.has(k)) all.set(k, t);
  }));
  if (!all.size) return null;   // nothing tagged: an empty row of controls is just clutter

  const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px', margin: '0 0 8px' } });
  row.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Tags:' }));
  [...all.values()].sort((a, b) => a.localeCompare(b)).forEach(tag => {
    const on = activeTag != null && activeTag.toLowerCase() === tag.toLowerCase();
    const chip = btn(tag, on ? 'primary' : undefined);
    chip.title = on
      ? 'Showing every node with this tag; click to clear.'
      : `Highlight the nodes tagged “${tag}”. Nothing is hidden and no figure changes — the rest are dimmed.`;
    // Read the state at click time.
    chip.onclick = () => {
      const selected = activeTag != null && activeTag.toLowerCase() === tag.toLowerCase();
      activeTag = selected ? null : tag;
      apply(activeTag);
    };
    row.appendChild(chip);
  });
  return row;
}

/// The strip above a view: the switches that change how it is drawn, then the group chips.

// The dedicated Nodes tab (#129): configure the virtual nodes — kind, how they're valued.
let focusedNode                = null;

function focusPath(svg     , incoming     , id        ) {
  if (focusedNode === id) { clearFocus(svg); return; }
  focusedNode = id;

  // Everything that feeds it, transitively.
  const onPath = new Set        ([id]);
  const links = new Set        ();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() ;
    (incoming[cur] || []).forEach((l     ) => {
      links.add(l.source + '' + l.target);
      if (!onPath.has(l.source)) { onPath.add(l.source); stack.push(l.source); }
    });
  }

  svg.querySelectorAll('[data-node]').forEach((e     ) =>
    e.classList[onPath.has(e.getAttribute('data-node')) ? 'add' : 'remove']('on-path'));
  svg.querySelectorAll('[data-src]').forEach((e     ) =>
    e.classList[links.has(e.getAttribute('data-src') + '' + e.getAttribute('data-dst')) ? 'add' : 'remove']('on-path'));
  svg.classList.add('flow-focus');
}

/// Highlight every node carrying `tag`, dimming the rest (#342).
function focusTag(svg     , nodesById                  , tag        ) {
  const tagged = new Set        ();
  nodesById.forEach((n, id) => {
    if ((n.tags || []).some((t        ) => t.toLowerCase() === tag.toLowerCase())) tagged.add(id);
  });

  focusedNode = null;
  svg.querySelectorAll('[data-node]').forEach((e     ) =>
    e.classList[tagged.has(e.getAttribute('data-node')) ? 'add' : 'remove']('on-path'));
  // Ribbons stay dim throughout: a link is not tagged.
  svg.querySelectorAll('[data-src]').forEach((e     ) => e.classList.remove('on-path'));
  svg.classList.add('flow-focus');
}

function clearFocus(svg     ) {
  focusedNode = null;
  if (!svg) return;
  svg.classList.remove('flow-focus');
  svg.querySelectorAll('.on-path').forEach((e     ) => e.classList.remove('on-path'));
}

// --- Node hover card ------------------------------------------------------------------------------
let nodeCardEl      = null;

function showNodeCard(host     , ev     , rows       ) {
  if (!nodeCardEl) {
    nodeCardEl = el('div', { class: 'node-card' });
    document.body.appendChild(nodeCardEl);
  }
  nodeCardEl.innerHTML = '';
  rows.forEach(r => nodeCardEl.appendChild(r));
  nodeCardEl.classList.add('show');
  moveNodeCard(ev);
}

// Follow the pointer, but flip to the other side rather than hanging off the edge of the window.
function moveNodeCard(ev     ) {
  if (!nodeCardEl || !nodeCardEl.classList.contains('show')) return;
  const pad = 14;
  const w = nodeCardEl.offsetWidth || 260, h = nodeCardEl.offsetHeight || 120;
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const x = ev.clientX + pad + w > vw ? ev.clientX - pad - w : ev.clientX + pad;
  const y = Math.min(Math.max(pad, ev.clientY - h / 2), vh - h - pad);
  nodeCardEl.style.left = Math.max(pad, x) + 'px';
  nodeCardEl.style.top = y + 'px';
}

function hideNodeCard() { if (nodeCardEl) nodeCardEl.classList.remove('show'); }

// Device templates and the panels that import them live in node-templates.ts.

// ── flow-view.ts ────────────────────────────────────────────────
// How much of the flow chart to draw: the unmetered-remainder and animation switches (browser-local).

// --- Node groups (#groups): several nodes shown as one collapsible node on both flow graphs.
const collapsedGroups = new Set        ();
const seenGroups = new Set        ();   // groups we've applied the default (collapsed) to at least once

function flowGroups()        {
  return (state.data?.EnergyFlow?.Groups || []).filter((g     ) => g && g.Id);
}

// Collapse each group the first time we see it; after that, respect the viewer's choice.
function ensureGroupState() {
  flowGroups().forEach((g     ) => { if (!seenGroups.has(g.Id)) { seenGroups.add(g.Id); collapsedGroups.add(g.Id); } });
}

// A member's owning group id, only when that group is currently collapsed.
function collapsedMemberMap()                      {
  const map                      = {};
  flowGroups().forEach((g     ) => { if (collapsedGroups.has(g.Id)) (g.Members || []).forEach((m        ) => { map[m] = g; }); });
  return map;
}

// An expanded group shows its members instead of its anchor: they take over its outgoing links and it drops
// out. Skipped when the anchor feeds more than one target, where splitting members across them is invented.
function explodeExpandedGroups(nodes       , links       )                                 {
  const groups = flowGroups().filter((g     ) => g && g.Id && !collapsedGroups.has(g.Id));
  if (!groups.length) return { nodes, links };

  let outNodes = nodes, outLinks = links;
  groups.forEach((g     ) => {
    const byId      = {}; outNodes.forEach((n     ) => { byId[n.id] = n; });
    if (!byId[g.Id]) return;                                    // synthetic group: nothing to substitute
    const members = (g.Members || []).filter((m        ) => byId[m]);
    if (!members.length) return;

    const feedsAnchor = outLinks.filter((l     ) => l.target === g.Id && members.includes(l.source));
    const anchorFeeds = outLinks.filter((l     ) => l.source === g.Id);
    if (!feedsAnchor.length || anchorFeeds.length !== 1) return;

    const target = anchorFeeds[0];
    const kept = outLinks.filter((l     ) => l.source !== g.Id && !(l.target === g.Id && members.includes(l.source)));
    outLinks = kept.concat(feedsAnchor.map((ml     ) => ({
      source: ml.source, target: target.target, value: ml.value,
      known: ml.known !== false && target.known !== false,
    })));
    outNodes = outNodes.filter((n     ) => n.id !== g.Id);
  });
  return { nodes: outNodes, links: outLinks };
}

function collapseGraph(nodes       , links       )                                 {
  const memberOf = collapsedMemberMap();
  if (!Object.keys(memberOf).length) return { nodes, links };

  const byId      = {}; nodes.forEach(n => { byId[n.id] = n; });
  const groupNode                      = {};
  flowGroups().forEach((g     ) => {
    if (!collapsedGroups.has(g.Id)) return;
    const anchor = byId[g.Id];   // id matches a real node -> an "anchor" group (e.g. Solar PV over its MPPTs)
    let sum = 0, known = false;
    (g.Members || []).forEach((m        ) => { const n = byId[m]; if (n && n.value != null) { sum += n.value; known = true; } });
    groupNode[g.Id] = anchor
      // The anchor keeps its own identity and value; only if it has none does it fall back to the members' sum.
      ? { ...anchor, value: anchor.value != null ? anchor.value : (known ? sum : null), group: true }
      : { id: g.Id, label: g.Label || g.Id, kind: g.Kind || 'node', value: known ? sum : null, group: true };
  });

  const remap = (id        ) => (memberOf[id] ? memberOf[id].Id : id);
  // Drop the collapsed members, keep everyone else.
  const present = new Set        ();
  // Drop collapsed members and any anchor node (it's re-added as its group node, so it isn't duplicated).
  const outNodes = nodes.filter(n => !memberOf[n.id] && !groupNode[n.id]);
  const merged                      = {};
  links.forEach(l => {
    const s = remap(l.source), t = remap(l.target);
    if (s === t) return;                       // a link fully inside one collapsed group
    present.add(s); present.add(t);
    const k = s + '\u0000' + t;
    if (!merged[k]) merged[k] = { source: s, target: t, value: 0, known: true };
    merged[k].value += (l.value || 0);
    if (l.known === false) merged[k].known = false;
  });
  // An anchor group always appears (its node was already in the graph); a synthetic group only if a member was.
  Object.values(groupNode).forEach((gn     ) => { if (present.has(gn.id) || byId[gn.id]) outNodes.push(gn); });
  return { nodes: outNodes, links: Object.values(merged) };
}

// The toggle strip above the diagram: one chip per group, click to collapse/expand on both graphs.

let showUnmeasured = (() => { try { return localStorage.getItem('rpdu-flow-unmeasured') !== '0'; } catch { return true; } })();

function setShowUnmeasured(on         ) {
  showUnmeasured = on;
  try { localStorage.setItem('rpdu-flow-unmeasured', on ? '1' : '0'); } catch { /* private mode: this session only */ }
}

/// Drop the unmetered-remainder nodes and their links when the view is switched off.
function applyUnmeasuredPref(nodes       , links       )                                 {
  if (showUnmeasured) return { nodes, links };
  const hidden = new Set(nodes.filter((n     ) => String(n.id || '').endsWith('#unmeasured')).map((n     ) => n.id));
  if (!hidden.size) return { nodes, links };
  return {
    nodes: nodes.filter((n     ) => !hidden.has(n.id)),
    links: links.filter((l     ) => !hidden.has(l.target) && !hidden.has(l.source)),
  };
}

/// Hide the branches that are carrying nothing. On by default: a rack of switched-off outlets is most of
/// the diagram and none of the information.
let hideEmpty = (() => { try { return localStorage.getItem('rpdu-flow-hide-empty') !== '0'; } catch { return true; } })();

function setHideEmpty(on         ) {
  hideEmpty = on;
  try { localStorage.setItem('rpdu-flow-hide-empty', on ? '1' : '0'); } catch { /* private mode: this session only */ }
}

/// Drop nodes reading zero when nothing downstream of them is carrying anything either.
///
/// A node with NO value is left alone. "0 A" and "no data" are different statements: the first is a
/// measurement, the second is a gap in the model — nothing measures that node — and hiding it by default
/// would bury exactly the sort of thing this diagram exists to surface.
///
/// The test is downstream only. A zero node still on a live supply path stays, so the solar chain after
/// dark — MPPTs at 0 feeding an aggregate at 0 feeding a live inverter — is drawn as the connected thing
/// it is. A zero node with nothing live below it is a switched-off outlet, and that is what goes.
function applyHideEmptyPref(nodes       , links       )                                 {
  if (!hideEmpty) return { nodes, links };

  const carrying = (n     ) => n.value != null && Math.abs(n.value) > 0;
  const byId = new Map             (nodes.map((n     ) => [n.id, n]));
  const out = new Map                  ();
  links.forEach((l     ) => out.set(l.source, [...(out.get(l.source) || []), l.target]));

  // Memoised so a wide fan-out is walked once, and cycle-safe because a node in progress answers false
  // rather than recursing back into itself.
  const feedsSomethingLive = new Map                 ();
  const walking = new Set        ();
  const live = (id        )          => {
    if (feedsSomethingLive.has(id)) return feedsSomethingLive.get(id) ;
    if (walking.has(id)) return false;
    walking.add(id);
    const answer = (out.get(id) || []).some(t => {
      const n = byId.get(t);
      return (n && carrying(n)) || live(t);
    });
    walking.delete(id);
    feedsSomethingLive.set(id, answer);
    return answer;
  };

  const keep = (id        ) => {
    const n = byId.get(id);
    if (!n) return false;
    return n.value == null || carrying(n) || live(id);
  };

  return {
    nodes: nodes.filter((n     ) => keep(n.id)),
    links: links.filter((l     ) => keep(l.source) && keep(l.target)),
  };
}

/// The "Unmeasured load" view switch, shown wherever the group chips are.
function unmeasuredToggle(onToggle            )              {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
    title: 'Show the gap between what a node passes and what its metered children draw, as its own node. '
      + 'A view setting only — the figure is never published, and turning it off does not change any total.',
  });
  const cb      = el('input', { type: 'checkbox' });
  cb.checked = showUnmeasured;
  cb.onchange = () => { setShowUnmeasured(cb.checked); onToggle(); };
  lbl.append(cb, document.createTextNode('Unmeasured load'));
  return lbl;
}

/// The "Animate flow" view switch. Purely local: a per-viewer preference.
function animateToggle(onToggle            )              {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
    title: 'Draw a moving stream along each ribbon. Speed follows how dense the flow is — flow per unit of '
      + 'ribbon width — so it says how hard something is moving, which width alone cannot. Links with no '
      + 'data, and measured zeroes, never animate: nothing should look busier than its reading.',
  });
  const cb      = el('input', { type: 'checkbox' });
  cb.checked = localStorage.getItem('rpdu2mqtt.flow.animate') === '1';
  cb.onchange = () => { localStorage.setItem('rpdu2mqtt.flow.animate', cb.checked ? '1' : '0'); onToggle(); };
  lbl.append(cb, document.createTextNode('Animate flow'));
  return lbl;
}

// The "show a past moment" control, and the wording for what comes back, live in history-control.ts.

function groupToggles(onToggle            , drawn = true)                     {
  const groups = flowGroups();
  const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px', margin: '0 0 8px' } });
  // The view switches are not about groups and must not disappear with them.
  if (drawn) {
    row.appendChild(hideEmptyToggle(onToggle));
    row.appendChild(unmeasuredToggle(onToggle));
    row.appendChild(animateToggle(onToggle));
  }
  if (!groups.length) return drawn ? row : null;
  row.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Groups:' }));
  groups.forEach((g     ) => {
    const on = collapsedGroups.has(g.Id);
    const count = (g.Members || []).length;
    const chip = btn(`${on ? '▸' : '▾'} ${g.Label || g.Id} (${count})`);
    // A group with no members has nothing to fold — collapsing/expanding it is a no-op.
    chip.title = count === 0 ? 'No members yet — add nodes to this group on the Nodes tab; then it collapses/expands.'
      : on ? `Collapsed — click to expand its ${count} member(s)` : 'Expanded — click to collapse into one node';
    chip.onclick = () => {
      if (count === 0) { toast(`“${g.Label || g.Id}” has no members yet — add some in the Groups section on the Nodes tab.`, false); return; }
      on ? collapsedGroups.delete(g.Id) : collapsedGroups.add(g.Id); onToggle();
    };
    row.appendChild(chip);
  });
  // Where membership is edited — the toggles only collapse/expand.
  row.appendChild(el('span', { class: 'desc', style: { margin: '0 0 0 6px', fontSize: '11px' }, text: '· add/remove members in the Groups section on the Nodes tab' }));
  return row;
}

// The candidate node universe for wiring: the built graph's nodes (pdu/outlet/…) plus the custom defs.

/// The "Hide empty" view switch. Per-viewer, like the others here.
function hideEmptyToggle(onToggle            )              {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
    title: 'Hide branches reading zero — switched-off outlets and anything they feed. Nodes with NO data '
      + 'stay: nothing measures those, which is a gap in the model rather than an empty branch. A view '
      + 'setting only; no total changes.',
  });
  const cb      = el('input', { type: 'checkbox' });
  cb.checked = hideEmpty;
  cb.onchange = () => { setHideEmpty(cb.checked); onToggle(); };
  lbl.append(cb, document.createTextNode('Hide empty'));
  return lbl;
}

// ── node-templates.ts ───────────────────────────────────────────
// Ready-made device templates, and the two panels that import them (MQTT Import, and the Nodes page).

// Ready-made device templates (EG4 inverters, meters, …), fetched once and cached.
let nodeTemplatesCache               = null;
async function loadNodeTemplates()                 {
  if (nodeTemplatesCache) return nodeTemplatesCache;
  const r = await api('/api/node-templates');
  nodeTemplatesCache = (r.body?.ok && r.body.templates) ? r.body.templates : [];
  return nodeTemplatesCache;
}

// Instantiate a template into the live config: its Modbus connection (if any) and its pre-wired nodes.
function instantiateTemplate(tpl     , prefix        , host        , unitId        , flow     )           {
  const nodes = ensure(flow, 'Nodes', []);
  const links = ensure(flow, 'Links', []);
  let connId                    ;
  if (tpl.transport === 'modbus' && tpl.modbus) {
    const conns = ensure(ensure(state.data, 'Modbus', {}), 'Connections', []);
    connId = prefix;
    conns.push({ Id: connId, Name: tpl.name, Host: host || '', Port: tpl.modbus.port, UnitId: unitId,
      PollIntervalSeconds: tpl.modbus.pollIntervalSeconds, Framing: tpl.modbus.framing || 'tcp', Enabled: true });
  }
  const idOf = (key        ) => prefix + '-' + key;
  const added           = [];
  (tpl.nodes || []).forEach((tn     ) => {
    const node      = { Id: idOf(tn.key), Label: tn.label, Kind: tn.kind, Sources: (tn.sources || []).map((s     ) => {
      const src      = { Type: tpl.transport, Metric: s.metric };
      if (s.unit) src.Unit = s.unit;
      if (s.scale != null && s.scale !== 1) src.Scale = s.scale;
      if (tpl.transport === 'modbus') {
        src.Connection = connId; src.Register = s.register; src.RegisterType = s.registerType;
        src.DataType = s.dataType; src.WordOrder = s.wordOrder;
      } else { if (s.topic) src.Topic = s.topic; if (s.jsonField) src.JsonField = s.jsonField; }
      return src;
    }) };
    nodes.push(node); added.push(node.Id);
    if (tn.feedsKey) links.push({ From: idOf(tn.key), To: idOf(tn.feedsKey) });
  });
  return added;
}

function renderImportPanel(flow     , existingIds             , rerender            )              {
  const panel = el('div', { class: 'tpl-import' });
  panel.appendChild(el('div', { class: 'desc', text: 'Import a known device to pre-fill its nodes and register bindings. Review and Save afterwards; addresses are community starting points — verify against your firmware.' }));
  const row = el('div', { class: 'ld-toolbar' });
  const sel = el('select', { style: { width: 'auto' } })                     ;
  const prefixIn = el('input', { type: 'text', placeholder: 'id prefix (e.g. eg4)' })                    ;
  const hostIn = el('input', { type: 'text', placeholder: 'Modbus host / IP' })                    ;
  const unitIn = el('input', { type: 'number', placeholder: 'unit', style: { width: '70px' } })                    ;
  const importBtn = btn('Import', 'primary');
  const note = el('div', { class: 'desc' });
  row.append(sel, prefixIn, hostIn, unitIn, importBtn);
  panel.append(row, note);

  loadNodeTemplates().then(tpls => {
    if (!tpls.length) { note.textContent = 'No device templates available.'; return; }
    tpls.forEach((t     ) => sel.appendChild(el('option', { value: t.id, text: t.vendor + ' · ' + t.name })));
    const showMeta = () => {
      const t = tpls.find((x     ) => x.id === sel.value);
      if (!t) return;
      prefixIn.value = t.id; hostIn.style.display = t.transport === 'modbus' ? '' : 'none';
      unitIn.style.display = t.transport === 'modbus' ? '' : 'none';
      unitIn.value = t.modbus ? String(t.modbus.unitId) : '';
      note.innerHTML = '';
      note.append(el('span', { text: (t.description || '') + ' ' }));
      if (t.sourceUrl) { const a = document.createElement('a'); a.href = t.sourceUrl; a.target = '_blank'; a.textContent = 'Register source ↗'; a.style.color = 'var(--accent)'; note.appendChild(a); }
    };
    sel.onchange = showMeta; showMeta();
    importBtn.onclick = () => {
      const t = tpls.find((x     ) => x.id === sel.value); if (!t) return;
      const prefix = (prefixIn.value || '').trim(); if (!prefix) { toast('An id prefix is required.', false); return; }
      const clash = (t.nodes || []).map((n     ) => prefix + '-' + n.key).find((id        ) => existingIds.has(id));
      if (clash) { toast(`Node id '${clash}' already exists — pick a different prefix.`, false); return; }
      const added = instantiateTemplate(t, prefix, hostIn.value.trim(), parseInt(unitIn.value) || 1, flow);
      toast(`Imported ${t.name}: ${added.length} node(s). Set the Modbus host if needed, then Save.`, true);
      rerender();
    };
  });
  return panel;
}

// ── palette.ts ──────────────────────────────────────────────────
// Ctrl+K page switcher.
//
// The nav has grown to five groups and twenty-odd pages, several of them collapsed; finding "HA Energy
// Mapping" meant remembering which group it hides under. This types straight to it. It reads the nav
// rather than keeping its own list, so a new page is reachable the moment it's rendered.

function paletteItems() {
  const out        = [];
  document.querySelectorAll('.nav-group-wrap').forEach((wrap     ) => {
    const group = wrap.querySelector('.nav-group')?.textContent || '';
    wrap.querySelectorAll('a').forEach((a     ) => out.push({ label: a.dataset?.label || a.textContent, group, link: a }));
  });
  // Pages outside any group (the Status landing page).
  const nav      = document.getElementById('nav');
  nav?.querySelectorAll('a').forEach((a     ) => {
    if (!out.some(i => i.link === a)) out.unshift({ label: a.dataset?.label || a.textContent, group: '', link: a });
  });
  return out;
}

function openPalette() {
  const items = paletteItems();
  const input      = el('input', { class: 'sheet-search', type: 'text', placeholder: 'Jump to a page…' });
  const list      = el('div');
  let shown        = items;
  let sel = 0;

  const choose = (i     ) => { closeSheet(); i?.link?.click(); };

  const render = () => {
    const q = (input.value || '').trim().toLowerCase();
    shown = q ? items.filter(i => (i.label + ' ' + i.group).toLowerCase().includes(q)) : items;
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    list.innerHTML = '';
    if (!shown.length) { list.appendChild(el('div', { class: 'cmd-empty', text: 'No page matches “' + input.value + '”.' })); return; }
    shown.forEach((i, idx) => {
      const row = el('div', { class: 'cmd-item', role: 'option', onclick: () => choose(i) },
        el('span', { text: i.label }),
        i.group ? el('span', { class: 'cmd-group', text: i.group }) : null);
      row.setAttribute('aria-selected', String(idx === sel));
      // Hovering moves the highlight, so mouse and keyboard don't disagree about what Enter does.
      row.onmouseenter = () => { sel = idx; paint(); };
      list.appendChild(row);
    });
  };
  const paint = () => [...list.children].forEach((c     , idx        ) => c.setAttribute?.('aria-selected', String(idx === sel)));

  input.oninput = () => { sel = 0; render(); };
  input.onkeydown = (e     ) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
  };

  render();
  openSheet({ search: input, body: list });
  input.focus?.();
}

function initPalette() {
  const opener      = document.getElementById('cmd-open');
  if (opener) opener.onclick = () => openPalette();
  window.addEventListener('keydown', (e     ) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); sheetIsOpen() ? closeSheet() : openPalette(); }
  });
}

// ── overrides.ts ────────────────────────────────────────────────
// Overrides editor (driven by live PDU data) + the config export/prune helpers.

function ovGet(path          ) { let o = state.data.Overrides; for (const p of path) { if (o == null) return undefined; o = o[p]; } return o; }
function ovSet(path          , val     ) {
  let o = state.data.Overrides = state.data.Overrides || {};
  for (let i = 0; i < path.length - 1; i++) { if (o[path[i]] == null) o[path[i]] = {}; o = o[path[i]]; }
  const last = path[path.length - 1];
  if (val === undefined || val === null || val === '') delete o[last]; else o[last] = val;
}

function ovText(label        , path          , placeholder         ) {
  const f = document.createElement('label'); f.className = 'ov-field';
  const s = document.createElement('span'); s.textContent = label; f.appendChild(s);
  const inp = document.createElement('input'); inp.type = 'text';
  const v = ovGet(path); if (v != null) inp.value = v;
  if (placeholder) inp.placeholder = placeholder;
  inp.onchange = () => ovSet(path, inp.value.trim());
  f.appendChild(inp); return f;
}
function ovEnabled(path          ) {
  const f = document.createElement('label'); f.className = 'ov-field ov-check';
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = ovGet(path) !== false;
  // Checked == default (true) -> drop the key; unchecked -> persist Enabled:false.
  inp.onchange = () => ovSet(path, inp.checked ? undefined : false);
  const s = document.createElement('span'); s.textContent = 'Enabled';
  f.appendChild(inp); f.appendChild(s); return f;
}
// ph: { name, id } placeholders showing the current (default) values.
// makeModel: also render Manufacturer/Model overrides (devices/outlets/groups, not measurements).
function overrideFields(objPath          , ph     , makeModel          ) {
  ph = ph || {};
  const wrap = document.createElement('div'); wrap.className = 'ov-fields';
  wrap.appendChild(ovText('Name (display)', [...objPath, 'Name'], ph.name));
  wrap.appendChild(ovText('ID (object_id)', [...objPath, 'ID'], ph.id));
  if (makeModel) {
    // Keep Make + Model together on one line.
    const pair = document.createElement('div'); pair.className = 'ov-pair';
    pair.appendChild(ovText('Make (manufacturer)', [...objPath, 'Make'], 'e.g. Dell'));
    pair.appendChild(ovText('Model', [...objPath, 'Model'], 'e.g. PowerEdge R730xd'));
    wrap.appendChild(pair);
  }
  wrap.appendChild(ovEnabled([...objPath, 'Enabled']));
  if (makeModel) {
    const note = document.createElement('div'); note.className = 'ov-note';
    note.textContent = 'Make/Model: leave blank to use the PDU’s value (or the Remap Model/Manufacturer result, if those toggles are enabled).';
    wrap.appendChild(note);
  }
  return wrap;
}
// A muted line of "label value" context bits; empty values are skipped.
function ovContext(parts       ) {
  const span = document.createElement('span'); span.className = 'ov-sub';
  span.textContent = parts.filter(p => p[1]).map(p => (p[0] ? p[0] + ' ' : '') + p[1]).join('   ·   ');
  return span;
}
function overrideCard(title        , contextParts       , objPath          , ph     , makeModel          ) {
  const card = document.createElement('div'); card.className = 'ov-card';
  const head = document.createElement('div'); head.className = 'ov-head';
  const t = document.createElement('div'); t.className = 'ov-title'; t.textContent = title; head.appendChild(t);
  if (contextParts && contextParts.some(p => p[1])) head.appendChild(ovContext(contextParts));
  card.appendChild(head);
  card.appendChild(overrideFields(objPath, ph, makeModel));
  return card;
}
function groupHeader(title        , sub               ) {
  const w = document.createElement('div'); w.className = 'ov-group';
  const h = document.createElement('h3'); h.textContent = title; w.appendChild(h);
  if (sub) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = sub; w.appendChild(d); }
  return w;
}
function outletRow(deviceKey        , o     ) {
  const row = document.createElement('div'); row.className = 'ov-outlet';
  const lab = document.createElement('div'); lab.className = 'ov-outlet-label';
  const strong = document.createElement('strong'); strong.textContent = 'Outlet ' + o.index; lab.appendChild(strong);
  const friendly = o.label || o.name;
  if (friendly) { const s = document.createElement('span'); s.textContent = ' — ' + friendly; lab.appendChild(s); }
  row.appendChild(lab);
  if (o.name || o.displayName) row.appendChild(ovContext([['PDU name:', o.name], ['discovered as:', o.displayName]]));
  row.appendChild(overrideFields(['Devices', deviceKey, 'Outlets', String(o.index)], { name: o.displayName, id: o.objectId }, true));
  return row;
}
function deviceCard(dev     ) {
  const card = document.createElement('div'); card.className = 'ov-card';
  const head = document.createElement('div'); head.className = 'ov-head';
  const friendly = dev.label || dev.name || dev.key;
  const t = document.createElement('div'); t.className = 'ov-title'; t.textContent = 'Device: ' + friendly; head.appendChild(t);
  head.appendChild(ovContext([['key', dev.key], ['PDU name:', dev.name], ['discovered as:', dev.displayName]]));
  card.appendChild(head);
  card.appendChild(overrideFields(['Devices', dev.key], { name: dev.displayName, id: dev.objectId }, true));

  // Merge live outlets with any override-only outlet keys (e.g. disabled ones not in live data).
  const live = dev.outlets || [];
  const ovOutlets = ovGet(['Devices', dev.key, 'Outlets']) || {};
  const merged = [...live];
  Object.keys(ovOutlets).forEach(idx => { if (!live.some((o     ) => String(o.index) === String(idx))) merged.push({ index: Number(idx), displayName: '(not currently discovered)' }); });
  if (merged.length) {
    const ol = document.createElement('div'); ol.className = 'ov-outlets';
    merged.sort((a     , b     ) => a.index - b.index).forEach((o     ) => ol.appendChild(outletRow(dev.key, o)));
    card.appendChild(ol);
  }
  return card;
}

async function renderOverrides(container     ) {
  container.dataset.loaded = '1';
  container.innerHTML = '<div class="desc">Loading live PDU data…</div>';
  const r = await api('/api/live');
  ensure(state.data, 'Overrides', {}); ensure(state.data.Overrides, 'Devices', {}); ensure(state.data.Overrides, 'Measurements', {});
  container.innerHTML = '';
  if (!r.body.ok) {
    const w = document.createElement('div'); w.className = 'desc'; w.style.color = 'var(--bad)';
    w.textContent = (r.body.message || 'Could not load live data.') + ' Showing existing overrides only.';
    container.appendChild(w);
  }
  const lv = r.body.ok ? r.body : { devices: [], measurements: [], groups: [] };
  const ov = state.data.Overrides;

  container.appendChild(overrideCard('Bridge (rPDU2MQTT)', [['', 'the top-level bridge device']], ['PDU'], {}, true));

  container.appendChild(groupHeader('Devices', 'Each discovered device and its outlets. Leave a field blank to keep the value shown in the placeholder.'));
  const liveKeys = new Set();
  lv.devices.forEach((d     ) => { liveKeys.add(d.key); container.appendChild(deviceCard(d)); });
  Object.keys(ov.Devices || {}).filter(k => !liveKeys.has(k)).forEach(k => container.appendChild(deviceCard({ key: k, displayName: '(not currently discovered)', outlets: [] })));

  container.appendChild(groupHeader('Measurements', 'Applied to every measurement of this type, across all outlets.'));
  const units      = {}; (lv.measurements || []).forEach((m     ) => { units[m.type] = m.units; });
  const types = [...new Set([...(lv.measurements || []).map((m     ) => m.type), ...Object.keys(ov.Measurements || {})])];
  types.forEach(tp => container.appendChild(overrideCard('measurement: ' + tp, [['units:', units[tp]]], ['Measurements', tp], {})));

  if (lv.groups && lv.groups.length) {
    container.appendChild(groupHeader('OneView Groups', null));
    lv.groups.forEach((g     ) => container.appendChild(overrideCard('Group: ' + (g.label || g.name || g.key), [['key', g.key], ['discovered as:', g.displayName]], ['OneviewGroups', 'Overrides', g.key], { name: g.displayName }, true)));
  }
}

// Show the generated paths produced by the current (unsaved) overrides, computed server-side
// against the real processing pipeline so it matches what would actually be published.
async function previewOverridePaths(box     ) {
  box.innerHTML = '<div class="desc">Computing paths with your unsaved edits…</div>';
  const r = await fetch('/api/paths/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) })
    .then(async res => ({ ok: res.ok, body: await res.json().catch(() => ({}       )) }));
  box.innerHTML = '';
  if (!r.body.ok) { box.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not compute paths.') + '</div>'; return; }
  const note = document.createElement('div'); note.className = 'desc';
  note.innerHTML = 'Paths with unsaved overrides applied. Note: overrides change the <b>HA name/object_id</b> and <b>Prometheus device/source labels</b>; the <b>MQTT topic</b> and <b>EmonCMS key</b> derive from the PDU’s raw keys and are not affected.';
  box.appendChild(note);
  box.appendChild(pathsTable(r.body.rows || [], !!r.body.prometheusEnabled, !!r.body.emonEnabled));
}

// Strip empty override objects so untouched entries don't pollute the saved config.
function exportData() {
  const clone = JSON.parse(JSON.stringify(state.data));
  if (clone.Overrides) pruneEmpty(clone.Overrides);
  return clone;
}
function pruneEmpty(o     )      {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const k of Object.keys(o)) {
      const v = pruneEmpty(o[k]);
      if (v === undefined) delete o[k];
    }
    if (Object.keys(o).length === 0) return undefined;
  }
  return o;
}

// ── sections/paths.ts ───────────────────────────────────────────
// Integration Paths section + the shared paths-table builders (also used by the overrides preview).

// A click-to-copy monospace table cell (used by the path tables).
function pathCopyCell(text        ) {
  const td = document.createElement('td');
  if (!text) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
  const code = document.createElement('span'); code.textContent = text;
  code.style.fontFamily = 'ui-monospace,Consolas,monospace'; code.style.fontSize = '12px';
  td.appendChild(copyOnClick(code, text)); return td;
}

// Every cell copies — the device, outlet and measurement names are as worth copying as the paths are
// (they're what you type into an override, a filter or a template).
function copyCell(text        ) {
  const td = document.createElement('td');
  if (!text) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
  const span = document.createElement('span'); span.textContent = text;
  td.appendChild(copyOnClick(span, text)); return td;
}

// Build a paths table (Device / Outlet / Measurement / MQTT [/ Prometheus] [/ EmonCMS]).
function pathsTable(rows       , promOn         , emonOn         ) {
  const t = document.createElement('table'); t.className = 'ld';
  const cols = ['Device', 'Outlet / entity', 'Measurement', 'MQTT topic'];
  if (promOn) cols.push('Prometheus'); if (emonOn) cols.push('EmonCMS');
  const head = document.createElement('tr'); cols.forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
  const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
  const tb = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    [r.device, r.source, r.type].forEach(c => tr.appendChild(copyCell(c)));
    tr.appendChild(pathCopyCell(r.mqtt));
    if (promOn) tr.appendChild(pathCopyCell(r.prometheus));
    if (emonOn) tr.appendChild(pathCopyCell(r.emoncms));
    tb.appendChild(tr);
  });
  t.appendChild(tb); return t;
}

// Generated integration paths per measurement (MQTT topic, Prometheus metric, EmonCMS key).
function addPathsSection(nav     , sections     ) {
  const link = navLink(nav, "Paths", "⤳");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Integration Paths'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'The MQTT topic, Prometheus metric, and EmonCMS key generated for each measurement (reflecting your overrides). Click any value — path, device, outlet or measurement — to copy it.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const filter = document.createElement('input'); filter.type = 'text'; filter.placeholder = 'Filter (device / outlet / measurement / path)…';
  const count = document.createElement('span'); count.className = 'ld-count';
  bar.appendChild(refresh); bar.appendChild(filter); bar.appendChild(count); sec.appendChild(bar);
  const tableWrap = document.createElement('div'); sec.appendChild(tableWrap);

  let rows        = [], promOn = false, emonOn = false;
  const draw = () => {
    const f = filter.value.trim().toLowerCase();
    const shown = f ? rows.filter(r => (r.device + ' ' + r.source + ' ' + r.type + ' ' + r.mqtt + ' ' + (r.prometheus || '') + ' ' + (r.emoncms || '')).toLowerCase().includes(f)) : rows;
    tableWrap.innerHTML = ''; tableWrap.appendChild(pathsTable(shown, promOn, emonOn));
  };
  const load = async () => {
    const r = await api('/api/paths');
    if (!r.body.ok) { tableWrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load paths.') + '</div>'; count.textContent = ''; return; }
    rows = r.body.rows || []; promOn = !!r.body.prometheusEnabled; emonOn = !!r.body.emonEnabled;
    count.textContent = rows.length + ' measurements';
    draw();
  };
  refresh.onclick = load; filter.oninput = draw;
  link.onclick = () => { activate(link, sec); load(); };
}

// ── sections/diagnostics.ts ─────────────────────────────────────
// Status / diagnostics: component health, versions, uptime, restart, and (in Kubernetes) logs + events.

function addDiagnosticsSection(nav     , sections     ) {
  const link = navLink(nav, "Diagnostics", "✚");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Diagnostics'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc'; d.textContent = 'Runtime status and maintenance actions.'; sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'sec-actions';
  const refresh = btn('Refresh');
  bar.appendChild(refresh); sec.appendChild(bar);

  // Restart panel: one button per restartable target. In Kubernetes these roll-restart the matching
  // Deployment(s) (which also pulls the latest image); in a split non-k8s deployment they signal the tier
  // over the bus; otherwise it's just this process. Populated from /api/restart/targets.
  const restartBar = document.createElement('div'); restartBar.className = 'sec-actions'; sec.appendChild(restartBar);
  const loadRestartTargets = async () => {
    restartBar.innerHTML = '';
    const r = await api('/api/restart/targets');
    const method = r.body.method || 'local';
    const targets = r.body.targets || [];
    const verb = method === 'rollout' ? 'Rollout restart' : method === 'signal' ? 'Restart' : 'Restart';
    const label = document.createElement('span'); label.className = 'desc'; label.style.cssText = 'margin:0 6px 0 0;align-self:center;';
    label.textContent = method === 'rollout' ? 'Rollout restart (also updates the image):' : method === 'signal' ? 'Restart a tier:' : 'Restart:';
    restartBar.appendChild(label);
    targets.forEach((t     ) => {
      const b = btn(`${verb} — ${t.label}`, t.id === 'all' ? 'danger' : '');
      b.onclick = async () => {
        if (!confirm(`${verb} ${t.label}? It will disconnect briefly while it restarts.`)) return;
        const rr = await api('/api/restart?target=' + encodeURIComponent(t.id), { method: 'POST' });
        const ok = rr.ok && rr.body.ok;
        toast(rr.body.message || 'Restarting…', ok);
        // Same reasoning as the operator's switch: the stream is about to drop because we asked it to.
        if (ok) expectRestart(`${verb} — ${t.label}`);
      };
      restartBar.appendChild(b);
    });
  };

  const comp = document.createElement('div'); comp.style.margin = '6px 0 14px'; sec.appendChild(comp);
  const info = document.createElement('table'); info.className = 'ld'; sec.appendChild(info);
  const k8sWrap = document.createElement('div'); sec.appendChild(k8sWrap);

  // A "Components" panel: which roles this node runs, MQTT transport, and whether PDU data is flowing.
  const compLine = (dotClass        , label        ) => {
    const ln = document.createElement('div'); ln.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px;';
    const dot = document.createElement('span'); dot.className = 'dot' + (dotClass ? ' ' + dotClass : '');
    const t = document.createElement('span'); t.textContent = label;
    ln.appendChild(dot); ln.appendChild(t); return ln;
  };
  const renderComponents = (b     ) => {
    comp.innerHTML = '';
    const head = document.createElement('div'); head.textContent = 'Components'; head.style.cssText = 'font-weight:600;color:var(--accent);margin-bottom:6px;'; comp.appendChild(head);
    const roles = b.roles || [];
    comp.appendChild(compLine('good', 'Roles on this node: ' + (roles.length ? roles.join(', ') : 'all')));
    comp.appendChild(compLine(b.mqttConnected ? 'good' : 'bad', 'MQTT — ' + (b.mqttConnected ? 'connected' : 'disconnected') + ' (' + (b.mqttHost || '?') + ')'));
    const ds = b.dataSources || [];
    if (!ds.length) comp.appendChild(compLine('', 'PDU data — none yet' + (roles.length && !roles.includes('worker') ? ' (waiting on a worker)' : '')));
    else ds.forEach((s     ) => comp.appendChild(compLine(s.stale ? 'bad' : 'good', 'PDU data · ' + s.instance + ' — ' + (s.stale ? 'stale, ' : '') + 'updated ' + s.ageSeconds + 's ago')));
    // Modbus sources (inverters/meters). This is where "everything's green but no solar/battery/grid data"
    // gets diagnosed — a device that isn't answering shows red here instead of only in a log line.
    (b.modbus || []).forEach((m     ) => {
      const label = 'Modbus · ' + (m.name || m.id) + ' (' + (m.host || '?') + ')';
      if (m.stale)
        comp.appendChild(compLine('bad', label + ' — ' + (m.lastOkAgeSeconds == null ? 'no successful read yet' : 'stale, last read ' + m.lastOkAgeSeconds + 's ago') + (m.error ? ' · ' + m.error : '')));
      else
        comp.appendChild(compLine('good', label + ' — reading ' + m.values + ' value(s), ' + (m.lastOkAgeSeconds ?? 0) + 's ago' + (m.error ? ' · ' + m.error : '')));
    });
    // Other role processes seen on the bus (split deployments only).
    (b.processes || []).forEach((p     ) => comp.appendChild(compLine(p.stale ? 'bad' : 'good', 'Process · ' + ((p.roles || []).join('+') || '?') + ' @ ' + (p.host || '?') + ' — ' + (p.stale ? 'last seen ' : 'alive, ') + p.ageSeconds + 's ago')));
  };

  const fmtUptime = (s        ) => { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; };
  // Server timestamps are rendered exactly as the server sent them — never through the browser's Date, which
  // would silently re-express them in the viewer's zone and defeat the point of showing the server's clock.
  const fmtStamp = (s        ) => String(s || '').replace('T', ' ').replace(/(\.\d+)?(Z|[+-]\d\d:\d\d)?$/, '');
  const fmtOffset = (mins        ) => (mins < 0 ? '-' : '+') + String(Math.floor(Math.abs(mins) / 60)).padStart(2, '0') + ':' + String(Math.abs(mins) % 60).padStart(2, '0');
  const row = (k        , v     ) => { const tr = document.createElement('tr'); const a = document.createElement('td'); a.textContent = k; a.style.color = 'var(--muted)'; a.style.width = '220px'; const b = document.createElement('td'); b.textContent = (v == null || v === '') ? '—' : v; tr.appendChild(a); tr.appendChild(b); return tr; };

  const load = async () => {
    const r = await api('/api/diagnostics'); const b = r.body;
    renderComponents(b);
    info.innerHTML = '';
    info.appendChild(row('App version', b.version));
    if (b.image) info.appendChild(row('Container image', b.image));
    if (b.update) {
      // Operator update report (#210). Highlight when a newer release than the deployed one is available.
      const u = b.update;
      let txt        ;
      if (u.available) txt = 'update available → ' + (u.latest || '?') + (u.applied ? ' (auto-updated)' : '') + (u.current ? ' (on ' + u.current + ')' : '');
      else if (u.current) txt = 'up to date (' + u.current + ')';
      else txt = u.message || '—';
      const tr = row('Updates', txt);
      if (u.available && !u.applied) (tr.lastChild               ).style.color = 'var(--warn, #d08700)';
      info.appendChild(tr);
    }
    info.appendChild(row('Uptime', b.uptimeSeconds != null ? fmtUptime(b.uptimeSeconds) : null));
    info.appendChild(row('Started (UTC)', b.startedUtc));
    info.appendChild(row('MQTT', (b.mqttConnected ? 'connected' : 'disconnected') + ' — ' + b.mqttHost));
    info.appendChild(row('Last PDU poll (UTC)', b.lastPollUtc));
    if (b.emoncms && b.emoncms.enabled) {
      const s = b.emoncms.status || {};
      let txt;
      if (s.ok === true) txt = 'ok (' + b.emoncms.transport + ') — last sent ' + (s.lastSuccessUtc || '?') + (s.count ? ', ' + s.count + ' inputs' : '');
      else if (s.ok === false) txt = 'error (' + b.emoncms.transport + ') — ' + (s.lastError || 'unknown');
      else txt = 'enabled (' + b.emoncms.transport + ') — no export yet';
      info.appendChild(row('EmonCMS', txt));
    }
    // The server's clock, and the boundary the daily energy totals are cut on. Neither is visible from a
    // browser — the container's clock is UTC unless someone set TZ, so "Energy today" can end at 7pm local
    // and look like the numbers are wrong when it is only the day that ended.
    try {
      const t = (await api('/api/time')).body;
      if (t && t.ok && t.host && t.period) {
        info.appendChild(row('Server time (UTC)', fmtStamp(t.utc)));
        info.appendChild(row('Server time zone', t.host.zone + ' (' + fmtOffset(t.host.offsetMinutes) + ') — ' + fmtStamp(t.host.time)));
        const p = t.period;
        if (!p.tracked) info.appendChild(row('Energy day', 'not tracked (EnergyFlow.Aggregation.TrackPeriods is off)'));
        else {
          const zoneRow = row('Energy day rolls at',
            String(p.startHour).padStart(2, '0') + ':00 ' + p.zone + ' (' + fmtOffset(p.offsetMinutes) + ')'
            + (p.configured ? '' : ' — not configured, using the host zone'));
          // A configured zone this host cannot resolve is silently ignored at runtime; say so here, because
          // the only other trace is one log line at startup.
          if (!p.resolved) {
            (zoneRow.lastChild               ).textContent = '"' + p.configured + '" did not resolve on this host — falling back to ' + p.zone;
            (zoneRow.lastChild               ).style.color = 'var(--bad, #d05a5a)';
          } else if (!p.configured) (zoneRow.lastChild               ).style.color = 'var(--warn, #d08700)';
          info.appendChild(zoneRow);
          info.appendChild(row('Current energy day', p.key + ' — now ' + fmtStamp(p.time) + ' there'));
          info.appendChild(row('Next rollover', fmtStamp(p.nextRolloverLocal) + ' ' + p.zone + ' (in ' + fmtUptime(p.secondsUntilRollover) + ')'));
        }
      }
    } catch { /* an older server has no /api/time; the rest of the page is still useful */ }
    info.appendChild(row('Config source', b.configSource));
    info.appendChild(row('.NET', b.dotnet));
    info.appendChild(row('OS', b.os));
    info.appendChild(row('Kubernetes', b.kubernetes ? (b.ns + ' / ' + (b.pod || '?')) : 'no'));
    k8sWrap.innerHTML = '';
    if (b.kubernetes) buildK8sTools(k8sWrap);
  };
  refresh.onclick = load;
  link.onclick = () => { activate(link, sec); load(); loadRestartTargets(); };
}

// Kubernetes-only: on-demand pod logs + recent events.
function buildK8sTools(container     ) {
  const tools = document.createElement('div'); tools.className = 'sec-actions';
  const logsBtn = btn('Load logs');
  const evBtn = btn('Load events');
  tools.appendChild(logsBtn); tools.appendChild(evBtn); container.appendChild(tools);
  const out = document.createElement('div'); container.appendChild(out);

  logsBtn.onclick = async () => {
    out.innerHTML = '<div class="desc">Loading logs…</div>';
    const r = await api('/api/diagnostics/logs');
    if (!r.body.ok) { out.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Failed.') + '</div>'; return; }
    const ta = document.createElement('textarea'); ta.className = 'yaml'; ta.readOnly = true; ta.value = r.body.logs || '(empty)';
    out.innerHTML = ''; out.appendChild(ta);
  };
  evBtn.onclick = async () => {
    out.innerHTML = '<div class="desc">Loading events…</div>';
    const r = await api('/api/diagnostics/events');
    if (!r.body.ok) { out.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Failed.') + '</div>'; return; }
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr'); ['Time', 'Type', 'Reason', 'Message', 'Count'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    (r.body.events || []).forEach((e     ) => { const tr = document.createElement('tr'); [e.time, e.type, e.reason, e.message, e.count].forEach(c => { const td = document.createElement('td'); td.textContent = c == null ? '' : c; tr.appendChild(td); }); tb.appendChild(tr); });
    t.appendChild(tb); out.innerHTML = ''; out.appendChild(t);
    if (!(r.body.events || []).length) out.innerHTML = '<div class="desc">No recent events.</div>';
  };
}

// ── sections/control.ts ─────────────────────────────────────────
// Direct outlet control (on/off/reboot) + group actions + label editing.

function addControlSection(nav     , sections     ) {
  const link = navLink(nav, "PDU Control", "⏻");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Outlet Control'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Turn outlets on/off, reboot, reset stats, or rename them on the PDU. Requires write actions enabled (PDU.ActionsEnabled) and PDU credentials.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());
  const filter = document.createElement('input'); filter.type = 'text'; filter.placeholder = 'Filter (device / outlet)…';
  bar.appendChild(refresh); bar.appendChild(instSel.wrap); bar.appendChild(filter); sec.appendChild(bar);
  const warn = document.createElement('div'); warn.className = 'desc'; warn.style.color = 'var(--bad)'; warn.style.display = 'none';
  warn.textContent = 'Write actions are disabled (PDU.ActionsEnabled is false). Enable it in the PDU section and restart to control outlets.';
  sec.appendChild(warn);
  const groupsWrap = document.createElement('div'); sec.appendChild(groupsWrap);
  const devicesWrap = document.createElement('div'); sec.appendChild(devicesWrap);
  const tableWrap = document.createElement('div'); sec.appendChild(tableWrap);

  let rows        = [], groups        = [], devices        = [], enabled = false;
  const actGroup = async (g     , action        ) => {
    const verb = action === 'on' ? 'turn ON' : action === 'off' ? 'turn OFF' : 'reboot';
    if (!confirm('Group "' + (g.name || g.key) + '": ' + verb + ' ALL member outlets?')) return;
    toast('Group ' + (g.name || g.key) + ': ' + action + '…', true);
    const r = await api('/api/control/group', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupKey: g.key, action, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 1000);
  };
  const setGroupLabel = (g     , value        ) => postLabel({ target: 'group', groupKey: g.key, label: (value || '').trim() }, 'Group ' + (g.name || g.key));
  const drawGroups = () => {
    groupsWrap.innerHTML = '';
    if (!groups.length) return;
    const hh = document.createElement('div'); hh.className = 'desc'; hh.style.marginTop = '4px'; hh.textContent = 'Groups — rename, see member states, and act on all member outlets:'; groupsWrap.appendChild(hh);
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Group', 'Label (on PDU)', 'Members', 'Actions'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    groups.forEach(g => {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td'); nameTd.textContent = g.name || g.key; tr.appendChild(nameTd);
      // Editable group label (written to the PDU).
      const labTd = document.createElement('td');
      const lin = document.createElement('input'); lin.type = 'text'; lin.value = g.label || ''; lin.style.width = '140px'; lin.disabled = !enabled;
      const setBtn = btn('Set'); setBtn.disabled = !enabled; setBtn.style.marginLeft = '6px';
      setBtn.onclick = () => setGroupLabel(g, lin.value);
      labTd.appendChild(lin); labTd.appendChild(setBtn); tr.appendChild(labTd);
      // Aggregate member state: a dot per member outlet + an "n/m on" summary.
      const memTd = document.createElement('td');
      const members = g.members || [];
      const onCount = members.filter((m     ) => m.state === 'on').length;
      members.forEach((m     ) => {
        const dot = document.createElement('span');
        dot.className = 'dot ' + (m.state === 'on' ? 'good' : m.state === 'off' ? 'bad' : 'muted');
        dot.style.marginRight = '3px'; dot.title = (m.name || ('#' + m.number)) + ': ' + (m.state || '?');
        memTd.appendChild(dot);
      });
      if (members.length) { const c = document.createElement('span'); c.className = 'ld-count'; c.style.marginLeft = '4px'; c.textContent = onCount + '/' + members.length + ' on'; memTd.appendChild(c); }
      else { memTd.textContent = '—'; memTd.style.color = 'var(--muted)'; }
      tr.appendChild(memTd);
      const actTd = document.createElement('td');
      [['All On', 'on'], ['All Off', 'off'], ['Reboot All', 'reboot']].forEach(([lab, a]) => {
        const b = btn(lab, a !== 'on' ? 'danger' : ''); b.disabled = !enabled; b.style.marginRight = '6px'; b.onclick = () => actGroup(g, a); actTd.appendChild(b);
      });
      tr.appendChild(actTd); tb.appendChild(tr);
    });
    t.appendChild(tb); groupsWrap.appendChild(t);
  };
  const act = async (o     , action        ) => {
    if (action === 'off' && !confirm('Turn OFF outlet ' + o.number + ' (' + o.name + ')?')) return;
    if (action === 'reboot' && !confirm('Reboot outlet ' + o.number + ' (' + o.name + ')? Connected equipment will lose power briefly.')) return;
    if (action === 'resetstats' && !confirm('Reset statistics for outlet ' + o.number + ' (' + o.name + ')?')) return;
    toast('Outlet ' + o.number + ': ' + action + '…', true);
    const r = await api('/api/control/outlet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: o.deviceId, index: o.index, action, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 800); // let the PDU apply, then re-read state
  };
  const postLabel = async (payload     , desc        ) => {
    toast(desc + ': set label…', true);
    const r = await api('/api/control/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 800);
  };
  const setLabel = (o     , value        ) => postLabel({ deviceId: o.deviceId, target: 'outlet', index: o.index, label: (value || '').trim() }, 'Outlet ' + o.number);
  const drawDevices = () => {
    devicesWrap.innerHTML = '';
    if (!devices.length) return;
    const hh = document.createElement('div'); hh.className = 'desc'; hh.style.marginTop = '4px';
    hh.textContent = 'PDUs & circuits — labels are written to the PDU:'; devicesWrap.appendChild(hh);
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Type', 'Name', 'Label (on PDU)'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    const labelRow = (kind        , name        , current        , payload     ) => {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td'); td0.textContent = kind; tr.appendChild(td0);
      const td1 = document.createElement('td'); td1.textContent = name || ''; tr.appendChild(td1);
      const td2 = document.createElement('td');
      const lin = document.createElement('input'); lin.type = 'text'; lin.value = current || ''; lin.style.width = '150px'; lin.disabled = !enabled;
      const setBtn = btn('Set'); setBtn.disabled = !enabled; setBtn.style.marginLeft = '6px';
      setBtn.onclick = () => postLabel(Object.assign({}, payload, { label: (lin.value || '').trim() }), kind + ' ' + (name || ''));
      td2.appendChild(lin); td2.appendChild(setBtn); tr.appendChild(td2);
      tb.appendChild(tr);
    };
    devices.forEach(d => {
      labelRow('PDU', d.name, d.label, { deviceId: d.deviceId, target: 'device' });
      (d.circuits || []).forEach((c     ) => labelRow('Circuit', c.name, c.label, { deviceId: d.deviceId, target: 'entity', entityKey: c.key }));
    });
    t.appendChild(tb); devicesWrap.appendChild(t);
  };
  const draw = () => {
    const f = filter.value.trim().toLowerCase();
    const shown = f ? rows.filter(r => (r.device + ' ' + r.name + ' ' + r.number).toLowerCase().includes(f)) : rows;
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Device', 'Outlet', 'Label (on PDU)', 'State', 'Actions'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    shown.forEach(o => {
      const tr = document.createElement('tr');
      const tdDev = document.createElement('td'); tdDev.textContent = o.device; tr.appendChild(tdDev);
      const tdName = document.createElement('td');
      tdName.appendChild(document.createTextNode('#' + o.number + ' — ' + (o.name || '')));
      // Current write-action config, so changes made via HA are visible here.
      const cfg = document.createElement('div'); cfg.className = 'ld-count';
      cfg.textContent = 'delays: on ' + o.onDelay + 's / off ' + o.offDelay + 's / reboot ' + o.rebootDelay + 's · power-on: ' + (o.poaAction || '?');
      tdName.appendChild(cfg); tr.appendChild(tdName);
      // Editable PDU label.
      const tdLabel = document.createElement('td');
      const lin = document.createElement('input'); lin.type = 'text'; lin.value = o.label || ''; lin.style.width = '150px'; lin.disabled = !enabled;
      const setBtn = btn('Set'); setBtn.disabled = !enabled; setBtn.style.marginLeft = '6px';
      setBtn.onclick = () => setLabel(o, lin.value);
      tdLabel.appendChild(lin); tdLabel.appendChild(setBtn);
      // Reset only shows when a label is actually set; clears it back to the PDU default.
      if ((o.label || '').trim()) {
        const resetBtn = btn('Reset', 'danger'); resetBtn.disabled = !enabled; resetBtn.style.marginLeft = '4px';
        resetBtn.onclick = () => { if (confirm('Clear the label for outlet ' + o.number + '?')) setLabel(o, ''); };
        tdLabel.appendChild(resetBtn);
      }
      tr.appendChild(tdLabel);
      const tdState = document.createElement('td');
      const dot = document.createElement('span'); dot.className = 'dot ' + (o.state === 'on' ? 'good' : 'bad'); tdState.appendChild(dot);
      tdState.appendChild(document.createTextNode(o.state || '?')); tr.appendChild(tdState);
      const tdAct = document.createElement('td');
      [['On', 'on'], ['Off', 'off'], ['Reboot', 'reboot'], ['Reset Stats', 'resetstats']].forEach(([lab, a]) => {
        const b = btn(lab, a === 'off' ? 'danger' : ''); b.disabled = !enabled; b.style.marginRight = '6px'; b.onclick = () => act(o, a); tdAct.appendChild(b);
      });
      tr.appendChild(tdAct); tb.appendChild(tr);
    });
    t.appendChild(tb); tableWrap.innerHTML = ''; tableWrap.appendChild(t);
  };
  const load = async () => {
    const r = await api(withInstance('/api/control/outlets', instSel));
    if (!r.body.ok) { tableWrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load outlets.') + '</div>'; return; }
    rows = r.body.outlets || []; groups = r.body.groups || []; devices = r.body.devices || []; enabled = !!r.body.actionsEnabled;
    warn.style.display = enabled ? 'none' : 'block'; drawGroups(); drawDevices(); draw();
  };
  refresh.onclick = load; filter.oninput = draw;
  link.onclick = () => { activate(link, sec); load(); };
}

// ── sections/livedata.ts ────────────────────────────────────────
// A read-only view of the current readings being pulled from the PDU(s).

function addLiveDataSection(nav     , sections     ) {
  const link = navLink(nav, "Live Data", "∿");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Live Data'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc'; d.textContent = 'Current measurements pulled from the PDU(s) on each poll.'; sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const viewSel = document.createElement('select');
  [['grouped', 'Grouped (by outlet)'], ['flat', 'Flat (one row per reading)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; viewSel.appendChild(o); });
  const filter = document.createElement('input'); filter.type = 'text'; filter.placeholder = 'Filter (device / outlet / measurement)…';
  // Live is the default now that the server pushes (#281): the table simply keeps up with the poller
  // instead of asking you to opt into a 5-second refresh.
  const autoLab = document.createElement('label'); const auto = document.createElement('input');
  auto.type = 'checkbox'; auto.className = 'switch'; auto.checked = true;
  autoLab.appendChild(auto); autoLab.appendChild(document.createTextNode('Live'));
  autoLab.title = 'Follow the readings as they arrive. Turn off to freeze the table while you read it.';
  const count = document.createElement('span'); count.className = 'ld-count';
  const instSel = instanceSelector(() => { syncLive(); load(); });
  bar.appendChild(refresh); bar.appendChild(instSel.wrap); bar.appendChild(viewSel); bar.appendChild(filter); bar.appendChild(autoLab); bar.appendChild(count);
  sec.appendChild(bar);
  const tableWrap = document.createElement('div'); sec.appendChild(tableWrap);
  const groupsWrap = document.createElement('div'); sec.appendChild(groupsWrap);

  let body      = { entities: [], types: [], units: {}, readings: [], groups: [] }, timer      = null;

  // Pivoted: one row per outlet/entity, a column per measurement type, grouped by device.
  const drawGrouped = () => {
    const f = filter.value.trim().toLowerCase();
    const types = body.types || [];
    const ents = (body.entities || []).filter((e     ) => !f || (e.device + ' ' + e.source + ' ' + types.join(' ')).toLowerCase().includes(f));
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    const cols = ['Outlet / entity', 'State', ...types.map((ty        ) => ty + (body.units[ty] ? ' (' + body.units[ty] + ')' : ''))];
    cols.forEach((x        , i        ) => { const th = document.createElement('th'); th.textContent = x; if (i >= 2) th.className = 'num'; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    let lastDevice      = null;
    ents.forEach((e     ) => {
      if (e.device !== lastDevice) {
        lastDevice = e.device;
        const dr = document.createElement('tr'); const dtd = document.createElement('td'); dtd.colSpan = cols.length;
        dtd.textContent = e.device; dtd.style.cssText = 'font-weight:600;background:var(--panel);color:var(--accent)';
        dr.appendChild(dtd); tb.appendChild(dr);
      }
      const tr = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = (e.number ? '#' + e.number + ' ' : '') + (e.source || ''); tr.appendChild(name);
      const st = document.createElement('td');
      if (e.kind === 'outlet' && e.state) { const dot = document.createElement('span'); dot.className = 'dot ' + (e.state === 'on' ? 'good' : 'bad'); st.appendChild(dot); st.appendChild(document.createTextNode(e.state)); }
      else { st.textContent = '—'; st.style.color = 'var(--muted)'; }
      tr.appendChild(st);
      types.forEach((ty        ) => { const td = document.createElement('td'); td.className = 'num'; const v = (e.values || {})[ty]; td.textContent = (v == null) ? '' : formatNum(v); tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); tableWrap.innerHTML = ''; tableWrap.appendChild(t);
  };

  const drawFlat = () => {
    const f = filter.value.trim().toLowerCase();
    const rows = (body.readings || []).filter((r     ) => !f || (r.device + ' ' + r.source + ' ' + r.type).toLowerCase().includes(f));
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Device', 'Outlet / entity', 'Measurement', 'Value', 'Units'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    rows.forEach((r     ) => {
      const tr = document.createElement('tr');
      [r.device, r.source, r.type, formatNum(r.value), r.units || ''].forEach((c, i) => { const td = document.createElement('td'); if (i === 3) td.className = 'num'; td.textContent = c; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); tableWrap.innerHTML = ''; tableWrap.appendChild(t);
  };

  // OneView group rollups — one row per group, a column per measurement type showing the group
  // total (Sum, falling back to Avg), flanked by Min/Max columns for types whose members vary.
  const drawGroupRollups = () => {
    groupsWrap.innerHTML = '';
    const gs = body.groups || [];
    if (!gs.length) return;
    const f = filter.value.trim().toLowerCase();
    const shown = gs.filter((g     ) => !f || (g.name || '').toLowerCase().includes(f));
    if (!shown.length) return;
    // Union of measurement types (+ units) across all groups, for stable columns. A type whose members
    // vary gets Min/Max columns flanking its total (e.g. Min | realPower (W) | Max).
    const types           = []; const units      = {}; const spread      = {};
    gs.forEach((g     ) => (g.measurements || []).forEach((m     ) => {
      if (!types.includes(m.type)) types.push(m.type);
      if (m.units && !units[m.type]) units[m.type] = m.units;
      if (m.min != null && m.max != null) spread[m.type] = true;
    }));
    types.sort();
    // Flatten types into ordered columns.
    const cols        = [];
    types.forEach(ty => {
      if (spread[ty]) cols.push({ ty, kind: 'min', label: 'Min' });
      cols.push({ ty, kind: 'val', label: ty + (units[ty] ? ' (' + units[ty] + ')' : '') });
      if (spread[ty]) cols.push({ ty, kind: 'max', label: 'Max' });
    });
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['OneView group', ...cols.map(c => c.label)].forEach((x, i) => { const th = document.createElement('th'); th.textContent = x; if (i >= 1) th.className = 'num'; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    shown.forEach((g     ) => {
      const byType      = {}; (g.measurements || []).forEach((m     ) => byType[m.type] = m);
      const tr = document.createElement('tr');
      const gtd = document.createElement('td'); gtd.textContent = g.name; gtd.style.fontWeight = '600'; tr.appendChild(gtd);
      cols.forEach(c => {
        const td = document.createElement('td'); td.className = 'num';
        const m = byType[c.ty];
        if (m) {
          const v = c.kind === 'min' ? m.min : c.kind === 'max' ? m.max : (m.sum != null ? m.sum : m.avg);
          td.textContent = (v == null) ? '' : formatNum(v);
          if (c.kind === 'val' && m.avg != null) td.title = c.ty + ' avg ' + formatNum(m.avg);
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    const hh = document.createElement('div'); hh.className = 'desc'; hh.style.marginTop = '12px'; hh.textContent = 'OneView groups (rollups — group totals, with per-member Min/Max):'; groupsWrap.appendChild(hh);
    t.appendChild(tb); groupsWrap.appendChild(t);
  };
  const draw = () => { (viewSel.value === 'flat' ? drawFlat : drawGrouped)(); drawGroupRollups(); };

  // One place to take a payload, whether it was fetched or pushed.
  const accept = (payload     ) => {
    if (!payload || !payload.ok) {
      tableWrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + ((payload && payload.message) || 'Could not load live data.') + '</div>';
      groupsWrap.innerHTML = ''; count.textContent = '';
      return;
    }
    body = payload;
    count.textContent = (body.entities || []).length + ' outlets/entities · ' + (body.readings || []).length + ' readings · ' + (body.groups || []).length + ' groups';
    draw();
  };
  const load = async () => accept((await api(withInstance('/api/livedata', instSel))).body);

  refresh.onclick = load;
  filter.oninput = draw;
  viewSel.onchange = draw;

  // Pushed while the tab is open and Live is on; the key carries the selected instance, so switching
  // PDUs re-subscribes rather than re-polls.
  const syncLive = liveWhileActive(sec, () => (auto.checked ? 'livedata' + (instSel.get() ? ':' + instSel.get() : '') : ''), accept);
  auto.onchange = () => syncLive();
  // The polling fallback: it only fires when this tab is open, Live is on, and the push stream is not
  // up — so it costs nothing in the normal case but the table still moves without one.
  timer = setInterval(() => {
    if (sec.classList.contains('active') && auto.checked && !realtimeLive()) load();
  }, 5000);
  link.onclick = () => { activate(link, sec); syncLive(); load(); };
}

// ── sections/flow.ts ────────────────────────────────────────────
// The Sankey: the energy hierarchy drawn as ribbons for one metric at one moment.

// The vocabulary — metrics, node kinds, modes, source types, Modbus shapes — is in flow-vocabulary.ts.

// Editing a node — the form, the topic picker, the Modbus explorer, the rename — is in node-editor.ts.

// Bring an EnergyFlow config up to the current shape in place (idempotent).
function migrateEnergyFlow(flow     ) {
  const links = ensure(flow, 'Links', []);
  const legacy = ensure(flow, 'Parents', {});
  if (Object.keys(legacy).length) {
    Object.entries(legacy).forEach(([child, parent]) => { if (parent && child && !links.some((l     ) => l.From === parent && l.To === child)) links.push({ From: parent, To: child }); });
    Object.keys(legacy).forEach(k => delete legacy[k]);
  }
  ensure(flow, 'Nodes', []).forEach((n     ) => {
    if (n.Mqtt && n.Mqtt.length) { n.Sources = (n.Sources || []).concat(n.Mqtt.map((s     ) => ({ Type: 'mqtt', ...s }))); delete n.Mqtt; }
    if (n.Value != null && (!n.Mode || n.Mode === 'auto')) n.Mode = 'static';
  });
}

// Save the whole config (both tabs edit the shared EnergyFlow object; either Save persists everything).
async function saveConfig(onSaved            ) {
  const payload = exportData();
  const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const ok = r.ok && r.body.ok;
  toast(r.body.message || (ok ? 'Saved.' : 'Save failed.'), ok);
  // This writes the same document the shell's save bar tracks, so re-baseline here too.
  if (ok) { setBaseline(payload); onSaved(); }
}

const CONTRADICTION_SHARE = 0.25;

function addFlowSection(nav     , sections     ) {
  const link = navLink(nav, "Flow", "⇄");
  // Both tabs edit the shared EnergyFlow object, so their nav entries carry its unsaved-edit count.
  link.dataset.section = "EnergyFlow";
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Energy Flow'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Live power flow (from the latest poll). Outlet→PDU is auto-derived; add upstream nodes (panels, breakers, a “Total”) and drag to set each node’s feeder to model the full hierarchy. Link width is proportional to the measurement.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());
  // Which measurement the flow is drawn by — link widths follow it.
  const metricSel = el('select', { title: 'Draw the flow by this measurement.' })                     ;
  [['realpower', 'Power (W)'], ['energytoday', 'Energy today (kWh)'], ['energy', 'Energy, lifetime (kWh)'],
   ['apparentpower', 'Apparent (VA)'], ['current', 'Current (A)']]
    .forEach(([v, t]) => metricSel.appendChild(el('option', { value: v, text: t })));
  const count = document.createElement('span'); count.className = 'ld-count';
  // What window "today" actually means, next to the selector that chose it.
  const animKey = 'rpdu2mqtt.flow.animate';
  const animateFlow = () => localStorage.getItem(animKey) === '1';

  const dayNote = el('span', { class: 'ld-count' })               ;
  dayNote.style.cssText = 'margin-left:8px';
  const showDayNote = async () => {
    dayNote.textContent = '';
    dayNote.removeAttribute('title');
    if (metricSel.value !== 'energytoday') return;
    let p     ;
    try { p = (await api('/api/time')).body?.period; } catch { return; }
    if (!p) return;
    if (!p.tracked) {
      dayNote.textContent = '· daily totals are not being tracked';
      dayNote.style.color = 'var(--warn, #d08700)';
      dayNote.title = 'Set EnergyFlow.Aggregation.TrackPeriods to on. Without it nothing re-bases the counters, and this view has no data to draw.';
      return;
    }
    const hrs = Math.floor(p.secondsUntilRollover / 3600), mins = Math.round(p.secondsUntilRollover % 3600 / 60);
    dayNote.textContent = `· day ${p.key} in ${p.zone}, rolls in ${hrs ? hrs + 'h ' : ''}${mins}m`;
    dayNote.style.color = p.configured && p.resolved ? '' : 'var(--warn, #d08700)';
    dayNote.title = !p.resolved
      ? `The configured zone "${p.configured}" did not resolve on the server; it is using ${p.zone} instead.`
      : p.configured
        ? `Every figure below covers ${p.key} in ${p.zone}, starting ${String(p.startHour).padStart(2, '0')}:00. Server time there is now ${String(p.time).replace('T', ' ').slice(0, 16)}.`
        : `No period time zone is configured, so the server's own zone (${p.zone}) is used — in a container that is usually UTC, which is unlikely to be the day you mean. Set EnergyFlow.Aggregation.PeriodTimeZone.`;
  };
  metricSel.onchange = () => { load(); showDayNote(); };
  bar.appendChild(refresh); bar.appendChild(el('label', { class: 'ld-inst' }, 'Show ', metricSel)); bar.appendChild(instSel.wrap); bar.appendChild(count); bar.appendChild(dayNote); sec.appendChild(bar);
  // Picking a whole day asks an energy question — power at 23:59:59 of a day gone by says almost nothing —
  let hadDay = false;
  const hist = historyControl((what     ) => {
    periods.mark(null);
    // Only on the way out of live.
    const leftLive = what === 'day' && !hadDay && !!hist.day();
    hadDay = !!hist.day();
    // Only the daily total can be added across days, so asking for a span asks for that metric.
    if ((leftLive && !hist.time() && metricSel.value === 'realpower') || (what === 'span' && hist.span() > 1)) {
      if (metricSel.value !== 'energytoday') metricSel.value = 'energytoday';
      showDayNote();
    }
    load();
  });
  // One click for the periods people actually ask for, as on the Energy and Trends pages. A period is a
  // question about energy — "how much yesterday" — so it answers in energy rather than leaving a power
  // reading under a heading about a month.
  const periods = periodRow((key           ) => {
    const { day, days } = periodWindow(key);
    hist.set(day, days);
    if (metricSel.value !== 'energytoday') { metricSel.value = 'energytoday'; showDayNote(); }
    periods.mark(key);
    hadDay = true;
    load();
  });
  sec.appendChild(periods.row);
  sec.appendChild(hist.row);
  const wrap = document.createElement('div'); sec.appendChild(wrap);

  // Each job below the diagram gets its own page under Energy Flow, so the Flow page is the diagram.
  const subPage = (label        , icon        , desc        ) => {
    const l = navLink(nav, label, icon);
    l.classList.add('nav-child');
    // These edit the same EnergyFlow document as the Flow and Nodes pages, so they carry its edit count.
    l.dataset.section = 'EnergyFlow';
    const s = document.createElement('div'); s.className = 'section'; sections.appendChild(s);
    s.appendChild(el('h2', { text: label }));
    s.appendChild(el('div', { class: 'desc', text: desc }));
    const body = document.createElement('div'); s.appendChild(body);
    return { link: l, sec: s, body };
  };

  const treePage = subPage('Roll-up', '∑',
    'What each node rolls up, per metric: measured leaves report their source, aggregates sum their children, residuals take the remainder.');
  const treePanel = treePage.body;
  const edPage = subPage('Hierarchy', '⑃',
    'How the nodes are wired together. Energy flows left → right.');
  const ed      = edPage.body;
  const settingsPage = subPage('Settings', '⚙',
    'Everything that governs the energy roll-up and its export. These were scattered across the pages they affected.');
  let lastGraph      = null;
  // Bindings the server is dropping on purpose.
  let withheldSources        = [];

  // Collapsing/expanding a group must move both graphs together (they share the collapse state).
  const redrawBoth = () => { if (lastGraph) draw(lastGraph); renderTree(); };

  // Each configured node's rolled-up value.
  const renderTree = async () => {
    treePanel.innerHTML = '';
    let r     ; try { r = await api('/api/flow/tree'); } catch { r = { body: { ok: false } }; }
    if (!r.body || !r.body.ok) {
      const dd = document.createElement('div'); dd.className = 'desc';
      dd.textContent = 'Node tree unavailable' + (r.body && r.body.message ? ': ' + r.body.message : ' (single-node cluster or nothing provisioned yet).');
      treePanel.appendChild(dd); return;
    }
    const nodes = r.body.nodes || [];
    if (!nodes.length) {
      const dd = document.createElement('div'); dd.className = 'desc';
      dd.textContent = 'No node values yet — add energy-flow nodes and feed a source; they are rolled up here.';
      treePanel.appendChild(dd); return;
    }

    ensureGroupState();
    const toggles = groupToggles(redrawBoth, false);
    if (toggles) treePanel.appendChild(toggles);

    const t = document.createElement('table'); t.className = 'ld';
    const hr = document.createElement('tr'); ['Node', 'Rolled-up values'].forEach(x => { const th = document.createElement('th'); th.textContent = x; hr.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(hr); t.appendChild(thead);
    const tb = document.createElement('tbody');

    const metricsText = (metrics       ) => (metrics || []).map((m     ) => m.metric + ': ' + formatNum(m.value)).join(', ');
    const byNode      = {}; nodes.forEach((n     ) => { byNode[n.node] = n; });

    const row = (label        , metrics       , opts                                       ) => {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td'); c1.textContent = label;
      if (opts?.indent) c1.style.paddingLeft = '24px';
      if (opts?.head) c1.style.fontWeight = '600';
      const c2 = document.createElement('td'); c2.style.cssText = 'color:var(--muted);font-size:12px;';
      c2.textContent = metricsText(metrics);
      tr.appendChild(c1); tr.appendChild(c2); tb.appendChild(tr);
    };

    // Sum a group's members per metric — only members that actually have a value.
    const groupMetrics = (g     ) => {
      const sums                         = {};
      (g.Members || []).forEach((m        ) => (byNode[m]?.metrics || []).forEach((mm     ) => { sums[mm.metric] = (sums[mm.metric] || 0) + mm.value; }));
      return Object.entries(sums).map(([metric, value]) => ({ metric, value }));
    };

    // Members are shown under their group (summed when collapsed, listed when expanded), never twice.
    const allMembers = new Set        ();
    flowGroups().forEach((g     ) => (g.Members || []).forEach((m        ) => allMembers.add(m)));

    nodes.forEach((n     ) => { if (!allMembers.has(n.node)) row(n.node, n.metrics); });

    flowGroups().forEach((g     ) => {
      row((g.Label || g.Id) + '  (group)', groupMetrics(g), { head: true });
      if (!collapsedGroups.has(g.Id))
        (g.Members || []).forEach((m        ) => { if (byNode[m]) row(byNode[m].node, byNode[m].metrics, { indent: true }); });
    });

    t.appendChild(tb); treePanel.appendChild(t);
  };

  // Layered Sankey: columns = longest path from a root (energy flows left->right, parent->child).
  const draw = (graph     ) => {
    wrap.innerHTML = '';
    ensureGroupState();
    // Fold collapsed groups into single nodes before laying out; the toggle strip re-draws on change.
    const collapsed = collapseGraph((graph.nodes || []).slice(), (graph.links || []).slice());
    // ...then substitute the members for the anchor on any group left expanded.
    const expanded = explodeExpandedGroups(collapsed.nodes, collapsed.links);
    // ...then honour the unmetered-remainder view switch...
    const shown = applyUnmeasuredPref(expanded.nodes, expanded.links);
    // ...and finally drop the branches carrying nothing, if that switch is on.
    const folded = applyHideEmptyPref(shown.nodes, shown.links);
    const toggles = groupToggles(redrawBoth);
    if (toggles) wrap.appendChild(toggles);
    const links = folded.links;
    const nodes = folded.nodes;
    if (!links.length) { wrap.innerHTML = '<div class="desc" style="color:var(--muted)">No measured power flow to display. Define an EnergyFlow hierarchy, or check that outlets report power.</div>'; count.textContent = ''; return; }

    const units = graph.units || '';
    // Which metric is actually on screen.
    const lifetimeEnergy = String(graph.metric || metricSel.value || '').toLowerCase() === 'energy';
    const incoming      = {}, outgoing      = {};
    nodes.forEach((n     ) => { incoming[n.id] = []; outgoing[n.id] = []; });
    links.forEach((l     ) => { (outgoing[l.source] = outgoing[l.source] || []).push(l); (incoming[l.target] = incoming[l.target] || []).push(l); });
    // The server decides a node's value and, crucially, whether one is known at all.
    const byId      = {};
    nodes.forEach((n     ) => { byId[n.id] = n; });
    const known = (id        ) => byId[id] && byId[id].value != null;
    const nodeValue = (id        ) => known(id) ? byId[id].value : 0;

    // Column index = longest path from a root (a node with no incoming links).
    const colMemo      = {};
    const col = (id        , seen              )         => {
      if (colMemo[id] != null) return colMemo[id];
      seen = seen || new Set();
      if (seen.has(id)) return 0;
      seen.add(id);
      const ins = incoming[id] || [];
      const c = ins.length ? Math.max(...ins.map((l     ) => col(l.source, seen) + 1)) : 0;
      seen.delete(id);
      return colMemo[id] = c;
    };
    nodes.forEach((n     ) => col(n.id));

    // Then pull every node as far RIGHT as its nearest child allows, so it lands next to what it powers.
    nodes.slice().sort((a     , b     ) => colMemo[b.id] - colMemo[a.id]).forEach((n     ) => {
      const outs = outgoing[n.id] || [];
      if (outs.length) colMemo[n.id] = Math.max(0, Math.min(...outs.map((l     ) => colMemo[l.target])) - 1);
    });
    // Never leave an empty left margin if every node pulled off column 0.
    const minCol = Math.min(...nodes.map((n     ) => colMemo[n.id]));
    if (minCol > 0) nodes.forEach((n     ) => { colMemo[n.id] -= minCol; });

    const maxCol = Math.max(0, ...nodes.map((n     ) => colMemo[n.id]));

    const cols        = [];
    nodes.forEach((n     ) => { const c = colMemo[n.id]; (cols[c] = cols[c] || []).push(n); });

    const W = 960, padTop = 22, gap = 8, nodeW = 12, usableH = 520;
    // Labels sit to the right of each node, so reserve a right gutter for them and only a small left pad.
    const leftPad = 16, rightGutter = 232;
    // What the node has to be tall enough to carry: its own reading.
    const throughput = (id        ) => {
      let inSum = 0, outSum = 0;
      (incoming[id] || []).forEach((l     ) => { if (l.known !== false) inSum += l.value || 0; });
      (outgoing[id] || []).forEach((l     ) => { if (l.known !== false) outSum += l.value || 0; });
      return Math.max(nodeValue(id) || 0, inSum, outSum);
    };

    const maxTotal = Math.max(1, ...cols.map(cn => cn.reduce((s        , n     ) => s + throughput(n.id), 0)));
    const pxPerUnit = usableH / maxTotal;
    const colX = (c        ) => leftPad + (maxCol > 0 ? c * ((W - leftPad - rightGutter - nodeW) / maxCol) : 0);

    const pos      = {};
    // Every node's label needs a full text line, whatever its bar height.
    const labelRow = 15;
    // A link's pull on the layout.
    const wFloor = maxTotal / 1000;
    const linkW = (l     ) => Math.max(l.value || 0, wFloor);
    // Barycenter of the feeders that are already positioned (forward pass) …
    const bary = (id        ) => { let w = 0, s = 0; (incoming[id] || []).forEach((l     ) => { const sp = pos[l.source]; if (sp) { s += (sp.y + sp.h / 2) * linkW(l); w += linkW(l); } }); return w ? s / w : Infinity; };
    // … and of what it feeds (backward pass), so a source column can be pulled level with its targets.
    const obary = (id        ) => { let w = 0, s = 0; (outgoing[id] || []).forEach((l     ) => { const tp = pos[l.target]; if (tp) { s += (tp.y + tp.h / 2) * linkW(l); w += linkW(l); } }); return w ? s / w : Infinity; };

    // Stack one column top-to-bottom in its current order; returns the y it ended at.
    const placeColumn = (cn       , c        ) => {
      let y = padTop;
      cn.forEach((n     ) => {
        // Bar height is proportional to what actually passes THROUGH the node, not to its own reading.
        const h = known(n.id) ? Math.max(2, throughput(n.id) * pxPerUnit) : 3;
        const rowH = Math.max(h, labelRow);
        pos[n.id] = { x: colX(c), y: y + (rowH - h) / 2, h, outOff: 0, inOff: 0 };
        y += rowH + gap;
      });
      return y;
    };

    // The unmetered remainder sits below its measured SIBLINGS (#366) — the ones fed by the same node, not
    // every measured node in the column. Sorting it below the whole column is what put PDU-1's remainder
    // underneath PDU-2's devices, so its ribbon had to cross every one of them to get there. The feeder
    // barycenter therefore leads: it groups each parent's children together, and the remainder settles at
    // the bottom of its own group.
    const remainder = (id        ) => (id || '').includes('#unmeasured') ? 1 : 0;

    // Forward: roots stack by size, downstream columns follow their feeders (groups children, avoids crossings).
    cols.forEach((cn, c) => {
      if (c === 0) cn.sort((a     , b     ) => remainder(a.id) - remainder(b.id) || nodeValue(b.id) - nodeValue(a.id));
      else cn.sort((a     , b     ) => (bary(a.id) - bary(b.id)) || (remainder(a.id) - remainder(b.id)) || (nodeValue(b.id) - nodeValue(a.id)));
      placeColumn(cn, c);
    });
    // Backward: right-to-left, order each column by what it feeds.
    for (let c = cols.length - 2; c >= 0; c--) {
      if (!cols[c]) continue;
      cols[c].sort((a     , b     ) => (obary(a.id) - obary(b.id)) || (remainder(a.id) - remainder(b.id)) || (nodeValue(b.id) - nodeValue(a.id)));
      placeColumn(cols[c], c);
    }
    // Re-place left-to-right in the settled order so every column shares one top edge and the offsets reset.
    let bottom = padTop;
    cols.forEach((cn, c) => { bottom = Math.max(bottom, placeColumn(cn, c)); });

    // Then slide each column bodily down to meet what it feeds.
    /// Where each ribbon actually meets each bar, in the order they are drawn.
    ///
    /// A ribbon leaves a bar at `y + outOff` and arrives at `y + inOff`, both accumulating from the TOP of
    /// the bar. Relaxing a column toward its neighbours' bar CENTRES therefore aims at a point no ribbon
    /// touches: a 3,012 W panel whose drawn children total 875 W carries all of them in the top sixth of
    /// its bar, and its children get pulled to the middle of a bar they never reach.
    const attachments = () => {
      const at = new Map                                   ();
      const outOff                         = {}, inOff                         = {};
      [...links]
        .sort((a     , b     ) =>
          (pos[a.target]?.y ?? 0) - (pos[b.target]?.y ?? 0) ||
          (pos[a.source]?.y ?? 0) - (pos[b.source]?.y ?? 0))
        .forEach((l     ) => {
          const sp = pos[l.source], tp = pos[l.target];
          if (!sp || !tp) return;
          const h = l.known === false || l.value * pxPerUnit < 1.5 ? 1.5 : l.value * pxPerUnit;
          const so = outOff[l.source] || 0, to = inOff[l.target] || 0;
          at.set(l, { from: sp.y + so + h / 2, to: tp.y + to + h / 2 });
          outOff[l.source] = so + h;
          inOff[l.target] = to + h;
        });
      return at;
    };

    const relaxOrder = [...Array(cols.length).keys()].reverse().concat([...Array(cols.length).keys()]);
    for (const c of relaxOrder) {
      const cn = cols[c];
      if (!cn || !cn.length) continue;
      const at = attachments();
      let w = 0, s = 0;
      cn.forEach((n     ) => {
        // Both sides, not just what it feeds, and each side measured where the ribbon lands.
        (outgoing[n.id] || []).forEach((l     ) => {
          const a = at.get(l);
          if (!a) return;
          s += (a.to - a.from) * linkW(l);
          w += linkW(l);
        });
        (incoming[n.id] || []).forEach((l     ) => {
          const a = at.get(l);
          if (!a) return;
          s += (a.from - a.to) * linkW(l);
          w += linkW(l);
        });
      });
      if (!w) continue;
      // Never above the top margin, and never so far down that the column leaves the canvas.
      const top = Math.min(...cn.map((n     ) => pos[n.id].y));
      const foot = Math.max(...cn.map((n     ) => pos[n.id].y + pos[n.id].h));
      const shift = Math.max(padTop - top, Math.min(s / w, Math.max(padTop, bottom) - foot));

      // Only rescue a column that has genuinely come adrift; leave a well-placed one alone.
      const reach = Math.max(8, (foot - top) / 2);
      if (Math.abs(shift) < reach) continue;
      cn.forEach((n     ) => { pos[n.id].y += shift; });
    }

    // Fit the viewBox to the tallest column (stacking gaps push it past usableH), so nothing clips.
    const totalH = Math.ceil(Math.max(padTop + usableH, bottom)) + padTop;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${totalH}`, width: W, height: totalH, style: 'display:block' });
    const colors = ['#49f', '#4f9', '#fa4', '#f49', '#9f4', '#4ff', '#f94', '#a9f'];
    // Clicking the empty canvas is the natural "never mind"; a redraw starts unfocused either way.
    svg.addEventListener('click', () => clearFocus(svg));
    focusedNode = null;

    // Ribbons (filled bezier bands).
    let flowClipSeq = 0;
    links.sort((a     , b     ) =>
      (pos[a.target]?.y ?? 0) - (pos[b.target]?.y ?? 0) ||
      (pos[a.source]?.y ?? 0) - (pos[b.source]?.y ?? 0)
    ).forEach((l     ) => {
      const s = pos[l.source], t = pos[l.target];
      if (!s || !t) return;
      // An unknown link draws as a hairline: the wiring is real, the quantity isn't known.
      const unknownLink = l.known === false;
      const idleLink = !unknownLink && l.value * pxPerUnit < 1.5;
      const h = (unknownLink || idleLink) ? 1.5 : l.value * pxPerUnit;
      const x1 = s.x + nodeW, x2 = t.x, xc = (x1 + x2) / 2;
      const sTop = s.y + s.outOff, tTop = t.y + t.inOff;
      const color = colors[colMemo[l.source] % colors.length];
      const ribbonPath = `M${x1},${sTop} C${xc},${sTop} ${xc},${tTop} ${x2},${tTop} L${x2},${tTop + h} C${xc},${tTop + h} ${xc},${sTop + h} ${x1},${sTop + h} Z`;
      svg.appendChild(svgEl('path', {
        d: ribbonPath,
        fill: unknownLink ? 'var(--muted)' : color,
        // A hairline at ribbon opacity is invisible; lift it so an idle branch still reads as connected.
        'fill-opacity': unknownLink ? '0.35' : idleLink ? '0.55' : '0.3',
        // Endpoints in the markup so focusing a supply path is a CSS class flip, not a repaint.
        'data-src': l.source, 'data-dst': l.target,
      }));

      // A stream drawn along the ribbon's centre line.
      if (animateFlow() && !unknownLink && !idleLink) {
        // The stream is the band, not a line drawn down the middle of it.
        const clipId = `fs${flowClipSeq++}`;
        const clip = svgEl('clipPath', { id: clipId });
        clip.appendChild(svgEl('path', { d: ribbonPath }));
        svg.appendChild(clip);

        // Lanes of thin particles, not one stroke as tall as the band.
        const lanes = Math.max(1, Math.min(6, Math.round(h / 16)));
        const laneW = Math.max(1.5, Math.min(3.5, (h / lanes) * 0.4));
        // Faster where the flow is denser, clamped either side so nothing crawls or strobes.
        const intensity = l.value / Math.max(1, maxTotal);
        const duration = Math.max(0.9, Math.min(6, 3.2 - intensity * 9));

        for (let i = 0; i < lanes; i++) {
          const f = (i + 0.5) / lanes;                       // this lane's position across the band
          const sY = sTop + h * f, tY = tTop + h * f;
          const stream = svgEl('path', {
            d: `M${x1},${sY} C${xc},${sY} ${xc},${tY} ${x2},${tY}`,
            fill: 'none', stroke: color, 'stroke-opacity': lanes > 1 ? '0.42' : '0.5',
            'stroke-width': laneW,
            'stroke-linecap': 'round',
            'stroke-dasharray': '9 31',
            'clip-path': `url(#${clipId})`,
            class: 'flow-stream',
            'data-src': l.source, 'data-dst': l.target,
          });
          stream.style.animationDuration = `${duration.toFixed(2)}s`;
          // Stagger the lanes so they read as a current rather than as one blinking comb.
          stream.style.animationDelay = `${(-duration * (i / Math.max(1, lanes))).toFixed(2)}s`;
          svg.appendChild(stream);
        }
      }

      s.outOff += h; t.inOff += h;
    });

    // A group reads like a node: click the group node to toggle it.
    const memberGroup                      = {};
    const groupById                      = {};
    flowGroups().forEach((g     ) => { groupById[g.Id] = g; (g.Members || []).forEach((m        ) => { memberGroup[m] = g; }); });

    // Nodes + labels, to the right of each node and vertically centered, with a bg halo over ribbons.
    const contradicted                                                 = [];
    nodes.forEach((n     ) => {
      const p = pos[n.id]; if (!p) return;
      const unknownNode = !known(n.id);
      const rect = svgEl('rect', {
        x: p.x, y: p.y, width: nodeW, height: p.h, rx: 2,
        fill: unknownNode ? 'var(--muted)' : colors[colMemo[n.id] % colors.length],
        'fill-opacity': unknownNode ? '0.45' : '1',
        'data-node': n.id,
      });
      svg.appendChild(rect);
      const lab = svgEl('text', {
        x: p.x + nodeW + 6, y: p.y + p.h / 2, fill: 'var(--fg)', 'font-size': '11', 'font-weight': n.kind === 'outlet' ? '400' : '600',
        'dominant-baseline': 'middle', 'paint-order': 'stroke', stroke: 'var(--panel2)', 'stroke-width': '3', 'stroke-linejoin': 'round',
        'data-node': n.id,
      });
      // A <title> must not be a child of <text>: its text node would become part of the <text> element's content.
      const labGroup = svgEl('g', {});
      const explain = (text        ) => {
        const t = svgEl('title');
        t.textContent = text;
        labGroup.appendChild(t);
      };
      // An inferred figure is never dressed as a measured one.
      const inferredNode = n.derivation === 'inferred';
      lab.textContent = unknownNode ? `${n.label} · no data`
        : `${n.label} · ${formatNum(nodeValue(n.id))} ${units}${inferredNode ? ' · inferred' : ''}`;
      if (unknownNode) {
        lab.setAttribute('fill', 'var(--muted)');
        lab.setAttribute('font-style', 'italic');
        explain('Nothing measures this node, and no single path determines it. Bind a live source to it, or mark one of its feeders as "residual" to say where the remainder comes from.');
      }
      // More leaves this node than arrives at it — not a state the hardware can be in.
      else if (inferredNode) {
        lab.setAttribute('font-style', 'italic');
        lab.setAttribute('fill-opacity', '0.85');
        explain('Nothing measures this node. The figure is what conservation requires: the load '
          + 'downstream is really being drawn, and the hierarchy you drew leaves exactly one path it could '
          + 'have arrived by. It is only as true as that hierarchy. Bind a source to measure it, or turn off '
          + '"Infer from a single supply path" under Energy roll-up to show no data instead.');
      }
      else if (n.imbalance != null) {
        lab.textContent += ' ⚠';
        const reading = nodeValue(n.id);
        // Past the line the node is named in a banner above the chart; the number is still shown.
        const share = lifetimeEnergy ? null : contradictionShare(n, reading);
        if (share != null && share >= CONTRADICTION_SHARE) {
          lab.setAttribute('fill', 'var(--warn, #d08700)');
          lab.setAttribute('class', 'flow-contradicted');
          contradicted.push({ id: n.id, label: n.label, share });
        }
        // Two different discrepancies wear the same marker, and they need different sentences.
        explain(n.derivation === 'measured'
          ? `This node reports ${formatNum(reading)} ${units}, but ${formatNum(reading + n.imbalance)} ${units} `
            + `passes through it — ${formatNum(n.imbalance)} ${units} more than it accounts for. Its sensor is `
            + 'probably measuring one leg rather than the whole node (an inverter bound to its AC-load output '
            + 'while it also charges a battery), or a source is scaled wrongly. The bar is drawn to the '
            + 'throughput so the ribbons fit; the label is the reading.'
          : `This node passes ${formatNum(reading)} ${units} to what it feeds, but only `
            + `${formatNum(reading - n.imbalance)} ${units} arrives from its feeders — a shortfall of `
            + `${formatNum(n.imbalance)} ${units}, which no supply accounts for.`
            + (metricSel.value === 'energy'
              ? ' On lifetime energy this is expected: these counters started at different times and cannot be compared. Switch to "Energy today", where every figure covers the same window.'
              : ' Check that the feeders into this node are all wired and reporting.'));
      }
      labGroup.appendChild(lab);
      svg.appendChild(labGroup);

        // Hovering a node explains it: what it is, what it reads, what feeds it and what it feeds.
      const card = () => {
        const rows        = [];
        rows.push(el('div', { class: 'nh-title', text: n.label }));
        rows.push(el('div', { class: 'nh-sub', text: `${n.kind || 'node'} · ${n.id}` }));
        rows.push(el('div', { class: 'nh-value' + (unknownNode ? ' nh-unknown' : '') },
          unknownNode ? 'no data' : `${formatNum(nodeValue(n.id))} ${units}`.trim(),
          el('span', { class: 'nh-metric', text: ' ' + metricLabel(metricSel.value).toLowerCase() })));
        // Provenance sits with the value, not in a legend somewhere else.
        if (!unknownNode && n.derivation && n.derivation !== 'measured')
          rows.push(el('div', { class: n.derivation === 'inferred' ? 'nh-warn' : 'desc', style: { margin: '2px 0 0' } },
            n.derivation === 'inferred'
              ? 'inferred — nothing measures this; conservation leaves one path it could have come by'
              : 'summed from what it feeds'));
        if (n.imbalance != null)
          rows.push(el('div', { class: 'nh-warn', text: `${formatNum(n.imbalance)} ${units} more leaves than arrives` }));
        // A sensor on one leg of a bidirectional device.
        if (n.throughput != null)
          rows.push(el('div', { class: 'desc', style: { margin: '2px 0 0' },
            text: `its sensor covers this leg; ${formatNum(n.throughput)} ${units} passes through the node` }));

        const side = (title        , ls       , other                    ) => {
          if (!ls.length) return;
          rows.push(el('div', { class: 'nh-head', text: title }));
          ls.forEach((l     ) => rows.push(el('div', { class: 'nh-row' },
            el('span', { class: 'nh-name', text: byId[other(l)]?.label || other(l) }),
            el('span', { class: 'nh-num', text: l.known === false ? '—' : `${formatNum(l.value)} ${units}`.trim() }))));
        };
        side('Fed by', incoming[n.id] || [], (l     ) => l.source);
        side('Feeds', outgoing[n.id] || [], (l     ) => l.target);

        // What the node is bound to, so a wrong topic or register is visible from the diagram itself.
        const cfg = (state.data?.EnergyFlow?.Nodes || []).find((x     ) => x.Id === n.id);
        const bound = (cfg?.Sources || []).concat(cfg?.Mqtt ? cfg.Mqtt.map((m     ) => ({ Type: 'mqtt', ...m })) : []);
        if (bound.length) {
          rows.push(el('div', { class: 'nh-head', text: 'Bound sources' }));
          bound.forEach((s     ) => rows.push(el('div', { class: 'nh-row' },
            el('span', { class: 'nh-name', text: metricLabel(s.Metric) }),
            el('span', { class: 'nh-src', text: s.Type === 'modbus' ? `${s.Connection || 'modbus'} reg ${s.Register}` : (s.Topic || '') }))));
        } else if (cfg) {
          rows.push(el('div', { class: 'nh-head', text: cfg.Value != null ? 'Fixed value' : 'No source bound' }));
        }
        return rows;
      };
      [rect, lab].forEach((elm     ) => {
        elm.addEventListener('mouseenter', (e     ) => showNodeCard(sec, e, card()));
        elm.addEventListener('mousemove', (e     ) => moveNodeCard(e));
        elm.addEventListener('mouseleave', hideNodeCard);
      });

      // Click to trace where this node's supply comes from: everything upstream stays lit, the rest dims.
      if (!(n.group || memberGroup[n.id] || groupById[n.id])) {
        [rect, lab].forEach((elm     ) => {
          elm.style.cursor = 'pointer';
          elm.addEventListener('click', (e     ) => { e.stopPropagation?.(); focusPath(svg, incoming, n.id); });
        });
      }

    // Group node (collapsed), an anchor node (expanded), or a member: make the node the expand/collapse control.
      const grp = n.group ? n : (memberGroup[n.id] || groupById[n.id]);
      if (grp) {
        const gid = n.group ? n.id : grp.Id;
        const toggle = () => { collapsedGroups.has(gid) ? collapsedGroups.delete(gid) : collapsedGroups.add(gid); redrawBoth(); };
        [rect, lab].forEach(elm => { elm.style.cursor = 'pointer'; elm.addEventListener('click', toggle); });
        const hint = svgEl('title');
        hint.textContent = n.group ? `“${n.label}” groups ${(grp.Members || []).length} node(s) — click to expand`
          : grp.Id === n.id ? `Group of ${(grp.Members || []).length} node(s) — click to collapse`
          : `In group “${grp.Label || grp.Id}” — click to collapse`;
        rect.appendChild(hint);
        if (n.group) lab.textContent = '▸ ' + lab.textContent;   // an affordance that this node opens up
      }
    });

    // Surface the unknowns rather than leaving them to be spotted.
    const unknownCount = nodes.filter((n     ) => !known(n.id)).length;
    count.textContent = `${nodes.length} node(s) · ${links.length} link(s)`
      + (unknownCount ? ` · ${unknownCount} with no data` : '');
    count.title = unknownCount
      ? 'Nothing measures these nodes, and no single path determines them. Bind a source, or mark a feeder "residual" to say where the remainder comes from — values are never invented for them.'
      : '';
    // Tag chips, above the banners: they change what is emphasised, not what is being reported.
    const taggedById = new Map             (nodes.map((n     ) => [n.id, n]));
    const applyTag = (tag               ) => {
      if (tag) focusTag(svg, taggedById, tag); else clearFocus(svg);
      const fresh = tagToggles(nodes, svg, applyTag);
      if (fresh && tagRow.parentNode) { tagRow.replaceWith(fresh); tagRow = fresh; }
    };
    let tagRow = tagToggles(nodes, svg, applyTag)       ;
    if (tagRow) {
      wrap.appendChild(tagRow);
      // Re-apply across the live repaint, so the selection survives a push.
      if (activeTag) focusTag(svg, taggedById, activeTag);
    }

    if (withheldSources.length) wrap.appendChild(withheldBanner(withheldSources));
    if (contradicted.length) wrap.appendChild(contradictionBanner(contradicted, (id) => focusPath(svg, incoming, id)));

    // No height cap: the diagram is the whole page, so it grows to its own height and the page scrolls once
    // — a pane capped at 74vh put a scrollbar inside a scrollbar and made the graph feel like an iframe.
    const scroll = el('div', { style: { overflow: 'auto', border: '1px solid var(--line)', borderRadius: '6px' } });
    scroll.appendChild(svg);
    const stage = el('div', { class: 'flow-stage' }, scroll);
    wrap.appendChild(stage);

    const zoom = attachZoom(scroll, svg, W, totalH, true);  // container is replaced on each draw(), so no leak.

    // Zoom where the diagram is, not in a toolbar under it: on a graph this size the reader's attention is
    // already inside the pane.
    const zoomBtn = (label        , title        , act            ) => {
      const b = btn(label);
      b.title = title;
      b.onclick = act;
      return b;
    };
    stage.appendChild(el('div', { class: 'flow-zoom' },
      zoomBtn('+', 'Zoom in', () => (zoom       ).zoomBy(1.2)),
      zoomBtn('−', 'Zoom out', () => (zoom       ).zoomBy(1 / 1.2)),
      zoomBtn('⤢', 'Fit the diagram to the page', () => (zoom       ).fit())));

    // The gesture line names what the device can actually do — a phone has neither a wheel nor a Ctrl key,
    // and being told to use them while the diagram sits three screens wide is its own kind of broken.
    const hints = el('div', { class: 'desc flow-gestures', style: { margin: '4px 2px 0', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } });
    const fitBtn = btn('Fit');
    fitBtn.onclick = () => (zoom       ).fit();
    fitBtn.style.padding = '1px 8px';
    fitBtn.style.fontSize = '11px';
    hints.appendChild(fitBtn);
    hints.appendChild(el('span', { text: 'Drag or swipe to pan · pinch to zoom · Ctrl/⌘ + scroll to zoom.' }));
    wrap.appendChild(hints);
  };

  // --- Settings: everything under EnergyFlow that isn't a node, a link or a group.
  const renderSettings = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const agg = ensure(flow, 'Aggregation', {});
    const body = settingsPage.body;
    body.innerHTML = '';

    const bar3 = el('div', { class: 'ld-toolbar' });
    const save = btn('Save', 'primary');
    save.onclick = () => saveConfig(load);
    bar3.append(save); body.appendChild(bar3);

    // MQTT export of the hierarchy (#164): each tier's rolled-up value is published per poll.
    body.appendChild(el('h3', { text: 'MQTT export', style: { margin: '14px 0 4px' } }));
    const exportRow = el('div', { class: 'ld-toolbar' });
    const topicIn = el('input', { type: 'text', placeholder: '{parent}/energyflow/{id}', style: { width: '280px' } });
    topicIn.value = flow.MqttTopicTemplate || '';
    topicIn.disabled = !flow.MqttExport;
    topicIn.onchange = () => { flow.MqttTopicTemplate = topicIn.value.trim() || undefined; refreshDirty(); };
    const expChk = el('input', { type: 'checkbox' }); expChk.checked = !!flow.MqttExport;
    expChk.onchange = () => { flow.MqttExport = expChk.checked; topicIn.disabled = !expChk.checked; refreshDirty(); };
    exportRow.append(el('label', {}, expChk, ' Export tiers to MQTT'), el('span', { class: 'desc', style: { margin: '0' }, text: 'Topic:' }), topicIn);
    body.appendChild(exportRow);

    // How the energy roll-up is accumulated, and when the day ends.
    body.appendChild(el('h3', { text: 'Energy roll-up', style: { margin: '14px 0 4px' } }));
    body.appendChild(el('div', { class: 'desc' },
      'Daily totals re-base every node and outlet at the same moment, so the figures can be compared and summed. '
      + 'Lifetime counters can’t: a PDU’s has run since it was commissioned, a node’s since you bound it. '
      + 'Draw the diagram with Show → “Energy today”.'));

    const aggRow = el('div', { class: 'ld-toolbar' });

    const trackChk = el('input', { type: 'checkbox' })                    ;
    trackChk.checked = agg.TrackPeriods !== false;   // defaults on
    const zoneSel = el('select', { style: { minWidth: '200px' } })                     ;
    const hourSel = el('select')                     ;
    for (let h = 0; h < 24; h++) hourSel.appendChild(el('option', { value: String(h), text: String(h).padStart(2, '0') + ':00' }));
    hourSel.value = String(agg.PeriodStartHour || 0);

    // Zones come from the schema, which the server filled with the ones IT can resolve.
    const zoneNode = (state.schema || []).find((n     ) => n.key === 'EnergyFlow')?.properties
      ?.find((n     ) => n.key === 'Aggregation')?.properties?.find((n     ) => n.key === 'PeriodTimeZone');
    const zones           = zoneNode?.enumValues || [''];
    zones.forEach(z => zoneSel.appendChild(el('option', { value: z, text: z || '(server’s own zone)' })));
    zoneSel.value = agg.PeriodTimeZone || '';

    const syncAgg = () => {
      zoneSel.disabled = hourSel.disabled = !trackChk.checked;
      agg.TrackPeriods = trackChk.checked;
      agg.PeriodTimeZone = zoneSel.value || undefined;
      agg.PeriodStartHour = Number(hourSel.value) || undefined;
      refreshDirty();
      showDayNote();
    };
    trackChk.onchange = zoneSel.onchange = hourSel.onchange = syncAgg;
    zoneSel.disabled = hourSel.disabled = !trackChk.checked;

    aggRow.append(
      el('label', {}, trackChk, ' Track daily totals'),
      el('span', { class: 'desc', style: { margin: '0' }, text: 'Day ends at:' }), hourSel, zoneSel);
    body.appendChild(aggRow);

    // The server's own clock, right where the boundary is set — it is the clock the day is cut on.
    const clock = el('div', { class: 'desc' })               ;
    body.appendChild(clock);
    api('/api/time').then((r     ) => {
      const t = r.body; if (!t || !t.ok || !t.host || !t.period) return;
      const p = t.period;
      clock.textContent = `Server clock: ${String(t.host.time).replace('T', ' ').slice(0, 19)} (${t.host.zone}). `
        + (p.tracked
          ? `Current day ${p.key}, next rollover ${String(p.nextRolloverLocal).replace('T', ' ').slice(0, 16)} ${p.zone}.`
          : 'Daily totals are off, so “Energy today” has nothing to draw.');
      if (p.tracked && !p.resolved) {
        clock.textContent += ` The saved zone "${p.configured}" does not exist on the server — it is using ${p.zone}.`;
        clock.style.color = 'var(--bad, #d05a5a)';
      } else if (p.tracked && !p.configured) {
        clock.textContent += ' No zone set, so the server’s own is used — usually UTC in a container.';
        clock.style.color = 'var(--warn, #d08700)';
      }
    }).catch(() => { });

    body.appendChild(el('h3', { text: 'What the diagram may state', style: { margin: '14px 0 4px' } }));

    // Conservation back-fill. A switch you can see.
    const inferRow = el('div', { class: 'desc' })               ;
    const inferChk = el('input', { type: 'checkbox' })                    ;
    inferChk.checked = flow.InferFromConservation !== false;   // defaults on
    inferChk.onchange = () => { flow.InferFromConservation = inferChk.checked ? undefined : false; refreshDirty(); };
    inferRow.append(el('label', {}, inferChk,
      ' Infer from a single supply path — fill in an unmeasured node from what it feeds, when only one path could have supplied it. Results are labelled “inferred”; off shows “no data”.'));
    body.appendChild(inferRow);

    const aggIntegrate = el('div', { class: 'desc' })               ;
    const intChk = el('input', { type: 'checkbox' })                    ;
    intChk.checked = !!agg.Enabled;
    intChk.onchange = () => { agg.Enabled = intChk.checked; refreshDirty(); };
    aggIntegrate.append(el('label', {}, intChk,
      ' Derive kWh from power for nodes that report only watts (an estimate — a real energy source always wins)'));
    body.appendChild(aggIntegrate);

    // Three switches deliberately not gathered here: they sit on the diagram they change.
    body.appendChild(el('div', { class: 'desc', style: { marginTop: '14px' } },
      'The “Hide empty”, “Unmeasured load” and “Animate flow” switches stay on the Flow page: they change '
      + 'what the diagram shows rather than what is configured, and they are per-browser — nothing here is '
      + 'saved by them.'));
  };

  // --- Hierarchy editor: a layered, left→right arrow graph (energy flows source → target).
  const colors = ['#4f8cff', '#46c46a', '#fa4', '#f49', '#9f4', '#4ff'];
  const NW = 190, NH = 46;

  const renderEditor = () => {
    if (ed._cleanup) ed._cleanup();
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const customNodes = ensure(flow, 'Nodes', []);
    const links = ensure(flow, 'Links', []);
    ed.innerHTML = '';

    ed.appendChild(el('div', { class: 'desc', text: 'Drag from a node’s right ● onto another node to add a feed (source powers target); click ✕ on a link to remove it. Double-click a custom node to rename it. PDU → outlet links are auto-derived (dashed) until you wire an explicit feeder. Add and configure nodes on the Nodes tab.' }));

    const bar2 = el('div', { class: 'ld-toolbar' });
    const save = btn('Save', 'primary');
    save.onclick = () => saveConfig(load);
    bar2.append(save); ed.appendChild(bar2);

    // Candidate nodes (from the built graph + custom defs).
    const cand = flowCandidates(lastGraph, customNodes);
    const nm = (id        )         => (cand.get(id) || {}).label || id;
    const byLabel = (a        , b        ) => (cand.get(a).label || a).localeCompare(cand.get(b).label || b);

    const autoParent = (id        ) => { const m = /^outlet:(.+):\d+$/.exec(id); return m ? 'pdu:' + m[1] : null; };

    // Edges: explicit directed Links, plus the auto PDU → outlet feed.
    const customTo = new Set(links.map((l     ) => l.To));
    const edges        = [];
    cand.forEach((c     ) => { const ap = autoParent(c.id); if (ap && cand.has(ap) && !customTo.has(c.id)) edges.push({ from: ap, to: c.id, custom: false }); });
    links.forEach((l     ) => { if (cand.has(l.From) && cand.has(l.To)) edges.push({ from: l.From, to: l.To, custom: true, ref: l }); });

    // Adjacency + column = longest path from a root (every edge therefore points strictly rightward).
    const incoming      = {}, outgoing      = {};
    cand.forEach((_     , id        ) => { incoming[id] = []; outgoing[id] = []; });
    edges.forEach(e => { outgoing[e.from].push(e); incoming[e.to].push(e); });
    const colMemo      = {};
    const col = (id        , seen              )         => {
      if (colMemo[id] != null) return colMemo[id];
      seen = seen || new Set(); if (seen.has(id)) return 0; seen.add(id);
      const ins = incoming[id] || [];
      const c = ins.length ? Math.max(...ins.map((e     ) => col(e.from, seen) + 1)) : 0;
      seen.delete(id); return colMemo[id] = c;
    };
    [...cand.keys()].forEach(id => col(id));
    // Pull each node as far right as its nearest child allows, so it lands next to what it powers.
    const colX      = {};
    [...cand.keys()].sort((a, b) => colMemo[b] - colMemo[a]).forEach(id => {
      const outs = outgoing[id] || [];
      colX[id] = outs.length ? Math.max(0, Math.min(...outs.map((e     ) => colX[e.to])) - 1) : colMemo[id];
    });
    // Never leave an empty left margin if every node pulled off column 0.
    const minC = Math.min(...([...cand.keys()].map(id => colX[id])            ));
    if (minC > 0) [...cand.keys()].forEach(id => { colX[id] -= minC; });
    // Would adding from→to create a loop? (can `to` already reach `from`?)
    const reaches = (a        , b        ) => { const stack = [a], seen = new Set(); while (stack.length) { const x = stack.pop() ; if (x === b) return true; if (seen.has(x)) continue; seen.add(x); (outgoing[x] || []).forEach((e     ) => stack.push(e.to)); } return false; };

    // Layout: stack each column top-to-bottom; order downstream columns by feeder barycenter.
    const padX = 22, padY = 18, rowGap = 16, step = NW + 96;
    const cols        = [];
    [...cand.keys()].forEach(id => { const c = colX[id]; (cols[c] = cols[c] || []).push(id); });
    const pos      = {};
    const bary = (id        ) => { const ins = incoming[id] || []; if (!ins.length) return 1e9; let s = 0, w = 0; ins.forEach((e     ) => { const p = pos[e.from]; if (p) { s += p.y + NH / 2; w++; } }); return w ? s / w : 1e9; };
    cols.forEach((ids, c) => {
      if (c === 0) ids.sort((a        , b        ) => (cand.get(a).kind === 'pdu' ? 0 : 1) - (cand.get(b).kind === 'pdu' ? 0 : 1) || byLabel(a, b));
      else ids.sort((a        , b        ) => (bary(a) - bary(b)) || byLabel(a, b));
      let y = padY;
      ids.forEach((id        ) => { pos[id] = { x: padX + c * step, y }; y += NH + rowGap; });
    });

    const W = Math.max(640, ...[...cand.keys()].map(id => pos[id].x + NW + padX));
    const H = Math.max(260, ...[...cand.keys()].map(id => pos[id].y + NH + padY));
    const scroll = el('div', { style: { overflow: 'auto', border: '1px solid var(--line)', borderRadius: '6px', marginTop: '10px', maxHeight: '72vh' } });
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: 'background:var(--panel2); display:block' });
    scroll.appendChild(svg); ed.appendChild(scroll);
    ed.appendChild(el('div', { class: 'desc', style: { margin: '4px 2px 0', fontSize: '11px' }, text: 'Drag the canvas to pan · scroll to move · Ctrl/⌘ + scroll to zoom · drag a node’s ● onto another to link.' }));
    const detachZoom = attachZoom(scroll, svg, W, H);
    const defs = svgEl('defs', {}); svg.appendChild(defs);
    [['fh-arrow', 'var(--faint)'], ['fh-arrow-c', '#7cc0ff']].forEach(([id, fill]) => {
      const mk = svgEl('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
      mk.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill })); defs.appendChild(mk);
    });
    const edgeLayer = svgEl('g', {}); svg.appendChild(edgeLayer);
    const nodeLayer = svgEl('g', {}); svg.appendChild(nodeLayer);

    const edgeD = (a     , b     ) => { const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, xc = (x1 + x2) / 2; return `M${x1},${y1} C${xc},${y1} ${xc},${y2} ${x2},${y2}`; };
    edges.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      edgeLayer.appendChild(svgEl('path', { d: edgeD(a, b), fill: 'none', stroke: e.custom ? '#5ab0ff' : 'var(--faint)', 'stroke-width': e.custom ? 3.5 : 2, 'stroke-opacity': e.custom ? '0.95' : '0.7', 'stroke-dasharray': e.custom ? '' : '5 4', 'marker-end': `url(#${e.custom ? 'fh-arrow-c' : 'fh-arrow'})`, 'pointer-events': 'none' }));
      if (e.custom) {
        // Drifting dashes along the link, hinting at flow direction.
        edgeLayer.appendChild(svgEl('path', { class: 'flow-line', d: edgeD(a, b), fill: 'none', stroke: '#eaf5ff', 'stroke-opacity': '0.95', 'stroke-width': '3.4', 'stroke-linecap': 'round', 'stroke-dasharray': '8 10', 'pointer-events': 'none' }));
        const mx = (a.x + NW + b.x) / 2, my = (a.y + b.y) / 2 + NH / 2;
        const del = svgEl('text', { x: mx, y: my, 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: 'var(--bad)', 'font-size': '15', style: 'cursor:pointer' });
        del.textContent = '✕'; del.onclick = () => { const i = links.indexOf(e.ref); if (i >= 0) links.splice(i, 1); toast(`${nm(e.from)} → ${nm(e.to)} removed.`, true); renderEditor(); };
        edgeLayer.appendChild(del);
      }
    });

    const nodeG      = {};
    [...cand.values()].forEach((c     ) => {
      const p = pos[c.id], color = colors[col(c.id) % colors.length];
      const g = svgEl('g', { transform: `translate(${p.x},${p.y})`, style: 'cursor:default' }); g.dataset.id = c.id;
      g.appendChild(svgEl('rect', { width: NW, height: NH, rx: 7, fill: 'var(--panel)', stroke: color, 'stroke-width': 2 }));
      const t1 = svgEl('text', { x: 11, y: 19, fill: 'var(--fg)', 'font-size': '12', 'font-weight': '600' }); t1.textContent = c.label.length > 26 ? c.label.slice(0, 25) + '…' : c.label; g.appendChild(t1);
      const t2 = svgEl('text', { x: 11, y: 35, fill: 'var(--muted)', 'font-size': '10' }); t2.textContent = c.id; g.appendChild(t2);
      g.appendChild(svgEl('circle', { cx: NW, cy: NH / 2, r: 7, fill: color, style: 'cursor:crosshair', 'data-port': c.id }));
      if (c.custom) {
        const rm = svgEl('text', { x: NW - 13, y: 15, fill: 'var(--bad)', 'font-size': '13', style: 'cursor:pointer', 'data-rm': c.id }); rm.textContent = '✕'; g.appendChild(rm);
        // Rename in place: double-click the node to relabel it.
        t1.setAttribute('title', 'Double-click to rename'); g.style.cursor = 'pointer';
        g.addEventListener('dblclick', (e     ) => {
          e.preventDefault();
          const node = customNodes.find((n     ) => n.Id === c.id); if (!node) return;
          const next = window.prompt(`Rename “${node.Label || node.Id}” (id ${node.Id} is unchanged)`, node.Label || node.Id);
          if (next == null) return; // cancelled
          node.Label = next.trim() || node.Id;
          toast(`Renamed to ${node.Label}. Save the hierarchy to keep it.`, true);
          renderEditor();
        });
      }
      nodeLayer.appendChild(g); nodeG[c.id] = g;
    });

    // Interactions: drag a node's output port onto another node to add a directed feed.
    const toUser = (cx        , cy        ) => new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse());
    let linkFrom      = null, tempLine      = null, hovered      = null;
    // Drag the empty canvas to pan, engaging past a small threshold so a click on a node still registers.
    let panStart      = null, panning = false;
    scroll.style.cursor = 'grab';
    const highlight = (id     ) => {
      if (id === hovered) return;
      if (hovered && nodeG[hovered]) { const rc = nodeG[hovered].querySelector('rect'); rc.setAttribute('stroke', colors[col(hovered) % colors.length]); rc.setAttribute('stroke-width', '2'); }
      hovered = id;
      if (hovered && nodeG[hovered]) { const rc = nodeG[hovered].querySelector('rect'); rc.setAttribute('stroke', '#46c46a'); rc.setAttribute('stroke-width', '3'); }
    };
    const targetUnder = (cx        , cy        ) => { const hit      = document.elementFromPoint(cx, cy); const gn = hit && hit.closest && hit.closest('g[data-id]'); return gn && gn.dataset.id !== linkFrom ? gn.dataset.id : null; };
    const onDown = (e     ) => {
      const portId = e.target.getAttribute && e.target.getAttribute('data-port');
      const rmId = e.target.getAttribute && e.target.getAttribute('data-rm');
      if (rmId) { const i = customNodes.findIndex((n     ) => n.Id === rmId); if (i >= 0) customNodes.splice(i, 1); for (let j = links.length - 1; j >= 0; j--) if (links[j].From === rmId || links[j].To === rmId) links.splice(j, 1); renderEditor(); return; }
      if (portId) { linkFrom = portId; tempLine = svgEl('path', { d: '', fill: 'none', stroke: '#5ab0ff', 'stroke-width': 2, 'stroke-dasharray': '4 3', 'pointer-events': 'none' }); edgeLayer.appendChild(tempLine); e.preventDefault(); return; }
      // Anything else (background, a node body, a label): a potential pan.
      panStart = { x: e.clientX, y: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
      e.preventDefault();   // don't rubber-band-select node labels while dragging
    };
    const onMove = (e     ) => {
      if (panStart && !linkFrom) {
        const dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
        if (panning || Math.hypot(dx, dy) > 4) {
          panning = true; scroll.style.cursor = 'grabbing';
          scroll.scrollLeft = panStart.sl - dx; scroll.scrollTop = panStart.st - dy;
        }
        return;
      }
      if (!linkFrom) return;
      const u = toUser(e.clientX, e.clientY), a = pos[linkFrom];
      tempLine.setAttribute('d', `M${a.x + NW},${a.y + NH / 2} L${u.x},${u.y}`);
      highlight(targetUnder(e.clientX, e.clientY));
    };
    const onUp = (e     ) => {
      if (panStart) { const wasPanning = panning; panStart = null; panning = false; scroll.style.cursor = 'grab'; if (wasPanning) return; }
      if (!linkFrom) return;
      const src = linkFrom, tgt = targetUnder(e.clientX, e.clientY);
      if (tempLine) tempLine.remove(); linkFrom = null; highlight(null);
      if (!tgt || src === tgt) return;
      if (reaches(tgt, src)) { toast('That would create a feeder loop.', false); return; }
      if (links.some((l     ) => l.From === src && l.To === tgt)) { toast('That feed already exists.', false); return; }
      links.push({ From: src, To: tgt });
      toast(`${nm(src)} → ${nm(tgt)} added.`, true);
      renderEditor();
    };
    svg.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    ed._cleanup = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); detachZoom(); };
  };

  const load = async () => {
    let path = withInstance('/api/flow', instSel);
    if (metricSel.value && metricSel.value !== 'realpower') path += (path.includes('?') ? '&' : '?') + 'metric=' + metricSel.value;
    const past = historyQuery(hist);
    if (past) path += (path.includes('?') ? '&' : '?') + past.slice(1);
    const [r, w] = await Promise.all([api(path), api('/api/flow/withheld')]);
    withheldSources = (w.body && w.body.ok && w.body.sources) || [];
    if (!r.body.ok) { wrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load flow data.') + '</div>'; count.textContent = ''; lastGraph = null; redrawSubPages(); return; }
    // Say plainly that this is not now. A past diagram that looks like the live one is the worst outcome.
    hist.setNote(historyNote(r.body));
    lastGraph = r.body;
    draw(r.body);
    redrawSubPages();
  };
  refresh.onclick = load;

  // A sub-page repaints with the data only while it is the page you are on.
  const redrawSubPages = () => {
    if (edPage.sec.classList.contains('active')) renderEditor();
    if (treePage.sec.classList.contains('active')) renderTree();
  };

  // The editor draws every node the diagram knows about, not just the configured ones.
  const openSubPage = async (page     , render            ) => {
    activate(page.link, page.sec);
    if (!lastGraph) await load();
    render();
  };
  treePage.link.onclick = () => openSubPage(treePage, renderTree);
  edPage.link.onclick = () => openSubPage(edPage, renderEditor);
  settingsPage.link.onclick = () => { activate(settingsPage.link, settingsPage.sec); renderSettings(); };

  // The Sankey follows the readings while the tab is open (#281).
  const syncLive = liveWhileActive(sec,
    () => 'flow:' + (metricSel.value || 'realpower') + (instSel.get() ? '|' + instSel.get() : ''),
    (body     ) => { if (hist.day() || !body || !body.ok) return; lastGraph = body; draw(body); });
  metricSel.addEventListener('change', () => syncLive());

  link.onclick = () => { activate(link, sec); syncLive(); load(); showDayNote(); };
}

// ── sections/node-editor.ts ─────────────────────────────────────
// Editing one node — name, kind, how it is valued, its live sources.

// --- Browsing what's out there: MQTT topics, and a Modbus device's registers ----------------------

let pickerSeq = 0;

/// A modal panel over the page. Returns the body to fill; closes on the button, the backdrop, or Escape.
function overlay(title        , onClose             )                                   {
  const back = el('div', { style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.55)', zIndex: '50', display: 'flex', alignItems: 'center', justifyContent: 'center' } });
  // The node editor's widest row is a table of eleven columns, which wants about 1,640px. At 75vw that
  // overflowed a 2,039px screen by ~110px and the Remove button rendered as "Re…", so the sheet takes what
  // the screen actually has. Vertical scrolling only: the table below manages its own width.
  const panel = el('div', { class: 'sheet-panel', style: { background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: '8px', padding: '14px', width: 'min(94vw, 1900px)', maxHeight: '86vh', overflowY: 'auto', overflowX: 'hidden' } });
  const head = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } });
  head.appendChild(el('h4', { text: title, style: { margin: '0', fontSize: '14px' } }));
  const x = btn('Close');
  head.appendChild(x);
  const body = el('div');
  // Every edit inside a sheet reports itself, once, here.
  //
  // The controls in this file write straight into the config object and most of them returned without
  // telling the dirty tracker, so the save bar stayed silent until something else happened to refresh it —
  // closing the sheet, or a control that did remember. Editing a topic and looking at the save bar said
  // nothing had changed. Adding refreshDirty() to two dozen handlers fixes today's controls and not
  // tomorrow's; `change` bubbles, so one listener on the sheet covers every control it will ever contain.
  //
  // refreshDirty() diffs the whole document, so it does not matter which control fired: what changed is
  // read off the document rather than reported by the handler.
  body.addEventListener('change', () => refreshDirty());
  panel.append(head, body);
  back.appendChild(panel);
  document.body.appendChild(back);

  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const dismiss = () => { close(); if (onClose) onClose(); };
  const onKey = (e     ) => { if (e.key === 'Escape') dismiss(); };
  x.onclick = dismiss;
  back.onclick = (e     ) => { if (e.target === back) dismiss(); };
  document.addEventListener('keydown', onKey);
  return { body, close };
}

async function fetchTopics(q        , limit = 50, filter         )               {
  const f = filter ? `&filter=${encodeURIComponent(filter)}` : '';
  const r = await api(`/api/mqtt/topics?q=${encodeURIComponent(q || '')}&limit=${limit}${f}`);
  return (r.body && r.body.ok) ? r.body : { topics: [], listening: false, indexed: 0 };
}

async function fetchTopicDetail(topic        )                      {
  if (!topic) return null;
  const r = await api(`/api/mqtt/topic?topic=${encodeURIComponent(topic)}`);
  return (r.body && r.body.ok) ? r.body : null;
}

/// Inline autocomplete for a topic input: a datalist kept in step with what you've typed.
function topicSuggester(input     , onExactPick            ) {
  const list = el('datalist', { id: 'topics-' + (++pickerSeq) });
  input.setAttribute('list', list.id);
  let timer      = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const body = await fetchTopics(input.value.trim());
      list.innerHTML = '';
      (body.topics || []).forEach((t     ) => list.appendChild(el('option', { value: t.topic })));
      // Picking from the dropdown fires 'input', not 'change', so treat an exact hit as a choice.
      if ((body.topics || []).some((t     ) => t.topic === input.value.trim())) onExactPick();
    }, 250);
  });
  return { list };
}

/// Inline autocomplete for the JSON field, read from the chosen topic's own payload.
function jsonFieldSuggester(input     , topicOf              ) {
  const list = el('datalist', { id: 'fields-' + (++pickerSeq) });
  input.setAttribute('list', list.id);
  const fill = async () => {
    const detail = await fetchTopicDetail(topicOf());
    list.innerHTML = '';
    ((detail && detail.fields) || []).forEach((f     ) => list.appendChild(el('option', { value: f.field })));
  };
  input.addEventListener('focus', fill);
  return list;
}

/// Fill in what the payload tells us about a freshly chosen topic — without overwriting deliberate choices.
async function applyTopicHint(src     , topic        , fieldIn     , rerender            ) {
  const detail = await fetchTopicDetail(topic);
  if (!detail) return;

  const notes           = [];
  // Only infer where the user hasn't already decided: an untouched binding still reads 'realpower'.
  if (detail.metric && (!src.Metric || src.Metric === 'realpower') && detail.metric !== src.Metric) {
    src.Metric = detail.metric; src.Unit = undefined; notes.push(metricLabel(detail.metric));
  }
  if (detail.unit && !src.Unit && detail.unit !== metricMeta(src.Metric || 'realpower')[2]) {
    src.Unit = detail.unit; notes.push(detail.unit);
  }
  if (detail.isJson && !src.JsonField && (detail.fields || []).length === 1) {
    src.JsonField = detail.fields[0].field;
    if (fieldIn) fieldIn.value = src.JsonField;
    notes.push('field ' + src.JsonField);
  }

  const sample = detail.value != null ? `${formatNum(detail.value)}` : (detail.payload || '').slice(0, 40);
  toast(notes.length ? `Read ${sample} — set ${notes.join(', ')}.` : `Last value: ${sample}`, true);
  if (notes.length) rerender();
}

/// The topic browser: search what's on the broker, see each topic's last value, click to bind it.
function openTopicPicker(current        , onPick                         ) {
  const { body, close } = overlay('Browse broker topics');
  body.appendChild(el('div', { class: 'desc', text: 'Live topics seen on the broker while this window is open. Nothing is indexed in the background — the subscription starts when you browse and stops when you stop.' }));

  // Which broker filter to subscribe to.
  const filterBar = el('div', { class: 'ld-toolbar' });
  const filterIn = el('input', { type: 'text', value: '#', placeholder: '# (everything)', style: { width: '220px' } })                    ;
  filterIn.title = 'The topic filter to subscribe to while browsing. If the broker denies “#”, narrow it (e.g. solar_assistant/#).';
  const applyFilter = btn('Browse this');
  filterBar.append(el('span', { class: 'desc', style: { margin: '0' }, text: 'Subscribe to:' }), filterIn, applyFilter);
  body.appendChild(filterBar);

  const bar = el('div', { class: 'ld-toolbar' });
  const search = el('input', { type: 'search', value: current || '', placeholder: 'filter the shown topics…', style: { width: '320px' } })                    ;
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(search, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Topic', 'Last value', 'Looks like', ''].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const load = async () => {
    const b = await fetchTopics(search.value.trim(), 100, filterIn.value.trim() || '#');
    tbody.innerHTML = '';
    if (b.granted === false) {
      // The broker refused the subscription — say so plainly instead of a mysterious empty list.
      status.style.color = 'var(--bad)';
      status.textContent = `The broker denied the subscription to “${b.filter || filterIn.value.trim()}”. Your MQTT account lacks read permission on it — grant it, or narrow the filter above to a prefix you can read (e.g. solar_assistant/#).`;
      return;
    }
    status.style.color = 'var(--muted)';
    status.textContent = b.listening
      ? `${(b.topics || []).length} shown · ${b.indexed}/${b.capacity} indexed · subscribed to “${b.filter || '#'}”`
      : `waiting for the broker subscription to “${b.filter || filterIn.value.trim()}” to come up…`;
    (b.topics || []).forEach((t     ) => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('code', { text: t.topic })));
      tr.appendChild(el('td', { class: 'num', text: t.value != null ? formatNum(t.value) + (t.unit ? ' ' + t.unit : '') : (t.payload || '').slice(0, 48) }));
      tr.appendChild(el('td', { text: t.isJson ? `JSON · ${(t.fields || []).length} field(s)` : (t.metric ? metricLabel(t.metric) : '—') }));
      const use = btn('Use', 'primary');
      use.onclick = () => { onPick(t.topic); close(); };
      tr.appendChild(el('td', {}, use));
      tbody.appendChild(tr);
    });
  };

  let timer      = null;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  applyFilter.onclick = () => load();
  filterIn.onkeydown = (e     ) => { if (e.key === 'Enter') load(); };
  load();
  // Keep the index's lease alive (and the list fresh) for as long as the window is open.
  const poll = setInterval(() => { if (!document.body.contains(tbl)) { clearInterval(poll); return; } load(); }, 5000);
}

/// The Modbus explorer: read a block of registers off the device and pick the one that looks right.
function openModbusExplorer(src     , onPick            ) {
  const conns        = (state.data?.Modbus?.Connections) || [];
  const conn = conns.find(c => c.Id === src.Connection);
  const { body } = overlay('Modbus explorer' + (conn ? ` · ${conn.Name || conn.Id}` : ''));

  if (!conn) {
    body.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'Pick a Modbus connection for this binding first (they are defined in the Modbus section).' }));
    return;
  }

  body.appendChild(el('div', { class: 'desc', text: 'One read per click — a gateway usually accepts a single client, and the worker is already polling it. Each register is decoded every way that makes sense; click the value that matches what the device should be reporting.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const startIn = el('input', { type: 'number', value: src.Register ?? 0, title: 'First register', style: { width: '90px' } })                    ;
  const countIn = el('input', { type: 'number', value: 32, title: 'How many', style: { width: '70px' } })                    ;
  const bankSel = el('select', { style: { width: 'auto' } })                     ;
  MODBUS_REGISTER_TYPES.forEach(t => bankSel.appendChild(el('option', { value: t, text: t })));
  bankSel.value = src.RegisterType || 'holding';
  const read = btn('Read', 'primary');
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(startIn, countIn, bankSel, read, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Register', 'uint16', 'int16', 'uint32', 'float32'].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const pick = (register        , dataType        ) => {
    src.Register = register;
    src.RegisterType = bankSel.value === 'holding' ? undefined : bankSel.value;
    src.DataType = dataType === 'uint16' ? undefined : dataType;
    toast(`Bound register ${register} as ${dataType}.`, true);
    onPick();
  };

  const cell = (row     , key        ) => {
    const td = el('td', { class: 'num' });
    if (row[key] == null) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
    const link = el('span', { text: formatNum(row[key]), style: { cursor: 'pointer', color: 'var(--accent, #4f8cff)' }, title: `Use register ${row.register} as ${key}` });
    link.onclick = () => pick(row.register, key);
    td.appendChild(link);
    return td;
  };

  read.onclick = async () => {
    status.textContent = 'reading…';
    const r = await api('/api/modbus/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Host: conn.Host, Port: conn.Port, UnitId: conn.UnitId, Framing: conn.Framing, TimeoutMs: conn.TimeoutMs,
        Start: parseInt(startIn.value) || 0, Count: parseInt(countIn.value) || 32, RegisterType: bankSel.value,
      }),
    });
    status.textContent = (r.body && r.body.message) || (r.body?.ok ? '' : 'read failed');
    status.style.color = r.body?.ok ? 'var(--muted)' : 'var(--bad)';
    tbody.innerHTML = '';
    ((r.body && r.body.rows) || []).forEach((row     ) => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('code', { text: String(row.register) })));
      tr.append(cell(row, 'uint16'), cell(row, 'int16'), cell(row, 'uint32'), cell(row, 'float32'));
      tbody.appendChild(tr);
    });
  };
  read.onclick(null);
}

/// Rename a node and carry its wiring with it; the id is the node's identity everywhere.
function openRenameDialog(node     , flow     , existingIds             , onRenamed                      ) {
  const { body, close } = overlay(`Rename ${node.Label || node.Id}`);
  const links        = ensure(flow, 'Links', []);
  const parents      = ensure(flow, 'Parents', {});
  const wired = links.filter(l => l.From === node.Id || l.To === node.Id).length
    + Object.entries(parents).filter(([c, p]) => c === node.Id || p === node.Id).length;

  body.appendChild(el('div', { class: 'desc', text: `Its ${wired} wiring reference(s) move with it automatically.` }));

  // The id is what every integration keys off, so a rename is a rename downstream too.
  const warn = el('div', {
    class: 'desc',
    style: { border: '1px solid var(--bad)', borderRadius: '6px', padding: '8px', margin: '8px 0', color: 'var(--fg)' },
  });
  warn.appendChild(el('b', { text: 'This changes how the node appears downstream.' }));
  warn.appendChild(el('div', { text: 'The MQTT topic, the Home Assistant entity/unique id, the Prometheus series and the EmonCMS feed are all derived from the id. Anything already recording under the old name — HA history, an energy dashboard entry, a Grafana query, an emonCMS feed — will see this as a new thing and stop following the old one. Rename deliberately, and fix those up afterwards.' }));
  body.appendChild(warn);

  const row = el('div', { class: 'ld-toolbar' });
  const idIn = el('input', { type: 'text', value: node.Id, style: { width: '260px' } })                    ;
  const apply = btn('Rename', 'primary');
  const err = el('span', { class: 'desc', style: { margin: '0 0 0 8px', color: 'var(--bad)' } });
  row.append(idIn, apply, err);
  body.appendChild(row);

  apply.onclick = () => {
    const next = (idIn.value || '').trim();
    if (!next) { err.textContent = 'An id is required.'; return; }
    if (next === node.Id) { close(); return; }
    if (existingIds.has(next)) { err.textContent = 'That id already exists.'; return; }

    const from = node.Id;
    node.Id = next;
    links.forEach(l => { if (l.From === from) l.From = next; if (l.To === from) l.To = next; });
    // The legacy Parents map keys by child id and stores the parent id, so both sides can name this node.
    Object.keys(parents).forEach(child => {
      if (parents[child] === from) parents[child] = next;
      if (child === from) { parents[next] = parents[child]; delete parents[child]; }
    });

    toast(`Renamed ${from} → ${next}; ${wired} reference(s) updated. Save to apply.`, true);
    close();
    onRenamed(next);
  };
  idIn.onkeydown = (e     ) => { if (e.key === 'Enter') apply.onclick(null); };
}

// A labelled field (label above a control) for the node editor's form grid.
function field(labelText        , control             , hint         ) {
  const f = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } });
  f.appendChild(el('label', { text: labelText, style: { fontSize: '11px', color: 'var(--muted)' } }));
  f.appendChild(control);
  if (hint) f.appendChild(el('div', { class: 'desc', text: hint, style: { margin: '0', fontSize: '11px' } }));
  return f;
}

// Per-node editor (#129): name, kind, mode, fixed value, a battery's storage, and the live value bindings —
function renderNodeEditor(node     , links       , cand                  , rerender                           ) {
  const meta = kindMeta(node.Kind);
  const allowed = meta[2];
  // No frame and no header of its own: this renders into a modal panel that already carries the node's name.
  const box = el('div', { class: 'node-editor' });

  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '12px' } });

  const labIn = el('input', { type: 'text', value: node.Label || '', placeholder: node.Id });
  labIn.onchange = () => { node.Label = labIn.value.trim() || undefined; };
  grid.appendChild(field('Name', labIn));

  const kindSel = el('select');
  NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
  kindSel.value = node.Kind || 'node';
  kindSel.onchange = () => { node.Kind = kindSel.value === 'node' ? undefined : kindSel.value; rerender(); };
  grid.appendChild(field('Kind', kindSel));

  const modeSel = el('select');
  NODE_MODES.forEach(([v, label, desc]) => { const o = el('option', { value: v, text: label }); o.title = desc; modeSel.appendChild(o); });
  modeSel.value = node.Mode || 'auto';
  modeSel.onchange = () => {
    node.Mode = modeSel.value === 'auto' ? undefined : modeSel.value;
    if (node.Mode !== 'static') node.Value = undefined;  // a fixed value only belongs to a static node
    rerender();  // toggle the Fixed value field
  };
  grid.appendChild(field('Mode', modeSel, 'How it’s valued with no measurement.'));

  // The fixed value only makes sense for a static leaf — show it only in that mode.
  if ((node.Mode || 'auto') === 'static') {
    const valIn = el('input', { type: 'number', step: 'any', value: node.Value ?? '', placeholder: '—' });
    valIn.onchange = () => { const v = +valIn.value; node.Value = (valIn.value !== '' && !isNaN(v)) ? v : undefined; };
    grid.appendChild(field('Fixed value', valIn, 'Used unless a bound source reports.'));
  }

  // Tags (#342). Every kind can be tagged — a panel or a plain node is exactly the sort of thing an
  // export filter names, and hanging this off the gauge kinds below meant those could not be tagged at all.
  const tags = ensure(node, 'Tags', []);
  grid.appendChild(field('Tags', tagInput(tags, {
    placeholder: 'critical, rack-1',
    onChange: () => { if (!tags.length) node.Tags = undefined; rerender(); },
  }), 'Labels for filtering the Energy page, highlighting the diagram and deciding what each destination '
    + 'exports. Type to add one — existing tags complete as you type. A tag never changes a reading.'));

  // The gauge's ceiling, for the kinds the Energy page draws a dial for.
  if (['solar', 'battery', 'grid', 'load', 'inverter'].includes(node.Kind || 'node')) {
    const maxIn = el('input', { type: 'number', step: 'any', min: '0', value: node.Max ?? '', placeholder: '—' });
    maxIn.onchange = () => { const v = +maxIn.value; node.Max = (maxIn.value !== '' && !isNaN(v) && v > 0) ? v : undefined; };
    grid.appendChild(field('Gauge max (W)', maxIn,
      'Full scale for this node’s gauge on the Energy page — a PV array’s peak output, an inverter’s rating. '
      + 'Blank shows the plain reading; no ceiling is ever guessed.'));
  }

  if ((node.Kind || 'node') === 'battery') {
    const stoIn = el('input', { type: 'number', step: 'any', value: node.StorageKwh ?? '', placeholder: 'kWh' });
    stoIn.onchange = () => { const v = +stoIn.value; node.StorageKwh = (stoIn.value !== '' && !isNaN(v)) ? v : undefined; };
    grid.appendChild(field('Storage (kWh)', stoIn));
  }
  box.appendChild(grid);

  // --- Live value bindings ---
  box.appendChild(el('h5', { text: 'Live value bindings', style: { margin: '6px 0 2px', fontSize: '12px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'Bind a metric to a live source — an MQTT topic, or a register on a Modbus TCP connection (set those up in the Modbus section). One binding per metric drives that metric’s power/energy/… roll-up; a fresh reading supersedes the fixed value. Takes effect without a restart once saved — the Current column then fills in on the source’s next message or poll, no page reload needed.', style: { margin: '0 0 8px' } }));

  // Battery and grid flow both ways.
  const bidirectional = (node.Kind === 'battery' || node.Kind === 'grid');
  const dirLabels                         = node.Kind === 'battery' ? { out: 'Discharge', in: 'Charge', split: 'Split: + discharge / − charge' }
    : node.Kind === 'grid' ? { out: 'Import', in: 'Export', split: 'Split: + import / − export' }
    : { out: 'Out', in: 'In', split: 'Split: + out / − in' };

  const sources        = ensure(node, 'Sources', []);
  // A column every row fills with an em dash is width spent saying "not applicable" eleven times. Counter
  // means something only for energy, Invert only for a signed metric — so they appear when a binding on
  // THIS node uses them.
  const metricOf = (s     ) => String(s.Metric || 'realpower').toLowerCase();
  const usesCounter = sources.some((s     ) => metricOf(s) === 'energy');
  const usesInvert = sources.some((s     ) => SIGNED_METRICS.includes(metricOf(s)));
  if (sources.length) {
    const tbl = el('table', { class: 'ld' });
    const head = el('tr');
    const colHint      = {
      Direction: 'What this source measures: the node supplying (discharge / grid import / solar production) or drawing (battery charge / grid export). Charge and export are published as a second sensor HA’s Energy Dashboard can show. Split takes one signed power/current value and fans it into both at once — the positive part as the supply side, the magnitude of the negative part as the draw side. Hidden for metrics with no direction (voltage, frequency, power factor, state of charge).',
      Invert: 'Flip the sign of a power or current reading — for a source that publishes export/discharge as positive when your hierarchy wants it negative (or vice versa).',
      Current: LIVE_HINT,
    };
    ['Type', 'Metric', ...(bidirectional ? ['Direction'] : []), ...(usesCounter ? ['Counter'] : []),
      'Unit', 'Source', 'Details', 'Scale', ...(usesInvert ? ['Invert'] : []), 'Current', ''].forEach(h => {
      const th = el('th', { text: h });
      if (colHint[h]) th.title = colHint[h];
      head.appendChild(th);
    });
    tbl.appendChild(el('thead', {}, head));
    const body = el('tbody');
    // Cells that a live probe fills in, keyed to their source so a refresh can update them in place.
    const liveCells                            = [];
    sources.forEach((src     ) => {
      const tr = el('tr');

      const typeSel = el('select', { style: { width: 'auto' } });
      sourceTypes(state.schema).forEach(([v, label]) => typeSel.appendChild(el('option', { value: v, text: label })));
      typeSel.value = src.Type || 'mqtt';
      typeSel.onchange = () => { src.Type = typeSel.value; rerender(); };  // the Source/Details fields differ per type
      tr.appendChild(el('td', {}, typeSel));

      // Offer this kind's metrics (friendly labels).
      const metricSel = el('select', { style: { width: 'auto' } });
      const metric = src.Metric || 'realpower';
      const opts = allowed.includes(metric) ? allowed : [metric, ...allowed];
      opts.forEach((m        ) => metricSel.appendChild(el('option', { value: m, text: metricLabel(m) })));
      metricSel.value = metric;
      metricSel.onchange = () => { src.Metric = metricSel.value; src.Unit = undefined; rerender(); };
      // Say at the point of choosing that this one won't roll up.
      const metricCell = el('td', {}, metricSel);
      if (!isAdditiveMetric(metric)) {
        metricCell.appendChild(el('div', {
          class: 'desc', style: { margin: '2px 0 0', fontSize: '11px' },
          text: 'per-node only — not summed',
          title: `${metricLabel(metric)} describes a condition at a point, so it is never added up the tree.`
          + ' The node you bind it to shows it; its parents show nothing rather than a total that was true nowhere.',
        }));
      }
      tr.appendChild(metricCell);

      // Direction: battery/grid only, and only for a directional metric.
      if (bidirectional) {
        const cell = el('td');
        if (DIRECTIONAL_METRICS.includes(metric)) {
          const opts = SIGNED_METRICS.includes(metric) ? ['out', 'in', 'split'] : ['out', 'in'];
          const dirSel = el('select', { style: { width: 'auto' } });
          opts.forEach(d => dirSel.appendChild(el('option', { value: d, text: dirLabels[d] })));
          dirSel.value = opts.includes(src.Direction) ? src.Direction : 'out';
          // Split's sign convention lives in a tooltip so it doesn't add a line to every row.
          if (SIGNED_METRICS.includes(metric))
            dirSel.title = node.Kind === 'grid' ? 'Split fans one ± value into both directions: positive = import, negative = export. Tick Invert if your source is reversed.'
              : node.Kind === 'battery' ? 'Split fans one ± value into both directions: positive = discharge, negative = charge. Tick Invert if your source is reversed.'
              : 'Split fans one ± value into both directions: positive = out, negative = in. Tick Invert if reversed.';
          dirSel.onchange = () => { src.Direction = dirSel.value === 'out' ? undefined : dirSel.value; rerender(); };
          cell.appendChild(dirSel);
        } else {
          cell.appendChild(el('span', { text: '—', style: { color: 'var(--muted)' }, title: 'Direction doesn’t apply to this metric.' }));
        }
        tr.appendChild(cell);
      }

      // Does this counter run forever, or does the device reset it every day?
      if (usesCounter) {
        const cell = el('td');
        if (metric === 'energy') {
          const accSel = el('select', { style: { width: 'auto' } });
          [['lifetime', 'Lifetime'], ['period', 'Daily']].forEach(([v, t]) => accSel.appendChild(el('option', { value: v, text: t })));
          accSel.value = src.Accumulation === 'period' ? 'period' : 'lifetime';
          accSel.title = 'Lifetime: a cumulative total that only rises; its daily figure is its rise since midnight. '
            + 'Daily: the device resets this counter itself, so the reading already is today\u2019s total and is used as-is.';
          accSel.onchange = () => { src.Accumulation = accSel.value === 'lifetime' ? undefined : accSel.value; refreshDirty(); };
          cell.appendChild(accSel);
        } else {
          cell.appendChild(el('span', { text: '\u2014', style: { color: 'var(--muted)' }, title: 'Only energy accumulates; this metric is instantaneous.' }));
        }
        tr.appendChild(cell);
      }

      // Input unit → converted to the metric's canonical unit on ingest. Store only a non-canonical choice.
      const [, , canonical, units] = metricMeta(metric);
      const unitSel = el('select', { style: { width: 'auto' } });
      units.forEach((u        ) => unitSel.appendChild(el('option', { value: u, text: u || '—' })));
      unitSel.value = src.Unit || canonical;
      unitSel.disabled = units.length <= 1;
      unitSel.onchange = () => { src.Unit = unitSel.value === canonical ? undefined : unitSel.value; };
      tr.appendChild(el('td', {}, unitSel));

      // The Source + Details columns are type-specific. A type this bundle has no bespoke editor for —
      // every plugin-contributed one — gets the generic Settings editor instead of nothing at all.
      const type = (src.Type || 'mqtt').toLowerCase();
      if (type === 'derived') {
        // Nothing to point at: the value comes from this node's other bindings. Which sum it will actually
        // do, and what it still needs to do any of them, are the useful things to say.
        const metric = (src.Metric || 'realpower').toLowerCase();
        const rule = (state.derivations || []).find((d     ) => d.metric === metric);
        const bound = (m        ) => sources.some((o     ) => o !== src
          && (o.Type || 'mqtt').toLowerCase() !== 'derived'
          && (o.Metric || 'realpower').toLowerCase() === m);
        // An operand may itself be worked out, so "have I got it" is asked the same way the backend asks.
        const have = (m        , seen              = new Set())          => {
          if (bound(m)) return true;
          if (seen.has(m)) return false;
          seen.add(m);
          const r = (state.derivations || []).find((d     ) => d.metric === m);
          return (r?.from || []).some((f     ) => have(f.a, seen) && have(f.b, seen));
        };
        // Seeded with the metric being worked out, or it can be "reached" through a relation that needs
        // itself — which would offer a sum the backend will not do.
        const reach = (m        ) => have(m, new Set([metric]));
        const usable = (rule?.from || []).find((f     ) => reach(f.a) && reach(f.b));

        const cell = el('td', {});
        // A backend that does not serve the relations (an older one, mid-rollout) leaves us unable to say
        // which sum this is — but "cannot be calculated" would be a claim, and we do not have it to make.
        if (!(state.derivations || []).length) {
          cell.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'calculated from this node’s other readings' }));
        }
        else if (!rule) {
          cell.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: `'${metricLabel(metric)}' cannot be calculated` }));
          cell.appendChild(el('div', { class: 'desc', style: { margin: '2px 0 0', color: 'var(--bad)' },
            text: `These can: ${(state.derivations || []).map((d     ) => d.name).join(', ')}.` }));
        }
        else if (usable) {
          cell.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: `= ${usable.label}` }));
          if (usable.assumes)
            cell.appendChild(el('div', { class: 'desc', style: { margin: '2px 0 0', color: 'var(--warn)' },
              text: `assumes ${usable.assumes}` }));
        }
        else {
          cell.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: `= ${(rule.from[0] || {}).label || ''}` }));
          cell.appendChild(el('div', { class: 'desc', style: { margin: '2px 0 0', color: 'var(--bad)' },
            text: 'Needs ' + (rule.from || []).map((f     ) => `${metricLabel(f.a)} and ${metricLabel(f.b)}`).join(', or ')
                + ' on this node.' }));
        }
        tr.appendChild(cell);
        // The same em dash every other inapplicable cell in this table uses. "no source to read" read as a
        // fault report sitting beside a working value.
        tr.appendChild(el('td', {}, el('span', {
          text: '—', style: { color: 'var(--muted)' },
          title: 'A calculated value has no source of its own — it is worked out from this node’s other bindings.',
        })));
      }
      else if (type !== 'mqtt' && type !== 'modbus' && !sourceEditorFor(type)) {
        const [srcCell, detailCell] = genericSourceEditor(src, () => refreshDirty());
        tr.appendChild(srcCell);
        tr.appendChild(detailCell);
      }
      else if (type === 'modbus') {
        // Source = which configured Modbus connection; Details = the register spec.
        const connections        = (state.data?.Modbus?.Connections) || [];
        const connSel = el('select', { style: { width: '160px' } });
        connSel.appendChild(el('option', { value: '', text: connections.length ? '— pick a connection —' : 'none — add one in Modbus' }));
        connections.forEach((c     ) => connSel.appendChild(el('option', { value: c.Id, text: c.Name || c.Id })));
        connSel.value = src.Connection || '';
        connSel.onchange = () => { src.Connection = connSel.value || undefined; };
        tr.appendChild(el('td', {}, connSel));

        const details = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } });
        const regIn = el('input', { type: 'number', value: src.Register ?? 0, title: 'Register address', style: { width: '80px' } });
        regIn.onchange = () => { const v = +regIn.value; src.Register = !isNaN(v) ? v : 0; };
        const regTypeSel = el('select', { title: 'Register bank', style: { width: 'auto' } });
        MODBUS_REGISTER_TYPES.forEach(t => regTypeSel.appendChild(el('option', { value: t, text: t })));
        regTypeSel.value = src.RegisterType || 'holding';
        regTypeSel.onchange = () => { src.RegisterType = regTypeSel.value === 'holding' ? undefined : regTypeSel.value; };
        const dtSel = el('select', { title: 'Data type', style: { width: 'auto' } });
        MODBUS_DATATYPES.forEach(t => dtSel.appendChild(el('option', { value: t, text: t })));
        dtSel.value = src.DataType || 'uint16';
        const woSel = el('select', { title: 'Word order (32-bit)', style: { width: 'auto' } });
        MODBUS_WORDORDERS.forEach(t => woSel.appendChild(el('option', { value: t, text: t })));
        woSel.value = src.WordOrder || 'big';
        woSel.onchange = () => { src.WordOrder = woSel.value === 'big' ? undefined : woSel.value; };
        // Word order only matters for 32-bit types; keep it enabled only then.
        const is32 = () => ['uint32', 'int32', 'float32'].includes(dtSel.value);
        woSel.disabled = !is32();
        dtSel.onchange = () => { src.DataType = dtSel.value === 'uint16' ? undefined : dtSel.value; woSel.disabled = !is32(); };

        // Rather than guessing a register from a PDF, read the device and pick the value that looks right.
        const explore = btn('Browse…');
        explore.title = 'Read a block of registers from the device and choose one.';
        explore.onclick = () => openModbusExplorer(src, rerender);

        details.append(regIn, regTypeSel, dtSel, woSel, explore);
        tr.appendChild(el('td', {}, details));
      } else {
        // Source = the topic, with autocomplete off what the broker is actually carrying.
        const topicCell = el('td');
        const topicIn = el('input', { type: 'text', value: src.Topic || '', placeholder: 'solar_assistant/inverter_1/pv_power/state', style: { width: '300px' } })                    ;
        const fieldIn = el('input', { type: 'text', value: src.JsonField || '', placeholder: 'JSON field (optional)', style: { width: '120px' } })                    ;

        const suggest = topicSuggester(topicIn, () => {
          src.Topic = topicIn.value.trim();
          applyTopicHint(src, topicIn.value.trim(), fieldIn, rerender);
        });
        topicIn.onchange = () => { src.Topic = topicIn.value.trim(); applyTopicHint(src, src.Topic, fieldIn, rerender); };

        const browse = btn('Browse');
        browse.title = 'Browse the topics currently on the broker and pick one.';
        browse.onclick = () => openTopicPicker(topicIn.value.trim(), picked => {
          topicIn.value = picked;
          src.Topic = picked;
          applyTopicHint(src, picked, fieldIn, rerender);
        });

        topicCell.append(topicIn, suggest.list, ' ', browse);
        tr.appendChild(topicCell);

        fieldIn.onchange = () => { src.JsonField = fieldIn.value.trim() || undefined; };
        const fieldCell = el('td');
        fieldCell.append(fieldIn, jsonFieldSuggester(fieldIn, () => src.Topic || ''));
        tr.appendChild(fieldCell);
      }

      // Scale carries the magnitude; Invert carries the sign.
      const scaleIn = el('input', { type: 'number', step: 'any', value: Math.abs(src.Scale ?? 1), style: { width: '80px' } });
      const setScale = (magnitude        , invert         ) => {
        const v = (invert ? -1 : 1) * (isNaN(magnitude) || magnitude === 0 ? 1 : Math.abs(magnitude));
        src.Scale = v === 1 ? undefined : v;
      };
      scaleIn.onchange = () => setScale(+scaleIn.value, (src.Scale ?? 1) < 0);
      tr.appendChild(el('td', {}, scaleIn));

      // Sign only means anything where the value has a direction — power and current, not voltage/energy.
      const invCell = el('td', { style: { textAlign: 'center' } });
      // Built either way so `setScale` keeps its reference; appended only when the column is there.
      if (SIGNED_METRICS.includes(metric)) {
        const inv = el('input', { type: 'checkbox' })                    ;
        inv.checked = (src.Scale ?? 1) < 0;
        inv.title = 'Flip the sign of this reading (e.g. solar/battery power the source publishes as export).';
        inv.onchange = () => setScale(+scaleIn.value, inv.checked);
        invCell.appendChild(inv);
      } else {
        invCell.appendChild(el('span', { text: '—', style: { color: 'var(--muted)' }, title: 'Sign has no meaning for this metric.' }));
      }
      if (usesInvert) tr.appendChild(invCell);

      // Live value for every binding type: Modbus is read from the device; the rest (MQTT, future types)
      const liveCell = el('td', { class: 'num', style: { minWidth: '90px', color: 'var(--muted)' }, text: '…' });
      liveCells.push({ src, cell: liveCell });
      tr.appendChild(liveCell);

      const rm = btn('Remove', 'danger');
      rm.onclick = () => { sources.splice(sources.indexOf(src), 1); rerender(); };
      tr.appendChild(el('td', {}, rm));
      body.appendChild(tr);
    });
    tbl.appendChild(body);
    // The table scrolls itself when it still cannot fit. Scrolling the whole sheet took the title and the
    // Close button with it, and left the Remove buttons off the right-hand edge with nothing to say so.
    box.appendChild(el('div', { class: 'bindings-scroll' }, tbl));

    // Live "Current" value for every binding.
    if (liveCells.length) {
      const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
      const setCell = (cell     , value               , err         , metric         ) => {
        if (value == null) { cell.textContent = err ? 'err' : '—'; cell.style.color = err ? 'var(--bad)' : 'var(--muted)'; cell.title = err || ('No live value yet. ' + LIVE_HINT); }
        else { const cu = metricMeta(metric)[2]; cell.textContent = `${formatNum(value)} ${cu}`.trim(); cell.style.color = 'var(--good)'; cell.title = ''; }
      };
      // A Modbus device is a shared serial resource — many gateways accept only one client at a time.
      const refresh = async (probe = false) => {
        let probeMsg = '';
        if (probe) {
          const modbus = liveCells.filter(lc => (lc.src.Type || 'mqtt') === 'modbus');
          const conns        = (state.data?.Modbus?.Connections) || [];
          const byConn = new Map                                   ();
          modbus.forEach(lc => { const id = lc.src.Connection || ''; (byConn.get(id) || byConn.set(id, []).get(id) ).push(lc); });
          for (const [connId, cells] of byConn) {
            const conn = conns.find(c => c.Id === connId);
            if (!conn) { cells.forEach(lc => setCell(lc.cell, null, 'pick a connection')); probeMsg = 'Pick a Modbus connection.'; continue; }
            try {
              const r = await api('/api/modbus/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ Host: conn.Host, Port: conn.Port, UnitId: conn.UnitId, Framing: conn.Framing, TimeoutMs: conn.TimeoutMs, Items: cells.map(lc => lc.src) }) });
              if (!r.body.ok) { cells.forEach(lc => setCell(lc.cell, null, 'err')); probeMsg = r.body.message || 'probe failed'; continue; }
              const readings = r.body.readings || [];
              cells.forEach((lc, i) => setCell(lc.cell, readings[i]?.value ?? null, readings[i]?.error, lc.src.Metric));
              const firstErr = readings.find((rd     ) => rd?.error)?.error;
              if (firstErr) probeMsg = (r.body.message || '') + ' — ' + firstErr;
            } catch (e     ) { cells.forEach(lc => setCell(lc.cell, null, 'err')); probeMsg = String(e?.message || e); }
          }
        }

        // Every binding not just device-probed reads the shared live cache the running ingests fill.
        const cached = probe ? liveCells.filter(lc => (lc.src.Type || 'mqtt') !== 'modbus') : liveCells;
        if (cached.length) {
          try {
            const reqs        = [];
            const plan = cached.map(lc => {
              const m = lc.src.Metric || 'realpower';
              if (lc.src.Direction === 'split') { const i0 = reqs.length; reqs.push({ Node: node.Id, Metric: m }, { Node: node.Id, Metric: m + '#in' }); return { lc, split: true, i0 }; }
              const i0 = reqs.length; reqs.push({ Node: node.Id, Metric: sourceMetricKey(lc.src) }); return { lc, split: false, i0 };
            });
            const r = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqs) });
            const vals = (r.body && r.body.values) || [];
            plan.forEach(p => {
              if (p.split) {
                const o = vals[p.i0]?.value, iv = vals[p.i0 + 1]?.value;
                setCell(p.lc.cell, (o == null && iv == null) ? null : (o || 0) - (iv || 0), undefined, p.lc.src.Metric);
              } else setCell(p.lc.cell, vals[p.i0]?.value ?? null, undefined, p.lc.src.Metric);
            });
          } catch (e     ) { cached.forEach(lc => setCell(lc.cell, null, 'err')); }
        }
        status.textContent = probeMsg || `updated ${new Date().toLocaleTimeString()}`;
        status.style.color = probeMsg ? 'var(--bad)' : 'var(--muted)';
      };
      const hasModbus = liveCells.some(lc => (lc.src.Type || 'mqtt') === 'modbus');
      const refreshBtn = btn(hasModbus ? 'Test device read' : 'Refresh values');
      if (hasModbus) refreshBtn.title = 'Open a one-off connection to the device to test these bindings. Normally the worker polls it and the value shows here automatically — avoid hammering a gateway that allows only one client.';
      refreshBtn.onclick = () => refresh(true);
      box.appendChild(el('div', { class: 'ld-toolbar', style: { marginTop: '6px' } }, refreshBtn, status));
      refresh(false);
      // Self-cleaning: once this editor is replaced/closed its box leaves the DOM and the poll stops.
      const timer = setInterval(() => { if (!document.body.contains(box)) { clearInterval(timer); return; } refresh(false); }, 2000);
    }
  }

  const addBind = btn('Add binding', 'primary');
  addBind.onclick = () => {
    // Default to the first metric this kind offers that isn't bound yet, so a click rarely needs a re-pick.
    const used = new Set(sources.map((s     ) => s.Metric || 'realpower'));
    const metric = allowed.find((m        ) => !used.has(m)) || allowed[0];
    sources.push({ Type: 'mqtt', Metric: metric, Topic: '' });
    rerender();
  };
  box.appendChild(el('div', { class: 'ld-toolbar', style: { marginTop: '8px' } }, addBind));

  // --- Feeders & children (wiring) — the parent/child specification, alongside the visual Flow tab. ---
  box.appendChild(el('h5', { text: 'Feeders & children', style: { margin: '12px 0 2px', fontSize: '12px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'Which nodes feed this one, and which it feeds. The same wiring you can drag on the Flow tab.', style: { margin: '0 0 6px' } }));

  const nm = (id        ) => (cand.get(id) || {}).label || id;
  const addLink = (from        , to        ) => {
    if (from === to || links.some(l => l.From === from && l.To === to)) return;
    if (wouldLoop(links, from, to)) { toast('That would create a feeder loop.', false); return; }
    links.push({ From: from, To: to });
  };
  const removeLink = (from        , to        ) => { const i = links.findIndex(l => l.From === from && l.To === to); if (i >= 0) links.splice(i, 1); };
  const wireRow = (title        , current          , onAdd                     , onRemove                     ) => {
    const row = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', margin: '3px 0' } });
    row.appendChild(el('span', { class: 'desc', style: { margin: '0', minWidth: '64px' }, text: title }));
    current.forEach(other => {
      const chip = el('span', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '1px 8px', fontSize: '12px' } });
      const x = el('span', { text: '✕', style: { cursor: 'pointer', color: 'var(--bad)' } });
      x.onclick = () => { onRemove(other); rerender(); };
      chip.append(nm(other), x); row.appendChild(chip);
    });
    // The picker lists every node in the hierarchy, which on a real install is hundreds of outlets.
    const options = [...cand.keys()].filter(id => id !== node.Id && !current.includes(id)).sort((a, b) => nm(a).localeCompare(nm(b)));
    const search = el('input', { type: 'search', placeholder: 'search…', style: { width: '130px' } })                    ;
    const sel = el('select', { style: { width: 'auto' } })                     ;
    const matches = () => {
      const f = (search.value || '').trim().toLowerCase();
      return f ? options.filter(id => (id + ' ' + nm(id)).toLowerCase().includes(f)) : options;
    };
    const fill = () => {
      const m = matches();
      sel.innerHTML = '';
      sel.appendChild(el('option', { value: '', text: m.length ? `+ add… (${m.length})` : 'no match' }));
      m.forEach(id => sel.appendChild(el('option', { value: id, text: nm(id) })));
    };
    search.oninput = fill;
    search.onkeydown = (e     ) => {
      if (e.key !== 'Enter') return;
      const m = matches();
      if (m.length === 1) { onAdd(m[0]); rerender(); }
    };
    fill();
    sel.onchange = () => { if (sel.value) { onAdd(sel.value); rerender(); } };
    row.append(search, sel);
    return row;
  };
  box.appendChild(wireRow('Fed by', links.filter(l => l.To === node.Id).map(l => l.From), o => addLink(o, node.Id), o => removeLink(o, node.Id)));
  box.appendChild(wireRow('Feeds', links.filter(l => l.From === node.Id).map(l => l.To), o => addLink(node.Id, o), o => removeLink(node.Id, o)));

  return box;
}

// ── sections/nodes.ts ───────────────────────────────────────────
// The Nodes page: the virtual-node table, node groups, and the tag rules for PDUs and outlets.

function flowCandidates(lastGraph     , customNodes       ) {
  const cand = new Map             ();
  (lastGraph?.nodes || [])
    .filter((n     ) => !String(n.id || '').includes('#'))
    .forEach((n     ) => cand.set(n.id, { id: n.id, label: n.label, kind: n.kind }));
  customNodes.forEach((n     ) => cand.set(n.Id, { id: n.Id, label: n.Label || n.Id, kind: n.Kind || 'node', custom: true }));
  return cand;
}

// Tags for the nodes nobody typed out (#342).
function renderAutoTagRules(flow     , cand                  , rerender            ) {
  const rules = ensure(flow, 'AutoTags', []);
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Tags for PDUs and outlets', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'Nodes the bridge derives from what it polls have no row of their own to tag. Match them by id, with * for any run of characters: “outlet:rack_pdu_1:*” tags every outlet on that PDU, “pdu:*” every PDU, and a full id one outlet. A tag never changes a reading — only what a view shows and what the exports may carry.' }));

  const ids = [...cand.keys()].filter(id => id.startsWith('pdu:') || id.startsWith('outlet:'));

  const t = el('table', { class: 'ld' });
  const head = el('tr');
  ['Match', 'Tags', 'Matches now', ''].forEach(h => head.appendChild(el('th', { text: h })));
  t.appendChild(el('thead', {}, head));
  const tb = el('tbody');

  rules.forEach((r     , i        ) => {
    const tr = el('tr');
    const matchIn = el('input', { type: 'text', value: r.Match || '', placeholder: 'outlet:rack_pdu_1:*' })                    ;
    matchIn.onchange = () => { r.Match = matchIn.value.trim(); refreshDirty(); rerender(); };
    tr.appendChild(el('td', {}, matchIn));

    const tags = ensure(r, 'Tags', []);
    tr.appendChild(el('td', {}, tagInput(tags, { placeholder: 'rack-1, critical', onChange: rerender })));

    // What the pattern covers right now, from the nodes actually on the graph.
    const hits = ids.filter(id => globMatches(r.Match || '', id));
    tr.appendChild(el('td', {}, el('span', {
      class: 'desc', style: { margin: '0', color: hits.length ? '' : 'var(--warn)' },
      text: hits.length ? `${hits.length} node(s)` : 'nothing',
      title: hits.length ? hits.slice(0, 20).join('\n') + (hits.length > 20 ? `\n…and ${hits.length - 20} more` : '')
        : 'No PDU or outlet on the current graph has an id this matches.',
    })));

    const del = btn('Remove', 'danger');
    del.onclick = () => { rules.splice(i, 1); refreshDirty(); rerender(); };
    tr.appendChild(el('td', {}, del));
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  if (rules.length) box.appendChild(t);

  const add = btn('+ Add tag rule');
  add.onclick = () => { rules.push({ Match: '', Tags: [] }); refreshDirty(); rerender(); };
  box.appendChild(add);
  return box;
}

/// The same match the server applies (AutoTags.Matches): '*' is the only wildcard.
function globMatches(pattern        , id        )          {
  if (!pattern) return false;
  const rx = '^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
  return new RegExp(rx, 'i').test(id);
}

// Group manager (#groups): named groups of nodes that collapse into one node on the flow graphs.
function renderGroupManager(flow     , cand                  , rerender            ) {
  const groups = ensure(flow, 'Groups', []);
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Groups', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'Show several nodes as one collapsible node on the flow graphs. Either make a new group (its value is the members’ sum), or turn an existing node into a group — e.g. make “Solar PV” a group over its three MPPTs: collapsed, the flow chart shows only Solar PV reporting its own value; click it to expand the strings. Collapse/expand from the toggles above either graph, or by clicking the node.' }));

  const nm = (id        ) => (cand.get(id) || {}).label || id;

  const addBar = el('div', { class: 'ld-toolbar' });
  const idIn = el('input', { type: 'text', placeholder: 'group id (e.g. incoming_pv)' })                    ;
  const labIn = el('input', { type: 'text', placeholder: 'label (e.g. Incoming PV)' })                    ;
  const kindSel = el('select', { style: { width: 'auto' } });
  NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
  const addBtn = btn('Add group', 'primary');
  addBtn.onclick = () => {
    const id = (idIn.value || '').trim();
    if (!id) { toast('A group id is required.', false); return; }
    if (groups.some((g     ) => g.Id === id) || cand.has(id)) { toast('That id already exists.', false); return; }
    const g      = { Id: id, Label: (labIn.value || '').trim() || id, Members: [] };
    if (kindSel.value !== 'node') g.Kind = kindSel.value;
    groups.push(g);
    rerender();
  };
  addBar.append(idIn, labIn, kindSel, addBtn);
  box.appendChild(addBar);

  // Anchor a group on an existing node: that node becomes the group (keeping its own value).
  const anchorRow = el('div', { class: 'ld-toolbar' });
  anchorRow.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Or turn an existing node into a group:' }));
  const anchorSel = el('select', { style: { width: 'auto' } })                     ;
  anchorSel.appendChild(el('option', { value: '', text: '— pick a node —' }));
  [...cand.keys()].filter(id => !groups.some((g     ) => g.Id === id)).sort((a, b) => nm(a).localeCompare(nm(b)))
    .forEach(id => anchorSel.appendChild(el('option', { value: id, text: nm(id) })));
  anchorSel.onchange = () => {
    const id = anchorSel.value; if (!id) return;
    groups.push({ Id: id, Label: nm(id), Members: [] });
    toast(`“${nm(id)}” is now a group — add its members below.`, true);
    rerender();
  };
  anchorRow.appendChild(anchorSel);
  box.appendChild(anchorRow);

  if (!groups.length) { box.appendChild(el('div', { class: 'desc', text: 'No groups yet — add one above, then pick its members.' })); return box; }

  groups.forEach((g     ) => {
    const card = el('div', { style: { border: '1px solid var(--line)', borderRadius: '6px', padding: '10px', margin: '8px 0', background: 'var(--panel2)' } });
    const head = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } });
    const labEdit = el('input', { type: 'text', value: g.Label || g.Id, style: { width: '200px' } })                    ;
    labEdit.onchange = () => { g.Label = labEdit.value.trim() || g.Id; };
    const kindEdit = el('select', { style: { width: 'auto' } });
    NODE_KINDS.forEach(([v, label]) => kindEdit.appendChild(el('option', { value: v, text: label })));
    kindEdit.value = g.Kind || 'node';
    kindEdit.onchange = () => { g.Kind = kindEdit.value === 'node' ? undefined : kindEdit.value; };
    const del = btn('Delete', 'danger');
    del.onclick = () => { groups.splice(groups.indexOf(g), 1); toast(`Group ${g.Label || g.Id} deleted.`, true); rerender(); };
    head.append(el('code', { text: g.Id, style: { color: 'var(--muted)' } }), labEdit, kindEdit, del);
    card.appendChild(head);

    // Members as removable chips, plus a picker of candidates not already in the group.
    const memRow = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', margin: '8px 0 0' } });
    memRow.appendChild(el('span', { class: 'desc', style: { margin: '0', minWidth: '64px' }, text: 'Members' }));
    (g.Members || []).forEach((m        ) => {
      const chip = el('span', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '1px 8px', fontSize: '12px' } });
      const x = el('span', { text: '✕', style: { cursor: 'pointer', color: 'var(--bad)' } });
      x.onclick = () => { g.Members.splice(g.Members.indexOf(m), 1); rerender(); };
      chip.append(nm(m), x); memRow.appendChild(chip);
    });
    const sel = el('select', { style: { width: 'auto' } })                     ;
    sel.appendChild(el('option', { value: '', text: '+ add member…' }));
    [...cand.keys()].filter(id => id !== g.Id && !(g.Members || []).includes(id)).sort((a, b) => nm(a).localeCompare(nm(b)))
      .forEach(id => sel.appendChild(el('option', { value: id, text: nm(id) })));
    sel.onchange = () => { if (sel.value) { ensure(g, 'Members', []).push(sel.value); rerender(); } };
    memRow.appendChild(sel);
    card.appendChild(memRow);
    box.appendChild(card);
  });

  return box;
}

// The open node editor, as a modal over the table (#292).
let nodeModal                                                      = null;

function closeNodeModal() {
  const m = nodeModal;
  nodeModal = null;
  if (m) m.close();
}

function syncNodeModal(node     , links       , cand                  , editing                       , rerender            ) {
  if (!node) { closeNodeModal(); return; }
  if (nodeModal && nodeModal.id !== node.Id) closeNodeModal();   // switched rows: a fresh panel, fresh title
  if (!nodeModal) {
    const o = overlay(`Edit node — ${node.Label || node.Id}`, () => { nodeModal = null; editing.id = null; rerender(); });
    nodeModal = { id: node.Id, body: o.body, close: o.close };
  }
  nodeModal.body.innerHTML = '';
  nodeModal.body.appendChild(renderNodeEditor(node, links, cand, (close          ) => { if (close) editing.id = null; rerender(); }));
}

/// Would adding from -> to close a cycle?
function wouldLoop(links       , from        , to        ) {
  const adj      = {};
  links.forEach(l => (adj[l.From] = adj[l.From] || []).push(l.To));
  const stack = [to]; const seen = new Set        ();
  while (stack.length) {
    const x = stack.pop() ;
    if (x === from) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    (adj[x] || []).forEach((t        ) => stack.push(t));
  }
  return false;
}

// Virtual-node manager (#129): the dedicated node-configuration surface (its own Nodes tab).
function renderNodeManager(flow     , customNodes       , links       , cand                  , editing                       , rerender                           ) {
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Virtual nodes', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'The custom nodes you’ve added (panels, breakers, batteries, producers, a “Total”). Click Edit to set the name, kind, how it’s valued, and bind live values from your broker.' }));

  if (!customNodes.length) {
    closeNodeModal();
    box.appendChild(el('div', { class: 'desc', text: 'No virtual nodes yet — add one above.' }));
    return box;
  }

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Id', 'Label', 'Kind', 'Mode', 'Value', 'Max', 'Tags', 'Fed by', 'Bindings', ''].forEach(h => {
    const th = el('th', { text: h });
    if (h === 'Tags') th.title = 'Free-form labels for filtering the views. A tag never changes a reading.';
    if (h === 'Fed by') th.title = 'What supplies this node. The same wiring as dragging on the Hierarchy tab, without the dragging.';
    if (h === 'Max') th.title = 'Full-scale value for this node’s gauge on the Energy page — a PV array’s peak output, an inverter’s rating, a breaker’s size. Blank shows the plain reading instead; no ceiling is ever guessed.';
    if (h === 'Bindings') th.title = 'Live source bindings. ⚠ = bound, but no energy (kWh) metric — the node won’t appear on Home Assistant’s Energy Dashboard until you add an Energy source.';
    head.appendChild(th);
  });
  tbl.appendChild(el('thead', {}, head));
  const body = el('tbody');
  customNodes.forEach((n     ) => {
    const tr = el('tr');
    if (editing.id === n.Id) tr.style.outline = '2px solid var(--accent, #4f8cff)';
    tr.appendChild(el('td', {}, el('code', { text: n.Id, style: { color: 'var(--muted)' } })));
    tr.appendChild(el('td', { text: n.Label || n.Id }));
    tr.appendChild(el('td', { text: kindMeta(n.Kind)[1] }));
    tr.appendChild(el('td', { text: n.Mode || 'auto' }));
    tr.appendChild(el('td', { class: 'num', text: n.Value ?? '—' }));
    tr.appendChild(el('td', { class: 'num', text: n.Max ?? '—' }));
    tr.appendChild(el('td', { text: (n.Tags || []).join(', ') || '—' }));

    // Wiring without dragging, in the direction the hierarchy is built in: what supplies this node.
    const incoming = links.filter((l     ) => l.To === n.Id).map((l     ) => l.From);
    const fedByCell = el('td');
    if (incoming.length > 1) {
      // Several feeders is legitimate — a transfer switch fed by grid, generator and inverter.
      fedByCell.appendChild(el('span', { text: incoming.map((f        ) => (cand.get(f) || {}).label || f).join(', ') }));
    } else {
      const sel = el('select', { style: { width: 'auto' } })                     ;
      sel.appendChild(el('option', { value: '', text: '— none —' }));
      [...cand.keys()]
        .filter(id => id !== n.Id && !String(id).includes('#'))
        .sort((a, b) => ((cand.get(a) || {}).label || a).localeCompare((cand.get(b) || {}).label || b))
        .forEach(id => sel.appendChild(el('option', { value: id, text: (cand.get(id) || {}).label || id })));
      sel.value = incoming[0] || '';
      sel.onchange = () => {
        const feeder = sel.value;
        // Energy would have to arrive from something this node already supplies.
        if (feeder && wouldLoop(links.filter((l     ) => l.To !== n.Id), feeder, n.Id)) {
          toast('That would create a feeder loop.', false);
          sel.value = incoming[0] || '';
          return;
        }
        // One incoming link is what this control manages: drop the old one, add the new.
        for (let i = links.length - 1; i >= 0; i--) if (links[i].To === n.Id) links.splice(i, 1);
        if (feeder) links.push({ From: feeder, To: n.Id });
        rerender();
      };
      fedByCell.appendChild(sel);
    }
    tr.appendChild(fedByCell);
    // Flag a node that's measured but has no energy (kWh) source — it can't feed HA's Energy Dashboard (#262).
    const srcs = [...(n.Sources || []), ...(n.Mqtt || [])];
    const nb = srcs.length;
    const hasEnergy = srcs.some((s     ) => String(s.Metric || 'realpower').toLowerCase() === 'energy');
    const bindCell = el('td', { class: nb ? '' : 'num' });
    bindCell.appendChild(el('span', { text: nb ? String(nb) : '—' }));
    if (nb && !hasEnergy)
      bindCell.appendChild(el('span', {
        text: ' ⚠', style: { color: 'var(--warn)', fontWeight: '700', cursor: 'help' },
        title: 'No energy (kWh) source bound — this node won’t appear on Home Assistant’s Energy Dashboard. Edit it and add a source with the “Energy” metric to include it.',
      }));
    tr.appendChild(bindCell);

    const actions = el('td', { style: { whiteSpace: 'nowrap' } });
    const edit = btn(editing.id === n.Id ? 'Editing…' : 'Edit');
    edit.onclick = () => { editing.id = editing.id === n.Id ? null : n.Id; rerender(); };
    const rename = btn('Rename');
    rename.title = 'Change this node’s id, moving its wiring with it.';
    rename.onclick = () => {
      const taken = new Set        ([...cand.keys(), ...customNodes.map((x     ) => x.Id)]);
      taken.delete(n.Id);
      openRenameDialog(n, flow, taken, id => { if (editing.id === n.Id) editing.id = id; rerender(); });
    };

    // Copy: the same node under a free id, opened for renaming.
    const copy = btn('Copy');
    copy.title = 'Duplicate this node (kind, mode, value and bindings) under a new id — rename it, then wire it up.';
    copy.onclick = () => {
      const taken = (id        ) => customNodes.some((x     ) => x.Id === id);
      let id = `${n.Id}-copy`;
      for (let i = 2; taken(id); i++) id = `${n.Id}-copy-${i}`;
      const clone = JSON.parse(JSON.stringify(n));
      clone.Id = id;
      clone.Label = `${n.Label || n.Id} (copy)`;
      customNodes.splice(customNodes.indexOf(n) + 1, 0, clone);
      editing.id = id;
      toast(`Copied to '${id}' — rename it and set its feeders.`, true);
      rerender();
    };
    const rm = btn('Delete', 'danger');
    rm.onclick = () => {
      customNodes.splice(customNodes.indexOf(n), 1);
      for (let j = links.length - 1; j >= 0; j--) if (links[j].From === n.Id || links[j].To === n.Id) links.splice(j, 1);
      if (editing.id === n.Id) editing.id = null;
      toast(`${n.Label || n.Id} deleted.`, true);
      rerender();
    };
    actions.append(edit, ' ', rename, ' ', copy, ' ', rm);
    tr.appendChild(actions);
    body.appendChild(tr);
  });
  tbl.appendChild(body);
  box.appendChild(tbl);

  // A deleted or renamed-away node leaves editing.id dangling; find() returning nothing closes the panel.
  syncNodeModal(editing.id ? customNodes.find((n     ) => n.Id === editing.id) : null, links, cand, editing, rerender);
  return box;
}

function addNodesSection(nav     , sections     ) {
  const link = navLink(nav, "Nodes", "⬡");
  // Both tabs edit the shared EnergyFlow object, so their nav entries carry its unsaved-edit count.
  link.dataset.section = "EnergyFlow";
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Energy Nodes'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Configure the virtual nodes in your energy hierarchy — panels, breakers, batteries, producers, a “Total”. Set each node’s kind, how it’s valued, its live-value bindings (MQTT / Modbus), and its feeders & children. The wiring also shows visually on the Flow tab.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const instSel = instanceSelector(() => load());
  const count = document.createElement('span'); count.className = 'ld-count';
  bar.appendChild(instSel.wrap); bar.appendChild(count); sec.appendChild(bar);
  const ed      = document.createElement('div'); ed.style.marginTop = '8px'; sec.appendChild(ed);
  let lastGraph      = null;
  const editing                        = { id: null };

  const render = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const customNodes = ensure(flow, 'Nodes', []);
    const links = ensure(flow, 'Links', []);
    count.textContent = `${customNodes.length} node(s)`;
    ed.innerHTML = '';

    const addBar = el('div', { class: 'ld-toolbar' });
    const idIn = el('input', { type: 'text', placeholder: 'id (e.g. gridboss)' });
    const labIn = el('input', { type: 'text', placeholder: 'label (e.g. Grid Boss)' });
    const kindSel = el('select', { style: { width: 'auto' } });
    NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
    const addBtn = btn('Add node', 'primary');
    const importBtn = btn('Import device template');
    const save = btn('Save', 'primary');
    addBtn.onclick = () => {
      const id = (idIn.value || '').trim(); if (!id) { toast('Node id is required.', false); return; }
      if (customNodes.some((n     ) => n.Id === id) || (lastGraph?.nodes || []).some((n     ) => n.id === id)) { toast('That id already exists.', false); return; }
      // Mode 'none' by default: a brand-new node has nothing measuring it.
      const node      = { Id: id, Label: (labIn.value || '').trim() || id, Mode: 'none' };
      if (kindSel.value !== 'node') node.Kind = kindSel.value;
      customNodes.push(node); editing.id = id; render();  // open the new node's editor straight away
    };
    save.onclick = () => saveConfig(load);
    addBar.append(idIn, labIn, kindSel, addBtn, importBtn, save); ed.appendChild(addBar);

    // Import-device-template panel, toggled by the button (existing ids guard against prefix clashes).
    const existingIds = new Set        ([...customNodes.map((n     ) => n.Id), ...((lastGraph?.nodes || []).map((n     ) => n.id))]);
    const impWrap = el('div'); ed.appendChild(impWrap);
    importBtn.onclick = () => {
      if (impWrap.firstChild) { impWrap.innerHTML = ''; return; }   // toggle closed
      impWrap.appendChild(renderImportPanel(flow, existingIds, render));
    };

    const cand = flowCandidates(lastGraph, customNodes);
    ed.appendChild(renderGroupManager(flow, cand, render));
    ed.appendChild(renderAutoTagRules(flow, cand, render));
    ed.appendChild(renderTagManager(render));
    ed.appendChild(renderNodeManager(flow, customNodes, links, cand, editing, (close          ) => { if (close) editing.id = null; render(); }));
  };

  const load = async () => {
    // The flow graph gives the auto (pdu/outlet) node ids for the feeder/children pickers.
    const r = await api(withInstance('/api/flow', instSel));
    lastGraph = r.body?.ok ? r.body : null;
    render();
  };
  link.onclick = () => { activate(link, sec); load(); };
  // The editor panel is mounted on <body>.
  nav.addEventListener('click', (e     ) => { if (nodeModal && !link.contains(e.target)) { editing.id = null; closeNodeModal(); } });
}

// ── sections/energy-board.ts ────────────────────────────────────
// The Energy Overview: solar / battery / grid / home as tiles and an animated diagram.
// The energy rules every view shares — see energy.ts for why they are not written twice.

// The Energy overview (#energy-rollup C): an at-a-glance board of where power is flowing right now —
function addEnergyOverviewSection(nav     , sections     ) {
  const link = navLink(nav, "Energy", "⚡");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Energy Overview' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Where your power is flowing right now, from the latest poll. Figures are summed from the nodes you tagged solar / battery / grid; anything unmeasured shows “—”, never a guess. Tag nodes and bind their sources on the Nodes tab.' }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  // Power now, or energy for the day so far (#371).
  const showSel = el('select', { style: { width: 'auto' } })                     ;
  showSel.appendChild(el('option', { value: 'realpower', text: 'Power (W)' }));
  showSel.appendChild(el('option', { value: 'energytoday', text: 'Energy today (kWh)' }));
  const instSel = instanceSelector(() => load());
  const status = el('span', { class: 'ld-count' });
  bar.append(refresh, el('span', { class: 'desc', style: { margin: '0' }, text: 'Show:' }), showSel, instSel.wrap, status);
  sec.appendChild(bar);
  // As on the Flow page: a whole day is an energy question, a specific time is a power one.
  let hadDay = false;
  const hist = historyControl((what     ) => {
    periods.mark(null);
    const leftLive = what === 'day' && !hadDay && !!hist.day();
    hadDay = !!hist.day();
    if ((leftLive && !hist.time() && showSel.value === 'realpower') || (what === 'span' && hist.span() > 1))
      showSel.value = 'energytoday';
    load();
  });
  // One click for the periods people actually ask for. A period is a question about energy — "how much
  // today" — so it answers in energy rather than leaving a power reading under a heading about a month.
  const periods = periodRow((key           ) => {
    const { day, days } = periodWindow(key);
    hist.set(day, days);
    showSel.value = 'energytoday';
    periods.mark(key);
    hadDay = true;
    load();
  });
  sec.appendChild(periods.row);
  sec.appendChild(hist.row);
  showSel.onchange = () => load();

  // One column for the whole board.
  const board = el('div', { class: 'energy-board' }); sec.appendChild(board);
  const flowWrap = el('div', { class: 'energy-flow' }); board.appendChild(flowWrap);
  const grid = el('div', { class: 'energy-grid' }); board.appendChild(grid);
  const summary = el('div', { class: 'energy-summary' }); board.appendChild(summary);

  const fmtPower = (w               ) => w == null ? '—'
    : Math.abs(w) >= 1000 ? `${formatNum(w / 1000)} kW` : `${formatNum(Math.round(w))} W`;
  // Energy is cumulative (kWh); one decimal is plenty and the units come from the energy graph itself.
  const fmtEnergy = (v               , units        ) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} ${units || 'kWh'}`;

  // A tile: coloured accent, big power figure, a direction/idle sub-line.
  const gaugeArc = (fraction        , over         ) => {
    const R = 26, CX = 30, CY = 30;
    // A 240° sweep opening at the bottom — the shape a dial is read as.
    const START = 150, SWEEP = 240;
    const pt = (deg        ) => {
      const r = (deg * Math.PI) / 180;
      return `${(CX + R * Math.cos(r)).toFixed(2)},${(CY + R * Math.sin(r)).toFixed(2)}`;
    };
    const arc = (from        , to        , cls        , extra                         = {}) => svgEl('path', {
      d: `M${pt(from)} A${R},${R} 0 ${to - from > 180 ? 1 : 0} 1 ${pt(to)}`,
      fill: 'none', 'stroke-width': '6', 'stroke-linecap': 'round', class: cls, ...extra,
    });
    const g = svgEl('svg', { viewBox: '0 0 60 60', class: 'gauge', width: '60', height: '60' });
    g.appendChild(arc(START, START + SWEEP, 'gauge-track'));
    if (fraction > 0) g.appendChild(arc(START, START + SWEEP * fraction, over ? 'gauge-fill over' : 'gauge-fill'));
    return g;
  };

  const tile = (cls        , icon        , label        , value        , sub        , subCls = '',
                gauge                                                                  ,
                trend                                                                                          ,
                link                                   ) => {
    const t = el('div', { class: 'energy-tile' + (cls ? ' ' + cls : '') });
    const head = el('div', { class: 'energy-head' });
    head.append(el('span', { class: 'energy-icon', text: icon }), el('span', { class: 'energy-label', text: label }));
    t.append(head, el('div', { class: 'energy-value', text: value }), el('div', { class: 'energy-sub' + (subCls ? ' ' + subCls : ''), text: sub }));
    if (gauge) {
      const wrap = el('div', { class: 'gauge-wrap' });
      wrap.appendChild(gaugeArc(gauge.fraction, gauge.over));
      wrap.appendChild(el('span', {
        class: 'gauge-cap' + (gauge.over ? ' over' : ''),
        text: gauge.over ? `over ${formatNum(gauge.max)} ${gauge.units}` : `of ${formatNum(gauge.max)} ${gauge.units}`,
      }));
      wrap.title = gauge.over
        ? `This reading is past the ${formatNum(gauge.max)} ${gauge.units} maximum set for this node, so the dial `
          + 'shows full. The reading is not wrong — the stated maximum is too low. Change it on the Nodes tab.'
        : `${Math.round(gauge.fraction * 100)}% of the ${formatNum(gauge.max)} ${gauge.units} maximum set for this node.`;
      t.appendChild(wrap);
    }
    // The shape behind the number. A tile without one looks exactly as it did before — no placeholder, and
    // no flat line standing in for readings nobody has.
    if (trend) t.appendChild(sparkline({ values: trend.values, color: trend.color, units: trend.units, at: trend.at }));
    if (link && link.ids.length) openOnClick(t, link.ids, link.label);
    return t;
  };

  /// Make something a way into this node's own day on the Trends page.
  ///
  /// The board answers "what is happening now"; the obvious next question is "and what has it been doing
  /// today", which was three deliberate steps away — open Trends, change the range, then untick everything
  /// that is not this. The click carries the node set the tile was summed from, so the answer is about the
  /// same nodes the figure came from rather than whatever Trends happened to be showing.
  const openOnClick = (elm     , ids          , label        ) => {
    elm.classList?.add('is-linked');
    elm.style.cursor = 'pointer';
    if (elm.setAttribute) elm.setAttribute('tabindex', '0');
    const title = `Show ${label} for today on the Trends page`;
    if (elm.setAttribute) elm.setAttribute('title', title); else elm.title = title;

    const go = () => {
      requestFocus(ids, 'today=1&step=300', label);
      const link = [...document.querySelectorAll('nav a')].find((a     ) => (a.dataset?.label || '') === 'Trends');
      if (link) (link       ).click();
    };
    elm.addEventListener('click', go);
    elm.addEventListener('keydown', (e     ) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault?.(); go(); } });
  };

  /// One trend per tile, summed across the nodes that tile is made of.
  ///
  /// Strict on gaps: a step counts only when EVERY node behind the tile reported at it. A partial sum drawn
  /// as a total is the same lie as a fabricated reading — three MPPTs where one dropped out would show the
  /// array's output falling, when what fell was the coverage.
  const trendFor = (ids          , color        , units        ) => {
    if (!ids.length || !trendSeries) return undefined;
    const rows = ids.map(id => trendSeries .byNode.get(id)).filter(Boolean)                       ;
    if (rows.length !== ids.length || !rows.length) return undefined;

    const values = rows[0].map((_, i) =>
      rows.every(r => r[i] != null && Number.isFinite(r[i]          ))
        ? rows.reduce((sum, r) => sum + (r[i]          ), 0)
        : null);
    return values.some(v => v != null) ? { values, color, units, at: trendSeries .at } : undefined;
  };

  /// The gauge for a node, or undefined when one would be a guess.
  const gaugeFor = (ids          , value               , units        ) => {
    const cfgNodes = (state.data?.EnergyFlow?.Nodes || [])         ;
    // Several tagged nodes of one kind (three MPPTs, two arrays) sum into one tile, so their ceilings sum too.
    const maxes = ids.map(id => cfgNodes.find(n => n.Id === id)?.Max).filter((m     ) => typeof m === 'number' && m > 0);
    if (!maxes.length || value == null) return undefined;
    const max = maxes.reduce((a        , b        ) => a + b, 0);
    const fraction = Math.min(1, Math.max(0, value / max));
    return { fraction, over: value > max, max, units };
  };

  const drawFlow = (arms           ) =>
    drawEnergyFlow(flowWrap, arms, (a, g) => openOnClick(g, a.ids , a.label));

  // Why is this tile empty?
  const whyNoReading = (kind        ) => {
    const nodes = (state.data?.EnergyFlow?.Nodes || []).filter((n     ) => (n.Kind || '') === kind);
    if (!nodes.length) return 'no reading yet';
    const bound = nodes.flatMap((n     ) => n.Sources || []);
    if (!bound.length)
      return nodes.some((n     ) => n.Value != null) ? 'static value only' : 'no source bound';
    // Bound but silent: name what it is waiting on, so the topic/register can be checked against reality.
    const first = bound[0];
    const what = first.Type === 'modbus'
      ? `${first.Connection || 'modbus'} reg ${first.Register}`
      : (first.Topic || 'its source');
    return bound.length > 1 ? `waiting on ${bound.length} sources` : `waiting on ${what}`;
  };
  // The hint under a tile: the direction when there's a value, the reason when there isn't.
  const subOrWhy = (value               , kind        , whenKnown        ) => value == null ? whyNoReading(kind) : whenKnown;

  // Same question for the battery's state of charge.
  const whyNoSoc = (battIds          , liveInfo                     ) => {
    const cfg = (state.data?.EnergyFlow?.Nodes || []).filter((n     ) => battIds.includes(n.Id));
    if (!cfg.length) return 'no battery node';
    const socSrcs = cfg.flatMap((n     ) => (n.Sources || []).filter((s     ) => s.Metric === 'soc'));
    if (!socSrcs.length) return 'no charge source bound';
    // Bound and expired: the endpoint still reports the last reading.
    const stale = battIds.map(id => liveInfo[`${id}|soc`]).find((i     ) => i && i.reported != null);
    if (stale) {
      const secs = Math.round(stale.ageSeconds || 0);
      const ago = secs >= 3600 ? `${Math.round(secs / 360) / 10} h` : secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs} s`;
      return `charge ${ago} stale`;
    }
    const first = socSrcs[0];
    const what = first.Type === 'modbus' ? `${first.Connection || 'modbus'} reg ${first.Register}` : (first.Topic || 'its source');
    return `no charge yet from ${what}`;
  };

  // Sum a kind's out-direction (graph) values.
  const sumKind = (nodes       , kind        ) => {
    const ns = nodes.filter(n => (n.kind || 'node') === kind);
    let sum = 0, known = false;
    ns.forEach(n => { if (typeof n.value === 'number') { sum += n.value; known = true; } });
    return { present: ns.length > 0, value: known ? sum : null };
  };

  // The board needs several round-trips, and is triggered by pushes as well as by the timer.
  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    try { await loadBoard(); } finally { loading = false; }
  };

  // The last few hours behind the tiles, keyed by node. Null until a load fills it, and left null when
  // history is off or the backend has nothing — which is why a tile can simply have no trend.
  let trendSeries                                                                               = null;

  /// Read the window every tile's trend is drawn from. One request for the whole board.
  const loadTrend = async (metric        ) => {
    trendSeries = null;
    // A past instant is a moment, not a window: the trend would be the same line on every tile.
    if (hist.at() || hist.span() > 1) return;
    try {
      const minutes = 180, step = 300;
      const r = await api(withInstance(
        `/api/flow/series?minutes=${minutes}&step=${step}&metric=${encodeURIComponent(metric)}`, instSel));
      const body = r?.body;
      if (!body || !body.ok || !Array.isArray(body.series) || !body.series.length) return;

      const byNode = new Map                           ();
      for (const s of body.series) if (s && s.node) byNode.set(s.node, s.values || []);
      const points = Math.max(...[...byNode.values()].map(v => v.length), 0);
      if (points < 2) return;

      // Each point's clock time in the viewer's own zone, for the hover.
      const stepMs = step * 1000, endMs = Date.now();
      const at = (i        ) => new Date(endMs - (points - 1 - i) * stepMs)
        .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      trendSeries = { byNode, at };
    } catch { /* the board is the point; a missing trend just means no line */ }
  };

  const loadBoard = async () => {
    // The whole board reads one metric (#371).
    const metric = showSel.value || 'realpower';
    const isEnergy = metric !== 'realpower';
    let r     ;
    const at = hist.at();
    let path = withInstance('/api/flow' + (isEnergy ? '?metric=' + encodeURIComponent(metric) : ''), instSel);
    const past = historyQuery(hist);
    if (past) path += (path.includes('?') ? '&' : '?') + past.slice(1);
    try { r = await api(path); }
    catch (e     ) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    await loadTrend(metric);
    grid.innerHTML = ''; summary.innerHTML = ''; flowWrap.innerHTML = '';
    if (!r.body || !r.body.ok) {
      // Say what actually went wrong.
      const why = (r.body && r.body.message) || `the server answered ${r.status ?? '?'} with no explanation`;
      grid.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'Could not load energy data — ' + why }));
      status.textContent = ''; return;
    }
    // Derived lanes are for the diagram, not the totals.
    hist.setNote(historyNote(r.body));
    const nodes = (r.body.nodes || []).filter((n     ) => !String(n.id || '').includes('#'));

    // Live cache reads: the in-direction (charge/export) power for battery/grid nodes.
    const battIds = nodes.filter((n     ) => n.kind === 'battery').map((n     ) => n.id);
    const gridIds = nodes.filter((n     ) => n.kind === 'grid').map((n     ) => n.id);
    // The other two kinds, for the gauges: a tile sums every node of its kind, so its ceiling sums too.
    const solarIds = nodes.filter((n     ) => n.kind === 'solar').map((n     ) => n.id);
    const loadIds = nodes.filter((n     ) => n.kind === 'load').map((n     ) => n.id);
    const liveBy                         = {};
    // The full record, not just the value: it carries the staleness fields (reported/ageSeconds/fresh).
    const liveInfo                      = {};

    // A past view must not read the live cache.
    const historical = !!r.body.historical;
    const inFromGraph                         = {};
    if (historical)
      (r.body.nodes || []).forEach((n     ) => {
        const id = String(n.id || '');
        if (id.endsWith('#in') && typeof n.value === 'number') inFromGraph[id.slice(0, -3) + '|' + metric + '#in'] = n.value;
      });

    const q = historical ? [] : [
      ...[...battIds, ...gridIds].map(id => ({ Node: id, Metric: metric + '#in' })),
      ...battIds.map(id => ({ Node: id, Metric: 'soc' })),
    ];
    if (q.length) {
      try {
        const lr = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
        (lr.body?.values || []).forEach((v     ) => {
          liveInfo[`${v.node}|${v.metric}`] = v;
          if (typeof v.value === 'number') liveBy[`${v.node}|${v.metric}`] = v.value;
        });
      } catch { /* no live cache — these reads just stay absent */ }
    }
    const inBy = historical ? inFromGraph : liveBy;
    const sumIn = (ids          ) => { let s = 0, known = false; ids.forEach(id => { const k = `${id}|${metric}#in`; if (k in inBy) { s += inBy[k]; known = true; } }); return known ? s : null; };
    // Battery SoC: average across battery nodes that report it (a bank reads as one figure). Only live —
    const socVals = historical ? [] : battIds.map(id => liveBy[`${id}|soc`]).filter((v)              => typeof v === 'number');
    const soc = socVals.length ? Math.round(socVals.reduce((a, b) => a + b, 0) / socVals.length) : null;

    // Formatting and gauges follow the metric.
    const units = r.body.units || (isEnergy ? 'kWh' : 'W');
    const fmt = (v               ) => isEnergy ? fmtEnergy(v, units) : fmtPower(v);
    const dial = (ids          , v               ) => isEnergy ? undefined : gaugeFor(ids, v, 'W');

    const solar = sumKind(nodes, 'solar');
    const batt = sumKind(nodes, 'battery');   // out = discharge
    const gridK = sumKind(nodes, 'grid');     // out = import
    const load_ = sumKind(nodes, 'load');
    const battIn = sumIn(battIds);            // charge
    const gridIn = sumIn(gridIds);            // export

    // Net = out − in. Present-but-all-unknown stays null; a measured side alone still yields a net.
    const net = (out                                            , inV               ) =>
      out.value == null && inV == null ? null : (out.value || 0) - (inV || 0);
    const battNet = net(batt, battIn);
    const gridNet = net(gridK, gridIn);

    // Home load: prefer explicitly-tagged load nodes; otherwise derive from the balance.
    let home                = null, homeSub = '';
    if (load_.present) { home = load_.value; homeSub = home == null ? 'no reading yet' : 'consuming'; }
    else {
      // Same rule as the Trends page: a kind the system does not have is left out.
      home = homeEnergy({
        ...(solar.present ? { solar: solar.value } : {}),
        ...(batt.present ? { battery: battNet } : {}),
        ...(gridK.present ? { grid: gridNet } : {}),
      });
      if (home != null) homeSub = 'balance of measured sources';
    }

    // Self-sufficiency is an ENERGY question — over some window.
    let eHome                = null, eFromGrid                = null, eUnits = 'kWh';
    let eWindow = 'of lifetime energy';
    if (isEnergy) {
      // The board is already an energy view, so the bar is a share of the very tiles above it.
      eHome = home;
      eUnits = units;
      // Energy drawn from the grid is what it imported.
      eFromGrid = gridK.value == null ? null : Math.max(0, gridK.value);
      const day = hist.day();
      eWindow = day ? `of energy on ${new Date(hist.at()).toLocaleDateString()}`
        : metric === 'energytoday' ? 'of today’s energy' : 'of lifetime energy';
    } else try {
      // Today, not all time.
      const er = await api(withInstance('/api/flow?metric=energytoday', instSel));
      if (er.body?.ok) {
        const enodes = er.body.nodes || [];
        eUnits = er.body.units || 'kWh';
        // From the answer, not from what was asked for.
        eWindow = er.body.metric === 'energytoday' ? 'of today’s energy' : 'of lifetime energy';
        const eSolar = sumKind(enodes, 'solar'), eBatt = sumKind(enodes, 'battery'), eGrid = sumKind(enodes, 'grid'), eLoad = sumKind(enodes, 'load');
        // In-direction (charge/export) energy from the same live cache, keyed to the same metric.
        const eInBy                         = {};
        const eq = [...battIds, ...gridIds].map(id => ({ Node: id, Metric: 'energytoday#in' }));
        if (eq.length) {
          try {
            const elr = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eq) });
            (elr.body?.values || []).forEach((v     ) => { if (typeof v.value === 'number') eInBy[`${v.node}|${v.metric}`] = v.value; });
          } catch { /* no live cache — energy#in just stays absent */ }
        }
        const eSumIn = (ids          ) => { let s = 0, known = false; ids.forEach(id => { const k = `${id}|energytoday#in`; if (k in eInBy) { s += eInBy[k]; known = true; } }); return known ? s : null; };
        const eBattNet = net(eBatt, eSumIn(battIds)), eGridNet = net(eGrid, eSumIn(gridIds));
        // Home energy: tagged load nodes if present, else the balance of measured sources (same rule as power).
        if (eLoad.present) eHome = eLoad.value;
        else {
          const unknownFeeder = (eSolar.present && eSolar.value == null) || (eBatt.present && eBatt.value == null) || (eGrid.present && eGrid.value == null);
          if (!unknownFeeder && (eSolar.present || eBatt.present || eGrid.present)) eHome = (eSolar.value || 0) + (eBattNet || 0) + (eGridNet || 0);
        }
        // What the house drew, not what it drew net of what it sent back.
        if (eGrid.value != null) eFromGrid = Math.max(0, eGrid.value);
      }
    } catch { /* energy graph unavailable — self-sufficiency just won't render */ }

    // Animated flow diagram — the arms present in this system, each with its live figure and flow direction.
    const arms        = [];
    if (solar.present) arms.push({ key: 'solar', icon: '☀️', label: 'Solar', text: fmt(solar.value), color: 'var(--warn)', flow: solar.value, ids: solarIds });
    if (batt.present || battIds.length) arms.push({ key: 'battery', icon: '🔋', label: 'Battery', text: soc != null ? `${soc}%` : fmt(battNet == null ? null : Math.abs(battNet)), color: 'var(--good)', flow: battNet, ids: battIds });
    if (gridK.present || gridIds.length) arms.push({ key: 'grid', icon: '⚡', label: 'Grid', text: fmt(gridNet == null ? null : Math.abs(gridNet)), color: 'var(--accent)', flow: gridNet, ids: gridIds });
    if (home != null || load_.present) arms.push({ key: 'home', icon: '🏠', label: 'Home', text: fmt(home), color: 'var(--muted)', flow: home, ids: loadIds });
    if (arms.length) drawFlow(arms);

    // Solar
    if (solar.present)
      grid.appendChild(tile('solar', '☀️', 'Solar', fmt(solar.value),
        subOrWhy(solar.value, 'solar', solar.value  > 1 ? 'producing' : 'idle'), solar.value && solar.value > 1 ? 'supply' : '',
        dial(solarIds, solar.value), trendFor(solarIds, 'var(--warn)', units), { ids: solarIds, label: 'Solar' }));

    // Battery — sign tells charge vs discharge; magnitude is what's shown. SoC (when bound) leads the sub-line.
    if (batt.present || battIds.length) {
      const dir = subOrWhy(battNet, 'battery', battNet  > 1 ? 'discharging' : battNet  < -1 ? 'charging' : 'idle');
      const cls = battNet == null ? '' : battNet > 1 ? 'supply' : battNet < -1 ? 'draw' : '';
      // SoC always leads the sub-line, so the state-of-charge slot is always shown.
      const socWhy = soc == null ? whyNoSoc(battIds, liveInfo) : null;
      // The dial is the battery's power against its rating; the slim bar below is state of charge.
      const t = tile('battery', '🔋', 'Battery', fmt(battNet == null ? null : Math.abs(battNet)), `${soc == null ? socWhy : soc + '%'} · ${dir}`, cls,
        dial(battIds, battNet == null ? null : Math.abs(battNet)), trendFor(battIds, 'var(--good)', units), { ids: battIds, label: 'Battery' });
      if (socWhy) t.title = `No battery percentage: ${socWhy}. Bind or correct the state-of-charge source on the Nodes tab.`;
      // A slim charge gauge under the tile when SoC is known — the "battery %" at a glance.
      if (soc != null) {
        const g = el('div', { class: 'energy-soc-bar', title: `${soc}% state of charge` }, el('span', { style: { width: soc + '%' } }));
        t.appendChild(g);
      }
      grid.appendChild(t);
    }

    // Grid — positive = importing (drawing from the utility), negative = exporting (selling back).
    if (gridK.present || gridIds.length) {
      const sub = subOrWhy(gridNet, 'grid', gridNet  > 1 ? 'importing' : gridNet  < -1 ? 'exporting' : 'idle');
      const cls = gridNet == null ? '' : gridNet > 1 ? 'draw' : gridNet < -1 ? 'supply' : '';
      // On energy the figure is the day's NET — import minus export, signed (#371).
      const gridShown = gridNet == null ? null : isEnergy ? gridNet : Math.abs(gridNet);
      grid.appendChild(tile('grid', '⚡', 'Grid', fmt(gridShown),
        isEnergy ? `${sub} · net for the day` : sub, cls,
        dial(gridIds, gridNet == null ? null : Math.abs(gridNet)), trendFor(gridIds, 'var(--accent)', units), { ids: gridIds, label: 'Grid' }));
    }

    // Home load (computed above with the flow arms).
    if (home != null || load_.present)
      grid.appendChild(tile('home', '🏠', 'Home', fmt(home), home == null ? whyNoReading('load') : (homeSub || 'consuming'), '',
        dial(loadIds, home), trendFor(loadIds, 'var(--muted)', units), { ids: loadIds, label: 'Home' }));

    // Self-sufficiency: the share of the home's energy (kWh) over the window above that was not drawn from the grid.
    const ssPct = selfSufficiencyPct(eHome, eFromGrid);
    const ssCovered = coveredEnergy(eHome, eFromGrid);
    if (ssPct != null && ssCovered != null) {
      const covered = ssCovered;
      const pct = Math.round(ssPct);
      const row = el('div', { class: 'energy-selfsuff' });
      row.append(
        el('div', { class: 'energy-ss-label', text: `Self-sufficiency ${pct}%` }),
        el('div', { class: 'energy-ss-bar' }, el('span', { style: { width: pct + '%' } })),
        el('div', { class: 'desc', text: `${fmtEnergy(covered, eUnits)} of ${fmtEnergy(eHome, eUnits)} ${eWindow} covered by solar + battery.` }),
      );
      summary.appendChild(row);
    }

    if (!grid.children.length)
      grid.appendChild(el('div', { class: 'desc', text: 'Nothing tagged yet. On the Nodes tab, set a node’s Kind to solar, battery, or grid and bind a source — it’ll show here.' }));
    status.textContent = `updated ${new Date().toLocaleTimeString()}`;
  };

  refresh.onclick = () => load();

  // The board is assembled from several reads, so the push is used as a trigger to rebuild it.
  const syncLive = liveWhileActive(sec, () => 'flow:realpower' + (instSel.get() ? '|' + instSel.get() : ''),
    () => { if (!hist.day()) load(); });
  // Fallback for when the stream isn't up; it does nothing while it is.
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive() && !hist.day()) load(); }, 8000);
  link.onclick = () => { activate(link, sec); syncLive(); load(); };
}

// ── sections/overview.ts ────────────────────────────────────────
// The landing page: what the system is doing right now, in one screen.
//
// The Status board answered "is the bridge healthy", which is the question you ask second. The first one
// is "what is my power doing" — and it was three clicks away behind a board of green dots (#395).

function addOverviewSection(nav     , sections     ) {
  const link = navLink(nav, 'Overview', '⌂');
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Overview' }));
  sec.appendChild(el('div', {
    class: 'desc',
    text: 'What the system is doing now, what it has done today, and anything that needs attention. '
      + 'Nothing here is estimated: a figure nothing measured is shown as a dash.',
  }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  const stamp = el('span', { class: 'ld-count' });
  bar.append(refresh, stamp); sec.appendChild(bar);

  // Anything wrong goes at the top, at full size. When nothing is, it collapses to a single line.
  const alerts = el('div'); sec.appendChild(alerts);

  const now = el('div', { class: 'ov-now' }); sec.appendChild(now);
  const flowWrap = el('div', { class: 'energy-flow ov-flow' }); now.appendChild(flowWrap);
  // Not `ov-battery`: a tile for the battery kind is built as `ov-` + kind, and the two collided.
  const battWrap = el('div', { class: 'ov-batt-side' }); now.appendChild(battWrap);

  sec.appendChild(el('h3', { text: 'Today so far', class: 'ov-h3' }));
  const todayRow = el('div', { class: 'ov-tiles' }); sec.appendChild(todayRow);

  sec.appendChild(el('h3', { text: 'Last 24 hours', class: 'ov-h3' }));
  const dayRow = el('div', { class: 'ov-tiles' }); sec.appendChild(dayRow);

  const fmtW = (w               ) => w == null ? '—'
    : Math.abs(w) >= 1000 ? `${formatNum(Math.round(w / 100) / 10)} kW` : `${formatNum(Math.round(w))} W`;
  const fmtKwh = (v               ) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} kWh`;

  const idsOfKind = (nodes       , kind        ) => nodes.filter(n => n.kind === kind && !n.id.includes('#')).map(n => n.id);
  const sumOfKind = (nodes       , kind        ) => {
    const vals = nodes.filter(n => n.kind === kind && !n.id.includes('#') && typeof n.value === 'number').map(n => n.value);
    return vals.length ? vals.reduce((a        , b        ) => a + b, 0) : null;
  };

  /// A figure with its name, and the sub-line that says what it means. Clicking opens that node's day.
  const tile = (kind        , icon        , label        , value        , sub        , ids          ) => {
    const t = el('div', { class: 'ov-tile ov-' + kind });
    t.append(
      el('div', { class: 'ov-tile-head' }, el('span', { class: 'ov-icon', text: icon }), el('span', { text: label })),
      el('div', { class: 'ov-value', text: value }),
      el('div', { class: 'ov-sub', text: sub }));
    if (ids.length) {
      t.classList.add('is-link');
      t.title = `Show ${label} through the day`;
      t.onclick = () => {
        requestFocus(ids, 'today=1&step=300', label);
        (document.querySelector('nav a[data-label="Trends"]')       )?.click();
      };
    }
    return t;
  };

  /// The battery, as the thing people actually look for: how full, which way, and how fast.
  const drawBattery = (soc               , watts               , why        , volts               ) => {
    battWrap.innerHTML = '';
    const charging = watts != null && watts < -1;
    const idle = watts == null || Math.abs(watts) <= 1;
    const pct = soc == null ? null : Math.max(0, Math.min(100, soc));
    const level = pct == null ? 'unknown' : pct >= 60 ? 'good' : pct >= 25 ? 'warn' : 'bad';

    const card = el('div', { class: 'ov-batt-card' });
    card.appendChild(el('div', { class: 'ov-batt-title', text: 'Battery' }));
    // A battery drawn as a battery: the fill IS the charge, so the number is confirmation, not the message.
    const body = el('div', { class: 'ov-batt-body ov-batt-' + level });
    const shell = el('div', { class: 'ov-batt-shell' });
    const fill = el('div', { class: 'ov-batt-fill' });
    fill.style.height = (pct == null ? 0 : pct) + '%';
    shell.append(fill, el('div', { class: 'ov-batt-cap' }));
    const state = pct == null ? why : idle ? 'idle' : charging ? `charging · ${fmtW(Math.abs(watts ))}` : `discharging · ${fmtW(watts )}`;
    body.append(shell, el('div', { class: 'ov-batt-read' },
      el('div', { class: 'ov-batt-pct', text: pct == null ? '—' : pct + '%' }),
      // Volts are how you tell a healthy pack from a sagging one, and the percentage alone never says it.
      el('div', { class: 'ov-batt-volts', text: volts == null ? '' : `${formatNum(Math.round(volts * 10) / 10)} V` }),
      el('div', { class: 'ov-sub', text: state })));
    card.appendChild(body);
    battWrap.appendChild(card);
  };

  /// One problem, said plainly and at a size that cannot be scrolled past.
  const alertCard = (level        , title        , state        , detail        ) =>
    el('div', { class: 'ov-alert ' + level },
      el('span', { class: 'ov-alert-icon', text: level === 'bad' ? '⛔' : '⚠' }),
      el('div', {},
        el('div', { class: 'ov-alert-title', text: `${title} — ${state}` }),
        el('div', { class: 'desc', text: detail || '' })));

  const drawStatus = (body     ) => {
    const cards = (body && body.cards) || [];
    alerts.innerHTML = '';
    if (!cards.length) return;
    const wrong = cards.filter((c     ) => c.level === 'bad' || c.level === 'warn');
    if (!wrong.length) {
      const ok = cards.filter((c     ) => c.level === 'good').length;
      alerts.appendChild(el('div', { class: 'ov-allgood' },
        el('span', { class: 'dot good' }),
        el('span', { text: `All ${ok} component${ok === 1 ? '' : 's'} healthy` }),
        el('a', { class: 'ov-allgood-link', text: 'Status board', onclick: () => (document.querySelector('nav a[data-label="Status"]')       )?.click() })));
      return;
    }
    wrong.sort((a     , b     ) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));
    wrong.forEach((c     ) => alerts.appendChild(alertCard(c.level, c.title, c.state, c.detail)));
  };

  let lastDay      = null;

  const drawDay = () => {
    dayRow.innerHTML = '';
    const body = lastDay;
    if (!body?.ok || !(body.series || []).length) {
      dayRow.appendChild(el('div', { class: 'desc', text: 'No history for the last 24 hours yet.' }));
      return;
    }
    const steps = ((body.series || [])[0]?.values || []).length;
    /// Sum a set of series step by step. Only a step EVERY one of them reported counts: a partial sum reads
    /// as a dip that never happened.
    const sumSeries = (list       ) => !list.length ? [] : Array.from({ length: steps }, (_, i) => {
      let total = 0;
      for (const s of list) { const v = s.values[i]; if (typeof v !== 'number') return null; total += v; }
      return total                 ;
    });
    const ofKind = (kind        , returns = false) => (body.series || [])
      .filter((s     ) => s.kind === kind && String(s.node).endsWith('#in') === returns);

    /// What the house drew at each step: the same balance as the figure above, done per reading rather
    /// than once. A step missing any part of that balance is a gap — filling it with a zero would draw a
    /// house that stopped using power.
    const homeValues = () => {
      const metered = ofKind('load');
      if (metered.length) return sumSeries(metered);
      const net = (kind        ) => {
        const out = sumSeries(ofKind(kind)), back = sumSeries(ofKind(kind, true));
        if (!out.length && !back.length) return [];
        return Array.from({ length: steps }, (_, i) => {
          const o = out[i], b = back[i];
          if (o == null && b == null) return null;
          return (o ?? 0) - (b ?? 0);
        });
      };
      const solar = sumSeries(ofKind('solar')), grid = net('grid'), batt = net('battery');
      const parts = [solar, grid, batt].filter(p => p.some(v => v != null));
      if (!parts.length) return [];
      return Array.from({ length: steps }, (_, i) => {
        let total = 0;
        for (const p of parts) { const v = p[i]; if (v == null) return null; total += v; }
        return total                 ;
      });
    };

    const strip = ([kind, label, icon]                          ) => {
      const values = kind === 'home' ? homeValues() : sumSeries(ofKind(kind));
      if (!values.length || !values.some(v => v != null)) return;
      // The same shape as the tiles above: a figure, what it means, and the shape behind it. A strip on
      // its own says "something happened" without saying what.
      const known = values.filter((v)              => typeof v === 'number');
      const nowV = [...values].reverse().find((v)              => typeof v === 'number') ?? null;
      const peak = known.length ? Math.max(...known) : null;
      const box = el('div', { class: 'ov-tile ov-strip ov-' + kind });
      box.append(
        el('div', { class: 'ov-tile-head' },
          el('span', { class: 'ov-icon', text: icon }), el('span', { text: label }),
          el('span', { class: 'ov-peak', text: peak == null ? '' : `peak ${fmtW(peak)}` })),
        el('div', { class: 'ov-value', text: fmtW(nowV) }),
        sparkline({
          values, color: kind === 'home' ? 'var(--accent)' : (KIND_COLOR[kind] || 'var(--accent)'), units: body.units || 'W',
          width: 300, height: 72,
          at: (i        ) => (body.at || [])[i] ? new Date(body.at[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
        }),
        el('div', { class: 'ov-sub', text: known.length ? `${known.length} of ${values.length} readings` : 'no readings' }));
      dayRow.appendChild(box);
    };
    ([['solar', 'Solar', '☀'], ['grid', 'Grid', '⚡'], ['battery', 'Battery', '🔋'], ['home', 'Home', '⌂']]                              ).forEach(strip);
  };

  const loadDay = async () => {
    try {
      const r = await api('/api/flow/series?minutes=1440&step=900&metric=realpower');
      lastDay = r.body;
    } catch { lastDay = null; }
    drawDay();
  };

  const drawNow = (power     , energy     , live                        , liveInfo                     ) => {
    const nodes = (power?.nodes || [])         ;
    const solarIds = idsOfKind(nodes, 'solar'), gridIds = idsOfKind(nodes, 'grid'), battIds = idsOfKind(nodes, 'battery');
    const solarW = sumOfKind(nodes, 'solar');
    const gridOut = sumOfKind(nodes, 'grid');
    const gridIn = sumKnown(gridIds.map(id => live[`${id}|realpower#in`]));
    const battOut = sumOfKind(nodes, 'battery');
    const battIn = sumKnown(battIds.map(id => live[`${id}|realpower#in`]));
    // One signed figure per bidirectional node: out is positive, in is negative.
    const gridNet = gridOut == null && gridIn == null ? null : (gridOut || 0) - (gridIn || 0);
    const battNet = battOut == null && battIn == null ? null : (battOut || 0) - (battIn || 0);
    // A metered load node wins over the balance of sources; without one the home is what is left over.
    const loadW = idsOfKind(nodes, 'load').length ? sumOfKind(nodes, 'load') : undefined;
    const homeW = homeEnergy({ solar: solarW, grid: gridNet, battery: battNet, ...(loadW === undefined ? {} : { load: loadW }) });

    const arms            = [];
    if (solarIds.length) arms.push({ key: 'solar', icon: '☀', label: 'Solar', text: fmtW(solarW), color: KIND_COLOR.solar, flow: solarW, ids: solarIds });
    if (gridIds.length) arms.push({ key: 'grid', icon: '⚡', label: 'Grid', text: fmtW(gridNet == null ? null : Math.abs(gridNet)), color: KIND_COLOR.grid, flow: gridNet, ids: gridIds });
    if (battIds.length) arms.push({ key: 'battery', icon: '🔋', label: 'Battery', text: fmtW(battNet == null ? null : Math.abs(battNet)), color: KIND_COLOR.battery, flow: battNet, ids: battIds });
    arms.push({ key: 'home', icon: '⌂', label: 'Home', text: fmtW(homeW), color: 'var(--accent)', flow: homeW == null ? null : -homeW });
    drawEnergyFlow(flowWrap, arms, (a, g) => {
      g.style.cursor = 'pointer';
      g.onclick = () => {
        requestFocus(a.ids , 'today=1&step=300', a.label);
        (document.querySelector('nav a[data-label="Trends"]')       )?.click();
      };
    });

    const socVals = battIds.map(id => live[`${id}|soc`]).filter((v)              => typeof v === 'number');
    // Voltage is a condition at a point, never a sum: several packs in parallel share one bus voltage.
    const voltVals = battIds.map(id => live[`${id}|voltage`]).filter((v)              => typeof v === 'number');
    drawBattery(socVals.length ? Math.round(socVals.reduce((a, b) => a + b, 0) / socVals.length) : null,
      battNet, battIds.length ? 'no charge source bound' : 'no battery configured',
      voltVals.length ? voltVals.reduce((a, b) => a + b, 0) / voltVals.length : null);

    // --- Today ------------------------------------------------------------------------------------
    todayRow.innerHTML = '';
    const eNodes = (energy?.nodes || [])         ;
    if (!eNodes.length) {
      todayRow.appendChild(el('div', { class: 'desc', text: 'No energy totals yet — history is off, or nothing has reported today.' }));
      return;
    }
    const eSolar = sumOfKind(eNodes, 'solar');
    const eGridOut = sumOfKind(eNodes, 'grid');
    const eGridIn = sumKnown(gridIds.map(id => {
      const n = eNodes.find((x     ) => x.id === id + '#in');
      return typeof n?.value === 'number' ? n.value : undefined;
    }));
    const eBattOut = sumOfKind(eNodes, 'battery');
    const eLoad = idsOfKind(eNodes, 'load').length ? sumOfKind(eNodes, 'load') : undefined;
    const eHome = homeEnergy({
      solar: eSolar, battery: eBattOut,
      grid: eGridOut == null && eGridIn == null ? null : (eGridOut || 0) - (eGridIn || 0),
      ...(eLoad === undefined ? {} : { load: eLoad }),
    });

    if (solarIds.length) todayRow.appendChild(tile('solar', '☀', 'Solar produced', fmtKwh(eSolar), 'since the day rolled over', solarIds));
    if (gridIds.length) todayRow.appendChild(tile('grid', '⚡', 'Grid imported', fmtKwh(eGridOut), eGridIn ? `${fmtKwh(eGridIn)} exported` : 'nothing exported', gridIds));
    todayRow.appendChild(tile('home', '⌂', 'Home used', fmtKwh(eHome), eHome == null ? 'no measured sources' : 'everything the house drew', []));
    const pct = selfSufficiencyPct(eHome, eGridOut);
    todayRow.appendChild(tile('self', '◔', 'Self-sufficiency', pct == null ? '—' : `${Math.round(pct)}%`,
      pct == null ? 'needs both home use and grid import' : 'of what the house used came from you', []));
  };

  let power      = null, energy      = null;

  const load = async () => {
    stamp.textContent = 'loading…';
    try {
      const [p, e] = await Promise.all([api('/api/flow?metric=realpower'), api('/api/flow?metric=energytoday')]);
      power = p.body; energy = e.body;
      const nodes = (power?.nodes || [])         ;
      const battIds = idsOfKind(nodes, 'battery'), gridIds = idsOfKind(nodes, 'grid');
      const q = [
        ...[...battIds, ...gridIds].map(id => ({ Node: id, Metric: 'realpower#in' })),
        ...battIds.map(id => ({ Node: id, Metric: 'soc' })),
        ...battIds.map(id => ({ Node: id, Metric: 'voltage' })),
      ];
      const live                         = {}, liveInfo                      = {};
      if (q.length) {
        try {
          const lr = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
          (lr.body?.values || []).forEach((v     ) => {
            liveInfo[`${v.node}|${v.metric}`] = v;
            if (typeof v.value === 'number') live[`${v.node}|${v.metric}`] = v.value;
          });
        } catch { /* the live cache is not there; those readings stay absent */ }
      }
      drawNow(power, energy, live, liveInfo);
      stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
    } catch (err     ) {
      stamp.textContent = '';
      alerts.appendChild(alertCard('bad', 'Overview', 'could not load', err?.message || 'the request failed'));
    }
    try { drawStatus((await api('/api/status/board')).body); } catch { /* the board has its own page */ }
    await loadDay();
  };

  refresh.onclick = () => load();
  liveWhileActive(sec, () => 'flow:realpower', () => load());
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive()) load(); }, 15000);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, load };
}

// ── sections/mqtt-import.ts ─────────────────────────────────────
// MQTT Import: browse what a broker publishes and turn it into energy-flow nodes.

// The "Import device template" panel: pick a template, set an id prefix + Modbus host/unit.
function renderDiscoverPanel(flow     , rerender            )              {
  const panel = el('div', { class: 'tpl-import' });
  panel.appendChild(el('div', {
    class: 'desc',
    text: 'Readings other integrations publish to this broker — power, energy, current, voltage, frequency. '
        + 'Pick the ones to add as nodes; nothing is created until you do, and nothing is saved until you '
        + 'press Save. Add topic shapes for other publishers under MQTT → ImportProfiles.',
  }));

  const bar = el('div', { class: 'ld-toolbar' });
  // Where to look. Discovery states the unit and device class, so it is the default.
  const srcSel = el('select', { style: { width: 'auto' } })                     ;
  srcSel.appendChild(el('option', { value: 'discovery', text: 'Home Assistant discovery' }));
  // The rest come from the server: built-in profiles plus MQTT.ImportProfiles.
  api('/api/mqtt/profiles').then((r     ) => {
    ((r.body && r.body.profiles) || []).forEach((p     ) =>
      srcSel.appendChild(el('option', { value: p.id, text: p.label + ' topics' })));
  });
  const tagIn = el('input', { type: 'text', value: 'imported', placeholder: 'tag (optional)' })                    ;
  // Where the imported nodes hang, and which way round.
  const dirSel = el('select', { style: { width: 'auto' } })                     ;
  dirSel.appendChild(el('option', { value: 'load', text: 'drawn from' }));
  dirSel.appendChild(el('option', { value: 'source', text: 'feeding' }));
  const feedSel = el('select', { style: { width: 'auto' } })                     ;
  feedSel.appendChild(el('option', { value: '', text: '— not wired —' }));
  (flow.Nodes || []).forEach((n     ) =>
    feedSel.appendChild(el('option', { value: n.Id, text: n.Label || n.Id })));
  const scan = btn('Scan broker', 'primary');
  const addBtn = btn('Add selected', 'primary');
  const copyBtn = btn('Copy this profile to config');
  copyBtn.title = 'Write the selected built-in profile into MQTT.ImportProfiles, where its pattern and '
                + 'metric map can be edited.';
  bar.append(srcSel, scan,
    el('span', { class: 'desc', style: { margin: '0' }, text: 'Wire as:' }), dirSel, feedSel,
    el('span', { class: 'desc', style: { margin: '0' }, text: 'Tag as:' }), tagIn, addBtn, copyBtn);
  const note = el('div', { class: 'desc' });
  const list = el('div');
  panel.append(bar, note, list);

  // Tagged on import so the per-destination filters can exclude them.
  tagIn.title = 'Applied to every node added here. Use it in a destination’s tag filter to avoid '
              + 'exporting these readings back to where they came from.';

  const picked = new Set        ();
  // Topics already bound anywhere in the config: a reading is "already imported" when its topic is bound.
  const boundTopics = new Set        ();
  (flow.Nodes || []).forEach((n     ) =>
    (n.Sources || []).forEach((src     ) => { if (src.Topic) boundTopics.add(src.Topic); }));

  /// The node a reading belongs to: its device, not its individual measure.
  const nodeIdFor = (r     ) =>
    String(r.device || r.id || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || r.id;

  // Rows and their unit selectors, so the bulk controls can drive them without a re-render.
  let boxes                                            = [];
  let unitSels                                             = [];

  const render = (readings       ) => {
    list.innerHTML = '';
    boxes = []; unitSels = [];
    if (!readings.length) {
      note.textContent = srcSel.value === 'discovery'
        ? 'No importable entities in the broker’s Home Assistant discovery. Publishers that announce nothing '
          + 'will not appear here — try a topic profile instead.'
        : 'No topics matched this profile’s shape. Check the pattern against what the publisher actually '
          + 'sends, or add one under MQTT → ImportProfiles.';
      return;
    }
    const tbl = el('table', { class: 'ld' });
    const head = el('tr');
    ['', 'Device', 'Reading', 'Metric', 'Unit', 'Topic'].forEach(h => head.appendChild(el('th', { text: h })));
    tbl.appendChild(el('thead', {}, head));
    const body = el('tbody');
    readings.forEach(r => {
      const tr = el('tr');
      const cb = el('input', { type: 'checkbox', class: 'switch' })                    ;
      const already = boundTopics.has(r.topic);
      // Two reasons a row cannot be taken: already modelled, or not bindable from its template.
      cb.disabled = !!r.unsupported || already;
      cb.onchange = () => { cb.checked ? picked.add(r.id) : picked.delete(r.id); syncCount(); };
      if (!cb.disabled) boxes.push({ reading: r, box: cb });
      tr.appendChild(el('td', {}, cb));
      tr.appendChild(el('td', { text: r.device || '—' }));
      tr.appendChild(el('td', { text: r.label }));
      tr.appendChild(el('td', { text: r.metric }));

      // A topic-matched reading carries no unit.
      const unitCell = el('td');
      if (r.unit) {
        unitCell.appendChild(el('span', { text: r.unit }));
      } else {
        const choices           = r.units || [];
        const unitSel = el('select', { style: { width: 'auto' } })                     ;
        unitSel.appendChild(el('option', { value: '', text: '— pick —' }));
        choices.forEach(u => unitSel.appendChild(el('option', { value: u, text: u })));
        // Pre-filled with the metric's canonical unit.
        r.unit = r.unit || r.canonicalUnit || '';
        unitSel.value = r.unit || '';
        unitSel.onchange = () => { r.unit = unitSel.value || undefined; };
        unitCell.appendChild(unitSel);
        unitSels.push({ reading: r, sel: unitSel });
        if (!choices.length) unitCell.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: 'no units for this metric' }));
      }
      tr.appendChild(unitCell);

      const topic = el('td');
      topic.appendChild(el('code', { text: r.topic, style: { color: 'var(--muted)' } }));
      if (r.sample != null && r.sample !== '')
        topic.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: `last value: ${String(r.sample).slice(0, 60)}` }));
      if (r.unsupported) topic.appendChild(el('div', { class: 'nh-warn', text: `Cannot import: ${r.unsupported}.` }));
      else if (already) topic.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: 'Already bound.' }));
      tr.appendChild(topic);
      body.appendChild(tr);
    });
    tbl.appendChild(body);
    list.appendChild(bulkBar(readings));
    list.appendChild(tbl);
    // Repeated below the table.
    const footer = el('div', { class: 'ld-toolbar', style: { marginTop: '6px' } });
    const addAgain = btn('Add selected', 'primary');
    addAgain.onclick = () => addBtn.onclick ({}       );
    footer.append(addAgain, el('span', { class: 'desc', style: { margin: '0' }, text: 'Adds the ticked rows as nodes. Save writes them to the config.' }));
    list.appendChild(footer);
    syncCount();
  };

  /// Keep both Add buttons showing how many rows are ticked.
  const syncCount = () => {
    const n = picked.size;
    const label = n ? `Add ${n} selected` : 'Add selected';
    [addBtn, ...Array.from(list.querySelectorAll('button'))].forEach((b     ) => {
      if (b && /^Add \d* ?selected$/.test(b.textContent || '')) b.textContent = label;
    });
  };

  /// Select-all, and one unit setter per metric present, so twenty rows are not twenty clicks.
  const bulkBar = (readings       ) => {
    const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px', margin: '0 0 6px' } });

    const all = btn('Select all');
    all.onclick = () => {
      const turnOn = boxes.some(b => !b.box.checked);
      boxes.forEach(b => {
        b.box.checked = turnOn;
        turnOn ? picked.add(b.reading.id) : picked.delete(b.reading.id);
      });
      all.textContent = turnOn ? 'Select none' : 'Select all';
      syncCount();
    };
    row.appendChild(all);

    // One setter per metric in the results: the answer is usually the same for every row of a metric.
    const metrics = [...new Set(readings.filter(r => !r.unit || r.units?.length).map(r => r.metric))].sort();
    metrics.forEach(metric => {
      const choices           = (readings.find(r => r.metric === metric) || {}).units || [];
      if (choices.length < 2) return;   // nothing to choose between
      const sel = el('select', { style: { width: 'auto' } })                     ;
      choices.forEach(u => sel.appendChild(el('option', { value: u, text: u })));
      sel.value = (readings.find(r => r.metric === metric) || {}).canonicalUnit || choices[0];
      sel.onchange = () => {
        unitSels.filter(u => u.reading.metric === metric).forEach(u => {
          u.sel.value = sel.value;
          u.reading.unit = sel.value;
        });
      };
      row.append(el('span', { class: 'desc', style: { margin: '0' }, text: `all ${metric}:` }), sel);
    });

    return row;
  };

  copyBtn.onclick = async () => {
    const id = srcSel.value;
    if (!id || id === 'discovery' || id.startsWith('custom:')) {
      toast('Pick a built-in topic profile first.', false);
      return;
    }
    const r = await api('/api/mqtt/profile?id=' + encodeURIComponent(id));
    if (!r.body || !r.body.ok) { toast((r.body && r.body.message) || 'Could not read that profile.', false); return; }
    const p = r.body.profile;
    const mqtt = ensure(state.data, 'MQTT', {});
    const list = ensure(mqtt, 'ImportProfiles', []);
    if (list.some((x     ) => (x.Name || '').toLowerCase() === (p.label || '').toLowerCase())) {
      toast(`'${p.label}' is already in ImportProfiles.`, false);
      return;
    }
    list.push({ Name: p.label, Filter: p.filter, Pattern: p.pattern, JsonField: p.jsonField || undefined, Metrics: p.metrics });
    toast(`Copied '${p.label}' into MQTT → ImportProfiles. Edit it there, then Save.`, true);
    refreshDirty();
  };

  let found        = [];
  scan.onclick = async () => {
    const src = srcSel.value;
    note.textContent = 'Scanning the broker…';
    const r = await api(src === 'discovery'
      ? '/api/mqtt/importable'
      : '/api/mqtt/importable/pattern?profile=' + encodeURIComponent(src));
    if (!r.body || !r.body.ok) { note.textContent = (r.body && r.body.message) || 'Could not scan.'; return; }
    found = r.body.readings || [];
    note.textContent = `${found.length} reading(s) from ${r.body.scanned} retained topic(s).`;
    render(found);
  };

  addBtn.onclick = () => {
    const take = found.filter(r => picked.has(r.id) && !r.unsupported && !boundTopics.has(r.topic));
    if (!take.length) { toast('Nothing selected.', false); return; }
    const tag = tagIn.value.trim();
    const nodes = ensure(flow, 'Nodes', []);

    // One node per device, with a source per metric.
    const byDevice = new Map               ();
    take.forEach(r => {
      const key = nodeIdFor(r);
      if (!byDevice.has(key)) byDevice.set(key, []);
      byDevice.get(key) .push(r);
    });

    let added = 0, extended = 0;
    byDevice.forEach((readings, deviceId) => {
      let id = deviceId;
      const sources = readings.map(r => ({
        Type: 'mqtt', Topic: r.topic, Metric: r.metric,
        // 'lifetime': the daily figure is derived from it.
        Accumulation: r.metric === 'energy' ? 'lifetime' : undefined,
        Unit: r.unit || undefined,
        JsonField: r.jsonField || undefined,
      }));
      readings.forEach(r => boundTopics.add(r.topic));

      // A second pass over the same device adds its remaining readings to the node already there.
      const deviceTopics = new Set(found.filter((f     ) => nodeIdFor(f) === id).map((f     ) => f.topic));
      let existing = nodes.find((n     ) => n.Id === id);
      if (existing && !(existing.Sources || []).some((src     ) => deviceTopics.has(src.Topic))) {
        // Same id, different thing. Take the next free id rather than merging or overwriting.
        let free = id, i = 2;
        while (nodes.some((n     ) => n.Id === free)) free = `${id}_${i++}`;
        toast(`A node named '${id}' already exists and is something else — imported as '${free}'.`, false);
        id = free;
        existing = undefined;
      }
      if (existing) {
        ensure(existing, 'Sources', []).push(...sources);
        extended++;
        return;
      }

      const node      = {
        Id: id,
        Label: readings[0].device || id,
        // 'none': an imported node is valued by its own bindings.
        Mode: 'none',
        Sources: sources,
      };
      if (tag) node.Tags = [tag];
      nodes.push(node);
      added++;
      // One link per node, in the direction chosen.
      if (feedSel.value) {
        ensure(flow, 'Links', []).push(dirSel.value === 'source'
          ? { From: id, To: feedSel.value }
          : { From: feedSel.value, To: id });
      }
    });

    const parts = [added ? `${added} node(s)` : '', extended ? `${extended} extended` : ''].filter(Boolean);
    toast(`Added ${parts.join(', ')} from ${take.length} reading(s). Press Save to write them to the config.`, true);
    picked.clear();
    rerender();
  };

  return panel;
}

/// Its own page under Integrations -> MQTT (#342 follow-on): it reads the broker rather than the PDU.

function addMqttImportSection(nav     , sections     ) {
  const link = navLink(nav, 'MQTT Import', '⇤');
  // Adding nodes edits the shared EnergyFlow document, so this page carries its unsaved-edit count.
  link.dataset.section = 'EnergyFlow';
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'MQTT Import' }));
  sec.appendChild(el('div', {
    class: 'desc',
    text: 'Add energy-flow nodes from readings other integrations already publish to this broker — by their '
        + 'Home Assistant discovery where they announce it, or by topic shape where they do not.',
  }));

  const host = el('div');
  sec.appendChild(host);

  const render = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const nodes = ensure(flow, 'Nodes', []);
    host.innerHTML = '';
    host.appendChild(renderDiscoverPanel(flow, render));
    const bar = el('div', { class: 'ld-toolbar' });
    const save = btn('Save', 'primary');
    save.onclick = () => saveConfig(() => render());
    bar.appendChild(save);
    host.appendChild(bar);
  };

  link.onclick = () => { render(); activate(link, sec); };
  return { link, sec };
}

// ── sections/nodedata.ts ────────────────────────────────────────
// Node Data: every reading the energy flow is collecting, in one table.
//
// The chart shows one metric at a time and only what flows, so everything else the bridge ingests — a
// battery's state of charge, a temperature, an inverter's frequency — had nowhere to be seen. This lists
// each node against every metric bound to it.
//
// The column that matters is Updated. A dead publisher and a topic that was never right both show an
// empty chart, and they need completely different fixes; the API reports a reading even after it has
// expired (flagged, not hidden) precisely so the two can be told apart here.

// Mirrors FlowUnits.cs — the canonical unit each metric is stored in, and its display name.
const UNITS                                   = {
  realpower: ['Power', 'W'], apparentpower: ['Apparent power', 'VA'], energy: ['Energy', 'kWh'],
  current: ['Current', 'A'], voltage: ['Voltage', 'V'], frequency: ['Frequency', 'Hz'],
  powerfactor: ['Power factor', ''], soc: ['State of charge', '%'],
  percent: ['Percentage', '%'], temperature: ['Temperature', '°C'],
};
const metricName = (m        ) => (UNITS[m] || [m, ''])[0];
const metricUnit = (m        ) => (UNITS[m] || [m, ''])[1];

const ago = (s        ) => s < 1 ? 'just now'
  : s < 90 ? Math.round(s) + 's ago'
  : s < 5400 ? Math.round(s / 60) + 'm ago'
  : Math.round(s / 3600) + 'h ago';

function addNodeDataSection(nav     , sections     ) {
  const link = navLink(nav, 'Node Data', '⊞');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Node Data' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Every reading the energy flow is collecting — one row per node and bound metric, whatever the chart happens to be showing. “Updated” is the one to watch: a source that has stopped reporting still lists its last value, marked stale, so a dead publisher can be told apart from a binding that was never right.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const refresh = btn('Refresh');
  const filter = el('input', { type: 'text', placeholder: 'Filter (node / metric / topic)…' });
  const onlyProblems = el('input', { type: 'checkbox', class: 'switch' });
  const problemsLab = el('label', { title: 'Show only rows with no reading, or one that has gone stale.' },
    onlyProblems, ' Problems only');
  const count = el('span', { class: 'ld-count' });
  bar.append(refresh, filter, problemsLab, count);
  sec.appendChild(bar);
  const wrap = el('div'); sec.appendChild(wrap);

  // One row per (node, bound metric), from the configured hierarchy — so a binding that has never
  // delivered still appears, which is exactly the case worth seeing.
  const rows = () => {
    const out        = [];
    (state.data?.EnergyFlow?.Nodes || []).forEach((n     ) => {
      if (!n.Id) return;
      const bound = (n.Sources || []).concat((n.Mqtt || []).map((m     ) => ({ Type: 'mqtt', ...m })));
      if (!bound.length) {
        if (n.Value != null) out.push({ node: n, metric: 'realpower', src: null, fixed: n.Value });
        return;
      }
      bound.forEach((s     ) => out.push({ node: n, metric: s.Metric || 'realpower', src: s }));
    });
    return out;
  };

  const describe = (s     ) => !s ? 'fixed value'
    : s.Type === 'modbus' ? `${s.Connection || 'modbus'} · register ${s.Register}`
    : (s.Topic || '') + (s.JsonField ? ` · ${s.JsonField}` : '');

  let live                      = {};
  const keyOf = (r     ) => `${r.node.Id}|${r.metric}`;

  const draw = () => {
    const f = (filter.value || '').trim().toLowerCase();
    let list = rows();
    list = list.filter(r => !f || `${r.node.Label || ''} ${r.node.Id} ${metricName(r.metric)} ${describe(r.src)}`.toLowerCase().includes(f));
    if (onlyProblems.checked) list = list.filter(r => {
      const v = live[keyOf(r)];
      // A reading with no timestamp is not a problem — it is in use. Only nothing at all, or something stale.
      return r.fixed == null && (!v || (v.reported == null && v.value == null) || v.fresh === false);
    });

    wrap.innerHTML = '';
    if (!list.length) {
      wrap.appendChild(el('div', { class: 'desc', text: onlyProblems.checked ? 'Nothing stale or missing — every bound source is reporting.' : 'No nodes have sources bound yet. Bind one on the Nodes tab.' }));
      return;
    }

    const t = el('table', { class: 'ld' });
    const head = el('tr');
    ['Node', 'Metric', 'Value', 'Updated', 'Source'].forEach((h, i) => head.appendChild(el('th', { class: i === 2 ? 'num' : '', text: h })));
    t.appendChild(el('thead', {}, head));
    const tb = el('tbody');

    let stale = 0, missing = 0;
    list.forEach(r => {
      const v = live[keyOf(r)];
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('span', { text: r.node.Label || r.node.Id }),
        el('div', { class: 'desc', style: { fontSize: '11px', margin: '0' }, text: r.node.Id })));
      tr.appendChild(el('td', { text: metricName(r.metric) }));

      // `reported` is the reading including one that has expired, and it only exists where the ingest can
      // date its readings. `value` is the live figure the roll-up is using. Reading the first alone meant a
      // source that cannot report ages showed "—" here while the diagram beside it drew that very number.
      const shown = v ? (v.reported != null ? v.reported : v.value) : null;
      const val = el('td', { class: 'num' });
      if (r.fixed != null) val.append(el('span', { text: `${formatNum(r.fixed)} ${metricUnit(r.metric)}`.trim() }));
      else if (shown != null) val.append(el('span', { text: `${formatNum(shown)} ${metricUnit(r.metric)}`.trim() }));
      else { val.append(el('span', { style: { color: 'var(--muted)' }, text: '—' })); missing++; }
      tr.appendChild(val);

      const upd = el('td');
      if (r.fixed != null) upd.append(el('span', { class: 'desc', text: 'fixed' }));
      // A value with no timestamp is not a source that never reported — it is one whose ingest does not
      // date its readings. Calling it "never" while showing its number contradicts the row itself.
      else if (v && v.atUtc == null && shown != null)
        upd.append(el('span', { class: 'desc', title: 'This value is in use, but the source it came from does not record when it arrived, so it cannot be aged.', text: 'no timestamp' }));
      else if (!v || v.atUtc == null) upd.append(el('span', { style: { color: 'var(--muted)' }, text: 'never' }));
      else {
        const fresh = v.fresh !== false;
        if (!fresh) stale++;
        upd.append(el('span', { class: 'dot ' + (fresh ? 'good' : 'bad') }), ' ', ago(v.ageSeconds ?? 0));
        upd.title = new Date(v.atUtc).toLocaleString()
          + (v.staleAfterSeconds ? `\nExpires after ${v.staleAfterSeconds}s without an update.` : '\nNever expires.')
          + (fresh ? '' : '\nStale — this value is no longer used by the flow or the exports.');
      }
      tr.appendChild(upd);
      tr.appendChild(el('td', {}, el('span', { class: 'ov-sub', text: describe(r.src) })));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);

    count.textContent = `${list.length} reading(s)`
      + (stale ? ` · ${stale} stale` : '') + (missing ? ` · ${missing} never reported` : '');
    count.title = stale || missing
      ? 'A stale row had a value that expired; a "never" row has a binding that has not delivered once — check the topic or register.'
      : '';
  };

  const load = async () => {
    const q = rows().filter(r => !r.fixed).map(r => ({ Node: r.node.Id, Metric: r.metric }));
    if (q.length) {
      const r = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
      live = {};
      (r.body?.values || []).forEach((v     ) => { live[`${v.node}|${v.metric}`] = v; });
    }
    draw();
  };

  refresh.onclick = load;
  filter.oninput = draw;
  onlyProblems.onchange = draw;
  // Ages tick even when nothing new arrives — a row going stale is itself the event worth seeing.
  liveWhileActive(sec, () => 'flow:realpower', () => load());
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive()) load(); }, 10000);
  link.onclick = () => { activate(link, sec); load(); };
  return link;
}

// ── sections/trends.ts ──────────────────────────────────────────
// Trends: usage over time, as bars per day.
// The energy rules every view shares, so this page and the Energy Overview cannot answer differently.

// The bar chart itself — axis, gaps, signs, hover — lives in charts.ts.

function addTrendsSection(nav     , sections     ) {
  const link = navLink(nav, 'Trends', '▦');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Trends' }));
  // What this page is showing depends on what was asked for, so it is written when the answer arrives
  // rather than fixed here — it said "daily energy over time" over a chart of watts.
  const desc = el('div', { class: 'desc' });
  sec.appendChild(desc);

  const bar = el('div', { class: 'ld-toolbar' });
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());

  // Two kinds of range, and they answer different questions with different metrics.
  const RANGES                             = [
    // Not "the last 24 hours": today starts where the counters last re-based.
    ['today=1&step=300', 'today so far', 'power'],
    // The whole previous period, on the same boundary — not "the 24 hours before now".
    ['today=1&back=1&step=300', 'yesterday', 'power'],
    ['minutes=360&step=300', 'last 6 hours', 'power'],
    ['minutes=1440&step=900', 'last 24 hours', 'power'],
    ['days=7', 'last 7 days', 'energy'],
    ['days=14', 'last 14 days', 'energy'],
    ['days=30', 'last 30 days', 'energy'],
    ['days=90', 'last 90 days', 'energy'],
  ];
  const rangeSel = el('select', { title: 'How far back to chart. Within a day the charts show power; across days, the daily energy totals.' })                     ;
  RANGES.forEach(([v, t]) => rangeSel.appendChild(el('option', { value: v, text: t })));
  rangeSel.value = 'days=30';
  rangeSel.onchange = () => { periods.mark(null); if (!metricChosen) metricSel.value = impliedMetric(); load(); };
  /// Where an intra-day window actually fell, in the reader's own clock. The day rolls over on the server's
  /// configured period zone, which is not necessarily the reader's — so it is said outright rather than
  /// inferred from the axis.
  const windowNote = (at                      ) => {
    if (perDay() || !at?.length) return '';
    const from = new Date(at[0]), to = new Date(at[at.length - 1]);
    const clock = (d      ) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return ` · ${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(from)} → ${clock(to)}`;
  };
  /// A counter's readings are not a per-bar quantity; the differences between them are.
  ///
  /// Charting `energytoday` through a day draws the counter itself — a staircase climbing to the day's
  /// total, where every bar restates the whole day so far and none of them says what was used at that
  /// moment. The difference between one reading and the next is the energy in that interval, which is the
  /// quantity the chart is asking about, and those DO add up to the day.
  ///
  /// A negative difference means the counter re-based (midnight, or a meter reset). Nothing measured that
  /// interval, so it is a gap rather than a zero.
  const toDeltas = (body     ) => {
    (body.series || []).forEach((s     ) => {
      const raw = s.values                     ;
      s.values = raw.map((v, i) => {
        if (i === 0 || v == null) return null;
        const prev = raw[i - 1];
        if (prev == null) return null;
        return v - prev < 0 ? null : v - prev;
      });
    });
    body.deltas = true;
  };

  /// One bar per period, which is the server's call: it labels the bars with period keys when they are
  /// periods, and sends bare instants when they are samples on a clock.
  const perDay = () => !!body?.days;
  /// A total is only a real quantity when each bar is one period's own accumulation. Summing samples of a
  /// rate gives a number in watts that is a quantity of nothing; summing a counter's readings is worse —
  /// it adds the same energy in again at every step.
  const summable = () => (perDay() || !!body?.deltas) && !rate();
  const byNodeTitle = () => perDay()
    ? `Daily ${metricName()} by node`
    : `${metricName().charAt(0).toUpperCase()}${metricName().slice(1)} by node`;
  /// What the page is showing, in the same words as the chart above it.
  const describe = () => {
    const from = 'read from the history backend.';
    if (perDay()) {
      desc.textContent = `Daily ${metricName()} totals over time, ${from} A day the backend has no reading `
        + 'for is left empty rather than drawn as zero, and is left out of every total — nothing recorded '
        + 'is not the same as nothing used.';
      return;
    }
    const mins = body?.stepSeconds ? Math.round(body.stepSeconds / 60) : 0;
    const every = mins ? `every ${mins} minutes` : 'sampled';
    const name = `${metricName().charAt(0).toUpperCase()}${metricName().slice(1)}`;
    if (body?.deltas) {
      desc.textContent = `${name} per ${mins || 5} minutes through the window, ${from} Each bar is what `
        + 'changed between two readings of the day’s counter, so the bars add up to the day rather than '
        + 'each restating it. An interval either reading is missing from is left empty.';
      return;
    }
    desc.textContent = `${name} ${every} through the window, ${from} A sample the backend has no reading `
      + 'for is left empty rather than drawn as zero.'
      + (rate() ? ' These are instantaneous readings, so they are not added up.' : '');
  };
  /// A window that is still filling. "Yesterday" is not one, and neither is any range that ended.
  const running = () => !rangeSel.value.includes('back=');
  /// How wide an intra-day chart may be. A day of five-minute samples is 288 bars: at the daily rule of
  /// 26px each that is a 7,488px chart in a ~1,600px pane, so the reader sees a fifth of their day, opened
  /// at the far end, with two axis labels on it. A day belongs on screen whole.
  const fitTo = () => charts.clientWidth || 1200;
  /// The chart everything else on the page is read against gets the room a tall window offers it; the ones
  /// stacked below keep their own size so they all stay on screen together.
  const leadHeight = () => Math.max(240, Math.min(Math.round((window.innerHeight || 900) * 0.34), 420));

  // What to chart. The range no longer decides it silently: the range's own default is filled in, and from
  // then on this is the answer.

  const LABELS                         = {
    realpower: 'power', apparentpower: 'apparent power', current: 'current', voltage: 'voltage',
    frequency: 'frequency', energy: 'energy', energytoday: 'energy',
  };
  const RATES = ['W', 'VA', 'A', 'V', 'Hz'];
  // Seeded with the two every build exports, so a page that cannot reach /api/flow/metrics still offers
  // the right default for each range instead of labelling a chart of energy "power".
  let METRICS           = [{ metric: 'realpower', units: 'W', epoch: 'instant' }, { metric: 'energytoday', units: 'kWh', epoch: 'period' }];
  const metricSel = el('select', { title: 'Which measurement to chart. What the history backend was given is what it can be asked for.' })                     ;
  let metricChosen = false;
  const unitsOf = (m        ) => (METRICS.find(x => x.metric === m) || { units: '' }).units;
  const epochOf = (m        ) => (METRICS.find(x => x.metric === m) || {}).epoch || '';
  /// A rate is a condition sampled at an instant — it is never added up. A quantity accumulated over a
  /// period is. Which one this is follows the metric, not the range.
  const rate = () => RATES.includes(unitsOf(metricSel.value));
  const metricName = () => LABELS[metricSel.value] || metricSel.value;
  /// The metric a range implies when nobody has said otherwise.
  const impliedMetric = () => {
    const wants = (RANGES.find(r => r[0] === rangeSel.value) || [])[2];
    const list = chartable();
    const found = list.find(m => wants === 'power' ? RATES.includes(m.units) : !RATES.includes(m.units));
    return (found || list[0]).metric;
  };
  /// What can honestly be drawn as a bar per point. A lifetime counter cannot: each bar would be everything
  /// the meter has ever seen, so the chart is a staircase and the day's own figure is nowhere on it.
  const chartable = () => METRICS.filter(m => m.epoch !== 'lifetime');
  const fillMetrics = () => {
    metricSel.innerHTML = '';
    chartable().forEach(m => metricSel.appendChild(el('option', { value: m.metric, text: `${LABELS[m.metric] || m.metric} (${m.units})` })));
    if (!metricChosen) metricSel.value = impliedMetric();
  };
  fillMetrics();
  metricSel.onchange = () => { metricChosen = true; load(); };

  const modeSel = el('select', { title: 'Stack the day’s nodes into one bar, or draw them side by side.' })                     ;
  [['stack', 'stacked'], ['group', 'side by side']].forEach(([v, t]) => modeSel.appendChild(el('option', { value: v, text: t })));
  modeSel.onchange = () => draw();

  // One click for the periods people actually ask for, and a period is a question about energy.
  const periods = periodRow((key           ) => {
    const { days } = periodWindow(key);
    // A day is charted through its own clock; several are charted a bar each.
    const range = key === 'today' ? 'today=1&step=300'
      : key === 'yesterday' ? 'today=1&back=1&step=300'
      : days < 2 ? 'today=1&step=300' : `days=${days}`;
    if (!Array.from(rangeSel.children).some((o     ) => o.value === range))
      rangeSel.appendChild(el('option', { value: range, text: `${key === 'week' ? 'this week' : key === 'month' ? 'this month' : 'this year'} (${days} days)` }));
    rangeSel.value = range;
    const energy = chartable().find(m => !RATES.includes(m.units));
    if (energy) { metricSel.value = energy.metric; metricChosen = true; }
    periods.mark(key);
    load();
  });
  sec.appendChild(periods.row);

  const status = el('span', { class: 'ld-count' });
  bar.append(refresh, el('label', { class: 'ld-inst' }, 'Show ', rangeSel),
    el('label', { class: 'ld-inst' }, 'of ', metricSel), el('label', { class: 'ld-inst' }, 'as ', modeSel),
    instSel.wrap, status);
  sec.appendChild(bar);

  const tagRow = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  sec.appendChild(tagRow);
  const picker = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  sec.appendChild(picker);

  const charts = el('div'); sec.appendChild(charts);
  const table = el('div'); sec.appendChild(table);

  let body      = null;
  const off = new Set        ();
  // Which column the table is ordered by.
  const sort = { col: 1, desc: true };

  const load = async () => {
    status.textContent = 'loading…';
    charts.innerHTML = ''; table.innerHTML = ''; picker.innerHTML = ''; tagRow.innerHTML = '';
    const path = withInstance('/api/flow/series?' + rangeSel.value + '&metric=' + encodeURIComponent(metricSel.value), instSel);
    let r     ;
    try { r = await api(path); }
    catch (e     ) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    body = r.body;
    // A period counter read at intervals within its own period is charted as what changed between reads.
    if (body?.ok && !body.days && epochOf(metricSel.value) === 'period') toDeltas(body);
    if (!body || !body.ok) {
      status.textContent = '';
      charts.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: (body && body.message) || 'Could not load the series.' }));
      return;
    }
    // Arrived from another page asking for something specific — "show me Solar for today".
    if (pending) {
      off.clear();
      const wanted = new Set(pending.nodes);
      (body.series || []).forEach((x     ) => { if (!wanted.has(x.node)) off.add(x.node); });
      // If none of what was asked for is in this window, say so rather than silently charting nothing.
      if (off.size === (body.series || []).length) {
        off.clear();
        resetSelection();
        status.textContent = `no history for ${pending.label || 'that node'} in this range`;
      }
      pending = null;
    }
    else if (!off.size) resetSelection();
    draw();
  };

  /// A request from another page, applied on the next load.
  let pending                                                                         = null;

  /// Open this page focused on a set of nodes, over a range. Called when someone clicks a tile elsewhere.
  const openFocused = () => {
    const want = takeFocus();
    if (!want) return false;
    pending = want;
    if (want.range && RANGES.some(r => r[0] === want.range)) rangeSel.value = want.range;
    load();
    return true;
  };

  const shown = () => (body?.series || []).filter((s     ) => !off.has(s.node));

  /// The selection the page opens with: the leaves the Energy board treats as the whole picture.
  const resetSelection = () => {
    off.clear();
    const kinds = new Set((body?.series || []).map((s     ) => s.kind));
    const preferred = ['solar', 'battery', 'grid', 'load'].filter(k => kinds.has(k));
    if (preferred.length >= 2) (body?.series || []).forEach((s     ) => { if (!preferred.includes(s.kind)) off.add(s.node); });
  };

  const drawTags = () => {
    tagRow.innerHTML = '';
    const tags = new Set        ();
    (body?.series || []).forEach((s     ) => (s.tags || []).forEach((t        ) => tags.add(t)));
    if (!tags.size) return;
    tagRow.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Tags:' }));
    [...tags].sort().forEach(tag => {
      const members = (body.series || []).filter((s     ) => (s.tags || []).includes(tag));
      const allOn = members.every((s     ) => !off.has(s.node));
      const chip = btn((allOn ? '● ' : '○ ') + tag);
      chip.title = `${members.length} node(s) tagged "${tag}" — click to chart exactly these`;
      chip.onclick = () => {
        // Selecting a tag charts that tag and nothing else.
        off.clear();
        (body.series || []).forEach((s     ) => { if (!(s.tags || []).includes(tag)) off.add(s.node); });
        draw();
      };
      tagRow.appendChild(chip);
    });
  };

  const drawPicker = () => {
    picker.innerHTML = '';
    picker.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Nodes:' }));
    (body?.series || []).forEach((s     , i        ) => {
      const on = !off.has(s.node);
      const chip = btn((on ? '● ' : '○ ') + (s.label || s.node));
      chip.title = (on ? 'On the chart — click to take it off' : 'Off the chart — click to add it')
        + ((s.tags || []).length ? `\ntags: ${(s.tags || []).join(', ')}` : '');
      if (on) chip.style.borderColor = colorFor(s.kind, i);
      chip.onclick = () => { if (on) off.add(s.node); else off.delete(s.node); draw(); };
      picker.appendChild(chip);
    });
    const all = btn('All');
    all.title = 'Chart every node. A hierarchy counts the same energy at several tiers, so read a stack of all of them with that in mind.';
    all.onclick = () => { off.clear(); draw(); };
    const none = btn('None');
    none.title = 'Take every node off the by-node chart. The system charts below are unaffected.';
    none.onclick = () => { (body?.series || []).forEach((s     ) => off.add(s.node)); draw(); };
    const reset = btn('Reset', 'primary');
    reset.title = 'Back to the default selection: solar, battery, grid and the loads.';
    reset.onclick = () => { resetSelection(); draw(); };
    picker.append(all, none, reset);
  };

  /// The return lanes: battery charge, grid export. Negative, because that is the direction they are.
  const isReturn = (s     ) => String(s.node || '').endsWith('#in');
  const signed = (s     )                    =>
    isReturn(s) ? s.values.map((v     ) => (v == null ? null : -Math.abs(v))) : s.values;

  /// Sum one kind across the window, day by day. Null where no node of that kind reported that day —
  const byKind = (kind        )                           => {
    const members = (body.series || []).filter((s     ) => s.kind === kind);
    if (!members.length) return null;
    return (body.days || []).map((_        , d        ) => sumKnown(members.map((s     ) => signed(s)[d])));
  };

  const section = (title        , note        , made                            , legend        ) => {
    const box = el('div', { style: { margin: '18px 0 4px' } });
    box.appendChild(el('h3', { text: title, style: { margin: '4px 0', fontSize: '15px' } }));
    if (note) box.appendChild(el('div', { class: 'desc', text: note }));
    const scroll = el('div', { style: { overflowX: 'auto', paddingBottom: '4px' } });
    scroll.appendChild(made.svg);
    box.appendChild(scroll);
    if (legend.length > 1 || legend.length === 1) {
      const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '10px' } });
      legend.forEach(l => row.appendChild(el('span', { class: 'desc', style: { margin: '0' } },
        el('span', { class: 'trend-swatch', style: { background: l.color } }), l.label)));
      box.appendChild(row);
    }
    charts.appendChild(box);
    // A chart wider than the page opens on its oldest bars, and for a window still filling the newest are
    // what the page is about — so start at the right-hand end (#378). A window that has already ended has no
    // "newest", and opening yesterday at 11pm hides the day. scrollWidth is only known once in the document.
    if (running()) scroll.scrollLeft = scroll.scrollWidth;
    return made.gaps;
  };

  const draw = () => {
    drawTags(); drawPicker();
    charts.innerHTML = ''; table.innerHTML = '';
    hideCard();
    describe();
    if (!body?.ok) return;

    // A day carries the server's period key; a moment within one is named here, in the viewer's clock.
    const days           = body.days
      || (body.at || []).map((iso        ) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const series = shown();
    const units = body.units || 'kWh';
    // The last period has not ended.
    const partial                = body.partial || null;

    // --- Per node, as chosen ---------------------------------------------------------------------
    let gaps = 0;
    if (series.length) {
      const lines         = series.map((s     , i        ) => ({
        label: s.label || s.node, color: colorFor(s.kind, i), values: signed(s),
      }));
      gaps = section(byNodeTitle(),
        'The nodes selected above.' + (partial ? ' The faded bar is today, still in progress — it counts in the totals below, so far.' : ''),
        barChart({ days, lines, units, stacked: modeSel.value === 'stack', partial, fitTo: fitTo(), height: leadHeight() }), lines);
    } else {
      const box = el('div', { style: { margin: '18px 0 4px' } });
      box.appendChild(el('h3', { text: byNodeTitle(), style: { margin: '4px 0', fontSize: '15px' } }));
      box.appendChild(el('div', { class: 'desc', text: 'No nodes selected — pick one above, or press Reset. The charts below are about the whole system and are not affected by the selection.' }));
      charts.appendChild(box);
    }

    // --- Grid ------------------------------------------------------------------------------------
    const gridSupply = (body.series || []).filter((s     ) => s.kind === 'grid' && !isReturn(s));
    const gridReturn = (body.series || []).filter((s     ) => s.kind === 'grid' && isReturn(s));
    const sumOf = (list       ) => days.map((_, d) => sumKnown(list.map((s     ) => signed(s)[d])));
    const gridIn = byKind('grid');
    if (gridSupply.length) {
      const imports = sumOf(gridSupply), exports_ = gridReturn.length ? sumOf(gridReturn) : null;
      const gridLines         = [{ label: 'Import', color: KIND_COLOR.grid, values: imports }];
      if (exports_) gridLines.push({ label: 'Export', color: '#6fb0e0', values: exports_ });
      section(perDay() ? 'Grid per day' : 'Grid',
        'Every grid node, whatever is selected above. Import above the line, export below it'
        + (exports_ ? '.' : ' — no export series is in history for this window, so only import is charted.'),
        barChart({ days, lines: gridLines, units, stacked: true, partial, fitTo: fitTo() }), gridLines);
    }

    // --- Self-sufficiency ---------------------------------------------------------------------------
    const solar = byKind('solar'), batt = byKind('battery'), load = byKind('load');
    // Self-sufficiency is a share of energy over a period.
    if (summable() && gridIn && (load || solar)) {
      // A kind this system does not have is left out of the balance entirely.
      const drawn = sumOf(gridSupply);
      const pct = days.map((_, d) => selfSufficiencyPct(homeEnergy({
        ...(solar ? { solar: solar[d] } : {}),
        ...(batt ? { battery: batt[d] } : {}),
        ...(gridIn ? { grid: gridIn[d] } : {}),
        ...(load ? { load: load[d] } : {}),
      }), drawn[d]));
      if (pct.some(v => v != null)) {
        const ssLines         = [{ label: 'Self-sufficiency', color: KIND_COLOR.solar, values: pct }];
        section('Self-sufficiency per day',
          'Every node, whatever is selected above — a share of a subset would not be self-sufficiency. '
          + 'The share of the home’s energy that did not come from the grid'
          + (load ? '.' : ', with the home taken as the balance of the measured sources.')
          + ' A day missing either figure is left empty rather than estimated.',
          barChart({ days, lines: ssLines, units: '%', stacked: false, max: 100, pct: true, partial, fitTo: fitTo() }), ssLines);
      }
    }

    // --- Where the day's energy came from -------------------------------------------------------
    const supplyLines         = [];
    ([['solar', 'Solar'], ['battery', 'Battery out'], ['grid', 'Grid import']]                      )
      .forEach(([k, label]) => {
        const v = sumOf((body.series || []).filter((s     ) => s.kind === k && !isReturn(s)));
        if (v.some(x => x != null)) supplyLines.push({ label, color: KIND_COLOR[k], values: v });
      });
    ([['battery', 'Battery in', '#2f8f52'], ['grid', 'Grid export', '#6fb0e0']]                              )
      .forEach(([k, label, colour]) => {
        const list = (body.series || []).filter((s     ) => s.kind === k && isReturn(s));
        if (!list.length) return;
        const v = sumOf(list);
        if (v.some(x => x != null)) supplyLines.push({ label, color: colour, values: v });
      });
    if (supplyLines.length > 1) {
      section(perDay() ? `Where the day’s ${metricName()} came from` : `Where the ${metricName()} is coming from`,
        'Each kind summed across its nodes, whatever is selected above. What went back — battery charge, '
        + 'grid export — is below the line, so the same energy is not counted as produced and then again '
        + 'as returned.',
        barChart({ days, lines: supplyLines, units, stacked: true, partial, fitTo: fitTo() }), supplyLines);
    }

    // --- Totals ----------------------------------------------------------------------------------
    if (!series.length) {
      status.textContent = `${days.length} ${perDay() ? 'day(s)' : 'sample(s)'} from ${body.source}`;
      return;
    }

    const step = Number(body.stepSeconds) || 0;
    const rows = series.map((s     ) => {
      // The day in progress counts. It is a real reading of a real day — an early one, said so in the note,
      // the fade and the hover — and leaving it out made the page disagree with the Energy board about today.
      const vals = s.values
        .map((v     , d        ) => [v, days[d]]                           )
        .filter(([v]     ) => v != null);
      const sum = vals.reduce((a        , [v]     ) => a + v, 0);
      const best = vals.reduce((a     , b     ) => (b[0] > (a?.[0] ?? -Infinity) ? b : a), null       );
      // Energy from power samples: each sample stands for one step of time.
      const kwh = rate() && units === 'W' && step > 0 ? (sum * step) / 3_600_000 : null;
      return {
        label: s.label || s.node,
        headline: summable() ? sum : (best ? best[0] : null),
        kwh,
        mean: vals.length ? sum / vals.length : null,
        covered: vals.length,
        peakAt: best ? best[1] : '',
        peakValue: best ? best[0] : null,
      };
    });

    const denom = days.length;
    const cols                                                                                                    = [
      { head: 'Node', num: false, text: r => r.label, sort: r => r.label.toLowerCase() },
      { head: summable() ? `Total (${units})` : `Peak (${units})`, num: true,
        text: r => r.headline == null ? '—' : formatNum(Number(r.headline.toFixed(2))),
        sort: r => r.headline ?? -Infinity,
        // Adding up power samples gives a number in watts that is a quantity of nothing.
        title: !summable() ? 'The highest reading in the window. These bars are not added up: a sum of them would be a quantity of nothing.'
          : 'Summed over the days that reported' + (partial ? `, including ${partial} as far as it has got.` : '.') },
      ...(rate() && units === 'W' ? [{ head: 'Energy (kWh, est.)', num: true,
        text: (r     ) => r.kwh == null ? '—' : formatNum(Number(r.kwh.toFixed(3))),
        sort: (r     ) => r.kwh ?? -Infinity,
        title: `Each sample held for its ${step}s step and added up. An estimate: it assumes the power between samples was the sampled value, and it covers only the samples that exist.` }] : []),
      { head: `Mean per ${perDay() ? 'day' : 'sample'} (${units})`, num: true,
        text: r => r.mean == null ? '—' : formatNum(Number(r.mean.toFixed(2))), sort: r => r.mean ?? -Infinity,
        // An early day counts as a whole one here, so say so rather than let a low mean look like a quiet week.
        title: !perDay() || !partial ? undefined
          : `Over the days that reported. ${partial} is one of them and is only part-way through, so the mean reads low until it ends.` },
      { head: `${perDay() ? 'Days' : 'Samples'} with data`, num: true,
        text: r => `${r.covered} of ${denom}`, sort: r => r.covered },
      { head: perDay() ? 'Peak day' : 'Peak at', num: false,
        // The day in progress can hold the peak, and it is a peak that may still rise — say which it is.
        text: r => r.peakAt ? `${r.peakAt} · ${formatNum(r.peakValue)}${r.peakAt === partial ? ' · so far' : ''}` : '—',
        sort: r => r.peakAt },
    ];

    // Sorted by whichever column you clicked.
    if (sort.col >= cols.length) sort.col = 0;
    const key = cols[sort.col].sort;
    rows.sort((a     , b     ) => {
      const x = key(a), y = key(b);
      const c = typeof x === 'string' ? String(x).localeCompare(String(y)) : (x < y ? -1 : x > y ? 1 : 0);
      return sort.desc ? -c : c;
    });

    const t = el('table', { class: 'ld' });
    const head = el('tr');
    cols.forEach((c, i) => {
      const th = el('th', { class: c.num ? 'num sortable' : 'sortable' });
      th.append(c.head + (sort.col === i ? (sort.desc ? ' ▾' : ' ▴') : ''));
      th.title = (c.title ? c.title + '\n' : '') + 'Click to sort by this column.';
      th.onclick = () => { if (sort.col === i) sort.desc = !sort.desc; else { sort.col = i; sort.desc = c.num; } draw(); };
      head.appendChild(th);
    });
    t.appendChild(el('thead', {}, head));
    const tb = el('tbody');
    rows.forEach((r     ) => {
      const tr = el('tr');
      cols.forEach(c => tr.appendChild(el('td', { class: c.num ? 'num' : '', text: c.text(r) })));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    table.appendChild(t);

    status.textContent = `${days.length} ${perDay() ? 'day(s)' : 'sample(s)'} from ${body.source}`
      + windowNote(body.at)
      + (gaps ? ` · ${gaps} with no reading` : '')
      + (partial ? ` · ${partial} still in progress` : '');
    status.title = gaps
      ? 'Those days are drawn as empty slots and left out of the totals. The backend holds nothing for them.'
      : '';
  };

  refresh.onclick = () => load();
  /// The exported metrics, asked for once. Until they arrive the page offers power, which every build has.
  let metricsAsked = false;
  const loadMetrics = async () => {
    if (metricsAsked) return;
    metricsAsked = true;
    try {
      const r      = await api('/api/flow/metrics');
      if (r?.body?.ok && r.body.metrics?.length) { METRICS = r.body.metrics; fillMetrics(); }
    } catch { /* the page still works with power alone */ }
  };

  link.onclick = () => { activate(link, sec); loadMetrics(); if (!openFocused() && !body) load(); };
  // Landing here from another page's click: the request is collected when this section becomes visible.
  window.addEventListener('rpdu:activate', () => { if (sec.classList.contains('active')) openFocused(); });
  return { link, sec };
}

// ── sections/export.ts ──────────────────────────────────────────
// A synthetic section that exports the current form state as config.yaml or an RpduConfig manifest — and
// takes one back (#214), merged into what's on screen or replacing it whole.

function addExportSection(nav     , sections     ) {
  const link = navLink(nav, "Export", "⇵");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Export'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Render the current (possibly unsaved) config for copy/paste into a ConfigMap, an RpduConfig custom resource, or source control.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'sec-actions';
  const fmt = document.createElement('select');
  [['yaml', 'config.yaml'], ['manifest', 'RpduConfig (Kubernetes)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; fmt.appendChild(o); });
  const copy = btn('Copy');
  const refresh = btn('Refresh');
  bar.appendChild(fmt); bar.appendChild(copy); bar.appendChild(refresh); sec.appendChild(bar);

  const ta = document.createElement('textarea'); ta.className = 'yaml'; ta.readOnly = true; ta.spellcheck = false; sec.appendChild(ta);

  const fill = async () => {
    const endpoint = fmt.value === 'manifest' ? '/api/config/manifest' : '/api/config/yaml';
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) });
    ta.value = r.ok ? await r.text() : 'Unable to render.';
  };
  copy.onclick = async () => { ta.select(); const ok = await copyText(ta.value); toast(ok ? 'Copied to clipboard.' : 'Could not copy — your browser blocked it (the text is selected, so Ctrl+C works).', ok); };
  refresh.onclick = fill;
  fmt.onchange = fill;

  sec.appendChild(buildImport());

  link.onclick = () => { activate(link, sec); fill(); };
}

// The other direction: paste a config (or a section of one) from somewhere else and apply it here.
function buildImport() {
  const wrap = el('div', { style: { marginTop: '22px' } });
  wrap.appendChild(el('h3', { text: 'Import', style: { margin: '4px 0', fontSize: '15px' } }));
  wrap.appendChild(el('div', {
    class: 'desc',
    text: 'Paste a config.yaml or an RpduConfig manifest — a whole one, or just the sections you want. Nothing is saved: the result is loaded into the form for you to review, and you press Save as usual.',
  }));

  const bar = el('div', { class: 'sec-actions' });
  const mode = el('select')                     ;
  [
    ['merge', 'Merge — apply only what the paste mentions'],
    ['replace', 'Replace — the paste becomes the whole config'],
  ].forEach(([v, t]) => mode.appendChild(el('option', { value: v, text: t })));
  const apply = btn('Import', 'primary');
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(mode, apply, status);
  wrap.appendChild(bar);

  const input = el('textarea', { class: 'yaml', spellcheck: false, placeholder: 'Paste config.yaml or an RpduConfig manifest here…' })                       ;
  wrap.appendChild(input);

  // Replace throws away everything the paste doesn't mention, which is worth saying before it happens.
  const note = el('div', { class: 'desc' });
  const describe = () => {
    note.textContent = mode.value === 'replace'
      ? 'Replace: any section the paste doesn’t mention goes back to its default — including PDUs, overrides and nodes you have here but not there.'
      : 'Merge: only the keys present in the paste are applied; everything else keeps its current value. A list (nodes, links, labels) is applied whole rather than half-merged.';
  };
  mode.onchange = describe;
  describe();
  wrap.appendChild(note);

  apply.onclick = async () => {
    const yaml = input.value.trim();
    if (!yaml) { toast('Paste a configuration first.', false); return; }

    status.textContent = 'importing…';
    const r = await api('/api/config/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Yaml: yaml, Mode: mode.value, Current: JSON.stringify(exportData()) }),
    });

    if (!r.body?.ok) {
      status.textContent = '';
      toast(r.body?.message || 'Import failed.', false);
      return;
    }

    // Load it into the form; the user reviews and saves like any other edit.
    state.data = r.body.config;
    build();
    const sections = (r.body.sections || []).join(', ');
    (r.body.notes || []).forEach((n        ) => toast(n, true));
    status.textContent = `applied ${sections || 'nothing'}`;
    toast(`Imported ${sections}. Review the tabs, then Save.`, true);
  };

  return wrap;
}

// ── sections/ha-energy.ts ───────────────────────────────────────
// Home Assistant Energy Mapping (#128): the EnergyDashboard settings + manual sync/clear actions.

function addHaEnergySection(nav     , sections     ) {
  const link = navLink(nav, "HA Energy Mapping", "▮");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Home Assistant Energy Mapping'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Map the energy-flow hierarchy into Home Assistant’s Energy Dashboard (individual devices + their upstream device). Each tier is published to HA as an Energy sensor by the flow export, so enable “Export tiers to MQTT” (Energy Flow → Settings) and HA discovery for the full Grid → Panel → Circuit → PDU → outlet chain to appear. Settings persist with the main Save button; the buttons act immediately using the values below.';
  sec.appendChild(d);

  const ha = ensure(ensure(state.data, 'HomeAssistant', {}), 'EnergyDashboard', {});

  const field = (label        , key        , type = 'text', placeholder = '') => {
    const f = el('div', { class: 'field' });
    f.appendChild(el('label', { text: label }));
    const inp      = el('input', { type, placeholder });
    if (ha[key] != null) inp.value = ha[key];
    inp.onchange = () => { ha[key] = inp.value === '' ? null : inp.value; };
    f.appendChild(inp);
    return { f, inp };
  };
  const url = field('Home Assistant URL', 'Url', 'text', 'http://homeassistant.local:8123');
  const token = field('Long-lived access token', 'Token', 'password', '');
  const etype = field('Energy measurement type', 'EnergyMeasurementType', 'text', 'energy');

  const chkF = el('div', { class: 'field' });
  const chk      = el('input', { type: 'checkbox' }); chk.checked = !!ha.Enabled;
  chk.onchange = () => { ha.Enabled = chk.checked; };
  chkF.appendChild(el('label', { style: { fontWeight: '600' } }, chk, ' Enable periodic sync'));
  chkF.appendChild(el('div', { class: 'desc', text: 'Re-push the hierarchy automatically every few polls while enabled.' }));

  const grid = el('div', { class: 'grid' });
  grid.append(url.f, token.f, etype.f, chkF);
  sec.appendChild(grid);

  const bar = el('div', { class: 'sec-actions' });
  const syncBtn = btn('Sync now', 'primary');
  const clearBtn = btn('Clear energy dashboard', 'danger');
  bar.append(syncBtn, clearBtn); sec.appendChild(bar);
  sec.appendChild(el('div', { class: 'desc', text: 'Also Save (main button) so the periodic sync uses these settings.' }));

  syncBtn.onclick = async () => {
    toast('Syncing to Home Assistant…', true);
    const r = await api('/api/ha-energy/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.inp.value.trim(), token: token.inp.value, energyMeasurementType: etype.inp.value.trim() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
  };
  clearBtn.onclick = async () => {
    if (!confirm('Clear ALL devices from Home Assistant’s Energy Dashboard?\n\nThis removes every entry in the dashboard’s device list — including any you added manually. You can re-add the hierarchy with “Sync now”.')) return;
    toast('Clearing the Energy Dashboard…', true);
    const r = await api('/api/ha-energy/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.inp.value.trim(), token: token.inp.value }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
  };
  link.onclick = () => activate(link, sec);
}

// ── sections/ha-cleanup.ts ──────────────────────────────────────
// The two Home Assistant cleanups that "Clear discovery" cannot do, rendered on the Home Assistant page
// beside the discovery buttons they belong with.
//
// Both list what they found — names and identifiers — before anything happens. A bare confirm() with a count
// is not enough here: deleting registry entries out of someone's Home Assistant is not undoable from this
// side, and the identifiers are what let you recognise a device from an older naming scheme as genuinely
// dead rather than merely unfamiliar.

function addDiscoveryCleanup(sec     ) {
  // ---- Retained configs for tiers this build would no longer publish ----
  sec.appendChild(el('h3', { text: 'Orphaned discovery configs', style: { margin: '20px 0 4px' } }));
  sec.appendChild(el('div', { class: 'desc' },
    'Discovery messages are retained, so a config outlives what it described — an outlet that gained its own '
    + 'native energy sensor, a renamed node, a deleted tier. This finds configs published under this project’s '
    + 'own prefix that the current setup would no longer publish, and retracts them. Live devices are left '
    + 'alone, and nothing belonging to another integration is ever listed or touched.'));

  const orphanOut = el('div', { class: 'desc' })               ;
  const orphanFind = btn('Find orphaned configs');
  const orphanClear = btn('Clear them', 'danger');
  orphanClear.disabled = true;
  sec.appendChild(el('div', { class: 'sec-actions' }, orphanFind, orphanClear));
  sec.appendChild(orphanOut);

  const showOrphans = (topics          ) => {
    orphanOut.innerHTML = '';
    orphanClear.disabled = !topics.length;
    if (!topics.length) { orphanOut.textContent = 'Nothing orphaned — every retained discovery config still matches something that exists.'; return; }
    orphanOut.appendChild(el('div', { text: `${topics.length} orphaned config(s) would be cleared:` }));
    const list = el('ul', { style: { margin: '4px 0 0 18px' } });
    topics.forEach(t => list.appendChild(el('li', { text: t, style: { fontFamily: 'var(--mono)', fontSize: '11px' } })));
    orphanOut.appendChild(list);
  };

  orphanFind.onclick = async () => {
    orphanOut.textContent = 'Looking…';
    const r = await api('/api/ha/orphans');
    if (!r.body?.ok) { orphanOut.textContent = 'Could not check: ' + (r.body?.message || 'unknown error'); return; }
    showOrphans(r.body.topics || []);
  };
  orphanClear.onclick = async () => {
    orphanClear.disabled = true;
    const r = await api('/api/ha/orphans/clear', { method: 'POST' });
    if (!r.body?.ok) { toast('Could not clear: ' + (r.body?.message || 'unknown error'), false); return; }
    toast(`Cleared ${r.body.cleared} orphaned config(s).`, true);
    showOrphans([]);
  };

  // ---- Devices Home Assistant still lists whose config is already gone ----
  sec.appendChild(el('h3', { text: 'Stale Home Assistant device registrations', style: { margin: '20px 0 4px' } }));
  sec.appendChild(el('div', { class: 'desc' },
    'Home Assistant keeps a device even after its discovery message is gone, so devices from earlier versions '
    + '— an outlet named under an older scheme, a tier since removed — linger in the UI with no way to clear '
    + 'them over MQTT: there is no config left to retract. This lists ones belonging to this project that have '
    + 'no entities left at all, and deletes them through Home Assistant’s own API. A device that still has '
    + 'entities is live and is never listed; nothing from another integration is either.'));

  const devOut = el('div', { class: 'desc' })               ;
  const devFind = btn('Find stale devices');
  const devDelete = btn('Delete them', 'danger');
  devDelete.disabled = true;
  sec.appendChild(el('div', { class: 'sec-actions' }, devFind, devDelete));
  sec.appendChild(devOut);

  let lastDevices        = [];
  const showDevices = (devices       ) => {
    lastDevices = devices;
    devOut.innerHTML = '';
    devDelete.disabled = !devices.length;
    if (!devices.length) { devOut.textContent = 'Nothing stale — every device of ours in Home Assistant still has entities.'; return; }
    devOut.appendChild(el('div', { text: `${devices.length} stale device(s) would be deleted from Home Assistant:` }));
    const list = el('ul', { style: { margin: '4px 0 0 18px' } });
    devices.forEach((d     ) => list.appendChild(el('li', {},
      el('span', { text: d.name || '(unnamed)' }),
      el('span', { style: { color: 'var(--faint)', fontFamily: 'var(--mono)', fontSize: '11px' }, text: '  ' + (d.identifiers || []).join(', ') }))));
    devOut.appendChild(list);
  };

  devFind.onclick = async () => {
    devOut.textContent = 'Asking Home Assistant…';
    const r = await api('/api/ha/devices/stale');
    if (!r.body?.ok) { devOut.textContent = 'Could not check: ' + (r.body?.message || 'unknown error'); return; }
    showDevices(r.body.devices || []);
  };
  devDelete.onclick = async () => {
    if (!confirm('Delete these devices from Home Assistant? They have no entities left, and anything still live '
      + 'is never listed — discovery re-creates a device if it comes back.')) return;

    // Deleted in batches so the count is the truth rather than an animation. Each device is a WebSocket
    // round trip to Home Assistant, so thirty-odd of them takes long enough that a spinner with nothing
    // behind it is indistinguishable from a hang.
    const ids = lastDevices.map((d     ) => d.id).filter(Boolean);
    const total = ids.length;
    devDelete.disabled = true;
    devFind.disabled = true;
    devOut.innerHTML = '';
    const label = el('div', { text: `Deleting 0 of ${total}…` });
    const bar = el('div', { class: 'progress' }, el('span', { style: { width: '0%' } }));
    devOut.appendChild(label); devOut.appendChild(bar);

    let done = 0, removed = 0, failed = '';
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      const r = await api('/api/ha/devices/stale/delete', { method: 'POST', body: JSON.stringify({ ids: batch }) });
      if (!r.body?.ok) { failed = r.body?.message || 'unknown error'; break; }
      removed += r.body.deleted || 0;
      done += batch.length;
      label.textContent = `Deleting ${done} of ${total}…`;
      (bar.firstChild               ).style.width = Math.round((done / total) * 100) + '%';
    }

    devFind.disabled = false;
    if (failed) { toast('Stopped after ' + removed + ': ' + failed, false); devOut.textContent = `Deleted ${removed} of ${total} before failing: ${failed}`; return; }
    toast(`Deleted ${removed} stale device(s) from Home Assistant.`, true);
    showDevices([]);
  };
}

// ── sections/home.ts ────────────────────────────────────────────
// Landing/status page (#186): a red / amber / green board for the bridge and everything it talks to.
// The verdicts come from the Status board via /api/status — this file only renders them. Deciding
// what "stale" or "waiting" means lives with the component that knows, not in the browser.

function addHomeSection(nav     , sections     ) {
  const link = navLink(nav, "Status", "◈");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Status' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Every hop your energy data takes — the meters it comes from, the broker it moves over, and the stores it lands in. Green = healthy, amber = degraded or waiting, red = broken, grey = not configured.' }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  bar.appendChild(refresh); sec.appendChild(bar);
  const grid = el('div', { class: 'status-grid' }); sec.appendChild(grid);

  // The dot/badge class per level; 'off' has no class (grey is the default).
  const dotClass      = { good: 'good', warn: 'warn', bad: 'bad', off: '' };

  const card = (cls        , title        , stateText        , detail                ) => {
    const c = el('div', { class: 'status-card' });
    const head = el('div', { class: 'status-head' });
    head.appendChild(el('span', { class: 'dot' + (cls ? ' ' + cls : '') }));
    head.appendChild(el('b', { text: title }));
    head.appendChild(el('span', { class: 'status-state' + (cls ? ' ' + cls : ''), text: stateText }));
    c.appendChild(head);
    c.appendChild(el('div', { class: 'desc', text: detail || '' }));
    return c;
  };

  const ago = (s        ) => s < 90 ? s + 's ago' : Math.round(s / 60) + 'm ago';
  const uptime = (s        ) => { s = Math.floor(s || 0); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return 'up ' + (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; };

  // A card's detail is the static part plus, where the board asked for it, the aged instant it carries.
  const detailOf = (c     ) => {
    const parts           = [];
    if (c.detail) parts.push(c.detail);
    if (c.eventUtc && c.age && c.age !== 'none') {
      const secs = Math.max(0, (Date.now() - new Date(c.eventUtc).getTime()) / 1000);
      parts.push(c.age === 'uptime' ? uptime(secs) : ago(Math.round(secs)));
    }
    return parts.join(' ');
  };

  // What each card said last time, so a card whose verdict actually moved can be flashed. Without it a
  // pushed update is indistinguishable from no update at all.
  const lastState = new Map                ();

  const render = (body     ) => {
    const cards = (body && body.cards) || [];
    grid.innerHTML = '';

    if (!cards.length) {
      grid.appendChild(card('warn', 'Status', 'Waiting', 'No component has reported yet'));
      lastState.clear();
      return;
    }
    cards.forEach((c     ) => {
      const node = card(dotClass[c.level] ?? '', c.title, c.state, detailOf(c));
      const sig = c.level + '/' + c.state;
      if (lastState.has(c.id) && lastState.get(c.id) !== sig) node.classList.add('flash');
      lastState.set(c.id, sig);
      grid.appendChild(node);
    });
  };

  const load = async () => render((await api('/api/status/board')).body);

  refresh.onclick = () => load();
  // The board is pushed from the server (#281) while this tab is on screen. The timer stays as the
  // fallback for when the stream isn't up — it does nothing while it is.
  liveWhileActive(sec, () => 'board', render);
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive()) load(); }, 10000);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, load };
}

// ── sections/features.ts ────────────────────────────────────────
// One page for every on/off switch in the product (#292).
//
// Each feature used to carry its own Enabled toggle on its own config page, so answering "what is this
// bridge actually doing?" meant opening eight pages and reading eight switches. They are gathered here
// instead, and removed from the individual pages, so there is exactly one place a feature is turned on and
// exactly one answer to what is running.
//
// The list comes from the schema: the server marks the one setting that turns each capability on
// ([FeatureToggle]), so a new one appears here without this file changing. It is marked rather than guessed
// from the name because the names genuinely differ — Gui.Enabled, but HomeAssistant.DiscoveryEnabled and
// Prometheus.Exporter — and a rule of "the boolean called Enabled" would have dropped the last two.
// The schema field renderer, so a switch here is the same control as on the section page — same change
// tracking, same locked-field handling. (The bundle is one shared scope, so this import is erased.)

/// A section's feature switch, if it has one. Exported so the config form filters exactly the property this
/// page renders — the two must agree, or a toggle is either duplicated or lost entirely.
function featureToggle(node     )             {
  if (node?.type !== 'object') return null;
  return (node.properties || []).find((p     ) => p.isFeatureToggle) || null;
}

/// Jump to a feature's own settings page. Nav links carry the schema key they edit, so this finds the page
/// without a second table of where things live.
function jumpToSection(key        ) {
  const links        = Array.from(document.querySelectorAll('nav a'));
  const link = links.find(a => a.dataset && a.dataset.section === key);
  if (link) link.click();
}

/// The reverse trip: from a section's "turned on and off on the Features page" note back to this page.
function jumpToFeatures() {
  const links        = Array.from(document.querySelectorAll('nav a'));
  const link = links.find(a => a.dataset && a.dataset.label === 'Features');
  if (link) link.click();
}

function addFeaturesSection(nav     , sections     ) {
  const link = navLink(nav, 'Features', '◉');
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Features' }));
  sec.appendChild(el('div', {
    class: 'desc',
    text: 'Everything this bridge can do, and whether it is doing it. Turning a feature on here does not configure it — use Settings on the card for that.',
  }));

  const body = el('div');
  sec.appendChild(body);

  const render = () => {
    body.innerHTML = '';
    const grid = el('div', { class: 'grid' });

    const feats = state.schema
      .map((n     ) => ({ section: n, prop: featureToggle(n) }))
      .filter((f     ) => f.prop);

    feats.forEach(({ section, prop }     ) => {
      const label = FEATURE_LABELS[section.key] || section.label || section.key;
      // The card's identity is the feature, not the word "Enabled" — and the description that explains the
      // feature is the section's, since the property's own is usually just "turn it on".
      renderNode({ ...prop, label, description: prop.description || section.description }, ensure(state.data, section.key, {}), grid, [section.key]);

      const card = grid.children[grid.children.length - 1]       ;
      const go = btn('Settings');
      go.onclick = () => jumpToSection(section.key);
      card.appendChild(el('div', { class: 'feature-go' }, go));
    });

    body.appendChild(grid);
    if (!feats.length) body.appendChild(el('div', { class: 'desc', text: 'No optional features in this build.' }));
  };

  // Re-read on every visit: the switches are bound to the live config document, which the section pages and
  // a reload both change underneath this page.
  link.onclick = () => { render(); activate(link, sec); };
  return { link, sec };
}

// Names that read as a capability rather than as a config section. Anything unlisted keeps its section
// label, so this is a polish list, not a registry to maintain.
const FEATURE_LABELS                         = {
  Gui: 'Web GUI',
  Api: 'REST API',
  Health: 'Health endpoints',
  Modbus: 'Modbus TCP polling',
  EmonCMS: 'EmonCMS export',
  HomeAssistant: 'Home Assistant discovery',
  Prometheus: 'Prometheus metrics',
  Operator: 'Kubernetes operator',
  Cache: 'Persistent cache (Valkey/Redis)',
};

// ── config-form.ts ──────────────────────────────────────────────
// Schema-driven config form: render scalar/object/dictionary/list nodes, the per-section panels, the
// nav, and the overall build() that wires every tab.

// Every scalar edit reports back, so the save bar, the nav badges and the field's own "edited" mark all
// stay in step with the document as it is typed.
function scalarInput(node     , obj     )      {
  const touched = () => refreshDirty();
  let el     ;
  if (node.type === 'bool') {
    el = document.createElement('input'); el.type = 'checkbox'; el.className = 'switch'; el.checked = !!obj[node.key];
    el.onchange = () => { obj[node.key] = el.checked; touched(); };
  } else if (node.type === 'enum') {
    el = document.createElement('select');
    // A blank choice (value "") means "unset" — leave the field out so its default/auto behaviour applies.
    const choices           = (node.enumValues || []).slice();
    // A saved value the build does not offer stays on the list, named as unrecognised. Dropping it would
    // show a blank control over a config that still holds the value, and the first edit of any other field
    // on the page would look like the user chose to clear it.
    const current = obj[node.key];
    if (current != null && current !== '' && !choices.includes(String(current))) choices.push(String(current));
    choices.forEach((v        ) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === '' ? '(default)' : v + ((node.enumValues || []).includes(v) ? '' : ' — not recognised');
      el.appendChild(o);
    });
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => { obj[node.key] = el.value === '' ? undefined : el.value; touched(); };
  } else if (node.type === 'int' || node.type === 'double') {
    el = document.createElement('input'); el.type = 'number'; if (node.type === 'double') el.step = 'any';
    if (node.min != null) el.min = node.min; if (node.max != null) el.max = node.max;
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => { obj[node.key] = el.value === '' ? null : Number(el.value); touched(); };
  } else {
    el = document.createElement('input'); el.type = node.type === 'password' ? 'password' : 'text';
    if (obj[node.key] != null) el.value = obj[node.key];
    el.onchange = () => { obj[node.key] = el.value === '' ? null : el.value; touched(); };
  }
  // A setting whose "off" would take away the means of turning it back on — the GUI's own Enabled flag
  // being the one that matters. Shown rather than hidden: a setting that vanishes reads as unsupported and
  // sends the operator looking for it, while a disabled control with the reason beside it answers in place.
  // The server decides which these are (schema notEditableReason), so there is no list to keep in step here.
  if (node.notEditableReason) {
    el.disabled = true;
    el.title = node.notEditableReason;
  }
  return el;
}

// A boolean reads (and hits) better as a switch with the current state spelled out beside it than as a
// 16px checkbox whose meaning you have to infer from the label.
function switchWrap(input     ) {
  const label = el('span', { class: 'switch-state', text: input.checked ? 'On' : 'Off' });
  const wrap = el('label', { class: 'switch-wrap' }, input, label);
  const sync = () => label.textContent = input.checked ? 'On' : 'Off';
  const prior = input.onchange;
  input.onchange = (e     ) => { prior?.(e); sync(); };
  return wrap;
}

// Render an object's child properties into `container`: scalar fields flow into a multi-column grid
// (compact), while nested lists/dicts/objects are tall unbreakable blocks, so they render full-width
// and stacked — otherwise the CSS column-balancer shoves them into one lopsided column.
// `path` is where `target` lives in the config document, so each field can be tracked for unsaved edits.
function renderObjectBody(properties       , target     , container     , path           = []) {
  const isComplex = (c     ) => c.type === 'object' || c.type === 'list' || c.type === 'dictionary';
  const scalars = (properties || []).filter(c => !isComplex(c));
  const complex = (properties || []).filter(isComplex);
  if (scalars.length) {
    const grid = document.createElement('div'); grid.className = 'grid';
    const fields = new Map             ();
    scalars.forEach(child => {
      renderNode(child, target, grid, path);
      fields.set(child.key, grid.children[grid.children.length - 1]);
    });
    container.appendChild(grid);
    wireVisibility(scalars, target, fields);
  }
  complex.forEach(child => renderNode(child, target, container, path));
}

// A setting that only applies to one choice of another setting (schema visibleWhen) — the Prometheus URL,
// when the history provider is Prometheus. Hidden the rest of the time rather than shown greyed out: an
// EmonCMS page carrying a Prometheus URL reads as if that is what will be queried.
//
// Which fields these are comes from the schema, so the form holds no list of provider-specific settings.
function wireVisibility(props       , target     , fields                  ) {
  props.filter(p => p.visibleWhen).forEach(p => {
    const field = fields.get(p.key);
    if (!field) return;
    // Unset means the deciding setting is at its default, not that it is blank — leaving History.Provider
    // alone still means Prometheus, and the URL has to be reachable.
    const decider = props.find((x     ) => x.key === p.visibleWhen.key);
    const sync = () => {
      const cur = target[p.visibleWhen.key] ?? decider?.default ?? '';
      show(field, p.visibleWhen.values.includes(String(cur)));
    };
    sync();
    visibilitySyncs.push(sync);
  });
}

// Every conditional field's re-check, run together whenever the document is edited. Rebuilt with the form,
// so a sync never outlives the element it hides.
let visibilitySyncs                 = [];
let visibilityOff      = null;
const runVisibilitySyncs = () => visibilitySyncs.forEach(s => s());

// Leaving a page can change what belongs in the nav too: a page kept visible only because you were on it
// (its feature switched off from inside it) drops out once you go somewhere else. Registered once — the
// list it runs is rebuilt with the form, this listener is not.
window.addEventListener?.('rpdu:activate', runVisibilitySyncs);

function show(elm     , on         ) { elm.classList[on ? 'remove' : 'add']('is-hidden'); }

// Render an arbitrary node bound to obj[node.key] (the value lives under its key on obj).
function renderNode(node     , obj     , container     , path           = []) {
  const here = [...path, node.key];
  if (node.type === 'object') {
    const target = ensure(obj, node.key, {});
    const fs = document.createElement('fieldset');
    const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
    renderObjectBody(node.properties, target, fs, here);
    container.appendChild(fs);
  } else if (node.type === 'dictionary') {
    container.appendChild(renderMap(node, ensure(obj, node.key, {}), here));
  } else if (node.type === 'list') {
    container.appendChild(renderList(node, ensure(obj, node.key, []), here));
  } else {
    const f = document.createElement('div'); f.className = 'field';
    // Where this control writes to, on the element itself: it makes a rendered form readable in devtools,
    // and it is how a check can say "this exact setting is rendered once" rather than matching on a label
    // like "Enabled", which several unrelated nested sections legitimately share.
    f.dataset.path = here.join('.');
    const lab = document.createElement('label'); lab.textContent = node.label; f.appendChild(lab);
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; f.appendChild(d); }
    const input = scalarInput(node, obj);
    // A masked field with no way to read it back is how a mistyped credential survives three attempts.
    f.appendChild(node.type === 'bool' ? switchWrap(input) : node.type === 'password' ? revealWrap(input) : input);
    // Say why it's greyed out, in the field itself — a disabled control with no explanation reads as a bug.
    if (node.notEditableReason) {
      const why = document.createElement('div');
      why.className = 'desc field-locked';
      why.textContent = node.notEditableReason;
      f.appendChild(why);
    }
    if (node.templateVars && node.templateVars.length) f.appendChild(templateVarChips(node.templateVars, input, obj, node));
    // A password's value must never reach the change-review list.
    registerField(here, f, node.type === 'password');
    container.appendChild(f);
  }
}

// Click-to-insert / draggable chips for a templated field's available {variables}.
function templateVarChips(vars          , input     , obj     , node     ) {
  const wrap = document.createElement('div'); wrap.className = 'tpl-vars';
  const label = document.createElement('span'); label.className = 'desc'; label.style.margin = '0'; label.textContent = 'Variables:';
  wrap.appendChild(label);
  vars.forEach(v => {
    const token = '{' + v + '}';
    const chip = document.createElement('span'); chip.className = 'tpl-chip'; chip.textContent = token; chip.draggable = true;
    chip.title = 'Click to insert at the cursor, or drag into the field';
    chip.onclick = () => {
      const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, s) + token + input.value.slice(e);
      const pos = s + token.length; input.focus(); input.setSelectionRange(pos, pos);
      obj[node.key] = input.value === '' ? null : input.value;
      refreshDirty();
    };
    // Native text drop inserts at the drop point; the field's change handler syncs the model on blur.
    chip.ondragstart = (ev     ) => ev.dataTransfer.setData('text/plain', token);
    wrap.appendChild(chip);
  });
  return wrap;
}

// Render the value of a dictionary/list element (valueSchema has no key of its own). `path` addresses
// the element itself, e.g. ['Pdus','default'] or ['Modbus','Connections','0'].
function renderValue(valueSchema     , holder     , keyName     , container     , path          ) {
  const node = Object.assign({}, valueSchema, { key: keyName, label: 'value' });
  if (node.type === 'object') {
    const target = ensure(holder, keyName, {});
    // A dictionary/list entry's fields (e.g. each PDU instance): scalars in columns, collections full-width.
    renderObjectBody(node.properties, target, container, path);
  } else {
    renderNode(node, holder, container, path.slice(0, -1));
  }
}

function renderMap(node     , mapObj     , path          ) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
  const entries = document.createElement('div'); fs.appendChild(entries);

  const drawEntry = (key        ) => {
    const wrap = document.createElement('div'); wrap.className = 'map-entry';
    const head = document.createElement('div'); head.className = 'head';
    const keyIn = document.createElement('input'); keyIn.className = 'key'; keyIn.type = 'text'; keyIn.value = key;
    keyIn.onchange = () => { if (keyIn.value && keyIn.value !== key) { mapObj[keyIn.value] = mapObj[key]; delete mapObj[key]; key = keyIn.value; refreshDirty(); } };
    const del = btn('Remove', 'danger');
    del.onclick = () => { delete mapObj[key]; entries.removeChild(wrap); refreshDirty(); };
    head.appendChild(keyIn); head.appendChild(del); wrap.appendChild(head);
    if (mapObj[key] == null) mapObj[key] = (node.valueSchema && node.valueSchema.type === 'object') ? {} : '';
    renderValue(node.valueSchema, mapObj, key, wrap, [...path, key]);
    entries.appendChild(wrap);
  };

  Object.keys(mapObj).forEach(drawEntry);
  const add = btn('+ Add');
  add.onclick = () => { let k = 'new'; let i = 1; while (mapObj[k] !== undefined) k = 'new' + (i++); mapObj[k] = node.valueSchema.type === 'object' ? {} : ''; drawEntry(k); refreshDirty(); };
  fs.appendChild(add);
  return fs;
}

function renderList(node     , arr       , path          ) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);

  // A list of tag names is a list of references to something defined elsewhere, so it is chosen rather
  // than typed: a mistyped tag here is a filter that silently matches nothing.
  if (node.tagChoices) {
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
    const picker = tagInput(arr, { strict: true });
    fs.appendChild(picker);
    registerField([...path], fs       , false);
    return fs;
  }

  const entries = document.createElement('div'); fs.appendChild(entries);
  const draw = (idx        ) => {
    const wrap = document.createElement('div'); wrap.className = 'list-entry';
    const del = btn('Remove', 'danger');
    del.onclick = () => { arr.splice(idx, 1); rebuild(); refreshDirty(); };
    wrap.appendChild(del);
    renderValue(node.valueSchema, arr, idx, wrap, [...path, String(idx)]);
    entries.appendChild(wrap);
  };
  const rebuild = () => { entries.innerHTML = ''; arr.forEach((_, i) => draw(i)); };
  rebuild();
  const add = btn('+ Add');
  add.onclick = () => { arr.push(node.valueSchema.type === 'object' ? {} : ''); rebuild(); refreshDirty(); };
  fs.appendChild(add);
  return fs;
}

// Nav grouped by function (#209): the PDU group only does anything with Vertiv rPDUs configured; live
// value sources are Integrations; readings are consolidated and shipped onward (Destinations); the rest is
// plumbing (System). A group holds both schema-driven config sections (by key) and the bespoke tool tabs
// (by their add* fn). Ungrouped schema sections fall into System, so a new one is never lost.
/// `after` names the schema section a tool belongs to. Without it a tool lands at the END of its group,
/// and `child: true` then indents it under whatever schema section happened to sort last — which is how
/// "HA Energy Mapping" ended up hanging off EmonCMS.

const NAV_GROUPS                                        = [
  // Sources: the Vertiv rPDU integration is the parent; its PDU-only tabs hang off it as children.
  { title: 'Sources', items: [{ tool: addLiveDataSection, child: true }, { tool: addControlSection, child: true }, { tool: addPathsSection, child: true }] },
  { title: 'Energy Flow', items: [{ tool: addEnergyOverviewSection }, { tool: addNodesSection }, { tool: addFlowSection }, { tool: addTrendsSection }, { tool: addNodeDataSection }] },
  { title: 'Integrations', items: [{ tool: addMqttImportSection, child: true, after: 'MQTT' }] },
  { title: 'Destinations', items: [{ tool: addHaEnergySection, child: true, after: 'HomeAssistant' }] },
  // The status board is a System page: it answers "is the bridge healthy", which is the second question.
  { title: 'System', items: [{ tool: addHomeSection }, { tool: addFeaturesSection }, { tool: addExportSection }, { tool: addDiagnosticsSection }] },
];

// Display-label fixes — acronyms in caps, and clearer names (#209). Keys are schema section keys.
const LABEL_OVERRIDES                         = { Pdus: 'Vertiv rPDU', Api: 'API', Gui: 'GUI', Modbus: 'Modbus TCP', HomeAssistant: 'Home Assistant' };

// A leading glyph per schema-driven page. Purely a scanning aid — the label is still the page's
// identity — so an unlisted section simply gets the neutral bullet. (The bespoke tool tabs pass their
// own glyph to navLink() where they build their link.)
const NAV_ICONS                         = {
  'Vertiv rPDU': '▤', 'Overrides': '✎', 'MQTT': '⇅', 'Modbus TCP': '⧉', 'EmonCMS': '▦',
  'Home Assistant': '⌂', 'Prometheus': '◎', 'GUI': '▭', 'API': '⚙',
  'Health': '♥', 'Logging': '☰', 'Debug': '⚑', 'Operator': '⎈',
};
function navIcon(label        ) { return NAV_ICONS[label] || '•'; }

// A collapsible nav group: clicking the header toggles its items. Returns the container the group's links
// (schema sections or tool tabs) are appended into.
function navGroup(nav     , title        ) {
  const wrap = el('div', { class: 'nav-group-wrap' });
  const header = el('div', { class: 'nav-group', text: title });
  const items = el('div', { class: 'nav-group-items' });
  header.onclick = () => wrap.classList.toggle('collapsed');
  wrap.append(header, items); nav.appendChild(wrap);
  return items;
}

// A credential field with a show/hide button. Hidden by default — it is a credential — but readable while
// it is being entered, because a value you cannot see is a value you cannot check against the one you
// copied.
function revealWrap(input     ) {
  const wrap = el('div', { class: 'reveal-wrap' });
  const eye = btn('Show');
  eye.type = 'button';
  eye.className = 'small reveal-btn';
  eye.title = 'Show this value';
  eye.onclick = () => {
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    eye.textContent = hidden ? 'Hide' : 'Show';
    eye.title = hidden ? 'Hide this value' : 'Show this value';
  };
  wrap.append(input, eye);
  return wrap;
}

// Says where a section's on/off switch went, and takes you there — a control that simply vanishes reads as
// a missing feature and sends the operator hunting for it.
function featurePointer(label        ) {
  const wrap = el('div', { class: 'desc feature-pointer' });
  wrap.appendChild(el('span', { text: `${label} is turned on and off on the Features page. ` }));
  const go = btn('Features');
  go.onclick = () => jumpToFeatures();
  wrap.appendChild(go);
  return wrap;
}

// Reading history from EmonCMS reads the feeds the EmonCMS export writes — same server, same key, same feed
// names — so there is nothing to configure for it here. Point at the page that does configure it rather
// than leave the page looking empty, or worse, duplicate the server and key into a second place to edit.
function wireHistoryProvider(sec     ) {
  const wrap = el('div', { class: 'desc feature-pointer' });
  wrap.appendChild(el('span', { text: 'EmonCMS history reads the feeds the EmonCMS export writes. Its server, API key and feed names are configured on the EmonCMS page. ' }));
  const go = btn('EmonCMS');
  go.onclick = () => jumpToSection('EmonCMS');
  wrap.appendChild(go);
  sec.appendChild(wrap);

  const sync = () => show(wrap, (state.data.History || {}).Provider === 'emoncms');
  sync();
  visibilitySyncs.push(sync);
}

// A settings page for a capability that is switched off is a page of settings for something that is not
// running. Its nav entry is hidden until the feature is turned on.
//
// Hidden, not removed: the page is still built, still reachable from the Features card's Settings button
// and from the command palette, and its entry returns the instant the switch is flipped — no save, no
// reload. The Features page is the one place that answers "what is this bridge doing?", and the nav now
// agrees with it instead of listing ten pages for things that are off.
function hideWhileOff(link     , sectionKey        , feature     ) {
  const sync = () => {
    const cur = (state.data[sectionKey] || {})[feature.key];
    const on = cur == null ? !!feature.default : !!cur;
    // Never hide the page being looked at: switching a feature off from its own settings page is exactly
    // when its nav entry would vanish under you, which reads as the GUI breaking.
    show(link, on || link.classList.contains('active'));
  };
  sync();
  visibilitySyncs.push(sync);
}

// Render one schema-driven config section (nav link + panel); returns the nav link.
function renderConfigSection(node     , nav     , sections     ) {
  const label = LABEL_OVERRIDES[node.key] || node.label;
  const link = navLink(nav, label, navIcon(label));
  // Which part of the document this page edits, so its nav entry can carry a count of pending edits.
  link.dataset.section = node.key;
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = label; sec.appendChild(h);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; sec.appendChild(d); }
  // Section-specific actions belong with the section they act on, not on every page.
  const acts = sectionActions(node);
  if (acts) sec.appendChild(acts);
  if (node.key === 'Overrides') {
    // Bespoke, live-data-driven editor instead of the blind dictionary form.
    const tools = document.createElement('div'); tools.className = 'sec-actions';
    const refresh = btn('Refresh live data');
    const preview = btn('Preview generated paths (with unsaved edits)');
    tools.appendChild(refresh); tools.appendChild(preview);
    const pathsBox = document.createElement('div');
    const container      = document.createElement('div');
    refresh.onclick = () => renderOverrides(container);
    preview.onclick = () => previewOverridePaths(pathsBox);
    sec.appendChild(tools); sec.appendChild(pathsBox); sec.appendChild(container);
    link.onclick = () => { activate(link, sec); if (!container.dataset.loaded) renderOverrides(container); };
  } else {
    if (node.type === 'object') {
      ensure(state.data, node.key, {});
      // The Energy Dashboard's settings — its URL and long-lived token above all — are rendered here, on
      // the Home Assistant page, because that is where anyone looks for them: the status board reports the
      // sync as "Home Assistant — Failing", and this is the page it names. The HA Energy Mapping page keeps
      // its own copies of the two connection fields, bound to this same object, because it cannot test a
      // connection it has no way to enter.
      let props = node.properties;
      // A feature's on/off switch lives on the Features page, not on eight separate pages (#292). It is
      // removed here rather than duplicated: two switches bound to one value would disagree the moment one
      // of them was clicked, and a page showing "Off" for something that is on is exactly the kind of
      // inaccuracy this GUI must never show.
      const feature = featureToggle(node);
      if (feature) {
        props = (props || []).filter((p     ) => p !== feature);
        sec.appendChild(featurePointer(label));
        hideWhileOff(link, node.key, feature);
      }
      // A plugin's settings live under Plugins/<id>, not as a property of their own — Config was compiled
      // before the plugin existed. Everything else about rendering and change-tracking is identical.
      const target = node.isPlugin
        ? ensure(ensure(state.data, 'Plugins', {}), node.key, {})
        : state.data[node.key];
      const path = node.isPlugin ? ['Plugins', node.key] : [node.key];
      renderObjectBody(props, target, sec, path);
    }
    else renderNode(node, state.data, sec, []);
    // A plugin's buttons come from what it says it can do — no per-integration wiring here at all.
    if (node.isPlugin) integrationActionBar(node.key).then(bar => { if (bar) sec.appendChild(bar); });
    // The discovery cleanups belong with the discovery buttons, not on the energy-mapping page.
    if (node.key === 'HomeAssistant') addDiscoveryCleanup(sec);
    if (node.key === 'History') wireHistoryProvider(sec);
    if (node.key === 'Gui') wireGuiAuth(sec);
    else if (node.key === 'EmonCMS') wireEmonCmsTransport(sec);
    else if (node.key === 'Api') wireApiDocs(sec);
    else if (node.key === 'Operator') { wireOperatorCheck(sec); wireOperatorSwitch(sec); }
    link.onclick = () => activate(link, sec);
  }
  return link;
}

function build() {
  const nav      = document.getElementById('nav'); const sections      = document.getElementById('sections');
  nav.innerHTML = ''; sections.innerHTML = '';
  // Everything registered against the old DOM is gone with it.
  clearFieldRegistry();
  visibilitySyncs = [];

  const byKey = new Map(state.schema.map((n     ) => [n.key, n]));
  // EnergyFlow has a dedicated visual editor (Flow/Nodes tabs), so its raw schema form is hidden here.
  // EnergyFlow has a dedicated visual editor (Flow/Nodes tabs). Plugins is the raw storage behind the
  // per-plugin pages — every loaded plugin already renders its own typed section, so showing the map as
  // well gives two editors for one thing, and the raw one is a free-text box you cannot usefully type into.
  const HIDDEN = new Set(['EnergyFlow', 'Plugins']);
  // A section the client doesn't place itself — a plugin's, or a new built-in — goes where the schema says
  // it belongs, and into System when it says nothing, so a new one is never lost.
  //
  // Built from a COPY of NAV_GROUPS. Pushing into the module-level constant meant every rebuild of the form
  // appended the same sections again, so saving twice put a page in the nav three times.
  // Every schema section is placed by what the SCHEMA says, built-in or plugin. NAV_GROUPS now carries
  // only the visual editors (Flow, Nodes, Trends…), which have no schema section to declare a group on.
  // Holding the grouping in two places is how a section ends up registered, rendered and reachable while
  // sitting in the wrong group, with nothing to say it was forgotten.
  //
  // Schema sections lead each group and the tools follow, because a tool marked `child` indents under
  // whatever precedes it — the PDU tabs belong under the PDU page, not above it.
  const navGroups = NAV_GROUPS.map(g => ({ title: g.title, items: []              }));
  const groupFor = (title        ) => navGroups.find(g => g.title === title) ?? navGroups.find(g => g.title === 'System') ;

  state.schema.forEach((n     ) => {
    if (HIDDEN.has(n.key)) return;
    groupFor(n.group || 'System').items.push({ schema: n.key });
  });
  NAV_GROUPS.forEach((g, i) => g.items.forEach(it => {
    // A tool that names its parent section sits directly after it; everything else keeps to the end.
    const after = 'after' in it ? it.after : undefined;
    const at = after ? navGroups[i].items.findIndex(x => 'schema' in x && x.schema === after) : -1;
    if (at >= 0) navGroups[i].items.splice(at + 1, 0, it);
    else navGroups[i].items.push(it);
  }));

  // The landing page: what the system is doing now, rendered first so it's the default tab (#395).
  const overview = addOverviewSection(nav, sections);
  const first      = overview.link;

  for (const g of navGroups) {
    // Drop items whose schema section is absent (e.g. Logging is hidden from the schema under Kubernetes).
    const items = g.items.filter(it => 'tool' in it || byKey.get((it       ).schema));
    if (!items.length) continue;
    const container = navGroup(nav, g.title);
    for (const it of items) {
      if ('schema' in it) {
        const l = renderConfigSection(byKey.get(it.schema), container, sections);
        if (it.child && l) l.classList.add('nav-child');
      } else {
        const before = container.children.length;
        it.tool(container, sections);
        if (it.child && container.children[before]) container.children[before].classList.add('nav-child');
      }
    }
  }

  // Open the tab named in the URL hash (so a refresh / shared link lands where you were), else the first.
  const wanted = decodeURIComponent((location.hash || '').slice(1));
  const target = wanted ? ([...nav.querySelectorAll('a')]         ).find(a => slug(navLabel(a)) === wanted) : null;
  (target || first)?.click();

  // One subscription for every conditional field, so changing the setting they hang off takes effect as
  // soon as it is picked rather than after a save and reload.
  visibilityOff?.();
  visibilityOff = onDirty(runVisibilitySyncs);

  wireNavBadges(nav);
}

// Each config page's nav entry carries the number of unsaved edits inside it, so pending work is
// visible from anywhere — you don't have to remember which tab you were on when you changed something.
let navBadgesOff      = null;
function wireNavBadges(nav     ) {
  // A rebuild replaces every link, so drop the watcher that was pointing at the old ones.
  navBadgesOff?.();
  const links = ([...nav.querySelectorAll('a')]         ).filter(a => a.dataset?.section);
  navBadgesOff = onDirty(() => links.forEach(a => {
    const n = changeCountFor(a.dataset.section);
    const existing = a.querySelector('.nav-badge');
    if (!n) { existing?.remove(); return; }
    if (existing) existing.textContent = String(n);
    else a.appendChild(el('span', { class: 'nav-badge', text: String(n), title: n + ' unsaved change(s) on this page' }));
  }));
}

// In the Gui section, grey out the auth fields that don't apply to the selected AuthType.
function wireGuiAuth(sec     ) {
  const oidcFs = [...sec.querySelectorAll('fieldset')].find((fs     ) => fs.querySelector('legend')?.textContent === 'Oidc')       ;
  // The AuthType dropdown is the only select in the Gui section (outside the Oidc fieldset).
  const authSelect = [...sec.querySelectorAll('.field select')].find((s     ) => !oidcFs || !oidcFs.contains(s))       ;
  if (!authSelect) return;
  // Basic-auth fields = text/password inputs of the Gui section, outside the Oidc fieldset.
  const basicInputs = [...sec.querySelectorAll('.field input')].filter((i     ) => (!oidcFs || !oidcFs.contains(i)) && (i.type === 'text' || i.type === 'password'));
  const oidcInputs = oidcFs ? [...oidcFs.querySelectorAll('input, select, textarea')] : [];
  const setOff = (els       , off         ) => els.forEach((e     ) => { e.disabled = off; e.style.opacity = off ? '0.5' : '1'; });
  const apply = () => {
    const t = authSelect.value;
    setOff(basicInputs, t !== 'Basic');
    setOff(oidcInputs, t !== 'Oidc');
  };
  authSelect.addEventListener('change', apply);
  apply();
}

// In the EmonCMS section, hide the fields that don't apply to the selected Transport (Http vs Mqtt).
function wireEmonCmsTransport(sec     ) {
  const fields = [...sec.querySelectorAll('.field')]         ;
  const field = (label        ) => fields.find(f => f.querySelector('label')?.textContent === label);
  const transportSel = field('Transport')?.querySelector('select');
  if (!transportSel) return;
  const mqttOnly = ['MqttBaseTopic', 'MqttTopicTemplate'].map(field).filter(Boolean);
  // Url/ApiKey are needed by the HTTP transport AND by feed auto-config (which drives the REST API
  // regardless of the measurement transport); Path is HTTP-transport only.
  const urlKey = ['Url', 'ApiKey'].map(field).filter(Boolean);
  const pathField = field('Path');
  const feedsAuto = field('AutoConfigure')?.querySelector('input[type=checkbox]');
  const apply = () => {
    const t = transportSel.value; // 'Http' | 'Mqtt'
    urlKey.forEach((f     ) => f.style.display = (t === 'Http' || feedsAuto?.checked) ? '' : 'none');
    if (pathField) pathField.style.display = t === 'Http' ? '' : 'none';
    mqttOnly.forEach((f     ) => f.style.display = t === 'Mqtt' ? '' : 'none');
  };
  transportSel.addEventListener('change', apply);
  feedsAuto?.addEventListener('change', apply);
  apply();
}

// The API section advertises OpenAPI/Scalar docs but never said where they live (#190). Show the real
// URLs, derived from the configured port. The API listens on its own port, so the links are built from
// this page's hostname rather than its path — they are only reachable if that port is exposed to you.
function wireApiDocs(sec     ) {
  const fields = [...sec.querySelectorAll('.field')]         ;
  const field = (label        ) => fields.find(f => f.querySelector('label')?.textContent === label);
  const enabled = field('Enabled')?.querySelector('input[type=checkbox]');
  const portIn = field('Port')?.querySelector('input');
  if (!portIn) return;

  const box = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = 'Documentation'; box.appendChild(lg);
  const desc = document.createElement('div'); desc.className = 'desc'; box.appendChild(desc);
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  box.appendChild(list);

  const LINKS = [
    ['Interactive docs (Scalar)', '/scalar/v1'],
    ['OpenAPI document', '/openapi/v1.json'],
    ['API root', '/api/v1'],
  ];

  const apply = () => {
    const on = enabled ? enabled.checked : true;
    const port = portIn.value || '8082';
    const base = `${location.protocol}//${location.hostname}:${port}`;
    desc.textContent = on
      ? 'The API is served on its own port — these links work once that port is reachable from your browser.'
      : 'The API is disabled. Enable it above, save, and restart; these links will work once it is listening.';
    list.innerHTML = '';
    for (const [label, path] of LINKS) {
      const row = document.createElement('div');
      const a = document.createElement('a');
      a.href = base + path; a.textContent = base + path;
      a.target = '_blank'; a.rel = 'noopener';
      a.style.cssText = 'font:12px ui-monospace,Consolas,monospace;';
      // Left clickable even when the API is off. Killing pointer-events made these look like ordinary
      // links that silently ignored a click — reported as "API links not clickable" (#295), because a
      // dead-looking link is indistinguishable from a broken page. The reason is now on the row itself
      // rather than only in the paragraph above it, so the state is legible where the link is.
      if (!on) {
        a.style.opacity = '0.55';
        a.title = 'The API is disabled, so nothing is listening on this port yet — enable it above, save, and restart.';
        row.appendChild(document.createTextNode(label + ': '));
        row.appendChild(a);
        row.appendChild(el('span', { class: 'desc', style: { margin: '0 0 0 6px' }, text: '· API disabled' }));
      } else {
        row.appendChild(document.createTextNode(label + ': '));
        row.appendChild(a);
      }
      list.appendChild(row);
    }
  };

  portIn.addEventListener('input', apply);
  enabled?.addEventListener('change', apply);
  apply();
  sec.appendChild(box);
}

// Operator page: an on-demand update check. Asks the operator to query the registry now and says plainly
// whether a newer eligible version (bounded by Policy) is available — read-only, never touches the Deployment.
function wireOperatorCheck(sec     ) {
  const box = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = 'Update check'; box.appendChild(lg);
  box.appendChild(el('div', { class: 'desc', text: 'Check the registry now and report whether a newer eligible version (bounded by Policy) is available. Read-only — this never changes the Deployment.' }));
  const row = el('div', { class: 'sec-actions' });
  const check = btn('Check now', 'primary');
  const result = el('div', { class: 'desc', style: { margin: '4px 0 0', fontSize: '13px' } });
  row.append(check); box.append(row, result);
  sec.appendChild(box);

  const show = (u     ) => {
    // The operator reports both the message and a Severity, so the colour comes straight from that severity —
    // no re-deriving from wording (the old code called 'unstable' a "release", then keyword-sniffed the prose).
    // Fall back to `available` only for a legacy report that predates the severity field.
    const msg = u?.message || (u?.available ? 'Update available.' : 'Up to date.');
    const sev = u?.severity ?? (u?.available ? 'UpdateAvailable' : 'Ok');
    if (sev === 'UpdateAvailable') { result.style.color = 'var(--warn, #fa4)'; result.textContent = '↑ ' + msg; }
    else if (sev === 'Ok') { result.style.color = 'var(--good)'; result.textContent = '✓ ' + msg; }
    else { result.style.color = 'var(--muted)'; result.textContent = msg; }   // Info / Error
    if (u?.checkedAt) result.textContent += ` · checked ${new Date(u.checkedAt).toLocaleTimeString()}`;
  };

  check.onclick = async () => {
    check.disabled = true;
    result.style.color = 'var(--muted)'; result.textContent = 'Checking the registry…';
    const r = await api('/api/operator/check', { method: 'POST' });
    check.disabled = false;
    if (!r.body?.ok) { result.style.color = 'var(--bad)'; result.textContent = r.body?.message || 'Check failed.'; return; }
    show(r.body.update);
  };
}

// Operator page: a channel/version switcher — roll the Deployment to stable/edge/dev or a specific release (#210).
function wireOperatorSwitch(sec     ) {
  const box = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = 'Deployed version'; box.appendChild(lg);
  const desc = el('div', { class: 'desc' }); box.appendChild(desc);
  const row = el('div', { class: 'sec-actions' });
  const sel = document.createElement('select'); sel.style.width = 'auto';
  const switchBtn = btn('Switch', 'primary');
  const forceBtn = btn('Force update');
  forceBtn.title = 'Re-pull the current tag now (pins its current digest so it rolls even on IfNotPresent). Use for moving channels like edge/dev that changed underneath.';
  const status = el('div', { class: 'desc' });
  row.append(sel, switchBtn, forceBtn); box.append(row, status);
  sec.appendChild(box);

  forceBtn.onclick = async () => {
    if (!confirm('Force a re-pull of the currently-deployed tag and roll the Deployment now?')) return;
    forceBtn.disabled = true;
    const res = await api('/api/operator/redeploy', { method: 'POST' });
    forceBtn.disabled = false;
    const forcedOk = res.ok && res.body?.ok;
    toast(res.body?.message || (res.ok ? 'Force update requested.' : 'Force update failed.'), forcedOk);
    if (forcedOk) {
      status.textContent = res.body.message;
      // The workload is about to go away. Say so, so the dropped stream reads as "busy", not "broken".
      expectRestart('Re-pulling the deployed image');
      toast('Updating — the bridge is restarting. This page reconnects on its own.', true);
    }
  };

  const CHANNEL_LABEL                         = {
    stable: 'stable — newest release', latest: 'latest — newest release', edge: 'edge — main branch (bleeding edge)',
    dev: 'dev — work-in-progress builds', unstable: 'unstable — work-in-progress builds',
  };

  api('/api/operator/tags').then(r => {
    const b = r.body || {};
    if (!b.ok) { desc.textContent = b.message || 'Version switching is unavailable.'; sel.style.display = 'none'; switchBtn.style.display = 'none'; forceBtn.style.display = 'none'; return; }
    desc.innerHTML = `Roll the Deployment to a different image tag. Currently deployed: <b>${b.current || '—'}</b>. Switching restarts the workload (a normal rolling update).`;
    const group = (label        , tags          , fmt                       ) => {
      if (!tags || !tags.length) return;
      const og = document.createElement('optgroup'); og.label = label;
      tags.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = fmt(t); if (t === b.current) o.selected = true; og.appendChild(o); });
      sel.appendChild(og);
    };
    group('Channels', b.channels || [], (t        ) => CHANNEL_LABEL[t] || t);
    group('Versions', b.versions || [], (t        ) => t);
    if (!sel.options.length) { desc.textContent += ' No tags found in the registry.'; switchBtn.disabled = true; }

    switchBtn.onclick = async () => {
      const tag = sel.value; if (!tag) return;
      if (tag === b.current) { toast('That tag is already deployed.', false); return; }
      if (!confirm(`Switch the deployment to "${tag}"? This rolls the workload (all tiers) to that image.`)) return;
      switchBtn.disabled = true;
      const res = await api('/api/operator/set-tag?tag=' + encodeURIComponent(tag), { method: 'POST' });
      switchBtn.disabled = false;
      const switchedOk = res.ok && res.body?.ok;
      toast(res.body?.message || (res.ok ? 'Switch requested.' : 'Switch failed.'), switchedOk);
      if (switchedOk) {
        status.textContent = res.body.message;
        expectRestart(`Switching to ${tag}`);
        toast(`Updating to ${tag} — the bridge is restarting. This page reconnects on its own.`, true);
      }
    };
  }).catch(() => { desc.textContent = 'Could not load available versions.'; sel.style.display = 'none'; switchBtn.style.display = 'none'; forceBtn.style.display = 'none'; });
}

// A link out to the system this page configures. It appears only when a URL is actually configured, so it
// can never dangle, and the href is resolved on each visit rather than at build time — otherwise editing
// the URL and clicking straight through would open the old one.
function externalLink(label        , href                     , hint        ) {
  const a      = el('a', { class: 'ext-link', target: '_blank', rel: 'noopener', title: hint }, label + ' ↗');
  const sync = () => {
    const u = href();
    if (u) { a.href = u; a.title = hint + '\n' + u; a.classList.remove('is-hidden'); }
    else a.classList.add('is-hidden');
  };
  sync();
  // activate() announces every tab switch, so a URL edited elsewhere is picked up on the way back here.
  window.addEventListener?.('rpdu:activate', sync);
  return a;
}

// A configured URL, trimmed and only if it looks like one — a half-typed host shouldn't produce a link.
function cfgUrl(...path          )                {
  let o      = state.data;
  for (const p of path) { if (o == null) return null; o = o[p]; }
  const s = typeof o === 'string' ? o.trim() : '';
  return /^https?:\/\/.+/i.test(s) ? s.replace(/\/+$/, '') : null;
}

// Section-specific action buttons (connection tests; Home Assistant discovery actions; a way in to the
// system being configured).
function sectionActions(node     ) {
  const bar = document.createElement('div'); bar.className = 'sec-actions';

  // What the last action did, on the page. A toast is gone in a few seconds and "did that work?" is the
  // whole reason these buttons exist — a test whose answer you have to catch is a test that says nothing.
  const result = el('div', { class: 'desc test-result' });

  const add = (label        , fn     , cls         ) => {
    const b = btn(label, cls);
    b.onclick = async () => {
      const was = b.textContent;
      b.disabled = true; b.textContent = 'Working…';
      result.textContent = '';
      result.className = 'desc test-result';
      try {
        const out      = await fn();
        if (out && typeof out.message === 'string') {
          result.textContent = (out.ok ? '✓ ' : '✗ ') + out.message;
          result.classList.add(out.ok ? 'test-ok' : 'test-bad');
        }
      } catch (e     ) {
        // An action that throws must not leave the button stuck on "Working…" with nothing said.
        result.textContent = '✗ ' + (e?.message || e);
        result.classList.add('test-bad');
      } finally { b.disabled = false; b.textContent = was; }
    };
    bar.appendChild(b);
  };

  if (node.key === 'MQTT') add('Test MQTT connection', testMqtt);
  else if (node.key === 'History') add('Test history backend', testHistory);
  else if (node.key === 'PDU') add('Test PDU connection', testPdu);
  else if (node.key === 'Modbus') add('Test connections', testModbus);
  else if (node.key === 'EmonCMS') {
    add('Test EmonCMS connection', testEmonCms); add('Provision feeds now', provisionEmonCmsFeeds); add('Delete all feeds', deleteEmonCmsFeeds, 'danger');
    bar.appendChild(externalLink('Open EmonCMS', () => cfgUrl('EmonCMS', 'Url'), 'Open the EmonCMS server this bridge feeds'));
  } else if (node.key === 'HomeAssistant') {
    if ((state.data.HomeAssistant || {}).DiscoveryEnabled !== false) {
      add('Republish discovery', rediscoverHa);
      add('Clear discovery', clearHa, 'danger');
      // The two cleanups that "Clear discovery" cannot do. One removes retained configs for things this
      // build no longer publishes; the other removes devices Home Assistant still lists whose config is
      // already gone, which is reachable only through HA's own API.
    }
    // The base URL is configured for the Energy Dashboard sync, but it's the way in to HA either way.
    bar.appendChild(externalLink('Open Home Assistant', () => cfgUrl('HomeAssistant', 'EnergyDashboard', 'Url'), 'Open Home Assistant'));
  } else if (node.key === 'Prometheus') {
    // Our own exporter, not the Pushgateway (that URL is a write endpoint, not something to visit). Built
    // from this page's hostname the way the API docs links are — it only resolves if that port is exposed.
    bar.appendChild(externalLink('Open /metrics', () => {
      const p = state.data?.Prometheus || {};
      return p.Exporter === false ? null : `${location.protocol}//${location.hostname}:${p.Port || 9184}/metrics`;
    }, 'The metrics this bridge exposes for Prometheus to scrape'));
  } else if (node.key === 'Pdus') {
    // One way in per configured PDU — their web UIs are where you go to check anything this can't show.
    Object.entries(state.data?.Pdus || {}).forEach(([id, pdu]     ) => {
      bar.appendChild(externalLink(`Open ${id}`, () => {
        const c = pdu?.Connection || {};
        const host = (c.Host || '').trim();
        if (!host) return null;
        const scheme = c.Scheme || 'http';
        const port = c.Port && c.Port !== 80 && c.Port !== 443 ? ':' + c.Port : '';
        return `${scheme}://${host}${port}`;
      }, `Open the ${id} PDU's own web interface`));
    });
    if (!bar.children.length) return null;
  } else return null;

  return el('div', {}, bar, result);
}

// ── actions.ts ──────────────────────────────────────────────────
// Section-level connection tests + Home Assistant discovery actions (wired from sectionActions()).

// Test every configured Modbus TCP connection by opening a throwaway connection to each.
async function testModbus() {
  const conns = (state.data?.Modbus?.Connections) || [];
  if (!conns.length) { toast('No Modbus connections configured — add one first.', false); return; }
  toast(`Testing ${conns.length} Modbus connection(s)…`, true);
  for (const c of conns) {
    if (!c.Host) { toast(`${c.Name || c.Id || 'connection'}: no host set.`, false); continue; }
    const r = await api('/api/modbus/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Host: c.Host, Port: c.Port, UnitId: c.UnitId }) });
    toast(`${c.Name || c.Id}: ${r.body.message || (r.body.ok ? 'OK' : 'failed')}`, r.body.ok);
  }
}

/// Run a connection test and always end with a verdict.
///
/// Each of these used to end at `toast(r.body.message, r.body.ok)`. An answer carrying no message toasted
/// an empty toast, and a fetch that threw — the bridge restarting, a proxy dropping the request — never
/// reached the toast at all: the page kept the optimistic "Testing…" and nothing else, which reads as a
/// test that is still running rather than one that failed.

/// Unwraps either shape: a bespoke endpoint's {ok,message} or the generic route's {ok,result:{ok,detail}}.
function testOutcome(body     )                                   {
  const inner = body?.result;
  if (inner && typeof inner === 'object')
    return { ok: inner.ok !== false, message: inner.detail ?? inner.message ?? (inner.ok !== false ? 'OK' : 'Failed') };
  return { ok: body?.ok !== false, message: body?.message ?? '' };
}

async function runTest(what        , path        )                      {
  let out            ;
  try {
    const r = await api(path, { method: 'POST' });
    const outcome = testOutcome(r.body);
    out = {
      ok: outcome.ok && !!(r.body && r.body.ok),
      message: outcome.message
        || (r.ok ? `${what}: the test answered without saying anything.` : `${what}: the bridge answered ${r.status}.`),
    };
  } catch (e     ) {
    out = { ok: false, message: `${what}: could not reach the bridge (${e?.message || e}).` };
  }
  toast(out.message, out.ok);
  return out;
}

async function testMqtt() { const r = await runTest('MQTT', '/api/integrations/mqtt/probe'); refreshStatus(); return r; }
async function testPdu() { return runTest('PDU', '/api/integrations/vertiv/probe'); }
async function testEmonCms() { const r = await runTest('EmonCMS', '/api/integrations/emoncms/probe'); refreshStatus(); return r; }
async function testHistory() { const r = await runTest('History', '/api/test/history'); refreshStatus(); return r; }
async function provisionEmonCmsFeeds() { await runIntegrationAction('emoncms', { name: 'publish', title: 'Provision EmonCMS feeds', description: '', effect: 'write' }); }
async function deleteEmonCmsFeeds() {
  if (!confirm('⚠️ DELETE ALL EmonCMS feeds created by rPDU2MQTT?\n\n'
    + 'This PERMANENTLY deletes every feed under rPDU2MQTT’s tag/node — and ALL of their stored history in EmonCMS.\n\n'
    + 'It CANNOT be undone. Any EmonCMS dashboards, graphs, apps or virtual feeds that use these feeds will break.\n\n'
    + 'Only continue if you intend to wipe and rebuild them.')) return;
  if (!confirm('Are you absolutely sure?\n\nThis is your last chance to cancel before every rPDU2MQTT feed and its data are destroyed.')) return;
  const typed = prompt('Final confirmation — type  DELETE  (all caps) to permanently delete all rPDU2MQTT feeds:');
  if (typed !== 'DELETE') { toast('Cancelled — nothing was deleted.', false); return; }
  toast('Deleting EmonCMS feeds…', true);
  // Through the generic route: the integration owns the rule and the single-owner lease, so the button and
  // the API cannot do different things.
  const r = await api('/api/integrations/emoncms/sweep', { method: 'POST' });
  const inner = (r.body || {}).result || {};
  toast(inner.message ?? r.body?.message ?? 'Done.', r.body?.ok !== false);
}
async function rediscoverHa() { toast('Requesting discovery…', true); const r = await api('/api/discovery/rediscover', { method: 'POST' }); toast(r.body.message, r.body.ok); }
async function clearHa() {
  if (!confirm('Clear ALL Home Assistant discovery messages published by rPDU2MQTT — including any left over '
    + 'from earlier versions or configurations? Every entity disappears from Home Assistant until discovery '
    + 'runs again. Nothing belonging to another integration is touched.')) return;
  const r = await api('/api/discovery/clear', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}

// --- Integration actions, rendered from what each integration says it can do -----------------------------
// Nothing here names an integration. The server derives the action list from the capabilities each one
// declares, so a plugin dropped into plugins/ gets its buttons with no TypeScript written for it — which is
// the whole point of the plugin contracts. The hand-wired per-destination functions above are what this
// replaces; they stay until every built-in is converted.

/// Run one action and report what came back.
async function runIntegrationAction(id        , action     ) {
  // Anything that removes something at the far end is confirmed, and named, before it happens.
  if (action.effect === 'destructive'
    && !confirm(`${action.title}\n\n${action.description}\n\nThis cannot be undone. Continue?`)) return;

  toast(`${action.title}…`, true);
  const r = await api(`/api/integrations/${encodeURIComponent(id)}/${encodeURIComponent(action.name)}`, { method: 'POST' });
  const body      = r.body || {};
  // An action returns whatever it likes; show a message if it gave one, otherwise say it finished.
  const result = body.result ?? {};
  const message = body.message ?? result.message ?? result.detail
    ?? (body.ok ? `${action.title} finished.` : `${action.title} failed.`);
  toast(message, body.ok !== false && result.ok !== false);
  return body;
}

/// The buttons for one integration, or null when it has none to offer.
async function integrationActionBar(id        )               {
  const r = await api('/api/integrations');
  if (!r.body?.ok) return null;
  const found = (r.body.integrations || []).find((i     ) => i.id === id);
  if (!found || !(found.actions || []).length) return null;

  const bar = el('div', { class: 'ld-toolbar' });
  found.actions.forEach((a     ) => {
    const b = btn(a.title, a.effect === 'destructive' ? 'danger' : a.effect === 'write' ? 'primary' : undefined);
    b.title = a.description;
    b.onclick = () => runIntegrationAction(id, a);
    bar.appendChild(b);
  });
  return bar;
}

// ── main.ts ─────────────────────────────────────────────────────
// Shell bootstrap: load the schema + config, build the UI, and own everything that lives outside a
// section — the app bar, the live-stream indicator, the theme, the palette, and the save bar.

// Back/forward navigation + direct hash edits: open the matching tab if it isn't already active. (Normal
// tab clicks already set the hash via activate(), so by the time this fires the tab is active -> no-op,
// which also avoids re-loading a tab's data on every click.)
window.addEventListener('hashchange', () => {
  const wanted = decodeURIComponent((location.hash || '').slice(1));
  if (!wanted) return;
  const link = ([...document.querySelectorAll('nav a')]         ).find(a => slug(a.dataset?.label || a.textContent) === wanted);
  if (link && !link.classList.contains('active')) link.click();
});

async function load() {
  state.schema = (await api('/api/schema')).body;
  state.data = (await api('/api/config')).body;
  // Older backends have no such endpoint; the editor then says what it can without the arithmetic.
  try { state.derivations = ((await api('/api/flow/derivations')).body || {}).metrics || []; }
  catch { state.derivations = []; }
  build();
  // Whatever the server just handed us is, by definition, the saved state.
  setBaseline();
  refreshStatus();
}

// --- App-bar status --------------------------------------------------------------------------------

// Last-seen operator update report, so "check now" can tell when a fresh result has landed.
let lastCheckedAt                = null;
let configWritable = true;
// The last roll the operator reported — its timestamp, and the tag it went to. null means "we haven't seen
// a report yet", which is deliberately different from "" — see appliedTagChanged.
let lastApplied                = null;
let lastAppliedAt                = null;

/// Did the operator just roll the deployment?
///
/// AutoUpdate rolls on the operator's own schedule, so unlike Switch or Force update there is no click to
/// hang an expectRestart() on: the page's first and only warning is the stream dying, which shows as a red
/// "Offline" for something entirely routine.
///
/// Watching the applied *tag* was not enough, and is why this never fired for anyone. Tracking a moving
/// channel — `unstable`, `main`, `edge`, the default and the common case — means an auto-update swaps the
/// digest under an unchanged tag, so "unstable" was reported before and after and nothing looked different.
/// Only a switch between two differently named tags was ever visible. The operator now stamps when it
/// actually rolled, which changes either way; the tag is still checked so an older operator that reports no
/// timestamp keeps working as it did.
///
/// Never fires on the first report. On a fresh page load every value is "new", and announcing a restart
/// that already happened (or never happened) would put the app bar into a state nothing is going to clear.
function appliedTagChanged(applied                           , appliedAt                )          {
  const at = appliedAt || '';
  if (at !== '') {
    // Same rule as the tag below: an absent timestamp is not a new roll, so it must not clear what we know.
    const rolled = lastAppliedAt !== null && at !== lastAppliedAt;
    lastAppliedAt = at;
    // Keep the tag in step so a later report can't read as a change purely because we stopped tracking it.
    if (applied) lastApplied = applied;
    return rolled;
  }

  const now = applied || '';
  // No tag in this report is not a change of tag — the operator can simply stop reporting one (restarting,
  // briefly unreachable). Forgetting the last tag here would make the next report of the SAME tag look
  // like a fresh roll, and announce a restart that never happened.
  if (now === '') return false;
  const changed = lastApplied !== null && now !== lastApplied;
  lastApplied = now;
  return changed;
}

// Render the header update chip from the operator's report (#210). Hidden when no operator is reporting.
function renderUpdate(u     ) {
  const upd      = document.getElementById('st-update');
  if (!upd) return;
  if (!u) { upd.classList.add('is-hidden'); lastCheckedAt = null; return; }
  lastCheckedAt = u.checkedAt || null;
  // An update the operator applied by itself: the workload is going away and nobody here asked for it.
  // Same treatment as a manual switch, so the drop that follows reads as "busy", not "broken".
  if (appliedTagChanged(u.applied, u.appliedAt)) {
    expectRestart(`Auto-updating to ${u.applied}`);
    toast(`Update applied — rolling to ${u.applied}. The bridge is restarting.`, true);
  }
  upd.classList.remove('is-hidden', 'busy');
  if (u.available) {
    upd.className = 'pill pill-btn warn';
    upd.textContent = '↑ ' + (u.latest || 'Update');
    upd.title = 'Update available: ' + (u.latest || '?') + (u.current ? ' (on ' + u.current + ')' : '')
      + (u.applied ? ' — auto-updated' : '') + '\nClick to check now';
  } else if (u.current) {
    upd.className = 'pill pill-btn good';
    upd.textContent = '✓ ' + u.current;
    upd.title = 'Up to date' + (u.checkedAt ? ' (checked ' + new Date(u.checkedAt).toLocaleString() + ')' : '') + '\nClick to check now';
  } else {
    upd.className = 'pill pill-btn';
    upd.textContent = 'Check updates';
    upd.title = (u.message || '') + '\nClick to check now';
  }
}

/// Settings that were saved but that this process is not running.
///
/// Most of the configuration is read once at startup, so saving it writes the file and changes nothing
/// else — the GUI then showed the saved value while the bridge went on behaving the old way, with a single
/// toast as the only warning. The badge stays until a restart closes the gap, on every page and in every
/// browser, and clicking it does the restart.
function renderRestartPending(r     ) {
  const pill      = document.getElementById('st-restart');
  if (!pill) return;
  const settings           = (r && r.settings) || [];
  if (!r || !r.required || !settings.length) { pill.classList.add('is-hidden'); return; }
  pill.classList.remove('is-hidden');
  pill.textContent = 'Restart required';
  pill.title = `${settings.length} saved setting(s) are not what this process is running:\n`
    + settings.slice(0, 12).map(s => '· ' + s).join('\n')
    + (settings.length > 12 ? `\n· …and ${settings.length - 12} more` : '')
    + '\nClick to restart the bridge and apply them.';
  pill.onclick = () => restartNow(settings);
}

/// Restart the bridge, having said exactly what it is for. The stream drops on the way, which the live
/// pill already knows how to explain.
async function restartNow(settings          ) {
  const what = settings.length === 1 ? settings[0] : `${settings.length} settings`;
  if (!confirm(`Restart the bridge now to apply ${what}?\n\nPolling and MQTT publishing stop for a few seconds. This page reconnects on its own.`)) return;
  expectRestart('Applying saved settings');
  const r = await api('/api/restart', { method: 'POST' });
  toast(r.body?.message || (r.ok ? 'Restarting…' : 'Could not restart.'), !!(r.body?.ok ?? r.ok));
}

// Paint the app bar from a /api/status body — from the initial fetch, or pushed on the `status` feed.
function renderStatus(body     ) {
  if (!body) return;
  const set = (id        , fn                  ) => { const e = document.getElementById(id); if (e) fn(e); };

  set('st-version', e => { e.textContent = 'v' + (body.version || '?'); e.title = body.configSource ? 'Config source: ' + body.configSource : ''; });
  set('st-mqtt', e => {
    e.className = 'pill ' + (body.mqttConnected ? 'good' : 'bad');
    e.title = (body.mqttConnected ? 'Connected to ' : 'Not connected to ') + (body.mqttHost || 'the broker');
  });
  set('st-mqtt-dot', e => e.className = 'dot ' + (body.mqttConnected ? 'good' : 'bad'));
  renderUpdate(body.update);

  renderRestartPending(body.restart);

  // A ConfigMap / read-only mount can't be saved: say so up front, not after the save fails.
  configWritable = body.configWritable !== false;
  set('st-readonly', e => e.classList[configWritable ? 'add' : 'remove']('is-hidden'));
  renderSaveBar();

  // Off by default only if the operator turned it off; absent (an older server) means show it.
  set('project-link', e => e.classList[body.showProjectLink === false ? 'add' : 'remove']('is-hidden'));

  // Show a logout link + signed-in user when OIDC is in use.
  if (body.auth === 'oidc') {
    set('st-logout', e => e.classList.remove('is-hidden'));
    if (body.user) set('st-user', e => e.textContent = body.user);
  }
}

async function refreshStatus() {
  renderStatus((await api('/api/status')).body);
}

// The live pill: the one place that says whether anything on screen is actually moving.
function initLiveIndicator() {
  const pill      = document.getElementById('st-live');
  const LOOK                      = {
    live: ['pill good', 'Live', 'Live updates are streaming from the bridge.'],
    connecting: ['pill warn', 'Connecting', 'Opening the live update stream…'],
    down: ['pill bad', 'Offline', 'The live update stream dropped — retrying. Pages fall back to manual refresh.'],
    idle: ['pill', 'Idle', 'Nothing on this page needs live updates.'],
  };
  onRealtimeState(s => {
    if (!pill) return;
    // A gap we asked for is not a fault. While a switch/redeploy/restart is in flight the stream is
    // expected to drop, so say "Updating" rather than flashing red "Offline" at someone who just clicked
    // the button that caused it. Once the stream is back, the window closes and normal reporting resumes —
    // and if it never comes back, the window expires and it goes red for real.
    const why = expectedRestart();
    if (s === 'live') restartFinished();
    const restarting = why && s !== 'live';
    const [cls, text, title] = restarting
      ? ['pill warn', 'Updating', `${why} — the bridge is restarting, so live updates have paused. This page reconnects on its own.`]
      : (LOOK[s] || LOOK.idle);
    pill.className = cls;
    pill.title = title;
    pill.innerHTML = '';
    const dot = restarting ? ' warn' : s === 'live' ? ' good' : s === 'down' ? ' bad' : s === 'connecting' ? ' warn' : '';
    pill.append(el('span', { class: 'dot' + dot }), text);
  });
  // The app bar is always watching, so the stream is up as soon as the page is.
  subscribeLive('status', renderStatus);
}

// "Check now": ask the operator (a separate process) to run a registry check, then poll for the result.
async function checkUpdatesNow() {
  const upd      = document.getElementById('st-update');
  if (upd.classList.contains('busy')) return;
  const priorCheckedAt = lastCheckedAt;
  upd.classList.add('busy'); upd.textContent = '⏳ Checking…'; upd.title = 'Checking for updates…';

  const r = await api('/api/operator/check', { method: 'POST' });
  if (!r.ok || !r.body?.ok) { toast(r.body?.message || 'Update check failed.', false); await refreshStatus(); return; }

  // The operator patches the CR status asynchronously; poll a few times for a newer checkedAt.
  const started = Date.now();
  while (Date.now() - started < 12000) {
    await new Promise(res => setTimeout(res, 1500));
    const s = (await api('/api/status')).body;
    if (s.update && s.update.checkedAt && s.update.checkedAt !== priorCheckedAt) {
      renderUpdate(s.update);
      toast(s.update.available ? ('Update available: ' + (s.update.latest || '?')) : 'Up to date.', true);
      return;
    }
  }
  await refreshStatus();
  toast('Requested a check — no response yet. Is the operator role running?', false);
}

// --- Save bar --------------------------------------------------------------------------------------
// It only exists when there is something to save, and it says how much. The old bar was permanent and
// always enabled: identical whether you'd changed nothing or twenty settings, with no way to see what
// a click would write, and no way back.

let saving = false;

function renderSaveBar() {
  const bar      = document.getElementById('savebar');
  const count      = document.getElementById('save-count');
  const save      = document.getElementById('btn-save');
  const note      = document.getElementById('ro-note');
  if (!bar) return;

  const n = changes().length;
  bar.classList[n ? 'remove' : 'add']('is-hidden');
  if (count) count.textContent = n === 1 ? '1 unsaved change' : n + ' unsaved changes';
  if (note) note.classList[configWritable ? 'add' : 'remove']('is-hidden');
  if (save) {
    save.disabled = saving || !configWritable;
    save.title = configWritable ? 'Write these changes to the configuration source' : 'The configuration source is read-only and cannot be saved.';
  }
}

async function saveConfigChanges() {
  if (saving || !isDirty() || !configWritable) return;
  const save      = document.getElementById('btn-save');
  const payload = exportData();
  saving = true; renderSaveBar();
  if (save) save.textContent = 'Saving…';

  const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  saving = false;
  if (save) { save.innerHTML = ''; save.append('Save', el('kbd', { text: 'Ctrl' }), el('kbd', { text: 'S' })); }

  const ok = r.ok && r.body.ok;
  // Only re-baseline on success — a failed save must leave the changes (and the bar) exactly as they were.
  if (ok) setBaseline(payload);
  else renderSaveBar();
  toast(r.body.message || (ok ? 'Saved.' : 'Save failed.'), ok);

  // Offer the restart at the moment it is needed, rather than leaving the operator to notice later that
  // the bridge is still running the old settings.
  if (ok && r.body.restartRequired) {
    const settings           = r.body.restartSettings || [];
    renderRestartPending({ required: true, settings });
    restartNow(settings);
  }
}

// The reviewable list of what a save would write: one row per setting, old value -> new value.
function reviewChanges() {
  const list = changes();
  const body = el('div');
  if (!list.length) body.appendChild(el('div', { class: 'cmd-empty', text: 'Nothing has been changed.' }));

  // Grouped by the config section each setting belongs to, matching how the nav is organised.
  const groups = new Map               ();
  list.forEach(c => {
    const g = c.path[0] || 'Config';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g) .push(c);
  });

  groups.forEach((rows, g) => {
    const box = el('div', { class: 'diff-group' }, el('h4', { text: g }));
    rows.forEach(c => box.appendChild(el('div', { class: 'diff-row' },
      el('div', { class: 'diff-path', text: c.path.join(' › ') }),
      el('span', { class: 'diff-val diff-old', text: formatValue(c.from, c.secret) }),
      el('span', { class: 'diff-arrow', text: '→' }),
      el('span', { class: 'diff-val diff-new', text: formatValue(c.to, c.secret) }))));
    body.appendChild(box);
  });

  const discard = el('button', { class: 'danger', text: 'Discard all', onclick: () => { closeSheet(); discardAll(); } });
  const saveBtn = el('button', { class: 'primary', text: 'Save', onclick: () => { closeSheet(); saveConfigChanges(); } });
  openSheet({ title: list.length === 1 ? '1 unsaved change' : list.length + ' unsaved changes', body, wide: true, footer: list.length ? [discard, saveBtn] : null });
}

function discardAll() {
  if (!isDirty()) return;
  if (!confirm(`Discard ${changes().length} unsaved change(s) and go back to the saved configuration?`)) return;
  discardChanges();
  build();
  refreshDirty();
  toast('Changes discarded.', true);
}

// --- Wiring ----------------------------------------------------------------------------------------

function initShell() {
  const on = (id        , fn     ) => { const e      = document.getElementById(id); if (e) e.onclick = fn; };
  on('st-update', checkUpdatesNow);
  on('btn-save', saveConfig);
  on('btn-review', reviewChanges);
  on('btn-discard', discardAll);
  on('btn-reload', () => {
    if (isDirty() && !confirm(`Reload from the server and lose ${changes().length} unsaved change(s)?`)) return;
    load();
  });

  // Narrow screens: the sidebar is a drawer. Any nav click closes it again.
  const closeNav = () => document.body.classList.remove('nav-open');
  on('nav-toggle', () => document.body.classList.toggle('nav-open'));
  on('nav-scrim', closeNav);
  document.getElementById('nav')?.addEventListener('click', (e     ) => { if (e.target?.closest?.('a')) closeNav(); });

  window.addEventListener('keydown', (e     ) => {
    if (e.key === 'Escape' && sheetIsOpen()) { e.preventDefault(); closeSheet(); return; }
    // Ctrl/⌘+S is what everyone's fingers already do in a form this size.
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveConfigChanges(); }
  });

  // Don't let a tab close silently take edits with it.
  window.addEventListener('beforeunload', (e     ) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // The bar is a pure function of the pending changes, so it repaints whenever they move.
  onDirty(renderSaveBar);

  // The bespoke editors (energy-flow nodes, the overrides table) mutate the same document directly
  // rather than going through the schema form. Instead of making every one of them report in, re-diff
  // after any interaction with the page: the document is small, and this runs once per event burst.
  let dirtyTick      = null;
  const scheduleDirty = () => { clearTimeout(dirtyTick); dirtyTick = setTimeout(refreshDirty, 120); };
  const sections = document.getElementById('sections');
  ['change', 'input', 'click'].forEach(ev => sections?.addEventListener(ev, scheduleDirty, true));

  initTheme();
  initPalette();
  initLiveIndicator();
}

initShell();
load();

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

// Units that step by a thousand, smallest first. Only the ones where a reading realistically crosses the
// boundary: a diagram reading "6,744 W" is four digits of precision nobody asked for, while amps and volts
// stay put because 1,000 A is not a number this measures.
const UNIT_STEPS             = [
  ['W', 'kW', 'MW', 'GW'],
  ['Wh', 'kWh', 'MWh', 'GWh'],
  ['VA', 'kVA', 'MVA'],
  ['var', 'kvar', 'Mvar'],
];

/// A reading with its unit, stepped up so the number stays readable: 6744 W -> "6.74 kW".
///
/// Scaling only ever goes UP from the unit given, and only past 1,000 — a 250 W load stays in watts rather
/// than becoming "0.25 kW", and a unit with no ladder (A, V, Hz, %) is left exactly as it is. Three
/// significant figures on a scaled value: the extra digits were never meaningful at kilowatt scale, and
/// keeping them is what made the labels wide enough to crowd the diagram.
function formatMeasure(value     , units         )         {
  const u = (units || '').trim();
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${formatNum(value)} ${u}`.trim();

  const ladder = UNIT_STEPS.find(l => l.some(x => x === u));
  const start = ladder ? ladder.indexOf(u) : -1;
  if (start < 0) return `${formatNum(value)} ${u}`.trim();

  let v = value, i = start;
  while (Math.abs(v) >= 1000 && i < ladder .length - 1) { v /= 1000; i++; }
  // Unscaled values keep the caller's existing precision; a scaled one gets three significant figures.
  if (i === start) return `${formatNum(v)} ${u}`.trim();
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return `${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${ladder [i]}`;
}

// SVG element helper (separate namespace from el()).
function svgEl(tag        , attrs      )      {
  const e      = document.createElementNS('http://www.w3.org/2000/svg', tag);
  // A null or undefined attribute is left off, never written as the text "null".
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v       );
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
const restartWatchers = new Set            ();

/// Told whenever a restart is expected, so something can watch for the bridge coming back.
function onExpectRestart(fn            ) {
  restartWatchers.add(fn);
  return () => restartWatchers.delete(fn);
}

function expectRestart(why        , seconds = 150) {
  restartWhy = why;
  restartUntil = Date.now() + seconds * 1000;
  // Re-render watchers now: the drop usually lands a moment later, but the pill should change the
  // instant the action is taken, not when the socket happens to notice.
  rtStateWatchers.forEach(fn => { try { fn(rtState); } catch { /* as above */ } });
  restartWatchers.forEach(fn => { try { fn(); } catch { /* as above */ } });
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
  walk(prune(before), prune(after), [], [], out);
  return out;
}

/// What names an entry of a list of objects, for the review sheet: "Types › energy_d" rather than "Types › 2".
function entryName(entry     , index        ) {
  for (const k of ['Type', 'Id', 'Name', 'Key']) if (entry && typeof entry[k] === 'string' && entry[k]) return entry[k];
  return `#${index + 1}`;
}

// `path` matches the form's field registry (list entries by index); `label` is how the review sheet names it.
function walk(a     , b     , path          , label          , out       ) {
  if (same(a, b)) return;

  // Recurse while both sides are object-shaped (or absent), so a whole new section still reports one
  // row per setting rather than a wall of JSON.
  const objectish = (v     ) => v === undefined || isPlainObject(v);
  if ((isPlainObject(a) || isPlainObject(b)) && objectish(a) && objectish(b)) {
    const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
    for (const k of keys) walk((a || {})[k], (b || {})[k], [...path, k], [...label, k], out);
    return;
  }

  // Same length on both sides: an entry was edited in place, so report that entry's setting, not the list.
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a, ...b].every(isPlainObject)) {
    a.forEach((_     , i        ) => walk(a[i], b[i], [...path, String(i)], [...label, entryName(b[i], i)], out));
    return;
  }

  out.push({ path, label, key: pathKey(path), from: a, to: b, secret: dirtySecrets.has(pathKey(path)) });
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

/// The declared vocabulary: tags given a name and a purpose up front, whether or not anything carries them.
function declaredTags()                                           {
  const flow = (state.data || {}).EnergyFlow || {};
  return (flow.Tags || []).filter((t     ) => t && String(t.Name || '').trim());
}

/// What a tag was declared to be for, if anything said.
function tagDescription(tag        )         {
  const d = declaredTags().find(x => String(x.Name).trim().toLowerCase() === tag.trim().toLowerCase());
  return (d && d.Description) || '';
}

/// Declare a tag. Returns false when one by that name already exists — same name twice is two tags that
/// look identical and filter differently, which is the failure the whole picker exists to avoid.
function declareTag(name        , description = '')          {
  const n = (name || '').trim();
  if (!n) return false;
  const flow = (state.data || {}).EnergyFlow || ((state.data || {}).EnergyFlow = {});
  const list = flow.Tags || (flow.Tags = []);
  if (list.some((t     ) => String(t.Name || '').trim().toLowerCase() === n.toLowerCase())) return false;
  list.push({ Name: n, Description: description });
  return true;
}

/// Stop declaring a tag. What carries it is untouched — removeTag is the one that strips it off things.
function undeclareTag(name        ) {
  const flow = (state.data || {}).EnergyFlow || {};
  if (!flow.Tags) return;
  flow.Tags = flow.Tags.filter((t     ) => String(t.Name || '').trim().toLowerCase() !== name.trim().toLowerCase());
}

/// Every tag the document defines, in a stable order.
function knownTags()           {
  const seen = new Map                ();
  // Declared first: a tag defined before anything carries it has to appear in every picker, or it cannot
  // be put to use from the place it was defined.
  declaredTags().forEach(d => {
    const k = String(d.Name || '').trim();
    if (k && !seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), k);
  });
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
  declaredTags().forEach((d     ) => {
    if (String(d.Name).trim().toLowerCase() === from.trim().toLowerCase()) d.Name = to.trim();
  });
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
  undeclareTag(tag);
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
    // A datalist completes what you type and shows nothing until you do, so a tag already in use looks
    // like it has to be retyped from memory — and a second spelling of an existing tag is a filter that
    // silently matches nothing. The existing ones are offered outright, beside the box that invents new.
    if (known.length) {
      const pick = el('select', { class: 'tag-pick' })                     ;
      pick.appendChild(el('option', { value: '', text: `existing (${known.length})…` }));
      known.forEach(k => pick.appendChild(el('option', { value: k, text: k })));
      pick.onchange = () => { if (pick.value) add(pick.value); };
      wrap.appendChild(pick);
    }
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
const ADDITIVE_METRICS = new Set(['realpower', 'apparentpower', 'energy', 'energy_d', 'current']);
const isAdditiveMetric = (key         ) => ADDITIVE_METRICS.has(key || '');
const SOURCE_METRICS = METRICS.map(m => m[0]);
const metricMeta = (key         ) => METRICS.find(m => m[0] === key) || METRICS[0];
// Metrics the diagram can be drawn by but nothing can be *bound* to, so they stay out of METRICS.
const DERIVED_METRIC_LABELS                         = { energy_d: 'Energy Daily' };
const metricLabel = (key         ) => DERIVED_METRIC_LABELS[key || ''] || metricMeta(key)[1];
// The live-cache key a source reads under, given its direction.
const sourceMetricKey = (src     ) => { const m = src.Metric || 'realpower'; return src.Direction === 'in' ? m + '#in' : m; };

// What a virtual node represents — mirrors [AllowedValues] on EnergyFlowNode.Kind.
const NODE_KINDS                               = [
  ['node', 'Virtual node', SOURCE_METRICS],
  ['panel', 'Electrical panel', ['realpower', 'apparentpower', 'current', 'voltage', 'energy', 'powerfactor']],
  ['breaker', 'Breaker / circuit', ['realpower', 'apparentpower', 'current', 'voltage', 'energy', 'powerfactor']],
  ['inverter', 'Inverter', SOURCE_METRICS],
  ['battery', 'Battery', ['realpower', 'energy', 'current', 'voltage', 'soc']],
  ['solar', 'Solar / PV', ['realpower', 'energy', 'current', 'voltage']],
  ['grid', 'Grid', SOURCE_METRICS],
  ['load', 'Load', ['realpower', 'apparentpower', 'energy', 'current', 'voltage', 'powerfactor']],
];
/// A load is where power is used, so it feeds nothing; a circuit that feeds other nodes is a breaker.
const feedsNothing = (kind         ) => kind === 'load';
const kindMeta = (kind         ) => NODE_KINDS.find(k => k[0] === (kind || 'node')) || NODE_KINDS[0];

// Source binding types — mirrors [AllowedValues] on EnergyFlowSource.Type.
// The built-in source types, and their labels. A plugin's type is appended from the schema at render
// time (see sourceTypes()), so contributing one needs no edit here.
const BUILTIN_SOURCE_TYPES                     = [
  ['mqtt', 'MQTT topic'], ['modbus', 'Modbus TCP'],
  ['emoncms', 'EmonCMS feed'], ['homeassistant', 'Home Assistant entity'],
  ['derived', 'Calculated'],
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
  breaker: '#d9a55c',
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
  const { days, lines, units } = opts;
  const kind = opts.kind || 'bar';
  const stacked = opts.stacked && kind !== 'line';
  const has = (d        ) => lines.some(l => l.values[d] != null);
  const dayTotal = (d        ) => lines.reduce((s, l) => s + (l.values[d] ?? 0), 0);

  // Charge and export are negative quantities — energy leaving in the other direction.
  const posOf = (d        ) => lines.reduce((s, l) => s + Math.max(0, l.values[d] ?? 0), 0);
  const negOf = (d        ) => lines.reduce((s, l) => s + Math.min(0, l.values[d] ?? 0), 0);
  const overlay = opts.overlay;
  const overlaid = overlay ? overlay.values.filter((v)              => v != null) : [];
  const peak = opts.max ?? Math.max(
    stacked ? Math.max(...days.map((_, d) => (has(d) ? posOf(d) : 0)), 0)
      : Math.max(...lines.flatMap(l => l.values.map(v => v ?? 0)), 0),
    ...overlaid, 0);
  const trough = Math.min(
    stacked ? Math.min(...days.map((_, d) => (has(d) ? negOf(d) : 0)), 0)
      : Math.min(...lines.flatMap(l => l.values.map(v => v ?? 0)), 0),
    ...overlaid, 0);
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
    } else if (kind === 'bar') {
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

  // Lines and areas are drawn as runs of consecutive readings, so a gap breaks them instead of bridging it.
  if (kind !== 'bar') {
    const up = days.map(() => 0), down = days.map(() => 0);
    const cx = (d        ) => (x(d) + slot / 2).toFixed(1);
    lines.forEach(l => {
      const base           = [], top           = [];
      // A series with no positive reading stacks below the line, zeros included; -0 >= 0 would put them on top.
      const below = !l.values.some(v => v != null && v > 0) && l.values.some(v => v != null && v < 0);
      days.forEach((_, d) => {
        const v = l.values[d];
        if (v == null) { base.push(NaN); top.push(NaN); return; }
        const down_ = below || v < 0;
        const from = stacked ? (down_ ? down[d] : up[d]) : 0;
        base.push(from); top.push(from + v);
        if (stacked) { if (down_) down[d] = from + v; else up[d] = from + v; }
      });
      let run           = [];
      const flush = () => {
        if (run.length === 1)
          svg.appendChild(svgTag('circle', { cx: cx(run[0]), cy: y(top[run[0]]).toFixed(1), r: 2.5, fill: l.color, class: kind === 'area' ? 'trend-area' : 'trend-line' }));
        else if (run.length > 1 && kind === 'area') {
          const pts = run.map(d => `${cx(d)},${y(top[d]).toFixed(1)}`)
            .concat([...run].reverse().map(d => `${cx(d)},${y(base[d]).toFixed(1)}`));
          svg.appendChild(svgTag('polygon', { points: pts.join(' '), fill: l.color, 'fill-opacity': stacked ? 0.85 : 0.35, stroke: l.color, 'stroke-width': 1, class: 'trend-area' }));
        } else if (run.length > 1)
          svg.appendChild(svgTag('polyline', { points: run.map(d => `${cx(d)},${y(top[d]).toFixed(1)}`).join(' '), fill: 'none', stroke: l.color, 'stroke-width': 2, class: 'trend-line' }));
        run = [];
      };
      days.forEach((_, d) => { if (Number.isNaN(top[d])) flush(); else run.push(d); });
      flush();
    });
  }

  // The overlay is drawn as runs of consecutive readings, so a gap breaks the line instead of bridging it.
  if (overlay) {
    let run           = [];
    const flush = () => {
      if (run.length > 1)
        svg.appendChild(svgTag('polyline', { points: run.join(' '), fill: 'none', stroke: overlay.color, 'stroke-width': 2, class: 'trend-overlay' }));
      else if (run.length === 1) {
        const [cx, cy] = run[0].split(',');
        svg.appendChild(svgTag('circle', { cx, cy, r: 2, fill: overlay.color, class: 'trend-overlay' }));
      }
      run = [];
    };
    days.forEach((_, d) => {
      const v = overlay.values[d];
      if (v == null) flush();
      else run.push(`${(x(d) + slot / 2).toFixed(1)},${y(v).toFixed(1)}`);
    });
    flush();
  }

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
      if (overlay) {
        const v = overlay.values[d];
        c.appendChild(el('div', { class: 'nh-row' },
          el('span', { class: 'nh-name' },
            el('span', { class: 'trend-swatch', style: { background: overlay.color } }),
            `${overlay.label} (overlay)`),
          el('span', { class: 'nh-num', text: v == null ? '—' : `${formatNum(Number(v.toFixed(2)))} ${units}` })));
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
  // With a grid, the scale needs room down the left and the times need room along the bottom.
  const padL = opts.grid ? 44 : pad, padB = opts.grid ? 16 : pad;

  const known = values.filter((v)              => v != null && Number.isFinite(v));
  if (known.length < 2) {
    // One point is not a trend, and none is not a zero. Say so rather than draw a flat line through nothing.
    const empty = el('div', { class: 'spark spark-empty', text: known.length ? '—' : '' });
    empty.title = known.length ? 'Only one reading in this window' : 'No readings stored for this window';
    return empty;
  }

  const lo = Math.min(...known, 0), hi = Math.max(...known);
  const span = hi - lo || 1;
  const x = (i        ) => padL + (values.length === 1 ? 0 : (i * (w - padL - pad)) / (values.length - 1));
  const y = (v        ) => h - padB - ((v - lo) / span) * (h - padB - pad);

  const svg = svgTag('svg', {
    viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'spark' + (opts.grid ? ' spark-gridded' : ''),
    // A stretched strip is fine for a bare line, but it would stretch the grid's labels with it.
    preserveAspectRatio: opts.grid ? 'xMidYMid meet' : 'none', role: 'img',
    'aria-label': `Trend: ${formatNum(known[0])} to ${formatNum(known[known.length - 1])} ${units}`,
  });

  // A light grid, drawn first so it sits behind the line: the scale down the side, the time along the bottom.
  if (opts.grid) {
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = lo + (span / ticks) * i, yy = y(v);
      svg.appendChild(svgTag('line', { x1: padL, y1: yy, x2: w - pad, y2: yy, class: 'spark-grid' }));
      const label = svgTag('text', { x: padL - 6, y: yy + 3, 'text-anchor': 'end', class: 'spark-axis' });
      // Units on the top line only: repeating them down the side says nothing five times.
      label.textContent = formatNum(Number(v.toFixed(hi < 10 ? 2 : 0))) + (i === ticks && units ? ' ' + units : '');
      svg.appendChild(label);
    }
    const steps = 4;
    for (let i = 1; i < steps && opts.at; i++) {
      const idx = Math.round(((values.length - 1) * i) / steps), xx = x(idx);
      svg.appendChild(svgTag('line', { x1: xx, y1: pad, x2: xx, y2: h - padB, class: 'spark-grid' }));
      const when = svgTag('text', { x: xx, y: h - 4, 'text-anchor': 'middle', class: 'spark-axis' });
      when.textContent = opts.at(idx);
      svg.appendChild(when);
    }
  }

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

  // Where the pointer is, drawn on the chart: a line down through it and a dot on the reading it names, so
  // the card's figure is tied to a place rather than left to be found.
  const cross = svgTag('line', { class: 'spark-cross', x1: 0, x2: 0, y1: pad, y2: h - padB, visibility: 'hidden' });
  const cursor = svgTag('circle', { class: 'spark-cursor', cx: 0, cy: 0, r: 3, fill: color, visibility: 'hidden' });
  svg.appendChild(cross);
  svg.appendChild(cursor);

  // The hover layer. The plot is 40px tall, so the target is the whole strip and the nearest point wins —
  // asking someone to hit a 2px line with a mouse is asking them not to bother.
  const hit = svgTag('rect', { x: 0, y: 0, width: w, height: h, fill: 'transparent', class: 'spark-hit' });
  svg.appendChild(hit);
  hit.addEventListener('mousemove', (ev     ) => {
    const box = svg.getBoundingClientRect?.() ?? { left: 0, width: w };
    // The pointer, in the chart's own coordinates, then measured across the plot rather than the whole box:
    // with a grid the plot starts past the scale down the side, and ignoring that slid every position right,
    // by the width of that gutter at the left and by nothing at all at the right.
    const scale = box.width ? box.width / w : 1;
    const px = (ev.clientX - box.left) / scale;
    const frac = (px - padL) / Math.max(1, w - padL - pad);
    const i = Math.max(0, Math.min(values.length - 1, Math.round(frac * (values.length - 1))));
    const v = values[i];
    const c = hoverCard();
    c.innerHTML = '';
    c.appendChild(el('div', { class: 'nc-title', text: opts.at ? opts.at(i) : `Point ${i + 1}` }));
    c.appendChild(el('div', { text: v == null ? 'no reading' : `${formatNum(v)} ${units}` }));
    c.classList.add('show');
    c.style.left = `${ev.clientX + 12}px`;
    c.style.top = `${ev.clientY + 12}px`;

    const at = x(i);
    cross.setAttribute('x1', String(at));
    cross.setAttribute('x2', String(at));
    cross.setAttribute('visibility', 'visible');
    // A moment with no reading has nowhere to put the dot; the line still says where you are.
    if (v == null) cursor.setAttribute('visibility', 'hidden');
    else {
      cursor.setAttribute('cx', String(at));
      cursor.setAttribute('cy', String(y(v)));
      cursor.setAttribute('visibility', 'visible');
    }
  });
  hit.addEventListener('mouseleave', () => {
    hideCard();
    cross.setAttribute('visibility', 'hidden');
    cursor.setAttribute('visibility', 'hidden');
  });

  return svg;
}

/// A ranking: one horizontal bar per item, largest first, labelled with its value and an optional note.
function rankChart(opts

 )                             {
  const items = opts.items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  const total = items.reduce((s, i) => s + i.value, 0);
  const W = opts.fitTo && opts.fitTo > 0 ? Math.max(420, opts.fitTo) : 720;
  const rowH = 22, padT = 8;
  const ring = opts.share && total > 0 ? 180 : 0;
  const H = Math.max(ring, padT * 2 + items.length * rowH);
  const svg = svgTag('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'trend-chart trend-rank' });
  const pct = (v        ) => `${(v / total * 100).toFixed(1)}%`;
  const titled = (node     , text        ) => {
    const t = document.createElementNS(SVG, 'title');
    t.textContent = text;
    node.appendChild(t);
    return node;
  };
  const describe = (it                      ) =>
    `${it.label}: ${formatNum(Number(it.value.toFixed(2)))} ${opts.units}${opts.share ? ` · ${pct(it.value)}` : ''}${it.note ? ` · ${it.note}` : ''}`;

  if (ring) {
    const cx = ring / 2, cy = H / 2, r = 70, inner = 42;
    const at = (rad        , a        ) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`;
    let angle = -Math.PI / 2;
    items.forEach(it => {
      const frac = it.value / total;
      // A whole ring cannot be drawn as one arc, so it is two circles instead.
      if (frac >= 0.9999) {
        svg.appendChild(titled(svgTag('circle', { cx, cy, r: (r + inner) / 2, fill: 'none', stroke: it.color, 'stroke-width': r - inner, class: 'trend-slice' }), describe(it)));
        return;
      }
      const end = angle + frac * 2 * Math.PI;
      const large = frac > 0.5 ? 1 : 0;
      const d = `M ${at(r, angle)} A ${r} ${r} 0 ${large} 1 ${at(r, end)} L ${at(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${at(inner, angle)} Z`;
      svg.appendChild(titled(svgTag('path', { d, fill: it.color, class: 'trend-slice' }), describe(it)));
      angle = end;
    });
  }

  const x0 = ring + 160, valueW = 190;
  const barMax = Math.max(40, W - x0 - valueW - 8);
  const top = items.length ? items[0].value : 1;
  items.forEach((it, i) => {
    const yy = padT + i * rowH;
    const name = svgTag('text', { x: x0 - 8, y: yy + 15, 'text-anchor': 'end', fill: 'var(--fg)', 'font-size': 12 });
    name.textContent = it.label.length > 24 ? it.label.slice(0, 23) + '…' : it.label;
    svg.appendChild(name);
    const w = Math.max(1, (it.value / top) * barMax);
    svg.appendChild(titled(svgTag('rect', { x: x0, y: yy + 4, width: w, height: rowH - 8, fill: it.color, class: 'trend-rank-bar' }), describe(it)));
    const value = svgTag('text', { x: x0 + w + 6, y: yy + 15, fill: 'var(--muted)', 'font-size': 11 });
    value.textContent = `${formatNum(Number(it.value.toFixed(2)))} ${opts.units}${opts.share ? ` · ${pct(it.value)}` : ''}${it.note ? ` · ${it.note}` : ''}`;
    svg.appendChild(value);
  });
  return { svg, gaps: 0 };
}

// ── context-menu.ts ─────────────────────────────────────────────
// The little menu a right-click opens, positioned inside the box it was aimed at. The floor plan and the
// flow diagram both use it; each keeps its own class so its own styling still applies.

/// A menu element to append to `host` (which must be positioned), and the two calls that work it. The host
/// may be given as a function, for a box built after the menu it holds.
function makeMenu(host     , cls = 'ctx-menu', onClose             ) {
  const menu = el('div', { class: cls });
  menu.hidden = true;
  const close = () => { if (!menu.hidden) { menu.hidden = true; menu.innerHTML = ''; onClose?.(); } };
  // Escape is how a menu is dismissed everywhere else, so it is how this one is dismissed too, and a click
  // anywhere but inside it is the other way out — including on the page around the box it was opened over.
  document.addEventListener('keydown', (e     ) => { if (e.key === 'Escape' && !menu.hidden) close(); });
  document.addEventListener('mousedown', (e     ) => {
    if (!menu.hidden && !(menu.contains?.(e?.target) ?? false)) close();
  });
  const open = (e     , entries                                          ) => {
    menu.innerHTML = '';
    const rows = entries.filter(Boolean)               ;
    rows.forEach(x => {
      if (x.head) { menu.appendChild(el('div', { class: `${cls}-head`, text: x.label })); return; }
      const b = el('button', { class: `${cls}-item` + (x.danger ? ' is-danger' : ''), type: 'button', text: x.label });
      b.disabled = !!x.disabled;
      b.onclick = () => { close(); x.run?.(); };
      menu.appendChild(b);
    });
    // Kept inside the box: a menu opened near an edge would otherwise hang off it.
    const box = typeof host === 'function' ? host() : host;
    const r = box?.getBoundingClientRect?.() || { left: 0, top: 0, width: 800, height: 600 };
    const x = Math.max(4, Math.min((e.clientX ?? 0) - r.left, r.width - 230));
    const y = Math.max(4, Math.min((e.clientY ?? 0) - r.top, Math.max(4, r.height - 40 - rows.length * 34)));
    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;
    menu.hidden = false;
  };
  return { el: menu, open, close, isOpen: () => !menu.hidden };
}

// ── history-sheet.ts ────────────────────────────────────────────
// What a node has been drawing, in a sheet: the panel schedule opens it for a breaker, the flow diagram for
// whatever was right-clicked. One line, summed from the nodes asked for — a moment where any of them has no
// reading is a gap in the line, never a partial sum.

/// Windows worth asking about, and how finely each is sampled.
const HISTORY_WINDOWS                     = [
  ['minutes=60&step=30', 'Last hour'],
  ['minutes=360&step=60', 'Last 6 hours'],
  ['minutes=1440&step=900', 'Last 24 hours'],
  ['days=7&step=3600', 'Last 7 days'],
  ['days=30&step=21600', 'Last 30 days'],
];
/// The window a sheet opens on when nobody has picked one yet.
const HISTORY_DEFAULT = 'minutes=1440&step=900';
/// The measurements a reading can be asked for in, and what each is called.
const HISTORY_METRICS                     = [
  ['realpower', 'Power (W)'],
  ['current', 'Current (A)'],
  ['apparentpower', 'Apparent (VA)'],
  ['energy_d', 'Energy today (kWh)'],
];
/// The last window picked, kept per browser: the same question tends to be asked over the same span.
const WINDOW_KEY = 'rpdu2mqtt.history.window';
const rememberedWindow = () => {
  try { const v = localStorage.getItem(WINDOW_KEY); return HISTORY_WINDOWS.some(([q]) => q === v) ? v  : HISTORY_DEFAULT; }
  catch { return HISTORY_DEFAULT; }
};

                                                                           

/// Open the history of one or more nodes, over a window picked in the sheet.
function openHistorySheet(o                ) {
  const nodes = o.nodes.filter(Boolean);
  const labelOf = o.labelOf || ((id        ) => id);
  const metric = o.metric || 'realpower';
  const plot = el('div', { class: 'ps-chart' });
  const legend = el('div', { class: 'ld-toolbar ps-legend', style: { flexWrap: 'wrap', gap: '10px' } });
  const note = el('div', { class: 'desc' });
  const breakdown = el('div', { class: 'hs-parts' });
  // A part that is the whole is not a breakdown; two legs summed into one line are.
  const parts = (o.parts || []).filter(id => id && !(nodes.length === 1 && nodes[0] === id));
  let window = rememberedWindow();
  let metricNow = metric;

  const load = async () => {
    if (!nodes.length) {
      plot.innerHTML = '';
      note.textContent = o.empty || 'Nothing is measuring this, so there is nothing to chart.';
      return;
    }
    plot.innerHTML = '';
    note.textContent = 'Reading…';
    let r     ;
    try { r = await api(`/api/flow/series?${window}&metric=${metricNow}`); }
    catch (e     ) { r = { body: { ok: false, message: e?.message || 'the request failed' } }; }
    const body = r?.body;
    if (!body?.ok) { note.textContent = body?.message || 'Could not read the history.'; return; }
    const all = body.series || [];
    const series = all.filter((s     ) => nodes.includes(s.node));
    if (!series.length) { note.textContent = `The history backend holds nothing for ${nodes.join(', ')} in this window.`; return; }
    // A node with no reading at some moment leaves the total unknown then, exactly as its power is.
    const at           = body.at || [];
    const values = at.map((_, i) => {
      let total = 0;
      for (const s of series) { const v = s.values?.[i]; if (v == null) return null; total += v; }
      return total                 ;
    });
    const known = values.filter((v)              => v != null);
    const units = body.units || 'W';
    // What the line is, and what it is summed from.
    legend.innerHTML = '';
    legend.appendChild(el('span', { class: 'desc', style: { margin: '0' } },
      el('span', { class: 'trend-swatch', style: { background: 'var(--accent)' } }), o.lineLabel));
    if (nodes.length > 1 || nodes[0] !== o.lineLabel)
      nodes.forEach(id => legend.appendChild(el('span', { class: 'desc', style: { margin: '0' } }, `${labelOf(id)} (${id})`)));
    plot.appendChild(sparkline({
      values, color: 'var(--accent)', units, width: 560, height: 160, grid: true,
      at: (i        ) => at[i] ? new Date(at[i]).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '',
    }));
    const when = (i        ) => (at[i] ? new Date(at[i]).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    const peak = known.length ? Math.max(...known) : null;
    const peakAt = peak == null ? '' : when(values.findIndex(v => v === peak));
    const last = [...values].reverse().find(v => v != null);
    note.textContent = known.length
      ? `${known.length} of ${values.length} readings · peak ${Math.round(peak ).toLocaleString('en-US')} ${units}`
        + `${peakAt ? ` at ${peakAt}` : ''} · average ${Math.round(known.reduce((a, v) => a + v, 0) / known.length).toLocaleString('en-US')} ${units}`
        + `${last == null ? '' : ` · latest ${Math.round(last).toLocaleString('en-US')} ${units}`} · from ${nodes.join(' + ')}`
      : `No readings stored for ${nodes.join(', ')} in this window.`;

    // What the total is made of, each on a strip of its own over the same window and the same reading.
    breakdown.innerHTML = '';
    if (!parts.length) return;
    const held = parts.map(id => ({ id, s: all.find((x     ) => x.node === id) })).filter(x => x.s);
    if (!held.length) {
      breakdown.appendChild(el('div', { class: 'desc', text: `Nothing is stored for what ${o.lineLabel} is made of in this window.` }));
      return;
    }
    breakdown.appendChild(el('div', { class: 'hs-parts-head', text: o.partsLabel || 'What it is made of' }));
    // Ordered by what each drew, so the biggest part of the total is first.
    held.map(({ id, s }) => {
      const vs                    = (s.values || []).map((v     ) => (typeof v === 'number' ? v : null));
      const seen = vs.filter((v)              => v != null);
      return { id, label: s.label || labelOf(id), vs, latest: [...vs].reverse().find(v => v != null) ?? null, avg: seen.length ? seen.reduce((a, v) => a + v, 0) / seen.length : null };
    }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1)).forEach(part => {
      const row = el('div', { class: 'hs-part' });
      row.dataset.node = part.id;
      row.appendChild(el('span', { class: 'hs-part-name', text: part.label, title: part.id }));
      row.appendChild(sparkline({ values: part.vs, color: 'var(--accent)', units, width: 132, height: 34 }));
      // A part with no reading says so: it is not nothing, it is unknown.
      row.appendChild(el('span', { class: 'hs-part-num', text: part.latest == null ? 'no data' : `${Math.round(part.latest).toLocaleString('en-US')} ${units}` }));
      breakdown.appendChild(row);
    });
  };

  const picker = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  const buttons = HISTORY_WINDOWS.map(([q, label]) => {
    const b = btn(label);
    b.onclick = () => {
      window = q;
      try { localStorage.setItem(WINDOW_KEY, q); } catch { /* a browser that keeps nothing still charts */ }
      buttons.forEach(x => x.classList.remove('primary'));
      b.classList.add('primary');
      load();
    };
    picker.appendChild(b);
    return b;
  });
  const markWindow = () => buttons.forEach((b, i) => b.classList.toggle('primary', HISTORY_WINDOWS[i][0] === window));
  markWindow();
  // The same reading, asked for in another measurement: watts, amps, or the energy behind them.
  const metricSel = el('select', { class: 'hs-metric', title: 'Which measurement to chart.' })                     ;
  HISTORY_METRICS.forEach(([v, t]) => metricSel.appendChild(el('option', { value: v, text: t })));
  if (!HISTORY_METRICS.some(([v]) => v === metricNow)) metricSel.appendChild(el('option', { value: metricNow, text: metricNow }));
  metricSel.value = metricNow;
  metricSel.onchange = () => { metricNow = metricSel.value; load(); };
  picker.appendChild(el('label', { class: 'ld-inst' }, 'Show ', metricSel));

  // The node itself is a thing of its own — its bindings and its label live on the Nodes page.
  const toNode = btn('Edit node');
  toNode.hidden = !nodes.length || o.editNode === false;
  toNode.title = nodes.length ? `Open ${labelOf(nodes[0])} (${nodes[0]}) in the node editor.` : '';
  toNode.onclick = () => {
    closeSheet();
    editNodeOnNextOpen(nodes[0]);
    (Array.from(document.querySelectorAll('nav a'))         ).find(a => a.dataset.label === 'Nodes')?.click();
  };
  openSheet({
    title: o.title,
    body: el('div', {}, picker, plot, legend, note, breakdown),
    footer: [toNode, ...(o.footer || [])],
  });
  load();
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

// ── ribbons.ts ──────────────────────────────────────────────────
// How a ribbon gets from one bar to the next.
//
// A ribbon is a filled band, not a stroked line: it has a thickness that means something (the value), and
// the animated stream clips against its outline. So each routing has to produce a closed outline rather
// than a centre line — which is also why this is worth having on its own, testable, away from the 600-line
// render.
//
// Every routing here obeys the same contract: the band leaves the source bar at x1 spanning
// [sTop, sTop + h], and arrives at the target bar at x2 spanning [tTop, tTop + h]. Whatever happens in
// between is the routing's business.

/// One ribbon's geometry: where it starts, where it ends, and how thick it is.

const r2 = (n        ) => Math.round(n * 100) / 100;

/// The closed outline of a ribbon, as an SVG path.
function ribbonOutline(style             , b      )         {
  switch (style) {
    case 'ortho': return orthoBand(b, 0);
    case 'ortho-round': return orthoBand(b, cornerRadius(b));
    default: return curvedBand(b);
  }
}

/// The line a stream of particles travels down the middle of the band, at fraction `f` across it.
///
/// It has to follow the same route as the outline or the particles swim outside their own ribbon — the
/// stream is clipped to the band, so a mismatched lane simply disappears where it leaves.
function lanePath(style             , b      , f        )         {
  const sY = b.sTop + b.h * f, tY = b.tTop + b.h * f;
  if (style === 'curved') {
    const xc = (b.x1 + b.x2) / 2;
    return `M${r2(b.x1)},${r2(sY)} C${r2(xc)},${r2(sY)} ${r2(xc)},${r2(tY)} ${r2(b.x2)},${r2(tY)}`;
  }
  // The grid routings share one elbow; a lane runs down the middle of it at its own offset.
  const xc = elbowX(b);
  const r = style === 'ortho-round' ? Math.min(cornerRadius(b), Math.abs(tY - sY) / 2) : 0;
  return polyline([[b.x1, sY], [xc, sY], [xc, tY], [b.x2, tY]], r);
}

/// The original: one smooth band from source to target.
function curvedBand({ x1, sTop, x2, tTop, h }      )         {
  const xc = (x1 + x2) / 2;
  return `M${r2(x1)},${r2(sTop)} C${r2(xc)},${r2(sTop)} ${r2(xc)},${r2(tTop)} ${r2(x2)},${r2(tTop)} `
       + `L${r2(x2)},${r2(tTop + h)} C${r2(xc)},${r2(tTop + h)} ${r2(xc)},${r2(sTop + h)} ${r2(x1)},${r2(sTop + h)} Z`;
}

/// How wide the vertical run is.
///
/// It wants to be the band's own thickness — that is what makes the turn constant-width, and it is right
/// whenever there is room. There often is not: a 4.6 kW band is 324px thick in a 163px column gap, and a
/// run that wide cannot sit between the two bars at all. It is capped to most of the corridor, so a very
/// thick ribbon pinches at its turn rather than hanging out of the side of a panel.
function runWidth(b      )         {
  if (b.laneW != null) return Math.max(1.5, b.laneW);
  return Math.max(1.5, Math.min(b.h, (b.x2 - b.x1) * 0.8));
}

/// Where the vertical run sits: mid-corridor, pulled in far enough that the whole run fits between the bars.
function elbowX(b      )         {
  const half = runWidth(b) / 2;
  const mid = b.laneX ?? (b.x1 + b.x2) / 2;
  return Math.min(Math.max(mid, b.x1 + half), b.x2 - half);
}

/// How much corner to round: as much as the turn and the runs allow, which on a long gentle turn is a lot.
///
/// The two corners share the vertical run between them, so neither may take more than half of it. The
/// horizontal runs either side are theirs alone.
function cornerRadius(b      )         {
  const drop = Math.abs(b.tTop - b.sTop);
  const half = runWidth(b) / 2;
  const xc = elbowX(b);
  return Math.max(0, Math.min(drop / 2, xc - half - b.x1, b.x2 - xc - half));
}

/// A band routed out, across and back in — two bends a side, never more.
///
/// The two edges turn on opposite sides of the vertical run, a run's width apart, which is what gives the
/// turn its thickness. Which edge takes which side depends on the direction of travel: put both on the
/// same side and the outline crosses itself and the ribbon renders as a bow tie; put them on the same x
/// and the run has no width at all, so a long drop draws as two rectangles with nothing joining them.
function orthoBand(b      , r        )         {
  const { x1, sTop, x2, tTop, h } = b;

  // Nothing to step over: a straight band, which is what the eye expects anyway.
  if (Math.abs(tTop - sTop) <= 1)
    return `M${r2(x1)},${r2(sTop)} L${r2(x2)},${r2(tTop)} L${r2(x2)},${r2(tTop + h)} L${r2(x1)},${r2(sTop + h)} Z`;

  const xc = elbowX(b), half = runWidth(b) / 2;
  const down = tTop > sTop ? 1 : -1;
  const nearX = xc + down * half, farX = xc - down * half;

  const upper = polyline([[x1, sTop], [nearX, sTop], [nearX, tTop], [x2, tTop]], r);
  const lower = polyline([[x2, tTop + h], [farX, tTop + h], [farX, sTop + h], [x1, sTop + h]], r);
  // The two sides, joined by the flat caps that sit against each bar.
  return `${upper} L${r2(x2)},${r2(tTop + h)} ${lower.replace(/^M/, 'L')} Z`;
}

/// A polyline of right-angle turns, with each corner optionally rounded by `r`.
///
/// Rounding is per corner and never eats more than half of either leg, so a short run keeps a sharp turn
/// rather than collapsing into a curve that overshoots the next one.
function polyline(pts            , r        )         {
  let d = `M${r2(pts[0][0])},${r2(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py), outLen = Math.hypot(nx - cx, ny - cy);
    // A leg shared with the next corner can only give up half of itself. The first and last legs end at a
    // bar rather than at another corner, so they can give more — but not everything: a corner that eats a
    // whole leg leaves no straight run at all and the ribbon reads as one continuous bend rather than a
    // line with rounded corners. Three fifths keeps the curve generous and the line still a line.
    const inBudget = i === 1 ? inLen * 0.6 : inLen / 2;
    const outBudget = i === pts.length - 2 ? outLen * 0.6 : outLen / 2;
    const rr = Math.min(r, inBudget, outBudget);
    if (rr <= 0.5) { d += ` L${r2(cx)},${r2(cy)}`; continue; }
    const ax = cx - ((cx - px) / inLen) * rr, ay = cy - ((cy - py) / inLen) * rr;
    const bx = cx + ((nx - cx) / outLen) * rr, by = cy + ((ny - cy) / outLen) * rr;
    d += ` L${r2(ax)},${r2(ay)} Q${r2(cx)},${r2(cy)} ${r2(bx)},${r2(by)}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${r2(last[0])},${r2(last[1])}`;
}

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

/// Hide the nodes nothing measures. Off by default: a node with no data is a gap in the model, and surfacing
/// those is what this diagram is for — but once the gaps are known, a column of them is only clutter.
let hideNoData = (() => { try { return localStorage.getItem('rpdu-flow-hide-no-data') === '1'; } catch { return false; } })();

function setHideNoData(on         ) {
  hideNoData = on;
  try { localStorage.setItem('rpdu-flow-hide-no-data', on ? '1' : '0'); } catch { /* private mode: this session only */ }
}

/// Drop nodes with no data when nothing downstream of them has data either, and say how many went.
///
/// The test is downstream, as it is for empty branches: a panel nothing meters, above circuits that are
/// metered, stays — removing it would cut the measured circuits off from everything that feeds them.
function applyHideNoDataPref(nodes       , links       )                                                 {
  if (!hideNoData) return { nodes, links, hidden: 0 };

  const byId = new Map             (nodes.map((n     ) => [n.id, n]));
  const out = new Map                  ();
  links.forEach((l     ) => out.set(l.source, [...(out.get(l.source) || []), l.target]));

  // Memoised, and cycle-safe: a node in progress answers false rather than recursing into itself.
  const reachesData = new Map                 ();
  const walking = new Set        ();
  const feedsData = (id        )          => {
    if (reachesData.has(id)) return reachesData.get(id) ;
    if (walking.has(id)) return false;
    walking.add(id);
    const answer = (out.get(id) || []).some(t => byId.get(t)?.value != null || feedsData(t));
    walking.delete(id);
    reachesData.set(id, answer);
    return answer;
  };

  const keep = (id        ) => byId.has(id) && (byId.get(id).value != null || feedsData(id));
  const kept = nodes.filter((n     ) => keep(n.id));
  return {
    nodes: kept,
    links: links.filter((l     ) => keep(l.source) && keep(l.target)),
    hidden: nodes.length - kept.length,
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

/// How the ribbons are routed between bars.
///
/// The default is the curved band this diagram has always drawn. The other two route on a grid instead:
/// out horizontally, one vertical run, back in horizontally — at most two bends, never a staircase. On a
/// dense hierarchy that reads more like a wiring diagram than a river, which is easier to follow when what
/// you want to know is which circuit goes where rather than how much is moving.

const RIBBON_KEY = 'rpdu-flow-ribbon';
const RIBBON_STYLES                                  = [
  ['curved', 'Curved ribbons', 'The default: each ribbon sweeps from source to target as one smooth band.'],
  ['ortho', 'Right angles', 'Route on a grid — out, across, in. Two bends at most, so a ribbon never staircases.'],
  ['ortho-round', 'Rounded angles', 'The same grid routing, with the corners rounded as far as the turn allows.'],
];

let ribbonStyle              = (() => {
  try {
    const v = localStorage.getItem(RIBBON_KEY);
    return RIBBON_STYLES.some(([id]) => id === v) ? v                : 'curved';
  } catch { return 'curved'; }
})();

function setRibbonStyle(v             ) {
  ribbonStyle = v;
  try { localStorage.setItem(RIBBON_KEY, v); } catch { /* private mode: this session only */ }
}

/// The routing picker, beside the other switches that change how the diagram is drawn.
function ribbonStyleSelect(onChange            )              {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px' },
    title: 'How ribbons are routed between nodes. A view setting only — it changes nothing about the values.',
  });
  const sel      = el('select', { style: { width: 'auto' } });
  RIBBON_STYLES.forEach(([id, label, why]) => {
    const opt = el('option', { value: id, text: label });
    opt.title = why;
    sel.appendChild(opt);
  });
  sel.value = ribbonStyle;
  sel.onchange = () => { setRibbonStyle(sel.value); onChange(); };
  lbl.append(document.createTextNode('Routing'), sel);
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
    row.appendChild(hideNoDataToggle(onToggle));
    row.appendChild(unmeasuredToggle(onToggle));
    row.appendChild(animateToggle(onToggle));
    row.appendChild(ribbonStyleSelect(onToggle));
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

/// The "Hide no data" view switch. Per-viewer, like the others here.
function hideNoDataToggle(onToggle            )              {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
    title: 'Hide nodes nothing measures, and the branches under them that have no data either. A node with no '
      + 'data that feeds a measured one stays, so nothing measured is cut off. How many were hidden is shown '
      + 'beside the node count. A view setting only; no total changes.',
  });
  const cb      = el('input', { type: 'checkbox' });
  cb.checked = hideNoData;
  cb.onchange = () => { setHideNoData(cb.checked); onToggle(); };
  lbl.append(cb, document.createTextNode('Hide no data'));
  return lbl;
}

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

// ── circuit-finder.ts ───────────────────────────────────────────
// Which circuit is this load on? Switch the load itself on and off, and watch which channel steps with it.
// The maths only: what each toggle did to every channel, and which of them is still in the running (#471).

/// One settled state of the load, and what each channel read on average while it lasted.

/// A channel still in the running: how many toggles it followed, and by how much.

                                               

/// The smallest step worth calling a change, in watts. Below this a channel's own noise answers for it.
const NOISE_FLOOR = 5;

const median = (xs          ) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/// A load's own draw is the step to expect; without it, anything above the noise floor counts.
const bounds = (watts                ) => watts && watts > 0
  ? { least: Math.max(NOISE_FLOOR, 0.4 * watts), most: 2.5 * watts }
  : { least: NOISE_FLOOR, most: Infinity };

/// Two channels stepping by roughly the same amount are the two legs of one 240 V breaker.
const paired = (a           , b           ) => Math.abs(a.step - b.step) <= 0.3 * Math.max(a.step, b.step);

function analyse(levels         , opts                                                             = {})          {
  const labels = opts.labels || {};
  const { least, most } = bounds(opts.watts);
  const toggles = Math.max(0, levels.length - 1);
  const steps                           = {};
  const misses                         = {};

  for (let i = 1; i < levels.length; i++) {
    // On should raise a channel and off should lower it; a change the other way is not this load.
    const want = levels[i].on ? 1 : -1;
    const nodes = new Set([...Object.keys(levels[i - 1].mean), ...Object.keys(levels[i].mean)]);
    nodes.forEach(node => {
      const before = levels[i - 1].mean[node], after = levels[i].mean[node];
      if (before == null || after == null) return;
      const step = want * (after - before);
      if (step >= least && step <= most) (steps[node] ||= []).push(step);
      else misses[node] = (misses[node] || 0) + 1;
    });
  }

  const candidates              = Object.entries(steps)
    .map(([node, seen]) => ({ node, label: labels[node] || node, matched: seen.length, step: median(seen), missed: misses[node] || 0 }))
    .sort((a, b) => b.matched - a.matched || b.step - a.step);

  const found = candidates.filter(c => c.matched === toggles && toggles > 0);
  // One channel that followed every toggle is the answer; two that also step together are one 240 V breaker.
  const legs = found.length === 2 && paired(found[0], found[1]);
  const done = toggles >= 2 && (found.length === 1 || legs);

  return { toggles, candidates, found, done, verdict: verdictOf(toggles, candidates, found, done, legs, opts.watts) };
}

const watts = (w        ) => `${Math.round(w).toLocaleString('en-US')} W`;

function verdictOf(toggles        , candidates             , found             , done         , legs         , load                )         {
  if (!toggles) return 'Switch the load, then tap again — the first toggle has nothing to compare against yet.';
  if (done && legs) return `Both legs of a 240 V breaker: ${found[0].label} and ${found[1].label}, stepping ${watts(found[0].step)} each.`;
  if (done) return `${found[0].label} — it followed all ${toggles} toggles, stepping ${watts(found[0].step)}.`;
  if (!candidates.length) {
    return load
      ? `Nothing stepped by about ${watts(load)}. Check the load really switched, or clear the expected draw and keep toggling.`
      : 'No channel stepped with that toggle. A small load can hide in one toggle\'s noise — keep toggling.';
  }
  if (!found.length) return `Nothing has followed every toggle yet. ${candidates[0].label} is closest, at ${candidates[0].matched} of ${toggles}. Keep toggling.`;
  const more = toggles < 2 ? 1 : found.length > 2 ? 2 : 1;
  return `${found.length} channels still match all ${toggles} toggles: ${found.slice(0, 3).map(c => c.label).join(', ')}. `
    + `${more} more toggle${more > 1 ? 's' : ''} should separate them.`;
}

// ── plan-geometry.ts ────────────────────────────────────────────
// Floor plan geometry (#463): outlines as point lists in the floor's drawing units, and the snapping that lets
// rooms meet edge to edge without a CAD tool's precision.

/// A rectangle drawn corner to corner, as the four-point outline a room is stored as.
function planRect(a    , b    )       {
  const x1 = Math.min(a.X, b.X), x2 = Math.max(a.X, b.X), y1 = Math.min(a.Y, b.Y), y2 = Math.max(a.Y, b.Y);
  return [{ X: x1, Y: y1 }, { X: x2, Y: y1 }, { X: x2, Y: y2 }, { X: x1, Y: y2 }];
}

/// Signed area by the shoelace formula; its magnitude is the outline's area.
function planArea(poly      )         {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.X * b.Y - b.X * a.Y;
  }
  return s / 2;
}

/// Where a label sits: the area-weighted centre, or the average of the points for a degenerate outline.
function planCentroid(poly      )     {
  if (!poly.length) return { X: 0, Y: 0 };
  const a = planArea(poly);
  if (Math.abs(a) < 1e-9) return { X: poly.reduce((s, p) => s + p.X, 0) / poly.length, Y: poly.reduce((s, p) => s + p.Y, 0) / poly.length };
  let cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p.X * q.Y - q.X * p.Y;
    cx += (p.X + q.X) * f;
    cy += (p.Y + q.Y) * f;
  }
  return { X: cx / (6 * a), Y: cy / (6 * a) };
}

/// Is a point inside an outline? Even-odd ray casting; a point on an edge may land either side.
function planContains(poly      , p    )          {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.Y > p.Y) !== (b.Y > p.Y) && p.X < ((b.X - a.X) * (p.Y - a.Y)) / (b.Y - a.Y) + a.X) inside = !inside;
  }
  return inside;
}

/// The smallest of the outlines holding a point, so a point in a closet inside a bedroom is in the closet.
function planShapeAt                            (shapes     , p    )           {
  let best           = null, bestArea = Infinity;
  for (const s of shapes) {
    const poly = s.Shape || [];
    if (poly.length < 3 || !planContains(poly, p)) continue;
    const a = Math.abs(planArea(poly));
    if (a < bestArea) { best = s; bestArea = a; }
  }
  return best;
}

/// The nearest point to p on the segment a–b.
function planNearestOnSegment(p    , a    , b    )     {
  const dx = b.X - a.X, dy = b.Y - a.Y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / len)) : 0;
  return { X: a.X + t * dx, Y: a.Y + t * dy };
}

const planDist = (a    , b    ) => Math.hypot(a.X - b.X, a.Y - b.Y);

/// Where a point lands once snapped: onto another outline's corner, else its edge, else the grid. Corners win
/// over edges so two rooms drawn side by side share their corners exactly.
function planSnap(p    , others        , threshold        , grid = 0)                                                      {
  let best            = null, bestD = threshold;
  for (const poly of others) for (const v of poly) {
    const d = planDist(p, v);
    if (d <= bestD) { best = v; bestD = d; }
  }
  if (best) return { pt: { X: best.X, Y: best.Y }, to: 'corner' };
  bestD = threshold;
  for (const poly of others) for (let i = 0; i < poly.length; i++) {
    const q = planNearestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    const d = planDist(p, q);
    if (d <= bestD) { best = q; bestD = d; }
  }
  if (best) return { pt: best, to: 'edge' };
  if (grid > 0) return { pt: { X: Math.round(p.X / grid) * grid, Y: Math.round(p.Y / grid) * grid }, to: 'grid' };
  return { pt: { X: p.X, Y: p.Y }, to: 'none' };
}

/// An outline moved by an offset.
function planMove(poly      , dx        , dy        )       {
  return poly.map(p => ({ X: p.X + dx, Y: p.Y + dy }));
}

/// A number rounded to a tenth of a unit, so a saved outline does not carry fifteen decimal places.
function planRound(v        )         { return Math.round(v * 10) / 10; }

/// An outline kept inside the floor: every point clamped to 0..w, 0..h and rounded.
function planClamp(poly      , w        , h        )       {
  return poly.map(p => ({ X: planRound(Math.max(0, Math.min(w, p.X))), Y: planRound(Math.max(0, Math.min(h, p.Y))) }));
}

/// The value scale for shading: 0 to the largest known value, never 0 to 0.
function planScaleMax(values                               )         {
  const known = values.filter((v)              => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return known.length ? Math.max(...known) : 0;
}

/// The wall nearest a point: where on it, its direction in degrees, and how far away it is.
function planNearestWall(p    , outlines        )                                                 {
  let best                                                 = null;
  for (const poly of outlines) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const q = planNearestOnSegment(p, a, b);
    const d = Math.hypot(p.X - q.X, p.Y - q.Y);
    if (!best || d < best.dist) best = { pt: q, angle: Math.atan2(b.Y - a.Y, b.X - a.X) * 180 / Math.PI, dist: d };
  }
  return best;
}

/// The length along a path of points.
function planPathLength(points      )         {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += Math.hypot(points[i].X - points[i - 1].X, points[i].Y - points[i - 1].Y);
  return s;
}

/// Is an outline a rectangle square to the page? Then it can be sized by width and depth.
function planIsBox(poly      )          {
  if (poly.length !== 4) return false;
  const xs = new Set(poly.map(p => planRound(p.X))), ys = new Set(poly.map(p => planRound(p.Y)));
  return xs.size === 2 && ys.size === 2;
}

/// The bounding box of an outline.
function planBounds(poly      )                                                 {
  const xs = poly.map(p => p.X), ys = poly.map(p => p.Y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/// Everything wired downstream of an item: the runs leaving it from its load side, and what they lead to, onward.
function planDownstream(runs                                              , from        )                                            {
  const items = new Set        (), seen = new Set        ();
  const queue = [from];
  while (queue.length) {
    const at = queue.shift() ;
    runs.forEach(r => {
      if (r.From !== at || seen.has(r.Id)) return;
      seen.add(r.Id);
      if (r.To && r.To !== from && !items.has(r.To)) { items.add(r.To); queue.push(r.To); }
    });
  }
  return { items, runs: seen };
}

/// The nearest item upstream of this one that is a GFCI, following runs back toward the supply. Null when none is.
function planProtectedBy(runs                                  , isGfci                         , id        )                {
  const seen = new Set        ([id]);
  let frontier = [id];
  while (frontier.length) {
    const next           = [];
    for (const at of frontier) for (const r of runs) {
      if (r.To !== at || !r.From || seen.has(r.From)) continue;
      if (isGfci(r.From)) return r.From;
      seen.add(r.From);
      next.push(r.From);
    }
    frontier = next;
  }
  return null;
}

// ── plan-units.ts ───────────────────────────────────────────────
// Real-world lengths on the floor plans (#463): feet and inches or metres and centimetres, as the GUI settings say.

const INCH = 0.0254;
const FOOT = 0.3048;

/// The system to show: the setting when it names one, else what the browser's language implies.
function planUnitSystem(pref         , lang         )             {
  if (pref === 'imperial' || pref === 'metric') return pref;
  const l = (lang || '').toLowerCase();
  return l === 'en-us' || l.startsWith('en-us') || l === 'en-lr' || l === 'my' || l.startsWith('my-') ? 'imperial' : 'metric';
}

/// A length in metres, written the way a tape measure reads: 12′ 6″, or 3.75 m / 85 cm.
function planFmtLen(m        , sys            )         {
  if (!Number.isFinite(m)) return '';
  const neg = m < 0 ? '−' : '';
  m = Math.abs(m);
  if (sys === 'imperial') {
    let inches = Math.round(m / INCH);
    const ft = Math.floor(inches / 12);
    inches -= ft * 12;
    if (!ft) return `${neg}${inches}″`;
    return inches ? `${neg}${ft}′ ${inches}″` : `${neg}${ft}′`;
  }
  if (m < 1) return `${neg}${Math.round(m * 100)} cm`;
  return `${neg}${(Math.round(m * 100) / 100).toString()} m`;
}

/// An area in square metres, as ft² or m².
function planFmtArea(m2        , sys            )         {
  if (!Number.isFinite(m2)) return '';
  return sys === 'imperial' ? `${Math.round(m2 / (FOOT * FOOT)).toLocaleString('en-US')} ft²` : `${(Math.round(m2 * 10) / 10).toLocaleString('en-US')} m²`;
}

/// A typed length, in metres: 12' 6", 12ft 6in, 12 6, 150", 3.75m, 3m 75cm, 375 cm, 3750mm. A bare number is feet or metres.
function planParseLen(text        , sys            )                {
  const t = String(text || '').toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/,/g, '.').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const num = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
  let m = t.match(new RegExp(`^${num} ?(?:'|ft|feet|foot)(?: ?${num} ?(?:"|in|inch|inches)?)?$`));
  if (m) return Number(m[1]) * FOOT + (m[2] ? Number(m[2]) * INCH : 0);
  m = t.match(new RegExp(`^${num} ?(?:"|in|inch|inches)$`));
  if (m) return Number(m[1]) * INCH;
  m = t.match(new RegExp(`^${num} ?m(?: ?${num} ?cm)?$`));
  if (m) return Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
  m = t.match(new RegExp(`^${num} ?cm$`));
  if (m) return Number(m[1]) / 100;
  m = t.match(new RegExp(`^${num} ?mm$`));
  if (m) return Number(m[1]) / 1000;
  m = t.match(new RegExp(`^${num} ${num}$`));
  if (m) return sys === 'imperial' ? Number(m[1]) * FOOT + Number(m[2]) * INCH : Number(m[1]) + Number(m[2]) / 100;
  m = t.match(new RegExp(`^${num}$`));
  if (m) return sys === 'imperial' ? Number(m[1]) * FOOT : Number(m[1]);
  return null;
}

/// The grid a plan is drawn on, in metres: a foot, or half a metre.
function planGridStep(sys            )         { return sys === 'imperial' ? FOOT : 0.5; }

/// What a corner snaps to when nothing else is near, in metres: three inches, or five centimetres.
function planSnapStep(sys            )         { return sys === 'imperial' ? 3 * INCH : 0.05; }

/// A round length for the scale bar that is at least `minM` metres, and its label.
function planScaleBar(minM        , sys            )                               {
  const steps = sys === 'imperial' ? [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].map(f => f * FOOT) : [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  const m = steps.find(s => s >= minM) ?? steps[steps.length - 1];
  return { m, label: planFmtLen(m, sys) };
}

/// The size a new floor starts at, in metres: a 60 × 40 ft lot, or 20 × 14 m.
function planDefaultPlot(sys            )                           {
  return sys === 'imperial' ? { w: 60 * FOOT, h: 40 * FOOT } : { w: 20, h: 14 };
}

// ── plan-history.ts ─────────────────────────────────────────────
// Undo and redo for the floor plans (#463): whole snapshots of what is being edited, which is small enough to copy.

/// A history over whatever `get` returns, restored through `set`. Push before each change.
function planHistory(get           , set                  , limit = 200)              {
  const back           = [], ahead           = [];
  return {
    push() {
      const now = JSON.stringify(get());
      if (back[back.length - 1] === now) return;
      back.push(now);
      if (back.length > limit) back.shift();
      ahead.length = 0;
    },
    undo() {
      const prev = back.pop();
      if (prev == null) return false;
      ahead.push(JSON.stringify(get()));
      set(JSON.parse(prev));
      return true;
    },
    redo() {
      const next = ahead.pop();
      if (next == null) return false;
      back.push(JSON.stringify(get()));
      set(JSON.parse(next));
      return true;
    },
    canUndo: () => back.length > 0,
    canRedo: () => ahead.length > 0,
    clear() { back.length = 0; ahead.length = 0; },
  };
}

// ── plan-art.ts ─────────────────────────────────────────────────
// What the floor plans are drawn with (#463, #464): surface textures at their real size, a pictogram per kind of
// placed item, and doors and windows as an architect draws them.

/// Surfaces a room, outdoor zone or the ground can have, with their names.
const PLAN_SURFACES                     = [
  ['', 'Plain'], ['wood', 'Wood'], ['tile', 'Tile'], ['carpet', 'Carpet'], ['concrete', 'Concrete'], ['stone', 'Stone'],
  ['grass', 'Grass'], ['gravel', 'Gravel'], ['dirt', 'Dirt'], ['deck', 'Deck'], ['pavers', 'Pavers'], ['water', 'Water'], ['snow', 'Snow'], ['stairs', 'Stairs'],
];

/// Grounds a floor can sit on.
const PLAN_GROUNDS                     = [['', 'Plain'], ['grass', 'Grass'], ['concrete', 'Concrete'], ['gravel', 'Gravel'], ['dirt', 'Dirt'], ['pavers', 'Pavers'], ['snow', 'Snow']];

/// Placed item kinds, grouped for the picker: [kind, name, group].
const PLAN_KINDS                             = [
  ['outlet', 'Outlet', 'Inside'], ['switch', 'Switch', 'Inside'], ['fixture', 'Light', 'Inside'], ['fan', 'Fan', 'Inside'],
  ['appliance', 'Appliance', 'Inside'], ['device', 'Device', 'Inside'], ['hvac', 'HVAC', 'Inside'], ['junction', 'Junction box', 'Inside'],
  ['ev-charger', 'EV charger', 'Power'], ['panel', 'Panel', 'Power'], ['meter', 'Utility meter', 'Power'], ['pole', 'Utility pole', 'Power'],
  ['transformer', 'Transformer', 'Power'], ['solar', 'Solar', 'Power'], ['battery', 'Battery', 'Power'], ['inverter', 'Inverter', 'Power'],
  ['generator', 'Generator', 'Power'],
];

/// Things with a real footprint, in inches: [key, name, kind, width, depth, round]. Placed at their size, backs to the wall.
const PLAN_FOOTPRINTS                                                      = [
  ['washer', 'Washer', 'appliance', 27, 30, false], ['dryer', 'Dryer', 'appliance', 27, 30, false], ['fridge', 'Fridge', 'appliance', 36, 30, false],
  ['freezer', 'Chest freezer', 'appliance', 42, 28, false], ['range', 'Range / oven', 'appliance', 30, 26, false], ['dishwasher', 'Dishwasher', 'appliance', 24, 24, false],
  ['water-heater', 'Water heater', 'appliance', 22, 22, true], ['furnace', 'Furnace', 'hvac', 21, 28, false], ['condenser', 'AC condenser', 'hvac', 30, 30, false],
  ['rack', 'Server rack', 'device', 24, 42, false], ['hot-tub', 'Hot tub', 'appliance', 84, 84, false],
];

/// Kinds that supply or carry power rather than use it; they get a ring of their own.
const PLAN_SUPPLY_KINDS = ['panel', 'meter', 'pole', 'transformer', 'solar', 'battery', 'inverter', 'generator'];

const PLAN_OPENINGS                     = [['door', 'Door'], ['double-door', 'Double door'], ['sliding-door', 'Sliding door'], ['garage-door', 'Garage door'], ['window', 'Window'], ['opening', 'Opening']];

/// Each surface's own colours: its base, a darker detail, and a lighter one.
const PLAN_SURFACE_COLOURS                                           = {
  wood: ['#c99d6b', '#a37649', '#dcb689'], tile: ['#e4ded1', '#bbb3a1', '#f2eee6'], carpet: ['#959cb2', '#848ca4', '#a6adc1'],
  concrete: ['#c4c3bd', '#adaca5', '#d2d1cb'], stone: ['#b4ac9d', '#958d7e', '#c7c0b3'], grass: ['#78ab5d', '#5d9146', '#93c476'],
  gravel: ['#cbbfa6', '#a99c83', '#ddd3bf'], dirt: ['#a4815f', '#8b6949', '#b8977a'], deck: ['#b17d50', '#7c5535', '#c49269'],
  pavers: ['#b9684c', '#8c4a33', '#cc8065'], water: ['#76aad6', '#5b91c2', '#93bfe3'], snow: ['#f2f5f9', '#dde4ee', '#ffffff'],
  stairs: ['#d3cbbd', '#8f8676', '#b7ae9e'],
};

/// A colour lighter or darker by a fraction: a detail drawn in the same colour as what it sits on.
function planShade(hex        , by        )         {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => Math.round(by < 0 ? c * (1 + by) : c + (255 - c) * by));
  return '#' + ch.map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
}

/// The pattern id for a surface, in its own colours or in a chosen one.
function planTextureId(name        , colour = '')         {
  return 'fp-tex-' + name + (colour ? '-' + colour.replace('#', '').toLowerCase() : '');
}

/// One surface texture at real size, in its own colours or recoloured from a base colour. `s` is units per metre.
function planTexture(name        , s        , colour = '')      {
  const own = PLAN_SURFACE_COLOURS[name];
  const [base, dark, light] = colour ? [colour, planShade(colour, -0.2), planShade(colour, 0.18)] : own || ['#cccccc', '#aaaaaa', '#eeeeee'];
  const p = svgEl('pattern', { id: planTextureId(name, colour), patternUnits: 'userSpaceOnUse' });
  const size = (w        , h        ) => { p.setAttribute('width', w * s); p.setAttribute('height', h * s); p.appendChild(svgEl('rect', { width: w * s, height: h * s, fill: base })); };
  const add = (e     ) => p.appendChild(e);
  const line = (x1        , y1        , x2        , y2        , stroke        , w = 0.008) => add(svgEl('line', { x1: x1 * s, y1: y1 * s, x2: x2 * s, y2: y2 * s, stroke, 'stroke-width': w * s }));
  const dot = (x        , y        , r        , fill        ) => add(svgEl('circle', { cx: x * s, cy: y * s, r: r * s, fill }));
  const path = (d        , stroke        , w = 0.008) => add(svgEl('path', { d: d.replace(/-?\d*\.?\d+/g, n => String(Number(n) * s)), stroke, 'stroke-width': w * s, fill: 'none' }));
  switch (name) {
    case 'wood': size(1.2, 0.3); line(0, 0.15, 1.2, 0.15, dark); line(0, 0.3, 1.2, 0.3, dark); line(0.45, 0, 0.45, 0.15, dark); line(1.0, 0.15, 1.0, 0.3, dark); break;
    case 'tile': size(0.3, 0.3); path('M0 0 H0.3 M0 0 V0.3', dark, 0.012); break;
    case 'carpet': size(0.1, 0.1); dot(0.03, 0.03, 0.012, dark); dot(0.08, 0.07, 0.01, light); break;
    case 'concrete': size(0.5, 0.5); dot(0.1, 0.12, 0.012, dark); dot(0.33, 0.07, 0.008, dark); dot(0.27, 0.38, 0.014, dark); dot(0.44, 0.29, 0.007, light); dot(0.06, 0.41, 0.009, dark); break;
    case 'stone': size(0.6, 0.6); path('M0 0.25 L0.22 0.2 L0.3 0 M0.22 0.2 L0.35 0.42 L0.6 0.36 M0.35 0.42 L0.28 0.6 M0.3 0 L0.55 0.12 L0.6 0.36', dark, 0.012); break;
    case 'grass': size(0.3, 0.3); path('M0.05 0.12 l0.02 -0.07 M0.18 0.27 l-0.015 -0.06 M0.24 0.1 l0.02 -0.06 M0.11 0.24 l0.01 -0.05', dark, 0.012); path('M0.2 0.2 l0.012 -0.05 M0.02 0.28 l0.015 -0.05', light, 0.01); break;
    case 'gravel': size(0.15, 0.15); dot(0.03, 0.04, 0.014, dark); dot(0.1, 0.03, 0.01, light); dot(0.07, 0.1, 0.016, dark); dot(0.13, 0.12, 0.01, dark); break;
    case 'dirt': size(0.25, 0.25); dot(0.05, 0.06, 0.01, dark); dot(0.17, 0.12, 0.008, light); dot(0.1, 0.2, 0.012, dark); break;
    case 'deck': size(1.5, 0.28); line(0, 0.14, 1.5, 0.14, dark, 0.014); line(0, 0.28, 1.5, 0.28, dark, 0.014); line(0.6, 0, 0.6, 0.14, dark, 0.01); line(1.25, 0.14, 1.25, 0.28, dark, 0.01); break;
    case 'pavers': size(0.4, 0.2); path('M0 0 H0.4 M0 0.1 H0.4 M0.2 0 V0.1 M0 0.1 V0.2 M0.4 0.1 V0.2', dark, 0.012); break;
    case 'water': size(0.6, 0.3); path('M0 0.15 q0.075 -0.06 0.15 0 t0.15 0 t0.15 0 t0.15 0', dark, 0.014); break;
    case 'snow': size(0.4, 0.4); dot(0.08, 0.1, 0.01, dark); dot(0.3, 0.25, 0.012, dark); dot(0.2, 0.36, 0.008, dark); break;
    case 'stairs': size(1.0, 0.28); line(0, 0.27, 1.0, 0.27, dark, 0.018); line(0, 0.25, 1.0, 0.25, light, 0.008); break;
    default: size(1, 1); break;
  }
  return p;
}

/// Every surface texture in its own colours.
function planTextures(s        )        {
  return Object.keys(PLAN_SURFACE_COLOURS).map(name => planTexture(name, s));
}

/// A pictogram for a placed item, centred on 0,0 inside a disc of radius r.
function planGlyph(kind        , r        )      {
  const g = svgEl('g', { class: 'fp-glyph' });
  const k = r * 0.5;
  const add = (tag        , a     ) => g.appendChild(svgEl(tag, a));
  const line = (x1        , y1        , x2        , y2        ) => add('line', { x1: x1 * k, y1: y1 * k, x2: x2 * k, y2: y2 * k });
  const rect = (x        , y        , w        , h        , rx = 0.15) => add('rect', { x: x * k, y: y * k, width: w * k, height: h * k, rx: rx * k });
  const circle = (cx        , cy        , rr        ) => add('circle', { cx: cx * k, cy: cy * k, r: rr * k });
  const path = (d        ) => add('path', { d: d.replace(/-?\d*\.?\d+/g, n => String(Number(n) * k)) });
  const text = (t        ) => { const e = svgEl('text', { x: 0, y: 0.05 * k, class: 'fp-glyph-text', 'font-size': 1.3 * k }); e.textContent = t; g.appendChild(e); };
  switch (kind) {
    case 'outlet': line(-0.35, -0.55, -0.35, 0.1); line(0.35, -0.55, 0.35, 0.1); circle(0, 0.6, 0.14); break;
    case 'switch': rect(-0.45, -0.9, 0.9, 1.8, 0.2); line(0, -0.5, 0, 0.05); break;
    case 'fixture': circle(0, 0, 0.42); [0, 45, 90, 135, 180, 225, 270, 315].forEach(a => { const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180); line(c * 0.65, s * 0.65, c * 0.95, s * 0.95); }); break;
    case 'fan': circle(0, 0, 0.18); path('M0 -0.18 Q0.2 -0.8 0 -0.9 Q-0.25 -0.6 0 -0.18 M0.16 0.09 Q0.8 0.2 0.8 0.45 Q0.45 0.5 0.16 0.09 M-0.16 0.09 Q-0.6 0.6 -0.8 0.45 Q-0.7 0.15 -0.16 0.09'); break;
    case 'appliance': rect(-0.9, -0.9, 1.8, 1.8, 0.25); circle(0, 0.15, 0.5); break;
    case 'hvac': rect(-0.9, -0.9, 1.8, 1.8, 0.2); circle(0, 0, 0.6); line(-0.42, -0.42, 0.42, 0.42); line(-0.42, 0.42, 0.42, -0.42); break;
    case 'junction': rect(-0.75, -0.75, 1.5, 1.5, 0.1); circle(0, 0, 0.3); break;
    case 'ev-charger': rect(-0.6, -0.9, 1.2, 1.8, 0.25); path('M0.12 -0.6 L-0.25 0.08 L0.05 0.08 L-0.12 0.6 L0.28 -0.12 L-0.02 -0.12 Z'); break;
    case 'panel': rect(-0.6, -0.95, 1.2, 1.9, 0.1); [-0.5, -0.15, 0.2, 0.55].forEach(y => line(-0.35, y, 0.35, y)); break;
    case 'meter': circle(0, 0, 0.85); line(0, 0.2, 0.45, -0.35); circle(0, 0.2, 0.08); break;
    case 'pole': line(0, -0.95, 0, 0.95); line(-0.75, -0.55, 0.75, -0.55); circle(-0.6, -0.72, 0.1); circle(0.6, -0.72, 0.1); break;
    case 'transformer': circle(-0.3, 0, 0.5); circle(0.3, 0, 0.5); break;
    case 'solar': rect(-0.95, -0.65, 1.9, 1.3, 0.05); line(-0.95, 0, 0.95, 0); line(-0.32, -0.65, -0.32, 0.65); line(0.32, -0.65, 0.32, 0.65); break;
    case 'battery': rect(-0.8, -0.5, 1.5, 1.0, 0.12); rect(0.7, -0.2, 0.2, 0.4, 0.05); line(-0.45, 0, -0.1, 0); line(-0.275, -0.18, -0.275, 0.18); break;
    case 'inverter': rect(-0.85, -0.85, 1.7, 1.7, 0.15); path('M-0.55 0 Q-0.28 -0.5 0 0 T0.55 0'); break;
    case 'generator': circle(0, 0, 0.85); text('G'); break;
    default: rect(-0.9, -0.65, 1.8, 1.3, 0.2); line(-0.4, 0.9, 0.4, 0.9); break;
  }
  return g;
}

/// A door, window or opening: the wall cut, and what fills it, lying along the wall at its angle.
/// `u` is drawing units per screen pixel; the wall is drawn a few pixels thick at any zoom.
function planOpening(o     , u        )      {
  const w = Math.max(1, Number(o.Width) || 90);
  const half = w / 2;
  const g = svgEl('g', { class: 'fp-op is-' + (o.Kind || 'door'), transform: `translate(${o.X},${o.Y}) rotate(${Number(o.Angle) || 0})` });
  const wall = 5 * u;
  g.appendChild(svgEl('line', { x1: -half, y1: 0, x2: half, y2: 0, class: 'fp-op-gap', 'stroke-width': wall + 2 * u }));
  const dir = o.Flip ? -1 : 1;
  const stroke = 1.6 * u;
  const leaf = (hx        , ox        , len        , left         ) => {
    g.appendChild(svgEl('line', { x1: hx, y1: 0, x2: hx, y2: dir * len, class: 'fp-op-leaf', 'stroke-width': stroke * 1.4 }));
    const sweep = left === (dir > 0) ? 0 : 1;
    g.appendChild(svgEl('path', { d: `M ${hx} ${dir * len} A ${len} ${len} 0 0 ${sweep} ${ox} 0`, class: 'fp-op-arc', 'stroke-width': stroke }));
  };
  const kind = o.Kind || 'door';
  if (kind === 'door') {
    const left = (o.Swing || 'left') === 'left';
    leaf(left ? -half : half, left ? half : -half, w, left);
  } else if (kind === 'double-door') {
    leaf(-half, 0, half, true);
    leaf(half, 0, half, false);
  } else if (kind === 'sliding-door') {
    const t = wall * 0.35;
    g.appendChild(svgEl('line', { x1: -half, y1: -t, x2: half * 0.12, y2: -t, class: 'fp-op-leaf', 'stroke-width': stroke * 1.4 }));
    g.appendChild(svgEl('line', { x1: -half * 0.12, y1: t, x2: half, y2: t, class: 'fp-op-leaf', 'stroke-width': stroke * 1.4 }));
  } else if (kind === 'garage-door') {
    g.appendChild(svgEl('rect', { x: -half, y: dir > 0 ? 0 : -w * 0.12, width: w, height: w * 0.12, class: 'fp-op-garage', 'stroke-width': stroke, 'stroke-dasharray': `${6 * u} ${4 * u}` }));
  } else if (kind === 'window') {
    const t = wall / 2;
    [-t, 0, t].forEach(y => g.appendChild(svgEl('line', { x1: -half, y1: y, x2: half, y2: y, class: 'fp-op-glass', 'stroke-width': y ? stroke : stroke * 0.8 })));
    [-half, half].forEach(x => g.appendChild(svgEl('line', { x1: x, y1: -t, x2: x, y2: t, class: 'fp-op-glass', 'stroke-width': stroke })));
  } else {
    [-half, half].forEach(x => g.appendChild(svgEl('line', { x1: x, y1: -wall, x2: x, y2: wall, class: 'fp-op-leaf', 'stroke-width': stroke })));
  }
  const hit = svgEl('rect', { x: -half, y: -10 * u, width: w, height: 20 * u, class: 'fp-hit' });
  hit.dataset.opening = o.Id;
  g.appendChild(hit);
  return g;
}

const PLAN_CIRCUIT_COLOURS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

/// A colour per circuit, stable across reloads: the same breaker is always the same colour.
function planCircuitColor(ref        )         {
  if (!ref) return 'var(--muted)';
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (h * 31 + ref.charCodeAt(i)) >>> 0;
  return PLAN_CIRCUIT_COLOURS[h % PLAN_CIRCUIT_COLOURS.length];
}

/// An appliance seen from above, drawn inside its own footprint of W × D drawing units, its front toward +Y.
/// `u` is drawing units per screen pixel, so the lines stay a pixel or two wide at any zoom.
function planFootprintArt(key        , W        , D        , u        )             {
  const g = svgEl('g', { class: 'fp-art' });
  const sw = 1.4 * u;
  const hw = W / 2, hd = D / 2, m = Math.min(W, D);
  const rect = (x        , y        , w        , h        , rx = 0, cls = '') => g.appendChild(svgEl('rect', { x, y, width: w, height: h, rx, 'stroke-width': sw, class: cls }));
  const circle = (cx        , cy        , r        , cls = '') => g.appendChild(svgEl('circle', { cx, cy, r, 'stroke-width': sw, class: cls }));
  const line = (x1        , y1        , x2        , y2        , cls = '') => g.appendChild(svgEl('line', { x1, y1, x2, y2, 'stroke-width': sw, class: cls }));
  const knobs = (y        , n        , r        ) => { for (let i = 0; i < n; i++) circle(-hw * 0.6 + (i + 0.5) * (hw * 1.2 / n), y, r, 'is-fill'); };
  switch (key) {
    case 'washer': {
      const con = D * 0.18;
      rect(-hw * 0.88, -hd * 0.94, W * 0.88, con, m * 0.03);
      knobs(-hd * 0.94 + con / 2, 3, m * 0.035);
      circle(0, con / 2, m * 0.34);
      circle(0, con / 2, m * 0.26, 'is-soft');
      break;
    }
    case 'dryer': {
      const con = D * 0.18;
      rect(-hw * 0.88, -hd * 0.94, W * 0.88, con, m * 0.03);
      knobs(-hd * 0.94 + con / 2, 2, m * 0.035);
      rect(-hw * 0.72, -hd * 0.94 + con + D * 0.08, W * 0.72, D * 0.58, m * 0.05);
      line(-hw * 0.4, -hd * 0.94 + con + D * 0.2, hw * 0.4, -hd * 0.94 + con + D * 0.2, 'is-soft');
      break;
    }
    case 'fridge': {
      // French doors across the front, meeting in the middle, a handle each side of the join; the vent at the back.
      line(-hw * 0.92, hd * 0.5, hw * 0.92, hd * 0.5);
      line(0, hd * 0.5, 0, hd * 0.94);
      rect(-W * 0.07, hd * 0.6, W * 0.025, D * 0.24, W * 0.012, 'is-fill');
      rect(W * 0.045, hd * 0.6, W * 0.025, D * 0.24, W * 0.012, 'is-fill');
      rect(-hw * 0.7, -hd * 0.86, W * 0.7, D * 0.1, m * 0.02, 'is-soft');
      for (let i = 1; i < 6; i++) line(-hw * 0.7 + i * W * 0.7 / 6, -hd * 0.84, -hw * 0.7 + i * W * 0.7 / 6, -hd * 0.68, 'is-soft');
      break;
    }
    case 'freezer': {
      line(-hw * 0.92, -hd * 0.72, hw * 0.92, -hd * 0.72);
      rect(-hw * 0.8, -hd * 0.6, W * 0.8, D * 0.7, m * 0.04, 'is-soft');
      rect(-hw * 0.25, hd * 0.72, W * 0.25, D * 0.06, m * 0.02, 'is-fill');
      break;
    }
    case 'range': {
      const con = D * 0.14;
      rect(-hw * 0.92, -hd * 0.94, W * 0.92, con, 0);
      knobs(-hd * 0.94 + con / 2, 4, m * 0.03);
      const top = -hd * 0.94 + con, span = hd * 0.94 * 2 - con;
      [[-0.25, 0.3, 0.19], [0.25, 0.3, 0.14], [-0.25, 0.72, 0.14], [0.25, 0.72, 0.19]].forEach(([x, y, r]) => { circle(x * W, top + y * span, r * m); circle(x * W, top + y * span, r * m * 0.55, 'is-soft'); });
      break;
    }
    case 'dishwasher': {
      rect(-hw * 0.9, -hd * 0.9, W * 0.9, D * 0.82, m * 0.03, 'is-soft');
      line(-hw * 0.9, hd * 0.6, hw * 0.9, hd * 0.6);
      rect(-hw * 0.5, hd * 0.72, W * 0.5, D * 0.06, m * 0.02, 'is-fill');
      break;
    }
    case 'water-heater': {
      circle(0, 0, m * 0.36, 'is-soft');
      circle(0, 0, m * 0.1);
      circle(-m * 0.22, -m * 0.22, m * 0.05, 'is-fill');
      circle(m * 0.22, -m * 0.22, m * 0.05, 'is-fill');
      break;
    }
    case 'furnace': {
      rect(-hw * 0.86, -hd * 0.86, W * 0.86, D * 0.86, m * 0.03, 'is-soft');
      circle(0, -hd * 0.45, m * 0.14);
      line(-hw * 0.86, hd * 0.55, hw * 0.86, hd * 0.55);
      for (let i = 1; i < 4; i++) line(-hw * 0.86 + i * W * 0.86 / 4, hd * 0.62, -hw * 0.86 + i * W * 0.86 / 4, hd * 0.8, 'is-soft');
      break;
    }
    case 'condenser': {
      const r = m * 0.42;
      circle(0, 0, r);
      circle(0, 0, r * 0.72, 'is-soft');
      circle(0, 0, r * 0.42, 'is-soft');
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; line(Math.cos(a) * r * 0.18, Math.sin(a) * r * 0.18, Math.cos(a) * r, Math.sin(a) * r, 'is-soft'); }
      circle(0, 0, r * 0.14, 'is-fill');
      break;
    }
    case 'rack': {
      rect(-hw * 0.84, -hd * 0.9, W * 0.84, D * 0.9, m * 0.02, 'is-soft');
      const rows = 7;
      for (let i = 1; i < rows; i++) line(-hw * 0.84, -hd * 0.9 + i * D * 0.9 / rows, hw * 0.84, -hd * 0.9 + i * D * 0.9 / rows, 'is-soft');
      for (let i = 0; i < rows; i++) circle(hw * 0.6, -hd * 0.9 + (i + 0.5) * D * 0.9 / rows, m * 0.03, 'is-fill');
      break;
    }
    case 'hot-tub': {
      rect(-hw * 0.8, -hd * 0.8, W * 0.8, D * 0.8, m * 0.2, 'is-soft');
      rect(-hw * 0.45, -hd * 0.45, W * 0.45, D * 0.45, m * 0.12);
      [[-0.62, -0.3], [-0.62, 0.3], [0.62, -0.3], [0.62, 0.3], [-0.3, -0.62], [0.3, -0.62], [-0.3, 0.62], [0.3, 0.62]].forEach(([x, y]) => circle(x * hw, y * hd, m * 0.022, 'is-fill'));
      break;
    }
    default: return null;
  }
  return g;
}

// ── search-select.ts ────────────────────────────────────────────
// A picker with a search box at the top of its list, for choices too many to scroll: circuits, meters, nodes.

/// A button showing the current choice; opening it shows a search box and the choices matching what is typed.
function searchSelect(choices          , value        , onPick                     , opts                                           = {})      {
  const wrap = el('div', { class: 'ss' });
  const current = () => choices.find(c => c.value === value) || choices[0];
  const face = el('button', { class: 'ss-btn', type: 'button', title: opts.title || '' },
    el('span', { class: 'ss-face', text: current()?.label || '' }), el('span', { class: 'ss-caret', text: '▾' }));
  face.setAttribute('aria-haspopup', 'listbox');
  face.setAttribute('aria-expanded', 'false');
  wrap.appendChild(face);

  let pop      = null;
  let active = 0;
  let shown           = [];
  const outside = (e     ) => { if (pop && !wrap.contains(e.target)) close(); };
  const close = () => {
    if (!pop) return;
    pop.remove(); pop = null;
    face.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  const pick = (c        ) => { value = c.value; face.children[0].textContent = c.label; close(); onPick(c.value); };

  const open = () => {
    if (pop) { close(); return; }
    const search = el('input', { type: 'search', class: 'ss-search', placeholder: opts.placeholder || 'Search…' })                    ;
    search.setAttribute('aria-label', opts.placeholder || 'Search');
    const list = el('div', { class: 'ss-list', role: 'listbox' });
    const draw = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = choices.filter(c => words.every(w => `${c.label} ${c.hint || ''} ${c.value} ${c.group || ''}`.toLowerCase().includes(w)));
      active = Math.max(0, Math.min(active, shown.length - 1));
      list.innerHTML = '';
      let group                    ;
      shown.forEach((c, i) => {
        if (c.group && c.group !== group) { group = c.group; list.appendChild(el('div', { class: 'ss-group', text: c.group })); }
        const b = el('button', { class: 'ss-opt' + (c.value === value ? ' is-current' : '') + (i === active ? ' is-active' : ''), type: 'button' },
          el('span', { class: 'ss-label', text: c.label }), ...(c.hint ? [el('span', { class: 'ss-hint', text: c.hint })] : []));
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(c.value === value));
        b.onclick = () => pick(c);
        list.appendChild(b);
      });
      if (!shown.length) list.appendChild(el('div', { class: 'ss-none', text: 'Nothing matches.' }));
    };
    search.oninput = () => { active = 0; draw(); };
    search.onkeydown = (e     ) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation?.(); close(); face.focus?.(); }
    };
    active = Math.max(0, choices.findIndex(c => c.value === value));
    pop = el('div', { class: 'ss-pop' }, search, list);
    wrap.appendChild(pop);
    face.setAttribute('aria-expanded', 'true');
    draw();
    document.addEventListener('pointerdown', outside, true);
    setTimeout(() => search.focus?.(), 0);
  };
  face.onclick = () => open();
  return wrap;
}

// ── plan-constraints.ts ─────────────────────────────────────────
// Geometric constraints on floor plans (#463): coincident corners, colinear, parallel and perpendicular walls,
// horizontal and vertical walls, fixed angles and fixed lengths — kept by relaxing the points toward each
// constraint in turn until they all hold. Corners that sit on top of one another move as one: a shared wall.

/// Corners closer than this, in drawing units, are one corner shared by the rooms that meet there.
const SHARED = 0.5;

const norm180 = (a        ) => { a %= 360; if (a > 180) a -= 360; if (a <= -180) a += 360; return a; };
const norm90 = (a        ) => { a = norm180(a); if (a > 90) a -= 180; if (a <= -90) a += 180; return a; };

/// The corners a wall runs between.
function planEdgeCorners(shape           , edge        )                   {
  const n = shape.Shape.length;
  return [((edge % n) + n) % n, (((edge + 1) % n) + n) % n];
}

/// The signed angle at a corner, from the wall arriving to the wall leaving, in degrees.
function planCornerAngle(shape           , corner        )         {
  const n = shape.Shape.length;
  const b = shape.Shape[corner], a = shape.Shape[(corner - 1 + n) % n], c = shape.Shape[(corner + 1) % n];
  const u = { X: a.X - b.X, Y: a.Y - b.Y }, v = { X: c.X - b.X, Y: c.Y - b.Y };
  return Math.atan2(u.X * v.Y - u.Y * v.X, u.X * v.X + u.Y * v.Y) * 180 / Math.PI;
}

/// The corners a set of shapes would move together: every corner within SHARED of another is in its group.
function planSharedCorners(shapes             , room        , corner        )                                     {
  const s = shapes.find(x => x.Id === room);
  const p = s?.Shape[corner];
  if (!p) return [];
  const out                                     = [];
  shapes.forEach(x => x.Shape.forEach((q, i) => { if (!(x.Id === room && i === corner) && Math.hypot(q.X - p.X, q.Y - p.Y) <= SHARED) out.push({ room: x.Id, corner: i }); }));
  return out;
}

/// How far a constraint is from holding: in drawing units for positions and lengths, in degrees for angles.
function residual(c                , pt                                         , shapes                        )         {
  const edgeOf = (r         ) => { const a = pt(r, 0), b = pt(r, 1); return a && b ? [a, b]             : null; };
  const angleOf = (e          ) => Math.atan2(e[1].Y - e[0].Y, e[1].X - e[0].X) * 180 / Math.PI;
  switch (c.Kind) {
    case 'coincident': { const a = pt(c.Refs[0]), b = pt(c.Refs[1]); return a && b ? Math.hypot(a.X - b.X, a.Y - b.Y) : 0; }
    case 'length': { const e = edgeOf(c.Refs[0]); return e && c.Value != null ? Math.abs(Math.hypot(e[1].X - e[0].X, e[1].Y - e[0].Y) - c.Value) : 0; }
    case 'horizontal': { const e = edgeOf(c.Refs[0]); return e ? Math.abs(e[1].Y - e[0].Y) : 0; }
    case 'vertical': { const e = edgeOf(c.Refs[0]); return e ? Math.abs(e[1].X - e[0].X) : 0; }
    case 'parallel': case 'perpendicular': case 'colinear': {
      const e1 = edgeOf(c.Refs[0]), e2 = edgeOf(c.Refs[1]);
      if (!e1 || !e2) return 0;
      const d = norm90(angleOf(e1) - angleOf(e2) - (c.Kind === 'perpendicular' ? 90 : 0));
      if (c.Kind !== 'colinear') return Math.abs(d);
      const L = Math.hypot(e1[1].X - e1[0].X, e1[1].Y - e1[0].Y) || 1;
      const n = { X: -(e1[1].Y - e1[0].Y) / L, Y: (e1[1].X - e1[0].X) / L };
      return Math.abs(d) + Math.max(...e2.map(q => Math.abs((q.X - e1[0].X) * n.X + (q.Y - e1[0].Y) * n.Y)));
    }
    case 'angle': {
      const r = c.Refs[0], s = shapes.get(r.Room);
      return s && r.Corner != null && c.Value != null ? Math.abs(norm180(planCornerAngle(s, r.Corner) - c.Value)) : 0;
    }
  }
  return 0;
}

/// Move the free corners until every constraint holds, or as near as they can. Corners of a locked room, of a
/// locked wall, or named in `fixed` ("room#corner") do not move. Returns the worst constraint left unmet.
function planSolve(shapes             , constraints                  , fixed              = new Set(), iterations = 120)                                     {
  const byId = new Map(shapes.map(s => [s.Id, s]));
  // Corners that coincide are one variable: moving one moves every room that shares it.

  const vars        = [];
  const varOf = new Map             ();
  shapes.forEach(s => s.Shape.forEach((p, i) => {
    const key = `${s.Id}#${i}`;
    let v = vars.find(x => Math.hypot(x.X - p.X, x.Y - p.Y) <= SHARED);
    if (!v) { v = { X: p.X, Y: p.Y, w: 1, members: [] }; vars.push(v); }
    v.members.push([s, i]);
    varOf.set(key, v);
    const n = s.Shape.length;
    const walled = (s.LockedWalls || []).some(e => e === i || ((e + 1) % n) === i);
    if (s.Locked || walled || fixed.has(key)) v.w = 0;
  }));
  if (!constraints.length) return { worst: 0, unmet: [] };
  const vRef = (r         , end = 0)             => {
    const s = byId.get(r.Room);
    if (!s || !s.Shape.length) return null;
    const i = r.Corner != null ? r.Corner : r.Edge != null ? planEdgeCorners(s, r.Edge)[end] : null;
    return i == null || i < 0 || i >= s.Shape.length ? null : varOf.get(`${s.Id}#${i}`) || null;
  };
  const both = (a     , b     ) => a.w + b.w;
  const rotate = (p     , pivot    , deg        ) => {
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const x = p.X - pivot.X, y = p.Y - pivot.Y;
    p.X = pivot.X + x * c - y * s; p.Y = pivot.Y + x * s + y * c;
  };
  /// Turn a wall about whichever end is held, or its middle when neither is.
  const turnEdge = (a     , b     , deg        ) => {
    if (!a.w && !b.w) return;
    const pivot = !a.w ? { X: a.X, Y: a.Y } : !b.w ? { X: b.X, Y: b.Y } : { X: (a.X + b.X) / 2, Y: (a.Y + b.Y) / 2 };
    if (a.w) rotate(a, pivot, deg);
    if (b.w) rotate(b, pivot, deg);
  };
  const edgeW = (a     , b     ) => (a.w && b.w ? 1 : a.w || b.w ? 0.5 : 0);
  const ang = (a     , b     ) => Math.atan2(b.Y - a.Y, b.X - a.X) * 180 / Math.PI;

  for (let it = 0; it < iterations; it++) {
    for (const c of constraints) {
      const r0 = c.Refs[0], r1 = c.Refs[1];
      if (c.Kind === 'coincident') {
        const a = vRef(r0), b = vRef(r1);
        if (!a || !b || a === b || !both(a, b)) continue;
        const dx = b.X - a.X, dy = b.Y - a.Y, k = both(a, b);
        a.X += dx * a.w / k; a.Y += dy * a.w / k; b.X -= dx * b.w / k; b.Y -= dy * b.w / k;
      } else if (c.Kind === 'length' && c.Value != null) {
        const a = vRef(r0, 0), b = vRef(r0, 1);
        if (!a || !b || !both(a, b)) continue;
        const dx = b.X - a.X, dy = b.Y - a.Y, cur = Math.hypot(dx, dy) || 1e-9, diff = (cur - c.Value) / cur, k = both(a, b);
        a.X += dx * diff * a.w / k; a.Y += dy * diff * a.w / k; b.X -= dx * diff * b.w / k; b.Y -= dy * diff * b.w / k;
      } else if (c.Kind === 'horizontal' || c.Kind === 'vertical') {
        const a = vRef(r0, 0), b = vRef(r0, 1);
        if (!a || !b || !both(a, b)) continue;
        const k = both(a, b);
        if (c.Kind === 'horizontal') { const d = b.Y - a.Y; a.Y += d * a.w / k; b.Y -= d * b.w / k; }
        else { const d = b.X - a.X; a.X += d * a.w / k; b.X -= d * b.w / k; }
      } else if (c.Kind === 'angle' && c.Value != null && r0?.Corner != null) {
        const s = byId.get(r0.Room);
        if (!s || s.Shape.length < 3) continue;
        const n = s.Shape.length;
        const B = varOf.get(`${s.Id}#${r0.Corner}`), A = varOf.get(`${s.Id}#${(r0.Corner - 1 + n) % n}`), C = varOf.get(`${s.Id}#${(r0.Corner + 1) % n}`);
        if (!A || !B || !C) continue;
        const u = { X: A.X - B.X, Y: A.Y - B.Y }, v = { X: C.X - B.X, Y: C.Y - B.Y };
        const cur = Math.atan2(u.X * v.Y - u.Y * v.X, u.X * v.X + u.Y * v.Y) * 180 / Math.PI;
        const err = norm180(c.Value - cur);
        const k = A.w + C.w;
        if (!k) continue;
        rotate(C, B, err * C.w / k);
        rotate(A, B, -err * A.w / k);
      } else if (c.Kind === 'parallel' || c.Kind === 'perpendicular' || c.Kind === 'colinear') {
        const a = vRef(r0, 0), b = vRef(r0, 1), p = vRef(r1, 0), q = vRef(r1, 1);
        if (!a || !b || !p || !q) continue;
        const w1 = edgeW(a, b), w2 = edgeW(p, q);
        if (!w1 && !w2) continue;
        const d = norm90(ang(a, b) - ang(p, q) - (c.Kind === 'perpendicular' ? 90 : 0));
        turnEdge(p, q, d * w2 / (w1 + w2));
        turnEdge(a, b, -d * w1 / (w1 + w2));
        if (c.Kind === 'colinear') {
          // Then the second wall is brought onto the first one's line, each side giving way by what it is free to.
          const L = Math.hypot(b.X - a.X, b.Y - a.Y) || 1e-9;
          const nx = -(b.Y - a.Y) / L, ny = (b.X - a.X) / L;
          [p, q].forEach(x => {
            const dist = (x.X - a.X) * nx + (x.Y - a.Y) * ny;
            const k = x.w + w1;
            if (!k) return;
            x.X -= nx * dist * x.w / k; x.Y -= ny * dist * x.w / k;
            const back = dist * w1 / k / 2;
            if (a.w) { a.X += nx * back; a.Y += ny * back; }
            if (b.w) { b.X += nx * back; b.Y += ny * back; }
          });
        }
      }
    }
  }
  // Write each variable back to every corner that shares it, rounded as outlines are stored.
  vars.forEach(v => v.members.forEach(([s, i]) => { s.Shape[i] = { X: Math.round(v.X * 10) / 10, Y: Math.round(v.Y * 10) / 10 }; }));

  const pt = (r         , end = 0)            => {
    const s = byId.get(r.Room);
    if (!s || !s.Shape.length) return null;
    const i = r.Corner != null ? r.Corner : r.Edge != null ? planEdgeCorners(s, r.Edge)[end] : null;
    return i == null ? null : s.Shape[i] || null;
  };
  let worst = 0;
  const unmet           = [];
  constraints.forEach(c => {
    const e = residual(c, pt, byId);
    const tol = c.Kind === 'angle' || c.Kind === 'parallel' || c.Kind === 'perpendicular' ? 0.5 : 1;
    if (e > tol) unmet.push(c.Id);
    worst = Math.max(worst, e);
  });
  return { worst, unmet };
}

/// Keep constraints pointing at the same corners when one is added at `at` in a room's outline.
function planRefsAfterInsert(constraints                  , room        , at        )       {
  constraints.forEach(c => c.Refs.forEach(r => {
    if (r.Room !== room) return;
    if (r.Corner != null && r.Corner >= at) r.Corner++;
    if (r.Edge != null && r.Edge >= at) r.Edge++;
  }));
}

/// Drop what a removed corner held, and renumber the rest.
function planRefsAfterRemove(constraints                  , room        , at        , count        )                   {
  const kept = constraints.filter(c => !c.Refs.some(r => r.Room === room && (r.Corner === at || r.Edge === at || r.Edge === (at - 1 + count) % count)));
  kept.forEach(c => c.Refs.forEach(r => {
    if (r.Room !== room) return;
    if (r.Corner != null && r.Corner > at) r.Corner--;
    if (r.Edge != null && r.Edge > at) r.Edge--;
  }));
  return kept;
}

/// Everything that no longer refers to a room: when it is deleted, or its outline redrawn.
function planRefsWithout(constraints                  , room        )                   {
  return constraints.filter(c => !c.Refs.some(r => r.Room === room));
}

// ── location-options.ts ─────────────────────────────────────────
// The places and circuits in the configuration, as picker options — for anything that says where a node is
// or which circuit it is on (#461, #465).

/// Every site, floor, room and area as [id, label], indented by depth so the tree reads in a flat list.
function locationChoices()                     {
  const out                     = [];
  const sites        = state.data?.EnergyFlow?.Sites || [];
  sites.forEach(s => {
    out.push([s.Id, s.Name || s.Id]);
    (s.Floors || []).slice().sort((a     , b     ) => (a.Level || 0) - (b.Level || 0)).forEach((f     ) => {
      out.push([f.Id, `  ${f.Name || f.Id}`]);
      (f.Rooms || []).forEach((r     ) => out.push([r.Id, `    ${r.Name || r.Id}`]));
      (f.Areas || []).forEach((a     ) => out.push([a.Id, `    ${a.Name || a.Id} (area)`]));
    });
  });
  return out;
}

/// Every breaker in use in every panel as ["panel/number", label]; an unused slot is not a circuit anything is on.
function circuitChoices()                     {
  const panels        = state.data?.EnergyFlow?.Panels || [];
  return panels.flatMap(p => (p.Breakers || []).filter((b     ) => b.State !== 'unused').map((b     ) =>
    [`${p.Id}/${b.Number}`, `${p.Name || p.Id} · ${b.Number}${b.Description ? ' — ' + b.Description : ''}`]                    ));
}

/// A select over some choices with a blank first option, keeping a current value that is not among them.
function choiceSelect(choices                    , value        , blank        )                    {
  const sel = el('select', {})                     ;
  sel.appendChild(el('option', { value: '', text: blank }));
  choices.forEach(([v, t]) => sel.appendChild(el('option', { value: v, text: t })));
  if (value && !choices.some(([v]) => v === value)) sel.appendChild(el('option', { value, text: `${value} (not found)` }));
  sel.value = value || '';
  return sel;
}

// ── panel-layout.ts ─────────────────────────────────────────────
// Where a breaker sits in the panel as it is drawn (#453): odd slots down the left column, even down the
// right, a double-pole spanning the next slot in its own column, and a tandem sharing one slot.

/// One drawn position: the slot, how many rows it covers, and the breaker (or two tandem halves) in it.

const isLeft = (slot        ) => slot % 2 === 1;
const rowOf = (slot        ) => Math.floor((slot + 1) / 2);

/// The cells of one column, top to bottom. A slot a double-pole reaches into is not drawn again.
function column                   (slots        , breakers     , left         )                {
  const cells                = [];
  const covered = new Set        ();
  for (let slot = left ? 1 : 2; slot <= slots; slot += 2) {
    if (covered.has(slot)) continue;
    const halves = breakers.filter(b => b.slot === slot).sort((a, b) => (a.half || 1) - (b.half || 1));
    // A double-pole in the last slot of a column has nothing to reach into, so it is drawn as one.
    const spans = halves.some(b => (b.poles || 1) === 2) && slot + 2 <= slots;
    if (spans) covered.add(slot + 2);
    cells.push({ slot, span: spans ? 2 : 1, halves });
  }
  return cells;
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
    // browser — the container's clock is UTC unless someone set TZ, so "Energy Daily" can end at 7pm local
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
  [['realpower', 'Power (W)'], ['energy_d', 'Energy Daily (kWh)'], ['energy', 'Energy, lifetime (kWh)'],
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
    if (metricSel.value !== 'energy_d') return;
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
  bar.appendChild(refresh); bar.appendChild(el('label', { class: 'ld-inst' }, 'Show ', metricSel)); bar.appendChild(instSel.wrap); bar.appendChild(count); bar.appendChild(dayNote);
  // Picking a whole day asks an energy question — power at 23:59:59 of a day gone by says almost nothing —
  let hadDay = false;
  const hist = historyControl((what     ) => {
    periods.mark(null);
    // Only on the way out of live.
    const leftLive = what === 'day' && !hadDay && !!hist.day();
    hadDay = !!hist.day();
    // Only the daily total can be added across days, so asking for a span asks for that metric.
    if ((leftLive && !hist.time() && metricSel.value === 'realpower') || (what === 'span' && hist.span() > 1)) {
      if (metricSel.value !== 'energy_d') metricSel.value = 'energy_d';
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
    if (metricSel.value !== 'energy_d') { metricSel.value = 'energy_d'; showDayNote(); }
    periods.mark(key);
    hadDay = true;
    load();
  });
  // Each of these was its own full-width row with a margin under it, so five rows of controls stacked down
  // the page while each used about a quarter of the line. They are one wrapping strip: side by side where
  // there is room, folding onto more lines where there is not.
  const controlsTop = el('div', { class: 'flow-controls' });
  controlsTop.append(bar, periods.row, hist.row);
  sec.appendChild(controlsTop);
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
  // The menu is the section's, not the drawing's: a redraw that rebuilt it took it out from under the pointer.
  // A live reading arriving while it is open is held, and drawn when it closes — the diagram holds still while
  // someone is reading a menu over it.
  let stage      = null;
  let heldGraph      = null;
  const menu = makeMenu(() => stage, 'ctx-menu', () => {
    const held = heldGraph;
    heldGraph = null;
    if (held) { lastGraph = held; draw(held); }
  });

  const draw = (graph     ) => {
    // A refresh rebuilds the whole diagram, and emptying a container as tall as this one collapses the
    // page. Any layout read while it is empty — and the pane measurement below is one — makes the browser
    // clamp the scroll position to the shrunken height, so a refresh threw the reader back to the top.
    // Holding the height across the rebuild means the page never shrinks and nothing is clamped.
    const held = (wrap       ).offsetHeight || 0;
    if (held) wrap.style.minHeight = held + 'px';
    // Measured before the clear, off a container that is not emptied, so the reading is of a laid-out page.
    const paneW = Math.round(Number((sec       ).clientWidth) || Number((wrap       ).clientWidth) || 0);
    wrap.innerHTML = '';
    ensureGroupState();
    // Fold collapsed groups into single nodes before laying out; the toggle strip re-draws on change.
    const collapsed = collapseGraph((graph.nodes || []).slice(), (graph.links || []).slice());
    // ...then substitute the members for the anchor on any group left expanded.
    const expanded = explodeExpandedGroups(collapsed.nodes, collapsed.links);
    // ...then honour the unmetered-remainder view switch...
    const shown = applyUnmeasuredPref(expanded.nodes, expanded.links);
    // ...and finally drop the branches carrying nothing, if that switch is on.
    const emptied = applyHideEmptyPref(shown.nodes, shown.links);
    // ...and the nodes nothing measures, if that one is on; how many went is said beside the count.
    const folded = applyHideNoDataPref(emptied.nodes, emptied.links);
    const controls = el('div', { class: 'flow-controls' });
    wrap.appendChild(controls);
    const toggles = groupToggles(redrawBoth);
    if (toggles) controls.appendChild(toggles);
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

    // The vertical gap between two rows in a column. Text is kept apart by each row being at least a label
    // line tall (`labelRow`), so this only separates bars; at 14 it doubled every small node's height, and a
    // column of thirty circuits was mostly empty space.
    const gap = 6;
    // The diagram used to be a fixed 960px, so on a wide pane it sat in the left two-thirds with the rest
    // empty. The zoom's fit only ever shrinks — growing by zoom would scale the 11px labels along with it,
    // which is not more information, only bigger. Laying out to the pane spreads the columns and leaves the
    // text where it is. Where the width cannot be measured (the DOM stub the checks run against) it falls
    // back to 960, so the geometry those checks pin is unchanged.
    const W = Math.max(960, Math.min(paneW ? paneW - 8 : 960, 2400));
    const padTop = 22, nodeW = 12, usableH = 520;
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
    // Every node's label needs a full text line, whatever its bar height: 11px text and its 3px halo.
    const labelRow = 14;

    /// Where a node's name is drawn: the middle of the ribbons it sends.
    ///
    /// Usually that is the middle of the bar. It is not for a node that passes on much less than it
    /// receives — a panel whose unmetered load is switched off — and the label sits to the right of the
    /// bar among those outgoing ribbons, so it follows them rather than the bar.
    const labelY = (id        , p     ) => {
      const out = stackTotal(id, 'out');
      return out > 0 ? p.y + stackStart(id) + out / 2 : p.y + p.h / 2;
    };
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

    // Both barycenters are Infinity for a node with nothing on that side, and `Infinity - Infinity` is NaN
    // — a falsy comparator result, so the whole column fell through to "biggest first" and lost the
    // grouping the other pass had just established. Two unknowns have to TIE, not compare as nonsense:
    // that is what put a sub-panel's minisplit in the middle of the main panel's circuits, and left a
    // panel's own remainder at the far bottom of the chart with a ribbon crossing everything to reach it.
    const cmp = (x        , y        ) => x === y ? 0 : x - y;

    // Ties break the same way wherever the barycenters agree: a remainder below its siblings, then biggest
    // first. Spelled once so the two directions cannot drift apart.
    const tieBreak = (a     , b     ) => (remainder(a.id) - remainder(b.id)) || (nodeValue(b.id) - nodeValue(a.id));

    // Sweep both ways until the order settles.
    //
    // One pass each way is not enough, because a column is ordered against its neighbour's CURRENT
    // positions and the neighbour may still move. Live: the circuits were ordered while the sub-panel sat
    // above the main panel, then the panels swapped — leaving each panel's circuits split around the
    // other's, with ribbons crossing the whole chart to reach them. Sweeping lets both settle against each
    // other. Four is well past the point these hierarchies stop changing, and it stops early when nothing
    // moved.
    const orderOf = () => cols.map(cn => (cn || []).map((n     ) => n.id).join(',')).join('|');
    for (let sweep = 0; sweep < 4; sweep++) {
      const before = orderOf();
      // Forward: roots stack by size, downstream columns follow their feeders.
      cols.forEach((cn, c) => {
        if (c === 0) { if (sweep === 0) cn.sort((a     , b     ) => tieBreak(a, b)); }
        else cn.sort((a     , b     ) => cmp(bary(a.id), bary(b.id)) || tieBreak(a, b));
        placeColumn(cn, c);
      });
      // Backward: right-to-left, ordering each column by what it feeds — but WITHIN its family, never
      // across families. Which parent a node hangs off decides where it sits; what it feeds only decides
      // the order among its own siblings.
      //
      // Leading with what a node feeds is what tore each panel's circuits apart: the two circuits that go
      // on to feed rack PDUs were pulled to the top of the column by them, while their four siblings —
      // having nothing downstream to be pulled by — fell to the bottom, with the other panel's circuits
      // stacked in between and ribbons crossing the whole chart. Siblings first, then their order.
      for (let c = cols.length - 2; c >= 0; c--) {
        if (!cols[c]) continue;
        cols[c].sort((a     , b     ) => cmp(bary(a.id), bary(b.id)) || cmp(obary(a.id), obary(b.id)) || tieBreak(a, b));
        placeColumn(cols[c], c);
      }
      if (orderOf() === before) break;
    }
    // Re-place left-to-right in the settled order so every column shares one top edge and the offsets reset.
    let bottom = padTop;
    cols.forEach((cn, c) => { bottom = Math.max(bottom, placeColumn(cn, c)); });

    // Then slide each column bodily down to meet what it feeds.
    /// Where each ribbon actually meets each bar, in the order they are drawn.
    ///
    /// How thick a ribbon is drawn: its value, or a hairline where there is nothing to scale.
    const ribbonH = (l     ) => (l.known === false || l.value * pxPerUnit < 1.5) ? 1.5 : l.value * pxPerUnit;

    /// Where a node's ribbons begin stacking on its bar.
    ///
    /// They used to stack from the TOP. A bar is as tall as what passes THROUGH the node, so a node that
    /// carries more than it hands on keeps every one of its ribbons in the top slice of its own bar: an
    /// inverter reading 12.1 kW but sending 3.3 kW to two panels attached all of it in the top quarter of a
    /// 520px bar. Everything downstream is then pulled up there with it — which is how a sub-panel ended up
    /// sitting in the middle of the other panel's fan, with all of its own ribbons crossing that fan to
    /// reach its circuits. Centred, the ribbons sit where the bar is.
    const stackTotal = (id        , side              ) =>
      (((side === 'out' ? outgoing[id] : incoming[id]) || [])         )
        .reduce((sum        , l     ) => sum + ribbonH(l), 0);

    const stackStart = (id        ) => {
      // ONE offset for both sides, from whichever side carries more.
      //
      // Centring each side on the bar independently lines up their CENTRES, not their tops — so a node
      // passing on a little less than it receives had its outgoing stack start a few pixels lower than its
      // incoming one, and the top edge of a chain stepped down at every node. Sharing the offset lines up
      // the tops, which is what makes a run of ribbons carrying the same power read as one flat band.
      const larger = Math.max(stackTotal(id, 'out'), stackTotal(id, 'in'));
      return Math.max(0, ((pos[id]?.h ?? 0) - larger) / 2);
    };

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
          const h = ribbonH(l);
          const so = outOff[l.source] ?? stackStart(l.source);
          const to = inOff[l.target] ?? stackStart(l.target);
          at.set(l, { from: sp.y + so + h / 2, to: tp.y + to + h / 2 });
          outOff[l.source] = so + h;
          inOff[l.target] = to + h;
        });
      return at;
    };

    /// The row a node occupies: its bar, or a full line of text where the bar is shorter than one.
    const rowOf = (id        ) => Math.max(pos[id].h, labelRow);

    /// Push a column apart until no two rows are closer than `gap`, keeping the settled order.
    ///
    /// Moving nodes individually is what makes crossings avoidable, and it is also what lets two of them
    /// land on top of each other — so every move is followed by this. Order is never changed here: the
    /// ordering passes decided it, and re-sorting by position would undo the grouping they established.
    const separate = (cn       ) => {
      let y = padTop;
      cn.forEach((n     ) => {
        if (pos[n.id].y < y) pos[n.id].y = y;
        y = pos[n.id].y + rowOf(n.id) + gap;
      });
      // Ran off the bottom: walk back up, which can only compress the slack this pass introduced.
      const foot = y - gap;
      if (foot > padTop + usableH) {
        let limit = foot - (foot - (padTop + usableH));
        for (let i = cn.length - 1; i >= 0; i--) {
          const id = cn[i].id;
          if (pos[id].y + rowOf(id) > limit) pos[id].y = limit - rowOf(id);
          limit = pos[id].y - gap;
        }
        let top = padTop;   // and never above the top margin
        cn.forEach((n     ) => {
          if (pos[n.id].y < top) pos[n.id].y = top;
          top = pos[n.id].y + rowOf(n.id) + gap;
        });
      }
    };

    /// Slide each node in a column onto the centre of the ribbons it exchanges with its neighbour.
    ///
    /// Whole columns used to move as one, which cannot fix a mismatch INSIDE a column — and that is where
    /// the crossings were: a sub-panel's bar sat above some of the main panel's own circuits, so every
    /// ribbon it sent had to cut across them to reach its children. Each bar now settles against the
    /// ribbons it actually carries.
    const relaxColumn = (c        , side              ) => {
      const cn = cols[c];
      if (!cn || !cn.length) return;
      const at = attachments();
      cn.forEach((n     ) => {
        // A node that feeds something is placed by WHAT IT FEEDS; one that feeds nothing, by its feeder.
        // Letting both sides pull every node makes them fight and neither wins: an inverter's two ribbons
        // are contiguous on its bar, while the panels they land on have to sit far enough apart for their
        // own circuits — so a panel dragged back towards the inverter ends up in the middle of the other
        // panel's fan. Ribbons are allowed to diverge; bars are not allowed to overlap someone else's.
        const feeds = ((outgoing[n.id] || [])         ).length > 0;
        if (side === 'out' ? !feeds : feeds) return;
        const links = ((side === 'out' ? outgoing[n.id] : incoming[n.id]) || [])
          .map((l     ) => at.get(l)).filter(Boolean);
        if (!links.length) return;
        // The TOP of the band its ribbons reach, against the top of the band they leave from — not their
        // flow-weighted centre, and not the middle of either band. Weighting by flow lets one dominant
        // ribbon pin the node in place while its small siblings sprawl: a 2 kW panel whose seven circuits
        // span 190px never moved, because its 612 W ribbon was already straight, and the sub-panel below
        // it ended up sitting in the middle of that fan with every one of its own ribbons cutting through
        // it. Aiming at the middles fixed that and tilted the whole diagram instead: a node's own ribbons
        // stack by flow, while the nodes they reach are spread by the row minimum and the gap, so the far
        // band is the taller of the two and its middle sits lower. Every column absorbed one more step of
        // that. The tops are the two points that carry the same quantity, so they are what line up.
        const theirs = links.map((a     ) => side === 'out' ? a.to : a.from);
        const mine = links.map((a     ) => side === 'out' ? a.from : a.to);
        const head = (xs          ) => Math.min(...xs);
        pos[n.id].y += head(theirs) - head(mine);
      });
      separate(cn);
    };

    // Sweep both ways a few times: a column settles against neighbours that are themselves still settling,
    // so one pass is never enough. This converges quickly and the separation step keeps every pass legal.
    for (let pass = 0; pass < 6; pass++) {
      for (let c = cols.length - 2; c >= 0; c--) relaxColumn(c, 'out');
      for (let c = 1; c < cols.length; c++) relaxColumn(c, 'in');
    }
    cols.forEach((cn       ) => { if (cn && cn.length) separate(cn); });
    bottom = Math.max(bottom, ...cols.filter(Boolean).flatMap((cn       ) => cn.map((n     ) => pos[n.id].y + rowOf(n.id))));

    // Fit the viewBox to the tallest column (stacking gaps push it past usableH), so nothing clips.
    const totalH = Math.ceil(Math.max(padTop + usableH, bottom)) + padTop;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${totalH}`, width: W, height: totalH, class: 'sankey-svg', style: 'display:block' });
    const colors = ['#49f', '#4f9', '#fa4', '#f49', '#9f4', '#4ff', '#f94', '#a9f'];
    const tintOf = (id        ) => colors[colMemo[id] % colors.length];
    // Clicking the empty canvas is the natural "never mind"; a redraw starts unfocused either way.
    svg.addEventListener('click', () => { menu.close(); clearFocus(svg); });
    focusedNode = null;

    /// What a right-click on bare canvas offers: the whole diagram rather than one node.
    svg.addEventListener('contextmenu', (e     ) => {
      e.preventDefault?.();
      menu.open(e, [
        { label: 'The diagram', head: true },
        { label: 'Clear the trace', disabled: !focusedNode, run: () => clearFocus(svg) },
        { label: 'Fit it to the page', run: () => (zoom       )?.fit?.() },
        { label: 'Read it again now', run: () => load() },
      ]);
    });

    /// What a right-click offers over a node: what it has been drawing, where its supply comes from, and
    /// the node itself. A history is only worth offering for something the bridge actually reads.
    const nodeMenu = (e     , n     ) => {
      e.preventDefault?.();
      e.stopPropagation?.();
      const named = n.label || n.id;
      menu.open(e, [
        { label: named, head: true },
        {
          label: 'History…',
          run: () => openHistorySheet({
            title: named,
            nodes: [n.id],
            lineLabel: named,
            labelOf: (id        ) => byId[id]?.label || id,
            metric: metricSel.value,
            empty: 'Nothing is measuring this node, so there is nothing to chart.',
            // What it feeds, each on a strip of its own: where a tier's power went, over the same window.
            parts: (outgoing[n.id] || []).map((l     ) => l.target),
            partsLabel: 'What it feeds',
          }),
        },
        { label: 'Trace its supply', run: () => focusPath(svg, incoming, n.id) },
        { label: 'Clear the trace', run: () => clearFocus(svg) },
        {
          label: 'Edit this node',
          // Only a node of the config has an editor; a PDU or outlet the bridge derives has none.
          disabled: !(state.data?.EnergyFlow?.Nodes || []).some((x     ) => x.Id === n.id),
          run: () => {
            editNodeOnNextOpen(n.id);
            (Array.from(document.querySelectorAll('nav a'))         ).find(a => a.dataset.label === 'Nodes')?.click();
          },
        },
      ]);
    };

    /// Every ribbon crossing a corridor turns on the SAME vertical axis, and turns through the same width.
    ///
    /// Both halves of that are the rule, and neither works alone. Letting each band turn half of its own
    /// thickness from the middle puts a thick ribbon's corners in a different place from a thin one's, and
    /// their corners interlock — a row of notches reading as puzzle pieces. Giving each band a lane of its
    /// own instead spreads the turns across the whole corridor, and the column of ribbons comes out as a
    /// staircase. One axis and one width is the only arrangement where every vertical edge in a corridor
    /// falls on one of two lines.
    ///
    /// A band thicker than the run narrows through the turn and widens again after it; a thinner one does
    /// the reverse. That is the price of the rule, and it is the rule that was asked for.
    const laneOf = new Map                                       ();
    {
      const corridors = new Map               ();
      links.forEach((l     ) => {
        const s2 = pos[l.source], t2 = pos[l.target];
        if (!s2 || !t2) return;
        const key = `${s2.x + nodeW}|${t2.x}`;
        (corridors.get(key) ?? corridors.set(key, []).get(key) ).push(l);
      });
      for (const [key, list] of corridors) {
        const [left, right] = key.split('|').map(Number);
        // A quarter of the corridor, bounded either side so it is neither a hairline nor a slab.
        const laneW = Math.max(12, Math.min(40, (right - left) * 0.25));
        const laneX = (left + right) / 2;
        list.forEach((l     ) => laneOf.set(l, { laneX, laneW }));
      }
    }

    // Ribbons (filled bands). Each node's stack begins where the layout put it, not at the bar's top.
    nodes.forEach((n     ) => {
      if (!pos[n.id]) return;
      pos[n.id].outOff = stackStart(n.id);
      pos[n.id].inOff = stackStart(n.id);
    });
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
      const x1 = s.x + nodeW, x2 = t.x;
      const sTop = s.y + s.outOff, tTop = t.y + t.inOff;
      const color = tintOf(l.source);
      const band = { x1, sTop, x2, tTop, h, ...(laneOf.get(l) ?? {}) };
      const ribbonPath = ribbonOutline(ribbonStyle, band);
      svg.appendChild(svgEl('path', {
        d: ribbonPath,
        fill: unknownLink ? 'var(--muted)' : color,
        // A hairline at ribbon opacity is invisible; lift it so an idle branch still reads as connected.
        'fill-opacity': unknownLink ? '0.35' : idleLink ? '0.55' : '0.3',
        class: 'flow-ribbon',
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
          const stream = svgEl('path', {
            d: lanePath(ribbonStyle, band, f),
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
        fill: unknownNode ? 'var(--muted)' : tintOf(n.id),
        'fill-opacity': unknownNode ? '0.45' : '1',
        'data-node': n.id,
      });
      svg.appendChild(rect);
      const lab = svgEl('text', {
        x: p.x + nodeW + 6, y: labelY(n.id, p), fill: 'var(--fg)', 'font-size': '11', 'font-weight': n.kind === 'outlet' ? '400' : '600',
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
        : `${n.label} · ${formatMeasure(nodeValue(n.id), units)}${inferredNode ? ' · inferred' : ''}`;
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
          ? `This node reports ${formatMeasure(reading, units)}, but ${formatMeasure(reading + n.imbalance, units)} `
            + `passes through it — ${formatMeasure(n.imbalance, units)} more than it accounts for. Its sensor is `
            + 'probably measuring one leg rather than the whole node (an inverter bound to its AC-load output '
            + 'while it also charges a battery), or a source is scaled wrongly. The bar is drawn to the '
            + 'throughput so the ribbons fit; the label is the reading.'
          : `This node passes ${formatMeasure(reading, units)} to what it feeds, but only `
            + `${formatMeasure(reading - n.imbalance, units)} arrives from its feeders — a shortfall of `
            + `${formatMeasure(n.imbalance, units)}, which no supply accounts for.`
            + (metricSel.value === 'energy'
              ? ' On lifetime energy this is expected: these counters started at different times and cannot be compared. Switch to "Energy Daily", where every figure covers the same window.'
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
          unknownNode ? 'no data' : formatMeasure(nodeValue(n.id), units),
          el('span', { class: 'nh-metric', text: ' ' + metricLabel(metricSel.value).toLowerCase() })));
        // Provenance sits with the value, not in a legend somewhere else.
        if (!unknownNode && n.derivation && n.derivation !== 'measured')
          rows.push(el('div', { class: n.derivation === 'inferred' ? 'nh-warn' : 'desc', style: { margin: '2px 0 0' } },
            n.derivation === 'inferred'
              ? 'inferred — nothing measures this; conservation leaves one path it could have come by'
              : 'summed from what it feeds'));
        if (n.imbalance != null)
          rows.push(el('div', { class: 'nh-warn', text: `${formatMeasure(n.imbalance, units)} more leaves than arrives` }));
        // A sensor on one leg of a bidirectional device.
        if (n.throughput != null)
          rows.push(el('div', { class: 'desc', style: { margin: '2px 0 0' },
            text: `its sensor covers this leg; ${formatMeasure(n.throughput, units)} passes through the node` }));

        const side = (title        , ls       , other                    ) => {
          if (!ls.length) return;
          rows.push(el('div', { class: 'nh-head', text: title }));
          ls.forEach((l     ) => rows.push(el('div', { class: 'nh-row' },
            el('span', { class: 'nh-name', text: byId[other(l)]?.label || other(l) }),
            el('span', { class: 'nh-num', text: l.known === false ? '—' : formatMeasure(l.value, units) }))));
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
        elm.addEventListener('contextmenu', (e     ) => nodeMenu(e, n));
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
      + (unknownCount ? ` · ${unknownCount} with no data` : '')
      + (folded.hidden ? ` · ${folded.hidden} with no data hidden` : '');
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
      controls.appendChild(tagRow);
      // Re-apply across the live repaint, so the selection survives a push.
      if (activeTag) focusTag(svg, taggedById, activeTag);
    }

    if (withheldSources.length) wrap.appendChild(withheldBanner(withheldSources));
    if (contradicted.length) wrap.appendChild(contradictionBanner(contradicted, (id) => focusPath(svg, incoming, id)));

    // No height cap: the diagram is the whole page, so it grows to its own height and the page scrolls once
    // — a pane capped at 74vh put a scrollbar inside a scrollbar and made the graph feel like an iframe.
    const scroll = el('div', { style: { overflow: 'auto', border: '1px solid var(--line)', borderRadius: '6px' } });
    scroll.appendChild(svg);
    stage = el('div', { class: 'flow-stage' }, scroll, menu.el);
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
    // The new content carries its own height now, so stop holding the old one.
    wrap.style.minHeight = '';
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
      + 'Draw the diagram with Show → “Energy Daily”.'));

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
          : 'Daily totals are off, so “Energy Daily” has nothing to draw.');
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

    ed.appendChild(el('div', { class: 'desc', text: 'Drag a node onto another to set what feeds it — the one you drop on becomes its feeder, replacing what it had. Drag from a node’s right ● onto another node to add a feed alongside any it already has (source powers target); click ✕ on a link to remove it. Double-click a custom node to rename it. PDU → outlet links are auto-derived (dashed) until you wire an explicit feeder. Add and configure nodes on the Nodes tab.' }));

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
      // Only children already placed count. A cycle (a config wired by hand, or an older build) leaves one
      // unplaced, and a NaN column put the node in no column at all — every later lookup of its position
      // was undefined and the page threw instead of drawing.
      const placed = outs.map((e     ) => colX[e.to]).filter((c     ) => typeof c === 'number');
      colX[id] = placed.length ? Math.max(0, Math.min(...placed) - 1) : colMemo[id];
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
    ed.appendChild(el('div', { class: 'desc', style: { margin: '4px 2px 0', fontSize: '11px' }, text: 'Drag the canvas background to pan · scroll to move · Ctrl/⌘ + scroll to zoom · drag a node onto another to set its feeder · drag a node’s ● onto another to add a feed.' }));
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
      if (!a || !b) return;   // nothing to draw between a node that was never placed
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
    // Screen → diagram coordinates. Falls back to the screen point where the browser cannot say (no CTM),
    // which only costs the rubber-band line its exact anchor.
    const toUser = (cx        , cy        ) => {
      try { return new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse()); } catch { return { x: cx, y: cy }; }
    };
    let linkFrom      = null, tempLine      = null, hovered      = null;
    // Dragging a node itself, to drop it on whatever should feed it.
    let dragNode      = null, dragFrom      = null, dragging = false, dragLine      = null;
    // Drag the empty canvas to pan, engaging past a small threshold so a click on a node still registers.
    let panStart      = null, panning = false;
    scroll.style.cursor = 'grab';
    const highlight = (id     ) => {
      if (id === hovered) return;
      if (hovered && nodeG[hovered]) { const rc = nodeG[hovered].querySelector('rect'); rc.setAttribute('stroke', colors[col(hovered) % colors.length]); rc.setAttribute('stroke-width', '2'); }
      hovered = id;
      if (hovered && nodeG[hovered]) { const rc = nodeG[hovered].querySelector('rect'); rc.setAttribute('stroke', '#46c46a'); rc.setAttribute('stroke-width', '3'); }
    };
    const targetUnder = (cx        , cy        , self      ) => { const hit      = document.elementFromPoint(cx, cy); const gn = hit && hit.closest && hit.closest('g[data-id]'); return gn && gn.dataset.id !== (self ?? linkFrom) ? gn.dataset.id : null; };

    /// Make `parent` what feeds `child`, in place of whatever fed it before.
    ///
    /// Dropping a node on another says "this is where it comes from", so it replaces rather than adds —
    /// an extra feeder is the ● drag. Replacing is destructive, so existing wiring is named and confirmed.
    const setParent = (child        , parent        ) => {
      if (child === parent) return;
      if (feedsNothing((cand.get(parent) || {}).kind)) {
        toast(`${nm(parent)} is a load, and a load does not feed anything. If it is a circuit that feeds ${nm(child)}, set its kind to Breaker.`, false);
        return;
      }
      if (reaches(child, parent)) { toast(`${nm(parent)} is already downstream of ${nm(child)} — that would be a loop.`, false); return; }
      if (links.some((l     ) => l.From === parent && l.To === child)) { toast(`${nm(parent)} already feeds ${nm(child)}.`, false); return; }

      const existing = links.filter((l     ) => l.To === child);
      if (existing.length && !confirm(
        `${nm(child)} is already fed by ${existing.map((l     ) => nm(l.From)).join(', ')}.\n\n`
        + `Replace that with ${nm(parent)}?\n\n`
        + `To keep both, cancel and drag ${nm(parent)}’s ● onto ${nm(child)} instead.`)) return;
      existing.forEach((l     ) => { const i = links.indexOf(l); if (i >= 0) links.splice(i, 1); });

      const derived = autoParent(child);
      links.push({ From: parent, To: child });
      toast(existing.length ? `${nm(parent)} now feeds ${nm(child)}, in place of ${existing.map((l     ) => nm(l.From)).join(', ')}.`
          : derived && derived !== parent ? `${nm(parent)} now feeds ${nm(child)}, in place of the derived ${nm(derived)} link.`
          : `${nm(parent)} now feeds ${nm(child)}.`, true);
      renderEditor();
    };
    const onDown = (e     ) => {
      const portId = e.target.getAttribute && e.target.getAttribute('data-port');
      const rmId = e.target.getAttribute && e.target.getAttribute('data-rm');
      if (rmId) { const i = customNodes.findIndex((n     ) => n.Id === rmId); if (i >= 0) customNodes.splice(i, 1); for (let j = links.length - 1; j >= 0; j--) if (links[j].From === rmId || links[j].To === rmId) links.splice(j, 1); renderEditor(); return; }
      if (portId) { linkFrom = portId; tempLine = svgEl('path', { d: '', fill: 'none', stroke: '#5ab0ff', 'stroke-width': 2, 'stroke-dasharray': '4 3', 'pointer-events': 'none' }); edgeLayer.appendChild(tempLine); e.preventDefault(); return; }
      // The node body: dragging it asks what feeds it. Engaged past a threshold below, so a click still
      // clicks and a double-click still renames.
      const onNode = e.target.closest ? e.target.closest('g[data-id]') : null;
      if (onNode && onNode.dataset && onNode.dataset.id) {
        dragNode = onNode.dataset.id;
        dragFrom = { x: e.clientX, y: e.clientY };
        e.preventDefault();
        return;
      }
      // Anything else (background, a node body, a label): a potential pan.
      panStart = { x: e.clientX, y: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
      e.preventDefault();   // don't rubber-band-select node labels while dragging
    };
    const onMove = (e     ) => {
      if (dragNode) {
        if (!dragging && Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) <= 4) return;
        if (!dragging) {
          dragging = true;
          scroll.style.cursor = 'grabbing';
          dragLine = svgEl('path', { d: '', fill: 'none', stroke: '#46c46a', 'stroke-width': 2, 'stroke-dasharray': '4 3', 'pointer-events': 'none' });
          edgeLayer.appendChild(dragLine);
        }
        const u = toUser(e.clientX, e.clientY), a = pos[dragNode];
        // Drawn the way the feed will run: from where it would come from, into this node's left edge.
        dragLine.setAttribute('d', `M${u.x},${u.y} L${a.x},${a.y + NH / 2}`);
        highlight(targetUnder(e.clientX, e.clientY, dragNode));
        return;
      }
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
      if (dragNode) {
        const child = dragNode, tgt = dragging ? targetUnder(e.clientX, e.clientY, dragNode) : null;
        if (dragLine) dragLine.remove();
        dragLine = null; dragNode = null; dragging = false;
        scroll.style.cursor = 'grab';
        highlight(null);
        if (tgt) setParent(child, tgt);
        return;
      }
      if (panStart) { const wasPanning = panning; panStart = null; panning = false; scroll.style.cursor = 'grab'; if (wasPanning) return; }
      if (!linkFrom) return;
      const src = linkFrom, tgt = targetUnder(e.clientX, e.clientY);
      if (tempLine) tempLine.remove(); linkFrom = null; highlight(null);
      if (!tgt || src === tgt) return;
      if (feedsNothing((cand.get(src) || {}).kind)) { toast(`${nm(src)} is a load, and a load does not feed anything. If it is a circuit, set its kind to Breaker.`, false); return; }
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
    (body     ) => {
      if (hist.day() || !body || !body.ok) return;
      // Held rather than dropped: whatever arrived last is drawn as soon as the menu closes.
      if (menu.isOpen()) { heldGraph = body; return; }
      lastGraph = body;
      draw(body);
    });
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

/// Every feed on the EmonCMS server, fetched once per page and shared by every binding's picker.
///
/// One request rather than one per row: a node with eight bindings would otherwise ask the server for the
/// same list eight times the moment its editor opened.
let emonFeeds                        = null;
function emonCmsFeeds(force = false)                 {
  if (force || !emonFeeds) {
    // The route wraps a handler's answer as { ok, result }, so the feeds are one level in.
    emonFeeds = api('/api/integrations/emoncms-source/feeds', { method: 'POST' })
      .then(r => (r.body?.result?.feeds || [])         )
      .catch(() => []         );
  }
  return emonFeeds;
}

/// Pick a feed off the server rather than typing a name from another browser tab.
function openEmonCmsPicker(current        , onPick                     ) {
  const { body, close } = overlay('Browse EmonCMS feeds');
  body.appendChild(el('div', { class: 'desc', text: 'Feeds on the EmonCMS server this bridge is configured for, with their latest value. Picking one stores its name — or its id, when the name is not unique.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const search = el('input', { type: 'search', value: current || '', placeholder: 'filter by name or tag…', style: { width: '320px' } })                    ;
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(search, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Tag', 'Feed', 'Latest', 'Updated', ''].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const draw = (feeds       ) => {
    const q = search.value.trim().toLowerCase();
    const shown = feeds.filter(f => !q || (f.name || '').toLowerCase().includes(q) || (f.tag || '').toLowerCase().includes(q));
    // A name that exists under several tags cannot be stored as a bare name, so the row that offers it
    // stores the id instead — the ambiguity is settled here rather than reported later as a missing value.
    const counts = new Map                ();
    feeds.forEach(f => counts.set(f.name, (counts.get(f.name) || 0) + 1));

    status.textContent = `${shown.length} of ${feeds.length} feed(s)`;
    tbody.innerHTML = '';
    shown.slice(0, 300).forEach(f => {
      const tr = el('tr');
      tr.appendChild(el('td', { text: f.tag || '—' }));
      tr.appendChild(el('td', {}, el('code', { text: f.name })));
      tr.appendChild(el('td', { class: 'num', text: f.value != null ? formatNum(f.value) + (f.unit ? ' ' + f.unit : '') : '—' }));
      tr.appendChild(el('td', { class: 'desc', text: f.at ? new Date(f.at).toLocaleString() : 'never' }));
      const use = btn('Use', 'primary');
      if ((counts.get(f.name) || 0) > 1) use.title = `Several feeds are called “${f.name}”, so this stores its id (${f.id}).`;
      use.onclick = () => { onPick(f); close(); };
      tr.appendChild(el('td', {}, use));
      tbody.appendChild(tr);
    });
    if (!feeds.length)
      tbody.appendChild(el('tr', {}, el('td', { colspan: '5', class: 'desc',
        text: 'No feeds came back. Check that EmonCMS.Url and an API key that can read feeds are set, then use Test on the EmonCMS feeds card.' })));
  };

  emonCmsFeeds().then(draw);
  search.oninput = () => emonCmsFeeds().then(draw);
}

/// The Source and Details cells for an EmonCMS binding: which feed, and what it currently reads.
function emonCmsSourceEditor(src     , onChange            )             {
  const feedIn = el('input', { type: 'text', value: src.Feed || '', placeholder: 'feed name or id', style: { width: '220px' } })                    ;
  feedIn.title = 'The feed to read: its name (e.g. 1_power), tag/name when the name is not unique, or its numeric id.';
  feedIn.onchange = () => { src.Feed = feedIn.value.trim() || undefined; onChange(); redraw(); };

  const browse = btn('Browse…');
  browse.title = 'List the feeds on the EmonCMS server and pick one.';
  browse.onclick = () => openEmonCmsPicker(feedIn.value.trim(), f => {
    // Stored by name where the name identifies it, so the binding survives a re-provision that renumbers
    // the feed; by id only where a name would be ambiguous.
    emonCmsFeeds().then(all => {
      const dupes = all.filter(o => o.name === f.name).length > 1;
      feedIn.value = dupes ? String(f.id) : f.name;
      src.Feed = feedIn.value;
      onChange();
      redraw();
    });
  });

  // What the named feed reads right now, so a wrong name is obvious here instead of as a blank node later.
  const detail = el('div', { class: 'desc', style: { margin: '0' }, text: '' });
  const redraw = () => {
    const wanted = (src.Feed || '').trim();
    if (!wanted) { detail.textContent = 'No feed chosen — this binding will supply nothing.'; detail.style.color = 'var(--muted)'; return; }
    emonCmsFeeds().then(all => {
      const matches = all.filter(f => String(f.id) === wanted || f.name === wanted || `${f.tag}/${f.name}` === wanted);
      if (!matches.length) {
        detail.style.color = 'var(--bad)';
        detail.textContent = all.length
          ? `No feed on the server is called “${wanted}”.`
          : 'Could not list the server’s feeds, so this name cannot be checked here.';
        return;
      }
      if (matches.length > 1) {
        detail.style.color = 'var(--bad)';
        detail.textContent = `“${wanted}” names ${matches.length} feeds (${matches.map(f => `${f.tag}/${f.name}`).join(', ')}). Use its tag, or its id.`;
        return;
      }
      const f = matches[0];
      detail.style.color = 'var(--muted)';
      detail.textContent = (f.value != null ? `${formatNum(f.value)}${f.unit ? ' ' + f.unit : ''}` : 'no value logged yet')
        + (f.at ? ` · ${new Date(f.at).toLocaleString()}` : '');
    });
  };
  redraw();

  return [el('td', {}, feedIn, ' ', browse), el('td', {}, detail)];
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

  // Where it is and which circuit it is plugged into (#461, #465).
  const locSel = choiceSelect(locationChoices(), node.Location || '', '— not placed —');
  locSel.onchange = () => { node.Location = locSel.value || undefined; };
  grid.appendChild(field('Location', locSel, 'The room, area, floor or site it is in. Its consumption counts there on the Floor Plans page.'));
  const circSel = choiceSelect(circuitChoices(), node.Circuit || '', '— not known —');
  circSel.onchange = () => { node.Circuit = circSel.value || undefined; };
  grid.appendChild(field('Circuit', circSel, 'The breaker it is plugged into. The circuit then counts it among its metered devices and reports what is left unmetered.'));

  // Where this node's EmonCMS feeds are filed; blank uses the EmonCMS page's tags.
  const emonTag = el('input', { type: 'text', value: node.EmonCmsTag || '', placeholder: 'EmonCMS default' })                    ;
  emonTag.onchange = () => { node.EmonCmsTag = emonTag.value.trim() || undefined; };
  grid.appendChild(field('EmonCMS tag', emonTag, 'Tag this node’s EmonCMS feeds are filed under. Blank uses the EmonCMS page’s. {node}, {label} and {kind} are filled in.'));
  const emonVirtualTag = el('input', { type: 'text', value: node.EmonCmsVirtualTag || '', placeholder: 'EmonCMS default' })                    ;
  emonVirtualTag.onchange = () => { node.EmonCmsVirtualTag = emonVirtualTag.value.trim() || undefined; };
  grid.appendChild(field('EmonCMS virtual-feed tag', emonVirtualTag, 'Tag this node’s EmonCMS virtual feeds are filed under. Blank uses the EmonCMS page’s.'));

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
      else if (type === 'emoncms') {
        // Source = which feed; Details = what that feed currently reads, so a mapping can be checked
        // against the server before it is wired into the flow.
        const [srcCell, detailCell] = emonCmsSourceEditor(src, () => refreshDirty());
        tr.appendChild(srcCell);
        tr.appendChild(detailCell);
      }
      else if (sourceEditorFor(type)) {
        // A type that registered a bespoke editor. This used to fall through to the MQTT branch and draw a
        // topic box, so registering one had no effect at all.
        const [srcCell, detailCell] = sourceEditorFor(type) (src, () => refreshDirty());
        tr.appendChild(srcCell);
        tr.appendChild(detailCell);
      }
      else if (type !== 'mqtt' && type !== 'modbus') {
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
  box.appendChild(el('div', { class: 'desc', text: 'Which nodes feed this one, and which it feeds. The same wiring you can drag on the Flow tab. Loads are not offered as feeders: a load uses power rather than passing it on, and a circuit that feeds other nodes is a Breaker.', style: { margin: '0 0 6px' } }));

  const nm = (id        ) => (cand.get(id) || {}).label || id;
  const addLink = (from        , to        ) => {
    if (from === to || links.some(l => l.From === from && l.To === to)) return;
    if (wouldLoop(links, from, to)) { toast('That would create a feeder loop.', false); return; }
    // A panel is fed from one place. Two feeders split its power across both on the diagram and count a
    // supply that is not there, so the second one is refused rather than quietly wired.
    const already = (cand.get(to) || {}).kind === 'panel' ? links.find(l => l.To === to) : null;
    if (already) { toast(`${nm(to)} is a panel, and a panel is fed from one place — it is already fed by ${nm(already.From)}. Drop that first.`, false); return; }
    links.push({ From: from, To: to });
  };
  const removeLink = (from        , to        ) => { const i = links.findIndex(l => l.From === from && l.To === to); if (i >= 0) links.splice(i, 1); };
  const wireRow = (title        , current          , onAdd                     , onRemove                     , offer                          = () => true) => {
    const row = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', margin: '3px 0' } });
    row.appendChild(el('span', { class: 'desc', style: { margin: '0', minWidth: '64px' }, text: title }));
    current.forEach(other => {
      const chip = el('span', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '1px 8px', fontSize: '12px' } });
      const x = el('span', { text: '✕', style: { cursor: 'pointer', color: 'var(--bad)' } });
      x.onclick = () => { onRemove(other); rerender(); };
      chip.append(nm(other), x); row.appendChild(chip);
    });
    // The picker lists every node in the hierarchy, which on a real install is hundreds of outlets.
    const options = [...cand.keys()].filter(id => id !== node.Id && !current.includes(id) && offer(id)).sort((a, b) => nm(a).localeCompare(nm(b)));
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
  box.appendChild(wireRow('Fed by', links.filter(l => l.To === node.Id).map(l => l.From), o => addLink(o, node.Id), o => removeLink(o, node.Id),
    id => !feedsNothing((cand.get(id) || {}).kind)));
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

// A node another page created, opened in the editor the next time the Nodes page loads.
let editOnOpen                = null;
function editNodeOnNextOpen(id        ) { editOnOpen = id; }

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
function renderNodeManager(flow     , customNodes       , links       , cand                  , editing                       , rerender                           , query = '') {
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Virtual nodes', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'The custom nodes you’ve added (panels, breakers, batteries, producers, a “Total”). Click Edit to set the name, kind, how it’s valued, and bind live values from your broker.' }));

  // What the filter leaves. The node being edited stays whatever is typed, so narrowing the table never
  // closes the editor out from under whoever is using it.
  const q = query.trim().toLowerCase();
  const all = customNodes;
  if (q) {
    const hit = (n     ) => [n.Id, n.Label, n.Kind || 'node', kindMeta(n.Kind)[1], ...(n.Tags || [])]
      .some((v     ) => String(v || '').toLowerCase().includes(q));
    customNodes = all.filter((n     ) => hit(n) || n.Id === editing.id);
    box.appendChild(el('div', { class: 'desc nd-shown', text: `${customNodes.length} of ${all.length} nodes shown` }));
  }

  if (!customNodes.length) {
    if (q) { box.appendChild(el('div', { class: 'desc', text: `Nothing matches “${query.trim()}”.` })); return box; }
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
        // A load uses power rather than passing it on; the feeder already wired stays listed so it still shows.
        .filter(id => id !== n.Id && !String(id).includes('#') && (!feedsNothing((cand.get(id) || {}).kind) || id === incoming[0]))
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
  // A hierarchy of any size is a long table: type to narrow it by id, name, kind or tag.
  const hunt = el('input', { type: 'search', class: 'nd-hunt', placeholder: 'filter by id, name, kind or tag…' })                    ;
  hunt.oninput = () => render();
  const count = document.createElement('span'); count.className = 'ld-count';
  bar.appendChild(instSel.wrap); bar.appendChild(hunt); bar.appendChild(count); sec.appendChild(bar);
  const ed      = document.createElement('div'); ed.style.marginTop = '8px'; sec.appendChild(ed);
  let lastGraph      = null;
  const editing                        = { id: null };

  const render = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const customNodes = ensure(flow, 'Nodes', []);
    const links = ensure(flow, 'Links', []);
    if (editOnOpen) { editing.id = editOnOpen; editOnOpen = null; }
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
    // Groups and the PDU/outlet tag rules have pages of their own: this one is for the nodes.
    const goTo = (label        ) => (document.querySelector(`nav a[data-label="${label}"]`)       )?.click();
    ed.appendChild(el('div', { class: 'desc', style: { margin: '4px 0 0' } },
      el('span', { text: 'Groups are managed on the ' }),
      el('a', { text: 'Groups page', onclick: () => goTo('Groups') }),
      el('span', { text: ', and tags — including the rules that tag PDUs and outlets — on the ' }),
      el('a', { text: 'Tags page', onclick: () => goTo('Tags') }),
      el('span', { text: '.' })));
    ed.appendChild(renderNodeManager(flow, customNodes, links, cand, editing, (close          ) => { if (close) editing.id = null; render(); }, hunt.value));
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

// ── sections/groups.ts ──────────────────────────────────────────
// Groups of nodes shown as one on the flow diagrams (#342). Its own page: it is a different job from listing
// the nodes themselves, and sharing the Nodes page meant scrolling past it to reach them.

function addGroupsSection(nav     , sections     ) {
  const link = navLink(nav, 'Groups', '⧉');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Node groups' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Nodes shown as a single collapsible node on the flow diagrams — three MPPTs as one “Incoming PV”, say. '
    + 'Members keep their own links and their own exports; the group carries their summed total.'));

  const instSel = instanceSelector(() => load());
  const save = btn('Save', 'primary');
  const count = el('span', { class: 'ld-count' });
  sec.appendChild(el('div', { class: 'ld-toolbar' }, instSel.wrap, save, count));
  const ed = el('div');
  sec.appendChild(ed);

  let lastGraph      = null;
  const render = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    const groups = ensure(flow, 'Groups', []);
    count.textContent = `${groups.length} group(s)`;
    ed.innerHTML = '';
    ed.appendChild(renderGroupManager(flow, flowCandidates(lastGraph, ensure(flow, 'Nodes', [])), render));
  };

  const load = async () => {
    // The flow graph names the nodes a group can hold, derived ones included.
    let r     ;
    try { r = await api(withInstance('/api/flow', instSel)); } catch { r = null; }
    lastGraph = r?.body?.ok ? r.body : null;
    render();
  };
  save.onclick = () => saveConfig(load);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, sec };
}

// ── sections/explorer.ts ────────────────────────────────────────
// Explorers on the MQTT and Modbus pages: browse what is out there, tick readings, and create a node from them.

/// A ticked reading: the binding it becomes, what the create dialog calls it, and a JSON topic's fields.

/// The footer both explorers share: how many are ticked, and the button that turns them into a node.
function explorerFooter(picked                            , suggestId              , onClear            , closeExplorer            ) {
  const bar = el('div', { class: 'ld-toolbar', style: { marginTop: '8px' } });
  const create = btn('Create node', 'primary')                     ;
  const clear = btn('Clear selection');
  const count = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  const sync = () => {
    count.textContent = picked.size ? `${picked.size} selected` : 'Tick readings to create a node from them.';
    create.disabled = !picked.size;
  };
  create.onclick = () => { if (picked.size) openCreateNodeDialog([...picked.values()], suggestId(), closeExplorer); };
  clear.onclick = () => { picked.clear(); onClear(); sync(); };
  bar.append(create, clear, count);
  sync();
  return { bar, sync };
}

/// A small copy affordance for the row it sits in: the topic, or what the topic last published.
function copyButton(title        , what        , text              ) {
  const b = el('button', { class: 'copy-btn', text: '⧉', title })                     ;
  b.onclick = async (ev     ) => {
    // The value cell opens the payload when clicked; copying is not that.
    ev?.stopPropagation?.();
    const value = text();
    const ok = await copyText(value);
    toast(ok ? `Copied the ${what}.` : `Could not copy — your browser blocked it. The ${what} is: ${value}`, ok);
  };
  return b;
}

/// The numeric fields of a JSON payload, from either shape the API returns: the topic list gives dotted
/// paths, the single-topic detail gives objects.
function fieldNames(fields     )           {
  return (fields || []).map((f     ) => (typeof f === 'string' ? f : f?.field)).filter(Boolean);
}

/// The payload as it reads: JSON indented, anything else exactly as it was sent.
function prettyPayload(payload        ) {
  try { return JSON.stringify(JSON.parse(payload), null, 2); } catch { return payload; }
}

/// The value at a dotted path inside a parsed payload.
function atPath(obj     , path        ) {
  return path.split('.').reduce((o     , k        ) => (o == null ? o : o[k]), obj);
}

/// A node id from free text: lower case, with anything EmonCMS or MQTT would not take replaced.
function explorerSlug(s        ) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/// The create-node dialog, filled in with a binding per ticked reading; the node opens in the Nodes editor.
function openCreateNodeDialog(bindings                 , suggestedId        , closeExplorer            ) {
  const { body, close } = overlay('Create node');
  const flow = ensure(state.data, 'EnergyFlow', {});
  const nodes        = ensure(flow, 'Nodes', []);
  body.appendChild(el('div', { class: 'desc', text: `A node with a binding for each of the ${bindings.length} selected reading(s). It opens in the node editor, and nothing is saved until you press Save there.` }));

  const bar = el('div', { class: 'ld-toolbar' });
  const idIn = el('input', { type: 'text', value: suggestedId, placeholder: 'id (e.g. gridboss)' })                    ;
  const labIn = el('input', { type: 'text', placeholder: 'label (e.g. Grid Boss)' })                    ;
  const kindSel = el('select', { style: { width: 'auto' } })                     ;
  NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
  bar.append(idIn, labIn, kindSel);
  body.appendChild(bar);

  const sources = bindings.map(b => ({ ...b.source }));
  const tbl = el('table', { class: 'ld' });
  tbl.appendChild(el('thead', {}, el('tr', {}, el('th', { text: 'Reading' }), el('th', { text: 'Metric' }), el('th', { text: 'JSON field' }))));
  const tbody = el('tbody');
  bindings.forEach((b, i) => {
    const src = sources[i];
    const metricSel = el('select', { style: { width: 'auto' } })                     ;
    METRICS.forEach(([key, label]) => metricSel.appendChild(el('option', { value: key, text: label })));
    metricSel.value = src.Metric || 'realpower';
    metricSel.onchange = () => { src.Metric = metricSel.value; src.Unit = undefined; };
    let fieldCell      = el('span', { class: 'desc', text: '—' });
    if (b.fields && b.fields.length > 1) {
      const fieldSel = el('select', { style: { width: 'auto' } })                     ;
      b.fields.forEach(f => fieldSel.appendChild(el('option', { value: f, text: f })));
      fieldSel.value = src.JsonField || b.fields[0];
      src.JsonField = fieldSel.value;
      fieldSel.onchange = () => { src.JsonField = fieldSel.value; };
      fieldCell = fieldSel;
    }
    tbody.appendChild(el('tr', {}, el('td', {}, el('code', { text: b.what })), el('td', {}, metricSel), el('td', {}, fieldCell)));
  });
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const foot = el('div', { class: 'ld-toolbar', style: { marginTop: '8px' } });
  const create = btn('Create node', 'primary');
  const err = el('span', { class: 'desc', style: { margin: '0 0 0 8px', color: 'var(--bad)' } });
  foot.append(create, err);
  body.appendChild(foot);

  create.onclick = () => {
    const id = (idIn.value || '').trim();
    if (!id) { err.textContent = 'An id is required.'; return; }
    if (nodes.some((n     ) => n.Id === id)) { err.textContent = 'That id already exists.'; return; }
    // 'none': the node is valued by the bindings it was created with.
    const node      = { Id: id, Label: (labIn.value || '').trim() || id, Mode: 'none', Sources: sources };
    if (kindSel.value !== 'node') node.Kind = kindSel.value;
    nodes.push(node);
    refreshDirty();
    close();
    closeExplorer();
    editNodeOnNextOpen(id);
    (Array.from(document.querySelectorAll('nav a'))         ).find(a => a.dataset.label === 'Nodes')?.click();
    toast(`Created node ${id} with ${sources.length} binding(s). Press Save to keep it.`, true);
  };
}

/// The topics as a tree of their '/' segments; a segment that is itself a topic carries its reading.

function buildTopicTree(rows       )            {
  const root            = { name: '', path: '', children: new Map() };
  rows.forEach(r => {
    let cur = root;
    const segs = String(r.topic || '').split('/');
    segs.forEach((seg, i) => {
      let next = cur.children.get(seg);
      if (!next) { next = { name: seg, path: segs.slice(0, i + 1).join('/'), children: new Map() }; cur.children.set(seg, next); }
      cur = next;
    });
    cur.row = r;
  });
  return root;
}

/// Every topic at or beneath this branch — what ticking the branch ticks.
function treeTopics(n           , out        = [])        {
  if (n.row) out.push(n.row);
  n.children.forEach(c => treeTopics(c, out));
  return out;
}

/// Every branch path, for expand/collapse all.
function treeBranches(n           , out           = [])           {
  n.children.forEach(c => { if (c.children.size) out.push(c.path); treeBranches(c, out); });
  return out;
}

/// The MQTT explorer: search the broker's live topics and tick the ones to create a node from.
function openMqttExplorer() {
  const { body, close } = overlay('MQTT explorer');
  body.appendChild(el('div', { class: 'desc', text: 'Live topics seen on the broker while this window is open, as a tree of their topic segments. Ticking a branch ticks every topic under it; create a node with a binding for each ticked reading.' }));

  const filterBar = el('div', { class: 'ld-toolbar' });
  const filterIn = el('input', { type: 'text', value: '#', placeholder: '# (everything)', style: { width: '220px' } })                    ;
  filterIn.title = 'The topic filter to subscribe to while browsing. If the broker denies “#”, narrow it (e.g. solar_assistant/#).';
  const applyFilter = btn('Browse this');
  filterBar.append(el('span', { class: 'desc', style: { margin: '0' }, text: 'Subscribe to:' }), filterIn, applyFilter);
  body.appendChild(filterBar);

  const bar = el('div', { class: 'ld-toolbar' });
  const search = el('input', { type: 'search', placeholder: 'filter the shown topics…', style: { width: '320px' } })                    ;
  const expandAll = btn('Expand all');
  const collapseAll = btn('Collapse all');
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(search, expandAll, collapseAll, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['', 'Topic', 'Last value', 'Looks like'].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const picked = new Map                       ();
  const pick = (t     ) => {
    const fields = fieldNames(t.fields);
    picked.set(t.topic, {
      key: t.topic, what: t.topic, fields,
      source: { Type: 'mqtt', Topic: t.topic, Metric: t.metric || 'realpower', Unit: t.unit || undefined, JsonField: fields.length === 1 ? fields[0] : undefined },
    });
  };
  // The deepest topic prefix every ticked topic shares, as the suggested id.
  const suggestId = () => {
    const parts = [...picked.keys()].map(t => t.split('/'));
    const common           = [];
    for (let i = 0; parts.length && parts.every(p => p.length > i + 1 && p[i] === parts[0][i]); i++) common.push(parts[0][i]);
    return explorerSlug(common[common.length - 1] || '');
  };

  let rows        = [];
  const showing = new Set        ();   // topics showing their whole payload
  const open = new Set        ();      // branches showing their children

  /// What a topic actually published, under its row: the payload in full, and the fields worth binding.
  const payloadRow = (t     ) => {
    const cell = el('td');
    cell.setAttribute('colspan', '4');
    const bar = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '0 0 6px' } });
    bar.append(el('code', { class: 'desc', style: { margin: '0' }, text: t.topic }),
               copyButton(`Copy the topic ${t.topic}`, 'topic', () => t.topic),
               copyButton('Copy the whole payload', 'payload', () => t.payload || String(t.value ?? '')));
    cell.appendChild(bar);
    cell.appendChild(el('pre', { class: 'payload', text: prettyPayload(t.payload || String(t.value ?? '')) }));
    const names = fieldNames(t.fields);
    if (names.length) {
      let parsed      = null;
      try { parsed = JSON.parse(t.payload || ''); } catch { parsed = null; }
      const list = el('div', { class: 'desc', style: { margin: '6px 0 0' } });
      list.appendChild(el('span', { text: 'Numeric fields: ' }));
      names.forEach((f, i) => {
        const v = parsed ? atPath(parsed, f) : undefined;
        // The field's own path, which is what a binding's JSON field asks for.
        const code = el('code', { text: f + (v != null && typeof v !== 'object' ? ` = ${v}` : '') });
        list.append(code, copyButton(`Copy the field path ${f}`, 'field path', () => f));
        if (i < names.length - 1) list.append(', ');
      });
      cell.appendChild(list);
    }
    return el('tr', { class: 'payload-row' }, cell);
  };
  const decided = new Set        ();   // branches the reader has opened or closed themselves

  const drawBranch = (start           , depth        ) => {
    // A chain of single children is one line: esphome/fridge/sensor/power/state, not five rows of one each.
    const names = [start.name];
    let n = start;
    while (!n.row && n.children.size === 1) { n = [...n.children.values()][0]; names.push(n.name); }
    const label = names.join('/');
    const topics = treeTopics(n);
    const branch = n.children.size > 0;
    // A small branch opens itself, a big one waits to be asked, and either way the reader's choice sticks.
    if (branch && !decided.has(n.path) && topics.length <= 25) open.add(n.path);

    const box = el('input', { type: 'checkbox', title: branch ? `Tick the ${topics.length} topic(s) under ${n.path}` : n.path })                    ;
    box.checked = topics.length > 0 && topics.every(t => picked.has(t.topic));
    (box       ).indeterminate = !box.checked && topics.some(t => picked.has(t.topic));
    box.onchange = () => {
      topics.forEach(t => box.checked ? pick(t) : picked.delete(t.topic));
      draw();
      footer.sync();
    };

    const name = el('td', { style: { paddingLeft: `${6 + depth * 18}px`, whiteSpace: 'nowrap' } });
    if (branch) {
      const toggle = el('span', { text: open.has(n.path) ? '▾' : '▸', style: { cursor: 'pointer', marginRight: '6px', color: 'var(--muted)' } });
      toggle.onclick = () => { decided.add(n.path); open.has(n.path) ? open.delete(n.path) : open.add(n.path); draw(); };
      name.appendChild(toggle);
    }
    name.append(el('code', { text: label }));
    if (branch) name.append(el('span', { class: 'desc', style: { margin: '0 0 0 6px' }, text: `${topics.length} topic(s)` }));
    // The path, ready to paste into a profile pattern, a subscription or a binding.
    name.append(copyButton(branch ? `Copy the path ${n.path}` : `Copy the topic ${n.path}`,
                           branch ? 'path' : 'topic', () => n.path));

    const t = n.row;
    const value = el('td', { class: 'num', text: t ? (t.value != null ? formatNum(t.value) + (t.unit ? ' ' + t.unit : '') : (t.payload || '').slice(0, 48)) : '' });
    // A truncated line of JSON tells you nothing, and there is nowhere else to read it.
    if (t && (t.payload || t.value != null)) {
      value.title = t.payload || '';
      value.style.cursor = 'pointer';
      value.onclick = () => { showing.has(t.topic) ? showing.delete(t.topic) : showing.add(t.topic); draw(); };
      // What it last published, in full — not the 48 characters the cell has room for.
      value.append(' ', copyButton('Copy the last value', 'value', () => t.payload || String(t.value ?? '')));
    }
    tbody.appendChild(el('tr', {},
      el('td', {}, box),
      name,
      value,
      el('td', { text: t ? (t.isJson ? `JSON · ${fieldNames(t.fields).length} field(s)` : (t.metric ? metricLabel(t.metric) : '—')) : '' })));
    if (t && showing.has(t.topic)) tbody.appendChild(payloadRow(t));

    if (branch && open.has(n.path)) n.children.forEach(c => drawBranch(c, depth + 1));
  };

  const draw = () => {
    tbody.innerHTML = '';
    buildTopicTree(rows).children.forEach(c => drawBranch(c, 0));
  };
  const setAll = (opened         ) => {
    treeBranches(buildTopicTree(rows)).forEach(path => { decided.add(path); opened ? open.add(path) : open.delete(path); });
    draw();
  };
  expandAll.onclick = () => setAll(true);
  collapseAll.onclick = () => setAll(false);

  const footer = explorerFooter(picked, suggestId, draw, close);
  body.appendChild(footer.bar);

  const reload = async () => {
    const b = await fetchTopics(search.value.trim(), 100, filterIn.value.trim() || '#');
    if (b.granted === false) {
      status.style.color = 'var(--bad)';
      status.textContent = `The broker denied the subscription to “${b.filter || filterIn.value.trim()}”. Grant this MQTT account read permission on it, or narrow the filter.`;
      rows = []; draw();
      return;
    }
    status.style.color = 'var(--muted)';
    status.textContent = b.listening
      ? `${(b.topics || []).length} shown · ${b.indexed}/${b.capacity} indexed · subscribed to “${b.filter || '#'}”`
      : `waiting for the broker subscription to “${b.filter || filterIn.value.trim()}” to come up…`;
    rows = b.topics || [];
    draw();
  };

  let timer      = null;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(reload, 250); };
  applyFilter.onclick = () => reload();
  filterIn.onkeydown = (e     ) => { if (e.key === 'Enter') reload(); };
  reload();
  // Keep the topic index's lease alive, and the values fresh, while the window is open.
  const poll = setInterval(() => { if (!document.body.contains(tbl)) { clearInterval(poll); return; } reload(); }, 5000);
}

/// The Modbus explorer: read a block of registers from a connection and tick the decoded values to create a node from.
function openRegisterExplorer() {
  const conns        = (state.data?.Modbus?.Connections) || [];
  const { body, close } = overlay('Modbus explorer');
  if (!conns.length) {
    body.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'There are no Modbus connections. Add one on this page first.' }));
    return;
  }
  body.appendChild(el('div', { class: 'desc', text: 'One read per click. A gateway usually accepts a single client, and the worker is already polling it. Each register is decoded every way that makes sense; tick the values that match what the device reports, then create a node with a binding for each.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const connSel = el('select', { style: { width: 'auto' } })                     ;
  conns.forEach(c => connSel.appendChild(el('option', { value: c.Id, text: c.Name || c.Id })));
  connSel.value = conns[0].Id;
  const startIn = el('input', { type: 'number', value: 0, title: 'First register', style: { width: '90px' } })                    ;
  const countIn = el('input', { type: 'number', value: 32, title: 'How many', style: { width: '70px' } })                    ;
  const bankSel = el('select', { style: { width: 'auto' } })                     ;
  MODBUS_REGISTER_TYPES.forEach(t => bankSel.appendChild(el('option', { value: t, text: t })));
  bankSel.value = 'holding';
  const read = btn('Read', 'primary');
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(connSel, startIn, countIn, bankSel, read, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Register', 'uint16', 'int16', 'uint32', 'float32'].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const picked = new Map                       ();
  const conn = () => conns.find(c => c.Id === connSel.value) || conns[0];
  let rows        = [];
  let readFrom = { id: '', bank: 'holding' };

  const cell = (row     , type        ) => {
    const td = el('td', { class: 'num' });
    if (row[type] == null) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
    const key = `${readFrom.id}|${readFrom.bank}|${row.register}|${type}`;
    const box = el('input', { type: 'checkbox', title: `Register ${row.register} as ${type}` })                    ;
    box.checked = picked.has(key);
    const { id, bank } = readFrom;
    box.onchange = () => {
      if (!box.checked) picked.delete(key);
      else picked.set(key, {
        key, what: `${id} ${bank} ${row.register} as ${type} = ${formatNum(row[type])}`,
        source: { Type: 'modbus', Connection: id, Register: row.register, RegisterType: bank === 'holding' ? undefined : bank, DataType: type === 'uint16' ? undefined : type, Metric: 'realpower' },
      });
      footer.sync();
    };
    td.append(box, ' ', formatNum(row[type]));
    return td;
  };
  const draw = () => {
    tbody.innerHTML = '';
    rows.forEach((row     ) => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('code', { text: String(row.register) })));
      tr.append(cell(row, 'uint16'), cell(row, 'int16'), cell(row, 'uint32'), cell(row, 'float32'));
      tbody.appendChild(tr);
    });
  };
  const footer = explorerFooter(picked, () => explorerSlug(readFrom.id), draw, close);
  body.appendChild(footer.bar);

  read.onclick = async () => {
    const c = conn();
    status.textContent = 'reading…';
    const r = await api('/api/modbus/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Host: c.Host, Port: c.Port, UnitId: c.UnitId, Framing: c.Framing, TimeoutMs: c.TimeoutMs,
        Start: parseInt(startIn.value) || 0, Count: parseInt(countIn.value) || 32, RegisterType: bankSel.value,
      }),
    });
    status.textContent = (r.body && r.body.message) || (r.body?.ok ? '' : 'read failed');
    status.style.color = r.body?.ok ? 'var(--muted)' : 'var(--bad)';
    readFrom = { id: c.Id, bank: bankSel.value };
    rows = (r.body && r.body.rows) || [];
    draw();
  };
  read.onclick(null       );
}

// ── sections/tags-page.ts ───────────────────────────────────────
// Tags (#424): define them, see what carries them, and see what they decide.
//
// A tag is the only thing in this config that means nothing on its own — it matters because a destination
// filter names it. So the page has to answer both halves at once: what wears this tag, and what does
// wearing it do. Buried at the bottom of the Nodes page it answered neither, and a tag could not exist
// until something already carried it, so a filter could never be set up ahead of the nodes it selects.

function addTagsSection(nav     , sections     ) {
  const link = navLink(nav, 'Tags', '#');
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  // The ids the tag rules can match: PDUs and outlets the bridge derives from what it polls.
  let lastGraph      = null;

  const render = () => {
    sec.innerHTML = '';
    sec.appendChild(el('h2', { text: 'Tags' }));
    sec.appendChild(el('div', {
      class: 'desc',
      text: 'A tag does nothing by itself — it matters because a destination filter names it. Below: every '
          + 'tag, what carries it, and which destinations decide on it. Renaming one here rewrites it on '
          + 'every node, rule and filter at once, which is the only way a rename does not quietly turn a '
          + 'working filter into one that matches nothing.',
    }));

    // --- Define one -----------------------------------------------------------------------------------
    const addBar = el('div', { class: 'ld-toolbar' });
    const name = el('input', { type: 'text', placeholder: 'tag name' })                    ;
    const desc = el('input', { type: 'text', placeholder: 'what it is for (optional)', style: { minWidth: '280px' } })                    ;
    const add = btn('Define tag', 'primary');
    const say = el('span', { class: 'desc', style: { margin: '0' } });
    const commit = () => {
      const n = name.value.trim();
      if (!n) return;
      if (!declareTag(n, desc.value.trim())) { say.textContent = `“${n}” already exists.`; return; }
      name.value = ''; desc.value = ''; say.textContent = '';
      refreshDirty(); render();
    };
    add.onclick = commit;
    name.onkeydown = (ev     ) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } };
    desc.onkeydown = (ev     ) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } };
    addBar.append(name, desc, add, say);
    sec.appendChild(addBar);
    sec.appendChild(el('div', { class: 'desc', text:
      'A tag defined here exists before anything carries it, so a filter can be set up ahead of the nodes '
      + 'it will select. Typing one straight onto a node still works and still appears below.' }));

    sec.appendChild(el('div', { class: 'desc' },
      el('span', { text: 'Default and per-outlet tags for the PDUs are set on the ' }),
      el('a', { text: 'Vertiv rPDU page', onclick: () => (document.querySelector('nav a[data-label="Vertiv rPDU"]')       )?.click() }),
      el('span', { text: '.' })));

    const tags = knownTags();
    if (!tags.length) {
      sec.appendChild(el('div', { class: 'desc', style: { marginTop: '12px' },
        text: 'No tags yet. Define one above, or add one to a node on the Nodes page.' }));
      return;
    }

    // --- What exists, what carries it, what decides on it ----------------------------------------------
    const t = el('table', { class: 'ld' });
    const head = el('tr');
    ['Tag', 'What it is for', 'Carried by', 'Destinations that decide on it', ''].forEach(h =>
      head.appendChild(el('th', { text: h })));
    t.appendChild(el('thead', {}, head));
    const tb = el('tbody');

    const declared = declaredTags().map(d => String(d.Name).trim().toLowerCase());

    tags.forEach(tag => {
      const use = tagUsage(tag);
      const tr = el('tr');

      const nm = el('input', { type: 'text', value: tag })                    ;
      nm.onchange = () => {
        const next = nm.value.trim();
        if (!next || next === tag) { nm.value = tag; return; }
        renameTag(tag, next);
        refreshDirty(); render();
      };
      const nameCell = el('td', {}, nm);
      // A tag nothing declared still works; saying so is how you tell a deliberate vocabulary from a typo
      // that has quietly become part of the config.
      if (!declared.includes(tag.toLowerCase()))
        nameCell.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: 'not declared — in use only' }));
      tr.appendChild(nameCell);

      const dsc = el('input', { type: 'text', value: tagDescription(tag), placeholder: '—' })                    ;
      dsc.onchange = () => {
        const flow = ensure(state.data, 'EnergyFlow', {});
        const list = ensure(flow, 'Tags', []);
        const found = list.find((x     ) => String(x.Name || '').trim().toLowerCase() === tag.toLowerCase());
        if (found) found.Description = dsc.value.trim();
        else list.push({ Name: tag, Description: dsc.value.trim() });
        refreshDirty(); render();
      };
      tr.appendChild(el('td', {}, dsc));

      // Named, not counted: "3 node(s)/rule(s)" in a tooltip is the answer you have to go looking for.
      const carried = el('td');
      if (!use.holders.length) {
        carried.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'nothing yet' }));
      } else {
        use.holders.slice(0, 6).forEach(h =>
          carried.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: h })));
        if (use.holders.length > 6)
          carried.appendChild(el('div', { class: 'desc', style: { margin: '0' },
            text: `…and ${use.holders.length - 6} more` }));
      }
      tr.appendChild(carried);

      const decides = el('td');
      if (!use.references.length) {
        decides.appendChild(el('span', { class: 'desc', style: { margin: '0' },
          text: 'none — this tag changes nothing' }));
      } else {
        use.references.forEach(r =>
          decides.appendChild(el('div', { class: 'desc', style: { margin: '0' }, text: r })));
      }
      tr.appendChild(decides);

      const del = btn('Remove', 'danger');
      del.title = 'Take this tag off everything that carries it, out of every filter that names it, and out '
                + 'of the declared list.';
      del.onclick = () => {
        if (use.references.length &&
            !confirm(`“${tag}” is named by ${use.references.join(', ')}.\n\nRemoving it changes what those `
                   + 'destinations send. Continue?')) return;
        removeTag(tag); refreshDirty(); render();
      };
      tr.appendChild(el('td', {}, del));
      tb.appendChild(tr);
    });

    t.appendChild(tb);
    sec.appendChild(t);
    sec.appendChild(el('div', { class: 'desc', style: { marginTop: '6px' },
      text: 'Save (main button) to apply. A tag that no destination decides on is doing nothing yet — set '
          + 'it on a destination’s Include or Exclude list to give it an effect.' }));

    // …and the rules that put tags on the nodes with no row of their own.
    const flow = ensure(state.data, 'EnergyFlow', {});
    sec.appendChild(renderAutoTagRules(flow, flowCandidates(lastGraph, ensure(flow, 'Nodes', [])), render));
  };

  const load = async () => {
    let r     ;
    try { r = await api('/api/flow'); } catch { r = null; }
    lastGraph = r?.body?.ok ? r.body : null;
    render();
  };

  link.onclick = () => { render(); activate(link, sec); load(); };
  render();
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
  showSel.appendChild(el('option', { value: 'energy_d', text: 'Energy Daily (kWh)' }));
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
      showSel.value = 'energy_d';
    load();
  });
  // One click for the periods people actually ask for. A period is a question about energy — "how much
  // today" — so it answers in energy rather than leaving a power reading under a heading about a month.
  const periods = periodRow((key           ) => {
    const { day, days } = periodWindow(key);
    hist.set(day, days);
    showSel.value = 'energy_d';
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
    const title = `Show ${label} for today on the Node Trends page`;
    if (elm.setAttribute) elm.setAttribute('title', title); else elm.title = title;

    const go = () => {
      requestFocus(ids, 'today=1', label);
      const link = [...document.querySelectorAll('nav a')].find((a     ) => (a.dataset?.label || '') === 'Node Trends');
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
        : metric === 'energy_d' ? 'of today’s energy' : 'of lifetime energy';
    } else try {
      // Today, not all time.
      const er = await api(withInstance('/api/flow?metric=energy_d', instSel));
      if (er.body?.ok) {
        const enodes = er.body.nodes || [];
        eUnits = er.body.units || 'kWh';
        // From the answer, not from what was asked for.
        eWindow = er.body.metric === 'energy_d' ? 'of today’s energy' : 'of lifetime energy';
        const eSolar = sumKind(enodes, 'solar'), eBatt = sumKind(enodes, 'battery'), eGrid = sumKind(enodes, 'grid'), eLoad = sumKind(enodes, 'load');
        // In-direction (charge/export) energy from the same live cache, keyed to the same metric.
        const eInBy                         = {};
        const eq = [...battIds, ...gridIds].map(id => ({ Node: id, Metric: 'energy_d#in' }));
        if (eq.length) {
          try {
            const elr = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eq) });
            (elr.body?.values || []).forEach((v     ) => { if (typeof v.value === 'number') eInBy[`${v.node}|${v.metric}`] = v.value; });
          } catch { /* no live cache — energy#in just stays absent */ }
        }
        const eSumIn = (ids          ) => { let s = 0, known = false; ids.forEach(id => { const k = `${id}|energy_d#in`; if (k in eInBy) { s += eInBy[k]; known = true; } }); return known ? s : null; };
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
        requestFocus(ids, 'today=1', label);
        (document.querySelector('nav a[data-label="Node Trends"]')       )?.click();
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

  /// Bindings the bridge is currently dropping, newest read from /api/flow/withheld.
  let withheld        = [];

  /// One problem, said plainly and at a size that cannot be scrolled past.
  ///
  /// A count is not a diagnosis: "2 of 46 binding(s) withheld" says something is wrong and nothing about
  /// what, and the reason was already known — it just lived on another page. Where the card is a source
  /// holding readings back, it opens onto the bindings themselves, each with the reason it is being dropped.
  const alertCard = (level        , title        , state        , detail        , id         ) => {
    const mine = withheld.filter((w     ) => !id || !w.integration || w.integration === id);
    const card = el('div', { class: 'ov-alert ' + level },
      el('span', { class: 'ov-alert-icon', text: level === 'bad' ? '⛔' : '⚠' }));
    const body = el('div', {},
      el('div', { class: 'ov-alert-title', text: `${title} — ${state}` }),
      el('div', { class: 'desc', text: detail || '' }));
    card.appendChild(body);
    if (!mine.length) return card;

    const list = el('div', { class: 'ov-alert-detail' });
    list.hidden = true;
    mine.forEach((w     ) => {
      const row = el('div', { class: 'ov-withheld' });
      row.appendChild(el('strong', { text: `${w.node}${w.metric ? ' · ' + w.metric : ''}` }));
      if (w.source) row.appendChild(el('code', { text: w.source }));
      row.appendChild(el('div', { class: 'desc', text: w.reason || 'No reason given.' }));
      list.appendChild(row);
    });

    const toggle = el('button', { class: 'ov-alert-more', type: 'button' })                     ;
    const label = () => `${list.hidden ? 'Show' : 'Hide'} ${mine.length} withheld binding${mine.length === 1 ? '' : 's'}`;
    toggle.textContent = label();
    toggle.onclick = () => { list.hidden = !list.hidden; toggle.textContent = label(); };
    body.append(toggle, list);
    return card;
  };

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
    wrong.forEach((c     ) => alerts.appendChild(alertCard(c.level, c.title, c.state, c.detail, c.id)));
  };

  let lastDay      = null;
  /// What the daily figures actually cover. A restart with nothing in the store starts them again, and a
  /// tile reading "0 kWh since the day rolled over" is then a claim about a day nobody measured.
  let origin                                                                                = null;
  const sinceLabel = () => {
    if (!origin || origin.carriedOver > 0 || !origin.accumulatingSinceUtc) return 'since the day rolled over';
    const from = new Date(origin.accumulatingSinceUtc);
    return `only since ${from.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — totals did not carry over`;
  };
  /// Said once, above the figures it applies to, rather than repeated on each of them.
  const originNote = () => {
    if (!origin || origin.carriedOver > 0 || !origin.accumulatingSinceUtc) return null;
    const where = origin.store === 'file' ? 'a file inside the container'
      : origin.store === 'cache' ? 'the shared cache' : 'memory';
    return el('div', { class: 'ov-note warn' },
      el('span', { class: 'ov-alert-icon', text: '⚠' }),
      el('div', {},
        el('div', { class: 'ov-alert-title', text: 'Today’s totals restarted with the process' }),
        el('div', { class: 'desc', text:
          `Nothing carried over from ${where}, so the figures below cover only since `
          + `${new Date(origin.accumulatingSinceUtc).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, `
          + 'not the whole day. Trends reads the history backend and still shows the full day.' })));
  };

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
        requestFocus(a.ids , 'today=1', a.label);
        (document.querySelector('nav a[data-label="Node Trends"]')       )?.click();
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

    const note = originNote();
    if (note) todayRow.appendChild(note);
    if (solarIds.length) todayRow.appendChild(tile('solar', '☀', 'Solar produced', fmtKwh(eSolar), sinceLabel(), solarIds));
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
      const [p, e] = await Promise.all([api('/api/flow?metric=realpower'), api('/api/flow?metric=energy_d')]);
      try { origin = (await api('/api/time')).body?.period ?? null; } catch { origin = null; }
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
    // The withheld list first: a card is drawn with its bindings already attached, not re-rendered later.
    try {
      const w = await api('/api/flow/withheld');
      withheld = (w.body && w.body.ok && w.body.sources) || [];
    } catch { withheld = []; }
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
  // The same broker tree as the MQTT page: what a profile does not match is still findable here.
  const browse = btn('Explore topics');
  browse.title = 'Browse every topic on the broker as a tree, and create a node from the ones a profile does not match.';
  browse.onclick = () => openMqttExplorer();
  const addBtn = btn('Add selected', 'primary');
  const copyBtn = btn('Copy this profile to config');
  copyBtn.title = 'Write the selected built-in profile into MQTT.ImportProfiles, where its pattern and '
                + 'metric map can be edited.';
  bar.append(srcSel, scan, browse,
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
  let accSels                                             = [];

  const render = (readings       ) => {
    list.innerHTML = '';
    boxes = []; unitSels = []; accSels = [];
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
    ['', 'Device', 'Reading', 'Metric', 'Unit', 'Counter', 'Topic'].forEach(h => head.appendChild(el('th', { text: h })));
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

      // Whether the counter runs forever or restarts each day. A daily "energy today" reading imported as a
      // lifetime total is read as a meter running backwards every midnight, and the export withholds it from
      // then on — a plug that resets at 0.9 kWh never climbs past its own best day again, so it goes quiet
      // and stays quiet. One sample cannot tell the two apart, so the question is asked rather than guessed.
      const accCell = el('td');
      if (r.metric === 'energy') {
        const accSel = el('select', { style: { width: 'auto' } })                     ;
        accSel.appendChild(el('option', { value: 'lifetime', text: 'lifetime' }));
        accSel.appendChild(el('option', { value: 'period', text: 'resets daily' }));
        r.accumulation = r.accumulation || 'lifetime';
        accSel.value = r.accumulation;
        accSel.onchange = () => { r.accumulation = accSel.value; };
        accCell.appendChild(accSel);
        accSels.push({ reading: r, sel: accSel });
      } else {
        accCell.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: '—' }));
      }
      tr.appendChild(accCell);

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

    // One setter for every energy row: a houseful of smart plugs is usually all the same kind of counter.
    if (readings.some(r => r.metric === 'energy')) {
      const accAll = el('select', { style: { width: 'auto' } })                     ;
      accAll.appendChild(el('option', { value: 'lifetime', text: 'lifetime' }));
      accAll.appendChild(el('option', { value: 'period', text: 'resets daily' }));
      accAll.onchange = () => accSels.forEach(a => {
        a.sel.value = accAll.value;
        a.reading.accumulation = accAll.value;
      });
      row.append(el('span', { class: 'desc', style: { margin: '0' }, text: 'all energy counters:' }), accAll);
    }

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
    list.push({ Name: p.label, Filter: p.filter, Pattern: p.pattern, JsonField: p.jsonField || undefined,
                Metrics: p.metrics, Tags: (p.tags || []).length ? [...p.tags] : undefined });
    toast(`Copied '${p.label}' into MQTT → ImportProfiles. Edit it there, then Save.`, true);
    refreshDirty();
  };

  let found        = [];
  // Tags the chosen profile puts on everything imported through it, beside the one typed above.
  let profileTags           = [];
  scan.onclick = async () => {
    const src = srcSel.value;
    note.textContent = 'Scanning the broker…';
    const r = await api(src === 'discovery'
      ? '/api/mqtt/importable'
      : '/api/mqtt/importable/pattern?profile=' + encodeURIComponent(src));
    if (!r.body || !r.body.ok) { note.textContent = (r.body && r.body.message) || 'Could not scan.'; return; }
    found = r.body.readings || [];
    profileTags = r.body.tags || [];
    note.textContent = `${found.length} reading(s) from ${r.body.scanned} retained topic(s).`
      + (profileTags.length ? ` This profile tags what it imports: ${profileTags.join(', ')}.` : '');
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
        // What the row's Counter column says. 'lifetime' still the default: the daily figure is derived
        // from it, and it is the right answer for most meters.
        Accumulation: r.metric === 'energy' ? (r.accumulation || 'lifetime') : undefined,
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
      const tags = [...new Set([...(tag ? [tag] : []), ...profileTags])];
      if (tags.length) node.Tags = tags;
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

// ── sections/timeline.ts ────────────────────────────────────────
// The timeline above a trends dashboard: the whole loaded range drawn as lines on a time axis, and a window
// over it that picks the stretch of time the dashboard below shows.

/// A stretch of time, in epoch milliseconds.

/// What the strip draws: the lines, the instant each value belongs to, the range it spans, and its width.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HEIGHT = 72;
/// How close to a window's edge a press grabs that edge, in screen pixels.
const EDGE_PX = 12;
/// The grip drawn on each edge, in screen pixels.
const GRIP_W = 10, GRIP_H = 30;
/// The narrowest window, in screen pixels, so an edge can always be grabbed again.
const NARROWEST_PX = 8;
/// How far a press has to travel before it is a drag rather than a click, in screen pixels.
const SLOP_PX = 3;
/// Room each axis label needs, in pixels.
const LABEL_PX = 80;
/// Axis steps, finest first; the finest that leaves each label its room is used.
const TICK_STEPS = [15 * 60_000, 30 * 60_000, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
/// Window lengths offered as one click.
const SIZES                     = [[HOUR, '1 h'], [6 * HOUR, '6 h'], [DAY, '1 day'], [7 * DAY, '7 days']];

/// 5400000 -> "1 h 30 min".
function lengthText(ms        ) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const days = Math.floor(mins / 1440), hours = Math.floor((mins % 1440) / 60), rest = mins % 60;
  return [days ? `${days} day${days > 1 ? 's' : ''}` : '', hours ? `${hours} h` : '', rest && !days ? `${rest} min` : '']
    .filter(Boolean).join(' ');
}

/// The start of the local hour, or of the local day for a day or longer.
function snapped(t        , size        ) {
  const d = new Date(t);
  if (size >= DAY) d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0);
  return d.getTime();
}

/// A longer range the page can load when zooming out past the whole of this one.

function timelineStrip(onPick                             , widen        ) {
  const box = el('div', { class: 'trend-timeline' });
  const head = el('div', { class: 'trend-timeline-head' });
  const note = el('span', { class: 'desc', style: { margin: '0' } });
  const tools = el('div', { class: 'trend-timeline-tools' });
  head.append(note, tools);
  const axis = el('div', { class: 'trend-timeline-axis' });
  box.append(head);

  let data                      = null;
  let span              = null;
  let svg      = null;
  let shadeL     , shadeR     , frame     , edgeL     , edgeR     , gripL     , gripR     ;
  let earlier      = null, later      = null, zoomOut      = null, whole      = null, toRange      = null;

  const width = () => data?.width || 1200;
  const t0 = () => data .bounds.from;
  const t1 = () => data .bounds.to;
  const xOf = (t        ) => ((t - t0()) / (t1() - t0() || 1)) * width();
  const tOf = (px        ) => t0() + Math.min(1, Math.max(0, px / width())) * (t1() - t0());
  /// Drawing units per screen pixel. The strip stretches to its box, so a pixel is rarely one unit.
  const unit = () => { const r = svg?.getBoundingClientRect?.(); return r && r.width ? width() / r.width : 1; };
  const pxOf = (ev     ) => {
    const r = svg?.getBoundingClientRect?.();
    return r && r.width ? (ev.clientX - r.left) * (width() / r.width) : ev.clientX;
  };

  /// A span held inside the range, or null when none of it is left there.
  const bounded = (s      )              => {
    const from = Math.max(t0(), Math.min(s.from, s.to));
    const to = Math.min(t1(), Math.max(s.from, s.to));
    return to > from ? { from, to } : null;
  };

  /// As `bounded`, and refused when a drag has made it narrower than an edge can be grabbed back from. Only a
  /// drag is held to that: a zoom, or a length picked by button or label, can be narrower than a pointer can
  /// draw on a small screen, and is still the window asked for.
  const inRange = (s      )              => {
    const b = bounded(s);
    return b && b.to - b.from >= ((NARROWEST_PX * unit()) / width()) * (t1() - t0()) ? b : null;
  };

  /// `s` scaled by `factor` about the instant `at`, kept inside the range. Covering all of it is no window.
  const zoomed = (s      , at        , factor        )              => {
    const w = (s.to - s.from) * factor;
    if (w >= t1() - t0()) return null;
    const from = Math.min(Math.max(t0(), at - (at - s.from) * factor), t1() - w);
    return bounded({ from, to: from + w }) ?? s;
  };

  /// `s` moved by `dt`, the same length, stopped at either end of the range.
  const shifted = (s      , dt        )       => {
    const w = s.to - s.from;
    const from = Math.min(Math.max(t0(), s.from + dt), t1() - w);
    return { from, to: from + w };
  };

  const when = (t        ) => {
    const d = new Date(t);
    return t1() - t0() > 36 * HOUR
      ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  /// What a pointer at `px` would do: resize an edge, move the window, or draw a new one.
  const modeAt = (px        )                                       => {
    if (!span) return 'create';
    const xl = xOf(span.from), xr = xOf(span.to), grab = EDGE_PX * unit();
    // Nearest edge first, so a narrow window still offers both.
    const dl = Math.abs(px - xl), dr = Math.abs(px - xr);
    if (Math.min(dl, dr) <= grab) return dl <= dr ? 'left' : 'right';
    return px > xl && px < xr ? 'move' : 'create';
  };
  const CURSOR = { left: 'ew-resize', right: 'ew-resize', move: 'grab', create: 'crosshair' };

  const paint = () => {
    note.textContent = span
      ? `Showing ${when(span.from)} → ${when(span.to)} (${lengthText(span.to - span.from)}). Double-click to zoom in further.`
      : 'The whole range. Double-click or drag across it to zoom in, click a date or time below it, or pick a length.';
    if (zoomOut) zoomOut.disabled = !span && !widen?.can();
    if (earlier) earlier.disabled = !span || span.from <= t0();
    if (later) later.disabled = !span || span.to >= t1();
    if (whole) whole.hidden = !span;
    if (toRange) toRange.hidden = !span;
    if (!svg) return;
    const on = !!span;
    const xl = on ? xOf(span .from) : 0;
    const xr = on ? xOf(span .to) : width();
    const u = unit();
    const set = (e     , attrs                     ) => Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
    const shown = on ? 'visible' : 'hidden';
    set(shadeL, { x: 0, width: on ? Math.max(0, xl) : 0 });
    set(shadeR, { x: xr, width: on ? Math.max(0, width() - xr) : 0 });
    set(frame, { x: xl, width: Math.max(0, xr - xl), visibility: shown });
    // The edges and their grips are sized in screen pixels, so they read the same however far the strip stretches.
    [[edgeL, xl], [edgeR, xr]].forEach(([e, x]) => set(e, { x: x - 1.5 * u, width: 3 * u, visibility: shown }));
    [[gripL, xl], [gripR, xr]].forEach(([g, x]) => set(g, { x: x - (GRIP_W / 2) * u, width: GRIP_W * u, visibility: shown }));
  };

  const settle = () => { paint(); onPick(span); };

  // A press, and what it is doing: drawing a new window, moving the window, or dragging one of its edges.
  let press                                                                                                      = null;
  // Two fingers down is a pinch, which zooms the window about the point between them.
  const fingers = new Map                ();
  let pinch                                                  = null;
  let wheelTimer      = null;

  const wire = (s     ) => {
    // The cursor says what a press would do before it is made.
    s.addEventListener('pointermove', (ev     ) => {
      if (!data || press || pinch) return;
      s.style.cursor = CURSOR[modeAt(pxOf(ev))];
    });

    s.addEventListener('pointerdown', (ev     ) => {
      if (!data) return;
      const px = pxOf(ev);
      fingers.set(ev.pointerId ?? 0, px);
      if (fingers.size === 2) {
        const [a, b] = [...fingers.values()];
        pinch = { apart: Math.abs(a - b) || 1, was: span ?? { from: t0(), to: t1() }, at: tOf((a + b) / 2) };
        press = null;
        return;
      }
      const mode = modeAt(px);
      press = { mode, px, was: span ? { ...span } : null, moved: false };
      s.style.cursor = mode === 'move' ? 'grabbing' : CURSOR[mode];
      ev.preventDefault?.();
    });

    s.addEventListener('wheel', (ev     ) => {
      if (!data) return;
      ev.preventDefault?.();
      const sideways = ev.shiftKey || Math.abs(ev.deltaX || 0) > Math.abs(ev.deltaY || 0);
      if (sideways) {
        if (!span) return;
        const dir = (ev.deltaX || ev.deltaY || 0) > 0 ? 1 : -1;
        span = shifted(span, dir * (span.to - span.from) * 0.15);
      } else if (!span && (ev.deltaY || 0) > 0) {
        // Out past the whole range loads a longer one, once the burst stops.
        if (!widen?.can()) return;
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => widen.go(), 300);
        return;
      } else {
        span = zoomed(span ?? { from: t0(), to: t1() }, tOf(pxOf(ev)), (ev.deltaY || 0) < 0 ? 0.7 : 1 / 0.7);
      }
      paint();
      // A scroll arrives as a burst of events; the dashboard follows once it stops.
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => onPick(span), 300);
    }, { passive: false });

    // Double-click zooms in about the pointer, as a map does. Outside the window it zooms into that part of the
    // whole range instead, so any section is two clicks away.
    s.addEventListener('dblclick', (ev     ) => {
      if (!data) return;
      const at = tOf(pxOf(ev));
      const base = span && at >= span.from && at <= span.to ? span : { from: t0(), to: t1() };
      span = zoomed(base, at, 1 / 3);
      settle();
    });
  };

  window.addEventListener('pointermove', (ev     ) => {
    if (!data) return;
    const id = ev.pointerId ?? 0;
    if (pinch && fingers.has(id)) {
      fingers.set(id, pxOf(ev));
      const [a, b] = [...fingers.values()];
      // Fingers moving apart ask for a narrower window: more detail, as a pinch-zoom does everywhere else.
      span = zoomed(pinch.was, pinch.at, pinch.apart / (Math.abs(a - b) || 1));
      paint();
      return;
    }
    if (!press) return;
    const px = pxOf(ev);
    if (!press.moved && Math.abs(px - press.px) <= SLOP_PX * unit()) return;
    press.moved = true;
    const dt = tOf(px) - tOf(press.px);
    const was = press.was;
    if (press.mode === 'create') span = inRange({ from: tOf(press.px), to: tOf(px) });
    else if (press.mode === 'move' && was) span = shifted(was, dt);
    else if (press.mode === 'left' && was) span = inRange({ from: Math.min(was.from + dt, was.to), to: was.to }) ?? span;
    else if (press.mode === 'right' && was) span = inRange({ from: was.from, to: Math.max(was.to + dt, was.from) }) ?? span;
    paint();
  });

  window.addEventListener('pointerup', (ev     ) => {
    fingers.delete(ev.pointerId ?? 0);
    if (pinch) {
      if (fingers.size < 2) { pinch = null; settle(); }
      return;
    }
    if (!press) return;
    const moved = press.moved;
    press = null;
    if (svg) svg.style.cursor = 'crosshair';
    // A press that never moved is a click, and a click picks nothing.
    if (moved) settle();
  });

  /// The axis under the lines: labels at a step that leaves each its room, each one a period that can be picked.
  const drawAxis = () => {
    axis.innerHTML = '';
    const range = t1() - t0();
    const step = TICK_STEPS.find(s => range / s <= width() / LABEL_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];
    let t = step >= DAY ? snapped(t0(), DAY) : snapped(t0(), HOUR);
    while (t < t0()) t += Math.min(step, DAY);
    // A step of days counts from a midnight; a step of hours from the start of an hour.
    if (step < DAY) while ((t - snapped(t, DAY)) % step !== 0 && t < t1()) t += 15 * 60_000;
    for (; t <= t1(); t += step) {
      const pct = ((t - t0()) / range) * 100;
      if (pct < 2 || pct > 98) continue;
      const d = new Date(t);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      const label = el('button', {
        class: 'trend-timeline-tick' + (midnight ? ' major' : ''),
        text: midnight || step >= DAY
          ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
          : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
      label.style.left = `${pct}%`;
      // A date is its day; a time is the stretch up to the next label.
      const length = midnight || step >= DAY ? DAY : step;
      label.title = `Show ${lengthText(length)} from ${d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      const from = t;
      label.onclick = () => { const s = bounded({ from, to: from + length }); if (s) { span = s; settle(); } };
      axis.appendChild(label);
      if (midnight && svg) svg.appendChild(svgTag('line', {
        class: 'trend-timeline-gridline', x1: xOf(t), x2: xOf(t), y1: 0, y2: HEIGHT, 'vector-effect': 'non-scaling-stroke',
      }));
    }
  };

  /// A window of `size`, starting on an hour or midnight: about the current window's middle, or ending at the newest.
  const sized = (size        )              => {
    if (size >= t1() - t0()) return null;
    const middle = span ? (span.from + span.to) / 2 : t1() - size / 2;
    const from = Math.min(Math.max(snapped(middle - size / 2, size), t0()), t1() - size);
    return { from, to: from + size };
  };

  const drawTools = () => {
    tools.innerHTML = '';
    earlier = btn('◀');
    earlier.title = 'Move the window back by its own length';
    earlier.onclick = () => { if (span) { span = shifted(span, -(span.to - span.from)); settle(); } };
    later = btn('▶');
    later.title = 'Move the window forward by its own length';
    later.onclick = () => { if (span) { span = shifted(span, span.to - span.from); settle(); } };
    const zoomIn = btn('+');
    zoomIn.title = 'Zoom in: half the length, about the middle';
    zoomIn.onclick = () => {
      const base = span ?? { from: t0(), to: t1() };
      span = zoomed(base, (base.from + base.to) / 2, 0.5);
      settle();
    };
    zoomOut = btn('−');
    zoomOut.title = 'Zoom out: twice the length, about the middle. At the whole range, loads the next longer range.';
    zoomOut.onclick = () => {
      if (span) { span = zoomed(span, (span.from + span.to) / 2, 2); settle(); }
      else widen?.go();
    };
    tools.append(zoomIn, zoomOut, earlier, later);
    SIZES.filter(([size]) => size < t1() - t0()).forEach(([size, text]) => {
      const b = btn(text);
      b.title = `Show ${lengthText(size)}` + (size >= DAY ? ', from midnight' : ', from the start of an hour');
      b.onclick = () => { const s = sized(size); if (s) { span = s; settle(); } };
      tools.appendChild(b);
    });
    if (widen?.zoomTo) {
      toRange = btn('Zoom to selection');
      toRange.title = 'Make the picked window the time range, so the timeline and the dashboard both cover just that stretch.';
      toRange.onclick = () => { if (span) widen.zoomTo (span); };
      tools.appendChild(toRange);
    }
    whole = btn('Show the whole range');
    whole.onclick = () => { span = null; settle(); };
    tools.appendChild(whole);
  };

  const draw = (d              ) => {
    data = d;
    // A window from before is kept as far as it still falls inside the range, however narrow it is.
    if (span) span = bounded(span);
    if (svg) svg.remove();
    axis.remove();
    svg = svgTag('svg', {
      class: 'trend-timeline-svg', width: width(), height: HEIGHT, viewBox: `0 0 ${width()} ${HEIGHT}`,
      preserveAspectRatio: 'none',
    });
    svg.style.cursor = 'crosshair';
    const known = d.lines.flatMap(l => l.values).filter((v)              => v != null && Number.isFinite(v));
    const lo = known.length ? Math.min(0, ...known) : 0;
    const hi = known.length ? Math.max(0, ...known) : 1;
    const y = (v        ) => HEIGHT - 4 - ((v - lo) / (hi - lo || 1)) * (HEIGHT - 8);
    d.lines.forEach(line => {
      // A missing reading breaks the line rather than being drawn as a zero.
      let run           = [];
      const flush = () => {
        if (run.length > 1) svg.appendChild(svgTag('polyline', {
          class: 'trend-timeline-line', points: run.join(' '), fill: 'none', stroke: line.color,
          'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke',
        }));
        run = [];
      };
      line.values.forEach((v, i) => {
        if (v == null || !Number.isFinite(v) || d.points[i] == null) { flush(); return; }
        run.push(`${xOf(d.points[i]).toFixed(1)},${y(v).toFixed(1)}`);
      });
      flush();
    });
    box.appendChild(svg);
    box.appendChild(axis);
    drawAxis();
    shadeL = svgTag('rect', { class: 'trend-timeline-shade', y: 0, height: HEIGHT });
    shadeR = svgTag('rect', { class: 'trend-timeline-shade', y: 0, height: HEIGHT });
    frame = svgTag('rect', { class: 'trend-timeline-window', y: 1, height: HEIGHT - 2 });
    edgeL = svgTag('rect', { class: 'trend-timeline-edge', y: 0, height: HEIGHT });
    edgeR = svgTag('rect', { class: 'trend-timeline-edge', y: 0, height: HEIGHT });
    gripL = svgTag('rect', { class: 'trend-timeline-grip', y: (HEIGHT - GRIP_H) / 2, height: GRIP_H, rx: 3 });
    gripR = svgTag('rect', { class: 'trend-timeline-grip', y: (HEIGHT - GRIP_H) / 2, height: GRIP_H, rx: 3 });
    svg.append(shadeL, shadeR, frame, edgeL, edgeR, gripL, gripR);
    wire(svg);
    drawTools();
    paint();
  };

  return {
    el: box,
    draw,
    span: () => span,
    clear: () => { span = null; paint(); },
  };
}

// ── sections/trends-shared.ts ───────────────────────────────────
// Shared by the two Trends pages: the window, interval and metric controls, the fetch, and how the answer is read.

/// A window that can be charted: its query, its name, the metric it implies, and roughly how long it is.

const RANGES          = [
  { value: 'today=1', text: 'today so far', wants: 'power', seconds: 86_400 },
  { value: 'today=1&back=1', text: 'yesterday', wants: 'power', seconds: 86_400 },
  { value: 'minutes=60', text: 'last hour', wants: 'power', seconds: 3_600 },
  { value: 'minutes=180', text: 'last 3 hours', wants: 'power', seconds: 10_800 },
  { value: 'minutes=360', text: 'last 6 hours', wants: 'power', seconds: 21_600 },
  { value: 'minutes=720', text: 'last 12 hours', wants: 'power', seconds: 43_200 },
  { value: 'minutes=1440', text: 'last 24 hours', wants: 'power', seconds: 86_400 },
  { value: 'days=7', text: 'last 7 days', wants: 'energy', seconds: 7 * 86_400 },
  { value: 'days=14', text: 'last 14 days', wants: 'energy', seconds: 14 * 86_400 },
  { value: 'days=30', text: 'last 30 days', wants: 'energy', seconds: 30 * 86_400 },
  { value: 'days=90', text: 'last 90 days', wants: 'energy', seconds: 90 * 86_400 },
];

/// The recent windows offered as one click beside the calendar periods.
const RECENT                     = [['minutes=60', 'Last hour'], ['minutes=360', 'Last 6 hours'], ['minutes=1440', 'Last 24 hours']];

/// Auto fits the samples to the chart; per day is one total for each day.
const INTERVALS                     = [
  ['auto', 'auto'], ['60', '1 min'], ['300', '5 min'], ['900', '15 min'], ['1800', '30 min'],
  ['3600', '1 hour'], ['10800', '3 hours'], ['21600', '6 hours'], ['43200', '12 hours'], ['day', 'per day'],
];

/// The steps a fitted interval snaps to.
const NICE_STEPS = [60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400];

/// The narrowest a sampled bar is drawn.
const MIN_BAR_PX = 6;

const LABELS                         = {
  realpower: 'power', apparentpower: 'apparent power', current: 'current', voltage: 'voltage',
  frequency: 'frequency', energy: 'energy',
};
const RATES = ['W', 'VA', 'A', 'V', 'Hz'];

/// The smallest offered step that fits `seconds` into `points` samples.
function stepToFit(seconds        , points        ) {
  const raw = seconds / Math.max(1, points);
  return NICE_STEPS.find(s => s >= raw) ?? NICE_STEPS[NICE_STEPS.length - 1];
}

/// 3600 -> "1 hour".
function durationText(seconds        ) {
  const named = INTERVALS.find(([v]) => Number(v) === seconds);
  if (named) return named[1];
  return seconds >= 3600 ? `${Math.round(seconds / 3600)} hours` : `${Math.round(seconds / 60)} min`;
}

/// The return lanes: battery charge and grid export.
const isReturn = (s     ) => String(s.node || '').endsWith('#in');

/// A return lane is negative, because that is the direction it flows.
const signed = (s     )                    =>
  isReturn(s) ? s.values.map((v     ) => (v == null ? null : -Math.abs(v))) : s.values;

function trendsPage(nav     , sections     , spec            ) {
  const link = navLink(nav, spec.label, spec.icon);
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: spec.label }));
  // Written when the answer arrives, so it describes what was actually charted.
  const desc = el('div', { class: 'desc' });
  sec.appendChild(desc);

  const bar = el('div', { class: 'ld-toolbar' });
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());
  const status = el('span', { class: 'ld-count' });
  const charts = el('div', { class: 'trend-charts' });
  let body      = null;
  // The whole range as loaded, and the stretch of it picked on the timeline. `body` is whichever is shown.
  let whole      = null;
  let picked              = null;
  const strip = spec.timeline
    ? timelineStrip(span => { picked = span; if (span) loadPicked(); else { body = whole; draw(); } }, {
      can: () => !!spanOfRange(rangeSel.value) || !!wider(),
      go: () => { const r = wider(); if (r) useRange(r); },
      zoomTo: (s) => useRange(customRange(s)),
    })
    : null;
  const unpick = () => { picked = null; strip?.clear(); };

  const rangeSel = el('select', { title: 'How far back to chart.' })                     ;
  RANGES.forEach(r => rangeSel.appendChild(el('option', { value: r.value, text: r.text })));
  rangeSel.value = 'days=30';
  // Windows the period buttons add, which RANGES does not list.
  const added = new Map               ();
  const rangeOf = ()        => RANGES.find(r => r.value === rangeSel.value) || added.get(rangeSel.value)
    || { value: rangeSel.value, text: rangeSel.value, wants: 'power', seconds: 86_400 };
  const multiDay = () => rangeSel.value.startsWith('days=');
  /// The two instants of a zoomed-to range, or null for any other range.
  const spanOfRange = (value        )              => {
    const m = /^from=([^&]+)&to=([^&]+)$/.exec(value);
    if (!m) return null;
    const from = Date.parse(decodeURIComponent(m[1])), to = Date.parse(decodeURIComponent(m[2]));
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null;
  };
  /// A range of two instants, listed in the dropdown so it reads back there.
  const customRange = (s      )        => {
    const value = `from=${encodeURIComponent(new Date(s.from).toISOString())}&to=${encodeURIComponent(new Date(s.to).toISOString())}`;
    const at = (t        ) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const range        = { value, text: `${at(s.from)} → ${at(s.to)}`, wants: rate() ? 'power' : 'energy', seconds: Math.round((s.to - s.from) / 1000) };
    if (!added.has(value)) { added.set(value, range); rangeSel.appendChild(el('option', { value, text: range.text })); }
    return range;
  };
  // Only the zoomed-to range being shown stays listed.
  const useRange = (r       ) => {
    rangeSel.value = r.value;
    Array.from(rangeSel.children).forEach((o     ) => {
      if (o.value !== r.value && spanOfRange(o.value)) { added.delete(o.value); o.remove(); }
    });
    rangeSel.onchange ({}       );
  };
  // The next longer range, which zooming out past the whole timeline loads: a zoomed-to range doubles about its middle.
  const wider = ()                    => {
    const custom = spanOfRange(rangeSel.value);
    if (!custom) return RANGES.find(r => /^(minutes|days)=/.test(r.value) && r.seconds > rangeOf().seconds);
    const w = 2 * (custom.to - custom.from);
    const longest = RANGES[RANGES.length - 1];
    if (w >= longest.seconds * 1000) return longest;
    const to = Math.min(Date.now(), (custom.from + custom.to) / 2 + w / 2);
    return customRange({ from: to - w, to });
  };

  const intervalSel = el('select', { title: 'How far apart the samples are. Auto fits them to the width of the chart; per day is one total for each day.' })                     ;
  INTERVALS.forEach(([v, t]) => intervalSel.appendChild(el('option', { value: v, text: t })));
  intervalSel.value = 'auto';
  // Per day only exists across days.
  const syncIntervals = () => {
    const perDayOpt      = Array.from(intervalSel.children).find((o     ) => o.value === 'day');
    if (perDayOpt) perDayOpt.disabled = !multiDay();
    if (!multiDay() && intervalSel.value === 'day') intervalSel.value = 'auto';
  };
  intervalSel.onchange = () => load();

  const fitTo = () => charts.clientWidth || 1200;
  const maxPoints = () => Math.max(24, Math.floor((fitTo() - 64) / MIN_BAR_PX));
  // The step asked for and the step used once the window is fitted to what the chart can draw; null is per day.
  const plan = ()                                                => {
    const choice = intervalSel.value;
    if (choice === 'day' || (choice === 'auto' && multiDay())) return { asked: null, used: null };
    const fit = stepToFit(rangeOf().seconds, maxPoints());
    if (choice === 'auto') return { asked: null, used: fit };
    const asked = Number(choice);
    return { asked, used: Math.max(asked, fit) };
  };

  let METRICS           = [
    { metric: 'realpower', units: 'W', epoch: 'instant' },
    { metric: 'energy', units: 'kWh', epoch: 'lifetime' },
  ];
  const metricSel = el('select', { title: 'Which measurement to chart. What the history backend was given is what it can be asked for.' })                     ;
  let metricChosen = false;
  const unitsOf = (m        ) => (METRICS.find(x => x.metric === m) || { units: '' }).units;
  const epochOf = (m        ) => (METRICS.find(x => x.metric === m) || {}).epoch || '';
  const rate = () => RATES.includes(unitsOf(metricSel.value));
  const metricName = () => LABELS[metricSel.value] || metricSel.value;
  // Only power and the energy counter are offered; a per-day bar is the counter's rise across that day.
  const chartable = () => METRICS.filter(m => epochOf(m.metric) !== 'period');
  const energyFor = (_range        ) => chartable().find(m => !RATES.includes(m.units));
  const impliedMetric = () => {
    const found = rangeOf().wants === 'power' ? chartable().find(m => RATES.includes(m.units)) : energyFor(rangeSel.value);
    return (found || chartable()[0]).metric;
  };
  const fillMetrics = () => {
    metricSel.innerHTML = '';
    chartable().forEach(m => metricSel.appendChild(el('option', { value: m.metric, text: `${LABELS[m.metric] || m.metric} (${m.units})` })));
    if (!metricChosen) metricSel.value = impliedMetric();
  };
  metricSel.onchange = () => { metricChosen = true; load(); };

  const chartSel = el('select', { title: 'Draw the series as bars, lines or filled areas.' })                     ;
  [['bar', 'bars'], ['line', 'lines'], ['area', 'areas']].forEach(([v, t]) => chartSel.appendChild(el('option', { value: v, text: t })));
  // Both dashboards open as stacked areas.
  chartSel.value = 'area';
  const stackBox = el('input')                    ;
  stackBox.type = 'checkbox';
  stackBox.checked = true;
  stackBox.title = 'Stack the series on top of each other. Off, bars sit side by side and areas overlap.';
  // Lines are never stacked.
  const syncStack = () => { stackBox.disabled = chartSel.value === 'line'; };
  chartSel.onchange = () => { syncStack(); draw(); };
  stackBox.onchange = () => draw();

  const periods = periodRow((key           ) => {
    const { days } = periodWindow(key);
    const range = key === 'yesterday' ? 'today=1&back=1' : days < 2 ? 'today=1' : `days=${days}`;
    if (days >= 2 && !RANGES.some(r => r.value === range) && !added.has(range)) {
      const text = `${key === 'week' ? 'this week' : key === 'month' ? 'this month' : 'this year'} (${days} days)`;
      added.set(range, { value: range, text, wants: 'energy', seconds: days * 86_400 });
      rangeSel.appendChild(el('option', { value: range, text }));
    }
    rangeSel.value = range;
    unpick();
    syncIntervals();
    const energy = energyFor(range);
    if (energy) { metricSel.value = energy.metric; metricChosen = true; }
    periods.mark(key);
    markRecent();
    load();
  });
  // A recent window is a range the dropdown already lists, so picking one reads back there too.
  const recentButtons = RECENT.map(([value, label]) => {
    const b = btn(label);
    b.title = `Chart the ${label.toLowerCase()} up to now.`;
    b.onclick = () => { rangeSel.value = value; rangeSel.onchange ({}       ); };
    return b;
  });
  periods.row.append(...recentButtons);
  const markRecent = () => recentButtons.forEach((b, i) => b.classList[RECENT[i][0] === rangeSel.value ? 'add' : 'remove']('primary'));
  rangeSel.onchange = () => { periods.mark(null); unpick(); syncIntervals(); markRecent(); if (!metricChosen) metricSel.value = impliedMetric(); load(); };

  // A counter's readings are not a per-bar quantity; the differences between them are, and a fall is a gap.
  const toDeltas = (b     ) => {
    (b.series || []).forEach((s     ) => {
      const raw = s.values                     ;
      s.values = raw.map((v, i) => {
        if (i === 0 || v == null) return null;
        const prev = raw[i - 1];
        if (prev == null) return null;
        return v - prev < 0 ? null : v - prev;
      });
    });
    b.deltas = true;
  };

  const perDay = () => !!body?.days;
  const summable = () => (perDay() || !!body?.deltas) && !rate();
  const running = () => !rangeSel.value.includes('back=');
  const leadHeight = () => Math.max(240, Math.min(Math.round((window.innerHeight || 900) * 0.34), 420));

  // A day carries the server's period key; a sampled instant is named in the reader's clock, with its date past a day.
  const days = ()           => {
    if (body?.days) return body.days;
    const at           = body?.at || [];
    const long = at.length > 1 && new Date(at[at.length - 1]).getTime() - new Date(at[0]).getTime() > 36 * 3_600_000;
    return at.map(iso => long
      ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  };

  // Where a sampled window fell, in the reader's own clock.
  const windowNote = (at                      ) => {
    if (perDay() || !at?.length) return '';
    const from = new Date(at[0]), to = new Date(at[at.length - 1]);
    const clock = (d      ) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return ` · ${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(from)} → ${clock(to)}`;
  };

  const describe = () => {
    const from = 'read from the history backend.';
    if (perDay()) {
      desc.textContent = `Daily ${metricName()} totals over time, ${from} A day the backend has no reading `
        + 'for is left empty rather than drawn as zero, and is left out of every total.';
      return;
    }
    const every = body?.stepSeconds ? `every ${durationText(body.stepSeconds)}` : 'sampled';
    const name = `${metricName().charAt(0).toUpperCase()}${metricName().slice(1)}`;
    if (body?.deltas) {
      desc.textContent = `${name} ${every} through the window, ${from} Each bar is what changed between two `
        + 'readings of the counter, so the bars add up rather than each restating it. An interval either reading is missing from is left empty.';
      return;
    }
    desc.textContent = `${name} ${every} through the window, ${from} A sample the backend has no reading `
      + 'for is left empty rather than drawn as zero.'
      + (rate() ? ' These are instantaneous readings, so they are not added up.' : '');
  };

  const section = (title        , note        , made                            , legend        ) => {
    const box = el('div', { style: { margin: '18px 0 4px' } });
    box.appendChild(el('h3', { text: title, style: { margin: '4px 0', fontSize: '15px' } }));
    if (note) box.appendChild(el('div', { class: 'desc', text: note }));
    const scroll = el('div', { style: { overflowX: 'auto', paddingBottom: '4px' } });
    scroll.appendChild(made.svg);
    box.appendChild(scroll);
    if (legend.length) {
      const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '10px' } });
      legend.forEach(l => row.appendChild(el('span', { class: 'desc', style: { margin: '0' } },
        el('span', { class: 'trend-swatch', style: { background: l.color } }), l.label)));
      box.appendChild(row);
    }
    charts.appendChild(box);
    // A window still filling opens at its newest bars; one that has ended opens at its start.
    if (running()) scroll.scrollLeft = scroll.scrollWidth;
    return made.gaps;
  };

  const statusLine = (gaps        ) => {
    // A picked stretch is fitted by its own length, not the range's.
    const p = picked ? { asked: null, used: null } : plan();
    const widened = p.asked != null && p.used != null && p.used > p.asked
      ? ` · interval widened from ${durationText(p.asked)} to ${durationText(p.used)} to fit the chart` : '';
    const capped = body?.requestedStepSeconds && body?.stepSeconds > body.requestedStepSeconds
      ? ` · sampled every ${durationText(body.stepSeconds)}, the finest this window allows` : '';
    return `${days().length} ${perDay() ? 'day(s)' : 'sample(s)'} from ${body.source}`
      + windowNote(body.at)
      + (gaps ? ` · ${gaps} with no reading` : '')
      + (body.partial ? ` · ${body.partial} still in progress` : '')
      + widened + capped;
  };

  const showRange = (value        ) => {
    const clean = value.replace(/&step=\d+/g, '');
    if (!RANGES.some(r => r.value === clean)) return;
    rangeSel.value = clean;
    unpick();
    syncIntervals();
    if (!metricChosen) metricSel.value = impliedMetric();
  };

  /// Where each loaded value sits in time, and the range the timeline spans. A day's total belongs to the day it ends.
  const placed = (b     )                                            => {
    const ends = ((b?.at || [])            ).map(iso => new Date(iso).getTime());
    if (!ends.length) return null;
    if (b.days) return { points: ends.map(t => t - 43_200_000), bounds: { from: ends[0] - 86_400_000, to: ends[ends.length - 1] } };
    return ends.length > 1 ? { points: ends, bounds: { from: ends[0], to: ends[ends.length - 1] } } : null;
  };

  const drawStrip = () => {
    if (!strip) return;
    const where = whole?.ok ? placed(whole) : null;
    strip.el.hidden = !where;
    if (where) strip.draw({ lines: spec.timeline (page, whole), points: where.points, bounds: where.bounds, width: fitTo() });
  };

  const draw = () => { hideCard(); charts.innerHTML = ''; describe(); spec.render(page); drawStrip(); };

  /// The stretch picked on the timeline, sampled finely enough to fill the chart.
  const loadPicked = async () => {
    const span = picked;
    if (!span) return;
    status.textContent = 'loading…';
    const seconds = Math.max(60, (span.to - span.from) / 1000);
    const fit = stepToFit(seconds, maxPoints());
    const choice = intervalSel.value;
    const step = choice === 'auto' || choice === 'day' ? fit : Math.max(Number(choice), fit);
    const query = `from=${encodeURIComponent(new Date(span.from).toISOString())}`
      + `&to=${encodeURIComponent(new Date(span.to).toISOString())}`
      + `&step=${step}&metric=${encodeURIComponent(metricSel.value)}`;
    let r     ;
    try { r = await api(withInstance('/api/flow/series?' + query, instSel)); }
    catch (e     ) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    // A newer pick is already on its way; this answer is for a window nobody is looking at.
    if (picked !== span) return;
    const b = r.body;
    const epoch = epochOf(metricSel.value);
    if (b?.ok && (epoch === 'lifetime' || epoch === 'period')) toDeltas(b);
    body = b?.ok ? b : whole;
    draw();
    if (!b?.ok) status.textContent = b?.message || 'Could not load that stretch of time.';
  };

  const load = async () => {
    status.textContent = 'loading…';
    const p = plan();
    const counterEpoch = epochOf(metricSel.value);
    // A counter's first day needs the reading before it, so one more day-end is asked for and dropped after differencing.
    const lead = p.used == null && counterEpoch === 'lifetime';
    const range = lead ? rangeSel.value.replace(/days=(\d+)/, (_, n) => `days=${Number(n) + 1}`) : rangeSel.value;
    const query = range + (p.used != null ? `&step=${p.used}` : '') + '&metric=' + encodeURIComponent(metricSel.value);
    let r     ;
    try { r = await api(withInstance('/api/flow/series?' + query, instSel)); }
    catch (e     ) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    body = r.body;
    if (body?.ok && (counterEpoch === 'lifetime' || (!body.days && counterEpoch === 'period'))) toDeltas(body);
    if (body?.ok && lead && body.days?.length > 1) {
      body.days = body.days.slice(1);
      if (body.at) body.at = body.at.slice(1);
      (body.series || []).forEach((x     ) => { x.values = x.values.slice(1); });
    }
    if (!body?.ok) {
      whole = null;
      draw();
      status.textContent = '';
      charts.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: body?.message || 'Could not load the series.' }));
      return;
    }
    whole = body;
    spec.loaded?.(page);
    if (picked) { await loadPicked(); return; }
    draw();
  };

  const page             = {
    sec, charts, status, body: () => body, load, draw, days, perDay, summable, rate, metricName,
    stacked: () => stackBox.checked && chartSel.value !== 'line',
    kind: () => chartSel.value                           , fitTo, leadHeight, section, statusLine, showRange,
  };

  sec.appendChild(periods.row);
  bar.append(refresh,
    el('label', { class: 'ld-inst' }, 'Show ', rangeSel),
    el('label', { class: 'ld-inst' }, 'every ', intervalSel),
    el('label', { class: 'ld-inst' }, 'of ', metricSel),
    el('label', { class: 'ld-inst' }, 'as ', chartSel),
    ...(spec.stackable ? [el('label', { class: 'ld-inst' }, stackBox, ' stacked')] : []),
    ...(spec.controls?.(page) || []),
    instSel.wrap, status);
  sec.appendChild(bar);
  if (strip) sec.appendChild(strip.el);
  (spec.above?.(page) || []).forEach(x => sec.appendChild(x));
  sec.appendChild(charts);
  (spec.below?.(page) || []).forEach(x => sec.appendChild(x));
  fillMetrics();
  syncIntervals();
  syncStack();

  refresh.onclick = () => load();
  let metricsAsked = false;
  const loadMetrics = async () => {
    if (metricsAsked) return;
    metricsAsked = true;
    try {
      const r      = await api('/api/flow/metrics');
      if (r?.body?.ok && r.body.metrics?.length) { METRICS = r.body.metrics; fillMetrics(); }
    } catch { /* the page still works with the metrics it was seeded with */ }
  };

  link.onclick = () => { activate(link, sec); loadMetrics(); if (!spec.activated?.(page) && !body) load(); };
  // Landing here from another page's click is collected when this section becomes visible.
  window.addEventListener('rpdu:activate', () => { if (sec.classList.contains('active')) spec.activated?.(page); });
  return { link, sec, page };
}

// ── sections/trends.ts ──────────────────────────────────────────
// Trends: the whole system over the chosen window — the grid, self-sufficiency, and where the energy came from.

function addTrendsSection(nav     , sections     ) {
  const { link, sec } = trendsPage(nav, sections, {
    label: 'Trends',
    icon: '▦',
    stackable: false,
    render: (p) => {
      const body = p.body();
      if (!body?.ok) return;

      const days = p.days();
      const units = body.units || 'kWh';
      const partial                = body.partial || null;
      const all        = body.series || [];
      const sumOf = (list       ) => days.map((_, d) => sumKnown(list.map((s     ) => signed(s)[d])));
      const byKind = (kind        ) => {
        const members = all.filter((s     ) => s.kind === kind);
        return members.length ? sumOf(members) : null;
      };
      let drawn = 0;

      // --- Grid ------------------------------------------------------------------------------------
      const gridSupply = all.filter((s     ) => s.kind === 'grid' && !isReturn(s));
      const gridReturn = all.filter((s     ) => s.kind === 'grid' && isReturn(s));
      const gridIn = byKind('grid');
      if (gridSupply.length) {
        const exports_ = gridReturn.length ? sumOf(gridReturn) : null;
        const gridLines         = [{ label: 'Import', color: KIND_COLOR.grid, values: sumOf(gridSupply) }];
        if (exports_) gridLines.push({ label: 'Export', color: '#6fb0e0', values: exports_ });
        p.section(p.perDay() ? 'Grid per day' : 'Grid',
          'Every grid node. Import above the line, export below it'
          + (exports_ ? '.' : ' — no export series is in history for this window, so only import is charted.'),
          barChart({ days, lines: gridLines, units, stacked: true, kind: p.kind(), partial, fitTo: p.fitTo() }), gridLines);
        drawn++;
      }

      // --- Self-sufficiency ---------------------------------------------------------------------------
      const solar = byKind('solar'), batt = byKind('battery'), load = byKind('load');
      // A share of energy over a period; instantaneous power is a different quantity.
      if (p.summable() && gridIn && (load || solar)) {
        const imported = sumOf(gridSupply);
        const pct = days.map((_, d) => selfSufficiencyPct(homeEnergy({
          ...(solar ? { solar: solar[d] } : {}),
          ...(batt ? { battery: batt[d] } : {}),
          ...(gridIn ? { grid: gridIn[d] } : {}),
          ...(load ? { load: load[d] } : {}),
        }), imported[d]));
        if (pct.some(v => v != null)) {
          const ssLines         = [{ label: 'Self-sufficiency', color: KIND_COLOR.solar, values: pct }];
          p.section(p.perDay() ? 'Self-sufficiency per day' : 'Self-sufficiency',
            'The share of the home’s energy that did not come from the grid'
            + (load ? '.' : ', with the home taken as the balance of the measured sources.')
            + ' A day missing either figure is left empty rather than estimated.',
            barChart({ days, lines: ssLines, units: '%', stacked: false, kind: p.kind(), max: 100, pct: true, partial, fitTo: p.fitTo() }), ssLines);
          drawn++;
        }
      }

      // --- Where the energy came from -------------------------------------------------------------
      const supplyLines         = [];
      ([['solar', 'Solar'], ['battery', 'Battery out'], ['grid', 'Grid import']]                      )
        .forEach(([k, label]) => {
          const v = sumOf(all.filter((s     ) => s.kind === k && !isReturn(s)));
          if (v.some(x => x != null)) supplyLines.push({ label, color: KIND_COLOR[k], values: v });
        });
      ([['battery', 'Battery in', '#2f8f52'], ['grid', 'Grid export', '#6fb0e0']]                              )
        .forEach(([k, label, colour]) => {
          const list = all.filter((s     ) => s.kind === k && isReturn(s));
          if (!list.length) return;
          const v = sumOf(list);
          if (v.some(x => x != null)) supplyLines.push({ label, color: colour, values: v });
        });
      if (supplyLines.length > 1) {
        p.section(p.perDay() ? `Where the day’s ${p.metricName()} came from` : `Where the ${p.metricName()} is coming from`,
          'Each kind summed across its nodes. What went back — battery charge, grid export — is below the line, '
          + 'so the same energy is not counted as produced and then again as returned.',
          barChart({ days, lines: supplyLines, units, stacked: true, kind: p.kind(), partial, fitTo: p.fitTo() }), supplyLines);
        drawn++;
      }

      if (!drawn)
        p.charts.appendChild(el('div', { class: 'desc', text: 'Nothing about the whole system to chart in this window: no grid, solar or battery node reported. Each node’s own series is on the Node Trends page.' }));

      const gaps = days.filter((_, d) => !all.some((s     ) => s.values[d] != null)).length;
      p.status.textContent = p.statusLine(gaps);
    },
  });
  return { link, sec };
}

// ── sections/node-trends.ts ─────────────────────────────────────
// Node Trends: each selected node's own series over the chosen window, with its totals.

/// Most nodes drawn in their own colour; past this the smallest are drawn together as one series.
const OWN_COLOURS = 7;
/// The categorical order, defined in styles.css for each theme.
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];
const OTHER_COLOUR = 'var(--faint)';

function addNodeTrendsSection(nav     , sections     ) {
  const off = new Set        ();
  const sort = { col: 1, desc: true };
  let filter = '';
  let overlayId = '';
  let pending                                                                         = null;
  let page            ;
  // Which selected nodes are drawn in their own colour, and that colour, for the current draw.
  let colours = new Map                ();

  // Kinds and tags flow in one row: two rows of chips before the chart was half the page on a real install.
  const tagRow = el('div', { style: { display: 'contents' } });
  const search = el('input', { class: 'trend-search' })                    ;
  search.type = 'search';
  search.placeholder = 'Filter nodes';
  search.title = 'Show only the nodes whose name, id or tags contain this text.';
  const searchRow = el('div', { class: 'ld-toolbar' }, search);
  const picker = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  // The node list is dozens of chips on a real install, so it folds into one line saying what is charted.
  const nodesBar = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } });
  const nodesPanel = el('div', {}, searchRow, picker);
  const NODES_OPEN_KEY = 'rpdu-node-trends-nodes-open';
  let nodesOpen = (() => { try { return localStorage.getItem(NODES_OPEN_KEY) === '1'; } catch { return false; } })();
  const setNodesOpen = (on         ) => {
    nodesOpen = on;
    try { localStorage.setItem(NODES_OPEN_KEY, on ? '1' : '0'); } catch { /* private mode: this session only */ }
  };
  const table = el('div');
  const overlaySel = el('select', { title: 'Draw one more series as a line over the chart, on the same axis.' })                     ;

  const all = ()        => page.body()?.series || [];
  const shown = () => all().filter((s     ) => !off.has(s.node));
  const matches = (s     ) => !filter
    || [s.label, s.node, ...(s.tags || [])].some(t => String(t || '').toLowerCase().includes(filter));

  const kindOf = (s     )         => s.kind || 'node';
  const KINDS_KEY = 'rpdu-node-trends-kinds';
  /// The kinds the page opens on when none were chosen: one that splits the total without counting it twice,
  /// circuits where there are any. Grid beside everything it feeds counts the same energy at every tier.
  const DEFAULT_KINDS = ['breaker', 'load', 'outlet', 'panel', 'pdu'];

  // The selection the page opens with: the kinds last chosen here, or the default.
  const resetSelection = (useSaved = true) => {
    off.clear();
    const kinds = new Set(all().map(kindOf));
    let saved           = [];
    if (useSaved) {
      try { saved = JSON.parse(localStorage.getItem(KINDS_KEY) || '[]').filter((k        ) => kinds.has(k)); }
      catch { saved = []; }
    }
    const one = DEFAULT_KINDS.find(k => kinds.has(k));
    // An install with none of those is sources and loads only, charted as before.
    const preferred = ['solar', 'battery', 'grid', 'load'].filter(k => kinds.has(k));
    const pick = saved.length ? saved : one ? [one] : preferred.length >= 2 ? preferred : [];
    if (pick.length) all().forEach((s     ) => { if (!pick.includes(kindOf(s))) off.add(s.node); });
  };

  /// The kinds wholly on the chart, remembered so the page opens as it was left.
  const saveKinds = () => {
    const kinds = [...new Set(all().map(kindOf))];
    const on = kinds.filter(k => all().filter((s     ) => kindOf(s) === k).every((s     ) => !off.has(s.node)));
    try { localStorage.setItem(KINDS_KEY, JSON.stringify(on)); } catch { /* private mode: this session only */ }
  };

  const KIND_ORDER = ['grid', 'solar', 'battery', 'inverter', 'panel', 'breaker', 'pdu', 'outlet', 'load', 'node', 'unmeasured'];
  const kindName = (k        ) => k === 'pdu' ? 'PDU' : k === 'outlet' ? 'Outlet' : k === 'unmeasured' ? 'Unmeasured'
    : kindMeta(k)[0] === k ? kindMeta(k)[1] : k;

  /// One chip per kind on the page: what a node is decides what it is sensible to chart beside it.
  const kindRow = el('div', { style: { display: 'contents' } });
  const filterRow = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px' } }, kindRow, tagRow);
  const drawKinds = () => {
    kindRow.innerHTML = '';
    const kinds = [...new Set(all().map(kindOf))]
      .sort((a, b) => ((KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
    if (kinds.length < 2) return;
    kindRow.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Kinds:' }));
    kinds.forEach(kind => {
      const members = all().filter((s     ) => kindOf(s) === kind);
      const allOn = members.every((s     ) => !off.has(s.node));
      const chip = btn(`${allOn ? '● ' : '○ '}${kindName(kind)} (${members.length})`);
      if (allOn) chip.classList.add('chip-on');
      chip.title = `${allOn ? 'Take' : 'Add'} the ${members.length} ${kindName(kind).toLowerCase()} node(s) ${allOn ? 'off' : 'to'} the chart. `
        + 'Kinds combine; one kind at a time charts the total once.';
      chip.onclick = () => {
        members.forEach((s     ) => allOn ? off.add(s.node) : off.delete(s.node));
        saveKinds();
        page.draw();
      };
      kindRow.appendChild(chip);
    });
  };

  // A node's weight in the window, for choosing which get their own colour.
  const weight = (s     ) => (s.values                     ).reduce((a        , v) => a + Math.abs(v ?? 0), 0);

  // Colour follows the node: its slot is its position among every node, moved on only if a drawn node holds it.
  const assignColours = (selected       ) => {
    const own = selected.length > OWN_COLOURS + 1
      ? [...selected].sort((a, b) => weight(b) - weight(a)).slice(0, OWN_COLOURS)
      : selected;
    const taken = new Set        ();
    colours = new Map();
    [...own].sort((a, b) => all().indexOf(a) - all().indexOf(b)).forEach((s     ) => {
      let slot = all().indexOf(s) % SERIES.length;
      while (taken.has(slot)) slot = (slot + 1) % SERIES.length;
      taken.add(slot);
      colours.set(s.node, SERIES[slot]);
    });
    return { own, rest: selected.filter((s     ) => !colours.has(s.node)) };
  };

  const drawTags = () => {
    tagRow.innerHTML = '';
    const tags = new Set        ();
    all().forEach((s     ) => (s.tags || []).forEach((t        ) => tags.add(t)));
    if (!tags.size) return;
    tagRow.appendChild(el('span', { class: 'desc', style: { margin: '0 0 0 10px' }, text: 'Tags:' }));
    [...tags].sort().forEach(tag => {
      const members = all().filter((s     ) => (s.tags || []).includes(tag));
      const allOn = members.every((s     ) => !off.has(s.node));
      const chip = btn((allOn ? '● ' : '○ ') + tag);
      if (allOn) chip.classList.add('chip-on');
      chip.title = `${members.length} node(s) tagged "${tag}" — click to chart exactly these`;
      chip.onclick = () => {
        off.clear();
        all().forEach((s     ) => { if (!(s.tags || []).includes(tag)) off.add(s.node); });
        page.draw();
      };
      tagRow.appendChild(chip);
    });
  };

  const drawPicker = () => {
    picker.innerHTML = '';
    const visible = all().filter(matches);
    all().forEach((s     , i        ) => {
      if (!matches(s)) return;
      const on = !off.has(s.node);
      const chip = btn((on ? '● ' : '○ ') + (s.label || s.node));
      chip.title = (on ? 'On the chart — click to take it off' : 'Off the chart — click to add it')
        + ((s.tags || []).length ? `\ntags: ${(s.tags || []).join(', ')}` : '');
      // Selected reads the same whether or not the node has its own colour; the colour is only its border.
      if (on) {
        chip.classList.add('chip-on');
        if (colours.has(s.node)) chip.style.borderColor = colours.get(s.node) ;
        else chip.title += '\ndrawn as part of Other';
      }
      chip.onclick = () => { if (on) off.add(s.node); else off.delete(s.node); page.draw(); };
      picker.appendChild(chip);
    });
    if (filter && !visible.length) picker.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: `no node matches "${filter}"` }));
    const allBtn = btn('All');
    allBtn.title = filter ? 'Chart every node matching the filter.' : 'Chart every node. A hierarchy counts the same energy at several tiers, so read a stack of all of them with that in mind.';
    allBtn.onclick = () => { visible.forEach((s     ) => off.delete(s.node)); page.draw(); };
    const none = btn('None');
    none.title = filter ? 'Take every node matching the filter off the chart.' : 'Take every node off the chart.';
    none.onclick = () => { visible.forEach((s     ) => off.add(s.node)); page.draw(); };
    const reset = btn('Reset', 'primary');
    reset.title = 'Back to the default: one kind that splits the total without counting it twice — circuits where there are any.';
    reset.onclick = () => {
      try { localStorage.removeItem(KINDS_KEY); } catch { /* private mode */ }
      resetSelection(false);
      page.draw();
    };
    nodesBar.innerHTML = '';
    const charted = all().filter((s     ) => !off.has(s.node)).length;
    const toggle = btn(nodesOpen ? 'Hide node list ▴' : 'Choose nodes ▾');
    toggle.title = nodesOpen ? 'Fold the node list away.' : 'Pick individual nodes, or filter them by name.';
    toggle.onclick = () => { setNodesOpen(!nodesOpen); drawPicker(); };
    nodesBar.append(el('span', { class: 'desc', style: { margin: '0' }, text: `Nodes: ${charted} of ${all().length} charted` }),
      toggle, allBtn, none, reset);
    nodesPanel.hidden = !nodesOpen;
  };
  search.oninput = () => { filter = search.value.trim().toLowerCase(); drawPicker(); };

  const fillOverlay = () => {
    overlaySel.innerHTML = '';
    overlaySel.appendChild(el('option', { value: '', text: 'nothing' }));
    all().forEach((s     ) => overlaySel.appendChild(el('option', { value: s.node, text: s.label || s.node })));
    if (!all().some((s     ) => s.node === overlayId)) overlayId = '';
    overlaySel.value = overlayId;
  };
  overlaySel.onchange = () => { overlayId = overlaySel.value; page.draw(); };

  const byNodeTitle = (p            ) => p.perDay()
    ? `Daily ${p.metricName()} by node`
    : `${p.metricName().charAt(0).toUpperCase()}${p.metricName().slice(1)} by node`;

  const drawTable = (p            , series       , days          , units        , partial               ) => {
    const step = Number(p.body().stepSeconds) || 0;
    const rows = series.map((s     ) => {
      const vals = s.values
        .map((v     , d        ) => [v, days[d]]                           )
        .filter(([v]     ) => v != null);
      const sum = vals.reduce((a        , [v]     ) => a + v, 0);
      const best = vals.reduce((a     , b     ) => (b[0] > (a?.[0] ?? -Infinity) ? b : a), null       );
      // Energy from power samples: each sample stands for one step of time.
      const kwh = p.rate() && units === 'W' && step > 0 ? (sum * step) / 3_600_000 : null;
      return {
        label: s.label || s.node,
        headline: p.summable() ? sum : (best ? best[0] : null),
        kwh,
        mean: vals.length ? sum / vals.length : null,
        covered: vals.length,
        peakAt: best ? best[1] : '',
        peakValue: best ? best[0] : null,
      };
    });

    const perDay = p.perDay();
    const cols                                                                                                    = [
      { head: 'Node', num: false, text: r => r.label, sort: r => r.label.toLowerCase() },
      { head: p.summable() ? `Total (${units})` : `Peak (${units})`, num: true,
        text: r => r.headline == null ? '—' : formatNum(Number(r.headline.toFixed(2))),
        sort: r => r.headline ?? -Infinity,
        title: !p.summable() ? 'The highest reading in the window. These are not added up: a sum of them would be a quantity of nothing.'
          : 'Summed over the days that reported' + (partial ? `, including ${partial} as far as it has got.` : '.') },
      ...(p.rate() && units === 'W' ? [{ head: 'Energy (kWh, est.)', num: true,
        text: (r     ) => r.kwh == null ? '—' : formatNum(Number(r.kwh.toFixed(3))),
        sort: (r     ) => r.kwh ?? -Infinity,
        title: `Each sample held for its ${step}s step and added up. An estimate covering only the samples that exist.` }] : []),
      { head: `Mean per ${perDay ? 'day' : 'sample'} (${units})`, num: true,
        text: r => r.mean == null ? '—' : formatNum(Number(r.mean.toFixed(2))), sort: r => r.mean ?? -Infinity,
        title: !perDay || !partial ? undefined
          : `Over the days that reported. ${partial} is one of them and is only part-way through, so the mean reads low until it ends.` },
      { head: `${perDay ? 'Days' : 'Samples'} with data`, num: true,
        text: r => `${r.covered} of ${days.length}`, sort: r => r.covered },
      { head: perDay ? 'Peak day' : 'Peak at', num: false,
        text: r => r.peakAt ? `${r.peakAt} · ${formatNum(r.peakValue)}${r.peakAt === partial ? ' · so far' : ''}` : '—',
        sort: r => r.peakAt },
    ];

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
      th.onclick = () => { if (sort.col === i) sort.desc = !sort.desc; else { sort.col = i; sort.desc = c.num; } p.draw(); };
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
  };

  // Charts that compare the selected nodes rather than follow them through time.
  const drawInsights = (p            , series       , days          , units        , partial               ) => {
    const body = p.body();
    const step = Number(body.stepSeconds) || 0;
    const width = p.fitTo();
    const color = (s     ) => colours.get(s.node) || OTHER_COLOUR;
    const readings = (s     ) => (s.values                     )
      .map((v, d) => [v, d]                           ).filter(([v]) => v != null)                      ;
    // Return lanes are energy going back, not a node's own use, so none of these rank them.
    const own = series.filter((s     ) => !isReturn(s));
    const estimated = !p.summable() && p.rate() && units === 'W' && step > 0;
    // What a node amounts to over the window: its energy where readings add up, or energy estimated from power.
    const amount = (s     ) => {
      const sum = readings(s).reduce((a, [v]) => a + v, 0);
      return p.summable() ? sum : estimated ? (sum * step) / 3_600_000 : null;
    };

    const ranked = own.map((s     ) => ({ s, value: amount(s) })).filter(x => x.value != null && x.value > 0)
      .sort((a, b) => (b.value          ) - (a.value          ));
    if (ranked.length >= 2) {
      p.section('Total energy by node',
        `Each selected node's total energy over the window${estimated ? ', estimated from its power readings' : ''}, and its share of the selected nodes' total. `
        + 'A node and the nodes beneath it count the same energy twice, so select one tier at a time for a true share.',
        rankChart({ items: ranked.map(x => ({ label: x.s.label || x.s.node, value: x.value          , color: color(x.s) })),
          units: estimated ? 'kWh' : units, share: true, fitTo: width }), []);
    }

    const peaks = own.map((s     ) => {
      const best = readings(s).reduce((a, b) => (b[0] > (a?.[0] ?? -Infinity) ? b : a), null                           );
      return best && best[0] > 0
        ? { label: s.label || s.node, value: best[0], color: color(s), note: days[best[1]] + (days[best[1]] === partial ? ' so far' : '') }
        : null;
    }).filter(Boolean)                                                                   ;
    if (peaks.length) {
      p.section(p.perDay() ? 'Peak daily energy by node' : `Peak ${p.metricName()} by node`,
        p.perDay() ? 'Each selected node\'s highest daily energy in the window, and the day it occurred.'
          : `Each selected node's highest ${p.metricName()} reading in the window, and when it occurred.`,
        rankChart({ items: peaks, units, fitTo: width }), []);
    }

    // The same hour across every day of the window, which shows when each node does its work.
    const at           = body.at || [];
    if (!p.perDay() && at.length && new Set(at.map(iso => new Date(iso).getHours())).size >= 2) {
      const hourOf = at.map(iso => new Date(iso).getHours());
      const perHour = body.deltas && step > 0 ? 3600 / step : 1;
      const lines         = (ranked.length ? ranked.map(x => x.s) : own).slice(0, 5).map((s     ) => ({
        label: s.label || s.node, color: color(s),
        values: Array.from({ length: 24 }, (_, h) => {
          const inHour = readings(s).filter(([, d]) => hourOf[d] === h).map(([v]) => v);
          return inHour.length ? (inHour.reduce((a, v) => a + v, 0) / inHour.length) * perHour : null;
        }),
      }));
      if (lines.length) {
        p.section(`Average ${p.metricName()} by hour of day`,
          (body.deltas ? `Energy per hour, averaged over every day in the window` : `Average ${p.metricName()} in each hour, over every day in the window`)
          + (lines.length < own.length ? ', for the five largest selected nodes.' : '.') + ' An hour with no reading is left empty.',
          barChart({ days: Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`), lines,
            units: body.deltas ? `${units}/h` : units, stacked: false, kind: 'line', fitTo: width, height: 220 }), lines);
      }
    }

    // What a node draws at its quietest: a load that never falls to zero is one that never switches off.
    if (p.rate() && units === 'W') {
      const floor = own.map((s     ) => {
        const v = readings(s).map(([x]) => x).sort((a, b) => a - b);
        if (v.length < 12) return null;
        const value = v[Math.floor(v.length * 0.05)];
        return value > 0 ? { label: s.label || s.node, value, color: color(s), note: `${v.length} samples` } : null;
      }).filter(Boolean)                                                                   ;
      if (floor.length) {
        p.section('Base load by node',
          'Each selected node\'s base load: the power that 5% of its readings fall below. A base load above zero is power drawn even at the node\'s quietest.',
          rankChart({ items: floor, units, fitTo: width }), []);
      }
    }
  };

  const created = trendsPage(nav, sections, {
    label: 'Node Trends',
    icon: '▥',
    stackable: true,
    controls: () => [el('label', { class: 'ld-inst' }, 'overlay ', overlaySel)],
    // The selected nodes across the whole loaded range, in the colours the chart below gives them.
    timeline: (_p, whole) => {
      const selected = (whole?.series || []).filter((s     ) => !off.has(s.node));
      const lines         = selected.filter((s     ) => colours.has(s.node))
        .map((s     ) => ({ label: s.label || s.node, color: colours.get(s.node) , values: signed(s) }));
      const rest = selected.filter((s     ) => !colours.has(s.node));
      if (rest.length) {
        const n = rest[0].values.length;
        lines.push({ label: 'Other', color: OTHER_COLOUR, values: Array.from({ length: n }, (_, d) => sumKnown(rest.map((s     ) => signed(s)[d]))) });
      }
      return lines;
    },
    above: () => [filterRow, nodesBar, nodesPanel],
    below: () => [table],
    loaded: () => {
      if (pending) {
        off.clear();
        const wanted = new Set(pending.nodes);
        all().forEach((s     ) => { if (!wanted.has(s.node)) off.add(s.node); });
        // None of what was asked for is in this window: fall back rather than chart nothing.
        if (off.size === all().length) resetSelection();
        pending = null;
      } else if (!off.size) resetSelection();
      fillOverlay();
    },
    activated: (p) => {
      const want = takeFocus();
      if (!want) return false;
      pending = want;
      if (want.range) p.showRange(want.range);
      p.load();
      return true;
    },
    render: (p) => {
      const body = p.body();
      const fold = assignColours(body?.ok ? shown() : []);
      drawKinds(); drawTags(); drawPicker(); table.innerHTML = '';
      if (!body?.ok) return;

      const days = p.days();
      const series = shown();
      const units = body.units || 'kWh';
      const partial                = body.partial || null;
      const over = overlayId ? all().find((s     ) => s.node === overlayId) : null;
      const overlay                   = over
        ? { label: over.label || over.node, color: 'var(--accent)', values: signed(over) } : undefined;

      if (!series.length) {
        const box = el('div', { style: { margin: '18px 0 4px' } });
        box.appendChild(el('h3', { text: byNodeTitle(p), style: { margin: '4px 0', fontSize: '15px' } }));
        box.appendChild(el('div', { class: 'desc', text: 'No nodes selected — pick one above, or press Reset. The whole-system charts are on the Trends page.' }));
        p.charts.appendChild(box);
        p.status.textContent = p.statusLine(0);
        return;
      }

      const lines         = fold.own.map((s     ) => ({ label: s.label || s.node, color: colours.get(s.node) , values: signed(s) }));
      // The rest are one series, so every drawn series can be told apart; the table below still lists each.
      if (fold.rest.length)
        lines.push({ label: `Other (${fold.rest.length} nodes)`, color: OTHER_COLOUR,
          values: days.map((_, d) => sumKnown(fold.rest.map((s     ) => signed(s)[d]))) });
      const legend = overlay ? [...lines, { ...overlay, label: `${overlay.label} (overlay)` }] : lines;
      const gaps = p.section(byNodeTitle(p),
        'The nodes selected above.' + (!partial ? ''
          : p.kind() === 'bar' ? ' The faded bar is today, still in progress — it counts in the totals below, so far.'
          : ' The last day is today, still in progress — it counts in the totals below, so far.'),
        barChart({ days, lines, units, stacked: p.stacked(), kind: p.kind(), partial, fitTo: p.fitTo(), height: p.leadHeight(), overlay }), legend);

      drawInsights(p, series, days, units, partial);
      drawTable(p, series, days, units, partial);
      p.status.textContent = p.statusLine(gaps);
      p.status.title = gaps ? 'Those are drawn as empty slots and left out of the totals. The backend holds nothing for them.' : '';
    },
  });
  page = created.page;
  return { link: created.link, sec: created.sec };
}

// ── sections/circuit-finder.ts ──────────────────────────────────
// Circuit Finder (#471): find a load's circuit by switching the load, not the breaker. Tap, switch the load,
// tap again — every channel is read between taps, and the one that steps with the load is the circuit.
// Built for a phone held in one hand at the panel: one big button, one list, no tables.

/// What a load can actually sit on. A panel, the grid and an inverter all step with the load as well, being
/// upstream of it, so offering them as answers only buries the circuit.
const CIRCUIT_KINDS = ['breaker', 'outlet', 'load'];

/// A state of the load that has been sampled at least once: the running total per channel.

function addCircuitFinderSection(nav     , sections     ) {
  const link = navLink(nav, 'Circuit Finder', '🔌');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Circuit Finder' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Find which circuit a load is on by switching the load itself. Tap the button, switch the load, then tap '
    + 'again. Every channel is read between taps, and the channel that rises when the load goes on and falls '
    + 'when it goes off is the one it is on. Each toggle narrows it down.'));

  const instSel = instanceSelector(() => reset());
  const draw = el('input', { type: 'number', min: '0', step: '10', placeholder: 'e.g. 1500' })                    ;
  draw.style.maxWidth = '9em';
  draw.title = 'Roughly what the load draws, if you know it. Leave blank for an unknown load.';
  draw.onchange = () => render();
  sec.appendChild(el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, 'Load draws about ', draw, ' W'), instSel.wrap));

  const everything = el('input', { type: 'checkbox' })                    ;
  everything.title = 'Also offer panels, the grid and other upstream nodes, which step with the load because they carry it.';
  everything.onchange = () => render();
  sec.appendChild(el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, everything, ' Show every channel, not just circuits')));

  // The button is its own progress bar: the fill sweeps across it while the channels are read again.
  const coolBar = el('span', { class: 'cf-fill' });
  coolBar.hidden = true;
  const tapLabel = el('span', { class: 'cf-label' });
  const tap = el('button', { class: 'cf-tap' }, coolBar, tapLabel)                     ;
  const reset_ = btn('Start over');
  sec.appendChild(el('div', { class: 'cf-actions' }, tap, reset_));
  const rate = el('div', { class: 'desc cf-rate' });
  sec.appendChild(rate);
  const verdict = el('div', { class: 'cf-verdict' });
  sec.appendChild(verdict);
  const list = el('div', { class: 'cf-list' });
  sec.appendChild(list);

  // The PDU decides how often a channel can be read at all, so it decides the shortest switch that can be seen.
  const pollSeconds = () => {
    const pdus      = (state.data || {}).Pdus || {};
    const each = Object.values(pdus).map((p     ) => Number(p?.PollInterval)).filter(n => Number.isFinite(n) && n > 0);
    return each.length ? Math.min(...each) : 5;
  };

  let stages          = [];
  let labels                         = {};
  let kinds                         = {};
  let busy = false;

  // A reading has to settle before the next tap means anything: the PDU is only read every few seconds.
  const coolSeconds = () => Math.min(5, Math.max(3, pollSeconds()));

  const reset = () => { stages = []; labels = {}; kinds = {}; render(); };
  reset_.onclick = () => reset();

  /// Every channel's reading now, added to the state the load is in.
  const sample = async () => {
    const stage = stages[stages.length - 1];
    if (!stage) return;
    let r     ;
    try { r = await api(withInstance('/api/flow', instSel)); }
    catch { return; }
    const nodes = r?.body?.ok ? r.body.nodes || [] : [];
    nodes.forEach((n     ) => {
      // A return lane or an unmetered remainder is not a channel anyone can find a load on.
      if (!n.id || String(n.id).includes('#') || typeof n.value !== 'number') return;
      labels[n.id] = n.label || n.id;
      kinds[n.id] = n.kind || 'node';
      stage.sum[n.id] = (stage.sum[n.id] || 0) + n.value;
      stage.n[n.id] = (stage.n[n.id] || 0) + 1;
    });
  };

  // While a session is open the channels are read in the background too, so a state is an average rather than
  // one instant — that is what lets a small load show through the noise.
  setInterval(() => { if (stages.length && sec.classList.contains('active') && !busy) sample().then(render); }, Math.max(2, pollSeconds()) * 1000);

  const offered = (id        ) => everything.checked || CIRCUIT_KINDS.includes(kinds[id] || 'node');
  const levels = ()          => stages
    .filter(s => Object.keys(s.n).length)
    .map(s => ({ on: s.on, mean: Object.fromEntries(Object.keys(s.sum).filter(offered).map(k => [k, s.sum[k] / s.n[k]])) }));

  const wattsWanted = () => { const v = Number(draw.value); return Number.isFinite(v) && v > 0 ? v : null; };

  tap.onclick = async () => {
    if (busy) return;
    busy = true;
    // The button stays down while the channels are read again, so a second tap cannot land inside the same
    // reading — the bar says how long that is.
    const cool = coolSeconds();
    tap.disabled = true;
    tap.dataset.cooldown = String(cool);
    tapLabel.textContent = `Reading channels… wait ${cool} s`;
    coolBar.hidden = false;
    coolBar.style.animationDuration = `${cool}s`;
    // The load has already been switched, so the tap opens the state it is now in and reads it.
    stages.push({ on: stages.length ? !stages[stages.length - 1].on : false, sum: {}, n: {} });
    await sample();
    render();
    setTimeout(() => { busy = false; tap.disabled = false; coolBar.hidden = true; render(); }, cool * 1000);
  };

  const render = () => {
    const poll = pollSeconds();
    // Each tap names the state the load is already in, so the button asks for the next one.
    const next = !stages.length || stages[stages.length - 1].on ? 'OFF' : 'ON';
    tapLabel.textContent = busy ? `Reading channels… wait ${coolSeconds()} s` : `Switch the load ${next}, then tap`;
    tap.title = 'Switch the load first, then tap: the tap reads every channel in the state the load is now in.';
    reset_.hidden = !stages.length;
    rate.textContent = `Channels are read every ${poll} s, so a switch shorter than about ${poll * 2} s cannot be seen. `
      + 'Leave the load in each state for a few seconds before tapping.';

    const found = analyse(levels(), { watts: wattsWanted(), labels });
    verdict.className = 'cf-verdict' + (found.done ? ' is-found' : '');
    verdict.textContent = stages.length ? found.verdict : 'Switch the load off, then tap to take the first reading.';

    list.innerHTML = '';
    found.candidates.slice(0, 8).forEach(c => {
      const share = found.toggles ? Math.round((c.matched / found.toggles) * 100) : 0;
      // The point of finding a circuit is usually to name it, so each row opens that node's editor.
      const row = el('button', { class: 'cf-row' + (found.done && found.found.some(f => f.node === c.node) ? ' is-found' : '') },
        el('span', { class: 'cf-name', text: c.label }),
        el('span', { class: 'cf-meta', text: `${c.matched} of ${found.toggles} toggles · ${Math.round(c.step).toLocaleString('en-US')} W · ${share}%` }),
        el('span', { class: 'cf-edit', text: 'Edit ›' }));
      row.title = `Open ${c.label} in the node editor, to name it or set what feeds it.`;
      row.onclick = () => {
        editNodeOnNextOpen(c.node);
        (Array.from(document.querySelectorAll('nav a'))         ).find(a => a.dataset.label === 'Nodes')?.click();
      };
      list.appendChild(row);
    });
    if (stages.length && !found.candidates.length && found.toggles)
      list.appendChild(el('div', { class: 'desc', text: 'No channel has stepped with the load yet.' }));
  };

  link.onclick = () => { activate(link, sec); render(); };
  render();
  return { link, sec };
}

// ── sections/panel-schedule.ts ──────────────────────────────────
// The panel schedule (#453): a panel drawn as it is — two columns of slots, a breaker handle on each — with
// each breaker's number, wire, rating, what it feeds and the live power of the channel measuring it (#454).
// Slots, breakers, tandem halves and the node measuring each leg are all edited here.

/// A breaker as the API reports it, with its chain and power resolved.

/// What a finding is about, in the words the page uses.
const CHECK_TITLES                         = {
  'channel-shared': 'One channel, two breakers',
  'channel-unmapped': 'A channel nobody mapped',
  'unused-live': 'An unused breaker drawing power',
  'half-clamped': 'Half a double-pole breaker',
  'over-rating': 'Over the breaker\u2019s rating',
  'channel-is-a-tier': 'Measured by a breaker, not a channel',
  'panel-multi-fed': 'A panel fed from two places',
  'circuit-multi-fed': 'A circuit fed from two places',
};

/// Why a breaker's power is not shown. Never a zero: a gap in the chain is a gap.
const GAPS                         = {
  noclamp: 'Nothing is measuring this breaker yet — pick the node its circuit is on. A double-pole needs both legs, unless one CT measures the whole circuit.',
  nochannel: 'Its clamp is not plugged into a monitor channel yet.',
  noreading: 'Its channel has no current reading.',
};

/// The kinds of node a breaker's circuit can be. A subpanel counts: a breaker feeding one is measured by the
/// CT on its feed. What carries the breaker — its own panel, and whatever feeds that — is ruled out separately.
const PANEL_CIRCUIT_KINDS = ['breaker', 'outlet', 'load', 'node', 'panel'];

function addPanelScheduleSection(nav     , sections     ) {
  const link = navLink(nav, 'Panel Schedule', '🗂');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section ps' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Panel Schedule' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Each panel as its own directory: the slots laid out as they are in the panel, odd down the left and even '
    + 'down the right, with what each breaker feeds and the power of the node measuring it. A breaker with '
    + 'nothing mapped to it reads no data rather than zero. Tap a breaker to edit it, or an empty slot to fill it in.'));

  const panelSel = el('select', { title: 'Which panel to show.' })                     ;
  const refresh = btn('Refresh');
  const addPanel = btn('Add panel');
  const importBtn = btn('Import…');
  const traceStart = btn('Trace…');
  traceStart.title = 'Identify an unknown breaker: take a baseline, switch it off, and see which channel went dark.';
  const printBtn = btn('Print…');
  printBtn.title = 'Print this directory for the inside of the panel door.';
  importBtn.title = 'Paste a directory you already keep — breaker numbers, wires, channels and what each feeds — and see what it reads as before anything is written.';
  // Watts or amps: the same reading, in the unit the question is being asked in.
  const unitSel = el('select', { class: 'ps-unit' })                     ;
  [['W', 'watts'], ['A', 'amps']].forEach(([v, t]) => unitSel.appendChild(el('option', { value: v, text: t })));
  unitSel.title = 'Show what each breaker is drawing in watts, or in amps against its rating.';
  unitSel.onchange = () => render();
  const status = el('span', { class: 'ld-count' });
  sec.appendChild(el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, 'Panel ', panelSel), el('label', { class: 'ld-inst' }, 'Show ', unitSel), refresh, addPanel, importBtn, traceStart, printBtn, status));

  // The panel's own settings: what it is called, and how many slots it has.
  const nameIn = el('input', { type: 'text', placeholder: 'Main Panel' })                    ;
  const slotsIn = el('input', { type: 'number', min: '2', max: '200', step: '2', class: 'ps-slots' })                    ;
  slotsIn.title = 'How many breaker positions the panel has, counting both columns. A 42-space panel has 42.';
  // The node that is this panel: its reading is the power coming in, and its breakers' circuits hang beneath it.
  const nodeSel = el('select', { class: 'ps-panel-node' })                     ;
  nodeSel.title = 'The energy-flow node that is this panel. Its reading is the power coming in, and a circuit mapped to one of its breakers is placed beneath it.';
  const feeders = el('span', { class: 'ps-feeders' });
  const feedAdd = el('select', { class: 'ps-feed-add' })                     ;
  // Where the panel is mounted, from the locations on the Floor Plans page.
  const whereBox = el('span', { class: 'ps-where' });
  feedAdd.title = 'Add a node that feeds this panel.';
  const settings = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, 'Name ', nameIn),
    el('label', { class: 'ld-inst' }, 'Slots ', slotsIn),
    el('label', { class: 'ld-inst' }, 'This panel is ', nodeSel),
    el('label', { class: 'ld-inst' }, 'Fed by ', feeders, feedAdd),
    el('label', { class: 'ld-inst' }, 'Mounted in ', whereBox));
  sec.appendChild(settings);
  const incoming = el('div', { class: 'desc ps-incoming' });
  sec.appendChild(incoming);

  // What the mapping contradicts, or the readings do (#457). A report: nothing here changes the directory.
  const checks = el('div', { class: 'ps-checks' });
  sec.appendChild(checks);

  const grid = el('div', { class: 'ps-grid' });
  // The enclosure: the two columns of breakers either side of the bus bar down the middle.
  sec.appendChild(el('div', { class: 'ps-panel' }, el('div', { class: 'ps-bus' }), grid));

  // The same directory laid out for the inside of the panel door (#460): shown only on paper.
  const printable = el('div', { class: 'ps-print' });
  sec.appendChild(printable);
  traceStart.onclick = () => {
    const p = shown();
    if (!p) { toast('Add a panel first.', false); return; }
    trace(p, null);
  };
  printBtn.onclick = () => {
    const w      = window;
    if (typeof w.print === 'function') w.print();
    else toast('This browser cannot print from here.', false);
  };

  let panels          = [];
  let findings            = [];
  let nodes                                                = [];

  const flowIn = () => ensure(state.data, 'EnergyFlow', {});
  const panelsIn = ()        => ensure(flowIn(), 'Panels', []);
  const clampsIn = ()        => ensure(flowIn(), 'Clamps', []);
  const linksIn = ()        => ensure(flowIn(), 'Links', []);
  const shown = () => panels.find(p => p.id === panelSel.value) || panels[0];
  const labelOf = (id        ) => nodes.find(n => n.id === id)?.label || id;
  /// What feeds a node today, according to the flow links.
  const parentsOf = (node        ) => linksIn().filter((l     ) => l.To === node).map((l     ) => String(l.From));
  /// The config entry behind the drawn panel: edits land there, and it is what the drawing follows.
  const configPanel = (id        ) => panelsIn().find((p     ) => p.Id === id);

  const load = async () => {
    status.textContent = 'loading…';
    let r     ;
    // Resolved from the directory on screen rather than the saved one, so an edit is drawn before Save.
    const holding = { EnergyFlow: { Panels: panelsIn(), Clamps: clampsIn() } };
    try {
      r = panelsIn().length
        ? await api('/api/panels/resolve', { method: 'POST', body: JSON.stringify(holding) })
        : await api('/api/panels');
    }
    catch (e     ) { r = { body: { ok: false, message: e?.message || 'the request failed' } }; }
    if (!r.body?.ok) { status.textContent = r.body?.message || 'Could not read the panels.'; panels = []; render(); return; }
    panels = r.body.panels || [];
    findings = r.body.findings || [];
    const keep = panelSel.value;
    panelSel.innerHTML = '';
    panels.forEach(p => panelSel.appendChild(el('option', { value: p.id, text: p.name || p.id })));
    if (panels.some(p => p.id === keep)) panelSel.value = keep;
    status.textContent = '';
    // The nodes a breaker's circuit can be: whatever the bridge already reads.
    try {
      const f      = await api('/api/flow');
      if (f?.body?.ok) nodes = (f.body.nodes || [])
        .filter((n     ) => n.id && !String(n.id).includes('#'))
        .map((n     ) => ({ id: n.id, label: n.label || n.id, kind: n.kind || 'node' }));
    } catch { /* the page still draws without the picker's choices */ }
    render();
  };
  refresh.onclick = () => load();
  panelSel.onchange = () => render();

  addPanel.onclick = () => {
    const id = (prompt('An id for the panel, e.g. main_panel') || '').trim();
    if (!id) return;
    panelsIn().push({ Id: id, Name: id, Slots: 42, Breakers: [] });
    refreshDirty();
    toast(`Added panel ${id}. Press Save to keep it.`, true);
    load();
  };

  nameIn.onchange = () => {
    const p = configPanel(panelSel.value);
    if (!p) return;
    p.Name = nameIn.value.trim() || p.Id;
    refreshDirty();
    render();
  };
  nodeSel.onchange = () => {
    const p = configPanel(panelSel.value);
    if (!p) return;
    p.Node = nodeSel.value;
    refreshDirty();
    load();
  };
  feedAdd.onchange = () => {
    const p = configPanel(panelSel.value);
    if (!p?.Node || !feedAdd.value) return;
    if (!parentsOf(p.Node).includes(feedAdd.value)) linksIn().push({ From: feedAdd.value, To: p.Node });
    feedAdd.value = '';
    refreshDirty();
    render();
  };
  slotsIn.onchange = () => {
    const p = configPanel(panelSel.value);
    if (!p) return;
    // Two slots to a row, so an odd count would leave half a row: the panel is sized in rows.
    const want = Math.max(2, Math.min(200, Number(slotsIn.value) || 42));
    p.Slots = want % 2 ? want + 1 : want;
    slotsIn.value = String(p.Slots);
    refreshDirty();
    render();
  };

  /// The breaker in the config this drawn one came from, so an edit lands on the real entry.
  const configBreaker = (panelId        , b         ) => {
    const p = configPanel(panelId);
    if (!p) return null;
    return ensure(p, 'Breakers', []).find((x     ) => x.Slot === b.slot && (x.Number || '') === b.number) || null;
  };

  /// The clamp recording which node measures one leg of a breaker, if anything does.
  const clampFor = (panelId        , number        , leg        ) =>
    clampsIn().find((c     ) => c.Panel === panelId && c.Breaker === number && (c.Leg || 1) === leg) || null;

  /// Point a leg at a node, or at nothing. The chain is kept — the pick writes the clamp behind it.
  const mapLeg = (panelId        , number        , leg        , channel        , wire        , whole = false) => {
    const existing = clampFor(panelId, number, leg);
    if (!channel) {
      const at = clampsIn().indexOf(existing);
      if (at >= 0) clampsIn().splice(at, 1);
      return;
    }
    if (existing) { existing.Channel = channel; existing.Whole = whole; if (wire) existing.Wire = wire; return; }
    clampsIn().push({ Label: `${number} L${leg}`, Panel: panelId, Breaker: number, Leg: leg, Wire: wire, Channel: channel, Whole: whole });
  };

  /// Which breaker a node is already measuring, so the picker can say so rather than let it be claimed twice.
  const takenBy = (channel        , panelId        , number        , leg        ) => {
    const other = clampsIn().find((c     ) => c.Channel === channel
      && !(c.Panel === panelId && c.Breaker === number && (c.Leg || 1) === leg));
    return other ? `${other.Panel}/${other.Breaker}` : '';
  };

  /// Power below this, in watts, is noise rather than a circuit drawing something — the same floor the bridge's own check uses.
  const TRACE_FLOOR = 5;

  /// Every node that could be the channel measuring a circuit: not a panel, and not a synthetic tier.
  const traceCandidates = () => nodes.filter(n => PANEL_CIRCUIT_KINDS.includes(n.kind)
    && !panelsIn().some((p     ) => p.Node === n.id || p.Id === n.id)
    && !n.id.startsWith('breaker:'));

  /// What every node is reading right now, for the before and after of a trace.
  const readAll = async ()                                         => {
    const out                                = {};
    try {
      const f      = await api('/api/flow');
      if (f?.body?.ok) (f.body.nodes || []).forEach((n     ) => { out[n.id] = typeof n.value === 'number' ? n.value : null; });
    } catch { /* nothing read is nothing to compare */ }
    return out;
  };

  /// Identify a breaker by switching it off and reading which channel went dark (#456).
  const trace = (panel       , start                ) => {
    const live = panel.breakers.filter(b => b.state !== 'unused');
    const pick = el('select', { class: 'ps-trace-pick' })                     ;
    live.forEach(b => pick.appendChild(el('option', {
      value: `${b.slot}|${b.number}`,
      text: `${b.number} — ${b.description || 'not identified'}${b.legs.some(l => l.channel) ? ' (already mapped)' : ''}`,
    })));
    const chosen = start || live.find(b => !b.legs.some(l => l.channel)) || live[0];
    if (chosen) pick.value = `${chosen.slot}|${chosen.number}`;
    const breakerNow = () => live.find(b => `${b.slot}|${b.number}` === pick.value) || chosen;

    const step = el('div', { class: 'desc ps-trace-step' });
    const result = el('div', { class: 'ps-trace-out' });
    const take = btn('Take the baseline', 'primary');
    const again = btn('Read again');
    again.hidden = true;
    let before                                       = null;
    let watching      = null;

    const stop = () => { if (watching) { clearInterval(watching); watching = null; } };

    const compare = async () => {
      if (!before) return;
      const b = breakerNow();
      const after = await readAll();
      const cand = traceCandidates();
      const was = (id        ) => before [id];
      const drawing = cand.filter(n => typeof was(n.id) === 'number' && (was(n.id)          ) > TRACE_FLOOR);
      // A channel that went dark: it was drawing, and now it is not. One that stopped reporting altogether is
      // not a channel that went dark, so it is not offered as the answer.
      const dropped = drawing.filter(n => typeof after[n.id] === 'number'
        && (after[n.id]          ) <= Math.max(TRACE_FLOOR, (was(n.id)          ) * 0.15));
      result.innerHTML = '';
      if (!drawing.length) {
        // Nothing was drawing to begin with, so switching anything off changes nothing anyone can read.
        result.appendChild(el('div', { class: 'ps-trace-note is-warn' },
          'Nothing was drawing when the baseline was taken, so a breaker going off changes nothing that can be read. '
          + 'Switch something on the circuit on — a lamp, a heater, the appliance itself — then take the baseline again.'));
        return;
      }
      if (!dropped.length) {
        result.appendChild(el('div', { class: 'ps-trace-note is-warn' },
          `${drawing.length} channel(s) are drawing power and none of them went dark. Either the breaker is still on, or `
          + 'nothing measures what it feeds — a circuit with no CT on it cannot be traced this way.'));
        return;
      }
      result.appendChild(el('div', { class: 'desc', text: dropped.length === 1
        ? 'One channel went dark while the breaker was off:'
        : `${dropped.length} channels went dark while the breaker was off — a 240 V circuit drops both its legs at once:` }));
      dropped.forEach((n, i) => {
        const row = el('div', { class: 'ps-trace-hit' });
        row.dataset.node = n.id;
        row.appendChild(el('span', { class: 'ps-trace-name', text: `${n.label} (${n.id})` }));
        row.appendChild(el('span', { class: 'ps-trace-fall',
          text: `${Math.round(was(n.id)          ).toLocaleString('en-US')} W → ${Math.round(after[n.id]          ).toLocaleString('en-US')} W` }));
        // A channel already recorded against another breaker: one of the two records is wrong, so it is said here.
        const held = takenBy(n.id, panel.id, b.number, 1);
        if (held) row.appendChild(el('span', { class: 'ps-trace-held', text: `already measuring ${held}` }));
        const map = (leg        ) => {
          const cfg = configBreaker(panel.id, b);
          mapLeg(panel.id, b.number, leg, n.id, cfg?.Wire || '');
          if (cfg) cfg.State = 'identified';
          refreshDirty();
          stop();
          closeSheet();
          toast(`${b.number} is measured by ${n.label}. Press Save to keep it.`, true);
          load();
        };
        if (b.poles === 2) {
          const one = btn('It is leg 1'), two = btn('It is leg 2');
          one.onclick = () => map(1);
          two.onclick = () => map(2);
          row.append(one, two);
        } else {
          const it = btn('This is it', 'primary');
          it.onclick = () => map(1);
          row.appendChild(it);
        }
        if (i === 0 && b.poles === 2 && dropped.length === 2) {
          const both = btn('Both legs are this breaker', 'primary');
          both.onclick = () => {
            const cfg = configBreaker(panel.id, b);
            dropped.slice(0, 2).forEach((d, leg) => mapLeg(panel.id, b.number, leg + 1, d.id, cfg?.Wire || ''));
            if (cfg) cfg.State = 'identified';
            refreshDirty();
            stop();
            closeSheet();
            toast(`${b.number} is measured by ${dropped[0].id} and ${dropped[1].id}. Press Save to keep it.`, true);
            load();
          };
          result.appendChild(both);
        }
        result.appendChild(row);
      });
    };

    take.onclick = async () => {
      before = await readAll();
      const drawing = traceCandidates().filter(n => typeof before [n.id] === 'number' && (before [n.id]          ) > TRACE_FLOOR).length;
      step.textContent = `Baseline taken: ${drawing} of ${traceCandidates().length} channels are drawing power. `
        + `Now switch ${breakerNow()?.number || 'the breaker'} off. The reading is checked every few seconds — or press Read again.`;
      again.hidden = false;
      take.textContent = 'Take the baseline again';
      result.innerHTML = '';
      stop();
      watching = setInterval(() => compare(), 4000);
    };
    again.onclick = () => compare();
    pick.onchange = () => { result.innerHTML = ''; };
    step.textContent = 'Take a baseline of what every channel is drawing, then switch the breaker off.';

    openSheet({
      title: 'Trace a breaker',
      wide: true,
      onClose: stop,
      body: el('div', { class: 'ps-trace' },
        el('div', { class: 'desc' }, 'Switching a breaker off and reading which channel went dark identifies it without guessing. '
          + 'The circuit has to be drawing something for the drop to be visible.'),
        el('label', { class: 'ld-inst' }, 'Breaker ', pick),
        step, result),
      footer: [take, again],
    });
  };

  const edit = (panel       , b                , slot        , presetHalf         ) => {
    const entry = b ? configBreaker(panel.id, b) : null;
    const wasNumber = b?.number || '';
    const field = (label        , input     , hint         ) =>
      el('div', { class: 'ps-field' }, el('label', { class: 'ps-label', text: label }), input,
        ...(hint ? [el('div', { class: 'desc', style: { margin: '2px 0 0' }, text: hint })] : []));
    const text = (value        , placeholder = '') => {
      const i = el('input', { type: 'text', placeholder })                    ;
      i.value = value;
      return i;
    };
    const number = text(b?.number || String(slot), 'as written, e.g. B06 or 26.1');
    const description = text(b?.description || '', 'what it feeds');
    const wire = text(b?.wire || '', 'e.g. W11');
    const gauge = text(b?.gauge || '', 'e.g. 12 AWG THWN');
    const conductor = el('select', {})                     ;
    [['', 'not stated'], ['copper', 'copper'], ['aluminium', 'aluminium']].forEach(([v, t]) => conductor.appendChild(el('option', { value: v, text: t })));
    conductor.value = b?.conductor || '';
    const amps = el('input', { type: 'number', min: '1', placeholder: 'e.g. 20' })                    ;
    amps.value = b?.amps == null ? '' : String(b.amps);
    const poles = el('select', {})                     ;
    [['1', 'single pole'], ['2', 'double pole (spans the next slot down)']].forEach(([v, t]) => poles.appendChild(el('option', { value: v, text: t })));
    poles.value = String(b?.poles || 1);
    const half = el('select', {})                     ;
    [['', 'the whole slot'], ['1', 'tandem, upper half'], ['2', 'tandem, lower half']].forEach(([v, t]) => half.appendChild(el('option', { value: v, text: t })));
    half.value = String(b?.half || presetHalf || '');
    const stateSel = el('select', {})                     ;
    [['identified', 'Identified'], ['unknown', 'Not identified yet'], ['unused', 'Unused slot']]
      .forEach(([v, t]) => stateSel.appendChild(el('option', { value: v, text: t })));
    stateSel.value = b?.state || 'unknown';

    // One picker per leg: which node the bridge already reads is this circuit. A 240 V circuit is often
    // measured by a single CT, which is the whole breaker rather than half of it.
    const wholeBox = el('input', { type: 'checkbox', class: 'ps-whole' })                    ;
    wholeBox.checked = !!clampFor(panel.id, wasNumber, 1)?.Whole;
    const pickers                      = [];
    const pickerRows = el('div', {});
    // A house has more channels than anyone wants to scroll: type to narrow them.
    const hunt = el('input', { type: 'search', class: 'ps-hunt', placeholder: 'filter channels by name or id…' })                    ;
    const huntCount = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
    // What carries this breaker: any panel in the directory, and whatever feeds this one, up the chain. A
    // breaker cannot be measured by something it hangs beneath.
    const above = new Set        ();
    panelsIn().forEach((p     ) => { if (p.Id) above.add(p.Id); if (p.Node) above.add(p.Node); });
    const walkUp = (id        ) => { if (!id || above.has(id)) return; above.add(id); parentsOf(id).forEach(walkUp); };
    walkUp(configPanel(panel.id)?.Node || panel.node || '');
    // A breaker's own tier is not a channel either: nothing measures it, so nothing can be measured by it.
    const candidates = () => nodes.filter(n => PANEL_CIRCUIT_KINDS.includes(n.kind) && !n.id.startsWith('breaker:') && !above.has(n.id));
    /// The channels worth showing: those matching what was typed, and whatever is already picked, which must
    /// never be filtered out from under the person looking at it — a pick the list has lost would be cleared
    /// by the next Apply.
    const matching = (chosen        ) => {
      const q = hunt.value.trim().toLowerCase();
      const list = candidates();
      if (chosen && !list.some(n => n.id === chosen))
        list.push(nodes.find(n => n.id === chosen) || { id: chosen, label: `${chosen} — nothing reads it`, kind: 'node' });
      return list.filter(n => !q || n.id.toLowerCase().includes(q) || (n.label || '').toLowerCase().includes(q) || n.id === chosen);
    };
    const drawPickers = () => {
      pickerRows.innerHTML = '';
      pickers.length = 0;
      const doublePole = Number(poles.value) === 2;
      if (doublePole)
        pickerRows.appendChild(el('div', { class: 'ps-field' },
          el('label', { class: 'ld-inst' }, wholeBox, ' One CT measures the whole circuit, not one leg')));
      pickerRows.appendChild(el('div', { class: 'ps-field' }, el('label', { class: 'ld-inst' }, hunt, huntCount)));
      const legs = doublePole && !wholeBox.checked ? [1, 2] : [1];
      legs.forEach(leg => {
        const chosen = clampFor(panel.id, wasNumber, leg)?.Channel || '';
        const sel = el('select', { class: 'ps-node' })                     ;
        const fill = (keep        ) => {
          sel.innerHTML = '';
          sel.appendChild(el('option', { value: '', text: '— nothing measuring it —' }));
          const shown = matching(keep);
          shown.forEach(n => {
            const taken = takenBy(n.id, panel.id, wasNumber || number.value, leg);
            sel.appendChild(el('option', { value: n.id, text: `${n.label} (${n.id})${taken ? ` — already on ${taken}` : ''}` }));
          });
          sel.value = keep;
          huntCount.textContent = `${shown.length} of ${candidates().length} channels`;
        };
        fill(chosen);
        (sel       )._fill = fill;
        pickers.push(sel);
        pickerRows.appendChild(field(legs.length > 1 ? `Measured by (leg ${leg})` : 'Measured by', sel,
          legs.length > 1 ? 'Both legs need a node before this breaker reports its power.' : ''));
      });
      // Filtering keeps whatever is picked, so narrowing the list never quietly unpicks it.
      hunt.oninput = () => pickers.forEach(p => (p       )._fill(p.value));
    };
    poles.onchange = () => drawPickers();
    wholeBox.onchange = () => drawPickers();
    drawPickers();

    // The rooms and areas the circuit serves (#459), and what is placed on it on the floor plans (#464).
    const served = new Set        (entry?.Rooms || []);
    const serves = el('div', { class: 'ps-serves' });
    const places = locationChoices();
    places.forEach(([id, label]) => {
      const cb = el('input', { type: 'checkbox' })                    ;
      cb.checked = served.has(id);
      cb.onchange = () => { if (cb.checked) served.add(id); else served.delete(id); };
      serves.appendChild(el('label', { class: 'ld-inst' }, cb, ' ' + label.trim()));
    });
    const servesField = field('Serves', places.length ? serves : el('div', { class: 'desc', text: 'No rooms yet — add them on the Floor Plans page.' }),
      'The rooms and areas this circuit feeds. A room then lists it among the circuits serving it.');
    const onIt = ((state.data?.EnergyFlow?.Placements || [])         ).filter(p => wasNumber && p.Circuit === `${panel.id}/${wasNumber}`);
    const placedField = field('Placed on it', onIt.length
      ? el('ul', { class: 'ps-placed' }, ...onIt.map(p => el('li', { text: `${p.Label || p.Kind}${p.Room ? ' — ' + p.Room : ''}` })))
      : el('div', { class: 'desc', text: 'Nothing on the floor plans is linked to this circuit.' }));

    const save = btn('Apply', 'primary');
    save.onclick = () => {
      const target = entry || { Slot: slot };
      const newNumber = number.value.trim() || String(slot);
      target.Slot = slot;
      target.Number = newNumber;
      target.Description = description.value.trim();
      target.Wire = wire.value.trim();
      target.Gauge = gauge.value.trim();
      target.Conductor = conductor.value;
      target.Amps = amps.value ? Number(amps.value) : null;
      target.Poles = Number(poles.value) || 1;
      target.Half = half.value ? Number(half.value) : null;
      target.State = stateSel.value;
      target.Rooms = [...served];
      if (!entry) {
        const p = configPanel(panel.id);
        if (p) ensure(p, 'Breakers', []).push(target);
      }
      // A renamed breaker keeps the clamps, placements and devices that were recorded against its old number.
      if (wasNumber && wasNumber !== newNumber) {
        clampsIn().filter((c     ) => c.Panel === panel.id && c.Breaker === wasNumber).forEach((c     ) => { c.Breaker = newNumber; });
        const was = `${panel.id}/${wasNumber}`, now = `${panel.id}/${newNumber}`;
        [...((flowIn().Placements || [])         ), ...((flowIn().Nodes || [])         )].forEach((x     ) => { if (x.Circuit === was) x.Circuit = now; });
      }
      const whole = target.Poles === 2 && wholeBox.checked;
      pickers.forEach((sel, i) => mapLeg(panel.id, newNumber, i + 1, sel.value, target.Wire, whole && i === 0));
      // One CT for the whole circuit leaves no second leg to record.
      if (whole || target.Poles === 1) mapLeg(panel.id, newNumber, 2, '', '');
      // The breaker is a node of the flow in its own right (#458), beneath its panel and above its channels,
      // so nothing has to be wired by hand here.
      refreshDirty();
      closeSheet();
      toast('Breaker updated. Press Save to keep it.', true);
      load();
    };
    const traceBtn = btn('Trace it…');
    traceBtn.title = 'Identify this breaker by switching it off and reading which channel went dark.';
    traceBtn.onclick = () => { if (b) trace(panel, b); };
    traceBtn.hidden = !b;

    const remove = btn('Remove', 'danger');
    remove.hidden = !entry;
    remove.onclick = () => {
      const p = configPanel(panel.id);
      const list = p ? ensure(p, 'Breakers', []) : [];
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
      refreshDirty();
      closeSheet();
      toast('Breaker removed. Press Save to keep it.', true);
      load();
    };

    openSheet({
      title: `Slot ${slot}${b ? ` — ${b.number}` : ''}`,
      body: el('div', {}, field('Breaker number', number), field('What it feeds', description),
        field('Wire label', wire), field('Wire gauge', gauge), field('Conductor', conductor),
        field('Rating (A)', amps), field('Poles', poles),
        field('Tandem', half, 'A tandem breaker is two half-height breakers sharing one slot.'),
        field('State', stateSel), pickerRows, servesField, placedField,
        ...(b?.node ? [field('On the energy flow', el('div', {
          class: 'desc',
          style: { margin: '0' },
          // A breaker measured by one channel is that channel: a tier above it would carry the same reading twice.
          text: (b.legs.some(l => l.channel === b.node)
            ? `It is the channel measuring it, ${b.node} — beneath ${panel.name || panel.id}. The circuit and the channel are one node, not two.`
            : `${b.derived ? 'This breaker is a tier of its own, ' : 'It is '}${b.node} — beneath ${panel.name || panel.id}, valued from `
              + `${b.legs.map(l => l.channel).filter(Boolean).join(' + ') || 'nothing measuring it yet'}.`)
            + ' It reaches Home Assistant, EmonCMS and Prometheus like any other node.',
        }))] : [])),
      footer: [save, traceBtn, remove],
    });
  };

  /// What this breaker has been drawing: the channels measuring it, summed the way its power is.
  const history = (panel       , b         ) => {
    const toEditor = btn('Edit breaker');
    toEditor.onclick = () => edit(panel, b, b.slot);
    const channels = b.legs.map(l => l.channel).filter(Boolean)            ;
    openHistorySheet({
      title: `${b.number}${b.description ? ' — ' + b.description : ''}${b.amps ? ` (${b.amps} A)` : ''}`,
      nodes: channels,
      lineLabel: `${b.number}${b.description ? ' — ' + b.description : ''}`,
      labelOf,
      empty: GAPS[b.gap] || 'Nothing is measuring this breaker, so there is nothing to chart.',
      // A 240 V circuit is the sum of its legs, and each leg is worth seeing on its own.
      parts: channels.length > 1 ? channels : [],
      partsLabel: 'Its legs',
      footer: [toEditor],
    });
  };

  const powerText = (b         ) => unitSel.value === 'A'
    ? (b.current == null ? 'no data' : `${b.current.toFixed(1)} A`)
    : (b.power == null ? 'no data' : `${Math.round(b.power).toLocaleString('en-US')} W`);

  /// How hard the circuit is working, against the breaker holding it. Only ever from a current reading —
  /// dividing watts by a voltage nobody measured would be a number we made up.
  const loadOf = (b         ) => (b.current == null || !b.amps ? null : b.current / b.amps);
  const loadClass = (b         ) => {
    const load = loadOf(b);
    return load == null ? '' : load >= 0.8 ? ' is-over' : load >= 0.6 ? ' is-busy' : ' is-easy';
  };

  /// Whether a breaker's number says anything the slot stamp has not already said: "1,3" in slots 1+3 has not,
  /// but "B06" and a tandem's "26.1" have.
  const saysMore = (number        , slotLabel        ) => {
    const digits = (s        ) => (s.match(/\d+/g) || []).join(',');
    return !!number && digits(number) !== digits(slotLabel);
  };

  const drawChecks = (drawn              ) => {
    checks.innerHTML = '';
    const mine = findings.filter(f => !f.breakers.length || f.breakers.some(b => b.split('/')[0] === drawn?.id));
    if (!mine.length) return;
    checks.appendChild(el('h3', { class: 'ps-checks-head', text: `${mine.length} thing${mine.length > 1 ? 's' : ''} to look at` }));
    mine.forEach(f => {
      const row = el('div', { class: 'ps-check is-' + f.severity }, el('span', { class: 'ps-check-kind', text: CHECK_TITLES[f.kind] || f.kind }), el('span', { class: 'ps-check-msg', text: f.message }));
      // Straight to the breaker it names, so it can be put right.
      f.breakers.forEach(ref => {
        const [panelId, number] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
        const b = panels.find(p => p.id === panelId)?.breakers.find(x => x.number === number);
        if (!b) return;
        const go = btn(number);
        go.title = `Open breaker ${number}`;
        go.onclick = () => { if (panelSel.value !== panelId) { panelSel.value = panelId; render(); } edit(panels.find(p => p.id === panelId) , b, b.slot); };
        row.appendChild(go);
      });
      checks.appendChild(row);
    });
  };

  /// Paste a directory, see what each line reads as, then write it into the panel (#455).
  const importSheet = () => {
    const panel = shown();
    if (!panel) { toast('Add a panel first.', false); return; }
    const body = el('div', { class: 'ps-import' });
    const text = el('textarea', { class: 'ps-paste', rows: '10', spellcheck: 'false',
      placeholder: 'B06,W11,N30,1,5: Lights, Garage, Kitchen\nB07: Bathroom????\n1,3: AC Heat Strips\nB26.1: W21: Servers' })                       ;
    const file = el('input', { type: 'file', accept: '.csv,.txt,text/plain,text/csv', class: 'ps-file' })                    ;
    file.onchange = async () => { const picked = file.files?.[0]; if (picked) { text.value = await picked.text(); read(); } };
    const pick = btn('Open a file…');
    pick.onclick = () => file.click();
    const out = el('div', { class: 'ps-rows' });
    const summary = el('div', { class: 'desc' });
    let rows        = [];

    const read = async () => {
      out.innerHTML = '';
      summary.textContent = 'Reading…';
      let r     ;
      try { r = await api('/api/panels/import', { method: 'POST', body: JSON.stringify({ text: text.value, panel: panel.id, config: { EnergyFlow: flowIn() } }) }); }
      catch (e     ) { r = { body: { ok: false, message: e?.message } }; }
      if (!r.body?.ok) { summary.textContent = r.body?.message || 'Could not read it.'; return; }
      rows = r.body.rows || [];
      // Which line of the box each row came from, so one that could not be read can be corrected in place.
      const raw = text.value.replace(/\r\n?/g, '\n').split('\n');
      let at = -1;
      rows.forEach((x     ) => {
        at = raw.findIndex((l, i) => i > at && l.trim().length > 0 && !l.trim().startsWith('#') && !l.trim().startsWith('//'));
        x.at = at;
      });
      const ok = rows.filter((x     ) => !x.note);
      summary.textContent = rows.length
        ? `${ok.length} of ${rows.length} line(s) read: ${ok.filter((x     ) => x.effect === 'add').length} new, `
          + `${ok.filter((x     ) => x.effect === 'update').length} updated, ${ok.filter((x     ) => x.effect === 'clash').length} clashing with a slot already taken. `
          + 'Nothing is written until you apply it, and nothing is kept until you press Save.'
        : 'Nothing to read yet.';
      rows.forEach((x     ) => {
        const row = el('div', { class: 'ps-row is-' + (x.note ? 'bad' : x.effect) });
        if (x.note) {
          // Not read: the line itself is the field, so it can be put right without hunting for it above.
          const fix = el('input', { class: 'ps-row-fix', value: x.line, spellcheck: 'false' })                    ;
          fix.onchange = () => {
            const lines = text.value.replace(/\r\n?/g, '\n').split('\n');
            if (x.at >= 0 && x.at < lines.length) { lines[x.at] = fix.value; text.value = lines.join('\n'); read(); }
          };
          row.appendChild(fix);
          row.appendChild(el('span', { class: 'ps-row-note', text: x.note }));
        }
        else {
          row.appendChild(el('span', { class: 'ps-row-line', text: x.line }));
          const bits = [x.number, x.poles === 2 ? 'double-pole' : x.half ? `tandem half ${x.half}` : '', x.wire, x.amps ? `${x.amps} A` : '',
            x.channel ? (x.channelKnown ? x.channel : `${x.channel} — no node with that id`) : '',
            x.description || (x.state === 'unused' ? 'unused' : 'not identified')];
          row.appendChild(el('span', { class: 'ps-row-read' + (x.channel && !x.channelKnown ? ' is-warn' : ''), text: bits.filter(Boolean).join(' · ') }));
          row.appendChild(el('span', { class: 'ps-row-effect', text: x.effect === 'add' ? 'new' : x.effect === 'update' ? 'updates it' : 'slot taken' }));
        }
        out.appendChild(row);
      });
    };
    text.oninput = () => { clearTimeout((text       )._t); (text       )._t = setTimeout(read, 250); };

    const apply = btn('Apply to the panel', 'primary');
    apply.onclick = () => {
      const cfg = configPanel(panel.id);
      if (!cfg) return;
      const list = ensure(cfg, 'Breakers', []);
      let added = 0, updated = 0, clashes = 0, mapped = 0;
      rows.filter((x     ) => !x.note).forEach((x     ) => {
        if (x.effect === 'clash') { clashes++; return; }
        let target = list.find((b     ) => String(b.Number || '').toLowerCase() === String(x.number).toLowerCase());
        if (target) updated++; else { target = { Slot: x.slot }; list.push(target); added++; }
        Object.assign(target, {
          Slot: x.slot, Number: x.number, Poles: x.poles, Half: x.half ?? null, Wire: x.wire || target.Wire || '',
          Description: x.description, State: x.state,
        });
        if (x.amps) target.Amps = x.amps;
        // A channel the line named, recorded as the clamp that measures the breaker.
        if (x.channel && x.channelKnown) { mapLeg(panel.id, x.number, 1, x.channel, x.wire || ''); mapped++; }
      });
      refreshDirty();
      closeSheet();
      toast(`${added} breaker(s) added, ${updated} updated${mapped ? `, ${mapped} mapped to a channel` : ''}`
        + `${clashes ? `, ${clashes} left alone because their slot is taken` : ''}. Press Save to keep it.`, true);
      load();
    };
    body.append(el('div', { class: 'desc', text: 'Paste the directory you already keep. Each line can carry the breaker number, the wire label, the monitor channel and what it feeds, in any order; “????” marks one nobody has identified and “Unused” an empty slot.' }),
      text, el('div', { class: 'ld-toolbar', style: { gap: '8px' } }, pick, file), summary, out);
    openSheet({ title: `Import into ${panel.name || panel.id}`, body, wide: true, footer: [apply] });
  };
  importBtn.onclick = () => importSheet();

  /// What a breaker reads as on paper: what it feeds, or that nobody has identified it. Never blank —
  /// a slot nobody has written down is the point of printing it.
  const printWords = (b         ) =>
    b.state === 'unused' ? 'Unused'
      : b.state === 'unknown' ? (b.description ? `${b.description} ????` : 'Unknown — not identified')
        : b.description || 'Unknown — not identified';

  /// The directory laid out as the panel is, for the door: odd slots down the left, even down the right.
  const drawPrint = (p       , slots        ) => {
    printable.innerHTML = '';
    const when = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    printable.appendChild(el('div', { class: 'ps-print-head' },
      el('h3', { text: p.name || p.id }),
      el('span', { class: 'ps-print-when', text: `${slots} slots · ${when}` })));
    const table = el('table', { class: 'ps-print-grid' });
    const head = el('tr');
    ['Circuit', 'Wire', 'A', '#', '#', 'A', 'Wire', 'Circuit'].forEach(h => head.appendChild(el('th', { text: h })));
    table.appendChild(el('thead', {}, head));
    const body = el('tbody');
    const holding = (slot        ) => p.breakers.filter(b => (b.poles === 2 ? [b.slot, b.slot + 2] : [b.slot]).includes(slot));
    const side = (slot        , tr     , mirrored         ) => {
      const on = holding(slot);
      const words = on.length
        ? on.map(b => b.slot === slot ? printWords(b) : `${b.number} — the other half of the breaker above`).join(' / ')
        : 'Empty';
      const cells = [
        el('td', { class: 'ps-print-desc' + (on.some(b => b.state === 'unknown') ? ' is-unknown' : on.length ? '' : ' is-empty'), text: words }),
        el('td', { class: 'ps-print-wire', text: on.map(b => b.wire).filter(Boolean).join(' / ') }),
        el('td', { class: 'ps-print-amps', text: on.map(b => b.amps ? String(b.amps) : '').filter(Boolean).join(' / ') }),
        el('td', { class: 'ps-print-slot', text: String(slot) }),
      ];
      (mirrored ? [...cells].reverse() : cells).forEach(c => tr.appendChild(c));
    };
    for (let slot = 1; slot <= slots; slot += 2) {
      const tr = el('tr');
      tr.dataset.slot = String(slot);
      side(slot, tr, false);
      if (slot + 1 <= slots) side(slot + 1, tr, true);
      body.appendChild(tr);
    }
    table.appendChild(body);
    printable.appendChild(table);
  };

  const render = () => {
    grid.innerHTML = '';
    const drawn = shown();
    const cfg = drawn ? configPanel(drawn.id) : null;
    settings.hidden = !drawn;
    if (!drawn) {
      grid.appendChild(el('div', { class: 'desc', text: 'No panels yet. Add one to start a directory, then fill in its slots.' }));
      return;
    }
    // The config is what is being edited, so the drawing follows it rather than the last answer from the API.
    const slots = Number(cfg?.Slots) || drawn.slots;
    const rows = Math.ceil(slots / 2);
    nameIn.value = cfg?.Name ?? drawn.name;
    whereBox.innerHTML = '';
    const whereSel = choiceSelect(locationChoices(), cfg?.Location || '', '— not placed —');
    whereSel.title = 'The room, area or floor this panel is mounted in.';
    whereSel.onchange = () => { if (cfg) { cfg.Location = whereSel.value || undefined; refreshDirty(); } };
    whereBox.appendChild(whereSel);
    slotsIn.value = String(slots);

    // Which node is this panel, and what feeds it.
    const panelNode = cfg?.Node ?? drawn.node ?? '';
    nodeSel.innerHTML = '';
    nodeSel.appendChild(el('option', { value: '', text: '— not mapped —' }));
    // A panel is a panel: only a node of that kind, and not one another panel in the directory already is.
    const claimed = new Set(panelsIn().filter((p     ) => p.Id !== drawn.id).map((p     ) => p.Node).filter(Boolean));
    const panelChoices = nodes.filter(n => n.kind === 'panel' && !claimed.has(n.id));
    // What is already recorded stays in the list, even where it is not a panel: opening the page must never
    // quietly re-point the panel at something else.
    if (panelNode && !panelChoices.some(n => n.id === panelNode))
      panelChoices.push(nodes.find(n => n.id === panelNode) || { id: panelNode, label: panelNode, kind: 'node' });
    panelChoices.forEach(n => nodeSel.appendChild(el('option', {
      value: n.id, text: `${n.label} (${n.id})${n.kind === 'panel' ? '' : ' — not a panel'}`,
    })));
    nodeSel.value = panelNode;
    feeders.innerHTML = '';
    const fedBy = panelNode ? parentsOf(panelNode) : [];
    fedBy.forEach(from => {
      const chip = el('span', { class: 'ps-chip' }, el('span', { text: labelOf(from) }));
      const drop = el('button', { class: 'ps-chip-x', text: '×', title: `${labelOf(from)} no longer feeds this panel` });
      drop.onclick = () => {
        const links = linksIn();
        for (let i = links.length - 1; i >= 0; i--) if (links[i].To === panelNode && links[i].From === from) links.splice(i, 1);
        refreshDirty();
        render();
      };
      chip.appendChild(drop);
      feeders.appendChild(chip);
    });
    if (!fedBy.length) feeders.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: panelNode ? 'nothing yet' : 'pick the panel’s node first' }));
    feedAdd.innerHTML = '';
    feedAdd.appendChild(el('option', { value: '', text: '+ add a feeder' }));
    nodes.filter(n => n.id !== panelNode && !fedBy.includes(n.id))
      .forEach(n => feedAdd.appendChild(el('option', { value: n.id, text: `${n.label} (${n.id})` })));
    // A panel is fed from one place. Once that is said, the way to change it is to drop it and pick again.
    feedAdd.hidden = !panelNode || fedBy.length > 0;
    feedAdd.disabled = !panelNode;

    // The mains figure: power, and the voltage beside it when whatever measures the panel reports one.
    const volts = drawn.volts == null ? '' : ` at ${drawn.volts.toFixed(1)} V`;
    incoming.textContent = !panelNode
      ? 'No node is mapped to this panel, so there is no incoming power to draw. Pick one above.'
      : drawn.incoming == null
        ? `Incoming: no data${volts ? `, though ${labelOf(panelNode)} reports${volts}` : ` — ${labelOf(panelNode)} has no current reading`}.`
        : `Incoming: ${Math.round(drawn.incoming).toLocaleString('en-US')} W${volts} through ${labelOf(panelNode)}.`;
    drawChecks(drawn);
    drawPrint(drawn, slots);
    // Every slot is one row tall, so a double-pole spanning two is twice the height of a single — with `auto`
    // the two rows it spans had nothing else in them and split its height between them instead.
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(var(--ps-row), auto))`;

    [true, false].forEach(left => {
      column(slots, drawn.breakers, left).forEach(cell => {
        const place = `${rowOf(cell.slot)} / span ${cell.span}`;
        const box = el('div', {
          // The column decides which way the breaker faces: handles point at the bus bar down the middle.
          // A breaker holding two slots has the room of two, so it is read at the size it is drawn.
          class: 'ps-cell ' + (left ? 'is-left' : 'is-right') + (cell.span === 2 ? ' is-double' : '')
            + (cell.halves.length ? '' : ' is-empty'),
          style: { gridColumn: left ? '2' : '3', gridRow: place },
        });
        box.dataset.slot = String(cell.slot);
        const slotLabel = String(cell.slot) + (cell.span === 2 ? `+${cell.slot + 2}` : '');
        // Stamped down the outside edge of the frame, as a panel is: one number per slot, counted down.
        const stamped = el('div', {
          class: 'ps-nums',
          style: { gridColumn: left ? '1' : '4', gridRow: place },
        }, ...(cell.span === 2 ? [cell.slot, cell.slot + 2] : [cell.slot]).map(n => el('span', { text: String(n) })));
        stamped.setAttribute('aria-hidden', 'true');
        grid.appendChild(stamped);
        if (!cell.halves.length) {
          const blank = el('span', { class: 'ps-breaker is-empty' }, el('span', { class: 'ps-pole is-empty' }));
          blank.setAttribute('aria-hidden', 'true');
          const add = el('button', { class: 'ps-open is-empty' }, blank, el('span', { class: 'ps-desc', text: 'empty' }));
          add.title = `Slot ${cell.slot} — nothing recorded. Tap to add a breaker.`;
          add.onclick = () => edit(drawn, null, cell.slot);
          box.appendChild(add);
        } else {
          cell.halves.forEach(b => {
            // The breaker as it looks in the panel, not a control: nothing here can switch one. A double-pole
            // is two handles with a tie between them, as it is on the wall.
            const poles = b.poles === 2 && cell.span === 2 ? 2 : 1;
            const handle = el('span', { class: 'ps-breaker is-' + b.state });
            for (let i = 0; i < poles; i++)
              handle.appendChild(el('span', { class: 'ps-pole is-' + b.state },
                el('span', { class: 'ps-throw', text: b.amps ? String(b.amps) : '' })));
            if (poles === 2) handle.appendChild(el('span', { class: 'ps-tie' }));
            handle.setAttribute('aria-hidden', 'true');
            const open = el('button', { class: 'ps-open' },
              handle,
              ...(saysMore(b.number, slotLabel) ? [el('span', { class: 'ps-num', text: b.number })] : []),
              el('span', { class: 'ps-desc', text: b.state === 'unused' ? 'Unused' : b.description || 'Not identified' }),
              // The directory's own mark for a circuit nobody has confirmed, description or not.
              ...(b.state === 'unknown' ? [el('span', { class: 'ps-mark', text: '????', title: 'Nobody has identified this circuit yet.' })] : []),
              el('span', { class: 'ps-meta', text: [b.wire, b.amps ? `${b.amps} A` : '', b.gauge].filter(Boolean).join(' · ') }));
            open.title = 'Edit this breaker — what it feeds, its wire, rating, and the node measuring it.';
            open.onclick = () => edit(drawn, b, cell.slot);
            // The reading is its own target: what a circuit is drawing now is also the way into what it has been drawing.
            const shown = unitSel.value === 'A' ? b.current : b.power;
            const reading = el('button', { class: 'ps-power' + (shown == null ? ' is-nodata' : loadClass(b)), text: powerText(b) });
            const load = loadOf(b);
            reading.title = shown == null
              ? (GAPS[b.gap] || 'No reading for this breaker.')
              : (load == null ? '' : `${b.current .toFixed(1)} A of ${b.amps} A — ${Math.round(load * 100)}% of the breaker. `)
                + `Measured by ${b.legs.map(l => l.channel).filter(Boolean).join(' + ')}. Tap for what it has been drawing.`;
            reading.onclick = () => history(drawn, b);
            box.appendChild(el('div', { class: 'ps-half is-' + b.state }, open, reading));
          });
          // A breaker declared as one half of a tandem leaves the other half of its slot to fill in. Saying
          // a slot is shared is the editor's business; what is in the other half is the panel's.
          const lone = cell.halves.length === 1 ? cell.halves[0] : null;
          if (lone?.half) {
            const missing = lone.half === 1 ? 2 : 1;
            const vacant = el('span', { class: 'ps-breaker is-empty' }, el('span', { class: 'ps-pole is-empty' }));
            vacant.setAttribute('aria-hidden', 'true');
            const other = el('button', { class: 'ps-open is-empty' }, vacant,
              el('span', { class: 'ps-desc', text: missing === 1 ? 'empty upper half' : 'empty lower half' }));
            other.title = `Slot ${cell.slot} shares two breakers; this half is empty. Tap to fill it in.`;
            other.onclick = () => edit(drawn, null, cell.slot, missing);
            box.appendChild(other);
          }
        }
        grid.appendChild(box);
      });
    });
  };

  link.onclick = () => { activate(link, sec); load(); };
  // A schedule is read while someone is at the panel, so it keeps up with the channels behind it.
  setInterval(() => { if (sec.classList.contains('active')) load(); }, 10000);
  return { link, sec };
}

// ── sections/floor-plan.ts ──────────────────────────────────────
// Floor Plans (#470): each floor drawn at real size with its rooms, outdoor zones and areas, doors and windows
// (#463), the outlets, fixtures, devices and utility gear placed on it and the cable runs between them (#464,
// #465), shaded live by what each room draws (#466), with a trace that finds an outlet's breaker from the
// outlet (#468). One Edit mode with a tool palette, undo and redo, and sizes in feet or metres.

/// Why a place has no total, in the words the page uses. Never a zero.
const FP_STATE_TEXT                         = {
  unmetered: 'Nothing metered is placed here.',
  unknown: 'A reading this total needs is missing, so it is not shown.',
};

/// The palette: [tool, name, shortcut, what it does].
const FP_TOOLS                                   = [
  ['select', 'Select', 'V', 'Select and move anything: rooms, their corners, items, doors, windows and wire bends.'],
  ['pan', 'Pan', 'H', 'Drag to move around the plan. Two fingers or the wheel with Ctrl also pan and zoom.'],
  ['room', 'Room', 'R', 'Drag a rectangle to draw a room, or add one by its measurements.'],
  ['outline', 'Outline', 'P', 'Tap each corner of an odd-shaped room; tap the first corner again to close it.'],
  ['zone', 'Outdoor', 'O', 'Drag out a yard, porch, patio, driveway or deck.'],
  ['area', 'Area', 'A', 'Drag out an area that may span rooms, such as upstairs or the server corner.'],
  ['door', 'Door', 'D', 'Tap a wall to put a door in it.'],
  ['window', 'Window', 'W', 'Tap a wall to put a window in it.'],
  ['item', 'Item', 'I', 'Tap to place an outlet, light, appliance, panel, meter, pole or anything else.'],
  ['wire', 'Wire', 'L', 'Draw a cable run from the supply side: tap the panel or outlet feeding it, each bend, then the item it goes to.'],
  ['constrain', 'Constrain', 'K', 'Tap corners or walls, then hold them: coincident, colinear, parallel, perpendicular, level, plumb, an angle or a length.'],
  ['measure', 'Measure', 'M', 'Tap two points to measure between them, and set the plan’s scale from a distance you know.'],
];

/// A small line icon for each tool, drawn in the button's own colour.
function fpToolIcon(tool        )      {
  const s = svgEl('svg', { viewBox: '0 0 24 24', class: 'fp-tool-icon', 'aria-hidden': 'true' });
  const p = (d        ) => s.appendChild(svgEl('path', { d }));
  switch (tool) {
    case 'select': p('M5 3 L5 19 L9.5 14.5 L12.5 21 L15 20 L12 13.5 L18 13.5 Z'); break;
    case 'pan': p('M12 3 V21 M3 12 H21 M12 3 L9.5 5.5 M12 3 L14.5 5.5 M12 21 L9.5 18.5 M12 21 L14.5 18.5 M3 12 L5.5 9.5 M3 12 L5.5 14.5 M21 12 L18.5 9.5 M21 12 L18.5 14.5'); break;
    case 'room': p('M4 5 H20 V19 H4 Z M4 12 H10'); break;
    case 'outline': p('M4 7 L11 4 L20 8 L18 19 L6 18 Z'); break;
    case 'zone': p('M12 3 L7 11 H10 L6 17 H18 L14 11 H17 Z M12 17 V21'); break;
    case 'area': p('M4 5 H7 M10 5 H14 M17 5 H20 V8 M20 11 V14 M20 17 V19 H17 M14 19 H10 M7 19 H4 V16 M4 13 V10 M4 7 V5'); break;
    case 'door': p('M4 20 H20 M6 20 V6 M6 6 A14 14 0 0 1 20 20'); break;
    case 'window': p('M3 9 H21 M3 12 H21 M3 15 H21 M3 9 V15 M21 9 V15'); break;
    case 'item': p('M12 3 A9 9 0 1 0 12.01 3 Z M9.5 8 V12 M14.5 8 V12 M12 15.5 V16'); break;
    case 'wire': p('M4 18 C8 18 8 6 12 6 S16 18 20 18 M4 18 A1.5 1.5 0 1 0 4.01 18 M20 18 A1.5 1.5 0 1 0 20.01 18'); break;
    case 'measure': p('M3 16 L16 3 L21 8 L8 21 Z M7 12 L9 14 M10 9 L12 11 M13 6 L15 8'); break;
    case 'constrain': p('M4 20 L20 4 M4 20 H13 M8 20 A6 6 0 0 0 7 15 M17 7 L20 4 L17 1'); break;
    case 'lock': p('M7 11 V8 A5 5 0 0 1 17 8 V11 M5 11 H19 V21 H5 Z'); break;
    case 'undo': p('M9 7 L4 12 L9 17 M4 12 H14 A6 6 0 0 1 14 24'); break;
    case 'redo': p('M15 7 L20 12 L15 17 M20 12 H10 A6 6 0 0 0 10 24'); break;
  }
  return s;
}

function addFloorPlanSection(nav     , sections     ) {
  const link = navLink(nav, 'Floor Plans', '⌗');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section fp' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Floor Plans' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Each floor at real size: rooms and outdoor zones, doors and windows, and the outlets, lights, panels, meters '
    + 'and devices on it with the cable runs between them. View shades each room by what it draws — a room with '
    + 'nothing metered reads unmetered, never zero. Edit draws and moves everything; Ctrl+Z undoes.'));

  // Where things are kept, and whether they will survive a restart: said loudly, above everything, when they will not.
  const banner = el('div', { class: 'fp-banner' });
  banner.hidden = true;
  sec.appendChild(banner);
  let storage      = null;
  const readStorage = async () => {
    try { const r      = await api('/api/plans/storage'); storage = r.body?.ok ? r.body : null; } catch { storage = null; }
    drawBanner();
  };
  const drawBanner = () => {
    banner.innerHTML = '';
    const lines                     = [];
    if (storage && storage.configWritable === false)
      lines.push(['Floor plan changes cannot be saved.', 'The configuration source is read-only, so rooms, items and wiring drawn here are lost when this page is closed. Make the configuration writable, or export the plans to keep them.']);
    if (storage && storage.persistent === false)
      lines.push(['Plan images will not be kept.', storage.why || 'No persistent plan storage is configured.']);
    banner.hidden = !lines.length;
    banner.classList.toggle('is-strong', mode === 'edit');
    lines.forEach(([title, text]) => banner.appendChild(el('div', { class: 'fp-banner-line' }, el('strong', { text: '⚠ ' + title }), el('span', { text: ' ' + text }))));
  };

  // --- Config access -------------------------------------------------------------------------------
  const flowIn = () => ensure(state.data, 'EnergyFlow', {});
  const sitesIn = ()        => ensure(flowIn(), 'Sites', []);
  const itemsIn = ()        => ensure(flowIn(), 'Placements', []);
  const runsIn = ()        => ensure(flowIn(), 'Runs', []);
  const floorsAll = () => sitesIn().flatMap((s     ) => ensure(s, 'Floors', []).map((f     ) => ({ site: s, floor: f })));
  const floorById = (id        ) => floorsAll().find(x => x.floor.Id === id) || null;
  const allIds = () => new Set        (sitesIn().flatMap((s     ) => [s.Id, ...ensure(s, 'Floors', []).flatMap((f     ) =>
    [f.Id, ...ensure(f, 'Rooms', []).map((r     ) => r.Id), ...ensure(f, 'Areas', []).map((a     ) => a.Id)])]));
  const freshId = (base        ) => {
    const stem = (base || 'place').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'place';
    const taken = allIds();
    let id = stem, n = 2;
    while (taken.has(id)) id = `${stem}_${n++}`;
    return id;
  };
  const freshIn = (list       , stem        ) => {
    const taken = new Set(list.map((p     ) => p.Id));
    let n = list.length + 1, id = `${stem}_${n}`;
    while (taken.has(id)) id = `${stem}_${++n}`;
    return id;
  };

  // --- Page state ----------------------------------------------------------------------------------
  const remembered = (key        , fallback        ) => { try { return localStorage.getItem('rpdu-fp-' + key) || fallback; } catch { return fallback; } };
  const remember = (key        , v        ) => { try { localStorage.setItem('rpdu-fp-' + key, v); } catch { /* this session only */ } };
  let floorId = remembered('floor', '');
  let mode                  = 'view';
  let tool       = 'select';
  let itemKind = remembered('kind', 'outlet');
  let doorKind = 'door';
  let wireKind = 'circuit';
  let snapOn = remembered('snap', '1') === '1';
  let showWiring = remembered('wiring', '1') === '1';
  let showSizes = remembered('sizes', '0') === '1';
  let period = remembered('period', 'now');
  let selection            = null;
  /// Everything else selected with it: Shift, Ctrl or ⌘ adds to a selection, and a box drag selects all it holds.
  let extra                           = [];
  let marquee                          = null;
  let spaceDown = false;
  let gfciNext = remembered('gfci', '0') === '1';
  let showCons = remembered('cons', '1') === '1';
  let itemPreset = '';
  let selectedCorner = -1;
  let selectedBend = -1;
  let lastTap                                     = null;
  let draft       = [];
  let rectStart            = null, rectEnd            = null;
  let wireDraft                                     = null;
  let measure                                 = null;
  let live              = null;
  let imageFailed = '';
  let vb = { x: 0, y: 0, w: 1000, h: 700 };
  let viewFor = '';
  let dragging = false;
  let hover            = null;
  let focused = '';
  let touch = false;
  /// Handles a finger can hit: larger on a touch screen.
  const hs = () => (touch ? 1.7 : 1);
  let showBelow = remembered('below', '1') === '1';

  const floorNow = () => floorById(floorId) || floorsAll()[0] || null;
  const roomsNow = ()        => { const f = floorNow(); return f ? ensure(f.floor, 'Rooms', []) : []; };
  const areasNow = ()        => { const f = floorNow(); return f ? ensure(f.floor, 'Areas', []) : []; };
  const openingsNow = ()        => { const f = floorNow(); return f ? ensure(f.floor, 'Openings', []) : []; };
  const shapeOf = (sel           ) => sel?.type === 'room' ? roomsNow().find(r => r.Id === sel.id)
    : sel?.type === 'area' ? areasNow().find(a => a.Id === sel.id) : null;
  const itemOf = (id        ) => itemsIn().find((p     ) => p.Id === id);
  const runOf = (id        ) => runsIn().find((r     ) => r.Id === id);
  const openingOf = (id        ) => openingsNow().find((o     ) => o.Id === id);
  const onFloor = (it     , f     ) => it.Floor === f.Id || (!it.Floor && ensure(f, 'Rooms', []).some((r     ) => r.Id === it.Room));
  const itemsNow = () => { const f = floorNow()?.floor; return f ? itemsIn().filter((p     ) => onFloor(p, f)) : []; };
  const runsNow = () => { const f = floorNow()?.floor; return f ? runsIn().filter((r     ) => r.Floor === f.Id) : []; };
  const placeOf = (id        ) => live?.places[id] || null;
  const nameOfPlace = (id        ) => {
    for (const s of sitesIn()) {
      if (s.Id === id) return s.Name || s.Id;
      for (const f of ensure(s, 'Floors', [])) {
        if (f.Id === id) return f.Name || f.Id;
        for (const r of [...ensure(f, 'Rooms', []), ...ensure(f, 'Areas', [])]) if (r.Id === id) return r.Name || r.Id;
      }
    }
    return id;
  };
  const circuitOf = (ref        ) => live?.circuits.find(c => c.ref === ref) || null;
  const circuitLabel = (c         ) => `${c.panelName} · ${c.number}${c.description ? ' — ' + c.description : ''}`;
  const refLabel = (ref        ) => { const c = circuitOf(ref); return c ? circuitLabel(c) : ref; };
  const nodeLabel = (id        ) => live?.nodes.find(n => n.id === id)?.label || id;
  const kindName = (k        ) => PLAN_KINDS.find(x => x[0] === k)?.[1] || k;
  const itemName = (it     ) => it.Label || kindName(it.Kind || 'outlet');
  const units = () => live?.units || 'W';
  const fmt = (v                           ) => v == null ? 'no data' : formatMeasure(units() === 'W' ? Math.round(v) : Math.round(v * 100) / 100, units());

  // Real sizes: drawing units per metre on this floor, and the unit system the GUI settings ask for.
  const sys = () => planUnitSystem(state.data?.Gui?.DistanceUnits, (globalThis       ).navigator?.language);
  const scale = () => Math.max(1, Number(floorNow()?.floor.Scale) || 100);
  const len = (unitsLong        ) => planFmtLen(unitsLong / scale(), sys());
  const areaText = (poly      ) => planFmtArea(Math.abs(planArea(poly)) / (scale() * scale()), sys());
  const toUnits = (text        ) => { const m = planParseLen(text, sys()); return m == null || m <= 0 ? null : m * scale(); };
  const lenInput = (unitsLong        , onSet                     , placeholder = '') => {
    const i = el('input', { type: 'text', class: 'fp-len', value: unitsLong > 0 ? len(unitsLong) : '', placeholder: placeholder || (sys() === 'imperial' ? `12' 6"` : '3.75 m') })                    ;
    i.onchange = () => {
      const u = toUnits(i.value);
      if (u == null) { i.classList.add('is-bad'); i.title = sys() === 'imperial' ? `Write it like 12' 6", 12 6 or 150"` : 'Write it like 3.75 m, 3 m 75 cm or 375 cm'; return; }
      i.classList.remove('is-bad');
      onSet(u);
    };
    return i;
  };

  // --- Undo and redo -------------------------------------------------------------------------------
  // Snapshots of everything the page edits; restored in place so every other page keeps its reference.
  const history = planHistory(() => flowIn(), v => { const cur = flowIn(); Object.keys(cur).forEach(k => delete cur[k]); Object.assign(cur, v); });
  const changed = () => { refreshDirty(); schedule(); };
  /// One undoable change: remember what was, make the change, redraw.
  const act = (fn            ) => { history.push(); fn(); changed(); render(); };
  const undo = () => { if (history.undo()) { cleanSelection(); changed(); render(); } };
  const redo = () => { if (history.redo()) { cleanSelection(); changed(); render(); } };
  const exists = (x                        ) => x.type === 'item' ? !!itemOf(x.id) : x.type === 'run' ? !!runOf(x.id)
    : x.type === 'opening' ? !!openingOf(x.id) : !!shapeOf(x);
  /// Everything selected, the primary first.
  const selected = ()                           => [...(selection ? [selection] : []), ...extra];
  const isSel = (type         , id        ) => selected().some(x => x.type === type && x.id === id);
  const cleanSelection = () => {
    extra = extra.filter(exists);
    if (!selection) return;
    const gone = selection.type === 'item' ? !itemOf(selection.id) : selection.type === 'run' ? !runOf(selection.id)
      : selection.type === 'opening' ? !openingOf(selection.id) : !shapeOf(selection);
    if (gone) selection = null;
    selectedCorner = -1;
  };

  // --- Layout --------------------------------------------------------------------------------------
  const floorSel = el('select', { class: 'fp-floor', title: 'Which floor to show.' })                     ;
  floorSel.onchange = () => { floorId = floorSel.value; remember('floor', floorId); selection = null; draft = []; wireDraft = null; measure = null; viewFor = ''; render(); };
  const addBtn = btn('+ Floor');
  addBtn.title = 'Add a floor, or a new site with its first floor.';
  const floorBtn = btn('Floor settings');
  const bgBtn = btn('Background');
  bgBtn.title = 'Upload a floor plan image to draw over, set how strongly it shows, and set the scale.';
  const toolsBtn = btn('Tools…');
  const exportBtn = btn('Export…');
  exportBtn.title = 'Download this floor as a picture, or every floor plan as a file you can import again.';
  const printBtn = btn('Print');
  printBtn.title = 'Print this floor, with its rooms, wiring and legend.';
  printBtn.onclick = () => { try { (window       ).print?.(); } catch { /* no print dialog here */ } };
  const undoBtn = el('button', { class: 'small fp-icon-btn', type: 'button', title: 'Undo (Ctrl+Z)' }, fpToolIcon('undo'));
  undoBtn.setAttribute('aria-label', 'Undo');
  undoBtn.onclick = () => undo();
  const redoBtn = el('button', { class: 'small fp-icon-btn', type: 'button', title: 'Redo (Ctrl+Y)' }, fpToolIcon('redo'));
  redoBtn.setAttribute('aria-label', 'Redo');
  redoBtn.onclick = () => redo();
  const status = el('span', { class: 'ld-count fp-status' });
  sec.appendChild(el('div', { class: 'ld-toolbar fp-bar' }, el('label', { class: 'ld-inst' }, 'Floor ', floorSel), addBtn, floorBtn, bgBtn, toolsBtn,
    exportBtn, printBtn, el('span', { class: 'fp-undo' }, undoBtn, redoBtn), status));

  const modeBar = el('div', { class: 'fp-seg', role: 'tablist' });
  const modeBtns                      = {};
  ([['view', 'View'], ['edit', 'Edit']]         ).forEach(([m, label]) => {
    const b = el('button', { class: 'fp-seg-btn', text: label, type: 'button' });
    b.setAttribute('role', 'tab');
    b.onclick = () => { mode = m; tool = 'select'; draft = []; rectStart = null; wireDraft = null; measure = null; selectedCorner = -1; render(); };
    modeBtns[m] = b;
    modeBar.appendChild(b);
  });
  const subBar = el('div', { class: 'fp-sub' });
  sec.appendChild(el('div', { class: 'fp-modes' }, modeBar, subBar));

  const palette = el('div', { class: 'fp-palette', role: 'toolbar' });
  palette.setAttribute('aria-label', 'Drawing tools');
  const toolBtns                      = {};
  FP_TOOLS.forEach(([t, name, key, what]) => {
    const b = el('button', { class: 'fp-tool', type: 'button', title: `${name} (${key}) — ${what}` }, fpToolIcon(t), el('span', { class: 'fp-tool-name', text: name }));
    b.setAttribute('aria-label', name);
    b.onclick = () => pickTool(t);
    toolBtns[t] = b;
    palette.appendChild(b);
  });
  const opts = el('div', { class: 'fp-opts' });

  const svg = svgEl('svg', { class: 'fp-svg', role: 'img' });
  const zoomIn = el('button', { class: 'fp-zbtn', text: '+', title: 'Zoom in (+)', type: 'button' });
  const zoomOut = el('button', { class: 'fp-zbtn', text: '−', title: 'Zoom out (−)', type: 'button' });
  const zoomFit = el('button', { class: 'fp-zbtn', text: '⤢', title: 'Fit the floor (0)', type: 'button' });
  const hint = el('div', { class: 'fp-hint' });
  const scaleBar = el('div', { class: 'fp-scalebar' }, el('span', { class: 'fp-scalebar-bar' }), el('span', { class: 'fp-scalebar-text' }));
  const empty = el('div', { class: 'fp-empty' });
  const fpMenu = makeMenu(() => stage, 'fp-menu');
  const menu = fpMenu.el;
  const stage = el('div', { class: 'fp-stage' }, svg, menu, el('div', { class: 'fp-zoom' }, zoomIn, zoomOut, zoomFit), scaleBar, hint, empty);
  const side = el('aside', { class: 'fp-side' });
  const legend = el('div', { class: 'fp-legend' });
  const body = el('div', { class: 'fp-body' }, palette, el('div', { class: 'fp-main' }, opts, stage, legend), side);
  sec.appendChild(body);

  const pickTool = (t      ) => {
    if (mode !== 'edit') mode = 'edit';
    tool = t; draft = []; rectStart = null; rectEnd = null; wireDraft = null; measure = null; selectedCorner = -1;
    render();
  };

  // --- Coordinates ---------------------------------------------------------------------------------
  const floorSize = () => { const f = floorNow()?.floor; return { w: Number(f?.Width) || 1000, h: Number(f?.Height) || 700 }; };
  /// Plan units per screen pixel: what keeps handles, strokes and labels the same size on screen at any zoom.
  const upp = () => {
    const r = svg.getBoundingClientRect?.();
    if (!r || !r.width || !r.height) return vb.w / 1000;
    return Math.max(vb.w / r.width, vb.h / r.height);
  };
  const toPlan = (e     )     => {
    const r = svg.getBoundingClientRect();
    const k = Math.min(r.width / vb.w, r.height / vb.h) || 1;
    const ox = (r.width - vb.w * k) / 2, oy = (r.height - vb.h * k) / 2;
    return { X: vb.x + (e.clientX - r.left - ox) / k, Y: vb.y + (e.clientY - r.top - oy) / k };
  };
  const fit = () => { const { w, h } = floorSize(); const pad = Math.max(w, h) * 0.03; vb = { x: -pad, y: -pad, w: w + pad * 2, h: h + pad * 2 }; };
  const zoomAt = (p    , factor        ) => {
    const { w } = floorSize();
    const nw = Math.max(w * 0.02, Math.min(w * 4, vb.w / factor));
    const f = vb.w / nw;
    vb = { x: p.X - (p.X - vb.x) / f, y: p.Y - (p.Y - vb.y) / f, w: nw, h: vb.h / f };
    drawPlan();
  };
  const centre = () => ({ X: vb.x + vb.w / 2, Y: vb.y + vb.h / 2 });
  zoomIn.onclick = () => zoomAt(centre(), 1.4);
  zoomOut.onclick = () => zoomAt(centre(), 1 / 1.4);
  zoomFit.onclick = () => { fit(); drawPlan(); };

  const outlinesOf = (list       ) => list.filter(s => (s.Shape || []).length >= 3).map(s => s.Shape        );
  const othersFor = (exclude     ) => outlinesOf([...roomsNow(), ...areasNow()].filter(s => s !== exclude));
  const snapStep = () => planSnapStep(sys()) * scale();
  const clampPt = (p    ) => { const { w, h } = floorSize(); return { X: planRound(Math.max(0, Math.min(w, p.X))), Y: planRound(Math.max(0, Math.min(h, p.Y))) }; };
  const snapped = (p    , exclude      = null) => {
    if (!snapOn) return clampPt(p);
    return clampPt(planSnap(p, othersFor(exclude), 12 * upp(), snapStep()).pt);
  };
  /// Within a few degrees of level or plumb from the last point, a line is made exactly so.
  const ortho = (prev                       , q    ) => {
    if (!prev || !snapOn) return q;
    const dx = q.X - prev.X, dy = q.Y - prev.Y;
    const a = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
    if (a < 6 || a > 174) return { X: q.X, Y: prev.Y };
    if (Math.abs(a - 90) < 6) return { X: prev.X, Y: q.Y };
    return q;
  };
  /// A drawn point: onto a wall corner or edge when one is near, else level or plumb from the last point, else the grid.
  const drawSnap = (prev                       , p    , grid = true) => {
    if (!snapOn) return clampPt(p);
    const sn = planSnap(p, othersFor(null), 16 * upp() * hs(), grid ? snapStep() : 0);
    return clampPt(sn.to === 'corner' || sn.to === 'edge' ? sn.pt : ortho(prev, sn.pt));
  };
  /// The point a wire's next bend follows on from.
  const wireLast = () => wireDraft ? (wireDraft.pts[wireDraft.pts.length - 1] || (wireDraft.from ? itemPt(wireDraft.from) : null)) : null;
  const gridSnapped = (p    ) => { if (!snapOn) return clampPt(p); const g = snapStep(); return clampPt({ X: Math.round(p.X / g) * g, Y: Math.round(p.Y / g) * g }); };
  /// Where an item actually is: its own point.
  const itemPt = (id        )            => { const it = itemOf(id); return it ? { X: Number(it.X) || 0, Y: Number(it.Y) || 0 } : null; };
  /// A run's whole path: its start item, its bends, and its end item.
  const runPath = (r     )       => {
    const pts       = [];
    const a = r.From ? itemPt(r.From) : null;
    if (a) pts.push(a);
    (r.Points || []).forEach((p    ) => pts.push(p));
    const b = r.To ? itemPt(r.To) : null;
    if (b) pts.push(b);
    return pts;
  };
  /// Where a wall is for a door or window: near enough to one, on it and lying along it.
  const wallAt = (p    ) => {
    const w = planNearestWall(p, outlinesOf(roomsNow().filter(r => !r.Outdoor)));
    return w && w.dist <= Math.max(0.6 * scale(), 16 * upp()) ? w : null;
  };
  const openingWidth = (kind        ) => {
    const imp = sys() === 'imperial';
    const inch = 0.0254;
    const m = kind === 'window' ? (imp ? 36 * inch : 1.2) : kind === 'double-door' ? (imp ? 60 * inch : 1.5) : kind === 'sliding-door' ? (imp ? 72 * inch : 1.8)
      : kind === 'garage-door' ? (imp ? 108 * inch : 2.7) : (imp ? 36 * inch : 0.9);
    return planRound(m * scale());
  };
  /// The circuit a selection is about, so the plan can bring it forward and fade the rest.
  const focusCircuit = () => selection?.type === 'item' ? itemOf(selection.id)?.Circuit || focused
    : selection?.type === 'run' ? runOf(selection.id)?.Circuit || focused : focused;
  /// The floor beneath this one on the same site, drawn faintly to line the one above up with it.
  const floorBelow = () => {
    const fl = floorNow();
    if (!fl) return null;
    const lower = ensure(fl.site, 'Floors', []).filter((f     ) => (Number(f.Level) || 0) < (Number(fl.floor.Level) || 0));
    return lower.sort((a     , b     ) => (Number(b.Level) || 0) - (Number(a.Level) || 0))[0] || null;
  };
  /// Outlets and switches live on walls: near enough to one, they sit on it.
  const WALL_KINDS = ['outlet', 'switch'];
  /// Where a wall-mounted item goes: on the wall, facing the side the pointer is on. Away from walls it stands free.
  const onWall = (kind        , q    , side     = q)                                 => {
    if (!snapOn || !WALL_KINDS.includes(kind)) return { ...q, facing: null };
    const w = planNearestWall(q, outlinesOf(roomsNow().filter(r => !r.Outdoor)));
    if (!w || w.dist > Math.max(0.3 * scale(), 10 * upp())) return { ...q, facing: null };
    // The normal toward the pointer's side of the wall; the room it is in when the pointer is on the line itself.
    let toward = { X: side.X - w.pt.X, Y: side.Y - w.pt.Y };
    if (Math.hypot(toward.X, toward.Y) < 1e-6) { const rm = planShapeAt(roomsNow(), side); const c = rm ? planCentroid(rm.Shape) : side; toward = { X: c.X - w.pt.X, Y: c.Y - w.pt.Y }; }
    const a = w.angle * Math.PI / 180;
    const n = { X: -Math.sin(a), Y: Math.cos(a) };
    const facing = (n.X * toward.X + n.Y * toward.Y >= 0 ? w.angle + 90 : w.angle - 90);
    return { X: planRound(w.pt.X), Y: planRound(w.pt.Y), facing: Math.round((((facing % 360) + 360) % 360) * 10) / 10 };
  };
  /// A sized item near a wall stands with its back to it, facing the room the pointer is in; away from walls it keeps its turn.
  const fitToWall = (it     , q    , side     = q) => {
    const D = Number(it.Depth) || 0;
    const w = snapOn ? planNearestWall(q, outlinesOf(roomsNow().filter(r => !r.Outdoor))) : null;
    if (!w || w.dist > D / 2 + Math.max(0.3 * scale(), 12 * upp())) { const g2 = gridSnapped(q); it.X = g2.X; it.Y = g2.Y; return; }
    let toward = { X: side.X - w.pt.X, Y: side.Y - w.pt.Y };
    if (Math.hypot(toward.X, toward.Y) < 1e-6) toward = { X: q.X - w.pt.X, Y: q.Y - w.pt.Y };
    const a = w.angle * Math.PI / 180;
    let n = { X: -Math.sin(a), Y: Math.cos(a) };
    if (n.X * toward.X + n.Y * toward.Y < 0) n = { X: -n.X, Y: -n.Y };
    // Its front, local +Y, faces into the room.
    it.Rotation = Math.round((((Math.atan2(n.Y, n.X) * 180 / Math.PI - 90) % 360) + 360) % 360 * 10) / 10;
    it.X = planRound(w.pt.X + n.X * (D / 2 + 0.5)); it.Y = planRound(w.pt.Y + n.Y * (D / 2 + 0.5));
  };
  const isSized = (it     ) => !!it && Number(it.Width) > 0 && Number(it.Depth) > 0;
  /// Which appliance a sized item is drawn as: its own record, or, for one placed before that was kept, its name.
  const footprintOf = (it     ) => it?.Footprint || PLAN_FOOTPRINTS.find(f => f[1] === it?.Label)?.[0] || '';
  const placeOnWall = (it     , q                                ) => {
    it.X = q.X; it.Y = q.Y;
    if (q.facing == null) delete it.Facing; else it.Facing = q.facing;
  };

  /// Everything drawn on this floor that can be selected.
  const everything = ()                           => [
    ...roomsNow().filter(r => (r.Shape || []).length >= 3).map(r => ({ type: 'room'           , id: r.Id })),
    ...areasNow().filter(a => (a.Shape || []).length >= 3).map(a => ({ type: 'area'           , id: a.Id })),
    ...openingsNow().map(o => ({ type: 'opening'           , id: o.Id })),
    ...itemsNow().map((i     ) => ({ type: 'item'           , id: i.Id })),
    ...runsNow().map(r => ({ type: 'run'           , id: r.Id })),
  ];
  /// Every point that moves when a set of things moves: outlines, items, doors and windows, wire bends.
  /// A room carries what is in it, the doors and windows in its walls and the bends of wires to what it holds.
  const movable = (sel                          ) => {
    const shapes = new Set     (), items = new Set     (), openings = new Set     (), runs = new Set     ();
    sel.forEach(x => {
      if (x.type === 'room' || x.type === 'area') {
        const s = shapeOf(x);
        if (!s || shapeHeld(s)) return;
        shapes.add(s);
        if (x.type === 'room') {
          itemsIn().forEach((it     ) => { if (it.Room === s.Id) items.add(it); });
          const near = 0.2 * scale();
          openingsNow().forEach(o => { const w = planNearestWall({ X: o.X, Y: o.Y }, [s.Shape]); if (w && w.dist <= near) openings.add(o); });
        }
      } else if (x.type === 'item') { const it = itemOf(x.id); if (it) items.add(it); }
      else if (x.type === 'opening') { const o = openingOf(x.id); if (o) openings.add(o); }
      else if (x.type === 'run') { const r = runOf(x.id); if (r) runs.add(r); }
    });
    runsNow().forEach(r => { if ([r.From, r.To].some(id => [...items].some((it     ) => it.Id === id))) runs.add(r); });
    return {
      shapes: [...shapes].map(sh => ({ sh, pts: sh.Shape.map((q    ) => ({ ...q })) })),
      items: [...items].map(it => ({ it, X: Number(it.X) || 0, Y: Number(it.Y) || 0 })),
      openings: [...openings].map(o => ({ o, X: Number(o.X) || 0, Y: Number(o.Y) || 0 })),
      runs: [...runs].map(r => ({ r, pts: (r.Points || []).map((q    ) => ({ ...q })) })),
    };
  };
  const shift = (m                            , dx        , dy        ) => {
    m.shapes.forEach(x => { x.sh.Shape = x.pts.map((q    ) => ({ X: planRound(q.X + dx), Y: planRound(q.Y + dy) })); });
    m.items.forEach(x => { x.it.X = planRound(x.X + dx); x.it.Y = planRound(x.Y + dy); });
    m.openings.forEach(x => { x.o.X = planRound(x.X + dx); x.o.Y = planRound(x.Y + dy); });
    m.runs.forEach(x => { x.r.Points = x.pts.map((q    ) => ({ X: planRound(q.X + dx), Y: planRound(q.Y + dy) })); });
  };
  /// The box around a set of movable points, or null when there are none.
  const boundsOf = (m                            ) => {
    const pts       = [...m.shapes.flatMap(x => x.pts), ...m.items.map(x => ({ X: x.X, Y: x.Y })), ...m.openings.map(x => ({ X: x.X, Y: x.Y })), ...m.runs.flatMap(x => x.pts)];
    return pts.length ? planBounds(pts) : null;
  };
  /// Is a selectable thing wholly inside a box?
  const insideBox = (x                        , b                                                ) => {
    const inB = (q    ) => q.X >= b.x && q.X <= b.x + b.w && q.Y >= b.y && q.Y <= b.y + b.h;
    if (x.type === 'room' || x.type === 'area') return (shapeOf(x)?.Shape || []).every(inB);
    if (x.type === 'item') { const it = itemOf(x.id); return !!it && inB({ X: it.X, Y: it.Y }); }
    if (x.type === 'opening') { const o = openingOf(x.id); return !!o && inB({ X: o.X, Y: o.Y }); }
    const r = runOf(x.id);
    return !!r && runPath(r).length > 0 && runPath(r).every(inB);
  };

  // --- Locks, shared corners and constraints -------------------------------------------------------
  const constraintsNow = ()                   => { const f = floorNow()?.floor; return f ? ensure(f, 'Constraints', []) : []; };
  const setConstraints = (list                  ) => { const f = floorNow()?.floor; if (f) f.Constraints = list; };
  /// The outlines on this floor, as the solver sees them.
  const shapesNow = () => [...roomsNow(), ...areasNow()].filter(x => (x.Shape || []).length >= 3);
  const shapeById = (id        ) => shapesNow().find(x => x.Id === id);
  /// A corner that must stay put: its room is locked, or a locked wall ends there.
  const cornerLocked = (sh     , i        ) => {
    if (!sh) return false;
    if (sh.Locked) return true;
    const n = (sh.Shape || []).length;
    return (sh.LockedWalls || []).some((e        ) => e === i || ((e + 1) % n) === i);
  };
  /// A shape that cannot move as a whole: locked, or holding a locked wall.
  const shapeHeld = (sh     ) => !!sh && (sh.Locked || (sh.LockedWalls || []).length > 0);
  let lastSolve                                     = { worst: 0, unmet: [] };
  /// Bring every constraint on this floor back into line, holding still the corners named.
  const solve = (fixed           = []) => {
    if (!constraintsNow().length) { lastSolve = { worst: 0, unmet: [] }; return; }
    lastSolve = planSolve(shapesNow(), constraintsNow(), new Set(fixed));
  };
  const keysOf = (sh     ) => (sh?.Shape || []).map((_     , i        ) => `${sh.Id}#${i}`);
  const saidLocked = () => toast('That is locked. Unlock it in its panel to change it.', false);
  let cPicks            = [];
  const sameRef = (a         , b         ) => a.Room === b.Room && (a.Corner ?? null) === (b.Corner ?? null) && (a.Edge ?? null) === (b.Edge ?? null);
  /// The corner or wall under the pointer: a corner when one is close, else the nearest wall.
  const pickRef = (p    )                 => {
    const reach = 14 * upp() * hs();
    let best                 = null, bestD = reach;
    shapesNow().forEach(sh => sh.Shape.forEach((q    , i        ) => { const d = Math.hypot(q.X - p.X, q.Y - p.Y); if (d <= bestD) { bestD = d; best = { Room: sh.Id, Corner: i }; } }));
    if (best) return best;
    bestD = reach * 0.85;
    shapesNow().forEach(sh => sh.Shape.forEach((q    , i        ) => {
      const r2 = sh.Shape[(i + 1) % sh.Shape.length];
      const n = planNearestOnSegment(p, q, r2);
      const d = Math.hypot(n.X - p.X, n.Y - p.Y);
      if (d <= bestD) { bestD = d; best = { Room: sh.Id, Edge: i }; }
    }));
    return best;
  };
  /// Where a wall's middle is, and which way it runs.
  const edgeMid = (r         ) => {
    const sh = shapeById(r.Room);
    if (!sh || r.Edge == null) return null;
    const [i, j] = planEdgeCorners(sh, r.Edge);
    const a = sh.Shape[i], b = sh.Shape[j];
    return { a, b, mid: { X: (a.X + b.X) / 2, Y: (a.Y + b.Y) / 2 }, len: Math.hypot(b.X - a.X, b.Y - a.Y), centre: planCentroid(sh.Shape) };
  };
  const cornerPt = (r         ) => { const sh = shapeById(r.Room); return sh && r.Corner != null ? sh.Shape[r.Corner] : null; };
  const addConstraint = (kind        , refs           , value         ) => {
    const id = freshIn(constraintsNow(), kind);
    act(() => { constraintsNow().push({ Id: id, Kind: kind, Refs: refs.map(r => ({ ...r })), Value: value ?? null }); solve(); cPicks = []; });
    if (lastSolve.unmet.includes(id)) toast('That constraint cannot hold with the others, or with what is locked. It is kept, and marked in red; Ctrl+Z takes it back.', false);
  };

  // --- Drawing -------------------------------------------------------------------------------------
  const shadeOf = (v               , max        ) => {
    if (v == null || max <= 0) return '';
    const t = Math.max(0, Math.min(1, v / max));
    return `color-mix(in srgb, var(--accent) ${Math.round(18 + t * 64)}%, transparent)`;
  };
  const points = (poly      ) => poly.map(q => `${q.X},${q.Y}`).join(' ');

  const drawPlan = () => {
    svg.innerHTML = '';
    const fl = floorNow();
    const { w, h } = floorSize();
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('aria-label', fl ? `Floor plan of ${fl.floor.Name || fl.floor.Id}` : 'No floor');
    svg.classList.toggle('is-editing', mode === 'edit' && tool !== 'select' && tool !== 'pan');
    svg.classList.toggle('is-panning', tool === 'pan' || mode === 'view');
    const u = upp();
    const s = scale();

    const defs = svgEl('defs');
    planTextures(s).forEach(p => defs.appendChild(p));
    // A surface in a colour of its own gets a pattern of its own, drawn in that colour.
    const tints = new Set        (roomsNow().filter(r => r.Surface && r.SurfaceColor).map(r => `${r.Surface}|${r.SurfaceColor}`));
    tints.forEach(k => { const [name, colour] = k.split('|'); defs.appendChild(planTexture(name, s, colour)); });
    // The grid is in real units: a foot or half a metre, with a heavier line every five feet or metre.
    const minor = planGridStep(sys()) * s, major = minor * (sys() === 'imperial' ? 5 : 2);
    const gp = svgEl('pattern', { id: 'fp-grid', width: major, height: major, patternUnits: 'userSpaceOnUse' });
    if (minor / u >= 7) for (let x = minor; x < major - 1e-6; x += minor) {
      gp.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: major, class: 'fp-gridline', 'stroke-width': u }));
      gp.appendChild(svgEl('line', { x1: 0, y1: x, x2: major, y2: x, class: 'fp-gridline', 'stroke-width': u }));
    }
    gp.appendChild(svgEl('path', { d: `M ${major} 0 L 0 0 0 ${major}`, class: 'fp-gridline is-major', 'stroke-width': u }));
    const hatch = svgEl('pattern', { id: 'fp-hatch', width: 10 * u, height: 10 * u, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.appendChild(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 10 * u, class: 'fp-hatchline', 'stroke-width': 1.5 * u }));
    defs.append(gp, hatch);
    svg.appendChild(defs);
    legend.innerHTML = '';
    if (!fl) { drawScaleBar(); return; }

    // Ground, then the plan image, then the grid while editing or where there is no image.
    const ground = fl.floor.Ground;
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, class: 'fp-paper' + (ground ? ' is-textured' : ''), fill: ground ? `url(#fp-tex-${ground})` : null }));
    const image = fl.floor.Image;
    if (image && imageFailed !== image) {
      const img = svgEl('image', { href: `/api/plans/images/${encodeURIComponent(image)}`, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'xMidYMid meet', class: 'fp-image', opacity: String(fl.floor.ImageOpacity ?? 0.85) });
      img.addEventListener('error', () => { imageFailed = image; drawPlan(); drawSide(); });
      svg.appendChild(img);
    }
    if (!image || imageFailed === image || mode === 'edit')
      svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, fill: 'url(#fp-grid)', class: 'fp-gridrect' }));
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, class: 'fp-edge', 'stroke-width': u }));
    const below = mode === 'edit' && showBelow ? floorBelow() : null;
    if (below) ensure(below, 'Rooms', []).filter((r     ) => (r.Shape || []).length >= 3).forEach((r     ) =>
      svg.appendChild(svgEl('polygon', { points: points(r.Shape), class: 'fp-below', 'stroke-width': 1.5 * u, 'stroke-dasharray': `${4 * u} ${4 * u}` })));

    const max = planScaleMax(roomsNow().map(r => placeOf(r.Id)?.value));
    const font = 13 * u;
    const focus = focusCircuit();
    // The rooms the focused circuit serves: the breaker's own list, and every room something on it is in.
    const focusRooms = new Set        (focus ? [...(circuitOf(focus)?.rooms || []), ...itemsIn().filter((i     ) => i.Circuit === focus).map((i     ) => i.Room).filter(Boolean)] : []);
    // A selected GFCI shows what it protects: everything wired downstream of it, and the rest fades.
    const gfci = selection?.type === 'item' && !extra.length ? itemOf(selection.id) : null;
    const downstream = gfci?.Gfci ? planDownstream(runsIn(), gfci.Id) : null;
    const isGfci = (id        ) => !!itemOf(id)?.Gfci;
    const label = (poly      , lines          , cls        ) => {
      const c = planCentroid(poly);
      const t = svgEl('text', { x: c.X, y: c.Y - (lines.length - 1) * font * 0.6, class: cls, 'font-size': font });
      lines.forEach((ln, i) => { const sp = svgEl('tspan', { x: c.X, dy: i ? font * 1.2 : 0 }); sp.textContent = ln; t.appendChild(sp); });
      return t;
    };

    // Rooms and outdoor zones: surface first, then the live shading over it, then the walls.
    const rooms = roomsNow().filter(r => (r.Shape || []).length >= 3).sort((a, b) => Number(!!b.Outdoor) - Number(!!a.Outdoor));
    rooms.forEach(room => {
      const poly       = room.Shape;
      if (room.Surface) svg.appendChild(svgEl('polygon', { points: points(poly), class: 'fp-surface', fill: `url(#${planTextureId(room.Surface, room.SurfaceColor || '')})` }));
      else if (room.SurfaceColor) svg.appendChild(svgEl('polygon', { points: points(poly), class: 'fp-surface is-solid', fill: room.SurfaceColor }));
    });
    const labels        = [];
    rooms.forEach(room => {
      const poly       = room.Shape;
      const p = placeOf(room.Id);
      const st = p?.state || 'unmetered';
      const sel = isSel('room', room.Id);
      const shape = svgEl('polygon', {
        points: points(poly),
        class: `fp-room ${room.Outdoor ? 'is-outdoor' : 'is-indoor'} is-${mode === 'view' ? st : 'edit'}${room.Surface ? ' has-surface' : ''}${sel ? ' is-selected' : ''}`,
        'stroke-width': (room.Outdoor ? 1.5 : sel ? 5 : 4) * u,
      });
      if (room.Outdoor) shape.setAttribute('stroke-dasharray', `${7 * u} ${5 * u}`);
      if (mode === 'view' && st === 'known') shape.style.fill = shadeOf(p .value, max);
      if (mode === 'view' && st === 'unmetered' && !room.Surface) shape.style.fill = 'url(#fp-hatch)';
      if (focusRooms.has(room.Id)) { shape.classList.add('is-circuit'); shape.style.stroke = planCircuitColor(focus); }
      shape.dataset.room = room.Id;
      svg.appendChild(shape);
      const lines = [room.Name || room.Id];
      if (mode === 'view') lines.push(st === 'known' ? fmt(p .value) : st === 'unknown' ? 'no data' : 'unmetered');
      if (showSizes || (mode === 'edit' && sel)) lines.push(areaText(poly));
      labels.push(label(poly, lines, 'fp-label' + (mode === 'view' ? ' is-' + st : '') + (room.Outdoor ? ' is-outdoor' : '')));
    });

    areasNow().forEach(area => {
      const poly       = area.Shape || [];
      if (poly.length < 3) return;
      const sel = isSel('area', area.Id);
      const shape = svgEl('polygon', { points: points(poly), class: 'fp-area' + (sel ? ' is-selected' : ''), 'stroke-width': (sel ? 3 : 2) * u, 'stroke-dasharray': `${8 * u} ${5 * u}` });
      shape.dataset.area = area.Id;
      svg.appendChild(shape);
      labels.push(label(poly, [area.Name || area.Id], 'fp-label fp-area-label'));
    });

    // Doors and windows cut the walls they sit in.
    openingsNow().forEach(o => {
      const g = planOpening(o, u);
      if (isSel('opening', o.Id)) g.classList.add('is-selected');
      svg.appendChild(g);
    });

    // Cable runs, in their circuit's colour. A selected circuit comes forward and the rest fade.
    if (showWiring || mode === 'edit') runsNow().forEach(r => {
      const path = runPath(r);
      if (path.length < 2) return;
      const sel = isSel('run', r.Id);
      const dim = downstream ? !downstream.runs.has(r.Id) : !!focus && r.Circuit !== focus;
      const colour = r.Kind === 'circuit' ? planCircuitColor(r.Circuit) : r.Kind === 'service' ? 'var(--series-4)' : 'var(--fg)';
      const lit = downstream ? downstream.runs.has(r.Id) : !!focus && r.Circuit === focus;
      const g = svgEl('g', { class: `fp-run is-${r.Kind || 'circuit'}${sel ? ' is-selected' : ''}${dim ? ' is-dim' : ''}${lit ? (downstream ? ' is-protected' : ' is-focus') : ''}${r.Circuit ? '' : ' is-unknown'}` });
      g.appendChild(svgEl('polyline', { points: points(path), class: 'fp-run-line', stroke: colour, 'stroke-width': (r.Kind === 'circuit' ? 2.5 : 4) * u * (sel ? 1.5 : 1), 'stroke-dasharray': r.Circuit || r.Kind !== 'circuit' ? null : `${6 * u} ${4 * u}` }));
      // While viewing, a branch circuit's run carries the circuit's reading at its middle.
      const cp = mode === 'view' && r.Circuit ? circuitOf(r.Circuit)?.power : undefined;
      if (mode === 'view' && r.Circuit && path.length >= 2) {
        const mid = path[Math.floor((path.length - 1) / 2)], nxt = path[Math.floor((path.length - 1) / 2) + 1];
        const t = svgEl('text', { x: (mid.X + nxt.X) / 2, y: (mid.Y + nxt.Y) / 2 - 7 * u, class: 'fp-run-read' + (cp == null ? ' is-nodata' : ''), 'font-size': font * 0.8 });
        t.textContent = cp == null ? 'no data' : formatMeasure(Math.round(cp), 'W');
        g.appendChild(t);
      }
      // Which way it runs, supply to load: a chevron on its longest stretch.
      let seg = 0, best = -1;
      for (let i = 0; i + 1 < path.length; i++) { const L = Math.hypot(path[i + 1].X - path[i].X, path[i + 1].Y - path[i].Y); if (L > best) { best = L; seg = i; } }
      if (best / u > 30) {
        const a = path[seg], b = path[seg + 1];
        const ang = Math.atan2(b.Y - a.Y, b.X - a.X) * 180 / Math.PI;
        const mx = (a.X + b.X) / 2, my = (a.Y + b.Y) / 2;
        g.appendChild(svgEl('path', { d: `M ${-5 * u} ${-4.5 * u} L ${2 * u} 0 L ${-5 * u} ${4.5 * u}`, transform: `translate(${mx},${my}) rotate(${ang})`, class: 'fp-run-arrow', stroke: colour, 'stroke-width': 2 * u }));
      }
      const hit = svgEl('polyline', { points: points(path), class: 'fp-hit fp-run-hit', 'stroke-width': 14 * u });
      hit.dataset.run = r.Id;
      g.appendChild(hit);
      svg.appendChild(g);
      if (sel && mode === 'edit' && !extra.length) {
        (r.Points || []).forEach((q    , i        ) => { const hd = svgEl('circle', { cx: q.X, cy: q.Y, r: 7 * u * hs(), class: 'fp-handle' + (i === selectedBend ? ' is-selected' : '') }); hd.dataset.runpt = String(i); svg.appendChild(hd); });
        for (let i = 0; i + 1 < path.length; i++) {
          const m = svgEl('circle', { cx: (path[i].X + path[i + 1].X) / 2, cy: (path[i].Y + path[i + 1].Y) / 2, r: 5 * u * hs(), class: 'fp-mid' });
          m.dataset.runmid = String(i);
          svg.appendChild(m);
        }
      }
    });

    // Placed items keep their size on screen at any zoom. An item on an unknown circuit is ringed and marked.
    const r = 12 * u;
    itemsNow().forEach((item     ) => {
      const sel = isSel('item', item.Id);
      const supply = PLAN_SUPPLY_KINDS.includes(item.Kind);
      const known = supply || (!!item.Circuit && (live?.placements[item.Id]?.circuitKnown ?? true));
      const dim = downstream ? !(downstream.items.has(item.Id) || item.Id === gfci .Id) : !!focus && item.Circuit !== focus;
      const lit = downstream ? downstream.items.has(item.Id) : !!focus && item.Circuit === focus;
      // Drawn at its real size when it has one: a washer is as big as a washer, turned as it stands.
      const W = Number(item.Width) || 0, D = Number(item.Depth) || 0, sized = W > 0 && D > 0;
      // A wall-mounted item sits beside its wall on the room's side, joined to it by a short stub, at any zoom.
      const facing = !sized && item.Facing != null && Number.isFinite(Number(item.Facing)) ? Number(item.Facing) * Math.PI / 180 : null;
      const off = facing == null ? { X: 0, Y: 0 } : { X: Math.cos(facing) * (r + 3 * u), Y: Math.sin(facing) * (r + 3 * u) };
      if (facing != null) svg.appendChild(svgEl('line', { x1: item.X, y1: item.Y, x2: item.X + off.X, y2: item.Y + off.Y, class: 'fp-item-stub' + (dim ? ' is-dim' : ''), 'stroke-width': 2.5 * u }));
      const g = svgEl('g', { class: 'fp-item' + (sel ? ' is-selected' : '') + (known ? '' : ' is-unknown') + (supply ? ' is-supply' : '') + (dim ? ' is-dim' : '') + (facing != null ? ' is-wall' : '') + (lit ? (downstream ? ' is-protected' : ' is-focus') : ''), transform: `translate(${item.X + off.X},${item.Y + off.Y})` });
      g.dataset.item = item.Id;
      let rr = r;
      let hasArt = false;
      if (sized) {
        const body = svgEl('g', { class: 'fp-body' + (sel ? ' is-selected' : '') + (dim ? ' is-dim' : '') + (lit ? (downstream ? ' is-protected' : ' is-focus') : '') + (known ? '' : ' is-unknown'), transform: `translate(${item.X},${item.Y}) rotate(${Number(item.Rotation) || 0})` });
        body.dataset.item = item.Id;
        const shape = item.Round
          ? svgEl('ellipse', { rx: W / 2, ry: D / 2, class: 'fp-body-shape', 'stroke-width': (sel ? 3 : 2) * u })
          : svgEl('rect', { x: -W / 2, y: -D / 2, width: W, height: D, rx: Math.min(W, D) * 0.07, class: 'fp-body-shape', 'stroke-width': (sel ? 3 : 2) * u });
        if (item.Circuit && (showWiring || focus)) shape.style.stroke = planCircuitColor(item.Circuit);
        body.appendChild(shape);
        // The front, where the door or the controls are.
        // The appliance itself, seen from above, when it is one we know how to draw.
        const art = planFootprintArt(footprintOf(item), W, D, u);
        if (art) { body.appendChild(art); body.classList.add('has-art'); }
        else if (!item.Round) body.appendChild(svgEl('line', { x1: -W * 0.38, y1: D / 2 - 4 * u, x2: W * 0.38, y2: D / 2 - 4 * u, class: 'fp-body-front', 'stroke-width': 3 * u }));
        svg.appendChild(body);
        hasArt = !!art;
        rr = Math.max(6 * u, Math.min(r, Math.min(W, D) * 0.32));
      } else {
        const disc = svgEl('circle', { r, class: 'fp-item-disc', 'stroke-width': (sel ? 3 : 2) * u });
        if (item.Circuit && (showWiring || focus)) disc.style.stroke = planCircuitColor(item.Circuit);
        g.appendChild(disc);
      }
      // An appliance drawn as itself needs no icon on top.
      if (!hasArt) {
        const glyph = planGlyph(item.Kind || 'outlet', rr);
        glyph.setAttribute('stroke-width', 1.4 * u);
        g.appendChild(glyph);
      }
      // A GFCI wears a G; anything it protects, when the wiring is shown, a small green shield dot.
      if (item.Gfci) {
        const b = svgEl('g', { class: 'fp-gfci', transform: `translate(${-r * 0.85},${-r * 0.8})` });
        b.appendChild(svgEl('circle', { r: r * 0.45, 'stroke-width': u }));
        const t = svgEl('text', { y: r * 0.03, 'font-size': r * 0.6 }); t.textContent = 'G'; b.appendChild(t);
        g.appendChild(b);
      } else if (showWiring && planProtectedBy(runsIn(), isGfci, item.Id)) {
        g.appendChild(svgEl('circle', { cx: r * 0.8, cy: r * 0.75, r: r * 0.28, class: 'fp-protected-dot', 'stroke-width': u }));
      }
      if (!known) {
        const badge = svgEl('text', { x: r * 0.85, y: -r * 0.6, class: 'fp-item-q', 'font-size': font * 0.9 });
        badge.textContent = '?';
        g.appendChild(badge);
      }
      // A metered item shows what it is drawing, right under it, while viewing.
      const reading = mode === 'view' && item.Node ? live?.placements[item.Id]?.value : undefined;
      if (mode === 'view' && item.Node) {
        const t = svgEl('text', { x: 0, y: r + font * 0.95, class: 'fp-item-read' + (reading == null ? ' is-nodata' : ''), 'font-size': font * 0.8 });
        t.textContent = reading == null ? 'no data' : fmt(reading);
        g.appendChild(t);
      } else if (item.Label && (sel || showSizes || (sized && Math.min(W, D) / u > 44))) {
        const t = svgEl('text', { x: 0, y: r + font, class: 'fp-item-label', 'font-size': font * 0.85 });
        t.textContent = item.Label;
        g.appendChild(t);
      }
      const title = svgEl('title');
      title.textContent = `${itemName(item)}${item.Circuit ? ' — ' + refLabel(item.Circuit) : supply ? '' : ' — circuit unknown'}`;
      g.appendChild(title);
      svg.appendChild(g);
    });

    labels.forEach(t => svg.appendChild(t));

    // Wall lengths along the selected room's edges, or every room's when sizes are on.
    const dimsFor = rooms.filter(rm => showSizes || (mode === 'edit' && selection?.type === 'room' && selection.id === rm.Id));
    dimsFor.forEach(rm => {
      const poly       = rm.Shape;
      const sign = planArea(poly) >= 0 ? 1 : -1;
      poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length];
        const L = Math.hypot(b.X - a.X, b.Y - a.Y);
        if (L / u < 40) return;
        const nx = -(b.Y - a.Y) / L * sign, ny = (b.X - a.X) / L * sign;
        let ang = Math.atan2(b.Y - a.Y, b.X - a.X) * 180 / Math.PI;
        if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
        const mx = (a.X + b.X) / 2 - nx * 11 * u, my = (a.Y + b.Y) / 2 - ny * 11 * u;
        const t = svgEl('text', { x: mx, y: my, class: 'fp-dim', 'font-size': font * 0.85, transform: `rotate(${ang} ${mx} ${my})` });
        t.textContent = len(L);
        svg.appendChild(t);
      });
    });

    // A sized item's handles: a corner to resize it, and a knob above its back to turn it.
    const sizedSel = mode === 'edit' && tool === 'select' && !extra.length && selection?.type === 'item' ? itemOf(selection.id) : null;
    if (isSized(sizedSel)) {
      const it = sizedSel, W = Number(it.Width), D = Number(it.Depth), t = (Number(it.Rotation) || 0) * Math.PI / 180;
      const at = (lx        , ly        ) => ({ X: it.X + lx * Math.cos(t) - ly * Math.sin(t), Y: it.Y + lx * Math.sin(t) + ly * Math.cos(t) });
      const back = at(0, -D / 2), knob = at(0, -D / 2 - 26 * u);
      svg.appendChild(svgEl('line', { x1: back.X, y1: back.Y, x2: knob.X, y2: knob.Y, class: 'fp-rot-stem', 'stroke-width': 1.5 * u }));
      const rot = svgEl('circle', { cx: knob.X, cy: knob.Y, r: 8 * u * hs(), class: 'fp-handle fp-rot' });
      rot.dataset.rotate = it.Id;
      svg.appendChild(rot);
      const cn = at(W / 2, D / 2);
      const rs = svgEl('rect', { x: cn.X - 7 * u * hs(), y: cn.Y - 7 * u * hs(), width: 14 * u * hs(), height: 14 * u * hs(), class: 'fp-handle fp-resize' });
      rs.dataset.resize = it.Id;
      svg.appendChild(rs);
    }

    // Editing handles: each corner, and a midpoint on each edge that adds a corner when dragged.
    const target = mode === 'edit' && !extra.length ? shapeOf(selection) : null;
    if (target && (target.Shape || []).length >= 3) {
      const poly       = target.Shape;
      poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length];
        const mid = svgEl('circle', { cx: (a.X + b.X) / 2, cy: (a.Y + b.Y) / 2, r: 6 * u * hs(), class: 'fp-mid' });
        mid.dataset.mid = String(i);
        svg.appendChild(mid);
      });
      poly.forEach((q, i) => {
        const hnd = svgEl('circle', { cx: q.X, cy: q.Y, r: 9 * u * hs(), class: 'fp-handle' + (i === selectedCorner ? ' is-selected' : '') });
        hnd.dataset.corner = String(i);
        svg.appendChild(hnd);
      });
    }

    // Locked walls, drawn over in the lock colour; a locked room wears a padlock by its name.
    shapesNow().forEach(sh => {
      (sh.LockedWalls || []).forEach((e        ) => {
        const m = edgeMid({ Room: sh.Id, Edge: e });
        if (m) svg.appendChild(svgEl('line', { x1: m.a.X, y1: m.a.Y, x2: m.b.X, y2: m.b.Y, class: 'fp-wall-locked', 'stroke-width': 7 * u, 'stroke-dasharray': `${3 * u} ${3 * u}` }));
      });
      if (sh.Locked) {
        const c = planCentroid(sh.Shape);
        const lk = svgEl('g', { class: 'fp-lock-badge', transform: `translate(${c.X},${c.Y - font * 2.1}) scale(${u * 0.7})` });
        lk.appendChild(svgEl('path', { d: 'M-5 -1 V-4 A5 5 0 0 1 5 -4 V-1 M-7 -1 H7 V9 H-7 Z' }));
        svg.appendChild(lk);
      }
    });
    // Constraints, where they hold: a pill on each wall or corner, red where they cannot.
    if (showCons) {
      const pill = (at    , text        , unmet         ) => {
        const w = (text.length * 6.5 + 10) * u, hh = 15 * u;
        const g = svgEl('g', { class: 'fp-cons' + (unmet ? ' is-unmet' : ''), transform: `translate(${at.X},${at.Y})` });
        g.appendChild(svgEl('rect', { x: -w / 2, y: -hh / 2, width: w, height: hh, rx: hh / 2, 'stroke-width': u }));
        const t = svgEl('text', { y: u, 'font-size': 10.5 * u }); t.textContent = text; g.appendChild(t);
        svg.appendChild(g);
      };
      const inward = (m     , px        ) => { const dx = m.centre.X - m.mid.X, dy = m.centre.Y - m.mid.Y, d = Math.hypot(dx, dy) || 1; return { X: m.mid.X + dx / d * px * u, Y: m.mid.Y + dy / d * px * u }; };
      let pair = 0;
      constraintsNow().forEach(c => {
        const unmet = lastSolve.unmet.includes(c.Id);
        if (c.Kind === 'length' || c.Kind === 'horizontal' || c.Kind === 'vertical') {
          const m = edgeMid(c.Refs[0]);
          if (m) pill(inward(m, c.Kind === 'length' ? 16 : 34), c.Kind === 'length' ? len(Number(c.Value) || 0) : c.Kind === 'horizontal' ? 'H' : 'V', unmet);
        } else if (c.Kind === 'angle') {
          const q = cornerPt(c.Refs[0]); const sh = shapeById(c.Refs[0].Room);
          if (q && sh) { const cc = planCentroid(sh.Shape); const dx = cc.X - q.X, dy = cc.Y - q.Y, d = Math.hypot(dx, dy) || 1; pill({ X: q.X + dx / d * 22 * u, Y: q.Y + dy / d * 22 * u }, `${Math.round(Math.abs(Number(c.Value) || 0))}°`, unmet); }
        } else if (c.Kind === 'coincident') {
          const q = cornerPt(c.Refs[0]);
          if (q) svg.appendChild(svgEl('circle', { cx: q.X, cy: q.Y, r: 7 * u, class: 'fp-cons-ring' + (unmet ? ' is-unmet' : ''), 'stroke-width': 2 * u }));
        } else {
          pair++;
          const sym = c.Kind === 'parallel' ? '∥' : c.Kind === 'perpendicular' ? '⊥' : '≡';
          c.Refs.forEach(r => { const m = edgeMid(r); if (m) pill(inward(m, 34), `${sym}${pair}`, unmet); });
        }
      });
    }
    // What the Constrain tool has picked.
    if (mode === 'edit' && tool === 'constrain') cPicks.forEach(r => {
      if (r.Corner != null) { const q = cornerPt(r); if (q) svg.appendChild(svgEl('circle', { cx: q.X, cy: q.Y, r: 10 * u * hs(), class: 'fp-pick', 'stroke-width': 3 * u })); }
      else { const m = edgeMid(r); if (m) svg.appendChild(svgEl('line', { x1: m.a.X, y1: m.a.Y, x2: m.b.X, y2: m.b.Y, class: 'fp-pick', 'stroke-width': 7 * u })); }
    });

    // The plot's edges, to drag it bigger or smaller: every side, and the corners.
    if (mode === 'edit' && tool === 'select') {
      const hr = 8 * u * hs();
      ([['l', 0, h / 2], ['r', w, h / 2], ['t', w / 2, 0], ['b', w / 2, h], ['rb', w, h], ['lt', 0, 0]]                              ).forEach(([side, x, y]) => {
        const hd = svgEl('rect', { x: x - hr, y: y - hr, width: hr * 2, height: hr * 2, rx: 2 * u, class: 'fp-plot-handle is-' + side });
        hd.dataset.plot = side;
        const t = svgEl('title'); t.textContent = 'Drag to make the plot bigger or smaller'; hd.appendChild(t);
        svg.appendChild(hd);
      });
    }
    if (marquee) {
      const b = planBounds([marquee.a, marquee.b]);
      svg.appendChild(svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'fp-marquee', 'stroke-width': 1.5 * u }));
    }

    // What is being drawn right now, with its size.
    if (rectStart && rectEnd) {
      const poly = planRect(rectStart, rectEnd);
      svg.appendChild(svgEl('polygon', { points: points(poly), class: 'fp-draft', 'stroke-width': 2 * u }));
      const b = planBounds(poly);
      const t = svgEl('text', { x: b.x + b.w / 2, y: b.y + b.h / 2, class: 'fp-draft-size', 'font-size': font });
      t.textContent = `${len(b.w)} × ${len(b.h)}`;
      svg.appendChild(t);
    }
    if (draft.length) {
      const pts = hover ? [...draft, hover] : draft;
      svg.appendChild(svgEl('polyline', { points: points(pts), class: 'fp-draft', 'stroke-width': 2 * u }));
      draft.forEach((q, i) => svg.appendChild(svgEl('circle', { cx: q.X, cy: q.Y, r: (i === 0 ? 9 : 6) * u, class: 'fp-draft-pt' + (i === 0 ? ' is-first' : '') })));
    }
    if (wireDraft) {
      const start = wireDraft.from ? itemPt(wireDraft.from) : null;
      const pts = [...(start ? [start] : []), ...wireDraft.pts, ...(hover ? [hover] : [])];
      if (pts.length) {
        svg.appendChild(svgEl('polyline', { points: points(pts), class: 'fp-draft is-wire', 'stroke-width': 2.5 * u }));
        wireDraft.pts.forEach(q => svg.appendChild(svgEl('circle', { cx: q.X, cy: q.Y, r: 5 * u, class: 'fp-draft-pt' })));
      }
    }
    if (measure) {
      const b = measure.b || hover;
      if (b) {
        svg.appendChild(svgEl('line', { x1: measure.a.X, y1: measure.a.Y, x2: b.X, y2: b.Y, class: 'fp-measure', 'stroke-width': 2 * u }));
        const t = svgEl('text', { x: (measure.a.X + b.X) / 2, y: (measure.a.Y + b.Y) / 2 - 8 * u, class: 'fp-measure-text', 'font-size': font });
        t.textContent = len(Math.hypot(b.X - measure.a.X, b.Y - measure.a.Y));
        svg.appendChild(t);
      }
      [measure.a, ...(measure.b ? [measure.b] : [])].forEach(q => svg.appendChild(svgEl('circle', { cx: q.X, cy: q.Y, r: 5 * u, class: 'fp-measure-pt' })));
    }

    // The scale the shading is on, with what the unshaded rooms mean.
    if (mode === 'view' && rooms.length) {
      legend.append(
        el('span', { class: 'fp-key' }, el('span', { class: 'fp-swatch fp-grad' }), `0 – ${max > 0 ? fmt(max) : 'no readings yet'}`),
        el('span', { class: 'fp-key' }, el('span', { class: 'fp-swatch is-unmetered' }), 'unmetered'),
        el('span', { class: 'fp-key' }, el('span', { class: 'fp-swatch is-unknown' }), 'no data'));
    }
    // The circuits on this floor, each a way to bring that circuit forward and fade the rest.
    const refs = [...new Set([...itemsNow().map((i     ) => i.Circuit), ...runsNow().map(r => r.Circuit)].filter(Boolean))]            ;
    if (showWiring && refs.length) {
      const box = el('div', { class: 'fp-circuits' }, el('span', { class: 'fp-circuits-k', text: 'Circuits' }));
      refs.sort().forEach(ref => {
        const b = el('button', { class: 'fp-chip' + (focused === ref ? ' is-on' : ''), type: 'button', title: 'Bring this circuit forward; tap again to show them all.' },
          el('span', { class: 'fp-swatch-dot', style: { background: planCircuitColor(ref) } }), refLabel(ref),
          el('span', { class: 'fp-chip-n', text: String(itemsNow().filter((i     ) => i.Circuit === ref).length) }));
        b.setAttribute('aria-pressed', String(focused === ref));
        b.onclick = () => { focused = focused === ref ? '' : ref; drawPlan(); };
        box.appendChild(b);
      });
      const unknown = itemsNow().filter((i     ) => !i.Circuit && !PLAN_SUPPLY_KINDS.includes(i.Kind)).length;
      if (unknown) box.appendChild(el('span', { class: 'fp-chip is-static' }, el('span', { class: 'fp-swatch-dot is-unknown' }), `${unknown} on an unknown circuit`));
      legend.appendChild(box);
    }
    drawScaleBar();
  };

  const drawScaleBar = () => {
    const u = upp();
    const bar = planScaleBar(90 * u / scale(), sys());
    const px = bar.m * scale() / u;
    (scaleBar.children[0]       ).style.width = `${Math.round(px)}px`;
    scaleBar.children[1].textContent = bar.label;
    scaleBar.hidden = !floorNow();
  };

  // --- Pointer handling ----------------------------------------------------------------------------
  const pointers = new Map                                  ();
  let gesture      = null;
  let pinch                                               = null;

  /// What is under the pointer, found by walking up from the element it landed on.
  const hitOf = (e     ) => {
    for (let n = e.target; n && n !== svg; n = n.parentNode || n.parent) {
      const d = n.dataset || {};
      if (d.resize) return { resize: d.resize           };
      if (d.rotate) return { rotate: d.rotate           };
      if (d.corner != null) return { corner: Number(d.corner) };
      if (d.mid != null) return { mid: Number(d.mid) };
      if (d.runpt != null) return { runpt: Number(d.runpt) };
      if (d.runmid != null) return { runmid: Number(d.runmid) };
      if (d.item) return { item: d.item           };
      if (d.opening) return { opening: d.opening           };
      if (d.run) return { run: d.run           };
      if (d.area) return { area: d.area           };
      if (d.room) return { room: d.room           };
    }
    return {}       ;
  };
  /// Select what was hit. With Shift, Ctrl or ⌘ it is added to the selection, or taken out if already in it.
  const selectHit = (hit     , additive = false) => {
    const next            = hit.item ? { type: 'item', id: hit.item } : hit.opening ? { type: 'opening', id: hit.opening } : hit.run ? { type: 'run', id: hit.run }
      : hit.room ? { type: 'room', id: hit.room } : hit.area ? { type: 'area', id: hit.area } : null;
    selectedCorner = -1; selectedBend = -1;
    if (!additive) { selection = next; extra = []; return; }
    if (!next) return;
    const all = selected();
    const at = all.findIndex(x => x.type === next.type && x.id === next.id);
    if (at >= 0) all.splice(at, 1); else all.push(next);
    selection = all[0] || null;
    extra = all.slice(1);
  };
  const hitSel = (hit     )                                => hit.item ? { type: 'item', id: hit.item } : hit.opening ? { type: 'opening', id: hit.opening }
    : hit.run ? { type: 'run', id: hit.run } : hit.room ? { type: 'room', id: hit.room } : hit.area ? { type: 'area', id: hit.area } : null;

  svg.addEventListener('pointerdown', (e     ) => {
    // The middle button pans in every tool, as it does in drawing programs; the right button is left to the browser.
    if (e.button != null && e.button > 1) return;
    if (e.pointerType) touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { svg.setPointerCapture?.(e.pointerId); } catch { /* capture is a nicety */ }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mid: toPlan({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }), vb: { ...vb } };
      gesture = null; marquee = null;
      rectStart = null; rectEnd = null;
      return;
    }
    const p = toPlan(e);
    const hit = hitOf(e);
    const additive = !!(e.shiftKey || e.ctrlKey || e.metaKey);
    gesture = { start: p, sx: e.clientX, sy: e.clientY, hit, moved: false, pushed: false, vb: { ...vb }, kind: 'pan', additive };
    if (e.button === 1 || spaceDown) { e.preventDefault?.(); gesture.kind = 'pan'; dragging = true; return; }

    const plotSide = (() => { for (let n = e.target; n && n !== svg; n = n.parentNode || n.parent) if (n.dataset?.plot) return n.dataset.plot          ; return ''; })();
    if (mode === 'edit' && tool === 'select' && plotSide) {
      const f = floorNow() .floor;
      gesture.kind = 'plot'; gesture.side = plotSide;
      gesture.orig = { w: Number(f.Width) || 1000, h: Number(f.Height) || 700 };
      gesture.all = movable(everything());
      gesture.box = boundsOf(gesture.all);
    } else if (mode === 'edit' && tool === 'select') {
      const target = extra.length ? null : shapeOf(selection);
      const run = !extra.length && selection?.type === 'run' ? runOf(selection.id) : null;
      const under = hitSel(hit);
      if (hit.corner != null && target) {
        gesture.kind = 'corner'; gesture.index = hit.corner; selectedCorner = hit.corner;
        // A corner shared with a neighbour moves in both rooms, unless Alt pulls it apart.
        gesture.linked = e.altKey ? [] : planSharedCorners(shapesNow(), target.Id, hit.corner);
        const held = cornerLocked(target, hit.corner) || gesture.linked.some((l     ) => cornerLocked(shapeById(l.room), l.corner));
        if (held) { gesture.kind = 'none'; saidLocked(); }
      }
      else if (hit.mid != null && target) {
        // Dragging a wall's middle slides the whole wall, keeping its direction; its neighbours stretch to follow.
        const [i, j] = planEdgeCorners(target, hit.mid);
        gesture.kind = 'wall'; gesture.index = hit.mid;
        gesture.ends = [i, j].map(k => ({ k, X: target.Shape[k].X, Y: target.Shape[k].Y, linked: e.altKey ? [] : planSharedCorners(shapesNow(), target.Id, k) }));
        const held = gesture.ends.some((x     ) => cornerLocked(target, x.k) || x.linked.some((l     ) => cornerLocked(shapeById(l.room), l.corner)));
        if (held) { gesture.kind = 'none'; saidLocked(); }
      }
      else if (hit.runpt != null && run) { gesture.kind = 'runpt'; gesture.index = hit.runpt; selectedBend = hit.runpt; }
      else if (hit.runmid != null && run) { gesture.kind = 'runinsert'; gesture.index = hit.runmid; }
      else if (hit.resize) { gesture.kind = 'resize'; }
      else if (hit.rotate) { gesture.kind = 'rotate'; }
      else if (under && additive) { gesture.kind = 'none'; }
      else if (under) {
        // Dragging anything already selected moves the whole selection; anything else is selected first.
        if (!isSel(under.type, under.id)) selectHit(hit);
        gesture.kind = 'group';
        gesture.members = movable(selected());
        const m0 = gesture.members;
        if (!m0.shapes.length && !m0.items.length && !m0.openings.length && !m0.runs.length) { gesture.kind = 'none'; saidLocked(); }
        gesture.single = selected().length === 1 ? selection : null;
      } else {
        gesture.kind = 'marquee';
      }
    } else if (mode === 'edit' && (tool === 'room' || tool === 'zone' || tool === 'area')) {
      gesture.kind = 'rect'; rectStart = snapped(p); rectEnd = rectStart;
    } else if (mode === 'edit' && tool !== 'pan') {
      gesture.kind = 'tap';
    }
    dragging = true;
    drawPlan();
  });

  svg.addEventListener('pointermove', (e     ) => {
    if (!pointers.has(e.pointerId)) {
      // Hovering: the next corner, bend or measuring point follows the pointer.
      if (draft.length || wireDraft || (measure && !measure.b)) { hover = tool === 'wire' ? drawSnap(wireLast(), toPlan(e)) : tool === 'measure' ? drawSnap(measure?.a, toPlan(e)) : drawSnap(draft[draft.length - 1], toPlan(e)); drawPlan(); }
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const { w } = floorSize();
      const nw = Math.max(w * 0.02, Math.min(w * 4, pinch.vb.w / (d / pinch.d)));
      const k = nw / pinch.vb.w;
      vb = { x: pinch.mid.X - (pinch.mid.X - pinch.vb.x) * k, y: pinch.mid.Y - (pinch.mid.Y - pinch.vb.y) * k, w: nw, h: pinch.vb.h * k };
      const now = toPlan({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      vb.x += pinch.mid.X - now.X; vb.y += pinch.mid.Y - now.Y;
      drawPlan();
      return;
    }
    if (!gesture) return;
    if (!gesture.moved && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) < 6) return;
    gesture.moved = true;
    const p = toPlan(e);
    // A drag is one change: remembered once, as it starts.
    const begin = () => { if (!gesture.pushed) { history.push(); gesture.pushed = true; } };
    const { w, h } = floorSize();
    const k = gesture.kind;
    if (k === 'pan' || k === 'tap' || k === 'none') {
      if (k !== 'pan' && mode === 'edit' && tool !== 'pan') { gesture.kind = 'pan'; }
      const r = svg.getBoundingClientRect();
      const sc = Math.min(r.width / gesture.vb.w, r.height / gesture.vb.h) || 1;
      vb = { ...gesture.vb, x: gesture.vb.x - (e.clientX - gesture.sx) / sc, y: gesture.vb.y - (e.clientY - gesture.sy) / sc };
    } else if (k === 'marquee') {
      marquee = { a: gesture.start, b: p };
    } else if (k === 'plot') {
      begin();
      // Growing to the left or top moves everything drawn along with the edge, so the drawing stays put on screen.
      const f = floorNow() .floor;
      const box = gesture.box;
      const g2 = snapStep() || 1;
      const side         = gesture.side;
      // Measured from the screen, not the plan: the view moves with a left or top edge as it is dragged.
      const rr = svg.getBoundingClientRect();
      const sc = Math.min(rr.width / gesture.vb.w, rr.height / gesture.vb.h) || 1;
      const d = { X: Math.round((e.clientX - gesture.sx) / sc / g2) * g2, Y: Math.round((e.clientY - gesture.sy) / sc / g2) * g2 };
      let W = gesture.orig.w, H = gesture.orig.h, dx = 0, dy = 0;
      if (side.includes('r')) W = Math.max(100, box ? box.x + box.w : 0, gesture.orig.w + d.X);
      if (side.includes('b')) H = Math.max(100, box ? box.y + box.h : 0, gesture.orig.h + d.Y);
      if (side.includes('l')) { dx = Math.max(-d.X, box ? -box.x : -Infinity, 100 - gesture.orig.w); W = gesture.orig.w + dx; }
      if (side.includes('t')) { dy = Math.max(-d.Y, box ? -box.y : -Infinity, 100 - gesture.orig.h); H = gesture.orig.h + dy; }
      f.Width = Math.round(W); f.Height = Math.round(H);
      shift(gesture.all, dx, dy);
      vb = { ...gesture.vb, x: gesture.vb.x + dx, y: gesture.vb.y + dy };
    } else if (k === 'group') {
      begin();
      let dx = p.X - gesture.start.X, dy = p.Y - gesture.start.Y;
      const one = gesture.single;
      const m = gesture.members;
      if (one?.type === 'item' && m.items.length === 1 && !m.shapes.length) {
        // One item: it snaps to the grid, and an outlet or switch onto a wall.
        const x = m.items[0];
        if (isSized(x.it)) fitToWall(x.it, { X: x.X + dx, Y: x.Y + dy }, p);
        else placeOnWall(x.it, onWall(x.it.Kind, gridSnapped({ X: x.X + dx, Y: x.Y + dy }), p));
      } else if (one?.type === 'opening' && m.openings.length === 1 && !m.shapes.length) {
        const x = m.openings[0];
        const want = { X: x.X + dx, Y: x.Y + dy };
        const wall = wallAt(want);
        const q = wall ? wall.pt : clampPt(want);
        x.o.X = planRound(q.X); x.o.Y = planRound(q.Y);
        if (wall) x.o.Angle = Math.round(wall.angle * 10) / 10;
      } else {
        // A room slides into place against its neighbour: its first corner snaps and everything follows.
        const lead = m.shapes[0];
        if (lead) {
          const first = lead.pts[0];
          const want = snapped({ X: first.X + dx, Y: first.Y + dy }, lead.sh);
          dx = want.X - first.X; dy = want.Y - first.Y;
        } else { const g2 = snapOn ? snapStep() : 0; if (g2) { dx = Math.round(dx / g2) * g2; dy = Math.round(dy / g2) * g2; } }
        // Nothing leaves the plot: the move stops at its edge.
        const box = boundsOf(m);
        if (box) { dx = Math.max(-box.x, Math.min(w - box.x - box.w, dx)); dy = Math.max(-box.y, Math.min(h - box.y - box.h, dy)); }
        shift(m, dx, dy);
        if (m.shapes.length) solve(m.shapes.flatMap((x     ) => keysOf(x.sh)));
      }
    } else if (k === 'resize' || k === 'rotate') {
      begin();
      const it = itemOf(selection .id);
      if (it) {
        const t = (Number(it.Rotation) || 0) * Math.PI / 180;
        if (k === 'rotate') {
          // Turned in fifteen-degree steps; Shift turns it freely.
          let deg = Math.atan2(p.Y - it.Y, p.X - it.X) * 180 / Math.PI + 90;
          if (!e.shiftKey) deg = Math.round(deg / 15) * 15;
          it.Rotation = Math.round((((deg % 360) + 360) % 360) * 10) / 10;
        } else {
          const lx = (p.X - it.X) * Math.cos(t) + (p.Y - it.Y) * Math.sin(t), ly = -(p.X - it.X) * Math.sin(t) + (p.Y - it.Y) * Math.cos(t);
          const g2 = snapOn ? snapStep() : 1;
          const min = 0.1 * scale();
          it.Width = Math.max(min, Math.round(Math.abs(lx) * 2 / g2) * g2);
          it.Depth = it.Round ? it.Width : Math.max(min, Math.round(Math.abs(ly) * 2 / g2) * g2);
        }
      }
    } else if (k === 'wall') {
      begin();
      const s = shapeOf(selection);
      if (s) {
        const [a, b] = gesture.ends;
        const L = Math.hypot(b.X - a.X, b.Y - a.Y) || 1;
        const nx = -(b.Y - a.Y) / L, ny = (b.X - a.X) / L;
        let off = (p.X - gesture.start.X) * nx + (p.Y - gesture.start.Y) * ny;
        const g2 = snapOn ? snapStep() : 0;
        if (g2) off = Math.round(off / g2) * g2;
        const fixed           = [];
        gesture.ends.forEach((x     ) => {
          const q = clampPt({ X: x.X + nx * off, Y: x.Y + ny * off });
          s.Shape[x.k] = q; fixed.push(`${s.Id}#${x.k}`);
          x.linked.forEach((l     ) => { const o = shapeById(l.room); if (o) { o.Shape[l.corner] = { ...q }; fixed.push(`${o.Id}#${l.corner}`); } });
        });
        solve(fixed);
      }
    } else if (k === 'corner') {
      begin();
      const s = shapeOf(selection);
      if (s) {
        const q = snapped(p, s);
        s.Shape[gesture.index] = q;
        const fixed = [`${s.Id}#${gesture.index}`];
        (gesture.linked || []).forEach((l     ) => { const o = shapeById(l.room); if (o) { o.Shape[l.corner] = { ...q }; fixed.push(`${o.Id}#${l.corner}`); } });
        solve(fixed);
      }
    } else if (k === 'rect') {
      rectEnd = snapped(p);
    } else if (k === 'runpt' || k === 'runinsert') {
      begin();
      const r = runOf(selection .id);
      if (r) {
        const pts = ensure(r, 'Points', []);
        if (k === 'runinsert') {
          // Bends are stored between the ends; a midpoint before the first bend inserts at the front.
          const at = Math.max(0, Math.min(pts.length, gesture.index - (r.From ? 1 : 0) + 1));
          pts.splice(at, 0, drawSnap(null, p));
          gesture.kind = 'runpt'; gesture.index = at;
        } else pts[gesture.index] = drawSnap(null, p);
      }
    }
    drawPlan();
  });

  const endPointer = (e     ) => {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; if (!pointers.size) dragging = false; return; }
    const g = gesture;
    gesture = null;
    dragging = false;
    if (!g) return;
    const p = toPlan(e);
    const { w, h } = floorSize();

    if (!g.moved) {
      marquee = null;
      tap(g, p);
      return;
    }
    if (g.kind === 'marquee') {
      const b = planBounds([g.start, p]);
      marquee = null;
      const caught = everything().filter(x => insideBox(x, b));
      const all = g.additive ? [...selected(), ...caught.filter(x => !isSel(x.type, x.id))] : caught;
      selection = all[0] || null; extra = all.slice(1); selectedCorner = -1;
      render();
      return;
    }
    if (g.kind === 'rect' && rectStart && rectEnd) {
      const poly = planRect(rectStart, rectEnd);
      rectStart = null; rectEnd = null;
      if (Math.abs(planArea(poly)) > (0.3 * scale()) ** 2) finishOutline(poly);
      else render();
      return;
    }
    if (g.kind === 'corner') {
      const s = shapeOf(selection);
      if (s) s.Shape = planClamp(s.Shape, w, h);
    }
    if (g.kind === 'group') {
      // Where an item lands is where it is: a room, an outdoor zone, or outdoors on this floor.
      const moved        = g.members.items.map((x     ) => x.it);
      const lone = moved.length === 1 && !g.members.shapes.length;
      let said = '';
      moved.forEach(it => {
        if (g.members.shapes.some((x     ) => x.sh.Id === it.Room)) return;
        const room = (lone ? planShapeAt(roomsNow(), p) : null) || planShapeAt(roomsNow(), { X: it.X, Y: it.Y });
        if ((room?.Id || '') !== (it.Room || '')) { it.Room = room?.Id || ''; said = room ? `Moved into ${room.Name || room.Id}.` : 'Moved outside every room: outdoors on this floor.'; }
        it.Floor = floorNow()?.floor.Id || it.Floor;
      });
      if (lone && said) toast(said, true);
    }
    if (g.kind === 'plot') viewFor = floorNow()?.floor.Id || '';
    if (g.pushed) changed();
    render();
  };
  // A middle-button drag pans; the browser's own middle-click autoscroll would fight it.
  svg.addEventListener('mousedown', (e     ) => { if (e.button === 1) e.preventDefault(); });
  svg.addEventListener('auxclick', (e     ) => { if (e.button === 1) e.preventDefault(); });
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', (e     ) => { pointers.delete(e.pointerId); gesture = null; pinch = null; marquee = null; dragging = false; rectStart = null; rectEnd = null; drawPlan(); });
  svg.addEventListener('pointerleave', () => { if (hover) { hover = null; drawPlan(); } });
  svg.addEventListener('dblclick', () => { if (wireDraft) finishWire(''); else if (draft.length >= 3) finishOutline(draft); });

  // --- The menu a right-click opens, over whatever it was aimed at ----------------------------------

  const closeMenu = () => fpMenu.close();
  const openMenu = (e     , entries         ) => fpMenu.open(e, entries);
  /// What a right-click offers, by what it landed on.
  /// A menu choice that edits: it turns Edit on first, so nothing in the menu is dead while viewing.
  const onEdit = (fn            ) => () => { if (mode !== 'edit') { mode = 'edit'; tool = 'select'; } fn(); };
  const menuFor = (hit     , p    )          => {
    const editing = mode === 'edit';
    const toEdit        = { label: 'Edit this floor', run: () => { mode = 'edit'; tool = 'select'; render(); } };
    const under = hitSel(hit);
    if (under && !isSel(under.type, under.id)) selectHit(hit);
    const many = selected().length > 1;
    if (many) return [
      { label: `${selected().length} selected`, head: true },
      { label: 'Delete them', danger: true, run: onEdit(() => deleteSelection())},
      { label: 'Select none', run: () => { selection = null; extra = []; render(); } },
    ];
    if (hit.corner != null) return [{ label: 'Corner', head: true }, { label: 'Remove corner', danger: true, run: onEdit(() => { selectedCorner = hit.corner; removeCorner(); })}];
    if (hit.runpt != null) return [{ label: 'Wire bend', head: true }, { label: 'Remove bend', danger: true, run: onEdit(() => { selectedBend = hit.runpt; removeBend(); })}];
    if (hit.mid != null) {
      const sh = shapeOf(selection);
      const locked = !!sh && ((sh.LockedWalls || []).includes(hit.mid) || sh.Locked);
      return [
        { label: `Wall ${hit.mid + 1}`, head: true },
        { label: 'Add a corner here', disabled: locked, run: onEdit(() => insertCorner(hit.mid))},
        { label: locked ? 'Unlock this wall' : 'Lock this wall', disabled: !sh, run: onEdit(() => act(() => { const list = ensure(sh, 'LockedWalls', []); const at = list.indexOf(hit.mid); if (at >= 0) list.splice(at, 1); else list.push(hit.mid); if (!list.length) delete sh.LockedWalls; }))},
        { label: 'Hold its length', disabled: !sh, run: onEdit(() => { const [i, j] = planEdgeCorners(sh, hit.mid); addConstraint('length', [{ Room: sh.Id, Edge: hit.mid }], Math.round(Math.hypot(sh.Shape[j].X - sh.Shape[i].X, sh.Shape[j].Y - sh.Shape[i].Y) * 10) / 10); })},
      ];
    }
    if (hit.item) {
      const it = itemOf(hit.item);
      if (!it) return [];
      const supply = PLAN_SUPPLY_KINDS.includes(it.Kind);
      return [
        { label: itemName(it), head: true },
        ...(it.Circuit ? [{ label: 'Show its circuit', run: () => { focused = focused === it.Circuit ? '' : it.Circuit; drawPlan(); } }         ] : []),
        ...(supply ? [] : [{ label: 'Trace its circuit', run: () => traceItem(it) }         ]),
        { label: 'Wire from here', run: onEdit(() => { mode = 'edit'; tool = 'wire'; wireDraft = { from: it.Id, pts: [] }; render(); })},
        ...(isSized(it)
          ? [{ label: 'Turn 90°', run: onEdit(() => act(() => { it.Rotation = ((Number(it.Rotation) || 0) + 90) % 360; }))}         ,
             { label: 'Draw as an icon', run: onEdit(() => act(() => { delete it.Width; delete it.Depth; delete it.Rotation; delete it.Round; delete it.Footprint; }))}         ]
          : [{ label: 'Give it a real size', run: onEdit(() => act(() => { const side = planRound(0.76 * scale()); it.Width = side; it.Depth = side; it.Rotation = 0; }))}         ]),
        ...(it.Kind === 'outlet' ? [{ label: it.Gfci ? 'Not a GFCI' : 'Mark as GFCI', run: onEdit(() => act(() => { if (it.Gfci) delete it.Gfci; else it.Gfci = true; }))}         ] : []),
        { label: 'Duplicate', run: onEdit(() => duplicate())},
        { label: 'Delete', danger: true, run: onEdit(() => deleteSelection())},
        ...(editing ? [] : [toEdit]),
      ];
    }
    if (hit.opening) {
      const o = openingOf(hit.opening);
      return [
        { label: PLAN_OPENINGS.find(x => x[0] === o?.Kind)?.[1] || 'Opening', head: true },
        { label: 'Turn 90°', run: onEdit(() => act(() => { o.Angle = ((Number(o.Angle) || 0) + 90) % 360; }))},
        { label: 'Open the other way', run: onEdit(() => act(() => { if (o.Flip) delete o.Flip; else o.Flip = true; }))},
        { label: 'Hinges on the other side', run: onEdit(() => act(() => { o.Swing = o.Swing === 'right' ? 'left' : 'right'; }))},
        { label: 'Duplicate', run: onEdit(() => duplicate())},
        { label: 'Delete', danger: true, run: onEdit(() => deleteSelection())},
      ];
    }
    if (hit.run) {
      const r = runOf(hit.run);
      return [
        { label: r?.Label || 'Wire', head: true },
        { label: 'Reverse direction', run: onEdit(() => act(() => { const f = r.From; r.From = r.To; r.To = f; r.Points = [...(r.Points || [])].reverse(); }))},
        ...(r?.Circuit ? [{ label: 'Show its circuit', run: () => { focused = focused === r.Circuit ? '' : r.Circuit; drawPlan(); } }         ] : []),
        { label: 'Delete', danger: true, run: onEdit(() => deleteSelection())},
      ];
    }
    if (hit.room || hit.area) {
      const sh = shapeOf(selection);
      if (!sh) return [];
      return [
        { label: sh.Name || sh.Id, head: true },
        { label: sh.Locked ? 'Unlock it' : 'Lock it', run: onEdit(() => act(() => { if (sh.Locked) delete sh.Locked; else sh.Locked = true; }))},
        { label: 'Redraw its outline', disabled: !!sh.Locked, run: onEdit(() => { act(() => { sh.Shape = []; setConstraints(planRefsWithout(constraintsNow(), sh.Id)); }); tool = hit.area ? 'area' : sh.Outdoor ? 'zone' : 'room'; render(); })},
        { label: 'Duplicate', disabled: !!hit.area, run: onEdit(() => duplicate())},
        { label: 'Delete', danger: true, run: onEdit(() => deleteSelection())},
        ...(editing ? [] : [toEdit]),
      ];
    }
    // Bare plot.
    return [
      { label: 'Here', head: true },
      { label: 'Add a room here', disabled: !floorNow(), run: () => { mode = 'edit'; tool = 'room'; render(); roomBySize(false); } },
      { label: `Place ${kindName(itemKind).toLowerCase()} here`, disabled: !floorNow(), run: () => { mode = 'edit'; tool = 'item'; render(); tap({ hit: {}, additive: false }, p); } },
      { label: 'Background image…', disabled: !floorNow(), run: () => backgroundSheet() },
      { label: 'Fit the floor in view', run: () => { fit(); drawPlan(); } },
      ...(editing ? [] : [toEdit]),
    ];
  };
  svg.addEventListener('contextmenu', (e     ) => {
    e.preventDefault?.();
    const p = toPlan(e);
    const entries = menuFor(hitOf(e), p);
    render();
    openMenu(e, entries);
  });
  stage.addEventListener('pointerdown', (e     ) => { if (!menu.hidden && !menu.contains?.(e.target)) closeMenu(); }, true);
  svg.addEventListener('wheel', (e     ) => {
    // The wheel zooms about the pointer; with Shift it pans instead.
    e.preventDefault();
    const dy = (Number(e.deltaY) || 0) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    if (e.shiftKey) {
      const r = svg.getBoundingClientRect();
      const sc = Math.min(r.width / vb.w, r.height / vb.h) || 1;
      const dx = (Number(e.deltaX) || 0) || dy;
      vb = { ...vb, x: vb.x + dx / sc, y: vb.y + (e.deltaX ? dy : 0) / sc };
      drawPlan();
      return;
    }
    zoomAt(toPlan(e), Math.exp(-dy * 0.0022));
  }, { passive: false });

  /// A tap, by tool.
  const tap = (g     , p    ) => {
    const hit = g.hit;
    // A corner or a wire bend: tapped once it is selected, tapped twice (or double-clicked) it is removed.
    if (mode === 'edit' && tool === 'select' && hit.mid != null) {
      // Double-tapping a wall's middle puts a corner there; a single tap does nothing but keep the room selected.
      const key = `${selection?.type}:${selection?.id}:m${hit.mid}`;
      const now = Date.now();
      const twice = !!lastTap && lastTap.key === key && now - lastTap.at < 450;
      lastTap = twice ? null : { key, at: now };
      if (twice) insertCorner(hit.mid);
      render();
      return;
    }
    if (mode === 'edit' && tool === 'select' && (hit.corner != null || hit.runpt != null)) {
      const key = `${selection?.type}:${selection?.id}:${hit.corner != null ? 'c' + hit.corner : 'b' + hit.runpt}`;
      const now = Date.now();
      const twice = !!lastTap && lastTap.key === key && now - lastTap.at < 450;
      lastTap = twice ? null : { key, at: now };
      if (hit.corner != null) { selectedCorner = hit.corner; if (twice) removeCorner(); }
      else { selectedBend = hit.runpt; if (twice) removeBend(); }
      render();
      return;
    }
    if (mode === 'view' || tool === 'select' || tool === 'pan') {
      selectedBend = -1;
      if (tool !== 'pan') selectHit(hit, mode === 'edit' && !!g.additive);
      render();
      return;
    }
    if (tool === 'outline') {
      const q = drawSnap(draft[draft.length - 1], p);
      const first = draft[0];
      if (first && draft.length >= 3 && Math.hypot(q.X - first.X, q.Y - first.Y) <= 14 * upp()) finishOutline(draft);
      else { draft.push(q); render(); }
      return;
    }
    if (tool === 'room' || tool === 'zone' || tool === 'area') { rectStart = null; rectEnd = null; render(); return; }
    if (tool === 'item') {
      if (hit.item) { selectHit(hit); render(); return; }
      const q = onWall(itemKind, gridSnapped(p), p);
      const room = planShapeAt(roomsNow(), p) || planShapeAt(roomsNow(), q);
      const id = freshIn(itemsIn(), itemKind.replace(/-/g, '_'));
      act(() => {
        const it      = { Id: id, Kind: itemKind, Label: '', Room: room?.Id || '', Floor: floorNow() .floor.Id, X: q.X, Y: q.Y, Circuit: '', Node: '' };
        if (itemKind === 'outlet' && gfciNext) it.Gfci = true;
        const fp = PLAN_FOOTPRINTS.find(f => f[0] === itemPreset);
        if (fp) {
          const inch = 0.0254 * scale();
          Object.assign(it, { Kind: fp[2], Label: fp[1], Footprint: fp[0], Width: planRound(fp[3] * inch), Depth: planRound(fp[4] * inch), Rotation: 0 });
          if (fp[5]) it.Round = true;
          fitToWall(it, gridSnapped(p), p);
        } else placeOnWall(it, q);
        itemsIn().push(it);
        selection = { type: 'item', id };
      });
      if (!room && !PLAN_SUPPLY_KINDS.includes(itemKind)) toast('Placed outdoors — outside every room. That is fine for an exterior light or a yard outlet.', true);
      return;
    }
    if (tool === 'door' || tool === 'window') {
      const kind = tool === 'window' ? 'window' : doorKind;
      const wall = wallAt(p);
      const q = wall ? wall.pt : clampPt(p);
      const id = freshIn(openingsNow(), kind.replace(/-/g, '_'));
      act(() => {
        openingsNow().push({ Id: id, Kind: kind, X: planRound(q.X), Y: planRound(q.Y), Angle: wall ? Math.round(wall.angle * 10) / 10 : 0, Width: openingWidth(kind), Swing: 'left', Flip: false });
        selection = { type: 'opening', id };
      });
      if (!wall) toast('No wall there, so it was placed where you tapped. Drag it onto a wall and it lines up.', false);
      return;
    }
    if (tool === 'wire') {
      if (!wireDraft) {
        wireDraft = hit.item ? { from: hit.item, pts: [] } : { from: '', pts: [drawSnap(null, p)] };
        render();
        return;
      }
      if (hit.item && hit.item !== wireDraft.from) { finishWire(hit.item); return; }
      wireDraft.pts.push(drawSnap(wireLast(), p));
      render();
      return;
    }
    if (tool === 'constrain') {
      const pick = pickRef(p);
      if (!pick) { cPicks = []; render(); return; }
      const at = cPicks.findIndex(r => sameRef(r, pick));
      if (at >= 0) cPicks.splice(at, 1); else { cPicks.push(pick); if (cPicks.length > 2) cPicks.shift(); }
      render();
      return;
    }
    if (tool === 'measure') {
      const q = snapped(p);
      if (!measure || measure.b) measure = { a: q, b: null };
      else measure.b = drawSnap(measure.a, p);
      render();
    }
  };

  /// A drawn outline becomes the selected room or area when it has none yet, and a new one otherwise.
  const finishOutline = (poly      ) => {
    const { w, h } = floorSize();
    const shape = planClamp(poly, w, h);
    draft = []; hover = null;
    const kind = tool === 'area' ? 'area' : 'room';
    const outdoor = tool === 'zone';
    const target = shapeOf(selection);
    act(() => {
      if (target && (target.Shape || []).length < 3 && selection .type === kind) { target.Shape = shape; return; }
      if (kind === 'area') {
        const name = `Area ${areasNow().length + 1}`;
        const id = freshId(name);
        // An area drawn over rooms takes them in.
        const rooms = roomsNow().filter(r => (r.Shape || []).length >= 3 && planContains(shape, planCentroid(r.Shape))).map(r => r.Id);
        areasNow().push({ Id: id, Name: name, Rooms: rooms, Shape: shape });
        selection = { type: 'area', id };
        return;
      }
      const name = outdoor ? `Yard ${roomsNow().filter(r => r.Outdoor).length + 1}` : `Room ${roomsNow().filter(r => !r.Outdoor).length + 1}`;
      const id = freshId(name);
      roomsNow().push({ Id: id, Name: name, Shape: shape, Outdoor: outdoor, Surface: outdoor ? 'grass' : '' });
      selection = { type: 'room', id };
      // Items already dropped inside it are now in it.
      itemsNow().forEach((it     ) => { if (!it.Room && planContains(shape, { X: it.X, Y: it.Y })) it.Room = id; });
    });
    tool = 'select';
    render();
    // Straight to its name: nobody wants to live with "Room 4".
    setTimeout(() => (side.querySelector?.('.fp-name')       )?.focus?.(), 0);
  };

  /// A wire drawn between two items, or out to a bare point. Its circuit comes from whichever end knows one.
  const finishWire = (to        ) => {
    const d = wireDraft;
    wireDraft = null; hover = null;
    if (!d) return;
    const pathLen = (d.from ? 1 : 0) + d.pts.length + (to ? 1 : 0);
    if (pathLen < 2) { render(); return; }
    const from = d.from ? itemOf(d.from) : null, end = to ? itemOf(to) : null;
    const circuit = from?.Circuit || end?.Circuit || '';
    const id = freshIn(runsIn(), 'run');
    let adopted = '';
    act(() => {
      runsIn().push({ Id: id, Kind: wireKind, Floor: floorNow() .floor.Id, Circuit: wireKind === 'circuit' ? circuit : '', From: d.from, To: to, Points: d.pts, Label: '' });
      // Wiring an item to one on a known circuit puts it on that circuit — said, and undoable.
      if (wireKind === 'circuit' && circuit) [from, end].forEach(it => { if (it && !it.Circuit && !PLAN_SUPPLY_KINDS.includes(it.Kind)) { it.Circuit = circuit; adopted = itemName(it); } });
      selection = { type: 'run', id };
    });
    if (adopted) toast(`${adopted} is wired to ${refLabel(circuit)}, so it is now on that circuit. Ctrl+Z undoes it.`, true);
  };

  // --- Tool options --------------------------------------------------------------------------------
  const seg = (options                    , value        , onPick                     , title = '') => {
    const box = el('div', { class: 'fp-seg fp-seg-sm' });
    if (title) box.title = title;
    options.forEach(([v, label]) => {
      const b = el('button', { class: 'fp-seg-btn' + (v === value ? ' is-on' : ''), text: label, type: 'button' });
      b.setAttribute('aria-pressed', String(v === value));
      b.onclick = () => onPick(v);
      box.appendChild(b);
    });
    return box;
  };
  const check = (label        , on         , set                      , title = '') => {
    const cb = el('input', { type: 'checkbox' })                    ;
    cb.checked = on;
    cb.onchange = () => set(cb.checked);
    return el('label', { class: 'ld-inst fp-check', title }, cb, ' ' + label);
  };

  const drawSub = () => {
    subBar.innerHTML = '';
    Object.entries(modeBtns).forEach(([m, b]) => { b.classList.toggle('is-on', m === mode); b.setAttribute('aria-selected', String(m === mode)); });
    if (mode === 'view') {
      subBar.appendChild(seg([['now', 'Power now'], ['today', 'Today'], ['week', 'This week']], period, v => { period = v; remember('period', v); load(); },
        'Shade by what each room is drawing now, or by the energy it has used over a period.'));
    }
    subBar.appendChild(check('Wiring', showWiring, v => { showWiring = v; remember('wiring', v ? '1' : '0'); drawPlan(); }, 'Show cable runs, and ring each item in its circuit’s colour.'));
    if (constraintsNow().length) subBar.appendChild(check('Constraints', showCons, v => { showCons = v; remember('cons', v ? '1' : '0'); drawPlan(); }, 'Show the constraints held on this floor: fixed lengths, angles, parallel and square walls.'));
    subBar.appendChild(check('Sizes', showSizes, v => { showSizes = v; remember('sizes', v ? '1' : '0'); drawPlan(); }, 'Show every wall’s length and each room’s floor area.'));
    if (mode === 'edit' && floorBelow()) subBar.appendChild(check('Floor below', showBelow, v => { showBelow = v; remember('below', v ? '1' : '0'); drawPlan(); }, 'Show the floor beneath this one faintly, to line this one up with it.'));
    if (mode === 'edit') subBar.appendChild(check('Snap', snapOn, v => { snapOn = v; remember('snap', v ? '1' : '0'); }, 'Corners snap to other rooms’ corners and edges, and everything to a fine grid.'));

    palette.hidden = mode !== 'edit';
    body.classList.toggle('is-editing', mode === 'edit');
    Object.entries(toolBtns).forEach(([t, b]) => { b.classList.toggle('is-on', mode === 'edit' && t === tool); b.setAttribute('aria-pressed', String(mode === 'edit' && t === tool)); });
    undoBtn.disabled = !history.canUndo();
    redoBtn.disabled = !history.canRedo();

    opts.innerHTML = '';
    opts.hidden = mode !== 'edit';
    if (mode === 'edit') drawOpts();
    const how = mode === 'view' ? 'Tap a room or item for its detail. Drag to pan, pinch or Ctrl+wheel to zoom.'
      : FP_TOOLS.find(t => t[0] === tool)?.[3] || '';
    hint.textContent = how;
    hint.hidden = !how || (mode === 'view' && !!selection);
  };

  const drawOpts = () => {
    const add = (...n       ) => n.forEach(x => opts.appendChild(x));
    if (tool === 'room' || tool === 'zone') {
      const bySize = btn(tool === 'zone' ? 'Add an outdoor zone by size…' : 'Add a room by size…', 'primary');
      bySize.onclick = () => roomBySize(tool === 'zone');
      add(bySize, el('span', { class: 'fp-opts-note', text: 'or drag across the plan.' }));
    } else if (tool === 'outline') {
      if (draft.length) {
        const done = btn('Finish outline', 'primary');
        done.disabled = draft.length < 3;
        done.onclick = () => finishOutline(draft);
        const back = btn('Undo point');
        back.onclick = () => { draft.pop(); render(); };
        const cancel = btn('Cancel');
        cancel.onclick = () => { draft = []; render(); };
        add(done, back, cancel, el('span', { class: 'fp-opts-note', text: `${draft.length} corner${draft.length === 1 ? '' : 's'}` }));
      } else add(el('span', { class: 'fp-opts-note', text: 'Tap the first corner. Double-tap or tap the first corner again to close.' }));
    } else if (tool === 'door') {
      add(seg(PLAN_OPENINGS.filter(o => o[0] !== 'window'), doorKind, v => { doorKind = v; render(); }));
    } else if (tool === 'item') {
      const grid = el('div', { class: 'fp-kinds' });
      ['Inside', 'Power'].forEach(group => {
        grid.appendChild(el('span', { class: 'fp-kinds-group', text: group === 'Inside' ? 'Loads' : 'Supply & utility' }));
        PLAN_KINDS.filter(k => k[2] === group).forEach(([k, label]) => {
          const b = el('button', { class: 'fp-kind' + (itemKind === k && !itemPreset ? ' is-on' : ''), type: 'button', title: label });
          const icon = svgEl('svg', { viewBox: '-13 -13 26 26', class: 'fp-kind-icon' });
          icon.appendChild(svgEl('circle', { r: 12, class: 'fp-item-disc' }));
          const gl = planGlyph(k, 12); gl.setAttribute('stroke-width', '1.4'); icon.appendChild(gl);
          b.append(icon, el('span', { text: label }));
          b.setAttribute('aria-pressed', String(itemKind === k));
          b.setAttribute('aria-label', label);
          b.onclick = () => { itemKind = k; itemPreset = ''; remember('kind', k); render(); };
          grid.appendChild(b);
        });
      });
      // Appliances and equipment at their real size: dropped by a wall, they stand with their back to it.
      grid.appendChild(el('span', { class: 'fp-kinds-group', text: 'At real size' }));
      PLAN_FOOTPRINTS.forEach(([key, label, kind, w, d, round]) => {
        const size = sys() === 'imperial' ? `${w}″ × ${d}″` : `${Math.round(w * 2.54)} × ${Math.round(d * 2.54)} cm`;
        const b = el('button', { class: 'fp-kind is-size' + (itemPreset === key ? ' is-on' : ''), type: 'button', title: `${label}, ${round ? `${size.split(' ×')[0]} across` : size}` });
        const icon = svgEl('svg', { viewBox: '-13 -13 26 26', class: 'fp-kind-icon' });
        const bw = 22 * w / Math.max(w, d), bd = 22 * d / Math.max(w, d);
        icon.appendChild(round ? svgEl('circle', { r: 11, class: 'fp-body-shape' }) : svgEl('rect', { x: -bw / 2, y: -bd / 2, width: bw, height: bd, rx: 2, class: 'fp-body-shape' }));
        const art = planFootprintArt(key, bw, bd, 0.55);
        if (art) icon.appendChild(art);
        b.append(icon, el('span', { text: label }));
        b.setAttribute('aria-label', label);
        b.setAttribute('aria-pressed', String(itemPreset === key));
        b.onclick = () => { itemPreset = itemPreset === key ? '' : key; itemKind = kind; render(); };
        grid.appendChild(b);
      });
      add(grid);
      if (itemKind === 'outlet') add(check('GFCI', gfciNext, v => { gfciNext = v; remember('gfci', v ? '1' : '0'); }, 'Place GFCI outlets: whatever is wired from their load side is protected by them.'));
    } else if (tool === 'wire') {
      add(seg([['circuit', 'Circuit'], ['feeder', 'Feeder'], ['service', 'Service']], wireKind, v => { wireKind = v; render(); },
        'A branch circuit, a feeder between panels, or the utility service from the pole.'));
      if (wireDraft) {
        const done = btn('Finish here', 'primary');
        done.disabled = (wireDraft.from ? 1 : 0) + wireDraft.pts.length < 2;
        done.onclick = () => finishWire('');
        const cancel = btn('Cancel');
        cancel.onclick = () => { wireDraft = null; render(); };
        add(done, cancel, el('span', { class: 'fp-opts-note', text: 'Tap bends, then the item it ends at.' }));
      }
    } else if (tool === 'constrain') {
      const corners = cPicks.filter(r => r.Corner != null), edges = cPicks.filter(r => r.Edge != null);
      if (!cPicks.length) add(el('span', { class: 'fp-opts-note', text: 'Tap a corner or a wall, or two of them. Tap again to let one go.' }));
      else add(el('span', { class: 'fp-opts-note is-picks', text: cPicks.map(refName).join(' + ') }));
      const go = (label        , fn            , title = '') => { const b = btn(label, 'primary'); if (title) b.title = title; b.onclick = fn; add(b); };
      if (edges.length === 1 && cPicks.length === 1) {
        const e = edgeMid(edges[0]) ;
        let want = e.len;
        add(lenInput(e.len, u => { want = u; }));
        go('Fix length', () => addConstraint('length', edges, Math.round(want * 10) / 10), 'Hold this wall at this length.');
        go('Level', () => addConstraint('horizontal', edges), 'Hold this wall horizontal on the plan.');
        go('Plumb', () => addConstraint('vertical', edges), 'Hold this wall vertical on the plan.');
      } else if (corners.length === 1 && cPicks.length === 1) {
        const sh = shapeById(corners[0].Room) ;
        const cur = planCornerAngle(sh, corners[0].Corner );
        const deg = el('input', { type: 'number', class: 'fp-deg', value: String(Math.round(Math.abs(cur))), min: '1', max: '359', step: '1' })                    ;
        add(deg, el('span', { class: 'fp-opts-note', text: '°' }));
        go('Hold angle', () => { const v = Math.max(1, Math.min(179.9, Number(deg.value) || 90)); addConstraint('angle', corners, Math.sign(cur || 1) * v); }, 'Hold the corner at this angle.');
        go('Square', () => addConstraint('angle', corners, Math.sign(cur || 1) * 90), 'Hold the corner at 90°.');
      } else if (corners.length === 2) {
        go('Coincident', () => addConstraint('coincident', corners), 'Make the two corners one: a shared corner.');
      } else if (edges.length === 2) {
        go('In line', () => addConstraint('colinear', edges), 'Colinear: the two walls lie along one line.');
        go('Parallel', () => addConstraint('parallel', edges));
        go('Square', () => addConstraint('perpendicular', edges), 'Perpendicular: the two walls meet at a right angle.');
        const a = edgeMid(edges[0]) , b = edgeMid(edges[1]) ;
        go('Same length', () => { addConstraint('length', [edges[1]], Math.round(a.len * 10) / 10); }, `Fix the second wall at the first one’s length, ${len(a.len)} (it is ${len(b.len)} now).`);
      } else if (cPicks.length === 2) {
        add(el('span', { class: 'fp-opts-note', text: 'Pick two corners, or two walls.' }));
      }
      if (cPicks.length) { const clear = btn('Clear'); clear.onclick = () => { cPicks = []; render(); }; add(clear); }
    } else if (tool === 'measure') {
      if (measure?.b) {
        const d = Math.hypot(measure.b.X - measure.a.X, measure.b.Y - measure.a.Y);
        const real = el('input', { type: 'text', class: 'fp-len', placeholder: sys() === 'imperial' ? `e.g. 12' 6"` : 'e.g. 3.75 m' })                    ;
        const set = btn('Set scale', 'primary');
        set.title = 'Make the plan’s scale such that this line is the length you typed. Rooms keep their outlines; their sizes change.';
        set.onclick = () => {
          const m = planParseLen(real.value, sys());
          if (!m || m <= 0 || d <= 0) { real.classList.add('is-bad'); return; }
          act(() => { floorNow() .floor.Scale = Math.round((d / m) * 1000) / 1000; });
          measure = null;
          toast(`Scale set: that line is ${planFmtLen(m, sys())}. Every size on this floor now reads in real units.`, true);
        };
        add(el('span', { class: 'fp-measure-read', text: len(d) }), el('span', { class: 'fp-opts-note', text: 'It is really' }), real, set);
      } else add(el('span', { class: 'fp-opts-note', text: measure ? 'Tap the second point.' : 'Tap the first point.' }));
    } else if (tool === 'select') {
      add(el('span', { class: 'fp-opts-note', text: 'Drag to move; drag a box to select several. Double-click a corner or bend to remove it. Delete removes; Ctrl+Z undoes.' }));
    } else {
      add(el('span', { class: 'fp-opts-note', text: FP_TOOLS.find(t => t[0] === tool)?.[3] || '' }));
    }
  };

  const roomBySize = (outdoor         ) => {
    const body = el('div', { class: 'fp-sheet' });
    const name = el('input', { type: 'text', placeholder: outdoor ? 'Back yard' : 'Kitchen' })                    ;
    let wU = 0, hU = 0;
    const wIn = lenInput(0, u => { wU = u; }), hIn = lenInput(0, u => { hU = u; });
    const surface = el('select', {})                     ;
    PLAN_SURFACES.forEach(([v, l]) => surface.appendChild(el('option', { value: v, text: l })));
    surface.value = outdoor ? 'grass' : '';
    body.append(field('Name', name), el('div', { class: 'fp-two' }, field('Width', wIn, 'Inside wall to inside wall.'), field('Depth', hIn)), field('Surface', surface),
      el('div', { class: 'desc', text: 'It is placed in the middle of the view; drag it where it goes. Sizes are in ' + (sys() === 'imperial' ? 'feet and inches' : 'metres') + ' — change that under GUI › Distance units.' }));
    const add = btn(outdoor ? 'Add zone' : 'Add room', 'primary');
    add.onclick = () => {
      wIn.onchange?.(null       ); hIn.onchange?.(null       );
      if (!wU || !hU) { toast('Give it a width and a depth.', false); return; }
      const c = snapped(centre());
      const shape = planClamp(planRect({ X: c.X - wU / 2, Y: c.Y - hU / 2 }, { X: c.X + wU / 2, Y: c.Y + hU / 2 }), floorSize().w, floorSize().h);
      const nm = name.value.trim() || (outdoor ? 'Yard' : `Room ${roomsNow().length + 1}`);
      const id = freshId(nm);
      act(() => { roomsNow().push({ Id: id, Name: nm, Shape: shape, Outdoor: outdoor, Surface: surface.value }); selection = { type: 'room', id }; tool = 'select'; });
      closeSheet();
    };
    openSheet({ title: outdoor ? 'Add an outdoor zone' : 'Add a room', body, footer: [add] });
    setTimeout(() => name.focus?.(), 0);
  };

  // --- Side panel ----------------------------------------------------------------------------------
  const row = (label        , value     , cls = '') => el('div', { class: 'fp-row ' + cls }, el('span', { class: 'fp-row-k', text: label }), typeof value === 'string' ? el('span', { class: 'fp-row-v', text: value }) : value);
  const field = (label        , input     , hintText = '') => el('label', { class: 'fp-field' }, el('span', { class: 'fp-field-k', text: label }), input, ...(hintText ? [el('span', { class: 'fp-field-hint', text: hintText })] : []));
  const select = (choices                    , value        , onPick                     ) => {
    const s = el('select', {})                     ;
    choices.forEach(([v, t]) => s.appendChild(el('option', { value: v, text: t })));
    s.value = value;
    s.onchange = () => onPick(s.value);
    return s;
  };
  const valueLine = (p              ) => {
    if (!p) return el('div', { class: 'fp-big is-unmetered', text: 'unmetered' });
    const box = el('div', {});
    box.appendChild(el('div', { class: 'fp-big is-' + p.state, text: p.state === 'known' ? fmt(p.value) : p.state === 'unknown' ? 'no data' : 'unmetered' }));
    if (p.state !== 'known') box.appendChild(el('div', { class: 'desc', text: FP_STATE_TEXT[p.state] || '' }));
    if (p.missing.length) box.appendChild(el('div', { class: 'desc', text: 'Waiting on: ' + p.missing.map(m => m.label).join(', ') }));
    if (p.split.length) box.appendChild(el('div', { class: 'desc', text: 'Fed from inside and outside this place, so its share cannot be told: ' + p.split.map(m => m.label).join(', ') }));
    return box;
  };
  const actions = (...b       ) => el('div', { class: 'fp-actions' }, ...b);
  const listRow = (name        , val        , onclick                     , valCls = '') => {
    const kids = [el('span', { class: 'fp-list-name', text: name }), el('span', { class: 'fp-list-val ' + valCls, text: val })];
    const b = onclick ? el('button', { class: 'fp-list-row', type: 'button' }, ...kids) : el('div', { class: 'fp-list-row is-static' }, ...kids);
    if (onclick) b.onclick = onclick;
    return b;
  };

  /// Every circuit serving a place: breakers that say they serve it, and the circuits of what is placed or metered in it.
  const circuitsFor = (placeId        ) => {
    if (!live) return []             ;
    const inPlace = (loc               ) => !!loc && (loc === placeId || areaTakesIn(placeId, loc));
    const refs = new Set        ();
    live.circuits.forEach(c => { if (c.rooms.some(r => inPlace(r) || areaTakesIn(r, placeId))) refs.add(c.ref); });
    itemsIn().forEach((it     ) => { if (it.Circuit && inPlace(it.Room)) refs.add(it.Circuit); });
    live.nodes.forEach(n => { if (n.circuit && inPlace(n.placed)) refs.add(n.circuit); });
    return live.circuits.filter(c => refs.has(c.ref));
  };
  const areaTakesIn = (areaId        , roomId        ) => areasNow().some(a => a.Id === areaId && (a.Rooms || []).includes(roomId));

  const circuitRow = (c         ) => {
    const b = el('button', { class: 'fp-list-row', type: 'button' },
      el('span', { class: 'fp-swatch-dot', style: { background: planCircuitColor(c.ref) } }),
      el('span', { class: 'fp-list-name', text: circuitLabel(c) }),
      el('span', { class: 'fp-list-val' + (c.power == null ? ' is-nodata' : ''), text: c.power == null ? 'no data' : formatMeasure(Math.round(c.power), 'W') }));
    if (c.exceeded) b.appendChild(el('span', { class: 'fp-flag', text: 'devices read more than the circuit', title: 'A device is on a different circuit than recorded, or a CT is on the wrong wire.' }));
    b.onclick = () => openCircuit(c);
    return b;
  };
  /// The nodes that are panels or circuits — measuring a breaker, not a single thing plugged in.
  const circuitNodes = () => new Set        ([
    ...(live?.circuits || []).flatMap(c => [c.node, ...c.channels]).filter(Boolean)            ,
    ...ensure(flowIn(), 'Panels', []).map((p     ) => p.Node).filter(Boolean),
  ]);
  /// Breakers to pick a circuit from, grouped by panel. A branch circuit is never an unused slot, nor a breaker feeding a
  /// subpanel; those feeders are what a placed panel is fed from.
  const circuitChoices = (feeders         , current = '')           => {
    const panelNodes = new Set(ensure(flowIn(), 'Panels', []).map((p     ) => p.Node).filter(Boolean));
    const list = (live?.circuits || []).filter(c => c.state !== 'unused' && (feeders || !(c.node && panelNodes.has(c.node))));
    const out           = [{ value: '', label: '— not known yet —' }, ...list.map(c => ({
      value: c.ref, group: c.panelName, label: `${c.number}${c.description ? ' — ' + c.description : ''}`,
      hint: [c.amps ? `${c.amps} A` : '', c.power == null ? 'no data' : formatMeasure(Math.round(c.power), 'W')].filter(Boolean).join(' · '),
    }))];
    if (current && !out.some(c => c.value === current)) out.splice(1, 0, { value: current, label: `${current} (not a branch circuit in any panel)` });
    return out;
  };
  /// What can meter a single item: a smart plug, a PDU outlet, a sensor — never a panel, a breaker's channel, or a supply.
  const meterChoices = (current = '')           => {
    const skip = circuitNodes();
    const kinds                         = { outlet: 'PDU outlets', load: 'Loads', node: 'Other nodes', pdu: 'PDUs', device: 'Devices' };
    const list = (live?.nodes || []).filter(n => !['panel', 'breaker', 'grid', 'solar', 'battery', 'inverter', 'unmeasured'].includes(n.kind) && !skip.has(n.id));
    const out           = [{ value: '', label: '— not individually metered —' }, ...list.map(n => ({
      value: n.id, label: n.label, group: kinds[n.kind] || n.kind, hint: `${n.id} · ${fmt(n.value)}`,
    }))];
    if (current && !out.some(c => c.value === current)) out.splice(1, 0, { value: current, label: `${nodeLabel(current)} (${current})` });
    return out;
  };

  const drawSide = () => {
    side.innerHTML = '';
    const fl = floorNow();
    if (!fl) {
      side.appendChild(el('h3', { text: 'Start with a floor' }));
      side.appendChild(el('div', { class: 'desc', text: 'Add a site and its first floor, then draw its rooms or upload its plan. Rooms from your Version 2.0 room tags can be brought in under Tools.' }));
      const start = btn('Add a site and floor', 'primary');
      start.onclick = () => addSheet();
      side.appendChild(start);
      return;
    }
    if (imageFailed && imageFailed === fl.floor.Image)
      side.appendChild(el('div', { class: 'fp-note is-warn', text: 'This floor’s plan image could not be loaded, so it is drawn on a grid. Upload it again under Background.' }));
    (live?.problems || []).forEach(pr => side.appendChild(el('div', { class: 'fp-note is-warn', text: pr })));
    if (live?.message) side.appendChild(el('div', { class: 'fp-note', text: live.message }));
    if (selection) {
      const back = el('button', { class: 'fp-back', type: 'button', text: '‹ All rooms' });
      back.onclick = () => { selection = null; extra = []; selectedCorner = -1; render(); };
      side.appendChild(back);
    }
    const editing = mode === 'edit';
    if (extra.length) return drawMany(editing);
    if (selection?.type === 'item') return drawItem(itemOf(selection.id), editing);
    if (selection?.type === 'opening') return drawOpening(openingOf(selection.id), editing);
    if (selection?.type === 'run') return drawRun(runOf(selection.id), editing);
    if (selection && shapeOf(selection)) return drawShape(selection.type                   , shapeOf(selection), editing);
    drawFloorSummary(fl);
  };

  const drawFloorSummary = (fl     ) => {
    if (lastSolve.unmet.length) side.appendChild(el('div', { class: 'fp-note is-bad', text: `${lastSolve.unmet.length} constraint${lastSolve.unmet.length > 1 ? 's' : ''} cannot all hold: ${constraintsNow().filter(c => lastSolve.unmet.includes(c.Id)).map(describeConstraint).join('; ')}. Remove one, or unlock what it pulls against.` }));
    const fp = placeOf(fl.floor.Id), sp = placeOf(fl.site.Id);
    side.appendChild(el('h3', { text: fl.floor.Name || fl.floor.Id }));
    const { w, h } = floorSize();
    side.appendChild(el('div', { class: 'fp-id', text: `${len(w)} × ${len(h)} plot · ${fl.site.Name || fl.site.Id}` }));
    side.appendChild(valueLine(fp));
    if (sp) side.appendChild(row(fl.site.Name || fl.site.Id, sp.state === 'known' ? fmt(sp.value) : sp.state === 'unknown' ? 'no data' : 'unmetered'));
    const list = el('div', { class: 'fp-list' });
    const undrawn        = [];
    [...roomsNow().map(r => [r.Outdoor ? 'zone' : 'room', r]), ...areasNow().map(a => ['area', a])].forEach(([type, s]     ) => {
      if ((s.Shape || []).length < 3 && type !== 'area') undrawn.push(s);
      const p = placeOf(s.Id);
      list.appendChild(listRow((s.Name || s.Id) + (type === 'area' ? ' (area)' : type === 'zone' ? ' (outdoor)' : ''),
        p?.state === 'known' ? fmt(p.value) : p?.state === 'unknown' ? 'no data' : 'unmetered',
        () => { selection = { type: type === 'area' ? 'area' : 'room', id: s.Id }; render(); }, 'is-' + (p?.state || 'unmetered')));
    });
    side.appendChild(el('h4', { text: 'Rooms and areas' }));
    side.appendChild(list.children.length ? list : el('div', { class: 'desc', text: 'No rooms yet. Choose Edit, then Room, and drag one out — or add one by its measurements.' }));
    if (undrawn.length) side.appendChild(el('div', { class: 'desc', text: `${undrawn.length} room${undrawn.length > 1 ? 's have' : ' has'} no outline yet: select one, then draw it.` }));
    const outside = itemsNow().filter((it     ) => !it.Room);
    if (outside.length) {
      side.appendChild(el('h4', { text: 'Outdoors' }));
      const ol = el('div', { class: 'fp-list' });
      outside.forEach((it     ) => ol.appendChild(listRow(itemName(it), it.Circuit ? refLabel(it.Circuit) : PLAN_SUPPLY_KINDS.includes(it.Kind) ? kindName(it.Kind) : 'circuit unknown',
        () => { selection = { type: 'item', id: it.Id }; render(); })));
      side.appendChild(ol);
    }
  };

  /// A constraint in words: what it holds, and between what.
  const refName = (r         ) => { const sh = shapeById(r.Room); const nm = sh?.Name || r.Room; return r.Corner != null ? `${nm} corner ${r.Corner + 1}` : `${nm} wall ${(r.Edge ?? 0) + 1}`; };
  const describeConstraint = (c                ) => {
    const [a, b] = c.Refs;
    switch (c.Kind) {
      case 'length': return `${refName(a)} fixed at ${len(Number(c.Value) || 0)}`;
      case 'angle': return `${refName(a)} at ${Math.round(Math.abs(Number(c.Value) || 0) * 10) / 10}°`;
      case 'horizontal': return `${refName(a)} level`;
      case 'vertical': return `${refName(a)} plumb`;
      case 'coincident': return `${refName(a)} on ${refName(b)}`;
      case 'colinear': return `${refName(a)} in line with ${refName(b)}`;
      case 'parallel': return `${refName(a)} parallel to ${refName(b)}`;
      case 'perpendicular': return `${refName(a)} square to ${refName(b)}`;
    }
    return c.Kind;
  };

  const drawShape = (type                 , s     , editing         ) => {
    const p = placeOf(s.Id);
    const name = el('input', { type: 'text', class: 'fp-name', value: s.Name || '' })                    ;
    name.placeholder = type === 'room' ? 'Kitchen' : 'Upstairs';
    name.onchange = () => act(() => { s.Name = name.value.trim() || s.Id; });
    side.appendChild(el('div', { class: 'fp-side-head' }, editing ? name : el('h3', { text: s.Name || s.Id }), el('span', { class: 'fp-pill', text: type === 'area' ? 'area' : s.Outdoor ? 'outdoor' : 'room' })));
    side.appendChild(el('div', { class: 'fp-id', text: s.Id }));
    side.appendChild(valueLine(p));

    const poly       = s.Shape || [];
    const held = !!s.Locked;
    if (editing) {
      // Locked, it cannot be moved, reshaped or deleted; the solver holds it still.
      const lock = el('button', { class: 'small fp-lock' + (held ? ' is-on' : ''), type: 'button', title: held ? 'Unlock it, so it can be changed again.' : 'Lock it in place.' }, fpToolIcon('lock'), held ? ' Locked' : ' Lock');
      lock.setAttribute('aria-pressed', String(held));
      lock.onclick = () => act(() => { if (s.Locked) delete s.Locked; else s.Locked = true; });
      side.appendChild(actions(lock));
    }
    /// A length typed for a wall keeps any length it is fixed at in step, then the rest of the plan follows.
    const settle = () => {
      const n = s.Shape.length;
      constraintsNow().forEach(c => {
        if (c.Kind !== 'length' || c.Refs[0]?.Room !== s.Id || c.Refs[0].Edge == null) return;
        const [i, j] = planEdgeCorners(s, c.Refs[0].Edge);
        if (i < n && j < n) c.Value = Math.round(Math.hypot(s.Shape[j].X - s.Shape[i].X, s.Shape[j].Y - s.Shape[i].Y) * 10) / 10;
      });
      solve(keysOf(s));
    };
    const lengthFix = (edge        ) => constraintsNow().find(c => c.Kind === 'length' && c.Refs[0]?.Room === s.Id && c.Refs[0].Edge === edge);
    if (poly.length >= 3) {
      side.appendChild(el('h4', { text: 'Size' }));
      side.appendChild(row('Floor area', areaText(poly)));
      if (editing && type === 'room' && planIsBox(poly)) {
        // A rectangle is sized by its inside measurements; its top-left corner stays put.
        const b = planBounds(poly);
        const setBox = (w        , h        ) => { if (held || (s.LockedWalls || []).length) { saidLocked(); render(); return; } act(() => { s.Shape = planClamp(planRect({ X: b.x, Y: b.y }, { X: b.x + w, Y: b.y + h }), floorSize().w, floorSize().h); settle(); }); };
        const wi = lenInput(b.w, w => setBox(w, b.h)), di = lenInput(b.h, h => setBox(b.w, h));
        if (held) { wi.disabled = true; di.disabled = true; }
        side.appendChild(el('div', { class: 'fp-two' }, field('Width', wi), field('Depth', di)));
      }
      side.appendChild(el('h4', { text: 'Walls' }));
      const walls = el('div', { class: 'fp-wall-list' });
      poly.forEach((a, i) => {
        const bpt = poly[(i + 1) % poly.length];
        const L = Math.hypot(bpt.X - a.X, bpt.Y - a.Y);
        const wallLocked = (s.LockedWalls || []).includes(i);
        if (!editing) { walls.appendChild(row(`Wall ${i + 1}`, len(L) + (wallLocked ? ' · locked' : '') + (lengthFix(i) ? ' · fixed' : ''))); return; }
        // Typing a wall's length moves the corner at its far end along the wall.
        const inp = lenInput(L, want => {
          if (held || cornerLocked(s, (i + 1) % poly.length)) { saidLocked(); render(); return; }
          act(() => {
            if (!L) return;
            const k = want / L;
            s.Shape[(i + 1) % poly.length] = { X: planRound(a.X + (bpt.X - a.X) * k), Y: planRound(a.Y + (bpt.Y - a.Y) * k) };
            const fix = lengthFix(i); if (fix) fix.Value = Math.round(want * 10) / 10;
            solve([`${s.Id}#${i}`, `${s.Id}#${(i + 1) % poly.length}`]);
          });
        });
        inp.disabled = held;
        const fixed = lengthFix(i);
        const fixBtn = el('button', { class: 'small fp-toggle' + (fixed ? ' is-on' : ''), type: 'button', text: 'Fix', title: fixed ? 'Let this wall’s length change again.' : 'Hold this wall at its length as the rest is edited.' });
        fixBtn.onclick = () => act(() => {
          const f = lengthFix(i);
          if (f) setConstraints(constraintsNow().filter(c => c !== f));
          else constraintsNow().push({ Id: freshIn(constraintsNow(), 'length'), Kind: 'length', Refs: [{ Room: s.Id, Edge: i }], Value: Math.round(L * 10) / 10 });
        });
        const lockBtn = el('button', { class: 'small fp-toggle' + (wallLocked ? ' is-on' : ''), type: 'button', title: wallLocked ? 'Unlock this wall.' : 'Lock this wall where it is: neither end moves.' }, fpToolIcon('lock'));
        lockBtn.setAttribute('aria-label', wallLocked ? 'Unlock wall' : 'Lock wall');
        lockBtn.setAttribute('aria-pressed', String(wallLocked));
        lockBtn.onclick = () => act(() => { const list = ensure(s, 'LockedWalls', []); const at = list.indexOf(i); if (at >= 0) list.splice(at, 1); else list.push(i); if (!list.length) delete s.LockedWalls; });
        walls.appendChild(el('div', { class: 'fp-wall-row' + (selectedCorner === i ? ' is-picked' : '') }, el('span', { class: 'fp-wall-k', text: `Wall ${i + 1}` }), inp, fixBtn, lockBtn));
      });
      side.appendChild(walls);
      if (editing) side.appendChild(el('div', { class: 'desc', text: 'Drag a wall’s middle dot to slide the wall; double-click it to add a corner. A corner shared with the next room moves in both — hold Alt to pull it apart.' }));
    }

    if (editing && type === 'room') {
      side.appendChild(el('div', { class: 'fp-two' },
        field('Kind', select([['room', 'Room'], ['outdoor', 'Outdoor zone']], s.Outdoor ? 'outdoor' : 'room', v => act(() => { s.Outdoor = v === 'outdoor'; if (s.Outdoor && !s.Surface) s.Surface = 'grass'; }))),
        field('Surface', select(PLAN_SURFACES, s.Surface || '', v => act(() => { s.Surface = v; })))));
      // The surface's own colour, or one chosen for it: the carpet, the tile, the paint.
      const colour = el('input', { type: 'color', class: 'fp-colour', value: s.SurfaceColor || (PLAN_SURFACE_COLOURS[s.Surface || ''] || ['#c8c8c8'])[0] })                    ;
      colour.title = 'The colour of its surface';
      colour.oninput = () => { s.SurfaceColor = colour.value; drawPlan(); };
      colour.onchange = () => { history.push(); s.SurfaceColor = colour.value; changed(); render(); };
      const reset = btn(s.Surface ? 'Its own colour' : 'No colour');
      reset.disabled = !s.SurfaceColor;
      reset.onclick = () => act(() => { delete s.SurfaceColor; });
      side.appendChild(field('Colour', el('div', { class: 'fp-colour-row' }, colour, reset), s.Surface ? 'Recolours the surface; its pattern stays.' : 'With a plain surface, fills the room.'));
    }

    // The constraints that hold this room, each removable.
    const mine = constraintsNow().filter(c => c.Refs.some(r => r.Room === s.Id));
    if (mine.length) {
      side.appendChild(el('h4', { text: 'Constraints' }));
      const cl2 = el('div', { class: 'fp-list' });
      mine.forEach(c => {
        const unmet = lastSolve.unmet.includes(c.Id);
        const rowEl = el('div', { class: 'fp-list-row is-static' + (unmet ? ' is-unmet' : '') }, el('span', { class: 'fp-list-name', text: describeConstraint(c) }),
          el('span', { class: 'fp-list-val' + (unmet ? ' is-nodata' : ''), text: unmet ? 'cannot hold' : 'holds' }));
        if (editing) {
          const x = el('button', { class: 'fp-chip-x', type: 'button', text: '×', title: 'Remove this constraint' });
          x.onclick = () => act(() => { setConstraints(constraintsNow().filter(k => k !== c)); });
          rowEl.appendChild(x);
        }
        cl2.appendChild(rowEl);
      });
      side.appendChild(cl2);
    }
    if (type === 'area') {
      const box = el('div', { class: 'fp-checks' });
      roomsNow().forEach(r => {
        const cb = el('input', { type: 'checkbox' })                    ;
        cb.checked = (s.Rooms || []).includes(r.Id);
        cb.disabled = !editing;
        cb.onchange = () => act(() => { const list = ensure(s, 'Rooms', []); const at = list.indexOf(r.Id); if (cb.checked && at < 0) list.push(r.Id); if (!cb.checked && at >= 0) list.splice(at, 1); });
        box.appendChild(el('label', { class: 'ld-inst' }, cb, ' ' + (r.Name || r.Id)));
      });
      side.appendChild(el('h4', { text: 'Takes in' }));
      side.appendChild(box.children.length ? box : el('div', { class: 'desc', text: 'No rooms on this floor yet.' }));
    }

    const circuits = circuitsFor(s.Id);
    side.appendChild(el('h4', { text: 'Circuits serving it' }));
    const cl = el('div', { class: 'fp-list' });
    circuits.forEach(c => cl.appendChild(circuitRow(c)));
    side.appendChild(circuits.length ? cl : el('div', { class: 'desc', text: 'No circuit is recorded as serving it. Tick the rooms a breaker serves from its circuit, or link what is placed here to a circuit.' }));

    const items = itemsIn().filter((it     ) => it.Room === s.Id || (type === 'area' && (s.Rooms || []).includes(it.Room)));
    const metered = (live?.nodes || []).filter(n => n.placed === s.Id && !items.some((it     ) => it.Node === n.id));
    side.appendChild(el('h4', { text: 'In it' }));
    const il = el('div', { class: 'fp-list' });
    items.forEach((it     ) => {
      const v = live?.placements[it.Id]?.value;
      il.appendChild(listRow(itemName(it), it.Node ? fmt(v) : it.Circuit ? refLabel(it.Circuit) : 'circuit unknown',
        () => { selection = { type: 'item', id: it.Id }; render(); }, it.Node && v == null ? 'is-nodata' : ''));
    });
    metered.forEach(n => il.appendChild(listRow(n.label, fmt(n.value), null)));
    side.appendChild(il.children.length ? il : el('div', { class: 'desc', text: 'Nothing placed or metered here yet.' }));

    // What it has been drawing: the same rollup at every moment in history.
    const trend = el('div', { class: 'fp-trend' });
    const trendBtn = btn('Show the last 24 hours');
    trendBtn.onclick = async () => {
      trend.innerHTML = '';
      trend.appendChild(el('div', { class: 'desc', text: 'Reading…' }));
      let r     ;
      try { r = await api(`/api/locations/series?location=${encodeURIComponent(s.Id)}&minutes=1440&step=900`, { method: 'POST', body: JSON.stringify({ EnergyFlow: flowIn() }) }); }
      catch (e     ) { r = { body: { ok: false, message: e?.message } }; }
      trend.innerHTML = '';
      if (!r.body?.ok) { trend.appendChild(el('div', { class: 'desc', text: r.body?.message || 'Could not read the history.' })); return; }
      const at           = r.body.at || [];
      trend.appendChild(sparkline({ values: r.body.values, color: 'var(--accent)', units: r.body.units || 'W', width: 300, height: 90, grid: true,
        at: (i        ) => at[i] ? new Date(at[i]).toLocaleString([], { hour: '2-digit', minute: '2-digit' }) : '' }));
    };
    side.append(el('h4', { text: 'Trend' }), trendBtn, trend);

    if (editing) {
      const redraw = btn(poly.length >= 3 ? 'Redraw outline' : 'Draw outline', poly.length >= 3 ? '' : 'primary');
      redraw.onclick = () => {
        if (poly.length >= 3 && !confirm('Draw a new outline for it? The current one is replaced.')) return;
        if (s.Locked) { saidLocked(); return; }
        act(() => { s.Shape = []; setConstraints(planRefsWithout(constraintsNow(), s.Id)); });
        tool = type === 'area' ? 'area' : s.Outdoor ? 'zone' : 'room';
        render();
      };
      const btns = [redraw];
      if (selectedCorner >= 0 && poly.length > 3) {
        side.appendChild(el('div', { class: 'desc', text: 'Double-click a corner to remove it, or drag a small dot to add one.' }));
        const dropCorner = btn('Remove corner');
        dropCorner.onclick = () => act(() => { s.Shape.splice(selectedCorner, 1); selectedCorner = -1; });
        btns.push(dropCorner);
      }
      if (type === 'room' && poly.length >= 3) { const copy = btn('Duplicate'); copy.title = 'A copy beside it (Ctrl+D).'; copy.onclick = () => duplicate(); btns.push(copy); }
      const del = btn('Delete', 'danger');
      del.onclick = () => deleteSelection();
      btns.push(del);
      side.appendChild(actions(...btns));
    }
  };

  const drawItem = (it     , editing         ) => {
    if (!it) { selection = null; return drawSide(); }
    const supply = PLAN_SUPPLY_KINDS.includes(it.Kind);
    side.appendChild(el('div', { class: 'fp-side-head' }, el('h3', { text: itemName(it) }), el('span', { class: 'fp-pill', text: kindName(it.Kind) })));
    const where = it.Room ? nameOfPlace(it.Room) : 'Outdoors';
    if (editing) {
      const lbl = el('input', { type: 'text', class: 'fp-name', value: it.Label || '', placeholder: 'e.g. Fridge, Porch light, Desk outlet' })                    ;
      lbl.onchange = () => act(() => { it.Label = lbl.value.trim(); });
      const rooms                     = [['', 'Outdoors / not in a room'], ...roomsNow().map(r => [r.Id, (r.Name || r.Id) + (r.Outdoor ? ' (outdoor)' : '')]                    )];
      side.append(field('Label', lbl),
        el('div', { class: 'fp-two' },
          field('Kind', select(PLAN_KINDS.map(k => [k[0], k[1]]                    ), it.Kind || 'outlet', v => act(() => { it.Kind = v; }))),
          field('Where', select(rooms, it.Room || '', v => act(() => { it.Room = v; it.Floor = floorNow() .floor.Id; })))));
      if (it.Kind === 'panel') {
        const panels                     = [['', '— which panel? —'], ...ensure(flowIn(), 'Panels', []).map((p     ) => [p.Id, p.Name || p.Id]                    )];
        side.appendChild(field('Panel', select(panels, it.Panel || '', v => act(() => { it.Panel = v; })), 'The panel in the Panel Schedule this is. Wires drawn from it can carry its circuits.'));
      }
      if (!supply || it.Kind === 'panel') {
        side.appendChild(field(it.Kind === 'panel' ? 'Fed from' : 'Circuit', searchSelect(circuitChoices(it.Kind === 'panel', it.Circuit || ''), it.Circuit || '', v => { act(() => { it.Circuit = v; }); offerBeneath(it); }, { placeholder: 'Search by breaker, description or panel…' }),
          it.Kind === 'panel' ? 'For a subpanel: the breaker feeding it.' : 'The breaker feeding it. Unknown is fine — trace it below, or wire it to something on a known circuit.'));
      }
      if (it.Kind === 'outlet') {
        const g = el('input', { type: 'checkbox' })                    ;
        g.checked = !!it.Gfci;
        g.onchange = () => act(() => { if (g.checked) it.Gfci = true; else delete it.Gfci; });
        side.appendChild(el('label', { class: 'ld-inst fp-check', title: 'Whatever is wired from its load side is protected by it.' }, g, ' GFCI outlet'));
      }
      side.appendChild(field('Metered by', searchSelect(meterChoices(it.Node || ''), it.Node || '', v => { act(() => { it.Node = v; }); offerBeneath(it); }, { placeholder: 'Search meters by name or id…' }),
        'A smart plug, CT, ESPHome sensor, PDU outlet or anything else reading this alone.'));
      // Its real size: width and depth, which way it is turned, and whether it is round.
      const inch = 0.0254 * scale();
      const looks = select([['', isSized(it) ? '— its own size —' : '— an icon —'], ...PLAN_FOOTPRINTS.map(f => [f[0], f[1]]                    )], '', v => {
        const fp = PLAN_FOOTPRINTS.find(f => f[0] === v);
        if (!fp) return;
        act(() => {
          it.Width = planRound(fp[3] * inch); it.Depth = planRound(fp[4] * inch); it.Footprint = fp[0];
          if (fp[5]) it.Round = true; else delete it.Round;
          if (!it.Label) it.Label = fp[1];
          if (it.Rotation == null) it.Rotation = 0;
        });
      });
      side.appendChild(field('Size', looks, isSized(it) ? 'Pick one to take its usual size, or set the size below.' : 'Draw it at its real size, as the appliance it is.'));
      if (isSized(it)) {
        const wIn = lenInput(Number(it.Width), v => act(() => { it.Width = planRound(v); if (it.Round) it.Depth = it.Width; }));
        const dIn = lenInput(Number(it.Depth), v => act(() => { it.Depth = planRound(v); }));
        side.appendChild(el('div', { class: 'fp-two' }, field(it.Round ? 'Across' : 'Width', wIn), ...(it.Round ? [] : [field('Depth', dIn)])));
        const turn = el('input', { type: 'number', class: 'fp-deg', value: String(Math.round(Number(it.Rotation) || 0)), step: '15' })                    ;
        turn.onchange = () => act(() => { it.Rotation = (((Number(turn.value) || 0) % 360) + 360) % 360; });
        const r90 = btn('Turn 90°');
        r90.onclick = () => act(() => { it.Rotation = ((Number(it.Rotation) || 0) + 90) % 360; });
        const round = el('input', { type: 'checkbox' })                    ;
        round.checked = !!it.Round;
        round.onchange = () => act(() => { if (round.checked) { it.Round = true; it.Depth = it.Width; } else delete it.Round; });
        const icon = btn('Draw as an icon');
        icon.onclick = () => act(() => { delete it.Width; delete it.Depth; delete it.Rotation; delete it.Round; delete it.Footprint; });
        side.appendChild(field('Turned', el('div', { class: 'fp-colour-row' }, turn, el('span', { class: 'fp-opts-note', text: '°' }), r90), 'Its front faces the room when it is dropped by a wall. Drag the knob above it to turn it, or its corner to size it.'));
        side.appendChild(el('div', { class: 'fp-colour-row' }, el('label', { class: 'ld-inst fp-check' }, round, ' Round'), icon));
      }
    } else {
      side.append(row('Where', where));
      if (!supply || it.Circuit) side.append(row('Circuit', it.Circuit ? refLabel(it.Circuit) : 'not known yet'));
      if (it.Kind === 'panel' && it.Panel) side.append(row('Panel', it.Panel));
      side.append(row('Metered by', it.Node ? nodeLabel(it.Node) : 'not metered'));
    }
    if (it.Node) side.appendChild(row('Reading', fmt(live?.placements[it.Id]?.value)));

    const c = it.Circuit ? circuitOf(it.Circuit) : null;
    if (c) { side.appendChild(el('h4', { text: it.Kind === 'panel' ? 'Fed from' : 'Its circuit' })); side.appendChild(circuitRow(c)); }
    else if (it.Circuit) side.appendChild(el('div', { class: 'fp-note is-warn', text: `${it.Circuit} is not a breaker in any panel, so its circuit reads as unknown.` }));
    if (c) {
      const on = itemsIn().filter((x     ) => x.Circuit === c.ref);
      const floors = new Set(on.map((x     ) => x.Floor).filter(Boolean));
      side.appendChild(el('div', { class: 'desc', text: `${on.length} item${on.length === 1 ? '' : 's'} and ${runsIn().filter((r     ) => r.Circuit === c.ref).length} wire${runsIn().filter((r     ) => r.Circuit === c.ref).length === 1 ? '' : 's'} on this circuit${floors.size > 1 ? `, across ${floors.size} floors` : ''} — highlighted on the plan.` }));
    }

    // A GFCI protects what is wired from its load side; anything downstream of one says which.
    if (it.Gfci) {
      const ds = planDownstream(runsIn(), it.Id);
      side.appendChild(el('h4', { text: 'Protects' }));
      if (!ds.items.size) side.appendChild(el('div', { class: 'desc', text: 'Nothing is wired from its load side yet. Draw a wire from this outlet to the ones it feeds; everything they lead to is protected.' }));
      else {
        const pl = el('div', { class: 'fp-list' });
        [...ds.items].map(id => itemOf(id)).filter(Boolean).forEach((x     ) => pl.appendChild(listRow(itemName(x), x.Room ? nameOfPlace(x.Room) : 'Outdoors',
          () => { if (x.Floor && x.Floor !== floorNow()?.floor.Id) { floorId = x.Floor; viewFor = ''; } selection = { type: 'item', id: x.Id }; extra = []; render(); })));
        side.appendChild(pl);
        side.appendChild(el('div', { class: 'desc', text: `${ds.items.size} downstream, shown in green on the plan. Tripping this GFCI cuts them all.` }));
      }
    } else {
      const by = planProtectedBy(runsIn(), (id        ) => !!itemOf(id)?.Gfci, it.Id);
      if (by) {
        const g = itemOf(by);
        side.appendChild(el('h4', { text: 'Protected by' }));
        side.appendChild(listRow(`GFCI ${itemName(g)}`, g.Room ? nameOfPlace(g.Room) : 'Outdoors', () => { if (g.Floor && g.Floor !== floorNow()?.floor.Id) { floorId = g.Floor; viewFor = ''; } selection = { type: 'item', id: g.Id }; extra = []; render(); }));
        side.appendChild(el('div', { class: 'desc', text: 'If this outlet is dead, check that GFCI for a trip before the breaker.' }));
      }
    }

    if (it.Kind === 'panel' && it.Panel) {
      const open = btn('Open its panel schedule');
      open.onclick = () => (Array.from(document.querySelectorAll('nav a'))         ).find(a => a.dataset.label === 'Panel Schedule')?.click();
      side.appendChild(actions(open));
    }
    const wired = runsIn().filter((r     ) => r.From === it.Id || r.To === it.Id);
    if (wired.length) {
      side.appendChild(el('h4', { text: 'Wired to' }));
      const wl = el('div', { class: 'fp-list' });
      wired.forEach((r     ) => {
        const other = r.From === it.Id ? r.To : r.From;
        wl.appendChild(listRow(other ? itemName(itemOf(other) || { Kind: '?' }) : 'a loose end', `${len(planPathLength(runPath(r)))} · ${r.Kind}`,
          () => { selection = { type: 'run', id: r.Id }; render(); }));
      });
      side.appendChild(wl);
    }

    const btns        = [];
    if (!supply) {
      const trace = btn(it.Circuit ? 'Trace again' : 'Trace its circuit', it.Circuit ? '' : 'primary');
      trace.title = 'Switch a load on this outlet on and off; the channel that follows is its circuit.';
      trace.onclick = () => traceItem(it);
      btns.push(trace);
    }
    if (editing) {
      const copy = btn('Duplicate');
      copy.title = 'A copy beside it (Ctrl+D).';
      copy.onclick = () => duplicate();
      btns.push(copy);
      const wire = btn('Wire from here');
      wire.title = 'Start a cable run at this item; tap the bends and then the item it goes to.';
      wire.onclick = () => { tool = 'wire'; wireDraft = { from: it.Id, pts: [] }; render(); };
      const del = btn('Delete', 'danger');
      del.onclick = () => deleteSelection();
      btns.push(wire, del);
    }
    side.appendChild(actions(...btns));
  };

  const drawOpening = (o     , editing         ) => {
    if (!o) { selection = null; return drawSide(); }
    side.appendChild(el('div', { class: 'fp-side-head' }, el('h3', { text: PLAN_OPENINGS.find(x => x[0] === o.Kind)?.[1] || 'Opening' })));
    if (!editing) { side.appendChild(row('Width', len(o.Width))); return; }
    side.append(
      el('div', { class: 'fp-two' },
        field('Kind', select(PLAN_OPENINGS, o.Kind || 'door', v => act(() => { o.Kind = v; }))),
        field('Width', lenInput(Number(o.Width) || 0, w => act(() => { o.Width = planRound(w); })))));
    if ((o.Kind || 'door') !== 'window' && o.Kind !== 'opening') {
      side.appendChild(el('div', { class: 'fp-two' },
        field('Hinges', select([['left', 'Left'], ['right', 'Right']], o.Swing || 'left', v => act(() => { o.Swing = v; }))),
        field('Opens', select([['in', 'This side'], ['out', 'Other side']], o.Flip ? 'out' : 'in', v => act(() => { o.Flip = v === 'out'; })))));
    }
    const copyOp = btn('Duplicate');
    copyOp.onclick = () => duplicate();
    const turn = btn('Rotate 90°');
    turn.onclick = () => act(() => { o.Angle = ((Number(o.Angle) || 0) + 90) % 360; });
    const del = btn('Delete', 'danger');
    del.onclick = () => deleteSelection();
    side.appendChild(actions(turn, copyOp, del));
    side.appendChild(el('div', { class: 'desc', text: 'Drag it along a wall to move it; it lines up with whichever wall it is dropped on.' }));
  };

  const drawRun = (r     , editing         ) => {
    if (!r) { selection = null; return drawSide(); }
    const from = r.From ? itemOf(r.From) : null, to = r.To ? itemOf(r.To) : null;
    side.appendChild(el('div', { class: 'fp-side-head' }, el('h3', { text: r.Label || `${r.Kind === 'service' ? 'Service' : r.Kind === 'feeder' ? 'Feeder' : 'Circuit'} run` }), el('span', { class: 'fp-pill', text: r.Kind })));
    side.appendChild(row('Supply side', from ? itemName(from) : 'a loose end'));
    side.appendChild(row('Load side', to ? itemName(to) : 'a loose end'));
    side.appendChild(row('Length on the plan', len(planPathLength(runPath(r)))));
    if (editing) {
      const note = el('input', { type: 'text', value: r.Label || '', placeholder: 'e.g. through the attic' })                    ;
      note.onchange = () => act(() => { r.Label = note.value.trim(); });
      side.append(field('Kind', select([['circuit', 'Branch circuit'], ['feeder', 'Feeder'], ['service', 'Utility service']], r.Kind || 'circuit', v => act(() => { r.Kind = v; }))),
        field('Circuit', searchSelect(circuitChoices(r.Kind === 'feeder', r.Circuit || ''), r.Circuit || '', v => act(() => {
          r.Circuit = v;
          // Both ends of a branch circuit are on it, unless one says otherwise already.
          [from, to].forEach(it => { if (v && it && !it.Circuit && !PLAN_SUPPLY_KINDS.includes(it.Kind)) it.Circuit = v; });
        }), { placeholder: 'Search circuits…' }), 'Setting it also puts either end with no circuit of its own on this one.'),
        field('Note', note));
      const flip = btn('Reverse direction');
      flip.title = 'Swap which end is the supply side. What is downstream of a GFCI follows this.';
      flip.onclick = () => act(() => { const f = r.From; r.From = r.To; r.To = f; r.Points = [...(r.Points || [])].reverse(); });
      const del = btn('Delete', 'danger');
      del.onclick = () => deleteSelection();
      const btns2 = [flip];
      if (selectedBend >= 0 && selectedBend < (r.Points || []).length) { const rb = btn('Remove bend'); rb.onclick = () => removeBend(); btns2.push(rb); }
      side.appendChild(actions(...btns2, del));
      side.appendChild(el('div', { class: 'desc', text: 'Double-click a bend to remove it.' }));
      side.appendChild(el('div', { class: 'desc', text: 'Drag a bend to move it; drag a small dot to add a bend.' }));
    } else if (r.Circuit) side.appendChild(row('Circuit', refLabel(r.Circuit)));
    const c = r.Circuit ? circuitOf(r.Circuit) : null;
    if (c) side.appendChild(circuitRow(c));
  };

  /// A copy of the selection beside it, selected: an item, a door or window, or a room with nothing in it.
  const duplicate = () => {
    if (!selection) return;
    const off = snapStep() * 4;
    const sel = selection;
    if (sel.type === 'item') {
      const it = itemOf(sel.id);
      if (!it) return;
      const id = freshIn(itemsIn(), String(it.Kind || 'item').replace(/-/g, '_'));
      act(() => { itemsIn().push({ ...JSON.parse(JSON.stringify(it)), Id: id, X: planRound(it.X + off), Y: planRound(it.Y + off), Node: '' }); selection = { type: 'item', id }; });
    } else if (sel.type === 'opening') {
      const o = openingOf(sel.id);
      if (!o) return;
      const id = freshIn(openingsNow(), String(o.Kind).replace(/-/g, '_'));
      const a = (Number(o.Angle) || 0) * Math.PI / 180;
      const step = Number(o.Width) * 1.5;
      act(() => { openingsNow().push({ ...o, Id: id, X: planRound(o.X + Math.cos(a) * step), Y: planRound(o.Y + Math.sin(a) * step) }); selection = { type: 'opening', id }; });
    } else if (sel.type === 'room') {
      const r = shapeOf(sel);
      if (!r) return;
      const nm = `${r.Name || r.Id} copy`;
      const id = freshId(nm);
      const b = planBounds(r.Shape || []);
      act(() => { roomsNow().push({ ...JSON.parse(JSON.stringify(r)), Id: id, Name: nm, HaArea: '', Shape: planClamp(planMove(r.Shape, b.w, 0), floorSize().w, floorSize().h) }); selection = { type: 'room', id }; });
    }
  };

  /// Take out the selected corner of a room or area; an outline keeps at least three.
  const removeCorner = () => {
    const sh = extra.length ? null : shapeOf(selection);
    if (!sh || selectedCorner < 0 || selectedCorner >= (sh.Shape || []).length) return false;
    if (cornerLocked(sh, selectedCorner)) { saidLocked(); return true; }
    if (sh.Shape.length <= 3) { toast('An outline needs at least three corners.', false); return true; }
    const at = selectedCorner, count = sh.Shape.length;
    act(() => {
      sh.Shape.splice(at, 1); selectedCorner = -1;
      setConstraints(planRefsAfterRemove(constraintsNow(), sh.Id, at, count));
      sh.LockedWalls = (sh.LockedWalls || []).filter((e        ) => e !== at && e !== (at - 1 + count) % count).map((e        ) => e > at ? e - 1 : e);
      solve();
    });
    return true;
  };
  /// A corner in the middle of a wall, so the wall can bend there.
  const insertCorner = (edge        ) => {
    const sh = extra.length ? null : shapeOf(selection);
    if (!sh) return;
    if (sh.Locked || (sh.LockedWalls || []).includes(edge)) { saidLocked(); return; }
    const [i, j] = planEdgeCorners(sh, edge);
    act(() => {
      sh.Shape.splice(i + 1, 0, { X: planRound((sh.Shape[i].X + sh.Shape[j].X) / 2), Y: planRound((sh.Shape[i].Y + sh.Shape[j].Y) / 2) });
      planRefsAfterInsert(constraintsNow(), sh.Id, i + 1);
      sh.LockedWalls = (sh.LockedWalls || []).map((e        ) => e > edge ? e + 1 : e);
      selectedCorner = i + 1;
    });
  };
  /// Take out the selected bend of a wire; its path joins straight across.
  const removeBend = () => {
    const r = !extra.length && selection?.type === 'run' ? runOf(selection.id) : null;
    if (!r || selectedBend < 0 || selectedBend >= (r.Points || []).length) return false;
    if ((r.From ? 1 : 0) + (r.To ? 1 : 0) + r.Points.length <= 2) { toast('A wire needs two ends.', false); return true; }
    const at = selectedBend;
    act(() => { r.Points.splice(at, 1); selectedBend = -1; });
    return true;
  };

  /// Remove everything selected in one undoable step. A room's items stay, outdoors; a wire to a removed item keeps its path.
  const deleteSelection = () => {
    const chosen = selected();
    if (!chosen.length) return;
    const all = chosen.filter(x => !((x.type === 'room' || x.type === 'area') && shapeOf(x)?.Locked));
    if (all.length < chosen.length) toast('Locked rooms and areas stay; unlock them to delete them.', false);
    if (!all.length) return;
    const rooms = all.filter(x => x.type === 'room').map(x => shapeOf(x)).filter(Boolean);
    const inRooms = itemsIn().filter((it     ) => rooms.some((r     ) => r.Id === it.Room) && !all.some(x => x.type === 'item' && x.id === it.Id)).length;
    if (inRooms && !confirm(`Delete ${all.length === 1 ? (rooms[0].Name || rooms[0].Id) : `${all.length} things`}? ${inRooms} item(s) in ${rooms.length > 1 ? 'those rooms' : 'it'} stay on the plan, outdoors.`)) return;
    act(() => {
      all.forEach(x => {
        if (x.type === 'item') {
          const it = itemOf(x.id);
          if (!it) return;
          itemsIn().splice(itemsIn().indexOf(it), 1);
          runsIn().forEach((r     ) => { if (r.From === it.Id) { ensure(r, 'Points', []).unshift({ X: it.X, Y: it.Y }); r.From = ''; } if (r.To === it.Id) { ensure(r, 'Points', []).push({ X: it.X, Y: it.Y }); r.To = ''; } });
        } else if (x.type === 'opening') { const o = openingOf(x.id); if (o) openingsNow().splice(openingsNow().indexOf(o), 1); }
        else if (x.type === 'run') { const r = runOf(x.id); if (r) runsIn().splice(runsIn().indexOf(r), 1); }
        else {
          const sh = shapeOf(x);
          if (!sh || sh.Locked) return;
          setConstraints(planRefsWithout(constraintsNow(), sh.Id));
          const list = x.type === 'room' ? roomsNow() : areasNow();
          list.splice(list.indexOf(sh), 1);
          if (x.type === 'room') { itemsIn().forEach((it     ) => { if (it.Room === sh.Id) { it.Room = ''; it.Floor = floorNow() .floor.Id; } }); areasNow().forEach(ar => { ar.Rooms = (ar.Rooms || []).filter((id        ) => id !== sh.Id); }); }
        }
      });
      selection = null; extra = [];
    });
    if (all.length > 1 || rooms.length) toast(`Deleted${all.length > 1 ? ` ${all.length} things` : ''}. Ctrl+Z brings ${all.length > 1 ? 'them' : 'it'} back.`, true);
  };

  /// What a selection of several things says: how many of each, and what can be done to them all at once.
  const drawMany = (editing         ) => {
    const all = selected();
    const count = (t         ) => all.filter(x => x.type === t).length;
    const words = ([['room', 'room', 'rooms'], ['area', 'area', 'areas'], ['item', 'item', 'items'], ['opening', 'door or window', 'doors and windows'], ['run', 'wire', 'wires']]                               )
      .map(([t, one, many]) => { const n = count(t); return n ? `${n} ${n > 1 ? many : one}` : ''; }).filter(Boolean);
    side.appendChild(el('div', { class: 'fp-side-head' }, el('h3', { text: `${all.length} selected` })));
    side.appendChild(el('div', { class: 'desc', text: words.join(', ') + '. Drag any of them to move them all; arrow keys nudge them; Shift-click adds or removes one.' }));
    const items = all.filter(x => x.type === 'item').map(x => itemOf(x.id)).filter((it     ) => it && !PLAN_SUPPLY_KINDS.includes(it.Kind));
    if (editing && items.length) {
      const same = items.every((it     ) => (it.Circuit || '') === (items[0].Circuit || '')) ? items[0].Circuit || '' : '__mixed';
      const choices = [...(same === '__mixed' ? [{ value: '__mixed', label: '— several circuits —' }] : []), ...circuitChoices(false)];
      side.appendChild(field(`Circuit for the ${items.length} item${items.length > 1 ? 's' : ''}`, searchSelect(choices, same, v => {
        if (v === '__mixed') return;
        act(() => items.forEach((it     ) => { it.Circuit = v; }));
      }, { placeholder: 'Search circuits…' }), 'Puts every selected outlet, light and device on one breaker.'));
    }
    const btns        = [];
    if (editing) {
      const del = btn(`Delete ${all.length}`, 'danger');
      del.onclick = () => deleteSelection();
      btns.push(del);
    }
    const none = btn('Select none');
    none.onclick = () => { selection = null; extra = []; render(); };
    btns.push(none);
    side.appendChild(actions(...btns));
  };

  /// A metered device on a known circuit belongs beneath that circuit in the energy flow; moving it is offered, never done quietly.
  const offerBeneath = (it     ) => {
    const c = it.Circuit ? circuitOf(it.Circuit) : null;
    if (!it.Node || !c?.node || it.Node === c.node) return;
    const links        = ensure(flowIn(), 'Links', []);
    const feeders = links.filter(l => l.To === it.Node).map(l => String(l.From));
    if (feeders.length === 1 && feeders[0] === c.node) return;
    const from = feeders.length ? `It is fed by ${feeders.map(nodeLabel).join(', ')} now; that link is replaced.` : 'Nothing feeds it in the energy flow yet.';
    if (!confirm(`Place ${nodeLabel(it.Node)} beneath ${circuitLabel(c)} (${nodeLabel(c.node)}) in the energy flow?\n\n${from}\n\nCancel leaves the energy flow as it is.`)) return;
    act(() => {
      for (let i = links.length - 1; i >= 0; i--) if (links[i].To === it.Node) links.splice(i, 1);
      links.push({ From: c.node, To: it.Node });
    });
    toast('Placed beneath its circuit. Press Save to keep it.', true);
  };

  // --- Circuit sheet (#464, #465) --------------------------------------------------------------------
  const openCircuit = (c         ) => {
    const panel = ensure(flowIn(), 'Panels', []).find((p     ) => p.Id === c.panel);
    const breaker = panel ? ensure(panel, 'Breakers', []).find((b     ) => b.Number === c.number) : null;
    const body = el('div', { class: 'fp-sheet' });
    body.appendChild(row('Reading', c.power == null ? 'no data' : formatMeasure(Math.round(c.power), 'W') + (c.amps ? ` on a ${c.amps} A breaker` : '')));
    if (c.devices.length) {
      body.appendChild(el('h4', { text: 'Metered on it' }));
      c.devices.forEach(d => body.appendChild(row(d.label, d.value == null ? 'no data' : formatMeasure(Math.round(d.value), 'W'))));
      body.appendChild(row('Unmetered remainder', c.remainderState === 'known' ? formatMeasure(Math.round(c.remainder ), 'W') : 'unknown', c.remainderState === 'known' ? '' : 'is-nodata'));
      if (c.remainderState !== 'known') body.appendChild(el('div', { class: 'desc', text: c.power == null ? 'The circuit itself has no reading, so what is left over cannot be said.' : 'A device on it has no reading, so what is left over cannot be said.' }));
      if (c.exceeded) body.appendChild(el('div', { class: 'fp-note is-bad', text: 'What is metered on this circuit reads more than the circuit itself. A device is recorded against the wrong circuit, or the CT is on the wrong wire.' }));
    }
    // How much cable is drawn for it, floor by floor.
    const drawnRuns = runsIn().filter((r     ) => r.Circuit === c.ref);
    if (drawnRuns.length) {
      const byFloor = new Map                ();
      drawnRuns.forEach((r     ) => {
        const f = floorById(r.Floor)?.floor;
        const metres = planPathLength(runPath(r)) / Math.max(1, Number(f?.Scale) || 100);
        byFloor.set(f?.Name || r.Floor, (byFloor.get(f?.Name || r.Floor) || 0) + metres);
      });
      const total = [...byFloor.values()].reduce((a, v) => a + v, 0);
      body.appendChild(row('Cable drawn', `${planFmtLen(total, sys())} in ${drawnRuns.length} run${drawnRuns.length > 1 ? 's' : ''}` + (byFloor.size > 1 ? ` (${[...byFloor].map(([n, m]) => `${n} ${planFmtLen(m, sys())}`).join(', ')})` : '')));
    }
    // From a breaker, everything placed on its circuit, across rooms and floors.
    body.appendChild(el('h4', { text: 'Placed on it' }));
    const placed = itemsIn().filter((it     ) => it.Circuit === c.ref);
    if (!placed.length) body.appendChild(el('div', { class: 'desc', text: 'Nothing placed on the plan is linked to this circuit yet.' }));
    placed.forEach((it     ) => {
      const fl = floorsAll().find(x => onFloor(it, x.floor));
      const b = el('button', { class: 'fp-list-row', type: 'button' },
        el('span', { class: 'fp-list-name', text: it.Label || it.Kind }),
        el('span', { class: 'fp-list-val', text: [it.Room ? nameOfPlace(it.Room) : 'no room', fl ? fl.floor.Name || fl.floor.Id : ''].filter(Boolean).join(' · ') }));
      b.onclick = () => { closeSheet(); if (fl) { floorId = fl.floor.Id; viewFor = ''; } selection = { type: 'item', id: it.Id }; render(); };
      body.appendChild(b);
    });
    // Which rooms and areas the circuit serves: how a room finds the circuits serving it.
    if (breaker) {
      body.appendChild(el('h4', { text: 'Serves' }));
      const box = el('div', { class: 'fp-checks' });
      floorsAll().forEach(({ floor }) => [...ensure(floor, 'Rooms', []), ...ensure(floor, 'Areas', [])].forEach((r     ) => {
        const cb = el('input', { type: 'checkbox' })                    ;
        cb.checked = (breaker.Rooms || []).includes(r.Id);
        cb.onchange = () => act(() => { const list = ensure(breaker, 'Rooms', []); const at = list.indexOf(r.Id); if (cb.checked && at < 0) list.push(r.Id); if (!cb.checked && at >= 0) list.splice(at, 1); });
        box.appendChild(el('label', { class: 'ld-inst' }, cb, ` ${r.Name || r.Id}`, el('span', { class: 'fp-muted', text: ` · ${floor.Name || floor.Id}` })));
      }));
      body.appendChild(box.children.length ? box : el('div', { class: 'desc', text: 'No rooms yet.' }));
    }
    const toPanel = btn('Open in Panel Schedule');
    toPanel.onclick = () => { closeSheet(); (Array.from(document.querySelectorAll('nav a'))         ).find(a => a.dataset.label === 'Panel Schedule')?.click(); };
    openSheet({ title: circuitLabel(c), body, footer: [toPanel] });
  };

  // --- Trace from the outlet (#468) -----------------------------------------------------------------
  const traceItem = (it     ) => {

    const stages          = [];
    const labels                         = {};
    let busy = false;
    const body = el('div', { class: 'fp-sheet' });
    body.appendChild(el('div', { class: 'desc', text: `Plug a lamp or kettle into ${it.Label || 'this outlet'} (or switch the fixture), then use the button: switch it, tap, and repeat. The channel that follows every switch is the circuit.` }));
    const tap = el('button', { class: 'cf-tap', type: 'button' })                     ;
    const verdict = el('div', { class: 'cf-verdict' });
    const offer = el('div', { class: 'fp-actions' });
    body.append(tap, verdict, offer);

    const sample = async () => {
      const stage = stages[stages.length - 1];
      let r     ;
      try { r = await api('/api/flow'); } catch { return; }
      (r?.body?.ok ? r.body.nodes || [] : []).forEach((n     ) => {
        if (!n.id || String(n.id).includes('#') || typeof n.value !== 'number') return;
        if (!['breaker', 'outlet', 'load', 'node'].includes(n.kind || 'node')) return;
        labels[n.id] = n.label || n.id;
        stage.sum[n.id] = (stage.sum[n.id] || 0) + n.value;
        stage.n[n.id] = (stage.n[n.id] || 0) + 1;
      });
    };
    const levels = ()          => stages.filter(s => Object.keys(s.n).length).map(s => ({ on: s.on, mean: Object.fromEntries(Object.keys(s.sum).map(k => [k, s.sum[k] / s.n[k]])) }));
    const paint = () => {
      const next = !stages.length || stages[stages.length - 1].on ? 'OFF' : 'ON';
      tap.textContent = busy ? 'Reading channels…' : `Switch it ${next}, then tap`;
      tap.disabled = busy;
      const found = analyse(levels(), { labels });
      verdict.className = 'cf-verdict' + (found.done ? ' is-found' : '');
      verdict.textContent = stages.length ? found.verdict : 'Switch the load off, then tap to take the first reading.';
      offer.innerHTML = '';
      if (!found.done) return;
      const channels = found.found.map(f => f.node);
      const matches = (live?.circuits || []).filter(c => channels.some(ch => c.channels.includes(ch) || c.node === ch));
      if (!matches.length) {
        offer.appendChild(el('div', { class: 'desc', text: `${channels.map(ch => labels[ch] || ch).join(' and ')} is not mapped to a breaker yet. Map it in the Panel Schedule, then link this outlet.` }));
        return;
      }
      matches.forEach(c => {
        const b = btn(`Link to ${circuitLabel(c)}`, 'primary');
        b.onclick = () => { closeSheet(); act(() => { it.Circuit = c.ref; }); toast(`Linked to ${circuitLabel(c)}. Press Save to keep it.`, true); };
        offer.appendChild(b);
      });
    };
    tap.onclick = async () => {
      if (busy) return;
      busy = true;
      stages.push({ on: stages.length ? !stages[stages.length - 1].on : false, sum: {}, n: {} });
      paint();
      await sample();
      setTimeout(async () => { await sample(); busy = false; paint(); }, 3000);
    };
    openSheet({ title: `Trace ${it.Label || it.Kind}`, body });
    paint();
  };

  // --- Sheets: floors, background, tools -----------------------------------------------------------
  const addSheet = () => {
    const body = el('div', { class: 'fp-sheet' });
    const siteName = el('input', { type: 'text', placeholder: 'Home' })                    ;
    const floorName = el('input', { type: 'text', placeholder: 'Ground floor' })                    ;
    const level = el('input', { type: 'number', value: '0', step: '1' })                    ;
    const siteSel = el('select', {})                     ;
    sitesIn().forEach((s     ) => siteSel.appendChild(el('option', { value: s.Id, text: s.Name || s.Id })));
    siteSel.appendChild(el('option', { value: '__new', text: '+ a new site' }));
    siteSel.value = floorNow()?.site.Id || (sitesIn()[0]?.Id ?? '__new');
    const siteRow = field('New site name', siteName);
    const sync = () => { siteRow.hidden = siteSel.value !== '__new'; };
    siteSel.onchange = sync;
    sync();
    const plot = planDefaultPlot(sys());
    let wU = plot.w * 100, hU = plot.h * 100;
    const wIn = el('input', { type: 'text', class: 'fp-len', value: planFmtLen(plot.w, sys()) })                    ;
    const hIn = el('input', { type: 'text', class: 'fp-len', value: planFmtLen(plot.h, sys()) })                    ;
    const read = () => { const w = planParseLen(wIn.value, sys()), h = planParseLen(hIn.value, sys()); if (w) wU = w * 100; if (h) hU = h * 100; };
    body.append(field('Site', siteSel), siteRow, field('Floor name', floorName), field('Level', level, '0 is the ground floor, 1 the one above, −1 a basement.'),
      el('div', { class: 'fp-two' }, field('Plot width', wIn), field('Plot depth', hIn)),
      el('div', { class: 'desc', text: 'The whole lot you want to draw on, yard included. Upload a plan image afterwards, or draw on the grid.' }));
    const add = btn('Add floor', 'primary');
    add.onclick = () => {
      read();
      const nm = floorName.value.trim();
      act(() => {
        let site = sitesIn().find((s     ) => s.Id === siteSel.value);
        if (!site) {
          const sn = siteName.value.trim() || 'Home';
          site = { Id: freshId(sn), Name: sn, Floors: [] };
          sitesIn().push(site);
        }
        const fname = nm || `Floor ${ensure(site, 'Floors', []).length + 1}`;
        const f = { Id: freshId(fname), Name: fname, Level: Number(level.value) || 0, Width: Math.round(wU), Height: Math.round(hU), Scale: 100, Image: '', Ground: '', Rooms: [], Areas: [], Openings: [] };
        site.Floors.push(f);
        floorId = f.Id; remember('floor', floorId); viewFor = '';
        mode = 'edit'; tool = 'room';
      });
      closeSheet();
      toast('Floor added. Drag out rooms, add one by size, or upload the plan under Background. Press Save to keep it.', true);
    };
    openSheet({ title: 'Add a floor', body, footer: [add] });
  };
  addBtn.onclick = addSheet;

  const floorSheet = () => {
    const fl = floorNow();
    if (!fl) return addSheet();
    const f = fl.floor;
    const body = el('div', { class: 'fp-sheet' });
    const name = el('input', { type: 'text', value: f.Name || '' })                    ;
    name.onchange = () => act(() => { f.Name = name.value.trim() || f.Id; });
    const siteName = el('input', { type: 'text', value: fl.site.Name || '' })                    ;
    siteName.onchange = () => act(() => { fl.site.Name = siteName.value.trim() || fl.site.Id; });
    const level = el('input', { type: 'number', value: String(f.Level ?? 0), step: '1' })                    ;
    level.onchange = () => act(() => { f.Level = Number(level.value) || 0; });
    const { w, h } = floorSize();
    body.append(el('div', { class: 'fp-two' }, field('Floor name', name), field('Site name', siteName)), field('Level', level),
      el('div', { class: 'fp-two' },
        field('Plot width', lenInput(w, v => act(() => { f.Width = Math.max(100, Math.round(v)); viewFor = ''; }))),
        field('Plot depth', lenInput(h, v => act(() => { f.Height = Math.max(100, Math.round(v)); viewFor = ''; })))),
      field('Ground', select(PLAN_GROUNDS, f.Ground || '', v => act(() => { f.Ground = v; })), 'What is drawn around the rooms: a lawn, a slab, gravel.'),
      el('h4', { text: 'Arrange' }),
      actions(
        (() => { const b = btn('Centre the drawing'); b.title = 'Move everything drawn on this floor to the middle of the plot.'; b.onclick = () => { arrange('centre'); closeSheet(); }; return b; })(),
        (() => { const b = btn('Fit the plot to the drawing'); b.title = 'Shrink or grow the plot to what is drawn, with a margin all round.'; b.onclick = () => { arrange('fit'); closeSheet(); }; return b; })()),
      el('div', { class: 'desc', text: 'The plot\u2019s edges can also be dragged in Edit with the Select tool.' }),
      el('div', { class: 'fp-id', text: `id ${f.Id} · ${fl.site.Name || fl.site.Id} · ${Math.round(scale() * 100) / 100} drawing units per metre` }));
    const del = btn('Delete floor', 'danger');
    del.onclick = () => {
      const rooms = ensure(f, 'Rooms', []).length;
      if (!confirm(`Delete ${f.Name || f.Id}${rooms ? ` and its ${rooms} room(s)` : ''}? What is placed on it goes too. Ctrl+Z brings it back.`)) return;
      act(() => {
        const items = itemsIn();
        for (let i = items.length - 1; i >= 0; i--) if (onFloor(items[i], f)) items.splice(i, 1);
        const runs = runsIn();
        for (let i = runs.length - 1; i >= 0; i--) if (runs[i].Floor === f.Id) runs.splice(i, 1);
        fl.site.Floors.splice(fl.site.Floors.indexOf(f), 1);
        floorId = ''; selection = null; viewFor = '';
      });
      closeSheet();
    };
    openSheet({ title: 'Floor settings', body, footer: [del] });
  };
  floorBtn.onclick = floorSheet;

  /// Put the drawing in the middle of its plot, or size the plot to the drawing with a margin.
  const arrange = (how                  ) => {
    const m = movable(everything());
    const box = boundsOf(m);
    const f = floorNow()?.floor;
    if (!box || !f) { toast('Nothing is drawn on this floor yet.', false); return; }
    act(() => {
      if (how === 'fit') {
        const margin = Math.round(1.5 * scale());
        f.Width = Math.max(100, Math.round(box.w + margin * 2));
        f.Height = Math.max(100, Math.round(box.h + margin * 2));
        shift(m, margin - box.x, margin - box.y);
      } else shift(m, (Number(f.Width) - box.w) / 2 - box.x, (Number(f.Height) - box.h) / 2 - box.y);
      viewFor = '';
    });
  };

  /// Upload a plan image for the floor on screen. With nothing drawn yet, the plot takes the image's proportions.
  const uploadImage = async (file      , say                     ) => {
    const fl = floorNow();
    if (!fl) { say('Add a floor first.'); return false; }
    const f = fl.floor;
    say('Preparing…');
    try {
      const prepared = await fpPrepareImage(file);
      say('Uploading…');
      const r = await fetch('/api/plans/images', { method: 'POST', headers: { 'Content-Type': prepared.type || 'application/octet-stream' }, body: prepared.blob });
      const b = await r.json().catch(() => ({}));
      if (!b.ok) { say(b.message || `Upload failed (${r.status}).`); toast(b.message || 'Upload failed.', false); return false; }
      const drawn = [...ensure(f, 'Rooms', []), ...ensure(f, 'Areas', [])].some((s     ) => (s.Shape || []).length >= 3) || itemsIn().some((it     ) => onFloor(it, f));
      act(() => {
        f.Image = b.id;
        imageFailed = '';
        if (!drawn && prepared.width && prepared.height) { f.Height = Math.max(100, Math.round((Number(f.Width) || 1000) * prepared.height / prepared.width)); viewFor = ''; }
      });
      say(drawn ? 'Uploaded. What is already drawn stays put; the image is fitted to the plot.' : 'Uploaded.');
      toast('Plan uploaded. Now set its scale: Edit › Measure, tap two points you know the distance between.', true);
      return true;
    } catch (e     ) { say(e?.message || 'Could not read that image.'); toast(e?.message || 'Could not read that image.', false); return false; }
  };

  const backgroundSheet = () => {
    const fl = floorNow();
    if (!fl) return addSheet();
    const f = fl.floor;
    const body = el('div', { class: 'fp-sheet' });
    const where = el('div', { class: 'desc', text: 'Checking where images are kept…' });
    api('/api/plans/storage').then((r     ) => { where.textContent = r.body?.ok ? `${r.body.limits} Kept in ${r.body.where}, never in the configuration. A large photo is shrunk here before it is sent.` : 'Plan storage is not reachable.'; }).catch(() => { where.textContent = 'Plan storage is not reachable.'; });
    const upStatus = el('div', { class: 'desc fp-up-status' });
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,.svg,image/*', class: 'fp-file' })                    ;
    file.onchange = async () => { const picked = file.files?.[0]; if (picked && await uploadImage(picked, t => { upStatus.textContent = t; })) closeSheet(); };
    const choose = btn(f.Image ? 'Replace image…' : 'Choose an image…', 'primary');
    choose.onclick = () => file.click();
    const drop = el('div', { class: 'fp-drop' }, el('div', { text: 'Drop a floor plan, a photo of one, or a screenshot here' }), choose, file);
    drop.addEventListener('dragover', (e     ) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', async (e     ) => { e.preventDefault(); drop.classList.remove('is-over'); const picked = e.dataTransfer?.files?.[0]; if (picked && await uploadImage(picked, t => { upStatus.textContent = t; })) closeSheet(); });
    body.append(drop, upStatus, where);
    if (f.Image) {
      body.appendChild(el('img', { class: 'fp-thumb', src: `/api/plans/images/${encodeURIComponent(f.Image)}`, alt: 'The current plan image' }));
      const opacity = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(f.ImageOpacity ?? 0.85) })                    ;
      opacity.oninput = () => { f.ImageOpacity = Number(opacity.value); drawPlan(); };
      opacity.onchange = () => { history.push(); refreshDirty(); };
      const scaleBtn = btn('Set the scale…');
      scaleBtn.title = 'Measure a distance you know on the image — a wall, a doorway — and say how long it really is.';
      scaleBtn.onclick = () => { closeSheet(); pickTool('measure'); };
      const remove = btn('Remove image', 'danger');
      remove.onclick = () => { act(() => { f.Image = ''; }); closeSheet(); };
      body.append(field('How strongly it shows', opacity), actions(scaleBtn, remove));
    }
    openSheet({ title: 'Background image', body });
  };
  bgBtn.onclick = backgroundSheet;

  // Dropping an image anywhere on the plan uploads it for this floor.
  stage.addEventListener('dragover', (e     ) => { if (e.dataTransfer?.types?.includes?.('Files')) { e.preventDefault(); stage.classList.add('is-drop'); } });
  stage.addEventListener('dragleave', () => stage.classList.remove('is-drop'));
  stage.addEventListener('drop', (e     ) => {
    stage.classList.remove('is-drop');
    const picked = e.dataTransfer?.files?.[0];
    if (!picked) return;
    e.preventDefault();
    uploadImage(picked, t => { status.textContent = t; });
  });

  // --- Export and import ---------------------------------------------------------------------------
  const download = (blob      , name        ) => {
    const a      = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  };
  const asDataUrl = (b      ) => new Promise        ((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
  const imageAsDataUrl = async (id        ) => { try { const r = await fetch(`/api/plans/images/${encodeURIComponent(id)}`); return r.ok ? await asDataUrl(await r.blob()) : null; } catch { return null; } };
  const fileStem = () => String(floorNow()?.floor.Name || floorNow()?.floor.Id || 'floor').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'floor';
  /// The floor as a standalone SVG: the whole plot, no handles, every colour written out and the image embedded.
  const svgMarkup = async () => {
    const keep = { vb: { ...vb }, selection, extra, cPicks, mode };
    selection = null; extra = []; cPicks = []; mode = 'view';
    const { w, h } = floorSize();
    vb = { x: 0, y: 0, w, h };
    drawPlan();
    const clone      = svg.cloneNode(true);
    const from        = [svg, ...svg.querySelectorAll('*')], to        = [clone, ...clone.querySelectorAll('*')];
    const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity',
      'font-size', 'font-weight', 'font-family', 'font-style', 'text-anchor', 'dominant-baseline', 'paint-order'];
    from.forEach((node, i) => {
      const cs      = getComputedStyle(node);
      to[i].setAttribute('style', props.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';'));
    });
    clone.querySelectorAll('.fp-hit, .fp-handle, .fp-mid, .fp-plot-handle, .fp-marquee, .fp-pick, title').forEach((n     ) => n.remove());
    const img = clone.querySelector('image');
    const id = floorNow()?.floor.Image;
    if (img && id) { const data = await imageAsDataUrl(id); if (data) img.setAttribute('href', data); else img.remove(); }
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
    clone.setAttribute('width', String(Math.round(w)));
    clone.setAttribute('height', String(Math.round(h)));
    vb = keep.vb; selection = keep.selection; extra = keep.extra; cPicks = keep.cPicks; mode = keep.mode;
    drawPlan();
    return new XMLSerializer().serializeToString(clone);
  };
  const exportSvg = async () => download(new Blob([await svgMarkup()], { type: 'image/svg+xml' }), `${fileStem()}.svg`);
  const exportPng = async () => {
    const markup = await svgMarkup();
    const { w, h } = floorSize();
    const k = Math.min(4, 4096 / Math.max(w, h));
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
    const ctx = canvas.getContext('2d') ;
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(b => { if (b) download(b, `${fileStem()}.png`); else toast('Could not draw the picture.', false); }, 'image/png');
  };
  /// Every floor plan as one file: sites, floors, rooms, items and wiring, with the plan images inside it.
  const exportJson = async () => {
    const f = flowIn();
    const ids = [...new Set(floorsAll().map(x => x.floor.Image).filter(Boolean))]            ;
    const images                         = {};
    for (const id of ids) { const d = await imageAsDataUrl(id); if (d) images[id] = d; }
    const doc = { format: 'rpdu2mqtt-floorplans', version: 1, exported: new Date().toISOString(),
      Sites: f.Sites || [], Placements: f.Placements || [], Runs: f.Runs || [], AutoLocations: f.AutoLocations || [], Images: images };
    download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), 'floor-plans.json');
  };
  const importJson = async (file      ) => {
    let doc     ;
    try { doc = JSON.parse(await file.text()); } catch { toast('That file is not JSON.', false); return; }
    if (doc?.format !== 'rpdu2mqtt-floorplans' || !Array.isArray(doc.Sites)) { toast('That is not a floor plans export from this bridge.', false); return; }
    const floors = doc.Sites.reduce((n        , x     ) => n + (x.Floors || []).length, 0);
    if (!confirm(`Replace the floor plans here with the file's ${doc.Sites.length} site(s) and ${floors} floor(s), ${(doc.Placements || []).length} item(s) and ${(doc.Runs || []).length} wire(s)?\n\nCtrl+Z undoes it, and nothing is kept until you press Save.`)) return;
    let failed = 0;
    for (const [id, data] of Object.entries(doc.Images || {})) {
      try {
        const blob = await (await fetch(String(data))).blob();
        const r = await fetch('/api/plans/images', { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
        const b = await r.json().catch(() => ({}));
        if (!b.ok || b.id !== id) failed++;
      } catch { failed++; }
    }
    act(() => {
      const f = flowIn();
      f.Sites = doc.Sites; f.Placements = doc.Placements || []; f.Runs = doc.Runs || [];
      if (Array.isArray(doc.AutoLocations)) f.AutoLocations = doc.AutoLocations;
      floorId = ''; selection = null; extra = []; viewFor = '';
    });
    toast(failed ? `Imported, but ${failed} plan image(s) could not be stored.` : 'Imported. Press Save to keep it.', !failed);
  };
  const exportSheet = () => {
    const body = el('div', { class: 'fp-sheet' });
    const file = el('input', { type: 'file', accept: 'application/json,.json', class: 'fp-file' })                    ;
    file.onchange = async () => { const picked = file.files?.[0]; if (picked) { closeSheet(); await importJson(picked); } };
    const option = (label        , text        , fn           , primary = false) => {
      const b = btn(label, primary ? 'primary' : '');
      b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e     ) { toast(e?.message || 'Export failed.', false); } b.disabled = false; };
      return el('div', { class: 'fp-tool-row' }, b, el('div', { class: 'desc', text }));
    };
    body.append(
      option('This floor as SVG', 'A drawing that stays sharp at any size, with the plan image inside it.', exportSvg, true),
      option('This floor as PNG', 'A picture, for sharing or a document.', exportPng),
      option('All floor plans (JSON)', 'Every site, floor, room, item and wire, with the plan images inside — a backup you can import here or on another bridge.', exportJson),
      option('Import floor plans…', 'Replace the floor plans here with an exported file.', () => file.click()),
      file);
    openSheet({ title: 'Export', body });
  };
  exportBtn.onclick = exportSheet;

  const toolsSheet = () => {
    const body = el('div', { class: 'fp-sheet' });
    const tags = btn('Rooms from tags…');
    tags.onclick = () => migrateSheet();
    const ha = btn('Publish rooms to Home Assistant…');
    ha.onclick = () => haSheet();
    body.append(
      el('div', { class: 'fp-tool-row' }, tags, el('div', { class: 'desc', text: 'Turn Version 2.0 room and area tags into rooms, with a preview of what each becomes before anything is written.' })),
      el('div', { class: 'fp-tool-row' }, ha, el('div', { class: 'desc', text: 'Create or match a Home Assistant area for each room, and file this bridge’s devices in them.' })),
      el('h4', { text: 'Keys' }),
      el('div', { class: 'fp-keys' }, ...[
        ['Ctrl+Z / Ctrl+Y', 'undo / redo'], ['V H R P O A', 'select, pan, room, outline, outdoor, area'], ['D W I L M', 'door, window, item, wire, measure'],
        ['Delete', 'remove the selection'], ['Arrows', 'nudge; Shift for more'], ['Esc', 'stop drawing'], ['+ − 0', 'zoom in, out, fit'],
      ].map(([k, t]) => el('div', {}, el('kbd', { text: k }), ' ' + t))));
    openSheet({ title: 'Tools', body });
  };
  toolsBtn.onclick = toolsSheet;

  const migrateSheet = async () => {
    const body = el('div', { class: 'fp-sheet' });
    body.appendChild(el('div', { class: 'desc', text: 'Loading tags…' }));
    openSheet({ title: 'Rooms from tags', body, wide: true });
    let r     ;
    try { r = await api('/api/locations/migrate', { method: 'POST', body: JSON.stringify({ config: { EnergyFlow: flowIn() } }) }); }
    catch (e     ) { r = { body: { ok: false, message: e?.message } }; }
    body.innerHTML = '';
    if (!r.body?.ok) { body.appendChild(el('div', { class: 'desc', text: r.body?.message || 'Could not read the tags.' })); return; }
    const floors = floorsAll();
    if (!floors.length) { body.appendChild(el('div', { class: 'desc', text: 'Add a floor first: a new room needs a floor to go on.' })); return; }
    const tags        = r.body.tags || [];
    if (!tags.length) { body.appendChild(el('div', { class: 'desc', text: 'No tags are in use.' })); return; }
    body.appendChild(el('div', { class: 'desc', text: 'Choose what each tag becomes. Suggestions come from the words in the tag; nothing is written until you apply the preview.' }));
    const rows                                                                                                                         = [];
    const table = el('div', { class: 'fp-mig' });
    tags.forEach(t => {
      const as = el('select', {})                     ;
      [['skip', 'leave as a tag'], ['room', 'a new room'], ['area', 'a new area'], ['existing', 'an existing place']].forEach(([v, l]) => as.appendChild(el('option', { value: v, text: l })));
      as.value = t.suggest;
      const floor = el('select', {})                     ;
      floors.forEach(x => floor.appendChild(el('option', { value: x.floor.Id, text: `${x.site.Name || x.site.Id} › ${x.floor.Name || x.floor.Id}` })));
      floor.value = floorNow()?.floor.Id || floors[0].floor.Id;
      const place = el('select', {})                     ;
      floors.forEach(x => [...ensure(x.floor, 'Rooms', []), ...ensure(x.floor, 'Areas', [])].forEach((p     ) => place.appendChild(el('option', { value: p.Id, text: `${p.Name || p.Id} · ${x.floor.Name || x.floor.Id}` }))));
      const remove = el('input', { type: 'checkbox' })                    ;
      const sync = () => { floor.hidden = !['room', 'area'].includes(as.value); place.hidden = as.value !== 'existing'; remove.disabled = as.value === 'skip'; };
      as.onchange = sync; sync();
      table.appendChild(el('div', { class: 'fp-mig-row' }, el('span', { class: 'fp-mig-tag' }, el('b', { text: t.tag }), el('span', { class: 'fp-muted', text: ` ${t.count}×` })), as, floor, place,
        el('label', { class: 'ld-inst', title: 'Take the tag off once it is a location.' }, remove, ' remove tag')));
      rows.push({ tag: t.tag, as, floor, place, remove });
    });
    body.appendChild(table);
    const out = el('div', { class: 'fp-mig-plan' });
    body.appendChild(out);
    const mappings = () => rows.map(x => ({ tag: x.tag, as: x.as.value, floor: x.floor.value, location: x.place.value, removeTag: x.remove.checked }));
    let plan      = null;
    const preview = btn('Preview', 'primary');
    const apply = btn('Apply');
    apply.disabled = true;
    preview.onclick = async () => {
      out.innerHTML = '';
      const p      = await api('/api/locations/migrate', { method: 'POST', body: JSON.stringify({ config: { EnergyFlow: flowIn() }, mappings: mappings() }) }).catch(() => null);
      if (!p?.body?.ok) { out.appendChild(el('div', { class: 'desc', text: p?.body?.message || 'Could not plan it.' })); return; }
      plan = p.body.plan;
      const list = (title        , items          ) => { if (!items.length) return; out.appendChild(el('h4', { text: title })); const ul = el('ul', { class: 'fp-ul' }); items.forEach(s => ul.appendChild(el('li', { text: s }))); out.appendChild(ul); };
      list('Places created', plan.creates.map((c     ) => `${c.kind} ${c.name} (${c.id}) on ${nameOfPlace(c.floor)}, from tag ${c.tag}`));
      list('Nodes placed', plan.nodes.map((n     ) => `${nodeLabel(n.node)} → ${plan.creates.find((c     ) => c.id === n.location)?.name || nameOfPlace(n.location)}${n.note ? ' — ' + n.note : ''}`));
      list('Rules for derived nodes', plan.rules.map((x     ) => `${x.match} → ${plan.creates.find((c     ) => c.id === x.location)?.name || nameOfPlace(x.location)}`));
      list('Tags removed', plan.removeTags);
      list('Left alone', plan.skipped.map((s     ) => `${s.what}: ${s.why}`));
      if (!plan.creates.length && !plan.nodes.length && !plan.rules.length) out.appendChild(el('div', { class: 'desc', text: 'Nothing would change.' }));
      apply.disabled = !(plan.creates.length || plan.nodes.length || plan.rules.length || plan.removeTags.length);
    };
    apply.onclick = () => {
      if (!plan) return;
      history.push();
      plan.creates.forEach((c     ) => {
        const f = floorById(c.floor)?.floor;
        if (!f) return;
        if (c.kind === 'area') ensure(f, 'Areas', []).push({ Id: c.id, Name: c.name, Rooms: [], Shape: [] });
        else ensure(f, 'Rooms', []).push({ Id: c.id, Name: c.name, Shape: [] });
      });
      const nodes        = ensure(flowIn(), 'Nodes', []);
      plan.nodes.forEach((n     ) => { const cfg = nodes.find(x => x.Id === n.node); if (cfg) cfg.Location = n.location; });
      const rules        = ensure(flowIn(), 'AutoLocations', []);
      plan.rules.forEach((x     ) => rules.push({ Match: x.match, Location: x.location }));
      const gone = new Set((plan.removeTags            ).map(t => t.toLowerCase()));
      if (gone.size) {
        nodes.forEach(x => { if (Array.isArray(x.Tags)) x.Tags = x.Tags.filter((t        ) => !gone.has(String(t).toLowerCase())); });
        ensure(flowIn(), 'AutoTags', []).forEach((x     ) => { if (Array.isArray(x.Tags)) x.Tags = x.Tags.filter((t        ) => !gone.has(String(t).toLowerCase())); });
      }
      closeSheet();
      changed();
      toast(`Applied: ${plan.creates.length} place(s), ${plan.nodes.length} node(s), ${plan.rules.length} rule(s). New rooms have no outline yet — select each and draw it. Press Save to keep it.`, true);
      render();
    };
    body.appendChild(el('div', { class: 'fp-actions' }, preview, apply));
  };

  const haSheet = async () => {
    const body = el('div', { class: 'fp-sheet' });
    body.appendChild(el('div', { class: 'desc', text: 'Reading Home Assistant…' }));
    openSheet({ title: 'Rooms as Home Assistant areas', body, wide: true });
    const r      = await api('/api/ha/areas/preview', { method: 'POST', body: JSON.stringify({ EnergyFlow: flowIn() }) }).catch((e     ) => ({ body: { ok: false, message: e?.message } }));
    body.innerHTML = '';
    if (!r.body?.ok) { body.appendChild(el('div', { class: 'desc', text: `${r.body?.message || 'Could not reach Home Assistant.'} The URL and token are set under Home Assistant › Energy Dashboard.` })); return; }
    const plan = r.body.plan;
    const WORDS                         = { create: 'create', rename: 'rename', link: 'link', ok: 'no change', set: 'put in area', keep: 'left alone' };
    const table = (title        , rows       , cells                      ) => {
      if (!rows.length) return;
      body.appendChild(el('h4', { text: title }));
      const t = el('div', { class: 'fp-ha' });
      rows.forEach(x => t.appendChild(el('div', { class: 'fp-ha-row is-' + x.action }, ...cells(x).map(c => el('span', { text: c })))));
      body.appendChild(t);
    };
    table('Rooms', plan.rooms, (x     ) => [x.name, WORDS[x.action] || x.action, x.why]);
    table('Devices', plan.devices, (x     ) => [x.deviceName, WORDS[x.action] || x.action, x.why]);
    if (plan.leftAlone.length) body.appendChild(el('div', { class: 'desc', text: `Areas no room claims are left alone: ${plan.leftAlone.map((a     ) => a.name).join(', ')}. Removing a room never removes its area.` }));
    if (!plan.rooms.length) body.appendChild(el('div', { class: 'desc', text: 'There are no rooms to publish yet.' }));
    const changes = plan.rooms.filter((x     ) => x.action !== 'ok').length + plan.devices.filter((x     ) => x.action === 'set').length;
    const go = btn(changes ? `Apply ${changes} change${changes > 1 ? 's' : ''}` : 'Nothing to change', 'primary');
    go.disabled = !changes;
    go.onclick = async () => {
      go.disabled = true;
      const a      = await api('/api/ha/areas/apply', { method: 'POST', body: JSON.stringify({ EnergyFlow: flowIn() }) }).catch((e     ) => ({ body: { ok: false, message: e?.message } }));
      const linked = a.body?.linked || {};
      if (Object.keys(linked).length) history.push();
      floorsAll().forEach(({ floor }) => ensure(floor, 'Rooms', []).forEach((rm     ) => { if (linked[rm.Id]) rm.HaArea = linked[rm.Id]; }));
      if (Object.keys(linked).length) changed();
      closeSheet();
      toast((a.body?.message || 'Done.') + (Object.keys(linked).length ? ' Press Save to remember the links, so a rename updates the same area.' : ''), !!a.body?.ok);
    };
    body.appendChild(el('div', { class: 'fp-actions' }, go));
  };

  // --- Loading and rendering -----------------------------------------------------------------------
  let pending      = null;
  const schedule = () => { clearTimeout(pending); pending = setTimeout(load, 600); };
  const load = async () => {
    const q = period === 'now' ? '' : `?period=${period}`;
    let r     ;
    try { r = await api('/api/locations/resolve' + q, { method: 'POST', body: JSON.stringify({ EnergyFlow: flowIn() }) }); }
    catch (e     ) { r = { body: { ok: false, message: e?.message || 'the request failed' } }; }
    if (!r.body?.ok) { status.textContent = r.body?.message || 'Could not read the locations.'; live = null; }
    else {
      status.textContent = '';
      live = {
        places: Object.fromEntries((r.body.places || []).map((p       ) => [p.id, p])),
        nodes: r.body.nodes || [], circuits: r.body.circuits || [],
        placements: Object.fromEntries((r.body.placements || []).map((p     ) => [p.id, p])),
        units: r.body.units || 'W', problems: r.body.problems || [], message: r.body.message || null,
      };
    }
    if (!dragging) render();
  };

  const drawEmpty = () => {
    const fl = floorNow();
    empty.innerHTML = '';
    const bare = !!fl && !fl.floor.Image && !roomsNow().some(r => (r.Shape || []).length >= 3) && !itemsNow().length;
    // In Edit the tools say how to start, and the card would only sit over where you are drawing.
    empty.hidden = !!fl && (!bare || mode === 'edit');
    if (!fl) {
      const start = btn('Add a site and floor', 'primary');
      start.onclick = () => addSheet();
      empty.append(el('div', { class: 'fp-empty-title', text: 'No floors yet' }), el('div', { class: 'desc', text: 'A floor is the plot you draw on: rooms, the yard, and everything placed in them.' }), start);
      return;
    }
    if (!bare || mode === 'edit') return;
    const up = btn('Upload a plan image', 'primary');
    up.onclick = () => backgroundSheet();
    const draw = btn('Draw a room');
    draw.onclick = () => pickTool('room');
    const size = btn('Add a room by size');
    size.onclick = () => { pickTool('room'); roomBySize(false); };
    empty.append(el('div', { class: 'fp-empty-title', text: 'An empty floor' }),
      el('div', { class: 'desc', text: 'Drop a floor plan image here to trace over, or start drawing on the grid.' }), actions(up, draw, size));
  };

  const render = () => {
    const floors = floorsAll();
    floorSel.innerHTML = '';
    floors.forEach(x => floorSel.appendChild(el('option', { value: x.floor.Id, text: `${x.site.Name || x.site.Id} › ${x.floor.Name || x.floor.Id}` })));
    if (!floors.length) floorSel.appendChild(el('option', { value: '', text: 'no floors yet' }));
    const fl = floorNow();
    if (fl && fl.floor.Id !== floorId) floorId = fl.floor.Id;
    floorSel.value = floorId;
    floorSel.disabled = !floors.length;
    floorBtn.disabled = !fl;
    bgBtn.disabled = !fl;
    // Refit when the floor changes, or when something asks for it by clearing viewFor; never mid-edit.
    const key = fl ? fl.floor.Id : '';
    if (fl && viewFor !== key) { fit(); viewFor = key; }
    if (fl) stage.style.aspectRatio = `${Number(fl.floor.Width) || 1000} / ${Number(fl.floor.Height) || 700}`;
    stage.classList.toggle('is-empty', !fl);
    // Whether the constraints hold, read from a copy: opening a floor never moves anything.
    lastSolve = constraintsNow().length ? planSolve(JSON.parse(JSON.stringify(shapesNow())), constraintsNow(), new Set(), 0) : { worst: 0, unmet: [] };
    drawSub();
    drawPlan();
    drawSide();
    drawEmpty();
    drawBanner();
  };

  window.addEventListener('keydown', (e     ) => {
    if (!sec.classList.contains('active')) return;
    if (/INPUT|SELECT|TEXTAREA/.test(e.target?.tagName || '') || e.target?.isContentEditable) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = String(e.key || '');
    if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if (ctrl && (k === 'd' || k === 'D') && mode === 'edit' && selection) { e.preventDefault(); duplicate(); return; }
    if (ctrl && (k === 'a' || k === 'A') && mode === 'edit') {
      e.preventDefault();
      const all = everything();
      selection = all[0] || null; extra = all.slice(1); selectedCorner = -1;
      if (tool !== 'select') tool = 'select';
      render();
      return;
    }
    if (ctrl || e.altKey) return;
    if (k === 'Escape') {
      if (!menu.hidden) { closeMenu(); return; }
      if (draft.length || rectStart || wireDraft || measure) { draft = []; rectStart = null; rectEnd = null; wireDraft = null; measure = null; hover = null; render(); }
      else if (selection) { selection = null; extra = []; render(); }
      return;
    }
    if (k === 'Enter' && wireDraft) { finishWire(''); return; }
    if (k === 'Enter' && draft.length >= 3) { finishOutline(draft); return; }
    if (k === '+' || k === '=') { zoomAt(centre(), 1.4); return; }
    if (k === '-' || k === '_') { zoomAt(centre(), 1 / 1.4); return; }
    if (k === '0') { fit(); drawPlan(); return; }
    if (mode !== 'edit') return;
    // Delete takes out a selected corner or bend first, and the whole thing only when none is picked.
    if ((k === 'Delete' || k === 'Backspace') && selection) { e.preventDefault(); if (!removeCorner() && !removeBend()) deleteSelection(); return; }
    if (k.startsWith('Arrow') && selection) {
      e.preventDefault();
      const step = snapStep() * (e.shiftKey ? 10 : 1);
      let dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
      const m = movable(selected());
      const box = boundsOf(m);
      const { w, h } = floorSize();
      if (box) { dx = Math.max(-box.x, Math.min(w - box.x - box.w, dx)); dy = Math.max(-box.y, Math.min(h - box.y - box.h, dy)); }
      act(() => shift(m, dx, dy));
      return;
    }
    const byKey = FP_TOOLS.find(t => t[2].toLowerCase() === k.toLowerCase());
    if (byKey) { e.preventDefault(); pickTool(byKey[0]); }
  });

  // Holding Space turns any drag into a pan, as drawing programs do.
  window.addEventListener('keydown', (e     ) => {
    if (e.key !== ' ' || !sec.classList.contains('active') || /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target?.tagName || '')) return;
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; svg.classList.add('is-panning'); }
  });
  window.addEventListener('keyup', (e     ) => { if (e.key === ' ' && spaceDown) { spaceDown = false; svg.classList.remove('is-panning'); } });

  link.onclick = () => { activate(link, sec); render(); load(); readStorage(); };
  // The live view keeps up with the house while it is on screen.
  setInterval(() => { if (sec.classList.contains('active') && !dragging && mode === 'view' && period === 'now') load(); }, 10000);
  return { link, sec };
}

/// A picked file made ready to upload: a phone photo decoded upright and shrunk, anything else passed through.
async function fpPrepareImage(file      )                                                                       {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (isSvg) {
    const text = await file.text();
    const m = text.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
    return { blob: file, type: 'image/svg+xml', width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0 };
  }
  let bitmap     ;
  try { bitmap = await (window       ).createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('This browser cannot read that image. A HEIC photo needs converting to JPEG first, or set the camera to “Most Compatible”.'); }
  const MAX = 4000;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale);
  // A small PNG is line art worth keeping exact; a photo, or anything large, is re-encoded.
  if (scale === 1 && file.size < 3 * 1024 * 1024 && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    return { blob: file, type: file.type, width, height };
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d') .drawImage(bitmap, 0, 0, width, height);
  const blob       = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Could not encode the image.')), 'image/jpeg', 0.85));
  return { blob, type: 'image/jpeg', width, height };
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

  // What the export filter leaves out. Sync pushes what the MQTT export publishes, so a node the filter
  // drops never becomes an HA sensor and cannot be mapped — which on this page looked like the sync
  // quietly missing things, with nothing here even naming the filter.
  const filterBox = el('div', { style: { margin: '14px 0' } });
  const drawFilter = () => {
    filterBox.innerHTML = '';
    const flow = (state.data && state.data.EnergyFlow) || {};
    const f = flow.MqttExportTags || {};
    const inc           = f.Include || [];
    const exc           = f.Exclude || [];
    const nodes        = flow.Nodes || [];

    // Edited here rather than linked away to: this is the page where the consequence is visible, and the
    // filter has no home of its own — it is a field on the Configuration page among a hundred others.
    const editor = () => {
      const box = el('div', { style: { margin: '6px 0' } });
      const f2 = ensure(ensure(state.data, 'EnergyFlow', {}), 'MqttExportTags', {});
      const excArr = ensure(f2, 'Exclude', []);
      const row = el('div', { class: 'field' });
      row.appendChild(el('label', { text: 'Never export nodes tagged' }));
      row.appendChild(tagInput(excArr, { strict: true, onChange: drawFilter }));
      box.appendChild(row);
      box.appendChild(el('div', { class: 'desc', text:
        'Governs the whole MQTT export, which is how Home Assistant is fed — a node dropped here publishes '
        + 'no sensor at all. Prometheus and EmonCMS keep their own lists, so a node kept out of Home '
        + 'Assistant still reaches them. Save to apply.' }));
      if (!knownTags().length)
        box.appendChild(el('div', { class: 'desc', text: 'No tags defined yet — tag a node on the Nodes page first.' }));
      return box;
    };

    if (!inc.length && !exc.length) {
      filterBox.appendChild(el('h3', { text: 'What the export filter leaves out', style: { margin: '4px 0', fontSize: '15px' } }));
      filterBox.appendChild(el('div', { class: 'desc', text: 'Every node is exported — no tag filter is set.' }));
      filterBox.appendChild(editor());
      return;
    }

    // An untagged node fails a populated include list; a node carrying an excluded tag is always out.
    const tagsOf = (n     )           => n.Tags || [];
    const dropped = nodes.filter(n => {
      const t = tagsOf(n).map((x        ) => String(x).trim().toLowerCase());
      if (exc.some(e => t.includes(String(e).trim().toLowerCase()))) return true;
      return inc.length > 0 && !inc.some(i => t.includes(String(i).trim().toLowerCase()));
    });

    filterBox.appendChild(el('h3', { text: 'What the export filter leaves out', style: { margin: '4px 0', fontSize: '15px' } }));
    const line = el('div', { class: 'desc' });
    if (inc.length) line.appendChild(el('span', { text: `Only nodes tagged ${inc.join(', ')} are exported. ` }));
    if (exc.length) line.appendChild(el('span', { text: `Nodes tagged ${exc.join(', ')} are never exported.` }));
    filterBox.appendChild(line);
    filterBox.appendChild(editor());

    if (!dropped.length) {
      filterBox.appendChild(el('div', { class: 'desc', text: 'No configured node is currently excluded.' }));
    } else {
      filterBox.appendChild(el('div', { class: 'ov-note warn', style: { marginTop: '8px' } },
        el('span', { class: 'ov-alert-icon', text: '⚠' }),
        el('div', {},
          el('div', { class: 'ov-alert-title', text: `${dropped.length} node${dropped.length === 1 ? '' : 's'} will not reach Home Assistant` }),
          el('div', { class: 'desc', text: 'They publish no MQTT sensor, so Sync cannot map them and any entity they '
                                         + 'already created in Home Assistant is retired.' }),
          el('div', { style: { marginTop: '6px' } },
            ...dropped.map((n     ) => el('div', { class: 'desc', style: { margin: '1px 0' },
              text: `${n.Label || n.Id}  (${n.Id})${(n.Tags || []).length ? '  · ' + (n.Tags || []).join(', ') : '  · untagged'}` }))))));
    }

    // Derived PDU/outlet nodes carry no Tags of their own; their tags come from rules.
    const rules        = flow.AutoTags || [];
    if (rules.length)
      filterBox.appendChild(el('div', { class: 'desc', style: { marginTop: '6px' },
        text: `${rules.length} auto-tag rule${rules.length === 1 ? '' : 's'} also tag PDUs and outlets, so the filter `
            + 'applies to them too — they are not listed here because they come from what the bridge polls.' }));
  };
  drawFilter();
  sec.appendChild(filterBox);

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

// ── sections/pdu-tags.ts ────────────────────────────────────────
// PDU tags: default tags for every PDU and outlet, and each one's own, kept as the EnergyFlow tag rules.

/// A tag box for the rule whose pattern is exactly `match`; the rule exists only while it carries a tag.
function ruleTags(match        ) {
  const rules = () => ensure(ensure(state.data, 'EnergyFlow', {}), 'AutoTags', []);
  const find = () => rules().find((x     ) => String(x.Match || '').trim().toLowerCase() === match.toLowerCase());
  const arr           = [...(find()?.Tags || [])];
  return tagInput(arr, {
    placeholder: 'add tag',
    onChange: () => {
      const list = rules();
      const rule = find();
      if (!arr.length) { if (rule) list.splice(list.indexOf(rule), 1); }
      else if (rule) rule.Tags = [...arr];
      else list.push({ Match: match, Tags: [...arr] });
      refreshDirty();
    },
  });
}

/// The tags panel for the PDU page, and the load that reads the discovered PDUs and outlets into it.
function renderPduTags()                                                 {
  const box = el('div', { class: 'pdu-tags', style: { margin: '18px 0' } });
  let graph      = null;

  const draw = () => {
    box.innerHTML = '';
    box.appendChild(el('h3', { text: 'Tags', style: { margin: '4px 0', fontSize: '15px' } }));
    box.appendChild(el('div', { class: 'desc', text:
      'Tags for what the PDUs report. Every PDU and every outlet can carry default tags, and each one its own '
      + 'on top of them. Patterns covering part of a PDU are on the Nodes page, and every tag is listed on the '
      + 'Tags page. Circuits are not nodes in the energy flow, so they cannot carry tags yet.' }));

    const defaults = el('table', { class: 'ld' });
    defaults.appendChild(el('thead', {}, el('tr', {}, el('th', { text: 'Applies to' }), el('th', { text: 'Default tags' }))));
    const dbody = el('tbody');
    ([['All PDUs', 'pdu:*'], ['All outlets', 'outlet:*']]                      ).forEach(([name, match]) =>
      dbody.appendChild(el('tr', {}, el('td', { text: name }), el('td', {}, ruleTags(match)))));
    defaults.appendChild(dbody);
    box.appendChild(defaults);

    const derived = (graph?.nodes || [])
      .filter((n     ) => /^(pdu|outlet):/.test(String(n.id || '')))
      .sort((a     , b     ) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    if (!derived.length) {
      box.appendChild(el('div', { class: 'desc', style: { marginTop: '8px' },
        text: 'No PDU or outlet has been reported yet, so there is nothing to tag individually.' }));
      return;
    }
    const items = el('table', { class: 'ld', style: { marginTop: '10px' } });
    items.appendChild(el('thead', {}, el('tr', {}, el('th', { text: 'PDU or outlet' }), el('th', { text: 'Id' }), el('th', { text: 'Its own tags' }))));
    const ibody = el('tbody');
    derived.forEach((n     ) => ibody.appendChild(el('tr', {},
      el('td', { text: n.label || n.id }), el('td', { class: 'desc', text: n.id }), el('td', {}, ruleTags(n.id)))));
    items.appendChild(ibody);
    box.appendChild(items);
  };

  const load = async () => {
    try { const r      = await api('/api/flow'); graph = r?.body?.ok ? r.body : null; } catch { graph = null; }
    draw();
  };

  draw();
  return { el: box, load };
}

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

/// PreferEmonCms -> "Prefer EmonCMS". The acronym is restored after the split, not before: splitting on a
/// case change turns EmonCms into "Emon Cms" first, and a pattern looking for the joined-up form then
/// matches nothing.
function humanise(value        ) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bEmon\s*Cms\b/gi, 'EmonCMS')
    .replace(/^./, c => c.toUpperCase());
}

/// A radio group for a small closed set, each choice carrying its own explanation as a tooltip.
///
/// The alternative is a dropdown under a paragraph covering every option, and that paragraph is then
/// repeated for every entry of a fixed list — eight times over on the EmonCMS types page, saying the same
/// thing about choices the reader is not looking at. The tooltip belongs to the choice it describes.
function radioGroup(node     , obj     ) {
  const wrap = document.createElement('div');
  wrap.className = 'radio-group';
  const name = `r${Math.random().toString(36).slice(2)}`;
  const current = () => String(obj[node.key] ?? node.default ?? (node.enumValues || [])[0] ?? '');
  (node.enumValues || []).forEach((v        , i        ) => {
    const why = (node.enumDescriptions || [])[i] || '';
    const lab = document.createElement('label');
    lab.className = 'radio';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = name; input.value = v;
    input.checked = current() === v;
    input.onchange = () => { if (input.checked) { obj[node.key] = v; refreshDirty(); runVisibilitySyncs(); } };
    const text = document.createElement('span'); text.textContent = humanise(v);
    lab.appendChild(input); lab.appendChild(text);
    // The explanation hangs off a mark you can aim at, rather than being a paragraph under every choice or
    // an invisible tooltip on the whole row that nothing tells you is there.
    if (why) {
      const hint = document.createElement('span');
      hint.className = 'hint'; hint.textContent = 'ⓘ'; hint.title = why;
      lab.appendChild(hint);
    }
    wrap.appendChild(lab);
  });
  return wrap;
}

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
    // A blank label means something beside the control already names it — a dictionary row's key.
    if (node.label !== '') { const lab = document.createElement('label'); lab.textContent = node.label; f.appendChild(lab); }
    if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; f.appendChild(d); }
    const input = node.radio ? radioGroup(node, obj) : scalarInput(node, obj);
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

/// The same schema minus the field that names the entry, which is shown as its heading instead.
function withoutKey(valueSchema     , key        ) {
  if (!valueSchema || valueSchema.type !== 'object' || !valueSchema.properties) return valueSchema;
  return Object.assign({}, valueSchema, { properties: valueSchema.properties.filter((p     ) => p.key !== key) });
}

/// A measurement type as it is written down, in the words the rest of the GUI uses for it.
const TYPE_LABELS                         = {
  realpower: 'Power', apparentpower: 'Apparent power', energy: 'Energy', energy_d: 'Energy Daily',
  current: 'Current', voltage: 'Voltage', frequency: 'Frequency', powerfactor: 'Power factor',
};
function labelFor(value        ) { return TYPE_LABELS[value] || value; }

// Render the value of a dictionary/list element (valueSchema has no key of its own). `path` addresses
// the element itself, e.g. ['Pdus','default'] or ['Modbus','Connections','0'].
/// Returns the node the control is bound to, so a renamed key can be rebound to its own value.
function renderValue(valueSchema     , holder     , keyName     , container     , path          , inline = false) {
  // Inline, the key sits beside the value and a second label saying "value" is noise.
  const node = Object.assign({}, valueSchema, { key: keyName, label: inline ? '' : 'value' });
  if (node.type === 'object') {
    const target = ensure(holder, keyName, {});
    // A dictionary/list entry's fields (e.g. each PDU instance): scalars in columns, collections full-width.
    renderObjectBody(node.properties, target, container, path);
  } else {
    renderNode(node, holder, container, path.slice(0, -1));
  }
  return node;
}

function renderMap(node     , mapObj     , path          ) {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend'); lg.textContent = node.label; fs.appendChild(lg);
  if (node.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = node.description; fs.appendChild(d); }
  // A worked entry says more than another sentence about the shape of one.
  if (node.mapExample) {
    const ex = document.createElement('div'); ex.className = 'desc map-example'; ex.textContent = node.mapExample;
    fs.appendChild(ex);
  }
  const entries = document.createElement('div'); fs.appendChild(entries);

  // A map of scalars is one row per entry — key, value, Remove. Only a map of objects (each PDU, each
  // Modbus connection) has enough in it to be worth a card of its own.
  const inline = !node.valueSchema || node.valueSchema.type !== 'object';

  const drawEntry = (key        ) => {
    const wrap = document.createElement('div'); wrap.className = 'map-entry' + (inline ? ' inline' : '');
    const keyIn = document.createElement('input'); keyIn.className = 'key'; keyIn.type = 'text'; keyIn.value = key;
    const del = btn('Remove', 'danger');
    del.onclick = () => { delete mapObj[key]; entries.removeChild(wrap); refreshDirty(); };
    if (mapObj[key] == null) mapObj[key] = (node.valueSchema && node.valueSchema.type === 'object') ? {} : '';

    let bound     ;
    if (inline) {
      wrap.appendChild(keyIn);
      bound = renderValue(node.valueSchema, mapObj, key, wrap, [...path, key], true);
      wrap.appendChild(del);
    } else {
      const head = document.createElement('div'); head.className = 'head';
      head.appendChild(keyIn); head.appendChild(del); wrap.appendChild(head);
      bound = renderValue(node.valueSchema, mapObj, key, wrap, [...path, key]);
    }
    // Renaming the key moves the value with it, and the control follows — bound to the old key it would
    // write the entry straight back under the name that was just changed.
    keyIn.onchange = () => {
      if (!keyIn.value || keyIn.value === key) return;
      mapObj[keyIn.value] = mapObj[key];
      delete mapObj[key];
      key = keyIn.value;
      if (bound) bound.key = key;
      refreshDirty();
    };
    entries.appendChild(wrap);
  };

  // Rows of two unlabelled boxes say nothing about which side is which, so the columns are headed — and
  // the heading stands whether or not there are any entries yet to read it against.
  if (inline) {
    const head = document.createElement('div'); head.className = 'map-head';
    const k = document.createElement('span'); k.textContent = node.keyLabel || 'Key';
    const v = document.createElement('span'); v.textContent = node.valueLabel || 'Value';
    head.appendChild(k); head.appendChild(v);
    entries.appendChild(head);
  }

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
  // A fixed list is the set it ships with — the measurement types EmonCMS understands, say. Its entries are
  // titled by the field that names them rather than offering that field for editing, and neither the Add
  // nor the Remove button is drawn, because either would produce an entry nothing downstream can act on.
  const fixedKey                     = node.fixedListKey;
  const draw = (idx        ) => {
    const wrap = document.createElement('div'); wrap.className = 'list-entry';
    if (fixedKey) {
      const head = document.createElement('div'); head.className = 'head';
      const name = document.createElement('strong');
      name.textContent = labelFor(String((arr[idx] || {})[fixedKey] ?? ''));
      head.appendChild(name); wrap.appendChild(head);
    } else {
      const del = btn('Remove', 'danger');
      del.onclick = () => { arr.splice(idx, 1); rebuild(); refreshDirty(); };
      wrap.appendChild(del);
    }
    renderValue(fixedKey ? withoutKey(node.valueSchema, fixedKey) : node.valueSchema, arr, idx, wrap, [...path, String(idx)]);
    entries.appendChild(wrap);
  };
  const rebuild = () => { entries.innerHTML = ''; arr.forEach((_, i) => draw(i)); };
  rebuild();
  if (!fixedKey) {
    const add = btn('+ Add');
    add.onclick = () => { arr.push(node.valueSchema.type === 'object' ? {} : ''); rebuild(); refreshDirty(); };
    fs.appendChild(add);
  }
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
  { title: 'Energy Flow', items: [{ tool: addEnergyOverviewSection }, { tool: addNodesSection }, { tool: addGroupsSection, child: true }, { tool: addTagsSection }, { tool: addFlowSection }, { tool: addTrendsSection }, { tool: addNodeTrendsSection }, { tool: addCircuitFinderSection }, { tool: addPanelScheduleSection }, { tool: addFloorPlanSection }, { tool: addNodeDataSection }] },
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
  // The PDU page is where anything about the PDUs is looked for, their tags included.
  if (node.key === 'Pdus') {
    const tags = renderPduTags();
    sec.appendChild(tags.el);
    const open = link.onclick;
    link.onclick = (ev     ) => { open?.call(link, ev); tags.load(); };
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

  if (node.key === 'MQTT') { add('Test MQTT connection', testMqtt); add('Explore topics', async () => openMqttExplorer()); }
  else if (node.key === 'History') add('Test history backend', testHistory);
  else if (node.key === 'PDU') add('Test PDU connection', testPdu);
  else if (node.key === 'Modbus') { add('Test connections', testModbus); add('Explore registers', async () => openRegisterExplorer()); }
  else if (node.key === 'EmonCMS') {
    add('Test EmonCMS connection', testEmonCms); add('Provision feeds now', provisionEmonCmsFeeds);
    add('Delete old inputs', cleanupEmonCmsInputs); add('Delete old feeds', cleanupEmonCmsFeeds, 'danger'); add('Delete all feeds', deleteEmonCmsFeeds, 'danger');
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
  const r = await api('/api/integrations/emoncms/delete-all-feeds', { method: 'POST' });
  const inner = (r.body || {}).result || {};
  toast(inner.message ?? r.body?.message ?? 'Done.', r.body?.ok !== false);
}
/// List what EmonCMS still holds that this bridge no longer sends or provisions, name it, and delete it on confirmation.
async function cleanupEmonCms(kind                    ) {
  const r = await api('/api/integrations/emoncms/stale', { method: 'POST' });
  const found = r.body?.result || {};
  if (r.body?.ok === false || found.ok === false) {
    const message = found.message || r.body?.message || 'Could not list old inputs and feeds.';
    toast(message, false);
    return { ok: false, message };
  }
  const names           = found[kind] || [];
  if (!names.length) return { ok: true, message: `No old ${kind} to delete.` };
  const listed = names.slice(0, 15).join('\n') + (names.length > 15 ? `\n…and ${names.length - 15} more` : '');
  const consequence = kind === 'feeds'
    ? 'Deleting a feed deletes its stored history in EmonCMS. It cannot be undone.'
    : 'No feed data is lost: an input only receives readings.';
  if (!confirm(`Delete ${names.length} ${kind} that rPDU2MQTT no longer ${kind === 'inputs' ? 'sends' : 'provisions'}?\n\n${listed}\n\n${consequence}`)) return;
  const d = await api(`/api/integrations/emoncms/sweep-${kind}`, { method: 'POST' });
  const done = d.body?.result || {};
  return { ok: d.body?.ok !== false && done.ok !== false, message: done.message || d.body?.message || 'Done.' };
}
const cleanupEmonCmsInputs = () => cleanupEmonCms('inputs');
const cleanupEmonCmsFeeds = () => cleanupEmonCms('feeds');
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

// --- Coming back from a restart ----------------------------------------------------------------------
// The bridge going away is expected — an update, a switch, applying settings. What was not handled is it
// coming back: the stream stayed down, every page held whatever it had, and the tab sat there stale until
// someone reloaded it by hand. So the page waits for the bridge and picks itself back up.

let bootVersion                = null;
let returnWatch      = null;
let watchingForReturn = false;

/// Poll until the bridge answers again, then carry on where we left off.
function watchForReturn() {
  // A flag rather than the timer id: a timer id is only reliably truthy in a browser.
  if (watchingForReturn) return;
  watchingForReturn = true;
  const poll = async () => {
    let body      = null;
    // While it is away this throws (connection refused) or answers with an error page; both mean "not yet".
    try { const r      = await api('/api/status'); body = r && r.ok ? r.body : null; } catch { body = null; }
    if (!body || !body.version) return;
    clearInterval(returnWatch);
    returnWatch = null;
    watchingForReturn = false;
    cameBack(body);
  };
  returnWatch = setInterval(poll, 2500);
  setTimeout(poll, 1000);
}

/// The bridge answered. Reload when it is a different build; otherwise just bring the page up to date.
function cameBack(body     ) {
  restartFinished();
  renderStatus(body);

  const now = body.version || '';
  if (bootVersion && now && now !== bootVersion) {
    // Never throw away work the operator has not saved: say what is waiting instead of reloading over it.
    if (isDirty()) {
      toast(`The bridge is back on v${now}, but this page is still the old build. Save or discard your `
          + 'changes, then reload to catch up.', true);
      return;
    }
    toast(`Updated to v${now} — reloading this page.`, true);
    setTimeout(() => location.reload(), 600);
    return;
  }

  toast('The bridge is back.', true);
  // Sections re-subscribe and refresh off this, the same as a tab switch.
  try { window.dispatchEvent?.(new CustomEvent('rpdu:activate')); } catch { /* sections keep polling */ }
}

// Paint the app bar from a /api/status body — from the initial fetch, or pushed on the `status` feed.
function renderStatus(body     ) {
  if (!body) return;
  const set = (id        , fn                  ) => { const e = document.getElementById(id); if (e) fn(e); };

  // What this page was loaded against. A restart that comes back on a different build means the assets in
  // this tab are the old ones, and no amount of reconnecting fixes that.
  if (!bootVersion && body.version) bootVersion = body.version;
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
  // Both ways the bridge can go away: one we asked for, and one we only notice by the stream dropping.
  onExpectRestart(watchForReturn);
  onRealtimeState(s => {
    if (s === 'down') watchForReturn();
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
      el('div', { class: 'diff-path', text: (c.label || c.path).join(' › ') }),
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

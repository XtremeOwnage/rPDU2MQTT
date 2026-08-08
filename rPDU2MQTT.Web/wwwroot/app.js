// ── state.ts ────────────────────────────────────────────────────
// Shared, mutable app state: the config schema and the editable config document, both set on load().
// (Authored as ES modules; the build bundles them into one shared scope, as the GUI has always run.)
const state                               = { schema: [], data: {} };

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
  let z = 1; const min = 0.25, max = 6;
  const apply = () => { svg.setAttribute('width', Math.round(baseW * z)); svg.setAttribute('height', Math.round(baseH * z)); };
  apply();

  const onWheel = (e     ) => {
    if (!(e.ctrlKey || e.metaKey)) return;   // plain wheel: let the container scroll normally
    e.preventDefault();
    const r = scroll.getBoundingClientRect();
    const cx = scroll.scrollLeft + (e.clientX - r.left), cy = scroll.scrollTop + (e.clientY - r.top);
    const prev = z;
    z = Math.min(max, Math.max(min, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    if (z === prev) return;
    apply();
    const k = z / prev;
    scroll.scrollLeft = cx * k - (e.clientX - r.left);
    scroll.scrollTop = cy * k - (e.clientY - r.top);
  };
  scroll.addEventListener('wheel', onWheel, { passive: false });
  const cleanups = [() => scroll.removeEventListener('wheel', onWheel)];

  if (pan) {
    // `armed` on press, but only actually pan once the pointer passes a small threshold. Without that, a plain
    // click nudged the scroll by a pixel, moved the target out from under the cursor, and the browser dropped
    // the click — so clickable nodes (expand a group) never fired.
    let armed = false, panning = false, sx = 0, sy = 0, sl = 0, st = 0;
    scroll.style.cursor = 'grab';
    const onDown = (e     ) => {
      if (e.button !== 0) return;
      armed = true; panning = false; sx = e.clientX; sy = e.clientY; sl = scroll.scrollLeft; st = scroll.scrollTop;
    };
    // Track on window so a drag that runs past the container edge keeps panning until release.
    const onMove = (e     ) => {
      if (!armed) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!panning && Math.hypot(dx, dy) < 4) return;   // still within click tolerance — leave the click alone
      panning = true; scroll.style.cursor = 'grabbing';
      scroll.scrollLeft = sl - dx; scroll.scrollTop = st - dy;
    };
    const onUp = () => { if (!armed) return; armed = false; if (panning) { panning = false; scroll.style.cursor = 'grab'; } };
    scroll.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    cleanups.push(() => { scroll.removeEventListener('pointerdown', onDown); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); });
  }

  return () => cleanups.forEach(f => f());
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
  const grainsWrap = document.createElement('div'); grainsWrap.style.margin = '14px 0 0'; sec.appendChild(grainsWrap);
  const k8sWrap = document.createElement('div'); sec.appendChild(k8sWrap);

  // The live grain tree (v3): every silo (pod), the grain types active on each, and the current leader.
  const shortSilo = (s        ) => (s || '').split('@')[0];
  const renderGrains = (g     ) => {
    grainsWrap.innerHTML = '';
    const head = document.createElement('div'); head.textContent = 'Grains'; head.style.cssText = 'font-weight:600;color:var(--accent);margin:0 0 6px;'; grainsWrap.appendChild(head);
    if (!g || !g.ok) {
      const d = document.createElement('div'); d.className = 'desc';
      d.textContent = 'Grain diagnostics unavailable' + (g && g.message ? ': ' + g.message : ' (single-node cluster or management grain not ready).');
      grainsWrap.appendChild(d); return;
    }
    const silos = g.silos || [];
    const sub = document.createElement('div'); sub.className = 'desc'; sub.style.margin = '0 0 8px';
    sub.textContent = silos.length + ' silo' + (silos.length === 1 ? '' : 's') + ' · leader: ' + (g.leader || 'none');
    grainsWrap.appendChild(sub);

    // Only show the per-silo placement column when there's more than one silo — otherwise it's the same
    // address on every row and just noise.
    const multiSilo = silos.length > 1;
    const cols = multiSilo ? ['Grain', 'Active', 'Placement'] : ['Grain', 'Active'];
    const t = document.createElement('table'); t.className = 'ld';
    const hr = document.createElement('tr'); cols.forEach(x => { const th = document.createElement('th'); th.textContent = x; hr.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(hr); t.appendChild(thead);
    const tb = document.createElement('tbody');
    (g.grains || []).forEach((row     ) => {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td'); c1.textContent = row.type; c1.title = row.fullType || '';
      const c2 = document.createElement('td'); c2.textContent = row.activations;
      tr.appendChild(c1); tr.appendChild(c2);
      if (multiSilo) {
        const c3 = document.createElement('td'); c3.style.cssText = 'color:var(--muted);font-size:12px;';
        c3.textContent = (row.silos || []).map((s     ) => shortSilo(s.silo) + ' ×' + s.count).join(', ');
        tr.appendChild(c3);
      }
      tb.appendChild(tr);
    });
    t.appendChild(tb); grainsWrap.appendChild(t);
    if (!(g.grains || []).length) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = 'No active grains.'; grainsWrap.appendChild(d); }
  };

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
    try { const gr = await api('/api/grains'); renderGrains(gr.body); } catch { renderGrains(null); }
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
// Energy Flow: a read-only Sankey + the layered arrow-graph hierarchy editor.

// Metrics a live source can supply: [stored key (matches PDU Measurement.Type), friendly label, canonical
// unit, selectable input units]. The key stays the PDU vocabulary so live values roll up with outlets; the
// UI shows the friendly name and a unit picker. Mirrors EnergyFlowSource.Metric + FlowUnits (Core).
// key, label, canonical unit, input units it can be bound in.
// Kept in step with FlowUnits.cs (Core), which is the authority — including which of these add up the
// tree. The intensive ones below describe a condition at a point and are never rolled up: a node shows
// the reading it has, and one with none shows nothing rather than a sum that was true nowhere.
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
// Metrics the diagram can be drawn by but nothing can be *bound* to, so they stay out of METRICS — that
// list is the source-binding vocabulary, and the daily total is derived from counters already bound there.
const DERIVED_METRIC_LABELS                         = { energytoday: 'Energy today' };
const metricLabel = (key         ) => DERIVED_METRIC_LABELS[key || ''] || metricMeta(key)[1];
// The live-cache key a source reads under, given its direction — mirrors FlowMetricKey (Core): an 'in'
// (charge/export) reading is stored under a '#in' suffix so it doesn't collide with the 'out' supply value.
const sourceMetricKey = (src     ) => { const m = src.Metric || 'realpower'; return src.Direction === 'in' ? m + '#in' : m; };

// What a virtual node represents — mirrors [AllowedValues] on EnergyFlowNode.Kind. Each kind offers only
// the metrics that make sense for it (a battery has no frequency); 'battery' also gets a storage field.
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

// Source binding types — mirrors [AllowedValues] on EnergyFlowSource.Type. Each type renders its own fields
// in the two source columns; adding an ingest is another entry here plus a branch in the row renderer.
const SOURCE_TYPES                     = [['mqtt', 'MQTT topic'], ['modbus', 'Modbus TCP']];

// Metrics whose sign carries direction, so inverting one is meaningful (export vs import, charge vs discharge).
// These are also the ones a single ± value can be *split* into out/in — an instantaneous quantity, unlike a
// cumulative energy counter (which needs separate in/out totals, so it gets out/in but not split).
const SIGNED_METRICS = ['realpower', 'apparentpower', 'current'];
// Metrics where an in/out direction means anything at all. Voltage, frequency, power factor and state of
// charge don't have a direction, so the Direction control is hidden for them entirely.
const DIRECTIONAL_METRICS = [...SIGNED_METRICS, 'energy'];

// Why a "Current" cell can sit empty — the thing every new binding trips over.
const LIVE_HINT = 'Live value from the running ingest. It appears when the source next reports: an MQTT binding when the publisher sends, a Modbus one on the worker’s next poll — and a new or edited binding is not read at all until you Save. Nothing here is missing because the page needs reloading.';
const MODBUS_REGISTER_TYPES = ['holding', 'input'];
const MODBUS_DATATYPES = ['uint16', 'int16', 'uint32', 'int32', 'float32'];
const MODBUS_WORDORDERS = ['big', 'little'];

// How an unmeasured node is valued — mirrors [AllowedValues] on EnergyFlowNode.Mode. A live/static value
// always wins; this only governs nodes the graph would otherwise infer. 'None' leads because it's what a new
// node gets: a node you haven't measured yet should read as nothing, not as an inferred figure.
const NODE_MODES                             = [
  ['none', 'None (nothing inferred)', 'Never inferred — contributes nothing unless it has a real value or children, so an unmeasured node simply drops out instead of showing a fabricated figure. The default for a new node.'],
  ['auto', 'Auto (aggregate)', 'Sums its children. As a feeder it carries a node’s unmet demand only when it is the single path into it — where conservation leaves no other answer. It never splits a load between several unmeasured feeders: that would be inventing a number. Mark one feeder “residual” to say where the remainder actually comes from.'],
  ['static', 'Static (fixed value)', 'A fixed leaf valued at the number you enter (still superseded by a bound live source). Reveals the Fixed value field.'],
  ['residual', 'Residual (untracked feeder)', 'The designated absorber on the feeder side: carries the demand still needed after every measured feeder has supplied its part. This is how you tell the diagram where unaccounted power comes from — without it, competing unmeasured feeders all read “no data”.'],
  ['untracked', 'Untracked (child of a measured parent)', 'Place under a parent that has a measured total (a bound source or fixed value): shows the slice of that total its tracked siblings don’t account for. Contributes nothing if the parent has no measured total.'],
];

// --- Browsing what's out there: MQTT topics, and a Modbus device's registers ----------------------
//
// The topic index behind these only exists while we're asking for it — every call renews a short lease and
// the broker subscription is dropped when nobody is browsing (see ITopicIndexGrain). So autocomplete costs a
// subscription while this editor is open and nothing at all afterwards; there's no background indexer.

let pickerSeq = 0;

/// A modal panel over the page. Returns the body to fill; closes on the button, the backdrop, or Escape.
/// `onClose` fires only on those three — a caller closing the panel itself already knows, and firing it
/// there would loop when the callback re-renders the surface that owns the panel.
function overlay(title        , onClose             )                                   {
  const back = el('div', { style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.55)', zIndex: '50', display: 'flex', alignItems: 'center', justifyContent: 'center' } });
  const panel = el('div', { style: { background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: '8px', padding: '14px', width: 'min(860px, 92vw)', maxHeight: '80vh', overflow: 'auto' } });
  const head = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } });
  head.appendChild(el('h4', { text: title, style: { margin: '0', fontSize: '14px' } }));
  const x = btn('Close');
  head.appendChild(x);
  const body = el('div');
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

  // Which broker filter to subscribe to. Default '#' (everything); a broker whose ACL forbids the bare
  // wildcard can narrow it, e.g. 'solar_assistant/#', and still browse under that prefix.
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

/// Rename a node and carry its wiring with it. The id is the node's identity everywhere — links, the legacy
/// Parents map, and every downstream path derived from it — so this rewrites the references in the config and
/// is honest about the ones it can't reach.
function openRenameDialog(node     , flow     , existingIds             , onRenamed                      ) {
  const { body, close } = overlay(`Rename ${node.Label || node.Id}`);
  const links        = ensure(flow, 'Links', []);
  const parents      = ensure(flow, 'Parents', {});
  const wired = links.filter(l => l.From === node.Id || l.To === node.Id).length
    + Object.entries(parents).filter(([c, p]) => c === node.Id || p === node.Id).length;

  body.appendChild(el('div', { class: 'desc', text: `Its ${wired} wiring reference(s) move with it automatically.` }));

  // The id is what every integration keys off, so a rename is a rename downstream too — say so plainly
  // rather than letting someone discover it when their history stops.
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
// one row per metric, each carrying a Type (MQTT today) and its transport fields, all editable in place
// (including the topic, which the old flat table couldn't change).
function renderNodeEditor(node     , links       , cand                  , rerender                           ) {
  const meta = kindMeta(node.Kind);
  const allowed = meta[2];
  // No frame and no header of its own: this is rendered into a modal panel that already carries the node's
  // name and a Close button (#292).
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

  // The gauge's ceiling, for the kinds the Energy page draws a dial for. Deliberately not offered on every
  // kind: a dial belongs on something with a rating (an array's peak, an inverter, a main breaker), and
  // offering it everywhere invites a number that means nothing.
  if (['solar', 'battery', 'grid', 'load', 'inverter'].includes(node.Kind || 'node')) {
    // Tags (#342): free text, comma-separated. No fixed vocabulary and no validation — the groupings worth
    // having cut across the wiring ("everything on the UPS", "upstairs") and nobody can guess them up front.
    const tagsIn = el('input', { type: 'text', value: (node.Tags || []).join(', '), placeholder: 'critical, rack-1' });
    tagsIn.onchange = () => {
      const list = tagsIn.value.split(',').map((t        ) => t.trim()).filter((t        ) => t);
      // De-duplicated case-insensitively: they are hand-typed, and the same tag twice is two identical chips.
      const seen = new Set        ();
      node.Tags = list.filter((t        ) => { const k = t.toLowerCase(); return seen.has(k) ? false : (seen.add(k), true); });
      if (!node.Tags.length) node.Tags = undefined;
      rerender();
    };
    grid.appendChild(field('Tags', tagsIn,
      'Comma-separated labels for filtering the Energy page and highlighting the diagram. A tag never changes a reading.'));

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

  // Battery and grid flow both ways, so their sources carry a Direction: 'out' (the supply value the roll-up
  // reads) vs 'in' (charge/export, exported as the energy_in sensor HA's dashboard picks up). Other kinds only
  // ever flow one way, so the column stays hidden for them. Labels are role-specific so the choice reads plainly.
  // Label the direction by what it physically IS, not the internal out/in convention (which, relative to the
  // node, makes grid *import* the "out" value — technically right but reads backwards). The user picks
  // Import/Export or Charge/Discharge; the out/in mapping stays under the hood.
  const bidirectional = (node.Kind === 'battery' || node.Kind === 'grid');
  const dirLabels                         = node.Kind === 'battery' ? { out: 'Discharge', in: 'Charge', split: 'Split: + discharge / − charge' }
    : node.Kind === 'grid' ? { out: 'Import', in: 'Export', split: 'Split: + import / − export' }
    : { out: 'Out', in: 'In', split: 'Split: + out / − in' };

  const sources        = ensure(node, 'Sources', []);
  if (sources.length) {
    const tbl = el('table', { class: 'ld' });
    const head = el('tr');
    const colHint      = {
      Direction: 'What this source measures: the node supplying (discharge / grid import / solar production) or drawing (battery charge / grid export). Charge and export are published as a second sensor HA’s Energy Dashboard can show. Split takes one signed power/current value and fans it into both at once — the positive part as the supply side, the magnitude of the negative part as the draw side. Hidden for metrics with no direction (voltage, frequency, power factor, state of charge).',
      Invert: 'Flip the sign of a power or current reading — for a source that publishes export/discharge as positive when your hierarchy wants it negative (or vice versa).',
      Current: LIVE_HINT,
    };
    ['Type', 'Metric', ...(bidirectional ? ['Direction'] : []), 'Counter', 'Unit', 'Source', 'Details', 'Scale', 'Invert', 'Current', ''].forEach(h => {
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
      SOURCE_TYPES.forEach(([v, label]) => typeSel.appendChild(el('option', { value: v, text: label })));
      typeSel.value = src.Type || 'mqtt';
      typeSel.onchange = () => { src.Type = typeSel.value; rerender(); };  // the Source/Details fields differ per type
      tr.appendChild(el('td', {}, typeSel));

      // Offer this kind's metrics (friendly labels), but keep an already-chosen one even if the kind wouldn't
      // list it. Changing the metric resets the unit (units differ per metric) and re-renders the row.
      const metricSel = el('select', { style: { width: 'auto' } });
      const metric = src.Metric || 'realpower';
      const opts = allowed.includes(metric) ? allowed : [metric, ...allowed];
      opts.forEach((m        ) => metricSel.appendChild(el('option', { value: m, text: metricLabel(m) })));
      metricSel.value = metric;
      metricSel.onchange = () => { src.Metric = metricSel.value; src.Unit = undefined; rerender(); };
      // Say at the point of choosing that this one won't roll up — otherwise the only clue is a parent
      // node reading "no data", which looks like a broken binding rather than the correct answer.
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

      // Direction (battery/grid only, and only for a directional metric — voltage/soc have no direction, so
      // their cell stays blank). A signed metric (power/current) also offers 'split': one ± value fanned into
      // both out and in, so a single Solar-Assistant-style topic drives charge AND discharge.
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

      // Does this counter run forever, or does the device reset it every day? Only energy accumulates, so
      // every other metric's cell stays blank. Getting it wrong is silent and expensive: measuring the
      // "rise" of a counter the device resets at midnight loses the whole day, because it drops to zero and
      // climbs again unobserved. One publisher can do both — Solar Assistant's total/load_energy is
      // cumulative while total/pv_energy resets — so it cannot be inferred from the source.
      {
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

      // The Source + Details columns are type-specific.
      if ((src.Type || 'mqtt') === 'modbus') {
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
        // Source = the topic, with autocomplete off what the broker is actually carrying, and a Browse
        // button for picking one by eye. Details = the JSON field, itself autocompleted from the payload.
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

      // Scale carries the magnitude; Invert carries the sign. Kept as one number on the wire (Scale) so
      // nothing downstream has to learn a second knob — the checkbox is just its sign, spelled out.
      const scaleIn = el('input', { type: 'number', step: 'any', value: Math.abs(src.Scale ?? 1), style: { width: '80px' } });
      const setScale = (magnitude        , invert         ) => {
        const v = (invert ? -1 : 1) * (isNaN(magnitude) || magnitude === 0 ? 1 : Math.abs(magnitude));
        src.Scale = v === 1 ? undefined : v;
      };
      scaleIn.onchange = () => setScale(+scaleIn.value, (src.Scale ?? 1) < 0);
      tr.appendChild(el('td', {}, scaleIn));

      // Sign only means anything where the value has a direction — power and current, not voltage/energy.
      const invCell = el('td', { style: { textAlign: 'center' } });
      if (SIGNED_METRICS.includes(metric)) {
        const inv = el('input', { type: 'checkbox' })                    ;
        inv.checked = (src.Scale ?? 1) < 0;
        inv.title = 'Flip the sign of this reading (e.g. solar/battery power the source publishes as export).';
        inv.onchange = () => setScale(+scaleIn.value, inv.checked);
        invCell.appendChild(inv);
      } else {
        invCell.appendChild(el('span', { text: '—', style: { color: 'var(--muted)' }, title: 'Sign has no meaning for this metric.' }));
      }
      tr.appendChild(invCell);

      // Live value for every binding type: Modbus is read from the device; the rest (MQTT, future types)
      // come from the shared live cache the running ingests fill — so you can confirm a mapping reads right.
      const liveCell = el('td', { class: 'num', style: { minWidth: '90px', color: 'var(--muted)' }, text: '…' });
      liveCells.push({ src, cell: liveCell });
      tr.appendChild(liveCell);

      const rm = btn('Remove', 'danger');
      rm.onclick = () => { sources.splice(sources.indexOf(src), 1); rerender(); };
      tr.appendChild(el('td', {}, rm));
      body.appendChild(tr);
    });
    tbl.appendChild(body);
    box.appendChild(tbl);

    // Live "Current" value for every binding: Modbus is read straight from the device (works before saving);
    // MQTT and any future type come from the shared live cache the running ingests fill. Auto-refreshes.
    if (liveCells.length) {
      const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
      const setCell = (cell     , value               , err         , metric         ) => {
        if (value == null) { cell.textContent = err ? 'err' : '—'; cell.style.color = err ? 'var(--bad)' : 'var(--muted)'; cell.title = err || ('No live value yet. ' + LIVE_HINT); }
        else { const cu = metricMeta(metric)[2]; cell.textContent = `${formatNum(value)} ${cu}`.trim(); cell.style.color = 'var(--good)'; cell.title = ''; }
      };
      // A Modbus device is a shared serial resource — many gateways accept only one client at a time, and
      // the worker already polls it. So auto-refresh reads the shared live cache (no device access); only an
      // explicit "Test device read" opens its own connection, to check a binding before it's saved/polled.
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

        // Every binding not just device-probed reads the shared live cache the running ingests fill. A 'split'
        // source is stored as two keys (out + in), so query both and show their signed sum (out − in) — the
        // original ± value — rather than just the out key, which reads 0 whenever the flow is on the in side.
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
      // Self-cleaning: once this editor is replaced/closed its box leaves the DOM and the poll stops. Polls at
      // 2s — the grain mirror updates about that fast, so a live power value shouldn't lag by 5+ seconds.
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
    // The picker lists every node in the hierarchy, which on a real install is hundreds of outlets — so it
    // comes with a search box that filters it as you type (Enter takes the single match).
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

// Bring an EnergyFlow config up to the current shape in place (idempotent) — run on load by both the Flow
// and Nodes tabs since either can be opened first: legacy single-feeder Parents → directed Links, per-node
// Mqtt → the general Sources list, and a bare Value → the explicit 'static' mode.
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
  // This writes the same document the shell's save bar tracks, so re-baseline here too — otherwise the
  // bar would keep claiming there are unsaved changes that have in fact just been written.
  if (ok) { setBaseline(payload); onSaved(); }
}

// --- Node groups (#groups): several nodes shown as one collapsible node on both flow graphs. Collapse
//     state is per-viewer (this session), defaulting to collapsed so a group de-clutters until you open it.
const collapsedGroups = new Set        ();
const seenGroups = new Set        ();   // groups we've applied the default (collapsed) to at least once

function flowGroups()        {
  return (state.data?.EnergyFlow?.Groups || []).filter((g     ) => g && g.Id);
}

// Collapse each group the FIRST time we see it (a group exists to tidy the diagram; opening it is the
// deliberate act). After that, respect the viewer's choice — the old version re-collapsed any group that
// wasn't currently collapsed on every redraw, which silently undid an expand the instant it happened.
function ensureGroupState() {
  flowGroups().forEach((g     ) => { if (!seenGroups.has(g.Id)) { seenGroups.add(g.Id); collapsedGroups.add(g.Id); } });
}

// A member's owning group id, only when that group is currently collapsed.
function collapsedMemberMap()                      {
  const map                      = {};
  flowGroups().forEach((g     ) => { if (collapsedGroups.has(g.Id)) (g.Members || []).forEach((m        ) => { map[m] = g; }); });
  return map;
}

// Fold a graph's {nodes, links} so each collapsed group becomes a single node (its members' sum), with the
// members' links re-pointed at the group and duplicates merged. A node/link value of null stays null — a
// group is only as known as its members (the same never-fabricate rule the server uses).
/**
 * An expanded group shows its members *instead of* its anchor, not as well as it.
 *
 * The anchor (a group whose Id is also a real node — "Solar (PV)" over MPPT_1..3) stays the node everything
 * else uses: the rollup, the MQTT export, the HA feed. On the diagram it is one level of detail, and its
 * members are the other. Drawing both put an extra hop in the chain — members → anchor → inverter — which
 * added nothing (the anchor's reading just IS the members' sum) and braided the links into an X.
 *
 * So expanding substitutes: the members take over the anchor's outgoing links and the anchor drops out.
 * Collapsing does the reverse, which collapseGraph already handles. Both views carry the same total, and
 * the toggle changes only how finely it is broken down.
 *
 * Skipped when the anchor feeds more than one target: splitting each member's contribution across several
 * downstream nodes would mean inventing a split nothing measures. Chaining is wrong there too, but it is
 * at least not a fabricated number, so that case keeps the hop.
 */
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
  // Drop the collapsed members, keep everyone else, add the group nodes (only groups that actually have a
  // member present in this graph).
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
// How much of what passes through a node may go unaccounted for before the node's own figure stops being
// believable.
//
// The server already suppresses noise — it only reports a gap at all above 1 unit AND 2% of the reading —
// so anything that reaches here is a real discrepancy worth a marker. But a marker was ALL it got: a small
// "⚠" appended to the label while the number itself was printed in the same weight as every honest figure
// on the chart. A node carrying a 129.9 kWh gap and a node 3% out looked identical.
//
// A quarter is the line because it is past arguing about. Rounding, sampling skew and counters read a few
// seconds apart do not lose a quarter of the energy; a mis-scaled source, a sensor measuring one leg of a
// node, or a counter that is not what it was declared to be all do. Above it, the figure is not "slightly
// off" — it is contradicted by the diagram it sits on, and saying so quietly is how a wrong number gets
// believed for a week.
const CONTRADICTION_SHARE = 0.25;

/// The banner naming every binding the bridge is dropping, and why. Separate from the contradiction banner
/// because it is a different statement: that one says a number on the chart disagrees with the chart, this
/// one says a number is absent on purpose. A node reading "no data" is otherwise indistinguishable from one
/// nobody ever bound a source to, and the two need completely different fixes.
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

/// The banner naming every node whose figure its own flows contradict. Above the chart, not inside it: the
/// point is to be read before the numbers are, by someone who came to the page to read the numbers.
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
  // A measured node's gap is throughput − reading, so the throughput is the larger side. Everything else
  // reports outflow − inflow, where the reading IS the outflow. Either way the denominator is the bigger
  // of the two sides — the amount the node is claiming to handle.
  const throughput = n.derivation === 'measured' ? reading + n.imbalance : reading;
  if (!(throughput > 0)) return null;
  return Math.min(1, Math.abs(n.imbalance) / throughput);
}

// Show the "Unmeasured load" node on the diagram? A view preference, not config: the node is drawn from
// figures already measured and is never exported (see FlowNode.Synthetic), so hiding it changes what you
// are looking at and nothing else. On by default — a panel passing 8 kW to 560 W of metered outlets is
// worth seeing — but it can dominate a chart when most of the load is unmetered, which is exactly when
// someone wants the metered detail back.
let showUnmeasured = (() => { try { return localStorage.getItem('rpdu-flow-unmeasured') !== '0'; } catch { return true; } })();

function setShowUnmeasured(on         ) {
  showUnmeasured = on;
  try { localStorage.setItem('rpdu-flow-unmeasured', on ? '1' : '0'); } catch { /* private mode: this session only */ }
}

/// Drop the unmetered-remainder nodes and their links when the view is switched off. Return lanes (#in)
/// are real measured flows and are never hidden by this.
function applyUnmeasuredPref(nodes       , links       )                                 {
  if (showUnmeasured) return { nodes, links };
  const hidden = new Set(nodes.filter((n     ) => String(n.id || '').endsWith('#unmeasured')).map((n     ) => n.id));
  if (!hidden.size) return { nodes, links };
  return {
    nodes: nodes.filter((n     ) => !hidden.has(n.id)),
    links: links.filter((l     ) => !hidden.has(l.target) && !hidden.has(l.source)),
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

/// The "Animate flow" view switch. Purely local: a per-viewer preference, not a property of the system, and
/// off by default because motion on a dashboard left up on a wall is a nuisance rather than information.
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

/// The `at`/`span` part of a flow query, and the sentence that says what came back.
///
/// Both pages ask the same question and must describe the answer the same way — a diagram or a board that
/// looks live while showing last Tuesday is the worst thing either page can do.
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
  // A window with days missing from it is not that window. Name the nodes rather than quietly showing a
  // short total as a whole one.
  const short = (body.incomplete || [])                                    ;
  const gap = short.length
    ? ` · incomplete: ${short.slice(0, 4).map(x => `${x.node} ${x.days}/${days}d`).join(', ')}${short.length > 4 ? `, +${short.length - 4} more` : ''}`
    : '';
  return `showing ${what} from ${body.source}${gap}`;
}

/// Which part of the moment was just changed. The caller needs it to tell "the whole of a day" (an energy
/// question) from "this instant of it" (a power one) — the two want different metrics, and guessing from
/// the value alone cannot distinguish a freshly-picked day from a re-render.

/// A "show this moment instead of now" control (#372). Returns the ISO instant to request, or '' for live.
///
/// Kept deliberately plain: a datetime input and a Live button. The value goes to the server as ?at=, and
/// the page renders whatever it gets back — a historical view is the same diagram built from the values of
/// that instant, not a second rendering path.
function historyControl(onChange                             )

  {
  const row = el('div', { class: 'ld-toolbar history-bar', style: { flexWrap: 'wrap', gap: '8px', margin: '0 0 8px' } });
  // Separate date and time inputs, not a datetime-local: that control reports '' until BOTH halves are
  // filled, so picking a day and leaving the time blank sent nothing and the page silently stayed live.
  // Split, the time is genuinely optional — blank means the end of the chosen day.
  const input = el('input', { type: 'date' })                    ;
  const timeIn = el('input', { type: 'time', step: '1' })                    ;
  const prev = btn('◀');
  const next = btn('▶');
  const live = btn('Live', 'primary');
  const note = el('span', { class: 'desc', style: { margin: '0' } });
  prev.title = 'Previous day';
  next.title = 'Next day';

  live.title = 'Back to the current reading';

  const today = () => new Date().toLocaleDateString('en-CA');   // yyyy-mm-dd in local time
  const step = (days        ) => {
    const from = input.value || today();
    const d = new Date(from + 'T12:00:00');   // midday, so a DST shift cannot land on the previous day
    d.setDate(d.getDate() + days);
    const iso = d.toLocaleDateString('en-CA');
    input.value = iso > today() ? today() : iso;   // no future days: there is nothing recorded there
    onChange('day');
  };

  input.onchange = () => onChange('day');
  timeIn.onchange = () => onChange('time');
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  live.onclick = () => { input.value = ''; timeIn.value = ''; spanSel.value = '1'; syncSpan(); note.textContent = ''; onChange('live'); };

  // The picker exists only if there is a backend to read from. With History switched off, a date control
  // whose every answer is "history is turned off" is worse than no control at all.
  //
  // Read live rather than at build time, and re-read on every tab switch, so turning the feature on under
  // Features brings the picker out without a reload.
  const historyOn = () => !!((state.data && state.data.History) || {}).Enabled;
  const syncEnabled = () => {
    const on = historyOn();
    row.classList[on ? 'remove' : 'add']('is-hidden');
    // A day still selected when the feature is switched off has to stop being requested, or the page goes
    // on asking for a moment that nothing can answer.
    if (!on && input.value) { input.value = ''; timeIn.value = ''; spanSel.value = '1'; note.textContent = ''; onChange('live'); }
  };

  // One control rather than five: the arrows and inputs share a border and only the outer corners round,
  // so the group reads as a single thing instead of a row of loose buttons.
  const group = el('div', { class: 'input-group' }, prev, input, timeIn, next);

  // How much of the past to add up. A week is the sum of seven daily totals — they all re-base at the same
  // moment, so they add; a lifetime counter and an instantaneous power reading do not, which is why the
  // server refuses a span for anything but the daily total and this offers one only alongside a date.
  const spanSel = el('select', { title: 'Add up the daily totals over this many days, ending on the chosen day.' })                     ;
  [['1', 'that day'], ['7', '7 days to it'], ['30', '30 days to it']]
    .forEach(([v, t]) => spanSel.appendChild(el('option', { value: v, text: t })));
  spanSel.onchange = () => { syncSpan(); onChange('span'); };

  // A time within the day says nothing about a week of them, so the two cannot both be set.
  const syncSpan = () => {
    const many = (Number(spanSel.value) || 1) > 1;
    timeIn.disabled = many;
    if (many) timeIn.value = '';
    timeIn.title = many
      ? 'Not used over a span of days — each day is counted whole.'
      : 'Optional. Leave blank for the end of the day — the day’s complete totals.';
  };

  row.append(el('span', { class: 'desc', style: { margin: '0' }, text: 'At:' }), group,
    el('span', { class: 'desc', style: { margin: '0' }, text: 'covering' }), spanSel, live, note);
  syncSpan();
  syncEnabled();
  window.addEventListener?.('rpdu:activate', syncEnabled);
  return {
    row,
    /// The instant to ask for.
    ///
    /// With a time, that time on the chosen day. Without one, the end of the day: a daily total is only
    /// complete then, and midnight would return the total a moment after it re-based, which is zero. Either
    /// way an instant still ahead of now is clamped to now, because nothing is recorded past it.
    at: () => {
      if (!historyOn() || !input.value) return '';
      const when = new Date(`${input.value}T${timeIn.value || '23:59:59'}`);
      const now = new Date();
      return (when > now ? now : when).toISOString();
    },
    day: () => (historyOn() ? input.value : ''),
    time: () => timeIn.value,
    /// Days to add up, ending on the chosen day. 1 is the plain "that moment" view.
    span: () => (historyOn() && input.value ? Math.max(1, Number(spanSel.value) || 1) : 1),
    setNote: (t        ) => { note.textContent = t; },
  };
}

// The tag selected on the diagram, kept across redraws: the Sankey repaints on every live push, and a
// highlight that cleared itself every few seconds would be unusable.
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
    // Read the state at click time, not the value captured when the chip was built: the row is rebuilt on
    // every toggle, but a chip that outlives its rebuild would keep re-selecting the tag it already has.
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
///
/// `drawn` says whether this view is a drawing. The roll-up is a table — nothing on it is drawn and nothing
/// animates — so offering "Unmeasured load" and "Animate flow" there described a diagram that was not on
/// the page. The group chips still belong: collapsing a group changes the table's rows.
function groupToggles(onToggle            , drawn = true)                     {
  const groups = flowGroups();
  const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px', margin: '0 0 8px' } });
  // The view switches are not about groups and must not disappear with them — this used to return null
  // when nothing was grouped, which hid the "Unmeasured load" toggle from anyone who had no groups.
  if (drawn) {
    row.appendChild(unmeasuredToggle(onToggle));
    row.appendChild(animateToggle(onToggle));
  }
  if (!groups.length) return drawn ? row : null;
  row.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Groups:' }));
  groups.forEach((g     ) => {
    const on = collapsedGroups.has(g.Id);
    const count = (g.Members || []).length;
    const chip = btn(`${on ? '▸' : '▾'} ${g.Label || g.Id} (${count})`);
    // A group with no members has nothing to fold — collapsing/expanding it is a no-op, so say so instead of
    // leaving the click feeling broken.
    chip.title = count === 0 ? 'No members yet — add nodes to this group on the Nodes tab; then it collapses/expands.'
      : on ? `Collapsed — click to expand its ${count} member(s)` : 'Expanded — click to collapse into one node';
    chip.onclick = () => {
      if (count === 0) { toast(`“${g.Label || g.Id}” has no members yet — add some in the Groups section on the Nodes tab.`, false); return; }
      on ? collapsedGroups.delete(g.Id) : collapsedGroups.add(g.Id); onToggle();
    };
    row.appendChild(chip);
  });
  // Where membership is edited — the toggles only collapse/expand; you add or remove a group's nodes on the
  // Nodes tab (this is the “how do I add a node to a group?” signpost).
  row.appendChild(el('span', { class: 'desc', style: { margin: '0 0 0 6px', fontSize: '11px' }, text: '· add/remove members in the Groups section on the Nodes tab' }));
  return row;
}

// The candidate node universe for wiring: the built graph's nodes (pdu/outlet/…) plus the custom defs.
//
// Not the nodes the builder synthesises to make the diagram balance — a bidirectional node's return lane
// (`…#in`) and a pass-through's unmetered remainder (`…#unmeasured`). They describe an arithmetic result,
// not a thing you can wire: they exist only in the built graph, are recomputed on every build, and have no
// entry in the config at all.
//
// Leaving them in put "Unmeasured load" into the hierarchy editor as a node with no links — orphaned and
// unexplained, because the editor draws links from the config while that node's link exists only in the
// graph. It also offered them in the "wire to" picker and as group members, where selecting one would
// write a config link to an id that is regenerated from scratch on the next build.
//
// '#' appears in no real id (PDU and outlet ids use ':'), so it marks exactly the builder's own inventions.
function flowCandidates(lastGraph     , customNodes       ) {
  const cand = new Map             ();
  (lastGraph?.nodes || [])
    .filter((n     ) => !String(n.id || '').includes('#'))
    .forEach((n     ) => cand.set(n.id, { id: n.id, label: n.label, kind: n.kind }));
  customNodes.forEach((n     ) => cand.set(n.Id, { id: n.Id, label: n.Label || n.Id, kind: n.Kind || 'node', custom: true }));
  return cand;
}

// Group manager (#groups): define named groups of nodes that collapse into one node on the flow graphs and
// export a summed total. Members keep their own links and exports — a group is an overlay plus a roll-up.
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

  // Anchor a group on an existing node: that node becomes the group (keeping its own value), and its members
  // fold into it. This is the "make Solar PV a group over its MPPTs" path.
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
//
// It used to render beneath the table, which put the form at the bottom of a long page — nowhere near the
// row you clicked — and forced the table itself to stay wide enough to host it, which small screens can't
// give. The panel lives on <body>, so it outlives the re-render of the surface underneath it and is rebuilt
// in place instead: the node object's identity is what the editor holds, and that survives a re-render.
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

/// Would adding from -> to close a cycle? The builder walks whatever it is handed, so a loop expressed in
/// config would recurse rather than fail.
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

// Virtual-node manager (#129): the dedicated node-configuration surface (its own Nodes tab). Each row is a
// node; Edit opens the full editor (name, kind, mode, value, bindings, feeders/children) in a modal.
// Deleting a node takes its bound sources with it (they live on the node).
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
    //
    // The column used to be the other way round, "what this node feeds". Every row of imported appliances
    // then read "— none —" while being fed by the main panel, and setting a node's place in the hierarchy
    // meant finding its parent's row and editing a list. You put a thing under its feeder, so the control
    // is on the thing.
    const incoming = links.filter((l     ) => l.To === n.Id).map((l     ) => l.From);
    const fedByCell = el('td');
    if (incoming.length > 1) {
      // Several feeders is legitimate — a transfer switch fed by grid, generator and inverter — and one
      // dropdown cannot express it. Shown, and edited in the node's own editor.
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

    // Copy: the same node under a free id, opened for renaming. Its bindings come along (that's the tedious
    // part worth copying — a second panel string, another breaker on the same meter); its wiring doesn't,
    // since the copy usually feeds somewhere else.
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
  // Which measurement the flow is drawn by — link widths follow it. Power (W) is the live snapshot; Energy
  // (kWh) is the cumulative total, so the diagram reads as "how much has flowed" rather than "how much now".
  //
  // "Energy today" is the one energy view whose arithmetic holds. Lifetime totals come from epochs that have
  // nothing to do with each other — a PDU's firmware counter has run since the unit was commissioned, a
  // derived node's since its binding was configured — so a panel can legitimately report eleven times what
  // its own feeder does. Daily totals all start at the same midnight, so they actually sum.
  const metricSel = el('select', { title: 'Draw the flow by this measurement.' })                     ;
  [['realpower', 'Power (W)'], ['energytoday', 'Energy today (kWh)'], ['energy', 'Energy, lifetime (kWh)'],
   ['apparentpower', 'Apparent (VA)'], ['current', 'Current (A)']]
    .forEach(([v, t]) => metricSel.appendChild(el('option', { value: v, text: t })));
  const count = document.createElement('span'); count.className = 'ld-count';
  // What window "today" actually means, next to the selector that chose it. The boundary is the *server's*,
  // and in a container that is UTC unless someone set TZ — so a day can end at 7pm local and look like the
  // totals reset for no reason. Shown only on the daily metric, where it changes how to read the chart.
  // Animating the ribbons is decoration, and decoration that cannot be switched off is a nuisance on a
  // dashboard left up on a wall. Off by default for the same reason, and remembered locally rather than in
  // the config: it is a per-viewer preference, not a property of the system.
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
  // so the metric moves with it. Picking a *time* is the opposite: an instant is exactly when power is the
  // right question, so the metric is left alone. Either way this is a default at the moment of the pick,
  // not a rule enforced on every load: choosing Power afterwards used to be undone by the next refresh.
  let hadDay = false;
  const hist = historyControl((what     ) => {
    // Only on the way out of live. Stepping between days, or re-picking one, keeps whatever you are
    // looking at — having the metric snap back every time the arrow is pressed is not a default, it is a
    // refusal to let you choose.
    const leftLive = what === 'day' && !hadDay && !!hist.day();
    hadDay = !!hist.day();
    // Only the daily total can be added across days, so asking for a span asks for that metric — the
    // server refuses any other, and a refusal where an answer was expected is not a useful default.
    if ((leftLive && !hist.time() && metricSel.value === 'realpower') || (what === 'span' && hist.span() > 1)) {
      if (metricSel.value !== 'energytoday') metricSel.value = 'energytoday';
      showDayNote();
    }
    load();
  });
  sec.appendChild(hist.row);
  const wrap = document.createElement('div'); sec.appendChild(wrap);

  // Three separate jobs used to be stacked below the diagram on this one page: a table of what each node
  // grain rolled up, the editor that wires the hierarchy, and the settings that govern the roll-up. Each
  // gets its own page under Energy Flow, so the Flow page is the diagram.
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
    'What each node\'s own grain rolled up, per metric: measured leaves report their source, aggregates sum their children, residuals take the remainder.');
  const treePanel = treePage.body;
  const edPage = subPage('Hierarchy', '⑃',
    'How the nodes are wired together. Energy flows left → right.');
  const ed      = edPage.body;
  const settingsPage = subPage('Settings', '⚙',
    'Everything that governs the energy roll-up and its export. These were scattered across the pages they affected.');
  let lastGraph      = null;
  // Bindings the server is dropping on purpose. Fetched beside the graph rather than folded into it: it
  // describes the ingest, not the drawing, and it must still be reported when the graph itself is empty.
  let withheldSources        = [];

  // Collapsing/expanding a group must move both graphs together (they share the collapse state).
  const redrawBoth = () => { if (lastGraph) draw(lastGraph); renderTree(); };

  // The distributed node-grain roll-up (v3): each configured node's value computed by its own grain
  // (measured leaves report their source, aggregates sum their children, residuals the remainder).
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
      dd.textContent = 'No node values yet — add energy-flow nodes and feed a source; the grains roll them up here.';
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

    // Sum a group's members per metric — only members that actually have a value, so a group is never a
    // fabricated total (matches the diagram and the server export).
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
    // ...then substitute the members for the anchor on any group left expanded, so a group is always shown
    // at exactly one level of detail rather than both at once...
    const expanded = explodeExpandedGroups(collapsed.nodes, collapsed.links);
    // ...and finally honour the unmetered-remainder view switch.
    const folded = applyUnmeasuredPref(expanded.nodes, expanded.links);
    const toggles = groupToggles(redrawBoth);
    if (toggles) wrap.appendChild(toggles);
    const links = folded.links;
    const nodes = folded.nodes;
    if (!links.length) { wrap.innerHTML = '<div class="desc" style="color:var(--muted)">No measured power flow to display. Define an EnergyFlow hierarchy, or check that outlets report power.</div>'; count.textContent = ''; return; }

    const units = graph.units || '';
    // Which metric is actually on screen, taken from the graph rather than the selector: the two disagree
    // while a fetch is in flight, and a live push repaints without the selector being touched at all.
    const lifetimeEnergy = String(graph.metric || metricSel.value || '').toLowerCase() === 'energy';
    const incoming      = {}, outgoing      = {};
    nodes.forEach((n     ) => { incoming[n.id] = []; outgoing[n.id] = []; });
    links.forEach((l     ) => { (outgoing[l.source] = outgoing[l.source] || []).push(l); (incoming[l.target] = incoming[l.target] || []).push(l); });
    // The server decides a node's value and, crucially, whether one is known at all — null means nothing
    // measures it and nothing downstream determines it. Never substitute 0 for that: 0 is a claim (solar at
    // night really is 0 W) and showing it for an unmeasured node is exactly the fabrication we removed.
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
    //
    // Longest-path alone left-justifies every root, which is fine while the graph is shallow but breaks as
    // soon as one branch is deeper than another. Add panels -> strings -> MPPTs upstream of an inverter and
    // Grid, having no feeder of its own, stays pinned in column 0 while the inverter moves out to column 3
    // — so its ribbon, several kW wide, is dragged straight across the string and MPPT columns and over
    // their bars and labels. Nothing reserves a lane for a link that skips a tier.
    //
    // A sink keeps its column; everyone else sits one step left of its earliest child. Every edge still
    // points strictly rightward, because a node always ends up strictly left of all its children.
    // Processed children-first (descending depth) so a child's column is final before its parent reads it.
    //
    // This is the same rule the hierarchy editor on the Nodes tab already applies, for the same reason —
    // it hit this first with Battery -> inverter skipping past Solar. The two views now agree on where a
    // node belongs, instead of the diagram and its editor disagreeing about the same topology.
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
    // What the node has to be tall enough to carry: its own reading, or the flows through it if those are
    // larger. Never smaller than the ribbons it must accommodate.
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
    // Every node's label needs a full text line, whatever its bar height — otherwise a stack of small
    // "0 W" / "no data" nodes collides its labels into an unreadable smear. So a node occupies a *row* at
    // least this tall (its bar is centered inside it), while the bar itself stays proportional.
    const labelRow = 15;
    // A link's pull on the layout. Weighting purely by value means a zero-carrying link exerts none at
    // all — and at night the whole solar chain is zero, so `w` stayed 0, bary() returned Infinity, and
    // every MPPT and the PV aggregate sorted to the bottom of their columns while the inverter they feed
    // stayed up beside the grid. The chain came out as scattered orphans joined by invisible ribbons.
    // A floor keeps a zero link meaning "these two are wired together" without letting it outvote a
    // measured one.
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
        //
        // Those are not always the same number, and when they differ the bar is the thing that lies. An
        // inverter bound to `load_power` reports its AC-load leg only, so one taking 8,344 W of PV and
        // sending 5,652 W of it to charge a battery reported 2,526 W — and drew a bar a third the width of
        // the ribbons entering and leaving it. The reading was correct; the geometry was not, and geometry is
        // the whole point of a Sankey. The label still shows the node's own value, and the discrepancy is
        // flagged separately.
        //
        // An unknown or measured-zero node is a thin marker (it has no magnitude to show) rather than a
        // fixed slab. The row it sits in is what guarantees label spacing.
        const h = known(n.id) ? Math.max(2, throughput(n.id) * pxPerUnit) : 3;
        const rowH = Math.max(h, labelRow);
        pos[n.id] = { x: colX(c), y: y + (rowH - h) / 2, h, outOff: 0, inOff: 0 };
        y += rowH + gap;
      });
      return y;
    };

    // The unmetered remainder sits at the bottom of its column, below every measured sibling (#366). It is
    // what is left after the metered children are subtracted, so reading it above them inverts the order the
    // figure is arrived at, and it moves up and down the column as the remainder changes size.
    const remainder = (id        ) => (id || '').includes('#unmeasured') ? 1 : 0;

    // Forward: roots stack by size, downstream columns follow their feeders (groups children, avoids crossings).
    cols.forEach((cn, c) => {
      if (c === 0) cn.sort((a     , b     ) => remainder(a.id) - remainder(b.id) || nodeValue(b.id) - nodeValue(a.id));
      else cn.sort((a     , b     ) => remainder(a.id) - remainder(b.id) || (bary(a.id) - bary(b.id)) || (nodeValue(b.id) - nodeValue(a.id)));
      placeColumn(cn, c);
    });
    // Backward: right-to-left, order each column by what it feeds. The forward pass alone can only order a
    // column by its inputs, so column 0 — which has none — was sorted purely by size and a zero-output
    // feeder always sank to the bottom, however far that was from the node it powers.
    for (let c = cols.length - 2; c >= 0; c--) {
      if (!cols[c]) continue;
      cols[c].sort((a     , b     ) => remainder(a.id) - remainder(b.id) || (obary(a.id) - obary(b.id)) || (nodeValue(b.id) - nodeValue(a.id)));
      placeColumn(cols[c], c);
    }
    // Re-place left-to-right in the settled order so every column shares one top edge and the offsets reset.
    let bottom = padTop;
    cols.forEach((cn, c) => { bottom = Math.max(bottom, placeColumn(cn, c)); });

    // Then slide each column bodily down to meet what it feeds.
    //
    // The two passes above only ever *order* a column; every column still starts at padTop. That is fine
    // while columns are of similar height, and comes apart when a short one feeds into a tall one: pulling
    // Grid rightward to hug the inverter (#307) put it above Solar in the same column, which pushed Solar
    // ~530px down — while the three idle MPPTs feeding it stayed pinned at the top of the column to their
    // left, joined to it by hairlines running the full height of the chart. Ordering cannot fix that; only
    // the column's offset can, and nothing was setting one.
    //
    // Translating the whole column keeps the order and spacing both passes just settled, and moves it by the
    // link-weighted average of how far each of its nodes misses what it powers. Right-to-left, so a column
    // reads targets that have already stopped moving.
    // Two sweeps: right-to-left settles each column against what it feeds, then left-to-right lets the
    // feeders answer back now that their targets have moved. One sweep alone leaves the first column it
    // touched positioned against neighbours that then moved.
    const relaxOrder = [...Array(cols.length).keys()].reverse().concat([...Array(cols.length).keys()]);
    for (const c of relaxOrder) {
      const cn = cols[c];
      if (!cn || !cn.length) continue;
      let w = 0, s = 0;
      cn.forEach((n     ) => {
        const sp = pos[n.id];
        if (!sp) return;
        const mid = sp.y + sp.h / 2;
        // Both sides, not just what it feeds.
        //
        // Weighing only the targets drags a column to the centre of what it powers, with nothing holding the
        // other end: a pair of PDUs fanning out to a dozen outlets got pulled up above the top edge of the
        // panel feeding them, so its ribbons rose out of the panel, crossed back down, and drew an S through
        // the middle of the chart. A column belongs between its feeders and its consumers, so both pull.
        (outgoing[n.id] || []).forEach((l     ) => {
          const tp = pos[l.target];
          if (!tp) return;
          s += ((tp.y + tp.h / 2) - mid) * linkW(l);
          w += linkW(l);
        });
        (incoming[n.id] || []).forEach((l     ) => {
          const fp = pos[l.source];
          if (!fp) return;
          s += ((fp.y + fp.h / 2) - mid) * linkW(l);
          w += linkW(l);
        });
      });
      if (!w) continue;
      // Never above the top margin, and never so far down that the column leaves the canvas — a chain that
      // hugs its target off-screen is no more readable than one that drifted away from it.
      const top = Math.min(...cn.map((n     ) => pos[n.id].y));
      const foot = Math.max(...cn.map((n     ) => pos[n.id].y + pos[n.id].h));
      const shift = Math.max(padTop - top, Math.min(s / w, Math.max(padTop, bottom) - foot));

      // Only rescue a column that has genuinely come adrift; leave a well-placed one alone.
      //
      // This pass exists for the night-time case, where three idle MPPTs sorted ~530px away from the Solar
      // node they feed and the chart read as scattered orphans. Applied to every column regardless, it also
      // nudged columns that were already correct — and a nudge is not free. A panel feeding two PDUs stacks
      // its ribbons flush by construction (the targets' heights sum to the source's), so any shift at all
      // lifts the targets off the source's edge and bends what should be a straight band into an S. Seen on
      // a live diagram: ribbons rising out of the top of the panel that fed them before turning back down.
      //
      // The test is overlap, not distance: if the column still spans where its flow wants it, the stacking
      // has already done the job and moving it can only make things worse.
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

    // Ribbons (filled bezier bands). The draw order IS the stacking order — outOff/inOff accumulate as we
    // go — so it has to satisfy both ends at once.
    //
    // Target y alone was not enough. It stacks a node's *outgoing* links correctly (they appear in
    // ascending target order), but says nothing about the order of the links arriving at any one target:
    // several MPPTs feeding one inverter all share a target, so they stacked in array order and the
    // ribbons crossed — a plain fan-in drawn as a braid. Adding source y as the tiebreak means the links
    // into a node arrive in the same vertical order as the nodes they come from, so parallel feeders no
    // longer cross. Both keys together satisfy source and target stacking simultaneously.
    // Clip ids must be unique within the document, and a redraw rebuilds the whole svg.
    let flowClipSeq = 0;
    links.sort((a     , b     ) =>
      (pos[a.target]?.y ?? 0) - (pos[b.target]?.y ?? 0) ||
      (pos[a.source]?.y ?? 0) - (pos[b.source]?.y ?? 0)
    ).forEach((l     ) => {
      const s = pos[l.source], t = pos[l.target];
      if (!s || !t) return;
      // An unknown link draws as a hairline: the wiring is real, the quantity isn't known. A *measured*
      // zero is the same picture — 0 W scales to a 1px band at 30% opacity, i.e. nothing — so at night the
      // solar chain looked disconnected rather than idle. Both get a visible hairline; only the ribbons
      // carrying something get a proportional band.
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
        // Endpoints in the markup so focusing a supply path is a CSS class flip, not a repaint — the
        // opacity above encodes whether a value is known, and must not be overwritten to dim them.
        'data-src': l.source, 'data-dst': l.target,
      }));

      // A stream drawn along the ribbon's centre line, so the diagram shows direction and rate rather than
      // just magnitude. Width already says how much; this says how hard, which a static Sankey cannot.
      //
      // Speed is tied to intensity — flow per unit of ribbon width, i.e. how fast the stuff is actually
      // moving — not to the raw value. Tying it to the value would march the widest ribbon fastest simply
      // for being wide, which reads as "more" twice and says nothing new.
      //
      // Skipped for anything unknown or idle: a hairline that animates claims motion nobody measured, and
      // "no data" must never look busier than a real reading.
      if (animateFlow() && !unknownLink && !idleLink) {
        // The stream is the band, not a line drawn down the middle of it.
        //
        // Stroking a thin centre line looked like a stray dash wandering loose over the diagram: 6px of
        // thread inside a 200px ribbon reads as an unrelated squiggle, and where ribbons overlap it appeared
        // to cross into bands it had nothing to do with. So the stroke is the ribbon's full height and is
        // clipped to the ribbon itself — it can no longer paint a pixel outside the flow it describes, and
        // it reads as the band moving rather than as something crawling along it.
        const clipId = `fs${flowClipSeq++}`;
        const clip = svgEl('clipPath', { id: clipId });
        clip.appendChild(svgEl('path', { d: ribbonPath }));
        svg.appendChild(clip);

        // Lanes of thin particles, not one stroke as tall as the band.
        //
        // A dashed stroke draws its gaps across the whole stroke width, so stroking the centre line at the
        // ribbon's full height turns every dash into a full-height vertical bar: on a wide ribbon that reads
        // as a venetian blind rather than as movement. Several thin lanes spread across the band, offset
        // from one another, read as a current — and they degrade correctly, because a hairline ribbon simply
        // gets one lane and looks exactly as it did.
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

    // A group reads like a node: click the group node to toggle it, or click any expanded member to fold it
    // back — the toggles above stay as an alternative. memberGroup maps a member to its group; groupById maps
    // a group's id (including an anchor group, whose id is a real node) so the anchor toggles either way.
    const memberGroup                      = {};
    const groupById                      = {};
    flowGroups().forEach((g     ) => { groupById[g.Id] = g; (g.Members || []).forEach((m        ) => { memberGroup[m] = g; }); });

    // Nodes + labels (to the right of each node, vertically centered; a bg halo keeps them legible
    // where they cross a ribbon).
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
      // A <title> must NOT be a child of <text>: its text node is part of the <text> element's content and
      // gets painted onto the chart. That is how a tooltip explaining an imbalance ended up rendered across
      // the diagram as a wall of words. Hang it on a wrapping <g> instead, where it is a tooltip and nothing
      // else.
      const labGroup = svgEl('g', {});
      const explain = (text        ) => {
        const t = svgEl('title');
        t.textContent = text;
        labGroup.appendChild(t);
      };
      // An inferred figure is never dressed as a measured one. It is arithmetic about the hierarchy someone
      // drew — sound, but not something anything metered — so it says so on its face, in the one place the
      // number is actually read.
      const inferredNode = n.derivation === 'inferred';
      lab.textContent = unknownNode ? `${n.label} · no data`
        : `${n.label} · ${formatNum(nodeValue(n.id))} ${units}${inferredNode ? ' · inferred' : ''}`;
      if (unknownNode) {
        lab.setAttribute('fill', 'var(--muted)');
        lab.setAttribute('font-style', 'italic');
        explain('Nothing measures this node, and no single path determines it. Bind a live source to it, or mark one of its feeders as "residual" to say where the remainder comes from.');
      }
      // More leaves this node than arrives at it — not a state the hardware can be in, so say so on the
      // diagram instead of drawing the larger number at full height and letting it look intentional.
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
        // Past the line, the label stops looking like every other figure on the chart and the node is
        // named in a banner above it. The number is still shown — hiding a reading the hardware actually
        // gave would be its own kind of lying — but it is no longer presented as settled.
        // Not on lifetime energy. Those counters started whenever each device or binding was first seen —
        // a PDU's outlet totals have been running for years, an inverter's for weeks, a derived one since
        // the last restart — so the two sides of a node are answering about different spans and a large
        // gap is the expected result, not a fault. Checked live: a main panel read 96% "unaccounted" purely
        // because its outlets have been counting far longer than its feeder. The ⚠ and its tooltip still
        // say so, and the tooltip already points at "Energy today", where every figure covers one window.
        const share = lifetimeEnergy ? null : contradictionShare(n, reading);
        if (share != null && share >= CONTRADICTION_SHARE) {
          lab.setAttribute('fill', 'var(--warn, #d08700)');
          lab.setAttribute('class', 'flow-contradicted');
          contradicted.push({ id: n.id, label: n.label, share });
        }
        // Two different discrepancies wear the same marker, and they need different sentences.
        //
        // For a MEASURED node the server sends throughput − reading, so the flows through it exceed what its
        // own sensor reports. Subtracting the imbalance from the reading — which is what this used to do —
        // is meaningless there and printed things like "-49.625 kWh arrives", which is not a quantity.
        //
        // For anything else it is outflow − inflow, and the reading IS the outflow, so inflow is the
        // difference and the original wording holds.
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

        // Hovering a node explains it: what it is, what it reads, what feeds it and what it feeds, and which
      // sources are bound to it. All of that is already on the client, so the card costs no extra request —
      // and it's the only place a node's *intensive* readings (voltage, soc, temperature) can be shown, since
      // those are deliberately absent from the ribbons.
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
      // Click again — or anywhere off a node — to restore. Group nodes keep click for expand/collapse,
      // which is their established affordance; use the toggles above to open one, then trace inside it.
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

    // Surface the unknowns rather than leaving them to be spotted: a node with no data is a gap in the
    // measurement, and the point of this diagram is knowing which parts of the house are actually covered.
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

    const scroll = el('div', { style: { overflow: 'auto', maxHeight: '74vh', border: '1px solid var(--line)', borderRadius: '6px' } });
    scroll.appendChild(svg); wrap.appendChild(scroll);
    wrap.appendChild(el('div', { class: 'desc', style: { margin: '4px 2px 0', fontSize: '11px' }, text: 'Drag to pan · scroll to move · Ctrl/⌘ + scroll to zoom.' }));
    attachZoom(scroll, svg, W, totalH, true);  // container is replaced on each draw(), so no leak.
  };

  // --- Settings: everything under EnergyFlow that isn't a node, a link or a group.
  //
  // The generic config form deliberately hides EnergyFlow (these visual editors replace it), so each of
  // these had been dropped onto whichever page it affected — the MQTT export and the day boundary under
  // the hierarchy editor, the rest further down the same page. Answering "how is this rolled up?" meant
  // scrolling a diagram editor. They are the same controls, bound to the same document, in one place.
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

    // Zones come from the schema, which the server filled with the ones IT can resolve — a zone missing
    // from this list would not resolve at runtime either, so offering it would only produce a silent
    // fallback to the host zone.
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

    // The server's own clock, right where the boundary is set — it is the clock the day is cut on, and in a
    // container it is UTC unless someone set TZ. Not knowing that is how "Energy today" appears to reset at
    // 7pm for no reason.
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

    // Conservation back-fill. A switch you can see, because it is the one place the diagram states a number
    // nothing measured — sound arithmetic about the hierarchy you drew, and only as true as that hierarchy.
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

    // Two switches deliberately not gathered here: "Unmeasured load" and "Animate flow" sit on the diagram
    // itself. They change what you are looking at rather than what is configured, they are per-viewer
    // (browser-local, never saved), and a view switch on another page is one you cannot see the effect of.
    body.appendChild(el('div', { class: 'desc', style: { marginTop: '14px' } },
      'The “Unmeasured load” and “Animate flow” switches stay on the Flow page: they change what the diagram '
      + 'shows rather than what is configured, and they are per-browser — nothing here is saved by them.'));
  };

  // --- Hierarchy editor: a layered, left→right arrow graph (energy flows source → target). Drag from a
  //     node's right ● output port onto another node to add a directed feed. A node can have many feeders
  //     (a transfer switch fed by grid + generator + inverter) and producers are just feeds pointing into
  //     what they power (solar → inverter). Columns are auto-laid-out by depth to minimise crossings. ---
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

    // Edges: explicit directed Links, plus the auto PDU → outlet feed (suppressed once an outlet is
    // explicitly fed). `custom` edges are user links (deletable); auto edges are dashed and fixed.
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
    // Pull each node as far RIGHT as its nearest child allows (longest-path left-justifies every root, which
    // leaves a feeder that skips a tier — Battery → inverter, past Solar — trailing a long line across the
    // columns above it). A sink keeps its column; everyone else sits one step left of its earliest child, so
    // it lands right next to what it powers. Processed children-first (descending depth); every edge still
    // points strictly rightward because a node ends up strictly left of all its children.
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
        // Rename in place: double-click the node to relabel it. Only the Label changes — Id stays fixed, so
        // every link/source keyed off it survives. (Ids aren't editable here for exactly that reason.)
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

    // Interactions: drag a node's output port onto another node to add a directed feed. Map screen
    // coords through the SVG CTM so the drag line stays correct under zoom/scroll.
    const toUser = (cx        , cy        ) => new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse());
    let linkFrom      = null, tempLine      = null, hovered      = null;
    // Drag the empty canvas to pan (engages past a small threshold, so a click/double-click on a node or the
    // ✕ still registers). A port-drag creates a link instead — that path sets linkFrom and never pans.
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

  // A sub-page repaints with the data only while it is the page you are on — saving from the hierarchy
  // editor reloads the graph, and rebuilding a page nobody is looking at would drop a drag in progress.
  const redrawSubPages = () => {
    if (edPage.sec.classList.contains('active')) renderEditor();
    if (treePage.sec.classList.contains('active')) renderTree();
  };

  // The editor draws every node the diagram knows about, not just the configured ones, so it needs the
  // graph — reachable now without going via the Flow page first.
  const openSubPage = async (page     , render            ) => {
    activate(page.link, page.sec);
    if (!lastGraph) await load();
    render();
  };
  treePage.link.onclick = () => openSubPage(treePage, renderTree);
  edPage.link.onclick = () => openSubPage(edPage, renderEditor);
  settingsPage.link.onclick = () => { activate(settingsPage.link, settingsPage.sec); renderSettings(); };

  // The Sankey follows the readings while the tab is open (#281). Only the diagram is repainted — the
  // hierarchy editor and the tree are left alone, so a push can't yank the ground out from under a drag.
  //
  // Updates are ignored while a past moment is on screen. A push carries the current readings, and painting
  // them under a chosen date shows live figures labelled as that date — the plainest way to mislead.
  const syncLive = liveWhileActive(sec,
    () => 'flow:' + (metricSel.value || 'realpower') + (instSel.get() ? '|' + instSel.get() : ''),
    (body     ) => { if (hist.day() || !body || !body.ok) return; lastGraph = body; draw(body); });
  metricSel.addEventListener('change', () => syncLive());

  link.onclick = () => { activate(link, sec); syncLive(); load(); showDayNote(); };
}

// The dedicated Nodes tab (#129): configure the virtual nodes — kind, how they're valued, live-value
// bindings, and feeders/children — separate from the Flow visualization. Both edit the shared EnergyFlow.
// --- Focus a supply path --------------------------------------------------------------------------
// "Where does this node's power come from?" is the question the diagram is worst at once there are more
// than a handful of ribbons. Clicking a node lights everything upstream of it and dims the rest.
//
// Done by classing the <svg> and the elements on the path, never by rewriting their fill-opacity: that
// attribute already carries meaning (a hairline says the quantity is unknown), and overwriting it to dim
// would destroy the very thing the diagram is being read for.
let focusedNode                = null;

function focusPath(svg     , incoming     , id        ) {
  if (focusedNode === id) { clearFocus(svg); return; }
  focusedNode = id;

  // Everything that feeds it, transitively. Guarded against cycles even though the builder keeps the
  // graph acyclic — this walks whatever it is handed.
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
///
/// A highlight and not a filter: removing nodes from a Sankey removes the ribbons into them too, so a
/// node whose feeders were hidden would read as unsourced and the totals along the remaining chain would
/// no longer add up. Dimming answers "which of these are tagged X" without changing a single figure.
function focusTag(svg     , nodesById                  , tag        ) {
  const tagged = new Set        ();
  nodesById.forEach((n, id) => {
    if ((n.tags || []).some((t        ) => t.toLowerCase() === tag.toLowerCase())) tagged.add(id);
  });

  focusedNode = null;
  svg.querySelectorAll('[data-node]').forEach((e     ) =>
    e.classList[tagged.has(e.getAttribute('data-node')) ? 'add' : 'remove']('on-path'));
  // Ribbons stay dim throughout: a link is not tagged, and lighting one because an end happens to be
  // would say the flow itself is part of the selection.
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
// One element reused by every node, rather than one per node: the Sankey can hold hundreds of outlets.
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

// Ready-made device templates (EG4 inverters, meters, …), fetched once and cached.
let nodeTemplatesCache               = null;
async function loadNodeTemplates()                 {
  if (nodeTemplatesCache) return nodeTemplatesCache;
  const r = await api('/api/node-templates');
  nodeTemplatesCache = (r.body?.ok && r.body.templates) ? r.body.templates : [];
  return nodeTemplatesCache;
}

// Instantiate a template into the live config: create its Modbus connection (if any) and its pre-wired
// nodes/links, all under an id prefix so the same device can be imported more than once without clashes.
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

// The "Import device template" panel: pick a template, set an id prefix + Modbus host/unit, and drop the
// pre-wired nodes into the config for review.
/// Import power/energy readings other integrations announce over Home Assistant MQTT discovery.
///
/// Discovery is used rather than per-integration topic patterns because it states the unit, the device
/// class and the payload shape.
function renderDiscoverPanel(flow     , rerender            )              {
  const panel = el('div', { class: 'tpl-import' });
  panel.appendChild(el('div', {
    class: 'desc',
    text: 'Readings other integrations publish to this broker — power, energy, current, voltage, frequency. '
        + 'Pick the ones to add as nodes; nothing is created until you do, and nothing is saved until you '
        + 'press Save. Add topic shapes for other publishers under MQTT → ImportProfiles.',
  }));

  const bar = el('div', { class: 'ld-toolbar' });
  // Where to look. Discovery states the unit and device class, so it is the default; the topic profiles
  // exist for publishers that announce nothing, where the shape of the topic is all there is to go on.
  const srcSel = el('select', { style: { width: 'auto' } })                     ;
  srcSel.appendChild(el('option', { value: 'discovery', text: 'Home Assistant discovery' }));
  // The rest come from the server: built-in profiles plus MQTT.ImportProfiles.
  api('/api/mqtt/profiles').then((r     ) => {
    ((r.body && r.body.profiles) || []).forEach((p     ) =>
      srcSel.appendChild(el('option', { value: p.id, text: p.label + ' topics' })));
  });
  const tagIn = el('input', { type: 'text', value: 'imported', placeholder: 'tag (optional)' })                    ;
  // Where the imported nodes hang, and which way round. An appliance monitor is a load: the panel supplies
  // the fridge, not the reverse. Wiring it the other way adds its draw to the panel's total and counts it
  // twice, since the appliance is already inside the panel's unmeasured remainder.
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

  // Tagged on import so the per-destination filters can exclude them. A reading imported from Home
  // Assistant and re-exported to it arrives back as a second copy.
  tagIn.title = 'Applied to every node added here. Use it in a destination’s tag filter to avoid '
              + 'exporting these readings back to where they came from.';

  const picked = new Set        ();
  // Topics already bound anywhere in the config: a reading is "already imported" when its topic is bound,
  // not when some node happens to share its id. That lets a device's remaining metrics be added later.
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

      // A topic-matched reading carries no unit. The choices are the units FlowUnits accepts for this
      // metric; an unlisted string would not convert.
      const unitCell = el('td');
      if (r.unit) {
        unitCell.appendChild(el('span', { text: r.unit }));
      } else {
        const choices           = r.units || [];
        const unitSel = el('select', { style: { width: 'auto' } })                     ;
        unitSel.appendChild(el('option', { value: '', text: '— pick —' }));
        choices.forEach(u => unitSel.appendChild(el('option', { value: u, text: u })));
        // Pre-filled with the metric's canonical unit. It is a form default the operator reviews against
        // the sampled payload in the topic cell, and the bulk setters above change a whole metric at once.
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
    // Repeated below the table. With twenty rows the toolbar scrolls off the top, leaving the page's Save
    // button as the only visible action — and Save without Add writes a config with no imported nodes.
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

    // One setter per metric in the results: the answer is usually the same for every row of a metric
    // (every ESPHome power sensor is W), and differs between metrics.
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

    // One node per device, with a source per metric. A device publishing power, energy, current and
    // voltage is one thing with four readings, matching how a PDU outlet or an inverter is modelled.
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
        // 'lifetime': the daily figure is derived from it, and a counter that resets is handled by the
        // reset detection. 'period' declared wrongly publishes a cumulative total as today's.
        Accumulation: r.metric === 'energy' ? 'lifetime' : undefined,
        Unit: r.unit || undefined,
        JsonField: r.jsonField || undefined,
      }));
      readings.forEach(r => boundTopics.add(r.topic));

      // A second pass over the same device adds its remaining readings to the node already there. The node
      // has to be that device though: an ESPHome device called "grid" sanitises to the id of an existing
      // grid node, and appending an appliance's topics to it would bind one device's readings onto another.
      // Sameness is decided by the topics this scan found for the device, which is what an earlier import
      // of it would have bound.
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
        // 'none': an imported node is valued by its own bindings. 'auto' would aggregate children it does
        // not have.
        Mode: 'none',
        Sources: sources,
      };
      if (tag) node.Tags = [tag];
      nodes.push(node);
      added++;
      // One link per node, in the direction chosen. 'drawn from' makes the node a child of the target,
      // which is what an appliance monitor is.
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

/// Its own page under Integrations -> MQTT (#342 follow-on). It reads the broker rather than the PDU and
/// is used once when wiring something up, so it does not belong on the node editor's toolbar.
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
      // Mode 'none' by default: a brand-new node has nothing measuring it, and inferring a size for it (the
      // 'auto' share) invents a figure the user never entered. Opt into inference deliberately.
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
    ed.appendChild(renderNodeManager(flow, customNodes, links, cand, editing, (close          ) => { if (close) editing.id = null; render(); }));
  };

  const load = async () => {
    // The flow graph gives the auto (pdu/outlet) node ids for the feeder/children pickers; node config itself
    // is global, so a failed/empty graph just means fewer wiring candidates, not an error.
    const r = await api(withInstance('/api/flow', instSel));
    lastGraph = r.body?.ok ? r.body : null;
    render();
  };
  link.onclick = () => { activate(link, sec); load(); };
  // The editor panel is mounted on <body>, so switching pages would otherwise leave it floating over
  // whatever you switched to.
  nav.addEventListener('click', (e     ) => { if (nodeModal && !link.contains(e.target)) { editing.id = null; closeNodeModal(); } });
}

// The Energy overview (#energy-rollup C): an at-a-glance board of where power is flowing right now —
// solar in, battery charging/discharging, grid import/export, and the house load — summed from the nodes
// tagged solar/battery/grid. It reads the same live values everything else does; anything unmeasured shows
// "—", never a fabricated zero (the whole flow's accuracy rule). Battery/grid net uses the in-direction
// (charge/export) power from the #in cache key, so the arrows point the right way.
function addEnergyOverviewSection(nav     , sections     ) {
  const link = navLink(nav, "Energy", "⚡");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Energy Overview' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Where your power is flowing right now, from the latest poll. Figures are summed from the nodes you tagged solar / battery / grid; anything unmeasured shows “—”, never a guess. Tag nodes and bind their sources on the Nodes tab.' }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  // Power now, or energy for the day so far (#371). Two different questions: what the house is doing this
  // second, and what it has used since the period rolled over.
  const showSel = el('select', { style: { width: 'auto' } })                     ;
  showSel.appendChild(el('option', { value: 'realpower', text: 'Power (W)' }));
  showSel.appendChild(el('option', { value: 'energytoday', text: 'Energy today (kWh)' }));
  const instSel = instanceSelector(() => load());
  const status = el('span', { class: 'ld-count' });
  bar.append(refresh, el('span', { class: 'desc', style: { margin: '0' }, text: 'Show:' }), showSel, instSel.wrap, status);
  sec.appendChild(bar);
  // As on the Flow page: a whole day is an energy question, a specific time is a power one, and the choice
  // is a default at the moment of the pick rather than something re-imposed on every load.
  let hadDay = false;
  const hist = historyControl((what     ) => {
    const leftLive = what === 'day' && !hadDay && !!hist.day();
    hadDay = !!hist.day();
    if ((leftLive && !hist.time() && showSel.value === 'realpower') || (what === 'span' && hist.span() > 1))
      showSel.value = 'energytoday';
    load();
  });
  sec.appendChild(hist.row);
  showSel.onchange = () => load();

  // One column for the whole board, so the diagram and the tiles share an edge and read as a single
  // thing. Left to themselves the diagram centred itself in the page while the tiles bunched up against
  // the left margin, and the two looked unrelated.
  const board = el('div', { class: 'energy-board' }); sec.appendChild(board);
  const flowWrap = el('div', { class: 'energy-flow' }); board.appendChild(flowWrap);
  const grid = el('div', { class: 'energy-grid' }); board.appendChild(grid);
  const summary = el('div', { class: 'energy-summary' }); board.appendChild(summary);

  const fmtPower = (w               ) => w == null ? '—'
    : Math.abs(w) >= 1000 ? `${formatNum(w / 1000)} kW` : `${formatNum(Math.round(w))} W`;
  // Energy is cumulative (kWh); one decimal is plenty and the units come from the energy graph itself.
  const fmtEnergy = (v               , units        ) => v == null ? '—' : `${formatNum(Math.round(v * 10) / 10)} ${units || 'kWh'}`;

  // A tile: coloured accent, big power figure, a direction/idle sub-line.
  // A dial drawn only against a ceiling somebody stated. Nothing here invents a maximum: without one the
  // tile shows the plain reading, which is the honest rendering of a quantity whose limit nobody has given.
  // Mirrors Core.Flow.Gauge, which owns the arithmetic and its edge cases.
  const gaugeArc = (fraction        , over         ) => {
    const R = 26, CX = 30, CY = 30;
    // A 240° sweep opening at the bottom — the shape a dial is read as, rather than a full ring which has
    // no start and therefore no "empty".
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
                gauge                                                                  ) => {
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
    return t;
  };

  /// The gauge for a node, or undefined when one would be a guess. Reads Max straight from the config the
  /// Nodes tab edits, so setting it takes effect on the next refresh with no restart.
  const gaugeFor = (ids          , value               , units        ) => {
    const cfgNodes = (state.data?.EnergyFlow?.Nodes || [])         ;
    // Several tagged nodes of one kind (three MPPTs, two arrays) sum into one tile, so their ceilings sum too.
    const maxes = ids.map(id => cfgNodes.find(n => n.Id === id)?.Max).filter((m     ) => typeof m === 'number' && m > 0);
    if (!maxes.length || value == null) return undefined;
    const max = maxes.reduce((a        , b        ) => a + b, 0);
    const fraction = Math.min(1, Math.max(0, value / max));
    return { fraction, over: value > max, max, units };
  };

  // The animated flow diagram: a central hub with Solar (top), Grid (left), Battery (right) and Home (bottom),
  // particles streaming along each arm in the real direction of flow — toward the hub when a source supplies,
  // away when it draws (charge/export/consumption). Speed and particle count scale with power; an unknown or
  // idle arm just shows a dim static line, never invented motion.
  const HUB = { x: 220, y: 150 };
  const NODEPOS                                           = {
    solar: { x: 220, y: 46 }, grid: { x: 66, y: 150 }, battery: { x: 374, y: 150 }, home: { x: 220, y: 254 },
  };
  const drawFlow = (arms                                                                                                  ) => {
    flowWrap.innerHTML = '';
    // Frame only the arms that exist. The four positions describe the full cross (solar top, grid left,
    // battery right, home bottom); a fixed 440x300 box therefore reserved the whole bottom of the diagram
    // for a home arm that most setups never tag, leaving a tall band of blank space under it that the
    // board had to push the tiles past. Fit the box to what is actually drawn instead.
    // Only the vertical extent is fitted. The width stays the full cross (grid .. battery), because the
    // SVG is laid out at 100% width and its height follows from the aspect ratio — narrowing the box for a
    // one-armed system would make it render absurdly tall.
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
      nodes.appendChild(g);
    });

    // A small hub dot where the arms meet.
    nodes.appendChild(svgEl('circle', { cx: HUB.x, cy: HUB.y, r: 5, class: 'energy-hub' }));
    flowWrap.appendChild(svg);
  };

  // Why is this tile empty? "No reading yet" is a dead end — it doesn't say whether the node has no source
  // bound at all, or has one that has never delivered. The configured hierarchy is already in the browser,
  // so answer it here and point at the thing to go fix.
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

  // Same question for the battery's state of charge, which has its own source and so its own reasons to be
  // blank. A bare "—" cannot be acted on: a battery with no soc source bound and one bound to a topic that
  // never publishes look identical on screen and need completely different fixes. This happened for real —
  // a soc source pointed at a topic name the publisher does not use, so power read fine and the percentage
  // sat empty with nothing on the page to say why. Name the topic; that is the thing to check.
  const whyNoSoc = (battIds          , liveInfo                     ) => {
    const cfg = (state.data?.EnergyFlow?.Nodes || []).filter((n     ) => battIds.includes(n.Id));
    if (!cfg.length) return 'no battery node';
    const socSrcs = cfg.flatMap((n     ) => (n.Sources || []).filter((s     ) => s.Metric === 'soc'));
    if (!socSrcs.length) return 'no charge source bound';
    // Bound and expired: the endpoint still reports the last reading, so say how old it is rather than
    // showing a figure that is no longer true.
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

  // Sum a kind's out-direction (graph) values. Returns present (any nodes of this kind) and the known sum
  // (null when nodes exist but none has a value) so we can tell "no grid" from "grid, value unknown".
  const sumKind = (nodes       , kind        ) => {
    const ns = nodes.filter(n => (n.kind || 'node') === kind);
    let sum = 0, known = false;
    ns.forEach(n => { if (typeof n.value === 'number') { sum += n.value; known = true; } });
    return { present: ns.length > 0, value: known ? sum : null };
  };

  // The board needs several round-trips, and it is now triggered by pushes as well as by the timer and
  // the button — so never let a second pass start on top of one still in flight.
  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    try { await loadBoard(); } finally { loading = false; }
  };

  const loadBoard = async () => {
    // The whole board reads one metric (#371). Power and energy-today are the same shape — a value per
    // node plus an in-direction for the bidirectional ones — so the tiles are built once and the metric
    // decides what they mean.
    const metric = showSel.value || 'realpower';
    const isEnergy = metric !== 'realpower';
    let r     ;
    const at = hist.at();
    let path = withInstance('/api/flow' + (isEnergy ? '?metric=' + encodeURIComponent(metric) : ''), instSel);
    const past = historyQuery(hist);
    if (past) path += (path.includes('?') ? '&' : '?') + past.slice(1);
    try { r = await api(path); }
    catch (e     ) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    grid.innerHTML = ''; summary.innerHTML = ''; flowWrap.innerHTML = '';
    if (!r.body || !r.body.ok) {
      // Say what actually went wrong. A bare "could not load" leaves you with nowhere to start; the
      // server's own message is the useful thing, and its HTTP status is the fallback.
      const why = (r.body && r.body.message) || `the server answered ${r.status ?? '?'} with no explanation`;
      grid.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'Could not load energy data — ' + why }));
      status.textContent = ''; return;
    }
    // Derived lanes are for the diagram, not the totals. The graph carries synthetic nodes the builder
    // adds to make the picture balance — a bidirectional node's return lane (`battery#in`, `grid#in`) and
    // a pass-through's unmetered remainder (`…#unmeasured`). The return lanes deliberately inherit their
    // parent's kind so they colour and read as the same device, which means a plain sumKind('battery')
    // would add charge to discharge and sumKind('grid') would add export to import — the tiles would
    // report a battery doing both at once. These tiles compute the in-direction themselves, from the live
    // cache, a few lines below. '#' appears in no real id (PDU and outlet ids use ':'), so it is a safe
    // marker for "the builder made this".
    hist.setNote(historyNote(r.body));
    const nodes = (r.body.nodes || []).filter((n     ) => !String(n.id || '').includes('#'));

    // Live cache reads: the in-direction (charge/export) power for battery/grid nodes, plus battery state of
    // charge — none of which the flow graph carries. Keyed by node|metric so one round-trip covers them all.
    const battIds = nodes.filter((n     ) => n.kind === 'battery').map((n     ) => n.id);
    const gridIds = nodes.filter((n     ) => n.kind === 'grid').map((n     ) => n.id);
    // The other two kinds, for the gauges: a tile sums every node of its kind, so its ceiling sums too.
    const solarIds = nodes.filter((n     ) => n.kind === 'solar').map((n     ) => n.id);
    const loadIds = nodes.filter((n     ) => n.kind === 'load').map((n     ) => n.id);
    const liveBy                         = {};
    // The full record, not just the value: it carries the staleness fields (reported/ageSeconds/fresh),
    // which are the only way to tell a source that has expired from one that never published at all.
    const liveInfo                      = {};
    const q = [
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
    const sumIn = (ids          ) => { let s = 0, known = false; ids.forEach(id => { const k = `${id}|${metric}#in`; if (k in liveBy) { s += liveBy[k]; known = true; } }); return known ? s : null; };
    // Battery SoC: average across battery nodes that report it (a bank reads as one figure).
    const socVals = battIds.map(id => liveBy[`${id}|soc`]).filter((v)              => typeof v === 'number');
    const soc = socVals.length ? Math.round(socVals.reduce((a, b) => a + b, 0) / socVals.length) : null;

    // Formatting and gauges follow the metric. A node's Max is a full-scale power figure, so a dial against
    // it means nothing for kWh — the tile shows the plain reading instead.
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

    // Home load: prefer explicitly-tagged load nodes; otherwise derive from the balance, but only when every
    // present source is known (an unknown feeder would make the balance a guess — so it shows "—" instead).
    let home                = null, homeSub = '';
    if (load_.present) { home = load_.value; homeSub = home == null ? 'no reading yet' : 'consuming'; }
    else {
      const unknownFeeder = (solar.present && solar.value == null) || (batt.present && batt.value == null) || (gridK.present && gridK.value == null);
      if (!unknownFeeder && (solar.present || batt.present || gridK.present)) {
        home = (solar.value || 0) + (battNet || 0) + (gridNet || 0);
        homeSub = 'balance of measured sources';
      }
    }

    // Self-sufficiency is an ENERGY question — over some window, what share of the home's kWh came from
    // solar + battery rather than the grid — so it is answered over the window the board is showing.
    //
    // It used to fetch lifetime energy unconditionally. Under a chosen day that put a figure describing all
    // time beneath tiles describing that day: the bar did not move when the day did, and the two contradicted
    // each other on the same screen.
    let eHome                = null, eFromGrid                = null, eUnits = 'kWh';
    let eWindow = 'of lifetime energy';
    if (isEnergy) {
      // The board is already an energy view, so the bar is a share of the very tiles above it. No second
      // read, and no second way of deriving the same numbers that could disagree with them.
      eHome = home;
      eUnits = units;
      // Energy drawn from the grid is what it imported. Netting export off first would let a house that
      // imported 10 kWh and exported 10 read as fully self-sufficient, which it was not.
      eFromGrid = gridK.value == null ? null : Math.max(0, gridK.value);
      const day = hist.day();
      eWindow = day ? `of energy on ${new Date(hist.at()).toLocaleDateString()}`
        : metric === 'energytoday' ? 'of today’s energy' : 'of lifetime energy';
    } else try {
      const er = await api(withInstance('/api/flow?metric=energy', instSel));
      if (er.body?.ok) {
        const enodes = er.body.nodes || [];
        eUnits = er.body.units || 'kWh';
        const eSolar = sumKind(enodes, 'solar'), eBatt = sumKind(enodes, 'battery'), eGrid = sumKind(enodes, 'grid'), eLoad = sumKind(enodes, 'load');
        // In-direction (charge/export) energy from the same live cache, keyed energy#in.
        const eInBy                         = {};
        const eq = [...battIds, ...gridIds].map(id => ({ Node: id, Metric: 'energy#in' }));
        if (eq.length) {
          try {
            const elr = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eq) });
            (elr.body?.values || []).forEach((v     ) => { if (typeof v.value === 'number') eInBy[`${v.node}|${v.metric}`] = v.value; });
          } catch { /* no live cache — energy#in just stays absent */ }
        }
        const eSumIn = (ids          ) => { let s = 0, known = false; ids.forEach(id => { const k = `${id}|energy#in`; if (k in eInBy) { s += eInBy[k]; known = true; } }); return known ? s : null; };
        const eBattNet = net(eBatt, eSumIn(battIds)), eGridNet = net(eGrid, eSumIn(gridIds));
        // Home energy: tagged load nodes if present, else the balance of measured sources (same rule as power).
        if (eLoad.present) eHome = eLoad.value;
        else {
          const unknownFeeder = (eSolar.present && eSolar.value == null) || (eBatt.present && eBatt.value == null) || (eGrid.present && eGrid.value == null);
          if (!unknownFeeder && (eSolar.present || eBatt.present || eGrid.present)) eHome = (eSolar.value || 0) + (eBattNet || 0) + (eGridNet || 0);
        }
        // What the house drew, not what it drew net of what it sent back: exported energy is not
        // consumption avoided, and netting it off overstates the share solar covered.
        if (eGrid.value != null) eFromGrid = Math.max(0, eGrid.value);
      }
    } catch { /* energy graph unavailable — self-sufficiency just won't render */ }

    // Animated flow diagram — the arms present in this system, each with its live figure and flow direction.
    const arms        = [];
    if (solar.present) arms.push({ key: 'solar', icon: '☀️', label: 'Solar', text: fmt(solar.value), color: 'var(--warn)', flow: solar.value });
    if (batt.present || battIds.length) arms.push({ key: 'battery', icon: '🔋', label: 'Battery', text: soc != null ? `${soc}%` : fmt(battNet == null ? null : Math.abs(battNet)), color: 'var(--good)', flow: battNet });
    if (gridK.present || gridIds.length) arms.push({ key: 'grid', icon: '⚡', label: 'Grid', text: fmt(gridNet == null ? null : Math.abs(gridNet)), color: 'var(--accent)', flow: gridNet });
    if (home != null || load_.present) arms.push({ key: 'home', icon: '🏠', label: 'Home', text: fmt(home), color: 'var(--muted)', flow: home });
    if (arms.length) drawFlow(arms);

    // Solar
    if (solar.present)
      grid.appendChild(tile('solar', '☀️', 'Solar', fmt(solar.value),
        subOrWhy(solar.value, 'solar', solar.value  > 1 ? 'producing' : 'idle'), solar.value && solar.value > 1 ? 'supply' : '',
        dial(solarIds, solar.value)));

    // Battery — sign tells charge vs discharge; magnitude is what's shown. SoC (when bound) leads the sub-line.
    if (batt.present || battIds.length) {
      const dir = subOrWhy(battNet, 'battery', battNet  > 1 ? 'discharging' : battNet  < -1 ? 'charging' : 'idle');
      const cls = battNet == null ? '' : battNet > 1 ? 'supply' : battNet < -1 ? 'draw' : '';
      // SoC always leads the sub-line — so the state-of-charge slot is always shown rather than silently
      // vanishing. When it is blank it says why (unbound / stale / never delivered) instead of just "—",
      // because "—" gives the operator nothing to go and fix.
      const socWhy = soc == null ? whyNoSoc(battIds, liveInfo) : null;
      // The dial is the battery's power against its rating; the slim bar below is state of charge. Two
      // different quantities, so they are two different marks rather than one doing double duty.
      const t = tile('battery', '🔋', 'Battery', fmt(battNet == null ? null : Math.abs(battNet)), `${soc == null ? socWhy : soc + '%'} · ${dir}`, cls,
        dial(battIds, battNet == null ? null : Math.abs(battNet)));
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
      // On energy the figure is the day's NET — import minus export, signed (#371). A magnitude would read
      // the same for a day that imported 5 kWh and one that exported 5 kWh.
      const gridShown = gridNet == null ? null : isEnergy ? gridNet : Math.abs(gridNet);
      grid.appendChild(tile('grid', '⚡', 'Grid', fmt(gridShown),
        isEnergy ? `${sub} · net for the day` : sub, cls,
        dial(gridIds, gridNet == null ? null : Math.abs(gridNet))));
    }

    // Home load (computed above with the flow arms).
    if (home != null || load_.present)
      grid.appendChild(tile('home', '🏠', 'Home', fmt(home), home == null ? whyNoReading('load') : (homeSub || 'consuming'), '',
        dial(loadIds, home)));

    // Self-sufficiency: the share of the home's energy (kWh) over the window above that was NOT drawn from
    // the grid. Only when the home energy and grid import both resolve and the house has actually used
    // energy; anything else would be dividing a guess.
    if (eHome != null && eHome > 0 && eFromGrid != null) {
      const covered = Math.max(0, eHome - eFromGrid);
      const pct = Math.max(0, Math.min(100, Math.round((covered / eHome) * 100)));
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

  // The board is assembled from several reads (the graph, the in-direction live values, the energy graph),
  // so the push is used as a *trigger*: when the server says the flow moved, rebuild the board. That keeps
  // one source of truth for how the figures are derived while making the page react in ~2s instead of 8.
  // Both the push and the fallback timer are held while a past moment is on screen: a reload would fetch
  // the chosen instant again, but it would also overwrite a view the operator is reading with a fresh one
  // every couple of seconds.
  const syncLive = liveWhileActive(sec, () => 'flow:realpower' + (instSel.get() ? '|' + instSel.get() : ''),
    () => { if (!hist.day()) load(); });
  // Fallback for when the stream isn't up; it does nothing while it is.
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive() && !hist.day()) load(); }, 8000);
  link.onclick = () => { activate(link, sec); syncLive(); load(); };
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
    if (onlyProblems.checked) list = list.filter(r => { const v = live[keyOf(r)]; return r.fixed == null && (!v || v.reported == null || v.fresh === false); });

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

      const val = el('td', { class: 'num' });
      if (r.fixed != null) val.append(el('span', { text: `${formatNum(r.fixed)} ${metricUnit(r.metric)}`.trim() }));
      else if (v && v.reported != null) val.append(el('span', { text: `${formatNum(v.reported)} ${metricUnit(r.metric)}`.trim() }));
      else { val.append(el('span', { style: { color: 'var(--muted)' }, text: '—' })); missing++; }
      tr.appendChild(val);

      const upd = el('td');
      if (r.fixed != null) upd.append(el('span', { class: 'desc', text: 'fixed' }));
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
// v3: the verdicts come from the component grains via /api/status — this file only renders them. Deciding
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

  // A card's detail is the static part plus, where the grain asked for it, the aged instant it carries.
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
    (node.enumValues || []).forEach((v        ) => { const o = document.createElement('option'); o.value = v; o.textContent = v === '' ? '(default)' : v; el.appendChild(o); });
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
    f.appendChild(node.type === 'bool' ? switchWrap(input) : input);
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

const NAV_GROUPS                                        = [
  // Sources: the Vertiv rPDU integration is the parent; its PDU-only tabs hang off it as children.
  { title: 'Sources', items: [{ schema: 'Pdus' }, { schema: 'Overrides', child: true }, { tool: addLiveDataSection, child: true }, { tool: addControlSection, child: true }, { tool: addPathsSection, child: true }] },
  { title: 'Energy Flow', items: [{ tool: addEnergyOverviewSection }, { tool: addNodesSection }, { tool: addFlowSection }, { tool: addNodeDataSection }] },
  { title: 'Integrations', items: [{ schema: 'MQTT' }, { tool: addMqttImportSection, child: true }, { schema: 'Modbus' }] },
  { title: 'Destinations', items: [{ schema: 'EmonCMS' }, { schema: 'HomeAssistant' }, { tool: addHaEnergySection, child: true }, { schema: 'Prometheus' }] },
  { title: 'System', items: [{ tool: addFeaturesSection }, { schema: 'Gui' }, { schema: 'Api' }, { schema: 'Health' }, { schema: 'Logging' }, { schema: 'Debug' }, { tool: addExportSection }, { tool: addDiagnosticsSection }] },
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
      // EnergyDashboard has its own "HA Energy Mapping" tab, so don't also render it in the HA form.
      let props = node.key === 'HomeAssistant' ? (node.properties || []).filter((p     ) => p.key !== 'EnergyDashboard') : node.properties;
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
      renderObjectBody(props, state.data[node.key], sec, [node.key]);
    }
    else renderNode(node, state.data, sec, []);
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
  const HIDDEN = new Set(['EnergyFlow']);
  // Any schema section not explicitly grouped (and not hidden) lands in System, so a new one is never lost.
  const knownSchema = new Set(NAV_GROUPS.flatMap(g => g.items.filter(i => 'schema' in i).map((i     ) => i.schema)));
  const system = NAV_GROUPS.find(g => g.title === 'System') ;
  state.schema.forEach((n     ) => { if (!knownSchema.has(n.key) && !HIDDEN.has(n.key)) system.items.push({ schema: n.key }); });

  // The landing page: a status board, rendered first so it's the default tab (#186).
  const home = addHomeSection(nav, sections);
  const first      = home.link;

  for (const g of NAV_GROUPS) {
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

async function runTest(what        , path        )                      {
  let out            ;
  try {
    const r = await api(path, { method: 'POST' });
    out = {
      ok: !!(r.body && r.body.ok),
      message: (r.body && r.body.message)
        || (r.ok ? `${what}: the test answered without saying anything.` : `${what}: the bridge answered ${r.status}.`),
    };
  } catch (e     ) {
    out = { ok: false, message: `${what}: could not reach the bridge (${e?.message || e}).` };
  }
  toast(out.message, out.ok);
  return out;
}

async function testMqtt() { const r = await runTest('MQTT', '/api/test/mqtt'); refreshStatus(); return r; }
async function testPdu() { return runTest('PDU', '/api/test/pdu'); }
async function testEmonCms() { const r = await runTest('EmonCMS', '/api/test/emoncms'); refreshStatus(); return r; }
async function testHistory() { const r = await runTest('History', '/api/test/history'); refreshStatus(); return r; }
async function provisionEmonCmsFeeds() { toast('Provisioning EmonCMS feeds…', true); const r = await api('/api/emoncms/provision-feeds', { method: 'POST' }); toast(r.body.message, r.body.ok); }
async function deleteEmonCmsFeeds() {
  if (!confirm('⚠️ DELETE ALL EmonCMS feeds created by rPDU2MQTT?\n\n'
    + 'This PERMANENTLY deletes every feed under rPDU2MQTT’s tag/node — and ALL of their stored history in EmonCMS.\n\n'
    + 'It CANNOT be undone. Any EmonCMS dashboards, graphs, apps or virtual feeds that use these feeds will break.\n\n'
    + 'Only continue if you intend to wipe and rebuild them.')) return;
  if (!confirm('Are you absolutely sure?\n\nThis is your last chance to cancel before every rPDU2MQTT feed and its data are destroyed.')) return;
  const typed = prompt('Final confirmation — type  DELETE  (all caps) to permanently delete all rPDU2MQTT feeds:');
  if (typed !== 'DELETE') { toast('Cancelled — nothing was deleted.', false); return; }
  toast('Deleting EmonCMS feeds…', true);
  const r = await api('/api/emoncms/delete-feeds', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}
async function rediscoverHa() { toast('Requesting discovery…', true); const r = await api('/api/discovery/rediscover', { method: 'POST' }); toast(r.body.message, r.body.ok); }
async function clearHa() {
  if (!confirm('Clear ALL Home Assistant discovery messages published by rPDU2MQTT — including any left over '
    + 'from earlier versions or configurations? Every entity disappears from Home Assistant until discovery '
    + 'runs again. Nothing belonging to another integration is touched.')) return;
  const r = await api('/api/discovery/clear', { method: 'POST' });
  toast(r.body.message, r.body.ok);
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

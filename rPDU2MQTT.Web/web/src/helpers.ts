// Generic, dependency-free helpers: fetch wrapper, DOM builders, the toast, tab activation, the SVG
// zoom helper, and the multi-PDU instance selector.

// `status` is carried so a caller can say *why* a call failed when the response had no message of its
// own — an empty or non-JSON body reads as a bare "couldn't load it" otherwise, which says nothing.
export const api = (p: string, opt?: any) => fetch(p, opt).then(async r => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));

export function ensure(obj: any, key: string, fallback: any) { if (obj[key] === undefined || obj[key] === null) obj[key] = fallback; return obj[key]; }

// --- DOM helpers ---------------------------------------------------------------------------------
// Create an element with optional props and children, to cut createElement/append boilerplate.
export function el(tag: string, props?: any, ...children: any[]): any {
  const e: any = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k === 'text') e.textContent = v;
    else if (k in e) e[k] = v; else e.setAttribute(k, v as any);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
// A small ".small" button (add a class like "danger"/"primary" via cls).
export function btn(label: string, cls?: string): any { return el('button', { class: 'small' + (cls ? ' ' + cls : ''), text: label }); }

export function formatNum(v: any) { return (typeof v === 'number' && Number.isFinite(v)) ? v.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(v); }

// Units that step by a thousand, smallest first. Only the ones where a reading realistically crosses the
// boundary: a diagram reading "6,744 W" is four digits of precision nobody asked for, while amps and volts
// stay put because 1,000 A is not a number this measures.
const UNIT_STEPS: string[][] = [
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
export function formatMeasure(value: any, units?: string): string {
  const u = (units || '').trim();
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${formatNum(value)} ${u}`.trim();

  const ladder = UNIT_STEPS.find(l => l.some(x => x === u));
  const start = ladder ? ladder.indexOf(u) : -1;
  if (start < 0) return `${formatNum(value)} ${u}`.trim();

  let v = value, i = start;
  while (Math.abs(v) >= 1000 && i < ladder!.length - 1) { v /= 1000; i++; }
  // Unscaled values keep the caller's existing precision; a scaled one gets three significant figures.
  if (i === start) return `${formatNum(v)} ${u}`.trim();
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return `${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${ladder![i]}`;
}

// SVG element helper (separate namespace from el()).
export function svgEl(tag: string, attrs?: any): any {
  const e: any = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v as any);
  return e;
}

// Stacked, self-dismissing toasts. The old one was a single <span> in the save bar: a second message
// silently replaced the first, and anything raised while you were scrolled down was never seen at all.
// Same signature, so every existing caller keeps working.
export function toast(msg: string, good?: boolean) {
  const host: any = document.getElementById('toasts');
  if (!host || !msg) return;
  const cls = 'toast ' + (good ? 'good' : 'bad');
  // Repeating the same message (a per-item loop reporting each result) just refreshes the existing one.
  const last: any = host.lastChild;
  if (last && last.dataset && last.dataset.msg === msg) { clearTimeout(last._timer); last.className = cls; last._timer = setTimeout(() => dismissToast(last), toastLife(msg)); return; }

  const t: any = el('div', { class: cls });
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
function toastLife(msg: string) { return Math.min(14000, 4000 + msg.length * 45); }
function dismissToast(t: any) {
  if (!t || t._gone) return;
  t._gone = true; clearTimeout(t._timer); t.classList.add('leaving');
  setTimeout(() => t.remove(), 200);
}

// --- Overlay sheet -------------------------------------------------------------------------------
// A centered modal panel used by the command palette and the change review. Returns { close }.
// Only one is open at a time; Esc and a backdrop click both dismiss it.
export function openSheet(opts: any) {
  const overlay: any = document.getElementById('overlay');
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
  if (opts.footer) { const f = el('div', { class: 'sheet-foot' }); (opts.footer as any[]).forEach(b => f.appendChild(b)); sheet.appendChild(f); }

  overlay.innerHTML = '';
  overlay.appendChild(sheet);
  overlay.classList.remove('is-hidden');
  overlay.onclick = (e: any) => { if (e.target === overlay) close(); };
  openSheetEsc = opts.onClose;
  return { close, body };
}
let openSheetEsc: any = null;
export function closeSheet() {
  const overlay: any = document.getElementById('overlay');
  if (!overlay || overlay.classList.contains('is-hidden')) return;
  overlay.classList.add('is-hidden');
  overlay.innerHTML = '';
  const fn = openSheetEsc; openSheetEsc = null;
  if (typeof fn === 'function') fn();
}
export function sheetIsOpen() {
  const overlay: any = document.getElementById('overlay');
  return !!overlay && !overlay.classList.contains('is-hidden');
}

// Copy text, and say honestly whether it worked. navigator.clipboard only exists in a secure context, and
// this GUI is usually reached over plain http on a LAN — so fall back to the old selection trick rather than
// silently doing nothing while claiming "Copied".
export async function copyText(text: string): Promise<boolean> {
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
export function copyOnClick(node: any, text: string, label?: string) {
  node.style.cursor = 'pointer';
  node.title = 'Click to copy';
  node.onclick = async () => {
    const ok = await copyText(text);
    toast(ok ? `Copied: ${label || text}` : 'Could not copy — your browser blocked it (try selecting the text).', ok);
  };
  return node;
}

// A URL-friendly slug for a nav label (used to put the active tab in the address bar).
export function slug(text: string): string {
  return (text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// A nav entry: a leading glyph, the label, and room for a badge. The label also lives in `dataset.label`
// because textContent now includes the glyph — everything that identifies a page (hash slugs, the
// palette, the tests) reads navLabel(), never the raw text.
export function navLink(nav: any, label: string, icon?: string) {
  const a: any = el('a');
  a.dataset.label = label;
  // These are clickable <a>s with no href, so they need the focus + keyboard behaviour spelled out.
  a.tabIndex = 0;
  a.setAttribute('role', 'link');
  a.onkeydown = (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.click(); } };
  a.append(el('span', { class: 'nav-icon', text: icon || '•' }), el('span', { class: 'nav-label', text: label }));
  nav.appendChild(a);
  return a;
}
export function navLabel(link: any) { return (link?.dataset?.label || link?.textContent || '') as string; }

export function activate(link: any, sec: any) {
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
export function attachZoom(scroll: any, svg: any, baseW: number, baseH: number, pan = false) {
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
  const zoomAbout = (clientX: number, clientY: number, factor: number) => {
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

  const onWheel = (e: any) => {
    if (!(e.ctrlKey || e.metaKey)) return;   // plain wheel: let the container scroll normally
    e.preventDefault();
    zoomAbout(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  };
  scroll.addEventListener('wheel', onWheel, { passive: false });
  const cleanups = [() => scroll.removeEventListener('wheel', onWheel)];

  // --- Pinch, for touch and trackpad-as-pointer. Two live pointers own the gesture; one is a pan.
  const pts = new Map<number, { x: number, y: number }>();
  let pinchFrom = 0;
  const spread = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e: any) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) pinchFrom = spread();
  };
  const onPointerMove = (e: any) => {
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
  const forget = (e: any) => { pts.delete(e.pointerId); if (pts.size < 2) pinchFrom = 0; };

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
    const onDown = (e: any) => {
      if (e.button !== 0 || pts.size > 1) return;
      armed = true; panning = false; sx = e.clientX; sy = e.clientY; sl = scroll.scrollLeft; st = scroll.scrollTop;
    };
    // Track on window so a drag that runs past the container edge keeps panning until release.
    const onMove = (e: any) => {
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
  let ro: any = null;
  try {
    ro = new (globalThis as any).ResizeObserver(() => { if (!chosen) fit(); });
    ro.observe(scroll);
    cleanups.push(() => ro.disconnect());
  } catch { /* no ResizeObserver: the fit on open is what matters */ }

  const detach = () => cleanups.forEach(f => f());
  (detach as any).fit = () => { chosen = false; fit(); };
  /// Zoom from a button rather than a gesture: about the middle of the pane, which is what someone looking
  /// at the pane is looking at.
  (detach as any).zoomBy = (factor: number) => {
    const r = scroll.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    zoomAbout(r.left + r.width / 2, r.top + r.height / 2, factor);
  };
  return detach;
}

// --- Multi-PDU: per-tab instance selector ---
let _instancesCache: any = null;
export async function getInstances() {
  if (_instancesCache) return _instancesCache;
  const r = await api('/api/instances');
  _instancesCache = (r.body && r.body.ok) ? (r.body.instances || []) : [];
  return _instancesCache;
}
// A per-tab PDU instance picker. Returns { wrap, get } — append `wrap` to a toolbar; `get()` is the
// selected instance id. Stays hidden when only one instance is configured (single-PDU UX unchanged);
// then get() === '' so the backend falls back to the primary. `onChange` fires when the user switches.
export function instanceSelector(onChange?: (id: string) => void) {
  const sel: any = el('select');
  const wrap = el('label', { class: 'ld-inst', style: { display: 'none' } }, 'Instance ', sel);
  getInstances().then((list: any[]) => {
    if (list.length <= 1) return;
    list.forEach(i => sel.appendChild(el('option', { value: i.id, text: i.id + (i.primary ? ' (primary)' : '') })));
    sel.value = (list.find(i => i.primary) || list[0]).id;
    wrap.style.display = '';
  });
  sel.onchange = () => onChange && onChange(sel.value);
  return { wrap, get: () => sel.value || '' };
}
// Append `?instance=<id>` to a path when an instance is selected (empty -> primary, omit the param).
export function withInstance(path: string, instSel: any) {
  const v = instSel.get();
  return v ? path + (path.includes('?') ? '&' : '?') + 'instance=' + encodeURIComponent(v) : path;
}

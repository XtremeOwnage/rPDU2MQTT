// Generic, dependency-free helpers: fetch wrapper, DOM builders, the toast, tab activation, the SVG
// zoom helper, and the multi-PDU instance selector.

export const api = (p: string, opt?: any) => fetch(p, opt).then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }));

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

// SVG element helper (separate namespace from el()).
export function svgEl(tag: string, attrs?: any): any {
  const e: any = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v as any);
  return e;
}

export function toast(msg: string, good?: boolean) { const t: any = document.getElementById('toast'); t.textContent = msg; t.className = 'toast ' + (good ? 'good' : 'bad'); }

// A URL-friendly slug for a nav label (used to put the active tab in the address bar).
export function slug(text: string): string {
  return (text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function activate(link: any, sec: any) {
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  link.classList.add('active'); sec.classList.add('active');
  // Reflect the active tab in the URL hash so a refresh (or a shared link) reopens it. Only write when it
  // actually changes, to avoid spurious history entries / hashchange loops (see the listener in main.ts).
  const s = slug(link.textContent);
  if (s && decodeURIComponent((location.hash || '').slice(1)) !== s) location.hash = s;
}

// Mouse-wheel zoom for an SVG inside a scroll container. The SVG must carry a viewBox of its base size;
// we scale by setting its width/height and keep the point under the cursor fixed. Returns a detach fn.
export function attachZoom(scroll: any, svg: any, baseW: number, baseH: number) {
  let z = 1; const min = 0.25, max = 6;
  const apply = () => { svg.setAttribute('width', Math.round(baseW * z)); svg.setAttribute('height', Math.round(baseH * z)); };
  apply();
  const onWheel = (e: any) => {
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
  return () => scroll.removeEventListener('wheel', onWheel);
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

// Highlighting on the flow chart: the supply path behind a node, the nodes carrying a tag, and the hover
import { btn, el } from './helpers.js';

export let activeTag: string | null = null;

/// Chips for every tag in use, highlighting the nodes carrying it (#342).
export function tagToggles(nodes: any[], svg: any, apply: (tag: string | null) => void): HTMLElement | null {
  const all = new Map<string, string>();   // lower-case key -> first spelling seen
  nodes.forEach(n => (n.tags || []).forEach((t: string) => {
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

// The dedicated Nodes tab (#129): configure the virtual nodes — kind, how they're valued, live-value
export let focusedNode: string | null = null;

export function focusPath(svg: any, incoming: any, id: string) {
  if (focusedNode === id) { clearFocus(svg); return; }
  focusedNode = id;

  // Everything that feeds it, transitively. Guarded against cycles even though the builder keeps the
  const onPath = new Set<string>([id]);
  const links = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    (incoming[cur] || []).forEach((l: any) => {
      links.add(l.source + '' + l.target);
      if (!onPath.has(l.source)) { onPath.add(l.source); stack.push(l.source); }
    });
  }

  svg.querySelectorAll('[data-node]').forEach((e: any) =>
    e.classList[onPath.has(e.getAttribute('data-node')) ? 'add' : 'remove']('on-path'));
  svg.querySelectorAll('[data-src]').forEach((e: any) =>
    e.classList[links.has(e.getAttribute('data-src') + '' + e.getAttribute('data-dst')) ? 'add' : 'remove']('on-path'));
  svg.classList.add('flow-focus');
}

/// Highlight every node carrying `tag`, dimming the rest (#342).
export function focusTag(svg: any, nodesById: Map<string, any>, tag: string) {
  const tagged = new Set<string>();
  nodesById.forEach((n, id) => {
    if ((n.tags || []).some((t: string) => t.toLowerCase() === tag.toLowerCase())) tagged.add(id);
  });

  focusedNode = null;
  svg.querySelectorAll('[data-node]').forEach((e: any) =>
    e.classList[tagged.has(e.getAttribute('data-node')) ? 'add' : 'remove']('on-path'));
  // Ribbons stay dim throughout: a link is not tagged, and lighting one because an end happens to be
  svg.querySelectorAll('[data-src]').forEach((e: any) => e.classList.remove('on-path'));
  svg.classList.add('flow-focus');
}

export function clearFocus(svg: any) {
  focusedNode = null;
  if (!svg) return;
  svg.classList.remove('flow-focus');
  svg.querySelectorAll('.on-path').forEach((e: any) => e.classList.remove('on-path'));
}

// --- Node hover card ------------------------------------------------------------------------------
export let nodeCardEl: any = null;

export function showNodeCard(host: any, ev: any, rows: any[]) {
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
export function moveNodeCard(ev: any) {
  if (!nodeCardEl || !nodeCardEl.classList.contains('show')) return;
  const pad = 14;
  const w = nodeCardEl.offsetWidth || 260, h = nodeCardEl.offsetHeight || 120;
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const x = ev.clientX + pad + w > vw ? ev.clientX - pad - w : ev.clientX + pad;
  const y = Math.min(Math.max(pad, ev.clientY - h / 2), vh - h - pad);
  nodeCardEl.style.left = Math.max(pad, x) + 'px';
  nodeCardEl.style.top = y + 'px';
}

export function hideNodeCard() { if (nodeCardEl) nodeCardEl.classList.remove('show'); }

// Device templates and the panels that import them live in node-templates.ts — the MQTT Import page

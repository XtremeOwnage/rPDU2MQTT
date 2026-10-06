// The flow as a treemap: every consumer a box, its area its share.
//
// The outer box is the hub the supply converges on; inside it each branch is a box, and inside each branch
// the boxes it feeds, down to the leaves. A node that keeps some for itself leaves that much of its box
// empty. Where the sunburst shows the hierarchy's shape, this is for comparing: forty loads side by side,
// the big ones big, every label horizontal.
import { formatMeasure, el } from './helpers.js';
import { findHub, flowTree, treeFill, treePath, type TreeNode } from './flow-tree.js';
import { opens, type TreeViewOpts } from './sunburst.js';
import { showNodeCard, moveNodeCard, hideNodeCard } from './flow-focus.js';

type TmRect = { x: number; y: number; w: number; h: number };

/// Squarified treemap (Bruls, Huizing, van Wijk): lay the items, largest first, in rows along the shorter
/// side, adding to a row while doing so keeps its boxes closer to square.
export function squarify<T>(items: { area: number; item: T }[], r: TmRect): { item: T; r: TmRect }[] {
  const out: { item: T; r: TmRect }[] = [];
  let rest = items.filter(i => i.area > 0).sort((a, b) => b.area - a.area);
  let { x, y, w, h } = r;
  const worst = (row: { area: number }[], side: number) => {
    const s = row.reduce((t, i) => t + i.area, 0);
    const mx = Math.max(...row.map(i => i.area)), mn = Math.min(...row.map(i => i.area));
    return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn));
  };
  while (rest.length && w > 0 && h > 0) {
    const side = Math.min(w, h);
    const row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(i);
    const s = row.reduce((t, it) => t + it.area, 0);
    if (w >= h) {
      const cw = Math.min(w, s / h);
      let yy = y;
      row.forEach(it => { const hh = it.area / cw; out.push({ item: it.item, r: { x, y: yy, w: cw, h: hh } }); yy += hh; });
      x += cw; w -= cw;
    } else {
      const rh = Math.min(h, s / w);
      let xx = x;
      row.forEach(it => { const ww = it.area / rh; out.push({ item: it.item, r: { x: xx, y, w: ww, h: rh } }); xx += ww; });
      y += rh; h -= rh;
    }
  }
  return out;
}

const TM_HEAD = 20, TM_PAD = 3;

/// Every box, laid out in a W×H frame: the root, then each node inside its parent's box under its header.
export function layoutTreemap(nodes: any[], links: any[], W: number, H: number, dir: 'in' | 'out' = 'out'):
  { root: TmRect; hub: string | null; total: number; cells: { t: TreeNode; r: TmRect; nested: boolean }[]; rests: { r: TmRect; value: number }[] } {
  const { hub } = findHub(nodes, links);
  const { top, total } = flowTree(nodes, links, hub, hub ? dir : 'out');
  const cells: { t: TreeNode; r: TmRect; nested: boolean }[] = [];
  /// What a node keeps rather than passes on: the empty part of its box.
  const rests: { r: TmRect; value: number }[] = [];
  const root: TmRect = { x: 0, y: 0, w: W, h: H };
  const inner = (r: TmRect): TmRect => ({ x: r.x + TM_PAD, y: r.y + TM_HEAD, w: r.w - 2 * TM_PAD, h: r.h - TM_HEAD - TM_PAD });
  /// A set of siblings in a box, measured against `scale`; what they leave over stays empty.
  const fill = (kids: TreeNode[], scale: number, r: TmRect) => {
    if (r.w < 4 || r.h < 4 || !(scale > 0)) return;
    const area = r.w * r.h;
    const passed = kids.reduce((s, k) => s + k.value, 0);
    const items: { area: number; item: TreeNode | null }[] = kids.map(k => ({ area: area * k.value / scale, item: k }));
    if (scale - passed > 1e-9) items.push({ area: area * (scale - passed) / scale, item: null });
    squarify(items, r).forEach(({ item, r: cr }) => {
      if (!item) { if (cr.w >= 3 && cr.h >= 3) rests.push({ r: cr, value: scale - passed }); return; }
      if (cr.w < 3 || cr.h < 3) return;
      // Room for a header and something beneath it: nest. Otherwise the box is drawn whole, a leaf here.
      const nested = item.children.length > 0 && cr.w > 56 && cr.h > TM_HEAD + 22;
      cells.push({ t: item, r: cr, nested });
      if (nested) fill(item.children, item.scale, inner(cr));
    });
  };
  fill(top, total, inner(root));
  return { root, hub, total, cells, rests };
}

export function drawTreemap(nodes: any[], links: any[], opts: TreeViewOpts & { width: number; height?: number }): HTMLElement {
  const W = Math.max(320, opts.width || 1000);
  // A phone is taller than wide; a desktop pane is wide, and never taller than the screen can show.
  const H = opts.height ?? (W < 640 ? Math.round(W * 1.35) : Math.round(Math.min(W * 0.58, 700)));
  const { root, hub, total, cells, rests } = layoutTreemap(nodes, links, W, H, opts.dir);
  const inward = !!hub && opts.dir === 'in';
  const byId = new Map(nodes.map(n => [n.id, n]));
  const fmt = (v: number) => formatMeasure(v, opts.units);
  const hubNode = hub ? byId.get(hub) : null;
  const rootLabel = hubNode ? (hubNode.label || hub) : null;
  const box = el('div', { class: 'treemap' }) as HTMLElement;
  box.style.aspectRatio = `${W} / ${H}`;
  const at = (c: any, r: TmRect) => {
    c.style.left = `${(100 * r.x / W).toFixed(3)}%`; c.style.top = `${(100 * r.y / H).toFixed(3)}%`;
    c.style.width = `${(100 * r.w / W).toFixed(3)}%`; c.style.height = `${(100 * r.h / H).toFixed(3)}%`;
  };

  // The root: the hub, whose header backs out a level.
  const head = el('div', { class: 'treemap-root' },
    el('span', { class: 'treemap-name', text: rootLabel || 'Total' }),
    el('span', { class: 'treemap-val', text: fmt(hubNode?.value ?? total) }));
  head.title = 'Back out a level';
  head.onclick = () => opts.onOut();
  at(head, root);
  box.appendChild(head);

  cells.forEach(({ t, r, nested }) => {
    const leaf = inward || !opens(links, t.id);
    const c = el('div', { class: 'treemap-cell' + (nested ? ' is-nested' : '') + (leaf ? ' is-leaf' : '') });
    c.dataset.node = t.id;
    c.style.background = treeFill(t);
    at(c, r);
    // What fits: a name on one line, the value beneath it when there is height for it.
    if (r.h >= 15 && r.w >= 28) {
      c.appendChild(el('span', { class: 'treemap-name', text: t.label }));
      if (nested || r.h >= 34) c.appendChild(el('span', { class: 'treemap-val', text: fmt(t.value) }));
    }
    c.addEventListener('click', (e: any) => { e.stopPropagation?.(); if (!leaf) opts.onOpen(t.id); });
    const place = { value: t.value, total, path: treePath(t, rootLabel), parentValue: t.parent ? t.parent.value : (hubNode?.value ?? total) };
    c.addEventListener('mouseenter', (e: any) => { if (opts.card) showNodeCard(opts.host, e, opts.card(t.id, place)); });
    c.addEventListener('mousemove', (e: any) => moveNodeCard(e));
    c.addEventListener('mouseleave', () => hideNodeCard());
    box.appendChild(c);
  });
  // Over their parents' boxes, which they sit inside.
  rests.forEach(({ r, value }) => {
    const c = el('div', { class: 'treemap-rest' });
    at(c, r);
    if (r.h >= 15 && r.w >= 60) c.appendChild(el('span', { class: 'treemap-name', text: inward ? 'unaccounted' : 'not passed on' }));
    if (r.h >= 30 && r.w >= 40) c.appendChild(el('span', { class: 'treemap-val', text: fmt(value) }));
    c.title = inward ? `${fmt(value)} not accounted for by its feeders` : `${fmt(value)} not passed on to anything drawn here`;
    box.appendChild(c);
  });
  return box;
}

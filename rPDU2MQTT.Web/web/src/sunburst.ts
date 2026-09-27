// The flow as a sunburst: where the power goes, as rings.
//
// The centre is the hub the supply converges on — an inverter, a main panel — with a thin inner ring for the
// supply mix feeding it (solar against grid against battery). Each ring outward is one level of the
// hierarchy, and each arc's angle is its share of what its parent passes on. The Sankey answers "which way
// does it flow"; this answers "what is using it" at a glance, with the big consumers as the big arcs.
import { formatMeasure, svgEl } from './helpers.js';
import { findHub, flowTree, treeFill, treePath, type TreeNode } from './flow-tree.js';
import type { TreePlace } from './flow-card.js';
import { showNodeCard, moveNodeCard, hideNodeCard } from './flow-focus.js';


export type TreeViewOpts = {
  units: string;
  /// Open a node: the Flow page drills into it, which re-centres the view there.
  onOpen: (id: string) => void;
  /// The centre was clicked: back out a level.
  onOut: () => void;
  /// The details card for a node, shown while the pointer is on it.
  card?: (id: string, place: TreePlace) => any[];
  /// Where the card belongs.
  host?: any;
};

type Arc = { id: string; label: string; value: number; depth: number; a0: number; a1: number; hue: number; key: string; node: TreeNode };

const SIZE = 720, C = SIZE / 2;
const HUB_R = 62, SUPPLY_R0 = 68, SUPPLY_R1 = 80, RING0 = 88;
/// The supply ring by what feeds it, in the colours the Energy page uses.
const SUPPLY_FILL: Record<string, string> = { solar: '#f2b01e', grid: '#8b95a7', battery: '#3fb950', generator: '#d9730d' };

/// Every arc, laid out: a child's angle is its share of what its parent passes on, measured against the
/// parent's scale, so a node that keeps some for itself leaves a gap at the end of its ring.
export function layoutSunburst(nodes: any[], links: any[], hub: string | null, _supply?: string[]): { arcs: Arc[]; depth: number; total: number } {
  const { top, total, depth } = flowTree(nodes, links, hub);
  const arcs: Arc[] = [];
  if (!(total > 0)) return { arcs, depth, total };
  const place = (t: TreeNode, a0: number, a1: number) => {
    if (a1 - a0 < 1e-4) return;
    arcs.push({ id: t.id, label: t.label, value: t.value, depth: t.depth, a0, a1, hue: t.branch, key: t.key, node: t });
    let a = a0;
    t.children.forEach(c => { const span = (a1 - a0) * c.value / t.scale; place(c, a, a + span); a += span; });
  };
  let a = 0;
  top.forEach(t => { const span = 2 * Math.PI * t.value / total; place(t, a, a + span); a += span; });
  return { arcs, depth, total };
}

const pt = (r: number, a: number) => [C + r * Math.sin(a), C - r * Math.cos(a)];
const f2 = (n: number) => Math.round(n * 100) / 100;

function arcPath(r0: number, r1: number, a0: number, a1: number): string {
  // A full ring cannot be drawn as one arc; stop a hair short.
  const end = a1 - a0 >= 2 * Math.PI - 1e-6 ? a0 + 2 * Math.PI - 1e-4 : a1;
  const large = end - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, end), [x2, y2] = pt(r0, end), [x3, y3] = pt(r0, a0);
  return `M${f2(x0)},${f2(y0)} A${r1},${r1} 0 ${large} 1 ${f2(x1)},${f2(y1)} L${f2(x2)},${f2(y2)} `
       + `A${r0},${r0} 0 ${large} 0 ${f2(x3)},${f2(y3)} Z`;
}

/// A node opens only when there is something beneath it; opening a leaf would draw an empty diagram.
export const opens = (links: any[], id: string) => links.some((l: any) => l.source === id && (l.value ?? 0) > 0);

export function drawSunburst(nodes: any[], links: any[], opts: TreeViewOpts): SVGElement {
  const { hub, supply } = findHub(nodes, links);
  const { arcs, depth, total } = layoutSunburst(nodes, links, hub);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const svg = svgEl('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'sunburst-svg', role: 'img' }) as any;
  const ringW = Math.max(26, Math.min(70, (C - 8 - RING0) / Math.max(1, depth)));
  const fmt = (v: number) => formatMeasure(v, opts.units);
  const hubNode = hub ? byId.get(hub) : null;
  const rootLabel = hubNode ? (hubNode.label || hub) : null;

  // The hub: what it is and what it carries, or what the pointer is on. Clicking it backs out a level.
  const disc = svgEl('circle', { cx: C, cy: C, r: HUB_R, class: 'sunburst-hub' });
  disc.addEventListener('click', () => opts.onOut());
  disc.appendChild(svgEl('title', {})).textContent = 'Back out a level';
  const name = svgEl('text', { x: C, y: C - 10, class: 'sunburst-hub-name' });
  const val = svgEl('text', { x: C, y: C + 12, class: 'sunburst-hub-value' });
  const share = svgEl('text', { x: C, y: C + 30, class: 'sunburst-hub-share' });
  const clip = (t: string) => t.length > 18 ? t.slice(0, 17) + '…' : t;
  const show = (label: string, v: number, note: string) => {
    name.textContent = clip(label); val.textContent = fmt(v); share.textContent = note;
  };
  const rest = () => show(rootLabel || 'Total', hubNode?.value ?? total, '');
  rest();

  const drawn: { p: any; key: string }[] = [];
  /// Hovering lights the arc, what it came from and what it feeds; the rest of the rings dim.
  const light = (key: string | null) => drawn.forEach(d => {
    const off = !!key && d.key !== key && !key.startsWith(d.key + '>') && !d.key.startsWith(key + '>');
    if (off) d.p.classList.add('is-dim'); else d.p.classList.remove('is-dim');
  });
  const hover = (p: any, id: string, key: string | null, place: TreePlace, note: string) => {
    p.addEventListener('mouseenter', (e: any) => {
      show(byId.get(id)?.label || id, place.value, note);
      light(key);
      if (opts.card) showNodeCard(opts.host, e, opts.card(id, place));
    });
    p.addEventListener('mousemove', (e: any) => moveNodeCard(e));
    p.addEventListener('mouseleave', () => { rest(); light(null); hideNodeCard(); });
  };

  // The supply mix: a thin ring just outside the hub.
  const supplyTotal = supply.reduce((s, id) => s + Math.max(0, byId.get(id)?.value ?? 0), 0);
  if (hub && supplyTotal > 0) {
    let a = 0;
    supply.forEach((id, i) => {
      const v = Math.max(0, byId.get(id)?.value ?? 0);
      if (!v) return;
      const span = 2 * Math.PI * v / supplyTotal;
      const kind = byId.get(id)?.kind;
      const p = svgEl('path', { d: arcPath(SUPPLY_R0, SUPPLY_R1, a, a + span), class: 'sunburst-supply', fill: SUPPLY_FILL[kind] || `hsl(${(i * 70 + 40) % 360} 75% 55%)` });
      p.dataset.node = id;
      p.addEventListener('click', (e: any) => { e.stopPropagation?.(); if (opens(links, id)) opts.onOpen(id); });
      hover(p, id, null, { value: v, total: supplyTotal, path: [], parentValue: null }, `${Math.round(100 * v / supplyTotal)}% of supply`);
      svg.appendChild(p);
      a += span;
    });
  }

  arcs.forEach(arc => {
    // Too thin to draw once the gap between arcs comes off: its parent's card lists it.
    const r0 = RING0 + (arc.depth - 1) * ringW, r1 = r0 + ringW - 2;
    if ((arc.a1 - arc.a0 - 0.004) * r0 < 3) return;
    const p = svgEl('path', { d: arcPath(r0, r1, arc.a0 + 0.002, arc.a1 - 0.002), fill: treeFill(arc.node), class: 'sunburst-arc' });
    p.dataset.node = arc.id;
    const leaf = !opens(links, arc.id);
    if (leaf) p.classList.add('is-leaf');
    p.addEventListener('click', (e: any) => { e.stopPropagation?.(); if (!leaf) opts.onOpen(arc.id); });
    hover(p, arc.id, arc.key, {
      value: arc.value, total, path: treePath(arc.node, rootLabel),
      parentValue: arc.node.parent ? arc.node.parent.value : (hubNode?.value ?? total),
    }, `${Math.round(100 * arc.value / total)}% of total`);
    svg.appendChild(p);
    drawn.push({ p, key: arc.key });

    // A label where it fits: along the ring's middle, turned to read outward, on the arcs big enough to hold it.
    const mid = (arc.a0 + arc.a1) / 2, rm = (r0 + r1) / 2;
    if ((arc.a1 - arc.a0) * rm < 16) return;
    const [x, y] = pt(rm, mid);
    let deg = (mid * 180 / Math.PI) - 90;
    if (deg > 90) deg -= 180;
    const t = svgEl('text', { x: f2(x), y: f2(y), class: 'sunburst-label', transform: `rotate(${f2(deg)} ${f2(x)} ${f2(y)})` });
    // Radial text: the ring's width is the line's length.
    const maxChars = Math.floor((ringW - 8) / 6.2);
    t.textContent = arc.label.length > maxChars ? arc.label.slice(0, Math.max(3, maxChars - 1)) + '…' : arc.label;
    svg.appendChild(t);
  });

  // The hub on top, so the arcs cannot cover it.
  svg.append(disc, name, val, share);
  return svg;
}

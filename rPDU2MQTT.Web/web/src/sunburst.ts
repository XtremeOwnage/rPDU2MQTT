// The flow as a sunburst: where the power goes, as rings.
//
// The centre is the hub the supply converges on — an inverter, a main panel — with a thin inner ring for the
// supply mix feeding it (solar against grid against battery). Each ring outward is one level of the
// hierarchy, and each arc's angle is its share of what its parent passes on. The Sankey answers "which way
// does it flow"; this answers "what is using it" at a glance, with the big consumers as the big arcs.
import { formatMeasure, svgEl } from './helpers.js';
import { findHub, flowTree, treeFill, treePath, type TreeNode } from './flow-tree.js';
import { SOURCE_COLOR } from './charts.js';
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
  /// 'out' draws what the hub feeds, 'in' what feeds it.
  dir?: 'in' | 'out';
};

type Arc = { id: string; label: string; value: number; depth: number; a0: number; a1: number; hue: number; key: string; node: TreeNode };

const SIZE = 720, C = SIZE / 2;
const HUB_R = 62, SUPPLY_R0 = 68, SUPPLY_R1 = 80, RING0 = 88;
const SUPPLY_FILL: Record<string, string> = { solar: SOURCE_COLOR.solar, grid: SOURCE_COLOR.grid, battery: SOURCE_COLOR.battery, generator: '#d9730d' };

/// Every arc, laid out: a child's angle is its share of what its parent passes on, measured against the
/// parent's scale, so a node that keeps some for itself leaves a gap at the end of its ring.
export function layoutSunburst(nodes: any[], links: any[], hub: string | null, dir: 'in' | 'out' = 'out'): { arcs: Arc[]; depth: number; total: number } {
  const { top, total, depth } = flowTree(nodes, links, hub, dir);
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

const BASE_SIZE = 11.5;
const MIN_SIZE = 8;

/// Light text on dark fills, dark text on light ones.
export function labelInk(fill: string): string {
  const m = /hsl\((-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)/.exec(fill);
  let r = 0.5, g = 0.5, b = 0.5;
  if (m) {
    const h = +m[1], sat = +m[2] / 100, l = +m[3] / 100, k = (n: number) => (n + h / 30) % 12;
    const a = sat * Math.min(l, 1 - l), ch = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    [r, g, b] = [ch(0), ch(8), ch(4)];
  } else if (/^#[\da-f]{6}$/i.test(fill)) {
    [r, g, b] = [1, 3, 5].map(i => parseInt(fill.slice(i, i + 2), 16) / 255);
  }
  const lin = (c: number) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum < 0.18 ? '#ffffff' : '#0b0e13';
}
const clipTo = (text: string, n: number) => text.length > n ? text.slice(0, Math.max(3, n - 1)) + '…' : text;
type ArcLabel = { along: boolean; flip: boolean; deg: number; lines: string[]; size: number; lineH: number };

function layoutLabel(label: string, span: number, mid: number, rm: number, depth: number, size: number): ArcLabel {
  const charW = 0.59 * size, lineH = 1.19 * size;
  const across = Math.floor((depth - 8) / charW);
  const fits = (r: number) => Math.floor((span * r - 8) / charW);
  const along = fits(rm);
  let deg = (mid * 180 / Math.PI) - 90;
  if (deg > 90) deg -= 180;
  const midDeg = mid * 180 / Math.PI;
  const flip = midDeg > 90 && midDeg < 270;
  const out = (a: boolean, lines: string[]) => ({ along: a, flip, deg, lines, size, lineH });
  if (label.length <= across || along <= across || depth < lineH + 2) return out(false, [clipTo(label, across)]);
  if (label.length <= along || depth < 2 * lineH + 4) return out(true, [clipTo(label, along)]);
  const inner = fits(rm - lineH / 2);
  const words = label.split(/\s+/);
  let first = '';
  while (words.length && (first ? first + ' ' + words[0] : words[0]).length <= inner) first = first ? first + ' ' + words.shift() : words.shift()!;
  if (!first) return out(true, [clipTo(label, along)]);
  return out(true, words.length ? [first, clipTo(words.join(' '), inner)] : [first]);
}

/// An arc's label: across the ring, or curved along it (two lines when the ring is deep enough), whichever shows more.
/// The largest size up to `maxSize` that shows the whole label, on one line if any size allows; else the base size, clipped.
/// `flip` marks the lower half, where text along the arc runs the other way to stay upright.
export function arcLabel(label: string, span: number, mid: number, rm: number, depth: number, maxSize = BASE_SIZE): ArcLabel {
  const whole = label.split(/\s+/).join(' ');
  for (const lines of [1, 2]) for (let size = maxSize; size >= BASE_SIZE; size -= 0.5) {
    const l = layoutLabel(label, span, mid, rm, depth, size);
    if (l.lines.length <= lines && l.lines.join(' ') === whole) return l;
  }
  // Smaller than the base before clipping, down to MIN_SIZE.
  for (let size = BASE_SIZE - 0.5; size >= MIN_SIZE; size -= 0.5) {
    const l = layoutLabel(label, span, mid, rm, depth, size);
    if (l.lines.join(' ') === whole) return l;
  }
  return layoutLabel(label, span, mid, rm, depth, MIN_SIZE);
}

let labelPaths = 0;

/// A node opens only when there is something beneath it; opening a leaf would draw an empty diagram.
export const opens = (links: any[], id: string) => links.some((l: any) => l.source === id && (l.value ?? 0) > 0);

export function drawSunburst(nodes: any[], links: any[], opts: TreeViewOpts): SVGElement {
  const { hub, supply } = findHub(nodes, links);
  const dir = hub ? opts.dir || 'out' : 'out';
  const { arcs, depth, total } = layoutSunburst(nodes, links, hub, dir);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const svg = svgEl('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'sunburst-svg', role: 'img' }) as any;
  const defs = svgEl('defs', {});
  svg.appendChild(defs);
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
  if (hub && dir === 'out' && supplyTotal > 0) {
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
    const fill = treeFill(arc.node);
    const p = svgEl('path', { d: arcPath(r0, r1, arc.a0 + 0.002, arc.a1 - 0.002), fill, class: 'sunburst-arc' });
    p.dataset.node = arc.id;
    const leaf = dir === 'in' ? true : !opens(links, arc.id);
    if (leaf) p.classList.add('is-leaf');
    p.addEventListener('click', (e: any) => { e.stopPropagation?.(); if (!leaf) opts.onOpen(arc.id); });
    hover(p, arc.id, arc.key, {
      value: arc.value, total, path: treePath(arc.node, rootLabel),
      parentValue: arc.node.parent ? arc.node.parent.value : (hubNode?.value ?? total),
    }, `${Math.round(100 * arc.value / total)}% of total`);
    svg.appendChild(p);
    drawn.push({ p, key: arc.key });

    const mid = (arc.a0 + arc.a1) / 2, rm = (r0 + r1) / 2;
    if ((arc.a1 - arc.a0) * rm < 16) return;
    const [x, y] = pt(rm, mid);
    const label = arcLabel(arc.label, arc.a1 - arc.a0, mid, rm, r1 - r0, arc.depth === 1 ? 16 : arc.depth === 2 ? 13.5 : BASE_SIZE);
    const style = `font-size:${label.size}px;fill:${labelInk(fill)}`;
    if (!label.along) {
      const t = svgEl('text', { x: f2(x), y: f2(y), class: 'sunburst-label', transform: `rotate(${f2(label.deg)} ${f2(x)} ${f2(y)})`, style });
      t.textContent = label.lines[0];
      svg.appendChild(t);
      return;
    }
    // Upper line outward on the top half, inward on the bottom half, where the text runs the other way.
    const n = label.lines.length;
    label.lines.forEach((line, i) => {
      const off = (n - 1) / 2 - i;
      const r = rm + (label.flip ? -off : off) * label.lineH;
      const id = `sb-label-${++labelPaths}`;
      const a1 = arc.a0 + Math.min(arc.a1 - arc.a0, 2 * Math.PI - 0.02);
      const [sx, sy] = pt(r, label.flip ? a1 : arc.a0), [ex, ey] = pt(r, label.flip ? arc.a0 : a1);
      const large = a1 - arc.a0 > Math.PI ? 1 : 0;
      defs.appendChild(svgEl('path', { id, d: `M${f2(sx)},${f2(sy)} A${f2(r)},${f2(r)} 0 ${large} ${label.flip ? 0 : 1} ${f2(ex)},${f2(ey)}`, fill: 'none' }));
      const t = svgEl('text', { class: 'sunburst-label', style });
      const tp = svgEl('textPath', { href: `#${id}`, startOffset: '50%' });
      tp.textContent = line;
      t.appendChild(tp);
      svg.appendChild(t);
    });
  });

  // The hub on top, so the arcs cannot cover it.
  svg.append(disc, name, val, share);
  return svg;
}

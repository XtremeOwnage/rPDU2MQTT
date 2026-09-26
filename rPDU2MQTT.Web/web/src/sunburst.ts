// The flow as a sunburst: where the power goes, as rings.
//
// The centre is the hub the supply converges on — an inverter, a main panel — with a thin inner ring for the
// supply mix feeding it (solar against grid against battery). Each ring outward is one level of the
// hierarchy, and each arc's angle is its share of what its parent passes on. The Sankey answers "which way
// does it flow"; this answers "what is using it" at a glance, with the big consumers as the big arcs.
import { formatMeasure, svgEl } from './helpers.js';

export type SunburstOpts = {
  units: string;
  /// Open a node: the Flow page drills into it, which re-centres the sunburst there.
  onOpen: (id: string) => void;
  /// The centre was clicked: back out a level.
  onOut: () => void;
};

type Arc = { id: string; label: string; value: number; depth: number; a0: number; a1: number; hue: number };

const SIZE = 720, C = SIZE / 2;
/// The supply ring by what feeds it, in the colours the Energy page uses.
const SUPPLY_FILL: Record<string, string> = { solar: '#f2b01e', grid: '#8b95a7', battery: '#3fb950', generator: '#d9730d' };
const HUB_R = 62, SUPPLY_R0 = 68, SUPPLY_R1 = 80, RING0 = 88;

/// Where the supply converges: follow the roots while everything they feed is one node. What was followed
/// is the supply; the node it all meets at is the hub. With no such node the hub is a virtual "Total".
export function findHub(nodes: any[], links: any[]): { hub: string | null; supply: string[] } {
  const ids = new Set(nodes.map(n => n.id));
  const fed = new Set(links.map(l => l.target));
  let frontier = nodes.filter(n => !fed.has(n.id)).map(n => n.id);
  let supply: string[] = [];
  const seen = new Set<string>();
  while (frontier.length) {
    const out = links.filter(l => frontier.includes(l.source));
    const targets = [...new Set(out.map(l => l.target))].filter(t => ids.has(t));
    if (frontier.length === 1 && targets.length !== 1) return { hub: frontier[0], supply };
    if (targets.length !== 1 || seen.has(targets[0])) return { hub: null, supply: [] };
    seen.add(targets[0]);
    supply = frontier;
    frontier = targets;
  }
  return { hub: null, supply: [] };
}

/// Every arc, laid out: a child's angle is its link's share of what its parent passes on. A node fed from two
/// parents appears under each with that parent's share of it, so every ring still adds up.
export function layoutSunburst(nodes: any[], links: any[], hub: string | null, supply: string[]): { arcs: Arc[]; depth: number; total: number } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out = new Map<string, any[]>();
  links.forEach(l => { if ((l.value ?? 0) > 0) (out.get(l.source) ?? out.set(l.source, []).get(l.source)!).push(l); });
  const fed = new Set(links.map(l => l.target));
  // The top ring: the hub's children, or, with no hub, every root.
  const top: { id: string; value: number }[] = hub
    ? (out.get(hub) || []).map(l => ({ id: l.target, value: l.value }))
    : nodes.filter(n => !fed.has(n.id) && (n.value ?? 0) > 0).map(n => ({ id: n.id, value: n.value }));
  const total = top.reduce((s, t) => s + t.value, 0);
  const arcs: Arc[] = [];
  let depth = 0;
  if (!(total > 0)) return { arcs, depth, total };
  const walk = (id: string, value: number, d: number, a0: number, a1: number, hue: number, path: Set<string>) => {
    const n = byId.get(id);
    if (!n || path.has(id) || a1 - a0 < 1e-4) return;
    arcs.push({ id, label: n.label || id, value, depth: d, a0, a1, hue });
    depth = Math.max(depth, d);
    const kids = out.get(id) || [];
    // This arc may be only part of the node — one parent's share of something fed from two — so its
    // children are that same share of the node's own links.
    const share = (n.value ?? 0) > 0 ? Math.min(1, value / n.value) : 1;
    const parts = kids.map(l => ({ id: l.target, v: l.value * share }));
    const passed = parts.reduce((sum, p) => sum + p.v, 0);
    if (!(passed > 0)) return;
    // Against the larger of the two: what a node passes on can be less than it takes (its own use shows as
    // the gap at the end of the ring), and a reading short of its children must not overflow the parent.
    const denom = Math.max(value, passed);
    let a = a0;
    const next = new Set(path).add(id);
    parts.forEach(p => {
      const span = (a1 - a0) * p.v / denom;
      walk(p.id, p.v, d + 1, a, a + span, hue, next);
      a += span;
    });
  };
  let a = 0;
  top.sort((x, y) => y.value - x.value).forEach((t, i) => {
    const span = (2 * Math.PI) * t.value / total;
    walk(t.id, t.value, 1, a, a + span, (i * 57 + 205) % 360, new Set(hub ? [hub] : []));
    a += span;
  });
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

export function drawSunburst(nodes: any[], links: any[], opts: SunburstOpts): SVGElement {
  const { hub, supply } = findHub(nodes, links);
  const { arcs, depth, total } = layoutSunburst(nodes, links, hub, supply);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const svg = svgEl('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'sunburst-svg', role: 'img' }) as any;
  const ringW = Math.max(26, Math.min(70, (C - 8 - RING0) / Math.max(1, depth)));
  const fmt = (v: number) => formatMeasure(v, opts.units);

  // The hub: what it is and what it carries, or what the pointer is on. Clicking it backs out a level.
  const hubNode = hub ? byId.get(hub) : null;
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
  const rest = () => show(hubNode ? (hubNode.label || hub) : 'Total', hubNode?.value ?? total, '');
  const readout = (p: any, label: string, v: number, note: string) => {
    p.addEventListener('mouseenter', () => show(label, v, note));
    p.addEventListener('mouseleave', rest);
  };
  rest();

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
      p.appendChild(svgEl('title', {})).textContent = `${byId.get(id)?.label || id} · ${fmt(v)} · ${Math.round(100 * v / supplyTotal)}% of the supply`;
      p.dataset.node = id;
      readout(p, byId.get(id)?.label || id, v, `${Math.round(100 * v / supplyTotal)}% of supply`);
      p.addEventListener('click', (e: any) => { e.stopPropagation?.(); opts.onOpen(id); });
      svg.appendChild(p);
      a += span;
    });
  }

  arcs.forEach(arc => {
    // Too thin to draw once the gap between arcs comes off: the tooltip on its parent still covers it.
    if (arc.a1 - arc.a0 <= 0.006) return;
    const r0 = RING0 + (arc.depth - 1) * ringW, r1 = r0 + ringW - 2;
    const light = Math.min(72, 44 + arc.depth * 7);
    const p = svgEl('path', {
      d: arcPath(r0, r1, arc.a0 + 0.002, arc.a1 - 0.002),
      fill: `hsl(${arc.hue} 62% ${light}%)`, class: 'sunburst-arc',
    });
    p.dataset.node = arc.id;
    p.appendChild(svgEl('title', {})).textContent = `${arc.label} · ${fmt(arc.value)} · ${Math.round(100 * arc.value / total)}% of the total`;
    p.addEventListener('click', (e: any) => { e.stopPropagation?.(); opts.onOpen(arc.id); });
    readout(p, arc.label, arc.value, `${Math.round(100 * arc.value / total)}% of total`);
    svg.appendChild(p);

    // A label where it fits: along the ring's middle, turned to read outward, on the arcs big enough to hold it.
    const mid = (arc.a0 + arc.a1) / 2, rm = (r0 + r1) / 2;
    const room = (arc.a1 - arc.a0) * rm;
    if (room < 16) return;
    const [x, y] = pt(rm, mid);
    let deg = (mid * 180 / Math.PI) - 90;
    if (deg > 90) deg -= 180;
    const t = svgEl('text', {
      x: f2(x), y: f2(y), class: 'sunburst-label',
      transform: `rotate(${f2(deg)} ${f2(x)} ${f2(y)})`,
    });
    // Radial text: the ring's width is the line's length.
    const maxChars = Math.floor((ringW - 8) / 6.2);
    const name = arc.label.length > maxChars ? arc.label.slice(0, Math.max(3, maxChars - 1)) + '…' : arc.label;
    t.textContent = name;
    svg.appendChild(t);
  });

  // The hub on top, so the arcs cannot cover it.
  svg.append(disc, name, val, share);
  return svg;
}

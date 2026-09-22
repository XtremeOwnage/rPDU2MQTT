// What the floor plans are drawn with (#463, #464): surface textures at their real size, a pictogram per kind of
// placed item, and doors and windows as an architect draws them.
import { svgEl } from './helpers.js';

/// Surfaces a room, outdoor zone or the ground can have, with their names.
export const PLAN_SURFACES: [string, string][] = [
  ['', 'Plain'], ['wood', 'Wood'], ['tile', 'Tile'], ['carpet', 'Carpet'], ['concrete', 'Concrete'], ['stone', 'Stone'],
  ['grass', 'Grass'], ['gravel', 'Gravel'], ['dirt', 'Dirt'], ['deck', 'Deck'], ['pavers', 'Pavers'], ['water', 'Water'], ['snow', 'Snow'], ['stairs', 'Stairs'],
];

/// Grounds a floor can sit on.
export const PLAN_GROUNDS: [string, string][] = [['', 'Plain'], ['grass', 'Grass'], ['concrete', 'Concrete'], ['gravel', 'Gravel'], ['dirt', 'Dirt'], ['pavers', 'Pavers'], ['snow', 'Snow']];

/// Placed item kinds, grouped for the picker: [kind, name, group].
export const PLAN_KINDS: [string, string, string][] = [
  ['outlet', 'Outlet', 'Inside'], ['switch', 'Switch', 'Inside'], ['fixture', 'Light', 'Inside'], ['fan', 'Fan', 'Inside'],
  ['appliance', 'Appliance', 'Inside'], ['device', 'Device', 'Inside'], ['hvac', 'HVAC', 'Inside'], ['junction', 'Junction box', 'Inside'],
  ['ev-charger', 'EV charger', 'Power'], ['panel', 'Panel', 'Power'], ['meter', 'Utility meter', 'Power'], ['pole', 'Utility pole', 'Power'],
  ['transformer', 'Transformer', 'Power'], ['solar', 'Solar', 'Power'], ['battery', 'Battery', 'Power'], ['inverter', 'Inverter', 'Power'],
  ['generator', 'Generator', 'Power'],
];

/// Kinds that supply or carry power rather than use it; they get a ring of their own.
export const PLAN_SUPPLY_KINDS = ['panel', 'meter', 'pole', 'transformer', 'solar', 'battery', 'inverter', 'generator'];

export const PLAN_OPENINGS: [string, string][] = [['door', 'Door'], ['double-door', 'Double door'], ['sliding-door', 'Sliding door'], ['garage-door', 'Garage door'], ['window', 'Window'], ['opening', 'Opening']];

/// A texture at real size: `s` is drawing units per metre, so a floorboard is a floorboard at any scale.
export function planTextures(s: number): any[] {
  const out: any[] = [];
  const pat = (id: string, w: number, h: number, base: string, ...kids: any[]) => {
    const p = svgEl('pattern', { id: 'fp-tex-' + id, width: w * s, height: h * s, patternUnits: 'userSpaceOnUse' });
    p.appendChild(svgEl('rect', { width: w * s, height: h * s, fill: base }));
    kids.forEach(k => p.appendChild(k));
    out.push(p);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, w = 0.008) => svgEl('line', { x1: x1 * s, y1: y1 * s, x2: x2 * s, y2: y2 * s, stroke, 'stroke-width': w * s });
  const dot = (x: number, y: number, r: number, fill: string) => svgEl('circle', { cx: x * s, cy: y * s, r: r * s, fill });
  const path = (d: string, stroke: string, w = 0.008, fill = 'none') => svgEl('path', { d: d.replace(/-?\d*\.?\d+/g, n => String(Number(n) * s)), stroke, 'stroke-width': w * s, fill });

  pat('wood', 1.2, 0.3, '#c99d6b', line(0, 0.15, 1.2, 0.15, '#a37649'), line(0, 0.3, 1.2, 0.3, '#a37649'), line(0.45, 0, 0.45, 0.15, '#a37649'), line(1.0, 0.15, 1.0, 0.3, '#a37649'));
  pat('tile', 0.3, 0.3, '#e4ded1', path('M0 0 H0.3 M0 0 V0.3', '#bbb3a1', 0.012));
  pat('carpet', 0.1, 0.1, '#959cb2', dot(0.03, 0.03, 0.012, '#848ca4'), dot(0.08, 0.07, 0.01, '#a6adc1'));
  pat('concrete', 0.5, 0.5, '#c4c3bd', dot(0.1, 0.12, 0.012, '#adaca5'), dot(0.33, 0.07, 0.008, '#b3b2ab'), dot(0.27, 0.38, 0.014, '#aaa9a2'), dot(0.44, 0.29, 0.007, '#d2d1cb'), dot(0.06, 0.41, 0.009, '#b6b5ae'));
  pat('stone', 0.6, 0.6, '#b4ac9d', path('M0 0.25 L0.22 0.2 L0.3 0 M0.22 0.2 L0.35 0.42 L0.6 0.36 M0.35 0.42 L0.28 0.6 M0.3 0 L0.55 0.12 L0.6 0.36', '#958d7e', 0.012));
  pat('grass', 0.3, 0.3, '#78ab5d', path('M0.05 0.12 l0.02 -0.07 M0.18 0.27 l-0.015 -0.06 M0.24 0.1 l0.02 -0.06 M0.11 0.24 l0.01 -0.05', '#5d9146', 0.012), path('M0.2 0.2 l0.012 -0.05 M0.02 0.28 l0.015 -0.05', '#93c476', 0.01));
  pat('gravel', 0.15, 0.15, '#cbbfa6', dot(0.03, 0.04, 0.014, '#a99c83'), dot(0.1, 0.03, 0.01, '#ddd3bf'), dot(0.07, 0.1, 0.016, '#b4a78e'), dot(0.13, 0.12, 0.01, '#9d9078'));
  pat('dirt', 0.25, 0.25, '#a4815f', dot(0.05, 0.06, 0.01, '#8b6949'), dot(0.17, 0.12, 0.008, '#b8977a'), dot(0.1, 0.2, 0.012, '#886646'));
  pat('deck', 1.5, 0.28, '#b17d50', line(0, 0.14, 1.5, 0.14, '#7c5535', 0.014), line(0, 0.28, 1.5, 0.28, '#7c5535', 0.014), line(0.6, 0, 0.6, 0.14, '#7c5535', 0.01), line(1.25, 0.14, 1.25, 0.28, '#7c5535', 0.01));
  pat('pavers', 0.4, 0.2, '#b9684c', path('M0 0 H0.4 M0 0.1 H0.4 M0.2 0 V0.1 M0 0.1 V0.2 M0.4 0.1 V0.2', '#8c4a33', 0.012));
  pat('water', 0.6, 0.3, '#76aad6', path('M0 0.15 q0.075 -0.06 0.15 0 t0.15 0 t0.15 0 t0.15 0', '#5b91c2', 0.014));
  pat('stairs', 1.0, 0.28, '#d3cbbd', line(0, 0.27, 1.0, 0.27, '#8f8676', 0.018), line(0, 0.25, 1.0, 0.25, '#b7ae9e', 0.008));
  pat('snow', 0.4, 0.4, '#f2f5f9', dot(0.08, 0.1, 0.01, '#dde4ee'), dot(0.3, 0.25, 0.012, '#e3e9f1'), dot(0.2, 0.36, 0.008, '#d6dee9'));
  return out;
}

/// A pictogram for a placed item, centred on 0,0 inside a disc of radius r.
export function planGlyph(kind: string, r: number): any {
  const g = svgEl('g', { class: 'fp-glyph' });
  const k = r * 0.5;
  const add = (tag: string, a: any) => g.appendChild(svgEl(tag, a));
  const line = (x1: number, y1: number, x2: number, y2: number) => add('line', { x1: x1 * k, y1: y1 * k, x2: x2 * k, y2: y2 * k });
  const rect = (x: number, y: number, w: number, h: number, rx = 0.15) => add('rect', { x: x * k, y: y * k, width: w * k, height: h * k, rx: rx * k });
  const circle = (cx: number, cy: number, rr: number) => add('circle', { cx: cx * k, cy: cy * k, r: rr * k });
  const path = (d: string) => add('path', { d: d.replace(/-?\d*\.?\d+/g, n => String(Number(n) * k)) });
  const text = (t: string) => { const e = svgEl('text', { x: 0, y: 0.05 * k, class: 'fp-glyph-text', 'font-size': 1.3 * k }); e.textContent = t; g.appendChild(e); };
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
export function planOpening(o: any, u: number): any {
  const w = Math.max(1, Number(o.Width) || 90);
  const half = w / 2;
  const g = svgEl('g', { class: 'fp-op is-' + (o.Kind || 'door'), transform: `translate(${o.X},${o.Y}) rotate(${Number(o.Angle) || 0})` });
  const wall = 5 * u;
  g.appendChild(svgEl('line', { x1: -half, y1: 0, x2: half, y2: 0, class: 'fp-op-gap', 'stroke-width': wall + 2 * u }));
  const dir = o.Flip ? -1 : 1;
  const stroke = 1.6 * u;
  const leaf = (hx: number, ox: number, len: number, left: boolean) => {
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
export function planCircuitColor(ref: string): string {
  if (!ref) return 'var(--muted)';
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (h * 31 + ref.charCodeAt(i)) >>> 0;
  return PLAN_CIRCUIT_COLOURS[h % PLAN_CIRCUIT_COLOURS.length];
}

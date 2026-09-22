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

/// Things with a real footprint, in inches: [key, name, kind, width, depth, round]. Placed at their size, backs to the wall.
export const PLAN_FOOTPRINTS: [string, string, string, number, number, boolean][] = [
  ['washer', 'Washer', 'appliance', 27, 30, false], ['dryer', 'Dryer', 'appliance', 27, 30, false], ['fridge', 'Fridge', 'appliance', 36, 30, false],
  ['freezer', 'Chest freezer', 'appliance', 42, 28, false], ['range', 'Range / oven', 'appliance', 30, 26, false], ['dishwasher', 'Dishwasher', 'appliance', 24, 24, false],
  ['water-heater', 'Water heater', 'appliance', 22, 22, true], ['furnace', 'Furnace', 'hvac', 21, 28, false], ['condenser', 'AC condenser', 'hvac', 30, 30, false],
  ['rack', 'Server rack', 'device', 24, 42, false], ['hot-tub', 'Hot tub', 'appliance', 84, 84, false],
];

/// Kinds that supply or carry power rather than use it; they get a ring of their own.
export const PLAN_SUPPLY_KINDS = ['panel', 'meter', 'pole', 'transformer', 'solar', 'battery', 'inverter', 'generator'];

export const PLAN_OPENINGS: [string, string][] = [['door', 'Door'], ['double-door', 'Double door'], ['sliding-door', 'Sliding door'], ['garage-door', 'Garage door'], ['window', 'Window'], ['opening', 'Opening']];

/// Each surface's own colours: its base, a darker detail, and a lighter one.
export const PLAN_SURFACE_COLOURS: Record<string, [string, string, string]> = {
  wood: ['#c99d6b', '#a37649', '#dcb689'], tile: ['#e4ded1', '#bbb3a1', '#f2eee6'], carpet: ['#959cb2', '#848ca4', '#a6adc1'],
  concrete: ['#c4c3bd', '#adaca5', '#d2d1cb'], stone: ['#b4ac9d', '#958d7e', '#c7c0b3'], grass: ['#78ab5d', '#5d9146', '#93c476'],
  gravel: ['#cbbfa6', '#a99c83', '#ddd3bf'], dirt: ['#a4815f', '#8b6949', '#b8977a'], deck: ['#b17d50', '#7c5535', '#c49269'],
  pavers: ['#b9684c', '#8c4a33', '#cc8065'], water: ['#76aad6', '#5b91c2', '#93bfe3'], snow: ['#f2f5f9', '#dde4ee', '#ffffff'],
  stairs: ['#d3cbbd', '#8f8676', '#b7ae9e'],
};

/// A colour lighter or darker by a fraction: a detail drawn in the same colour as what it sits on.
export function planShade(hex: string, by: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => Math.round(by < 0 ? c * (1 + by) : c + (255 - c) * by));
  return '#' + ch.map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
}

/// The pattern id for a surface, in its own colours or in a chosen one.
export function planTextureId(name: string, colour = ''): string {
  return 'fp-tex-' + name + (colour ? '-' + colour.replace('#', '').toLowerCase() : '');
}

/// One surface texture at real size, in its own colours or recoloured from a base colour. `s` is units per metre.
export function planTexture(name: string, s: number, colour = ''): any {
  const own = PLAN_SURFACE_COLOURS[name];
  const [base, dark, light] = colour ? [colour, planShade(colour, -0.2), planShade(colour, 0.18)] : own || ['#cccccc', '#aaaaaa', '#eeeeee'];
  const p = svgEl('pattern', { id: planTextureId(name, colour), patternUnits: 'userSpaceOnUse' });
  const size = (w: number, h: number) => { p.setAttribute('width', w * s); p.setAttribute('height', h * s); p.appendChild(svgEl('rect', { width: w * s, height: h * s, fill: base })); };
  const add = (e: any) => p.appendChild(e);
  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, w = 0.008) => add(svgEl('line', { x1: x1 * s, y1: y1 * s, x2: x2 * s, y2: y2 * s, stroke, 'stroke-width': w * s }));
  const dot = (x: number, y: number, r: number, fill: string) => add(svgEl('circle', { cx: x * s, cy: y * s, r: r * s, fill }));
  const path = (d: string, stroke: string, w = 0.008) => add(svgEl('path', { d: d.replace(/-?\d*\.?\d+/g, n => String(Number(n) * s)), stroke, 'stroke-width': w * s, fill: 'none' }));
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
export function planTextures(s: number): any[] {
  return Object.keys(PLAN_SURFACE_COLOURS).map(name => planTexture(name, s));
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

/// An appliance seen from above, drawn inside its own footprint of W × D drawing units, its front toward +Y.
/// `u` is drawing units per screen pixel, so the lines stay a pixel or two wide at any zoom.
export function planFootprintArt(key: string, W: number, D: number, u: number): any | null {
  const g = svgEl('g', { class: 'fp-art' });
  const sw = 1.4 * u;
  const hw = W / 2, hd = D / 2, m = Math.min(W, D);
  const rect = (x: number, y: number, w: number, h: number, rx = 0, cls = '') => g.appendChild(svgEl('rect', { x, y, width: w, height: h, rx, 'stroke-width': sw, class: cls }));
  const circle = (cx: number, cy: number, r: number, cls = '') => g.appendChild(svgEl('circle', { cx, cy, r, 'stroke-width': sw, class: cls }));
  const line = (x1: number, y1: number, x2: number, y2: number, cls = '') => g.appendChild(svgEl('line', { x1, y1, x2, y2, 'stroke-width': sw, class: cls }));
  const knobs = (y: number, n: number, r: number) => { for (let i = 0; i < n; i++) circle(-hw * 0.6 + (i + 0.5) * (hw * 1.2 / n), y, r, 'is-fill'); };
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

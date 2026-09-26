// The animated energy diagram: a hub with an arm per source, dots travelling the way the power is going.
// Shared, because the home page and the Energy page must not draw the same system two different ways.
import { svgEl } from './helpers.js';

export type FlowArm = {
  key: string; icon: string; label: string; text: string; color: string;
  /// Watts. Positive supplies the hub, negative draws from it, null means nothing was measured.
  flow: number | null;
  ids?: string[];
};

// A central hub with Solar (top), Grid (left), Battery (right), Home (bottom).
const HUB = { x: 220, y: 150 };
const NODEPOS: Record<string, { x: number, y: number }> = {
  solar: { x: 220, y: 46 }, grid: { x: 66, y: 150 }, battery: { x: 374, y: 150 }, home: { x: 220, y: 254 },
};

/// How an arm's dots run: which way, how fast, how many. Rebuilt only when this changes, so a refresh with
/// the same flow leaves the dots where they are instead of restarting them.
const motionOf = (a: FlowArm) => {
  const mag = Math.abs(a.flow ?? 0);
  if (a.flow == null || mag <= 1) return 'still';
  const toHub = a.key === 'home' ? false : (a.flow ?? 0) >= 0;
  const kw = mag / 1000;
  const dur = Math.max(2.2, 6 - Math.min(3.5, kw * 0.9));       // more power → faster
  const count = Math.min(5, Math.max(2, Math.round(1 + kw)));    // …and denser
  // Rounded, so the ordinary jitter of a live reading does not restart the animation every refresh.
  return `${toHub ? 'in' : 'out'}|${(Math.round(dur * 4) / 4).toFixed(2)}|${count}`;
};

/// Draw the arms into `target`. A refresh of the same arms updates the figures in place: the diagram is
/// not replaced, so it neither flashes nor restarts its animation. `onOpen`, when given, makes a node clickable.
export function drawEnergyFlow(target: any, arms: FlowArm[], onOpen?: (arm: FlowArm, group: any) => void) {
    const shape = arms.map(a => a.key + ':' + (a.ids || []).join(',')).join(';');
    const existing = target.firstChild;
    if (existing && existing.dataset?.shape === shape) {
      arms.forEach(a => {
        const g = existing.querySelector?.(`[data-arm="${a.key}"]`);
        if (!g) return;
        const val = g.querySelector?.('.energy-node-val');
        if (val && val.textContent !== a.text) val.textContent = a.text;
        const live = a.flow != null && Math.abs(a.flow) > 1;
        g.classList[live ? 'add' : 'remove']('live');
        const dots = existing.querySelector?.(`[data-dots="${a.key}"]`);
        const motion = motionOf(a);
        if (dots && dots.dataset.motion !== motion) drawDots(dots, a, motion);
      });
      return;
    }

    target.innerHTML = '';
    // Frame only the arms that exist.
    const ys = arms.map(a => NODEPOS[a.key].y);
    // Below a node sits its label (+42) and value (+57); above it, the ring (r 26).
    const y0 = Math.min(HUB.y, ...ys) - 40, y1 = Math.max(HUB.y, ...ys) + 70;
    const svg = svgEl('svg', {
      viewBox: `12 ${y0} 416 ${y1 - y0}`,
      width: '100%', preserveAspectRatio: 'xMidYMid meet', class: 'energy-flow-svg',
    });
    svg.dataset.shape = shape;
    const lines = svgEl('g', {}); const dotLayer = svgEl('g', {}); const nodes = svgEl('g', {});
    svg.append(lines, dotLayer, nodes);

    arms.forEach(a => {
      const p = NODEPOS[a.key];
      // Base connector (always visible, dim) between the node and the hub.
      lines.appendChild(svgEl('line', { x1: p.x, y1: p.y, x2: HUB.x, y2: HUB.y, class: 'energy-arm' }));

      const dots = svgEl('g', {});
      dots.dataset.dots = a.key;
      drawDots(dots, a, motionOf(a));
      dotLayer.appendChild(dots);

      // Node: a coloured ring with its icon, a label and the live figure.
      const mag = Math.abs(a.flow ?? 0);
      const g = svgEl('g', { class: 'energy-node' + (a.flow != null && mag > 1 ? ' live' : '') });
      g.dataset.arm = a.key;
      g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 26, class: 'energy-node-ring', style: `stroke:${a.color}` }));
      const icon = svgEl('text', { x: p.x, y: p.y + 1, class: 'energy-node-icon' }); icon.textContent = a.icon; g.appendChild(icon);
      const lab = svgEl('text', { x: p.x, y: p.y + 42, class: 'energy-node-label' }); lab.textContent = a.label; g.appendChild(lab);
      const val = svgEl('text', { x: p.x, y: p.y + 57, class: 'energy-node-val' }); val.textContent = a.text; g.appendChild(val);
      // Click through to this node's own day. The whole group is the target — asking anyone to hit the
      // 26px ring exactly is asking them not to bother.
      if (onOpen && a.ids && a.ids.length) onOpen(a, g);
      nodes.appendChild(g);
    });

    // A small hub dot where the arms meet.
    nodes.appendChild(svgEl('circle', { cx: HUB.x, cy: HUB.y, r: 5, class: 'energy-hub' }));
    target.appendChild(svg);
  }

/// The dots travelling one arm. Direction: >0 supplies the hub (node→hub); <0 draws from it (hub→node).
/// Home only ever consumes.
function drawDots(group: any, a: FlowArm, motion: string) {
  group.innerHTML = '';
  group.dataset.motion = motion;
  if (motion === 'still') return;
  const [dir, durS, countS] = motion.split('|');
  const dur = Number(durS), count = Number(countS);
  const p = NODEPOS[a.key];
  const [sx, sy, ex, ey] = dir === 'in' ? [p.x, p.y, HUB.x, HUB.y] : [HUB.x, HUB.y, p.x, p.y];
  for (let i = 0; i < count; i++) {
    const dot = svgEl('circle', { r: 3.4, fill: a.color, class: 'energy-dot' });
    dot.appendChild(svgEl('animateMotion', { dur: `${dur}s`, repeatCount: 'indefinite', begin: `-${(dur / count) * i}s`, path: `M${sx},${sy} L${ex},${ey}` }));
    group.appendChild(dot);
  }
}

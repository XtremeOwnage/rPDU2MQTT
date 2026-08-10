// Day-by-day bar charts: axis, empty days, signed values, hover card.
import { el, formatNum } from './helpers.js';

// The kinds worth a colour of their own; anything else shares the neutral run.
export const KIND_COLOR: Record<string, string> = {
  solar: 'var(--warn, #d08700)',
  battery: 'var(--good, #46c46a)',
  grid: 'var(--accent, #4f8cff)',
  load: '#b06fd0',
  outlet: '#7f8ea3',
  pdu: '#5c7fa3',
  panel: '#c98b3f',
  inverter: '#3fb0a8',
};
export const colorFor = (kind: string, i: number) =>
  KIND_COLOR[kind] || ['#4f8cff', '#46c46a', '#d08700', '#b06fd0', '#3fb0a8', '#c05c5c'][i % 6];

/// One drawable series: a name, a colour, and one value per day — null where there is no reading.
export type Line = { label: string; color: string; values: (number | null)[] };

export const SVG = 'http://www.w3.org/2000/svg';
export const svgTag = (tag: string, attrs: Record<string, any>) => {
  const e = document.createElementNS(SVG, tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
  return e;
};

/// The hover card. One card for the page, moved and refilled — a card per chart would leak one per redraw.
export let card: any = null;
export function hoverCard(): any {
  if (!card) {
    card = el('div', { class: 'node-card trend-card' });
    document.body.appendChild(card);
  }
  return card;
}
export function hideCard() { if (card) card.classList.remove('show'); }

// A day-by-day bar chart. `stacked` adds the day's series into one bar, otherwise they sit side by side; a
// day where every series is null is drawn as an empty slot and reported, never as a bar of zero.
export function barChart(opts: {
  days: string[]; lines: Line[]; units: string; stacked: boolean; max?: number; pct?: boolean;
  partial?: string | null;
}): { svg: any; gaps: number } {
  const { days, lines, units, stacked } = opts;
  const has = (d: number) => lines.some(l => l.values[d] != null);
  const dayTotal = (d: number) => lines.reduce((s, l) => s + (l.values[d] ?? 0), 0);

  // Charge and export are negative quantities — energy leaving in the other direction.
  const posOf = (d: number) => lines.reduce((s, l) => s + Math.max(0, l.values[d] ?? 0), 0);
  const negOf = (d: number) => lines.reduce((s, l) => s + Math.min(0, l.values[d] ?? 0), 0);
  const peak = opts.max ?? Math.max(
    stacked ? Math.max(...days.map((_, d) => (has(d) ? posOf(d) : 0)), 0)
      : Math.max(...lines.flatMap(l => l.values.map(v => v ?? 0)), 0),
    0);
  const trough = Math.min(
    stacked ? Math.min(...days.map((_, d) => (has(d) ? negOf(d) : 0)), 0)
      : Math.min(...lines.flatMap(l => l.values.map(v => v ?? 0)), 0),
    0);
  const span = (peak - trough) || 1;

  const W = Math.max(720, days.length * 26);
  const H = 240, padL = 56, padB = 40, padT = 12, padR = 8;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / days.length;
  const x = (d: number) => padL + slot * d;
  const barW = Math.max(3, slot * 0.72);
  const y = (v: number) => padT + plotH - ((v - trough) / span) * plotH;
  const zeroY = y(0);

  const svg = svgTag('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'trend-chart' });

  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = trough + (span / ticks) * i, yy = y(v);
    svg.appendChild(svgTag('line', { x1: padL, y1: yy, x2: W - padR, y2: yy, stroke: 'var(--line)', 'stroke-width': 1 }));
    const t = svgTag('text', { x: padL - 6, y: yy + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 });
    t.textContent = formatNum(Number(v.toFixed(peak < 10 ? 2 : 0))) + (opts.pct ? '%' : '');
    svg.appendChild(t);
  }

  let gaps = 0;
  days.forEach((day, d) => {
    if (!has(d)) {
      gaps++;
      const g = svgTag('rect', {
        x: x(d) + (slot - barW) / 2, y: padT, width: barW, height: plotH,
        fill: 'var(--line)', opacity: 0.25, class: 'trend-gap',
      });
      const title = document.createElementNS(SVG, 'title');
      title.textContent = `${day} — no reading from the history backend`;
      g.appendChild(title);
      svg.appendChild(g);
    } else {
      // The period still in progress is drawn faded: it is a real reading of an unfinished day.
      const partial = day === opts.partial;
      const paint = (attrs: Record<string, any>) => {
        const r = svgTag('rect', partial ? { ...attrs, opacity: 0.55 } : attrs);
        if (partial) {
          const t = document.createElementNS(SVG, 'title');
          t.textContent = `${day} — still in progress, not a full day`;
          r.appendChild(t);
        }
        svg.appendChild(r);
      };
      if (stacked) {
        // Each sign stacks away from zero on its own side.
        let up = 0, down = 0;
        lines.forEach(l => {
          const v = l.values[d];
          if (v == null || v === 0) return;
          const from = v > 0 ? up : down;
          const to = from + v;
          paint({
            x: x(d) + (slot - barW) / 2, y: Math.min(y(from), y(to)), width: barW,
            height: Math.max(1, Math.abs(y(to) - y(from))), fill: l.color,
          });
          if (v > 0) up = to; else down = to;
        });
      } else {
        const each = barW / lines.length;
        lines.forEach((l, i) => {
          const v = l.values[d];
          if (v == null || v === 0) return;
          paint({
            x: x(d) + (slot - barW) / 2 + each * i, y: Math.min(zeroY, y(v)),
            width: Math.max(1, each - 1), height: Math.max(1, Math.abs(y(v) - zeroY)), fill: l.color,
          });
        });
      }
    }

    const every = Math.ceil(days.length / 12);
    if (d % every === 0) {
      const t = svgTag('text', { x: x(d) + slot / 2, y: H - padB + 16, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11 });
      t.textContent = day.slice(5);
      svg.appendChild(t);
    }
  });

  // The axis sits at zero, not at the bottom, so which side of it a bar is on is the point.
  svg.appendChild(svgTag('line', { x1: padL, y1: zeroY, x2: W - padR, y2: zeroY, stroke: 'var(--muted)', 'stroke-width': 1 }));

  // A full-height hit area per day, over the bars.
  days.forEach((day, d) => {
    const hit = svgTag('rect', {
      x: x(d), y: padT, width: slot, height: plotH, fill: 'transparent', class: 'trend-hit', 'data-day': day,
    });
    const show = (ev: any) => {
      const c = hoverCard();
      c.innerHTML = '';
      c.appendChild(el('div', { class: 'nh-title', text: day + (day === opts.partial ? ' · so far' : '') }));
      if (day === opts.partial)
        c.appendChild(el('div', { class: 'desc', style: { margin: '0 0 2px' }, text: 'still in progress — not a full day' }));
      if (!has(d)) {
        c.appendChild(el('div', { class: 'nh-warn', text: 'no reading from the history backend' }));
      } else {
        lines.forEach(l => {
          const v = l.values[d];
          c.appendChild(el('div', { class: 'nh-row' },
            el('span', { class: 'nh-name' },
              el('span', { class: 'trend-swatch', style: { background: l.color } }),
              l.label),
            el('span', { class: 'nh-num', text: v == null ? '—' : `${formatNum(Number(v.toFixed(2)))}${opts.pct ? '%' : ' ' + units}` })));
        });
        if (stacked && lines.length > 1)
          c.appendChild(el('div', { class: 'nh-row nh-total' },
            el('span', { class: 'nh-name', text: 'Total' }),
            el('span', { class: 'nh-num', text: `${formatNum(Number(dayTotal(d).toFixed(2)))} ${units}` })));
      }
      c.classList.add('show');
      const px = (ev && ev.clientX) || 0, py = (ev && ev.clientY) || 0;
      c.style.left = Math.max(8, px + 14) + 'px';
      c.style.top = Math.max(8, py + 14) + 'px';
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('mousemove', show);
    hit.addEventListener('mouseleave', hideCard);
    svg.appendChild(hit);
  });

  return { svg, gaps };
}

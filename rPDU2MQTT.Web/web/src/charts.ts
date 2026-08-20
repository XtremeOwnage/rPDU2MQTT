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
      // A day key is charted without its year; a clock label (an intra-day moment) is already what to show.
      t.textContent = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(5) : day;
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

/// A tile's trend: one series, no axes, no legend — the tile's own label names it.
///
/// It answers "and what has it been doing?", which a single instantaneous figure cannot. Deliberately not a
/// chart in the full sense: axes and a legend on a 44px-tall plot cost more room than the shape is worth,
/// and the number it sits under is the headline.
///
/// Gaps stay gaps. A reading the backend does not have is a break in the line, never a drop to zero joined
/// up to its neighbours — the same rule the rest of the flow follows, and the reason the line is drawn as
/// runs of consecutive points rather than one path.
export function sparkline(opts: {
  values: (number | null)[]; color: string; units: string; width?: number; height?: number;
  at?: (i: number) => string;      // what to call point i when someone hovers it
}): any {
  const { values, color, units } = opts;
  const w = opts.width ?? 132, h = opts.height ?? 40;
  const pad = 3;                                   // room for the 2px stroke and the hover dot's ring

  const known = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (known.length < 2) {
    // One point is not a trend, and none is not a zero. Say so rather than draw a flat line through nothing.
    const empty = el('div', { class: 'spark spark-empty', text: known.length ? '—' : '' });
    empty.title = known.length ? 'Only one reading in this window' : 'No readings stored for this window';
    return empty;
  }

  const lo = Math.min(...known, 0), hi = Math.max(...known);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (values.length === 1 ? 0 : (i * (w - pad * 2)) / (values.length - 1));
  const y = (v: number) => h - pad - ((v - lo) / span) * (h - pad * 2);

  const svg = svgTag('svg', {
    viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'spark',
    preserveAspectRatio: 'none', role: 'img',
    'aria-label': `Trend: ${formatNum(known[0])} to ${formatNum(known[known.length - 1])} ${units}`,
  });

  // Consecutive runs, so a gap in the data is a gap in the line.
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { if (run.length) runs.push(run); run = []; return; }
    run.push({ i, v: v as number });
  });
  if (run.length) runs.push(run);

  for (const r of runs) {
    if (r.length === 1) {
      // A lone reading between gaps is a dot: a segment needs two points, and inventing the second one
      // would be drawing a trend nobody measured.
      svg.appendChild(svgTag('circle', { cx: x(r[0].i), cy: y(r[0].v), r: 1.6, fill: color, class: 'spark-dot' }));
      continue;
    }
    const line = r.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' L');
    // The area first, so the line sits on top of it.
    svg.appendChild(svgTag('path', {
      d: `M${line} L${x(r[r.length - 1].i).toFixed(1)},${h - pad} L${x(r[0].i).toFixed(1)},${h - pad} Z`,
      fill: color, 'fill-opacity': '0.14', stroke: 'none',
    }));
    svg.appendChild(svgTag('path', {
      d: `M${line}`, fill: 'none', stroke: color, 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
  }

  // The latest reading, marked: it is the one the tile's big number is showing.
  const last = known[known.length - 1];
  const lastAt = values.length - 1 - [...values].reverse().findIndex(v => v != null && Number.isFinite(v as number));
  svg.appendChild(svgTag('circle', {
    cx: x(lastAt), cy: y(last), r: 2.4, fill: color, stroke: 'var(--panel2)', 'stroke-width': '1.5',
  }));

  // The hover layer. The plot is 40px tall, so the target is the whole strip and the nearest point wins —
  // asking someone to hit a 2px line with a mouse is asking them not to bother.
  const hit = svgTag('rect', { x: 0, y: 0, width: w, height: h, fill: 'transparent', class: 'spark-hit' });
  svg.appendChild(hit);
  hit.addEventListener('mousemove', (ev: any) => {
    const box = svg.getBoundingClientRect?.() ?? { left: 0, width: w };
    const frac = box.width ? (ev.clientX - box.left) / box.width : 0;
    const i = Math.max(0, Math.min(values.length - 1, Math.round(frac * (values.length - 1))));
    const v = values[i];
    const c = hoverCard();
    c.innerHTML = '';
    c.appendChild(el('div', { class: 'nc-title', text: opts.at ? opts.at(i) : `Point ${i + 1}` }));
    c.appendChild(el('div', { text: v == null ? 'no reading' : `${formatNum(v)} ${units}` }));
    c.classList.add('show');
    c.style.left = `${ev.clientX + 12}px`;
    c.style.top = `${ev.clientY + 12}px`;
  });
  hit.addEventListener('mouseleave', () => hideCard());

  return svg;
}

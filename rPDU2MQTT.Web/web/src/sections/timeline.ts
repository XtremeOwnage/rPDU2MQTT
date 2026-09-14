// The timeline above a trends dashboard: the whole loaded range drawn as lines, and a window over it that
// picks the stretch of time the dashboard below shows.
import { btn, el } from '../helpers.js';
import { svgTag, type Line } from '../charts.js';

/// A stretch of time, in epoch milliseconds.
export type Span = { from: number; to: number };

/// What the strip draws: the lines, the instant each value belongs to, the range it spans, and its width.
export type TimelineData = { lines: Line[]; points: number[]; bounds: Span; width: number };

const HEIGHT = 72;
/// How close to a window's edge a press grabs that edge, in pixels.
const EDGE = 7;
/// The narrowest window, in pixels, so an edge can always be grabbed again.
const NARROWEST = 8;
/// How far a press has to travel before it is a drag rather than a click.
const SLOP = 3;

export function timelineStrip(onPick: (span: Span | null) => void) {
  const box = el('div', { class: 'trend-timeline' });
  const head = el('div', { class: 'trend-timeline-head' });
  const note = el('span', { class: 'desc', style: { margin: '0' } });
  const whole = btn('Show the whole range');
  whole.hidden = true;
  head.append(note, whole);
  box.appendChild(head);

  let data: TimelineData | null = null;
  let span: Span | null = null;
  let svg: any = null;
  let shadeL: any, shadeR: any, frame: any, edgeL: any, edgeR: any;

  const width = () => data?.width || 1200;
  const t0 = () => data!.bounds.from;
  const t1 = () => data!.bounds.to;
  const xOf = (t: number) => ((t - t0()) / (t1() - t0() || 1)) * width();
  const tOf = (px: number) => t0() + Math.min(1, Math.max(0, px / width())) * (t1() - t0());

  /// A span held inside the range, or null when it is narrower than an edge can be grabbed back from.
  const inRange = (s: Span): Span | null => {
    const from = Math.max(t0(), Math.min(s.from, s.to));
    const to = Math.min(t1(), Math.max(s.from, s.to));
    return to - from < (NARROWEST / width()) * (t1() - t0()) ? null : { from, to };
  };

  /// `s` scaled by `factor` about the instant `at`, kept inside the range. Covering all of it is no window.
  const zoomed = (s: Span, at: number, factor: number): Span | null => {
    const w = (s.to - s.from) * factor;
    if (w >= t1() - t0()) return null;
    const from = Math.min(Math.max(t0(), at - (at - s.from) * factor), t1() - w);
    return inRange({ from, to: from + w }) ?? s;
  };

  /// `s` moved by `dt`, the same width, stopped at either end of the range.
  const shifted = (s: Span, dt: number): Span => {
    const w = s.to - s.from;
    const from = Math.min(Math.max(t0(), s.from + dt), t1() - w);
    return { from, to: from + w };
  };

  const when = (t: number) => {
    const d = new Date(t);
    return t1() - t0() > 36 * 3_600_000
      ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const paint = () => {
    whole.hidden = !span;
    note.textContent = span
      ? `Showing ${when(span.from)} → ${when(span.to)}. Drag the window to move it, its edges to resize it, `
        + 'scroll to zoom and shift-scroll to pan; double-click to show the whole range.'
      : 'The whole range. Drag across the timeline to look at part of it.';
    if (!svg) return;
    const on = !!span;
    const xl = on ? xOf(span!.from) : 0;
    const xr = on ? xOf(span!.to) : width();
    const set = (e: any, attrs: Record<string, any>) => Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
    const shown = on ? 'visible' : 'hidden';
    set(shadeL, { x: 0, width: on ? Math.max(0, xl) : 0 });
    set(shadeR, { x: xr, width: on ? Math.max(0, width() - xr) : 0 });
    set(frame, { x: xl, width: Math.max(0, xr - xl), visibility: shown });
    set(edgeL, { x: xl - 2, visibility: shown });
    set(edgeR, { x: xr - 2, visibility: shown });
  };

  const settle = () => { paint(); onPick(span); };

  // A press, and what it is doing: drawing a new window, moving the window, or dragging one of its edges.
  let press: { mode: 'create' | 'move' | 'left' | 'right'; px: number; was: Span | null; moved: boolean } | null = null;
  // Two fingers down is a pinch, which zooms the window about the point between them.
  const fingers = new Map<number, number>();
  let pinch: { apart: number; was: Span; at: number } | null = null;

  const pxOf = (ev: any) => {
    const r = svg?.getBoundingClientRect?.();
    return r && r.width ? (ev.clientX - r.left) * (width() / r.width) : ev.clientX;
  };

  const wire = (s: any) => {
    s.addEventListener('pointerdown', (ev: any) => {
      if (!data) return;
      const px = pxOf(ev);
      fingers.set(ev.pointerId ?? 0, px);
      if (fingers.size === 2) {
        const [a, b] = [...fingers.values()];
        const was = span ?? { from: t0(), to: t1() };
        pinch = { apart: Math.abs(a - b) || 1, was, at: tOf((a + b) / 2) };
        press = null;
        return;
      }
      let mode: 'create' | 'move' | 'left' | 'right' = 'create';
      if (span) {
        const xl = xOf(span.from), xr = xOf(span.to);
        if (Math.abs(px - xl) <= EDGE) mode = 'left';
        else if (Math.abs(px - xr) <= EDGE) mode = 'right';
        else if (px > xl && px < xr) mode = 'move';
      }
      press = { mode, px, was: span ? { ...span } : null, moved: false };
      ev.preventDefault?.();
    });

    s.addEventListener('wheel', (ev: any) => {
      if (!data) return;
      ev.preventDefault?.();
      const sideways = ev.shiftKey || Math.abs(ev.deltaX || 0) > Math.abs(ev.deltaY || 0);
      if (sideways) {
        if (!span) return;
        const dir = (ev.deltaX || ev.deltaY || 0) > 0 ? 1 : -1;
        span = shifted(span, dir * (span.to - span.from) * 0.15);
      } else {
        span = zoomed(span ?? { from: t0(), to: t1() }, tOf(pxOf(ev)), (ev.deltaY || 0) < 0 ? 0.8 : 1.25);
      }
      paint();
      // A scroll arrives as a burst of events; the dashboard follows once it stops.
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => onPick(span), 300);
    }, { passive: false });

    s.addEventListener('dblclick', () => { if (span) { span = null; settle(); } });
  };
  let wheelTimer: any = null;

  window.addEventListener('pointermove', (ev: any) => {
    if (!data) return;
    const id = ev.pointerId ?? 0;
    if (pinch && fingers.has(id)) {
      fingers.set(id, pxOf(ev));
      const [a, b] = [...fingers.values()];
      // Fingers moving apart ask for a narrower window: more detail, as a pinch-zoom does everywhere else.
      span = zoomed(pinch.was, pinch.at, pinch.apart / (Math.abs(a - b) || 1));
      paint();
      return;
    }
    if (!press) return;
    const px = pxOf(ev);
    if (!press.moved && Math.abs(px - press.px) <= SLOP) return;
    press.moved = true;
    const dt = tOf(px) - tOf(press.px);
    const was = press.was;
    if (press.mode === 'create') span = inRange({ from: tOf(press.px), to: tOf(px) });
    else if (press.mode === 'move' && was) span = shifted(was, dt);
    else if (press.mode === 'left' && was) span = inRange({ from: Math.min(was.from + dt, was.to), to: was.to }) ?? span;
    else if (press.mode === 'right' && was) span = inRange({ from: was.from, to: Math.max(was.to + dt, was.from) }) ?? span;
    paint();
  });

  window.addEventListener('pointerup', (ev: any) => {
    fingers.delete(ev.pointerId ?? 0);
    if (pinch) {
      if (fingers.size < 2) { pinch = null; settle(); }
      return;
    }
    if (!press) return;
    const moved = press.moved;
    press = null;
    // A press that never moved is a click, and a click picks nothing.
    if (moved) settle();
  });

  whole.onclick = () => { span = null; settle(); };

  const draw = (d: TimelineData) => {
    data = d;
    // A window from before is kept only as far as it still falls inside the range.
    if (span) span = inRange(span);
    if (svg) svg.remove();
    svg = svgTag('svg', {
      class: 'trend-timeline-svg', width: width(), height: HEIGHT, viewBox: `0 0 ${width()} ${HEIGHT}`,
      preserveAspectRatio: 'none',
    });
    const known = d.lines.flatMap(l => l.values).filter((v): v is number => v != null && Number.isFinite(v));
    const lo = known.length ? Math.min(0, ...known) : 0;
    const hi = known.length ? Math.max(0, ...known) : 1;
    const y = (v: number) => HEIGHT - 4 - ((v - lo) / (hi - lo || 1)) * (HEIGHT - 8);
    d.lines.forEach(line => {
      // A missing reading breaks the line rather than being drawn as a zero.
      let run: string[] = [];
      const flush = () => {
        if (run.length > 1) svg.appendChild(svgTag('polyline', {
          class: 'trend-timeline-line', points: run.join(' '), fill: 'none', stroke: line.color,
          'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke',
        }));
        run = [];
      };
      line.values.forEach((v, i) => {
        if (v == null || !Number.isFinite(v) || d.points[i] == null) { flush(); return; }
        run.push(`${xOf(d.points[i]).toFixed(1)},${y(v).toFixed(1)}`);
      });
      flush();
    });
    shadeL = svgTag('rect', { class: 'trend-timeline-shade', y: 0, height: HEIGHT });
    shadeR = svgTag('rect', { class: 'trend-timeline-shade', y: 0, height: HEIGHT });
    frame = svgTag('rect', { class: 'trend-timeline-window', y: 1, height: HEIGHT - 2 });
    edgeL = svgTag('rect', { class: 'trend-timeline-edge', y: HEIGHT / 2 - 12, width: 4, height: 24, rx: 2 });
    edgeR = svgTag('rect', { class: 'trend-timeline-edge', y: HEIGHT / 2 - 12, width: 4, height: 24, rx: 2 });
    svg.append(shadeL, shadeR, frame, edgeL, edgeR);
    wire(svg);
    box.appendChild(svg);
    paint();
  };

  return {
    el: box,
    draw,
    span: () => span,
    clear: () => { span = null; paint(); },
  };
}

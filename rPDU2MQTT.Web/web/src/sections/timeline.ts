// The timeline above a trends dashboard: the whole loaded range drawn as lines on a time axis, and a window
// over it that picks the stretch of time the dashboard below shows.
import { btn, el } from '../helpers.js';
import { svgTag, type Line } from '../charts.js';

/// A stretch of time, in epoch milliseconds.
export type Span = { from: number; to: number };

/// What the strip draws: the lines, the instant each value belongs to, the range it spans, and its width.
export type TimelineData = { lines: Line[]; points: number[]; bounds: Span; width: number };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HEIGHT = 72;
/// How close to a window's edge a press grabs that edge, in screen pixels.
const EDGE_PX = 12;
/// The grip drawn on each edge, in screen pixels.
const GRIP_W = 10, GRIP_H = 30;
/// The narrowest window, in screen pixels, so an edge can always be grabbed again.
const NARROWEST_PX = 8;
/// How far a press has to travel before it is a drag rather than a click, in screen pixels.
const SLOP_PX = 3;
/// Room each axis label needs, in pixels.
const LABEL_PX = 80;
/// Axis steps, finest first; the finest that leaves each label its room is used.
const TICK_STEPS = [15 * 60_000, 30 * 60_000, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
/// Window lengths offered as one click.
const SIZES: [number, string][] = [[HOUR, '1 h'], [6 * HOUR, '6 h'], [DAY, '1 day'], [7 * DAY, '7 days']];

/// 5400000 -> "1 h 30 min".
function lengthText(ms: number) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const days = Math.floor(mins / 1440), hours = Math.floor((mins % 1440) / 60), rest = mins % 60;
  return [days ? `${days} day${days > 1 ? 's' : ''}` : '', hours ? `${hours} h` : '', rest && !days ? `${rest} min` : '']
    .filter(Boolean).join(' ');
}

/// The start of the local hour, or of the local day for a day or longer.
function snapped(t: number, size: number) {
  const d = new Date(t);
  if (size >= DAY) d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0);
  return d.getTime();
}

export function timelineStrip(onPick: (span: Span | null) => void) {
  const box = el('div', { class: 'trend-timeline' });
  const head = el('div', { class: 'trend-timeline-head' });
  const note = el('span', { class: 'desc', style: { margin: '0' } });
  const tools = el('div', { class: 'trend-timeline-tools' });
  head.append(note, tools);
  const axis = el('div', { class: 'trend-timeline-axis' });
  box.append(head);

  let data: TimelineData | null = null;
  let span: Span | null = null;
  let svg: any = null;
  let shadeL: any, shadeR: any, frame: any, edgeL: any, edgeR: any, gripL: any, gripR: any;
  let earlier: any = null, later: any = null, zoomOut: any = null, whole: any = null;

  const width = () => data?.width || 1200;
  const t0 = () => data!.bounds.from;
  const t1 = () => data!.bounds.to;
  const xOf = (t: number) => ((t - t0()) / (t1() - t0() || 1)) * width();
  const tOf = (px: number) => t0() + Math.min(1, Math.max(0, px / width())) * (t1() - t0());
  /// Drawing units per screen pixel. The strip stretches to its box, so a pixel is rarely one unit.
  const unit = () => { const r = svg?.getBoundingClientRect?.(); return r && r.width ? width() / r.width : 1; };
  const pxOf = (ev: any) => {
    const r = svg?.getBoundingClientRect?.();
    return r && r.width ? (ev.clientX - r.left) * (width() / r.width) : ev.clientX;
  };

  /// A span held inside the range, or null when none of it is left there.
  const bounded = (s: Span): Span | null => {
    const from = Math.max(t0(), Math.min(s.from, s.to));
    const to = Math.min(t1(), Math.max(s.from, s.to));
    return to > from ? { from, to } : null;
  };

  /// As `bounded`, and refused when a drag has made it narrower than an edge can be grabbed back from. Only a
  /// drag is held to that: a zoom, or a length picked by button or label, can be narrower than a pointer can
  /// draw on a small screen, and is still the window asked for.
  const inRange = (s: Span): Span | null => {
    const b = bounded(s);
    return b && b.to - b.from >= ((NARROWEST_PX * unit()) / width()) * (t1() - t0()) ? b : null;
  };

  /// `s` scaled by `factor` about the instant `at`, kept inside the range. Covering all of it is no window.
  const zoomed = (s: Span, at: number, factor: number): Span | null => {
    const w = (s.to - s.from) * factor;
    if (w >= t1() - t0()) return null;
    const from = Math.min(Math.max(t0(), at - (at - s.from) * factor), t1() - w);
    return bounded({ from, to: from + w }) ?? s;
  };

  /// `s` moved by `dt`, the same length, stopped at either end of the range.
  const shifted = (s: Span, dt: number): Span => {
    const w = s.to - s.from;
    const from = Math.min(Math.max(t0(), s.from + dt), t1() - w);
    return { from, to: from + w };
  };

  const when = (t: number) => {
    const d = new Date(t);
    return t1() - t0() > 36 * HOUR
      ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  /// What a pointer at `px` would do: resize an edge, move the window, or draw a new one.
  const modeAt = (px: number): 'left' | 'right' | 'move' | 'create' => {
    if (!span) return 'create';
    const xl = xOf(span.from), xr = xOf(span.to), grab = EDGE_PX * unit();
    // Nearest edge first, so a narrow window still offers both.
    const dl = Math.abs(px - xl), dr = Math.abs(px - xr);
    if (Math.min(dl, dr) <= grab) return dl <= dr ? 'left' : 'right';
    return px > xl && px < xr ? 'move' : 'create';
  };
  const CURSOR = { left: 'ew-resize', right: 'ew-resize', move: 'grab', create: 'crosshair' };

  const paint = () => {
    note.textContent = span
      ? `Showing ${when(span.from)} → ${when(span.to)} (${lengthText(span.to - span.from)}). Double-click to zoom in further.`
      : 'The whole range. Double-click or drag across it to zoom in, click a date or time below it, or pick a length.';
    if (zoomOut) zoomOut.disabled = !span;
    if (earlier) earlier.disabled = !span || span.from <= t0();
    if (later) later.disabled = !span || span.to >= t1();
    if (whole) whole.hidden = !span;
    if (!svg) return;
    const on = !!span;
    const xl = on ? xOf(span!.from) : 0;
    const xr = on ? xOf(span!.to) : width();
    const u = unit();
    const set = (e: any, attrs: Record<string, any>) => Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
    const shown = on ? 'visible' : 'hidden';
    set(shadeL, { x: 0, width: on ? Math.max(0, xl) : 0 });
    set(shadeR, { x: xr, width: on ? Math.max(0, width() - xr) : 0 });
    set(frame, { x: xl, width: Math.max(0, xr - xl), visibility: shown });
    // The edges and their grips are sized in screen pixels, so they read the same however far the strip stretches.
    [[edgeL, xl], [edgeR, xr]].forEach(([e, x]) => set(e, { x: x - 1.5 * u, width: 3 * u, visibility: shown }));
    [[gripL, xl], [gripR, xr]].forEach(([g, x]) => set(g, { x: x - (GRIP_W / 2) * u, width: GRIP_W * u, visibility: shown }));
  };

  const settle = () => { paint(); onPick(span); };

  // A press, and what it is doing: drawing a new window, moving the window, or dragging one of its edges.
  let press: { mode: 'create' | 'move' | 'left' | 'right'; px: number; was: Span | null; moved: boolean } | null = null;
  // Two fingers down is a pinch, which zooms the window about the point between them.
  const fingers = new Map<number, number>();
  let pinch: { apart: number; was: Span; at: number } | null = null;
  let wheelTimer: any = null;

  const wire = (s: any) => {
    // The cursor says what a press would do before it is made.
    s.addEventListener('pointermove', (ev: any) => {
      if (!data || press || pinch) return;
      s.style.cursor = CURSOR[modeAt(pxOf(ev))];
    });

    s.addEventListener('pointerdown', (ev: any) => {
      if (!data) return;
      const px = pxOf(ev);
      fingers.set(ev.pointerId ?? 0, px);
      if (fingers.size === 2) {
        const [a, b] = [...fingers.values()];
        pinch = { apart: Math.abs(a - b) || 1, was: span ?? { from: t0(), to: t1() }, at: tOf((a + b) / 2) };
        press = null;
        return;
      }
      const mode = modeAt(px);
      press = { mode, px, was: span ? { ...span } : null, moved: false };
      s.style.cursor = mode === 'move' ? 'grabbing' : CURSOR[mode];
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
        span = zoomed(span ?? { from: t0(), to: t1() }, tOf(pxOf(ev)), (ev.deltaY || 0) < 0 ? 0.7 : 1 / 0.7);
      }
      paint();
      // A scroll arrives as a burst of events; the dashboard follows once it stops.
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => onPick(span), 300);
    }, { passive: false });

    // Double-click zooms in about the pointer, as a map does. Outside the window it zooms into that part of the
    // whole range instead, so any section is two clicks away.
    s.addEventListener('dblclick', (ev: any) => {
      if (!data) return;
      const at = tOf(pxOf(ev));
      const base = span && at >= span.from && at <= span.to ? span : { from: t0(), to: t1() };
      span = zoomed(base, at, 1 / 3);
      settle();
    });
  };

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
    if (!press.moved && Math.abs(px - press.px) <= SLOP_PX * unit()) return;
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
    if (svg) svg.style.cursor = 'crosshair';
    // A press that never moved is a click, and a click picks nothing.
    if (moved) settle();
  });

  /// The axis under the lines: labels at a step that leaves each its room, each one a period that can be picked.
  const drawAxis = () => {
    axis.innerHTML = '';
    const range = t1() - t0();
    const step = TICK_STEPS.find(s => range / s <= width() / LABEL_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];
    let t = step >= DAY ? snapped(t0(), DAY) : snapped(t0(), HOUR);
    while (t < t0()) t += Math.min(step, DAY);
    // A step of days counts from a midnight; a step of hours from the start of an hour.
    if (step < DAY) while ((t - snapped(t, DAY)) % step !== 0 && t < t1()) t += 15 * 60_000;
    for (; t <= t1(); t += step) {
      const pct = ((t - t0()) / range) * 100;
      if (pct < 2 || pct > 98) continue;
      const d = new Date(t);
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      const label = el('button', {
        class: 'trend-timeline-tick' + (midnight ? ' major' : ''),
        text: midnight || step >= DAY
          ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
          : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
      label.style.left = `${pct}%`;
      // A date is its day; a time is the stretch up to the next label.
      const length = midnight || step >= DAY ? DAY : step;
      label.title = `Show ${lengthText(length)} from ${d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      const from = t;
      label.onclick = () => { const s = bounded({ from, to: from + length }); if (s) { span = s; settle(); } };
      axis.appendChild(label);
      if (midnight && svg) svg.appendChild(svgTag('line', {
        class: 'trend-timeline-gridline', x1: xOf(t), x2: xOf(t), y1: 0, y2: HEIGHT, 'vector-effect': 'non-scaling-stroke',
      }));
    }
  };

  /// A window of `size`, starting on an hour or midnight: about the current window's middle, or ending at the newest.
  const sized = (size: number): Span | null => {
    if (size >= t1() - t0()) return null;
    const middle = span ? (span.from + span.to) / 2 : t1() - size / 2;
    const from = Math.min(Math.max(snapped(middle - size / 2, size), t0()), t1() - size);
    return { from, to: from + size };
  };

  const drawTools = () => {
    tools.innerHTML = '';
    earlier = btn('◀');
    earlier.title = 'Move the window back by its own length';
    earlier.onclick = () => { if (span) { span = shifted(span, -(span.to - span.from)); settle(); } };
    later = btn('▶');
    later.title = 'Move the window forward by its own length';
    later.onclick = () => { if (span) { span = shifted(span, span.to - span.from); settle(); } };
    const zoomIn = btn('+');
    zoomIn.title = 'Zoom in: half the length, about the middle';
    zoomIn.onclick = () => {
      const base = span ?? { from: t0(), to: t1() };
      span = zoomed(base, (base.from + base.to) / 2, 0.5);
      settle();
    };
    zoomOut = btn('−');
    zoomOut.title = 'Zoom out: twice the length, about the middle. Past the whole range, shows all of it.';
    zoomOut.onclick = () => { if (span) { span = zoomed(span, (span.from + span.to) / 2, 2); settle(); } };
    tools.append(zoomIn, zoomOut, earlier, later);
    SIZES.filter(([size]) => size < t1() - t0()).forEach(([size, text]) => {
      const b = btn(text);
      b.title = `Show ${lengthText(size)}` + (size >= DAY ? ', from midnight' : ', from the start of an hour');
      b.onclick = () => { const s = sized(size); if (s) { span = s; settle(); } };
      tools.appendChild(b);
    });
    whole = btn('Show the whole range');
    whole.onclick = () => { span = null; settle(); };
    tools.appendChild(whole);
  };

  const draw = (d: TimelineData) => {
    data = d;
    // A window from before is kept as far as it still falls inside the range, however narrow it is.
    if (span) span = bounded(span);
    if (svg) svg.remove();
    axis.remove();
    svg = svgTag('svg', {
      class: 'trend-timeline-svg', width: width(), height: HEIGHT, viewBox: `0 0 ${width()} ${HEIGHT}`,
      preserveAspectRatio: 'none',
    });
    svg.style.cursor = 'crosshair';
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
    box.appendChild(svg);
    box.appendChild(axis);
    drawAxis();
    shadeL = svgTag('rect', { class: 'trend-timeline-shade', y: 0, height: HEIGHT });
    shadeR = svgTag('rect', { class: 'trend-timeline-shade', y: 0, height: HEIGHT });
    frame = svgTag('rect', { class: 'trend-timeline-window', y: 1, height: HEIGHT - 2 });
    edgeL = svgTag('rect', { class: 'trend-timeline-edge', y: 0, height: HEIGHT });
    edgeR = svgTag('rect', { class: 'trend-timeline-edge', y: 0, height: HEIGHT });
    gripL = svgTag('rect', { class: 'trend-timeline-grip', y: (HEIGHT - GRIP_H) / 2, height: GRIP_H, rx: 3 });
    gripR = svgTag('rect', { class: 'trend-timeline-grip', y: (HEIGHT - GRIP_H) / 2, height: GRIP_H, rx: 3 });
    svg.append(shadeL, shadeR, frame, edgeL, edgeR, gripL, gripR);
    wire(svg);
    drawTools();
    paint();
  };

  return {
    el: box,
    draw,
    span: () => span,
    clear: () => { span = null; paint(); },
  };
}

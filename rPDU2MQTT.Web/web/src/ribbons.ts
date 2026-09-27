// How a link gets from one bar to the next: a curved band (the default), or a wire on a grid.
//
// A band is filled, with a thickness that is the value; it leaves the source bar spanning [sTop, sTop + h]
// and arrives at the target spanning [tTop, tTop + h]. A wire leaves the middle of that slot and arrives at
// the middle of the target's, and says the value by its stroke width. Pure functions, testable away from
// the render.

export type RibbonStyle = 'curved' | 'ortho' | 'ortho-round';

/// One ribbon's geometry: where it starts, where it ends, and how thick it is.
export type Band = { x1: number; sTop: number; x2: number; tTop: number; h: number };

const r2 = (n: number) => Math.round(n * 100) / 100;

/// The closed outline of a curved ribbon, as an SVG path. The right-angle routings draw wires instead
/// (wirePath below): a band as thick as its flow cannot turn a right angle in a column gap.
export function ribbonOutline(_style: RibbonStyle, b: Band): string {
  return curvedBand(b);
}

/// The line a stream of particles travels down the band, at fraction `f` across it. It follows the same
/// route as the outline, or the particles swim outside their own ribbon — the stream is clipped to the band.
export function lanePath(_style: RibbonStyle, b: Band, f: number): string {
  const sY = b.sTop + b.h * f, tY = b.tTop + b.h * f;
  const xc = (b.x1 + b.x2) / 2;
  return `M${r2(b.x1)},${r2(sY)} C${r2(xc)},${r2(sY)} ${r2(xc)},${r2(tY)} ${r2(b.x2)},${r2(tY)}`;
}

/// One smooth band from source to target.
function curvedBand({ x1, sTop, x2, tTop, h }: Band): string {
  const xc = (x1 + x2) / 2;
  return `M${r2(x1)},${r2(sTop)} C${r2(xc)},${r2(sTop)} ${r2(xc)},${r2(tTop)} ${r2(x2)},${r2(tTop)} `
       + `L${r2(x2)},${r2(tTop + h)} C${r2(xc)},${r2(tTop + h)} ${r2(xc)},${r2(sTop + h)} ${r2(x1)},${r2(sTop + h)} Z`;
}

/// A polyline of right-angle turns, with each corner optionally rounded by `r`.
///
/// Rounding is per corner and never eats more than half of either leg, so a short run keeps a sharp turn
/// rather than collapsing into a curve that overshoots the next one.
function polyline(pts: number[][], r: number): string {
  let d = `M${r2(pts[0][0])},${r2(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py), outLen = Math.hypot(nx - cx, ny - cy);
    // A leg shared with the next corner can only give up half of itself. The first and last legs end at a
    // bar rather than at another corner, so they can give more — but not everything: a corner that eats a
    // whole leg leaves no straight run at all and the ribbon reads as one continuous bend rather than a
    // line with rounded corners. Three fifths keeps the curve generous and the line still a line.
    const inBudget = i === 1 ? inLen * 0.6 : inLen / 2;
    const outBudget = i === pts.length - 2 ? outLen * 0.6 : outLen / 2;
    const rr = Math.min(r, inBudget, outBudget);
    if (rr <= 0.5) { d += ` L${r2(cx)},${r2(cy)}`; continue; }
    const ax = cx - ((cx - px) / inLen) * rr, ay = cy - ((cy - py) / inLen) * rr;
    const bx = cx + ((nx - cx) / outLen) * rr, by = cy + ((ny - cy) / outLen) * rr;
    d += ` L${r2(ax)},${r2(ay)} Q${r2(cx)},${r2(cy)} ${r2(bx)},${r2(by)}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${r2(last[0])},${r2(last[1])}`;
}

/// A link drawn as a wire rather than a band, for the right-angle routings.
///
/// A band as thick as its flow cannot turn a right angle in a column gap: a 1.5 kW band is hundreds of
/// pixels thick in a gap a third of that, so every turn became a solid block and the blocks stacked into
/// one another. A wire keeps the one thing a right-angle layout is for — seeing which circuit goes where —
/// and says how much by its thickness instead. It leaves the middle of its slot on the source bar, runs to
/// its source's trunk, along the trunk, and into the middle of its slot on the target bar.
export type Wire = { x1: number; sy: number; x2: number; ty: number; trunkX: number };

export function wirePath(style: RibbonStyle, w: Wire): string {
  if (Math.abs(w.ty - w.sy) <= 0.5) return `M${r2(w.x1)},${r2(w.sy)} L${r2(w.x2)},${r2(w.ty)}`;
  const x = Math.min(Math.max(w.trunkX, w.x1 + 2), w.x2 - 2);
  const r = style === 'ortho-round' ? 10 : 0;
  return polyline([[w.x1, w.sy], [x, w.sy], [x, w.ty], [w.x2, w.ty]], r);
}

/// How thick a wire is for a band of thickness `h`: ordered like the flows, but never a slab or a hairline.
export function wireWidth(h: number): number {
  return Math.max(1.5, Math.min(10, 1.5 + Math.sqrt(Math.max(0, h)) * 0.6));
}

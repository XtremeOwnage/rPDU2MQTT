// How a ribbon gets from one bar to the next.
//
// A ribbon is a filled band, not a stroked line: it has a thickness that means something (the value), and
// the animated stream clips against its outline. So each routing has to produce a closed outline rather
// than a centre line — which is also why this is worth having on its own, testable, away from the 600-line
// render.
//
// Every routing here obeys the same contract: the band leaves the source bar at x1 spanning
// [sTop, sTop + h], and arrives at the target bar at x2 spanning [tTop, tTop + h]. Whatever happens in
// between is the routing's business.

export type RibbonStyle = 'curved' | 'ortho' | 'ortho-round';

/// One ribbon's geometry: where it starts, where it ends, and how thick it is.
export type Band = {
  x1: number; sTop: number; x2: number; tTop: number; h: number;
  /// The centre of this ribbon's own vertical lane, and how wide that lane is. Supplied by the renderer,
  /// which is the only thing that can see the other ribbons sharing the corridor. Absent for a lone band.
  laneX?: number; laneW?: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/// The closed outline of a ribbon, as an SVG path.
export function ribbonOutline(style: RibbonStyle, b: Band): string {
  switch (style) {
    case 'ortho': return orthoBand(b, 0);
    case 'ortho-round': return orthoBand(b, cornerRadius(b));
    default: return curvedBand(b);
  }
}

/// The line a stream of particles travels down the middle of the band, at fraction `f` across it.
///
/// It has to follow the same route as the outline or the particles swim outside their own ribbon — the
/// stream is clipped to the band, so a mismatched lane simply disappears where it leaves.
export function lanePath(style: RibbonStyle, b: Band, f: number): string {
  const sY = b.sTop + b.h * f, tY = b.tTop + b.h * f;
  if (style === 'curved') {
    const xc = (b.x1 + b.x2) / 2;
    return `M${r2(b.x1)},${r2(sY)} C${r2(xc)},${r2(sY)} ${r2(xc)},${r2(tY)} ${r2(b.x2)},${r2(tY)}`;
  }
  // The grid routings share one elbow; a lane runs down the middle of it at its own offset.
  const xc = elbowX(b);
  const r = style === 'ortho-round' ? Math.min(cornerRadius(b), Math.abs(tY - sY) / 2) : 0;
  return polyline([[b.x1, sY], [xc, sY], [xc, tY], [b.x2, tY]], r);
}

/// The original: one smooth band from source to target.
function curvedBand({ x1, sTop, x2, tTop, h }: Band): string {
  const xc = (x1 + x2) / 2;
  return `M${r2(x1)},${r2(sTop)} C${r2(xc)},${r2(sTop)} ${r2(xc)},${r2(tTop)} ${r2(x2)},${r2(tTop)} `
       + `L${r2(x2)},${r2(tTop + h)} C${r2(xc)},${r2(tTop + h)} ${r2(xc)},${r2(sTop + h)} ${r2(x1)},${r2(sTop + h)} Z`;
}

/// How wide the vertical run is.
///
/// It wants to be the band's own thickness — that is what makes the turn constant-width, and it is right
/// whenever there is room. There often is not: a 4.6 kW band is 324px thick in a 163px column gap, and a
/// run that wide cannot sit between the two bars at all. It is capped to most of the corridor, so a very
/// thick ribbon pinches at its turn rather than hanging out of the side of a panel.
function runWidth(b: Band): number {
  if (b.laneW != null) return Math.max(1.5, b.laneW);
  return Math.max(1.5, Math.min(b.h, (b.x2 - b.x1) * 0.8));
}

/// Where the vertical run sits: mid-corridor, pulled in far enough that the whole run fits between the bars.
function elbowX(b: Band): number {
  const half = runWidth(b) / 2;
  const mid = b.laneX ?? (b.x1 + b.x2) / 2;
  return Math.min(Math.max(mid, b.x1 + half), b.x2 - half);
}

/// How much corner to round: as much as the turn and the runs allow, which on a long gentle turn is a lot.
///
/// The two corners share the vertical run between them, so neither may take more than half of it. The
/// horizontal runs either side are theirs alone.
function cornerRadius(b: Band): number {
  const drop = Math.abs(b.tTop - b.sTop);
  const half = runWidth(b) / 2;
  const xc = elbowX(b);
  return Math.max(0, Math.min(drop / 2, xc - half - b.x1, b.x2 - xc - half));
}

/// A band routed out, across and back in — two bends a side, never more.
///
/// The two edges turn on opposite sides of the vertical run, a run's width apart, which is what gives the
/// turn its thickness. Which edge takes which side depends on the direction of travel: put both on the
/// same side and the outline crosses itself and the ribbon renders as a bow tie; put them on the same x
/// and the run has no width at all, so a long drop draws as two rectangles with nothing joining them.
function orthoBand(b: Band, r: number): string {
  const { x1, sTop, x2, tTop, h } = b;

  // Nothing to step over: a straight band, which is what the eye expects anyway.
  if (Math.abs(tTop - sTop) <= 1)
    return `M${r2(x1)},${r2(sTop)} L${r2(x2)},${r2(tTop)} L${r2(x2)},${r2(tTop + h)} L${r2(x1)},${r2(sTop + h)} Z`;

  const xc = elbowX(b), half = runWidth(b) / 2;
  const down = tTop > sTop ? 1 : -1;
  const nearX = xc + down * half, farX = xc - down * half;

  const upper = polyline([[x1, sTop], [nearX, sTop], [nearX, tTop], [x2, tTop]], r);
  const lower = polyline([[x2, tTop + h], [farX, tTop + h], [farX, sTop + h], [x1, sTop + h]], r);
  // The two sides, joined by the flat caps that sit against each bar.
  return `${upper} L${r2(x2)},${r2(tTop + h)} ${lower.replace(/^M/, 'L')} Z`;
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

/// Mix two colours. Accepts #rgb and #rrggbb, which is what the palette uses.
export function mixHex(a: string, b: string, t: number): string {
  const parse = (h: string) => {
    const raw = h.replace('#', '');
    const full = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  };
  const [r1, g1, b1] = parse(a), [r2, g2, b2] = parse(b);
  const part = (x: number, y: number) =>
    Math.max(0, Math.min(255, Math.round(x + (y - x) * t))).toString(16).padStart(2, '0');
  return `#${part(r1, r2)}${part(g1, g2)}${part(b1, b2)}`;
}

/// The shade one ribbon takes within the fan leaving a node.
///
/// Every ribbon out of a node used to be the identical colour, so where two of them ran side by side down
/// the same corridor the only thing separating them was the hard edge between two bands of the same fill.
/// A fan of twelve outlets came out as a stack of stripes. Spreading the siblings across a range of the
/// node's own colour lets them read as one graded sweep, and still says which node they came from.
export function fanShade(color: string, index: number, count: number): string {
  if (count < 2) return color;
  return mixHex(color, '#ffffff', (index / (count - 1)) * 0.45);
}

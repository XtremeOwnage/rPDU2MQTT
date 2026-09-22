// Floor plan geometry (#463): outlines as point lists in the floor's drawing units, and the snapping that lets
// rooms meet edge to edge without a CAD tool's precision.

export type Pt = { X: number; Y: number };

/// A rectangle drawn corner to corner, as the four-point outline a room is stored as.
export function planRect(a: Pt, b: Pt): Pt[] {
  const x1 = Math.min(a.X, b.X), x2 = Math.max(a.X, b.X), y1 = Math.min(a.Y, b.Y), y2 = Math.max(a.Y, b.Y);
  return [{ X: x1, Y: y1 }, { X: x2, Y: y1 }, { X: x2, Y: y2 }, { X: x1, Y: y2 }];
}

/// Signed area by the shoelace formula; its magnitude is the outline's area.
export function planArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.X * b.Y - b.X * a.Y;
  }
  return s / 2;
}

/// Where a label sits: the area-weighted centre, or the average of the points for a degenerate outline.
export function planCentroid(poly: Pt[]): Pt {
  if (!poly.length) return { X: 0, Y: 0 };
  const a = planArea(poly);
  if (Math.abs(a) < 1e-9) return { X: poly.reduce((s, p) => s + p.X, 0) / poly.length, Y: poly.reduce((s, p) => s + p.Y, 0) / poly.length };
  let cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p.X * q.Y - q.X * p.Y;
    cx += (p.X + q.X) * f;
    cy += (p.Y + q.Y) * f;
  }
  return { X: cx / (6 * a), Y: cy / (6 * a) };
}

/// Is a point inside an outline? Even-odd ray casting; a point on an edge may land either side.
export function planContains(poly: Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.Y > p.Y) !== (b.Y > p.Y) && p.X < ((b.X - a.X) * (p.Y - a.Y)) / (b.Y - a.Y) + a.X) inside = !inside;
  }
  return inside;
}

/// The smallest of the outlines holding a point, so a point in a closet inside a bedroom is in the closet.
export function planShapeAt<T extends { Shape?: Pt[] }>(shapes: T[], p: Pt): T | null {
  let best: T | null = null, bestArea = Infinity;
  for (const s of shapes) {
    const poly = s.Shape || [];
    if (poly.length < 3 || !planContains(poly, p)) continue;
    const a = Math.abs(planArea(poly));
    if (a < bestArea) { best = s; bestArea = a; }
  }
  return best;
}

/// The nearest point to p on the segment a–b.
export function planNearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.X - a.X, dy = b.Y - a.Y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / len)) : 0;
  return { X: a.X + t * dx, Y: a.Y + t * dy };
}

const planDist = (a: Pt, b: Pt) => Math.hypot(a.X - b.X, a.Y - b.Y);

/// Where a point lands once snapped: onto another outline's corner, else its edge, else the grid. Corners win
/// over edges so two rooms drawn side by side share their corners exactly.
export function planSnap(p: Pt, others: Pt[][], threshold: number, grid = 0): { pt: Pt; to: 'corner' | 'edge' | 'grid' | 'none' } {
  let best: Pt | null = null, bestD = threshold;
  for (const poly of others) for (const v of poly) {
    const d = planDist(p, v);
    if (d <= bestD) { best = v; bestD = d; }
  }
  if (best) return { pt: { X: best.X, Y: best.Y }, to: 'corner' };
  bestD = threshold;
  for (const poly of others) for (let i = 0; i < poly.length; i++) {
    const q = planNearestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    const d = planDist(p, q);
    if (d <= bestD) { best = q; bestD = d; }
  }
  if (best) return { pt: best, to: 'edge' };
  if (grid > 0) return { pt: { X: Math.round(p.X / grid) * grid, Y: Math.round(p.Y / grid) * grid }, to: 'grid' };
  return { pt: { X: p.X, Y: p.Y }, to: 'none' };
}

/// An outline moved by an offset.
export function planMove(poly: Pt[], dx: number, dy: number): Pt[] {
  return poly.map(p => ({ X: p.X + dx, Y: p.Y + dy }));
}

/// A number rounded to a tenth of a unit, so a saved outline does not carry fifteen decimal places.
export function planRound(v: number): number { return Math.round(v * 10) / 10; }

/// An outline kept inside the floor: every point clamped to 0..w, 0..h and rounded.
export function planClamp(poly: Pt[], w: number, h: number): Pt[] {
  return poly.map(p => ({ X: planRound(Math.max(0, Math.min(w, p.X))), Y: planRound(Math.max(0, Math.min(h, p.Y))) }));
}

/// The value scale for shading: 0 to the largest known value, never 0 to 0.
export function planScaleMax(values: (number | null | undefined)[]): number {
  const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return known.length ? Math.max(...known) : 0;
}

/// The wall nearest a point: where on it, its direction in degrees, and how far away it is.
export function planNearestWall(p: Pt, outlines: Pt[][]): { pt: Pt; angle: number; dist: number } | null {
  let best: { pt: Pt; angle: number; dist: number } | null = null;
  for (const poly of outlines) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const q = planNearestOnSegment(p, a, b);
    const d = Math.hypot(p.X - q.X, p.Y - q.Y);
    if (!best || d < best.dist) best = { pt: q, angle: Math.atan2(b.Y - a.Y, b.X - a.X) * 180 / Math.PI, dist: d };
  }
  return best;
}

/// The length along a path of points.
export function planPathLength(points: Pt[]): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += Math.hypot(points[i].X - points[i - 1].X, points[i].Y - points[i - 1].Y);
  return s;
}

/// Is an outline a rectangle square to the page? Then it can be sized by width and depth.
export function planIsBox(poly: Pt[]): boolean {
  if (poly.length !== 4) return false;
  const xs = new Set(poly.map(p => planRound(p.X))), ys = new Set(poly.map(p => planRound(p.Y)));
  return xs.size === 2 && ys.size === 2;
}

/// The bounding box of an outline.
export function planBounds(poly: Pt[]): { x: number; y: number; w: number; h: number } {
  const xs = poly.map(p => p.X), ys = poly.map(p => p.Y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

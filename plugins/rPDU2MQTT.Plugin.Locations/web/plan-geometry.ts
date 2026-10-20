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
/// `others` may hold standalone walls as two-point lines, which snap without a far face.
/// `wall`: how thick a wall is. A point also snaps to the far face of a wall from a room, so a room drawn next door
/// leaves the wall between them.
export function planSnap(p: Pt, others: Pt[][], threshold: number, grid = 0, wall = 0): { pt: Pt; to: 'corner' | 'edge' | 'grid' | 'none' } {
  let best: Pt | null = null, bestD = threshold;
  for (const poly of others) for (const v of poly) {
    const d = planDist(p, v);
    if (d <= bestD) { best = v; bestD = d; }
  }
  if (best) return { pt: { X: best.X, Y: best.Y }, to: 'corner' };
  // Level and plumb walls nearby, each way on its own: X to the nearest upright wall, Y to the nearest level one.
  let sx: number | null = null, sy: number | null = null, dx = threshold, dy = threshold;
  for (const poly of others) {
    const turn = Math.sign(planArea(poly));
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const reach = threshold * 3;
      if (Math.abs(a.X - b.X) < 1e-6 && p.Y >= Math.min(a.Y, b.Y) - reach && p.Y <= Math.max(a.Y, b.Y) + reach) {
        const out = Math.sign(b.Y - a.Y) * turn;
        for (const x of wall > 0 && turn ? [a.X, a.X + out * wall] : [a.X]) { const d = Math.abs(p.X - x); if (d <= dx) { dx = d; sx = x; } }
      }
      if (Math.abs(a.Y - b.Y) < 1e-6 && p.X >= Math.min(a.X, b.X) - reach && p.X <= Math.max(a.X, b.X) + reach) {
        const out = Math.sign(a.X - b.X) * turn;
        for (const y of wall > 0 && turn ? [a.Y, a.Y + out * wall] : [a.Y]) { const d = Math.abs(p.Y - y); if (d <= dy) { dy = d; sy = y; } }
      }
    }
  }
  if (sx != null || sy != null) {
    const g = (v: number) => grid > 0 ? Math.round(v / grid) * grid : v;
    return { pt: { X: sx ?? g(p.X), Y: sy ?? g(p.Y) }, to: 'edge' };
  }
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

/// Everything wired downstream of an item: the runs leaving it from its load side, and what they lead to, onward.
export function planDownstream(runs: { Id: string; From?: string; To?: string }[], from: string): { items: Set<string>; runs: Set<string> } {
  const items = new Set<string>(), seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    runs.forEach(r => {
      if (r.From !== at || seen.has(r.Id)) return;
      seen.add(r.Id);
      if (r.To && r.To !== from && !items.has(r.To)) { items.add(r.To); queue.push(r.To); }
    });
  }
  return { items, runs: seen };
}

/// The nearest item upstream of this one that is a GFCI, following runs back toward the supply. Null when none is.
export function planProtectedBy(runs: { From?: string; To?: string }[], isGfci: (id: string) => boolean, id: string): string | null {
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const at of frontier) for (const r of runs) {
      if (r.To !== at || !r.From || seen.has(r.From)) continue;
      if (isGfci(r.From)) return r.From;
      seen.add(r.From);
      next.push(r.From);
    }
    frontier = next;
  }
  return null;
}

/// Two rooms that meet along a wall, as one outline: the shared stretch of wall goes, the rest is kept as drawn.
/// Null when they do not share a wall, overlap, or would leave a hole or two separate pieces.
export function planUnion(a: Pt[], b: Pt[], eps = 0.5): Pt[] | null {
  if (a.length < 3 || b.length < 3) return null;
  const ccw = (p: Pt[]) => planArea(p) < 0 ? [...p].reverse() : p;
  const A = ccw(a), B = ccw(b);
  const same = (p: Pt, q: Pt) => Math.hypot(p.X - q.X, p.Y - q.Y) <= eps;
  const onSeg = (p: Pt, s: Pt, t: Pt) => { const n = planNearestOnSegment(p, s, t); return same(n, p) && !same(p, s) && !same(p, t); };
  // Every edge broken wherever a corner of the other room sits along it, so shared stretches line up end to end.
  const split = (poly: Pt[], other: Pt[]) => {
    const out: [Pt, Pt][] = [];
    poly.forEach((s, i) => {
      const t = poly[(i + 1) % poly.length];
      const len = Math.hypot(t.X - s.X, t.Y - s.Y) || 1;
      const cuts = other.filter(p => onSeg(p, s, t)).map(p => ({ p, d: ((p.X - s.X) * (t.X - s.X) + (p.Y - s.Y) * (t.Y - s.Y)) / len })).sort((x, y) => x.d - y.d).map(x => x.p);
      [s, ...cuts, t].reduce((prev, cur) => { if (!same(prev, cur)) out.push([prev, cur]); return cur; });
    });
    return out;
  };
  const ea = split(A, B), eb = split(B, A);
  const shared = (e: [Pt, Pt], list: [Pt, Pt][]) => list.some(f => same(e[0], f[1]) && same(e[1], f[0]));
  const strictlyIn = (p: Pt, poly: Pt[]) => planContains(poly, p) && poly.every((s, i) => !same(planNearestOnSegment(p, s, poly[(i + 1) % poly.length]), p));
  const mid = (e: [Pt, Pt]) => ({ X: (e[0].X + e[1].X) / 2, Y: (e[0].Y + e[1].Y) / 2 });
  if (ea.some(e => strictlyIn(mid(e), B)) || eb.some(e => strictlyIn(mid(e), A))) return null;
  const keepA = ea.filter(e => !shared(e, eb)), keepB = eb.filter(e => !shared(e, ea));
  if (keepA.length === ea.length) return null;
  const edges = [...keepA, ...keepB];
  const loop: Pt[] = [];
  let at = edges.shift()!;
  loop.push(at[0]);
  while (edges.length) {
    const i = edges.findIndex(e => same(e[0], at[1]));
    if (i < 0) return null;
    at = edges.splice(i, 1)[0];
    loop.push(at[0]);
  }
  if (!same(at[1], loop[0])) return null;
  return planStraighten(loop, eps);
}

/// Corners left standing in the middle of a straight wall are dropped. Null when nothing of an outline is left.
/// A wall that ends inside a region traces out and back; those spikes go too.
export function planStraighten(loop: Pt[], eps = 0.5): Pt[] | null {
  let out = loop;
  for (let before = -1; before !== out.length && out.length >= 3;) {
    before = out.length;
    const cur = out;
    out = cur.filter((p, i) => {
      const s = cur[(i - 1 + cur.length) % cur.length], t = cur[(i + 1) % cur.length];
      if (Math.hypot(s.X - t.X, s.Y - t.Y) <= eps) return false;
      const n = planNearestOnSegment(p, s, t);
      return Math.hypot(n.X - p.X, n.Y - p.Y) > eps;
    });
    out = out.filter((p, i) => Math.hypot(p.X - out[(i + 1) % out.length].X, p.Y - out[(i + 1) % out.length].Y) > eps);
  }
  return out.length >= 3 ? out : null;
}

/// A room cut by a line drawn across it, wall to wall: the pieces, largest first. One piece when the line does not
/// reach across.
export function planSplit(room: Pt[], line: Pt[], eps = 0.5): Pt[][] {
  const parts = planFaces([room], eps, [line]).filter(f => planContains(room, f.at)).map(f => planStraighten(f.shape, eps)).filter((x): x is Pt[] => !!x);
  return parts.sort((a, b) => Math.abs(planArea(b)) - Math.abs(planArea(a)));
}

/// Every enclosed region the outlines carve the floor into, the empty spaces between rooms included: each edge is
/// cut wherever another edge or corner meets it, and the regions are traced edge to edge. `at` is a point just
/// inside each one, beside its first wall.
export function planFaces(polys: Pt[][], eps = 0.5, lines: Pt[][] = []): { shape: Pt[]; at: Pt }[] {
  const nodes: Pt[] = [];
  const node = (p: Pt) => {
    let i = nodes.findIndex(q => Math.hypot(p.X - q.X, p.Y - q.Y) <= eps);
    if (i < 0) { nodes.push({ X: p.X, Y: p.Y }); i = nodes.length - 1; }
    return i;
  };
  const segs: [Pt, Pt][] = [];
  polys.filter(p => p.length >= 3).forEach(p => p.forEach((s, i) => segs.push([s, p[(i + 1) % p.length]])));
  lines.forEach(l => l.slice(1).forEach((t, i) => segs.push([l[i], t])));
  const cross = (s: [Pt, Pt], t: [Pt, Pt]): Pt | null => {
    const [a, b] = s, [c, d] = t;
    const den = (b.X - a.X) * (d.Y - c.Y) - (b.Y - a.Y) * (d.X - c.X);
    if (Math.abs(den) < 1e-9) return null;
    const u = ((c.X - a.X) * (d.Y - c.Y) - (c.Y - a.Y) * (d.X - c.X)) / den;
    const v = ((c.X - a.X) * (b.Y - a.Y) - (c.Y - a.Y) * (b.X - a.X)) / den;
    return u > 0 && u < 1 && v > 0 && v < 1 ? { X: a.X + u * (b.X - a.X), Y: a.Y + u * (b.Y - a.Y) } : null;
  };
  const links = new Set<string>();
  segs.forEach(sg => {
    const [s, t] = sg;
    const len = Math.hypot(t.X - s.X, t.Y - s.Y);
    if (len <= eps) return;
    const cuts: Pt[] = [];
    segs.forEach(o => {
      if (o === sg) return;
      o.forEach(p => { const n = planNearestOnSegment(p, s, t); if (Math.hypot(n.X - p.X, n.Y - p.Y) <= eps) cuts.push(n); });
      const x = cross(sg, o);
      if (x) cuts.push(x);
    });
    const along = (p: Pt) => ((p.X - s.X) * (t.X - s.X) + (p.Y - s.Y) * (t.Y - s.Y)) / len;
    const ids = [s, ...cuts.sort((a, b) => along(a) - along(b)), t].map(node);
    for (let i = 1; i < ids.length; i++) if (ids[i] !== ids[i - 1]) links.add(Math.min(ids[i], ids[i - 1]) + ',' + Math.max(ids[i], ids[i - 1]));
  });
  const out = new Map<number, number[]>();
  links.forEach(k => { const [a, b] = k.split(',').map(Number); (out.get(a) || out.set(a, []).get(a)!).push(b); (out.get(b) || out.set(b, []).get(b)!).push(a); });
  const ang = (a: number, b: number) => Math.atan2(nodes[b].Y - nodes[a].Y, nodes[b].X - nodes[a].X);
  out.forEach((list, a) => list.sort((x, y) => ang(a, x) - ang(a, y)));
  // Arriving at b from a, carry on along the edge next round from the one back to a: each region is traced
  // with its inside on the same hand, and the outline around each group of rooms comes out the other way round.
  const used = new Set<string>();
  const faces: { shape: Pt[]; at: Pt }[] = [];
  out.forEach((list, a0) => list.forEach(b0 => {
    if (used.has(a0 + '>' + b0)) return;
    const loop: number[] = [];
    let a = a0, b = b0;
    for (let guard = 0; guard < 10000 && !used.has(a + '>' + b); guard++) {
      used.add(a + '>' + b); loop.push(a);
      const around = out.get(b)!;
      const next = around[(around.indexOf(a) - 1 + around.length) % around.length];
      a = b; b = next;
    }
    const shape = loop.map(i => nodes[i]);
    if (shape.length < 3 || planArea(shape) <= eps * eps) return;
    // A point a hair inside, off the middle of the longest wall, so it is in this region and not an island in it.
    let best = 0, bl = -1;
    shape.forEach((p, i) => { const q = shape[(i + 1) % shape.length]; const l = Math.hypot(q.X - p.X, q.Y - p.Y); if (l > bl) { bl = l; best = i; } });
    const p = shape[best], q = shape[(best + 1) % shape.length];
    const off = Math.min(eps * 2, bl / 4);
    faces.push({ shape, at: { X: (p.X + q.X) / 2 - (q.Y - p.Y) / bl * off, Y: (p.Y + q.Y) / 2 + (q.X - p.X) / bl * off } });
  }));
  return faces;
}

/// Regions traced by planFaces, joined back into one outline where they meet. Null when they do not make one piece.
export function planJoin(parts: Pt[][], eps = 0.5): Pt[] | null {
  if (!parts.length) return null;
  let shape = parts[0], rest = parts.slice(1);
  for (let progress = true; progress && rest.length;) {
    progress = false;
    for (const r of [...rest]) { const next = planUnion(shape, r, eps); if (next) { shape = next; rest = rest.filter(x => x !== r); progress = true; } }
  }
  return rest.length ? null : planStraighten(shape, eps);
}

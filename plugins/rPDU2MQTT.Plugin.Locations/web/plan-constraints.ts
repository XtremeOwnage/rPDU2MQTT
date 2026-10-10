// Geometric constraints on floor plans (#463): coincident corners, colinear, parallel and perpendicular walls,
// horizontal and vertical walls, fixed angles and fixed lengths — kept by relaxing the points toward each
// constraint in turn until they all hold. Corners that sit on top of one another move as one: a shared wall.
import { type Pt } from './plan-geometry.js';

export type PlanRef = { Room: string; Corner?: number | null; Edge?: number | null };
export type PlanConstraint = { Id: string; Kind: string; Refs: PlanRef[]; Value?: number | null };
export type PlanShape = { Id: string; Shape: Pt[]; Locked?: boolean; LockedWalls?: number[] };

/// Corners closer than this, in drawing units, are one corner shared by the rooms that meet there.
const SHARED = 0.5;

const norm180 = (a: number) => { a %= 360; if (a > 180) a -= 360; if (a <= -180) a += 360; return a; };
const norm90 = (a: number) => { a = norm180(a); if (a > 90) a -= 180; if (a <= -90) a += 180; return a; };

/// The corners a wall runs between.
export function planEdgeCorners(shape: PlanShape, edge: number): [number, number] {
  const n = shape.Shape.length;
  return [((edge % n) + n) % n, (((edge + 1) % n) + n) % n];
}

/// The signed angle at a corner, from the wall arriving to the wall leaving, in degrees.
export function planCornerAngle(shape: PlanShape, corner: number): number {
  const n = shape.Shape.length;
  const b = shape.Shape[corner], a = shape.Shape[(corner - 1 + n) % n], c = shape.Shape[(corner + 1) % n];
  const u = { X: a.X - b.X, Y: a.Y - b.Y }, v = { X: c.X - b.X, Y: c.Y - b.Y };
  return Math.atan2(u.X * v.Y - u.Y * v.X, u.X * v.X + u.Y * v.Y) * 180 / Math.PI;
}

/// The corners a set of shapes would move together: every corner within SHARED of another is in its group.
export function planSharedCorners(shapes: PlanShape[], room: string, corner: number): { room: string; corner: number }[] {
  const s = shapes.find(x => x.Id === room);
  const p = s?.Shape[corner];
  if (!p) return [];
  const out: { room: string; corner: number }[] = [];
  shapes.forEach(x => x.Shape.forEach((q, i) => { if (!(x.Id === room && i === corner) && Math.hypot(q.X - p.X, q.Y - p.Y) <= SHARED) out.push({ room: x.Id, corner: i }); }));
  return out;
}

/// How far a constraint is from holding: in drawing units for positions and lengths, in degrees for angles.
function residual(c: PlanConstraint, pt: (r: PlanRef, end?: number) => Pt | null, shapes: Map<string, PlanShape>): number {
  const edgeOf = (r: PlanRef) => { const a = pt(r, 0), b = pt(r, 1); return a && b ? [a, b] as [Pt, Pt] : null; };
  const angleOf = (e: [Pt, Pt]) => Math.atan2(e[1].Y - e[0].Y, e[1].X - e[0].X) * 180 / Math.PI;
  switch (c.Kind) {
    case 'coincident': { const a = pt(c.Refs[0]), b = pt(c.Refs[1]); return a && b ? Math.hypot(a.X - b.X, a.Y - b.Y) : 0; }
    case 'length': { const e = edgeOf(c.Refs[0]); return e && c.Value != null ? Math.abs(Math.hypot(e[1].X - e[0].X, e[1].Y - e[0].Y) - c.Value) : 0; }
    case 'horizontal': { const e = edgeOf(c.Refs[0]); return e ? Math.abs(e[1].Y - e[0].Y) : 0; }
    case 'vertical': { const e = edgeOf(c.Refs[0]); return e ? Math.abs(e[1].X - e[0].X) : 0; }
    case 'parallel': case 'perpendicular': case 'colinear': {
      const e1 = edgeOf(c.Refs[0]), e2 = edgeOf(c.Refs[1]);
      if (!e1 || !e2) return 0;
      const d = norm90(angleOf(e1) - angleOf(e2) - (c.Kind === 'perpendicular' ? 90 : 0));
      if (c.Kind !== 'colinear') return Math.abs(d);
      const L = Math.hypot(e1[1].X - e1[0].X, e1[1].Y - e1[0].Y) || 1;
      const n = { X: -(e1[1].Y - e1[0].Y) / L, Y: (e1[1].X - e1[0].X) / L };
      return Math.abs(d) + Math.max(...e2.map(q => Math.abs((q.X - e1[0].X) * n.X + (q.Y - e1[0].Y) * n.Y)));
    }
    case 'angle': {
      const r = c.Refs[0], s = shapes.get(r.Room);
      return s && r.Corner != null && c.Value != null ? Math.abs(norm180(planCornerAngle(s, r.Corner) - c.Value)) : 0;
    }
  }
  return 0;
}

/// Move the free corners until every constraint holds, or as near as they can. Corners of a locked room, of a
/// locked wall, or named in `fixed` ("room#corner") do not move. Returns the worst constraint left unmet.
export function planSolve(shapes: PlanShape[], constraints: PlanConstraint[], fixed: Set<string> = new Set(), iterations = 120): { worst: number; unmet: string[] } {
  const byId = new Map(shapes.map(s => [s.Id, s]));
  // Corners that coincide are one variable: moving one moves every room that shares it.
  type Var = { X: number; Y: number; w: number; members: [PlanShape, number][] };
  const vars: Var[] = [];
  const varOf = new Map<string, Var>();
  shapes.forEach(s => s.Shape.forEach((p, i) => {
    const key = `${s.Id}#${i}`;
    let v = vars.find(x => Math.hypot(x.X - p.X, x.Y - p.Y) <= SHARED);
    if (!v) { v = { X: p.X, Y: p.Y, w: 1, members: [] }; vars.push(v); }
    v.members.push([s, i]);
    varOf.set(key, v);
    const n = s.Shape.length;
    const walled = (s.LockedWalls || []).some(e => e === i || ((e + 1) % n) === i);
    if (s.Locked || walled || fixed.has(key)) v.w = 0;
  }));
  if (!constraints.length) return { worst: 0, unmet: [] };
  const vRef = (r: PlanRef, end = 0): Var | null => {
    const s = byId.get(r.Room);
    if (!s || !s.Shape.length) return null;
    const i = r.Corner != null ? r.Corner : r.Edge != null ? planEdgeCorners(s, r.Edge)[end] : null;
    return i == null || i < 0 || i >= s.Shape.length ? null : varOf.get(`${s.Id}#${i}`) || null;
  };
  const both = (a: Var, b: Var) => a.w + b.w;
  const rotate = (p: Var, pivot: Pt, deg: number) => {
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const x = p.X - pivot.X, y = p.Y - pivot.Y;
    p.X = pivot.X + x * c - y * s; p.Y = pivot.Y + x * s + y * c;
  };
  /// Turn a wall about whichever end is held, or its middle when neither is.
  const turnEdge = (a: Var, b: Var, deg: number) => {
    if (!a.w && !b.w) return;
    const pivot = !a.w ? { X: a.X, Y: a.Y } : !b.w ? { X: b.X, Y: b.Y } : { X: (a.X + b.X) / 2, Y: (a.Y + b.Y) / 2 };
    if (a.w) rotate(a, pivot, deg);
    if (b.w) rotate(b, pivot, deg);
  };
  const edgeW = (a: Var, b: Var) => (a.w && b.w ? 1 : a.w || b.w ? 0.5 : 0);
  const ang = (a: Var, b: Var) => Math.atan2(b.Y - a.Y, b.X - a.X) * 180 / Math.PI;

  for (let it = 0; it < iterations; it++) {
    for (const c of constraints) {
      const r0 = c.Refs[0], r1 = c.Refs[1];
      if (c.Kind === 'coincident') {
        const a = vRef(r0), b = vRef(r1);
        if (!a || !b || a === b || !both(a, b)) continue;
        const dx = b.X - a.X, dy = b.Y - a.Y, k = both(a, b);
        a.X += dx * a.w / k; a.Y += dy * a.w / k; b.X -= dx * b.w / k; b.Y -= dy * b.w / k;
      } else if (c.Kind === 'length' && c.Value != null) {
        const a = vRef(r0, 0), b = vRef(r0, 1);
        if (!a || !b || !both(a, b)) continue;
        const dx = b.X - a.X, dy = b.Y - a.Y, cur = Math.hypot(dx, dy) || 1e-9, diff = (cur - c.Value) / cur, k = both(a, b);
        a.X += dx * diff * a.w / k; a.Y += dy * diff * a.w / k; b.X -= dx * diff * b.w / k; b.Y -= dy * diff * b.w / k;
      } else if (c.Kind === 'horizontal' || c.Kind === 'vertical') {
        const a = vRef(r0, 0), b = vRef(r0, 1);
        if (!a || !b || !both(a, b)) continue;
        const k = both(a, b);
        if (c.Kind === 'horizontal') { const d = b.Y - a.Y; a.Y += d * a.w / k; b.Y -= d * b.w / k; }
        else { const d = b.X - a.X; a.X += d * a.w / k; b.X -= d * b.w / k; }
      } else if (c.Kind === 'angle' && c.Value != null && r0?.Corner != null) {
        const s = byId.get(r0.Room);
        if (!s || s.Shape.length < 3) continue;
        const n = s.Shape.length;
        const B = varOf.get(`${s.Id}#${r0.Corner}`), A = varOf.get(`${s.Id}#${(r0.Corner - 1 + n) % n}`), C = varOf.get(`${s.Id}#${(r0.Corner + 1) % n}`);
        if (!A || !B || !C) continue;
        const u = { X: A.X - B.X, Y: A.Y - B.Y }, v = { X: C.X - B.X, Y: C.Y - B.Y };
        const cur = Math.atan2(u.X * v.Y - u.Y * v.X, u.X * v.X + u.Y * v.Y) * 180 / Math.PI;
        const err = norm180(c.Value - cur);
        const k = A.w + C.w;
        if (!k) continue;
        rotate(C, B, err * C.w / k);
        rotate(A, B, -err * A.w / k);
      } else if (c.Kind === 'parallel' || c.Kind === 'perpendicular' || c.Kind === 'colinear') {
        const a = vRef(r0, 0), b = vRef(r0, 1), p = vRef(r1, 0), q = vRef(r1, 1);
        if (!a || !b || !p || !q) continue;
        const w1 = edgeW(a, b), w2 = edgeW(p, q);
        if (!w1 && !w2) continue;
        const d = norm90(ang(a, b) - ang(p, q) - (c.Kind === 'perpendicular' ? 90 : 0));
        turnEdge(p, q, d * w2 / (w1 + w2));
        turnEdge(a, b, -d * w1 / (w1 + w2));
        if (c.Kind === 'colinear') {
          // Then the second wall is brought onto the first one's line, each side giving way by what it is free to.
          const L = Math.hypot(b.X - a.X, b.Y - a.Y) || 1e-9;
          const nx = -(b.Y - a.Y) / L, ny = (b.X - a.X) / L;
          [p, q].forEach(x => {
            const dist = (x.X - a.X) * nx + (x.Y - a.Y) * ny;
            const k = x.w + w1;
            if (!k) return;
            x.X -= nx * dist * x.w / k; x.Y -= ny * dist * x.w / k;
            const back = dist * w1 / k / 2;
            if (a.w) { a.X += nx * back; a.Y += ny * back; }
            if (b.w) { b.X += nx * back; b.Y += ny * back; }
          });
        }
      }
    }
  }
  // Write each variable back to every corner that shares it, rounded as outlines are stored.
  vars.forEach(v => v.members.forEach(([s, i]) => { s.Shape[i] = { X: Math.round(v.X * 10) / 10, Y: Math.round(v.Y * 10) / 10 }; }));

  const pt = (r: PlanRef, end = 0): Pt | null => {
    const s = byId.get(r.Room);
    if (!s || !s.Shape.length) return null;
    const i = r.Corner != null ? r.Corner : r.Edge != null ? planEdgeCorners(s, r.Edge)[end] : null;
    return i == null ? null : s.Shape[i] || null;
  };
  let worst = 0;
  const unmet: string[] = [];
  constraints.forEach(c => {
    const e = residual(c, pt, byId);
    const tol = c.Kind === 'angle' || c.Kind === 'parallel' || c.Kind === 'perpendicular' ? 0.5 : 1;
    if (e > tol) unmet.push(c.Id);
    worst = Math.max(worst, e);
  });
  return { worst, unmet };
}

/// Keep constraints pointing at the same corners when one is added at `at` in a room's outline.
export function planRefsAfterInsert(constraints: PlanConstraint[], room: string, at: number): void {
  constraints.forEach(c => c.Refs.forEach(r => {
    if (r.Room !== room) return;
    if (r.Corner != null && r.Corner >= at) r.Corner++;
    if (r.Edge != null && r.Edge >= at) r.Edge++;
  }));
}

/// Drop what a removed corner held, and renumber the rest.
export function planRefsAfterRemove(constraints: PlanConstraint[], room: string, at: number, count: number): PlanConstraint[] {
  const kept = constraints.filter(c => !c.Refs.some(r => r.Room === room && (r.Corner === at || r.Edge === at || r.Edge === (at - 1 + count) % count)));
  kept.forEach(c => c.Refs.forEach(r => {
    if (r.Room !== room) return;
    if (r.Corner != null && r.Corner > at) r.Corner--;
    if (r.Edge != null && r.Edge > at) r.Edge--;
  }));
  return kept;
}

/// Everything that no longer refers to a room: when it is deleted, or its outline redrawn.
export function planRefsWithout(constraints: PlanConstraint[], room: string): PlanConstraint[] {
  return constraints.filter(c => !c.Refs.some(r => r.Room === room));
}

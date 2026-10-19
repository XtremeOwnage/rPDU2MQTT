// Geometric constraints on floor plans (#463): coincident corners (or a corner on a wall), colinear, parallel and perpendicular walls,
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
    case 'coincident': {
      const [p, e] = c.Refs[0]?.Corner != null ? [c.Refs[0], c.Refs[1]] : [c.Refs[1], c.Refs[0]];
      if (!p || !e) return 0;
      const a = pt(p);
      if (!a) return 0;
      if (e.Corner != null) { const b = pt(e); return b ? Math.hypot(a.X - b.X, a.Y - b.Y) : 0; }
      // A corner on a wall: how far it is off the wall's line.
      const w = edgeOf(e);
      if (!w) return 0;
      const L = Math.hypot(w[1].X - w[0].X, w[1].Y - w[0].Y) || 1;
      return Math.abs((a.X - w[0].X) * (w[1].Y - w[0].Y) - (a.Y - w[0].Y) * (w[1].X - w[0].X)) / L;
    }
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

/// What a solve knows beyond the plan as it is now. `before` is the plan as it was before this edit, so corners that
/// were shared stay shared once one of them has moved. `hold` names the rooms being reshaped by hand: every other
/// room is only pulled along, by the corners it shares or is joined at, and keeps its level and plumb walls so as it
/// goes, stretching as a rectangle instead of skewing (#602).
/// `keep` holds the level and plumb walls of the rooms in `hold` too, as a rectangle in a sketch is held: dragging a
/// corner resizes the room square instead of skewing it.
export type PlanSolveOpts = { before?: PlanShape[]; hold?: string[]; keep?: boolean };

/// Move the free corners until every constraint holds, or as near as they can. Corners of a locked room, of a
/// locked wall, or named in `fixed` ("room#corner") do not move. Coincident corners are one point. Returns the worst
/// constraint left unmet.
export function planSolve(shapes: PlanShape[], constraints: PlanConstraint[], fixed: Set<string> = new Set(), iterations = 120, opts: PlanSolveOpts = {}): { worst: number; unmet: string[] } {
  const byId = new Map(shapes.map(s => [s.Id, s]));
  const keyOf = (r: PlanRef | undefined, end = 0): string | null => {
    const s = r && byId.get(r.Room);
    if (!s || !s.Shape.length) return null;
    const i = r!.Corner != null ? r!.Corner : r!.Edge != null ? planEdgeCorners(s, r!.Edge)[end] : null;
    return i == null || i < 0 || i >= s.Shape.length ? null : `${s.Id}#${i}`;
  };
  const isPoint = (r?: PlanRef) => !!r && r.Corner != null;
  const pt = (r: PlanRef, end = 0): Pt | null => {
    const k = keyOf(r, end);
    return k ? byId.get(r.Room)!.Shape[Number(k.slice(k.lastIndexOf('#') + 1))] || null : null;
  };
  const evaluate = () => {
    let worst = 0;
    const unmet: string[] = [];
    constraints.forEach(c => {
      const e = residual(c, pt, byId);
      const tol = c.Kind === 'angle' || c.Kind === 'parallel' || c.Kind === 'perpendicular' ? 0.5 : 1;
      if (e > tol) unmet.push(c.Id);
      worst = Math.max(worst, e);
    });
    return { worst, unmet };
  };
  if (!constraints.length && !opts.hold) return { worst: 0, unmet: [] };
  if (iterations <= 0) return evaluate();

  // The rooms only pulled along keep the walls that are level or plumb so.
  const implied: PlanConstraint[] = [];
  const followers = new Set<string>();
  if (opts.hold) {
    const hold = new Set(opts.hold);
    shapes.forEach(s => {
      const held = hold.has(s.Id);
      if ((held && !opts.keep) || s.Locked) return;
      if (constraints.some(c => c.Kind === 'angle' && c.Refs[0]?.Room === s.Id && Math.abs(Math.abs(Number(c.Value) || 0) - 90) > 0.5)) return;
      if (!held) followers.add(s.Id);
      const id = held ? 'keep' : '';
      const was = opts.before?.find(b => b.Id === s.Id && b.Shape.length === s.Shape.length) || s;
      const n = was.Shape.length;
      was.Shape.forEach((p, i) => {
        const q = was.Shape[(i + 1) % n];
        if (Math.hypot(q.X - p.X, q.Y - p.Y) < 1) return;
        if (Math.abs(q.Y - p.Y) <= 0.15) implied.push({ Id: id, Kind: 'horizontal', Refs: [{ Room: s.Id, Edge: i }] });
        else if (Math.abs(q.X - p.X) <= 0.15) implied.push({ Id: id, Kind: 'vertical', Refs: [{ Room: s.Id, Edge: i }] });
      });
    });
  }
  const all = [...constraints, ...implied];
  if (!all.length) return { worst: 0, unmet: [] };

  /// `led`: the point belongs to a room that is not merely following, so what a follower keeps cannot move it.
  type Var = { X: number; Y: number; w: number; members: string[]; led?: boolean };
  const at = (k: string) => { const h = k.lastIndexOf('#'); return byId.get(k.slice(0, h))!.Shape[Number(k.slice(h + 1))]; };
  const put = (k: string, p: Pt) => { const h = k.lastIndexOf('#'); byId.get(k.slice(0, h))!.Shape[Number(k.slice(h + 1))] = p; };
  const keys: string[] = [];
  const locked = new Set<string>();
  shapes.forEach(s => {
    const n = s.Shape.length;
    s.Shape.forEach((_, i) => {
      const k = `${s.Id}#${i}`;
      keys.push(k);
      if (s.Locked || (s.LockedWalls || []).some(e => e === i || ((e + 1) % n) === i)) locked.add(k);
    });
  });
  // Which corners are one point: those that sat together before this edit, and those joined by a coincident constraint.
  const parent = new Map(keys.map(k => [k, k]));
  const find = (k: string): string => { while (parent.get(k) !== k) { const up = parent.get(parent.get(k)!)!; parent.set(k, up); k = up; } return k; };
  const join = (a: string | null, b: string | null) => { if (!a || !b) return; const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const was = shapes.map(s => opts.before?.find(b => b.Id === s.Id && b.Shape.length === s.Shape.length) || s);
  const flat: [string, Pt][] = [];
  was.forEach((s, j) => s.Shape.forEach((p, i) => flat.push([`${shapes[j].Id}#${i}`, p])));
  for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) {
    const p = flat[i][1], q = flat[j][1];
    if (Math.abs(p.X - q.X) <= SHARED && Math.abs(p.Y - q.Y) <= SHARED && Math.hypot(p.X - q.X, p.Y - q.Y) <= SHARED) join(flat[i][0], flat[j][0]);
  }
  const leads = new Set<string>();
  constraints.forEach(c => { if (c.Kind === 'coincident' && isPoint(c.Refs[0]) && isPoint(c.Refs[1])) { const a = keyOf(c.Refs[0]), b = keyOf(c.Refs[1]); if (a) leads.add(a); join(a, b); } });
  const groups = new Map<string, string[]>();
  keys.forEach(k => { const r = find(k); const g = groups.get(r); if (g) g.push(k); else groups.set(r, [k]); });

  const relax = () => {
    const vars: Var[] = [];
    const varOf = new Map<string, Var>();
    const hard = (k: string) => locked.has(k) || fixed.has(k);
    groups.forEach(ms => {
      // Corners held in different places cannot be one point; each is its own, and the constraint goes unmet.
      const held: Var[] = [];
      ms.filter(hard).forEach(k => {
        const p = at(k);
        let v = held.find(c => Math.hypot(c.X - p.X, c.Y - p.Y) <= SHARED);
        if (!v) { v = { X: p.X, Y: p.Y, w: 0, members: [] }; held.push(v); }
        v.members.push(k);
      });
      const rest = ms.filter(k => !hard(k));
      if (!held.length) {
        const lead = rest.find(k => leads.has(k)) || rest[0];
        const p = at(lead);
        held.push({ X: p.X, Y: p.Y, w: 1, members: [] });
      }
      rest.forEach(k => {
        const p = at(k);
        let best = held[0];
        held.forEach(v => { if (Math.hypot(v.X - p.X, v.Y - p.Y) < Math.hypot(best.X - p.X, best.Y - p.Y)) best = v; });
        best.members.push(k);
      });
      held.forEach(v => { v.led = v.members.some(k => !followers.has(k.slice(0, k.lastIndexOf('#')))); vars.push(v); v.members.forEach(k => varOf.set(k, v)); });
    });
    const vRef = (r: PlanRef | undefined, end = 0): Var | null => { const k = keyOf(r, end); return k ? varOf.get(k) || null : null; };
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
    /// Bring a point onto a wall's line, the point and the wall each giving way by what they are free to.
    const ontoLine = (x: Var, a: Var, b: Var, wl: number) => {
      const L = Math.hypot(b.X - a.X, b.Y - a.Y) || 1e-9;
      const nx = -(b.Y - a.Y) / L, ny = (b.X - a.X) / L;
      const dist = (x.X - a.X) * nx + (x.Y - a.Y) * ny;
      const k = x.w + wl;
      if (!k) return;
      x.X -= nx * dist * x.w / k; x.Y -= ny * dist * x.w / k;
      const back = dist * wl / k;
      if (a.w) { a.X += nx * back; a.Y += ny * back; }
      if (b.w) { b.X += nx * back; b.Y += ny * back; }
    };

    for (let it = 0; it < iterations; it++) {
      for (const c of all) {
        const r0 = c.Refs[0], r1 = c.Refs[1];
        if (c.Kind === 'coincident') {
          if (isPoint(r0) && isPoint(r1)) {
            const a = vRef(r0), b = vRef(r1);
            if (!a || !b || a === b || !both(a, b)) continue;
            const dx = b.X - a.X, dy = b.Y - a.Y, k = both(a, b);
            a.X += dx * a.w / k; a.Y += dy * a.w / k; b.X -= dx * b.w / k; b.Y -= dy * b.w / k;
          } else {
            // A corner on a wall: it lies on the wall's line.
            const [p, e] = isPoint(r0) ? [r0, r1] : [r1, r0];
            const x = vRef(p), a = vRef(e, 0), b = vRef(e, 1);
            if (!x || !a || !b || x === a || x === b) continue;
            ontoLine(x, a, b, edgeW(a, b));
          }
        } else if (c.Kind === 'length' && c.Value != null) {
          const a = vRef(r0, 0), b = vRef(r0, 1);
          if (!a || !b || !both(a, b)) continue;
          const dx = b.X - a.X, dy = b.Y - a.Y, cur = Math.hypot(dx, dy) || 1e-9, diff = (cur - c.Value) / cur, k = both(a, b);
          a.X += dx * diff * a.w / k; a.Y += dy * diff * a.w / k; b.X -= dx * diff * b.w / k; b.Y -= dy * diff * b.w / k;
        } else if (c.Kind === 'horizontal' || c.Kind === 'vertical') {
          const a = vRef(r0, 0), b = vRef(r0, 1);
          if (!a || !b) continue;
          // A follower's own level and plumb walls give way to the room it follows, never the other way.
          const wa = c.Id === '' && a.led ? 0 : a.w, wb = c.Id === '' && b.led ? 0 : b.w, k = wa + wb;
          if (!k) continue;
          if (c.Kind === 'horizontal') { const d = b.Y - a.Y; a.Y += d * wa / k; b.Y -= d * wb / k; }
          else { const d = b.X - a.X; a.X += d * wa / k; b.X -= d * wb / k; }
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
          if (k) {
            rotate(C, B, err * C.w / k);
            rotate(A, B, -err * A.w / k);
          } else if (B.w) {
            // Both walls' far ends are held: the corner itself moves, onto the circle where the walls meet at that angle.
            const mid = { X: (A.X + C.X) / 2, Y: (A.Y + C.Y) / 2 };
            const half = Math.hypot(C.X - A.X, C.Y - A.Y) / 2;
            const t = Math.abs(c.Value) * Math.PI / 180;
            const R = half / Math.max(1e-6, Math.sin(t));
            const off = R * Math.cos(t);
            const L = half * 2 || 1e-9;
            const nx = -(C.Y - A.Y) / L, ny = (C.X - A.X) / L;
            const side = Math.sign((B.X - mid.X) * nx + (B.Y - mid.Y) * ny) || 1;
            const cx = mid.X + nx * side * off, cy = mid.Y + ny * side * off;
            const d = Math.hypot(B.X - cx, B.Y - cy) || 1e-9;
            B.X = cx + (B.X - cx) / d * R; B.Y = cy + (B.Y - cy) / d * R;
          }
        } else if (c.Kind === 'parallel' || c.Kind === 'perpendicular' || c.Kind === 'colinear') {
          const a = vRef(r0, 0), b = vRef(r0, 1), p = vRef(r1, 0), q = vRef(r1, 1);
          if (!a || !b || !p || !q) continue;
          const w1 = edgeW(a, b), w2 = edgeW(p, q);
          if (!w1 && !w2) continue;
          const d = norm90(ang(a, b) - ang(p, q) - (c.Kind === 'perpendicular' ? 90 : 0));
          turnEdge(p, q, d * w2 / (w1 + w2));
          turnEdge(a, b, -d * w1 / (w1 + w2));
          if (c.Kind === 'colinear') [p, q].forEach(x => ontoLine(x, a, b, w1 / 2));
        }
      }
    }
    // Write each point back to every corner that is it, rounded as outlines are stored.
    vars.forEach(v => v.members.forEach(k => put(k, { X: Math.round(v.X * 10) / 10, Y: Math.round(v.Y * 10) / 10 })));
  };

  relax();
  return evaluate();
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

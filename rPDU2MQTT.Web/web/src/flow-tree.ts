// The flow as a tree, for the views that draw it as one: the sunburst and the treemap.
//
// The root is the hub the supply converges on — an inverter, a main panel — or, with none, every root side
// by side. Each node's children are what it feeds. A node fed from two parents is a child of each, carrying
// that parent's share of it, so every level still adds up.

export type TreeNode = {
  id: string;
  label: string;
  /// What this piece carries: a parent's share of the node when it has two.
  value: number;
  /// What the children are measured against: the larger of the value and what it passes on. What a node
  /// passes on can be less than it takes (its own use), and a reading short of its children must not
  /// let them overflow it.
  scale: number;
  depth: number;
  /// The top-level branch it belongs to, for its colour.
  branch: number;
  parent: TreeNode | null;
  children: TreeNode[];
  /// A unique key: the ids from the top down, since one node can appear under two parents.
  key: string;
};

/// Where the supply converges: the first node every root reaches, followed on while it feeds only one node.
/// Its direct feeders are the supply. With no such node the hub is null.
export function findHub(nodes: any[], links: any[]): { hub: string | null; supply: string[] } {
  const ids = new Set(nodes.map(n => n.id));
  const out = new Map<string, string[]>();
  links.forEach(l => { if (ids.has(l.source) && ids.has(l.target)) (out.get(l.source) ?? out.set(l.source, []).get(l.source)!).push(l.target); });
  const fed = new Set(links.map(l => l.target));
  const roots = nodes.filter(n => !fed.has(n.id)).map(n => n.id);
  if (!roots.length) return { hub: null, supply: [] };
  const reached = new Map<string, number>();
  roots.forEach(r => {
    const seen = new Set<string>([r]);
    for (let todo = [r]; todo.length;) (out.get(todo.pop()!) || []).forEach(t => { if (!seen.has(t)) { seen.add(t); todo.push(t); } });
    seen.forEach(id => reached.set(id, (reached.get(id) || 0) + 1));
  });
  const common = new Set([...reached].filter(([, n]) => n === roots.length).map(([id]) => id));
  const firsts = [...common].filter(id => !links.some(l => l.target === id && common.has(l.source)));
  if (firsts.length !== 1) return { hub: null, supply: [] };
  let hub = firsts[0];
  const seen = new Set<string>([hub]);
  for (let next = out.get(hub) || []; next.length === 1 && !seen.has(next[0]); next = out.get(hub) || []) { hub = next[0]; seen.add(hub); }
  if ((out.get(hub) || []).length === 0) return { hub: null, supply: [] };
  const supply = [...new Set(links.filter(l => l.target === hub && ids.has(l.source)).map(l => l.source))];
  return { hub, supply };
}

/// The top-level branches, largest first, each with its subtree; and the total they add up to.
export function flowTree(nodes: any[], links: any[], hub: string | null): { top: TreeNode[]; total: number; depth: number } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out = new Map<string, any[]>();
  links.forEach(l => { if ((l.value ?? 0) > 0) (out.get(l.source) ?? out.set(l.source, []).get(l.source)!).push(l); });
  const fed = new Set(links.map(l => l.target));
  const firsts: { id: string; value: number }[] = hub
    ? (out.get(hub) || []).map(l => ({ id: l.target, value: l.value }))
    : nodes.filter(n => !fed.has(n.id) && (n.value ?? 0) > 0).map(n => ({ id: n.id, value: n.value }));
  firsts.sort((x, y) => y.value - x.value);
  const total = firsts.reduce((s, t) => s + t.value, 0);
  let depth = 0;

  const build = (id: string, value: number, d: number, branch: number, parent: TreeNode | null, path: Set<string>): TreeNode | null => {
    const n = byId.get(id);
    if (!n || path.has(id) || !(value > 0)) return null;
    const t: TreeNode = { id, label: n.label || id, value, scale: value, depth: d, branch, parent, children: [],
                          key: (parent ? parent.key + '>' : '') + id };
    depth = Math.max(depth, d);
    // This piece may be only part of the node — one parent's share of something fed from two — so its
    // children are that same share of the node's own links.
    const share = (n.value ?? 0) > 0 ? Math.min(1, value / n.value) : 1;
    const next = new Set(path).add(id);
    (out.get(id) || [])
      .map(l => ({ id: l.target, v: l.value * share }))
      .sort((a, b) => b.v - a.v)
      .forEach(p => { const c = build(p.id, p.v, d + 1, branch, t, next); if (c) t.children.push(c); });
    const passed = t.children.reduce((s, c) => s + c.value, 0);
    t.scale = Math.max(value, passed);
    return t;
  };

  const top = firsts
    .map((f, i) => build(f.id, f.value, 1, i, null, new Set(hub ? [hub] : [])))
    .filter((t): t is TreeNode => !!t);
  return { top, total, depth };
}

/// Labels from the top of the drawing down to a node, the node itself excluded.
export function treePath(t: TreeNode, rootLabel: string | null): string[] {
  const path: string[] = [];
  for (let p = t.parent; p; p = p.parent) path.unshift(p.label);
  if (rootLabel) path.unshift(rootLabel);
  return path;
}

/// A colour per top-level branch, lighter with each level down, the same in both views.
export const branchHue = (branch: number) => (branch * 57 + 205) % 360;
export const treeFill = (t: TreeNode) => `hsl(${branchHue(t.branch)} 62% ${Math.min(76, 44 + t.depth * 7)}%)`;

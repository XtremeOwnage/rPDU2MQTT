// Shared app state, set on load().
export const state: { schema: any[]; data: any; derivations: any[]; viewer: boolean } = { schema: [], data: {}, derivations: [], viewer: false };

/// One page asking another to open on something specific; consumed once by the page that lands.
export const focus: { nodes: string[] | null; range: string | null; label: string | null } =
  { nodes: null, range: null, label: null };

/// Ask a page to open focused on these nodes. `range` is a Trends range value, e.g. 'today=1&step=300'.
export function requestFocus(nodes: string[], range: string | null, label: string | null) {
  focus.nodes = nodes.length ? [...nodes] : null;
  focus.range = range;
  focus.label = label;
}

/// Take and clear the pending request.
export function takeFocus() {
  if (!focus.nodes) return null;
  const taken = { nodes: focus.nodes, range: focus.range, label: focus.label };
  focus.nodes = null; focus.range = null; focus.label = null;
  return taken;
}

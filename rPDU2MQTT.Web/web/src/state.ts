// Shared, mutable app state: the config schema and the editable config document, both set on load().
// (Authored as ES modules; the build bundles them into one shared scope, as the GUI has always run.)
export const state: { schema: any[]; data: any } = { schema: [], data: {} };

/// One page asking another to open on something specific — "show me Solar for today".
///
/// Set by whoever is navigating, consumed once by the page that lands. Deliberately not in the URL: the
/// hash is the tab, and a node set encoded into it would be a second router to keep honest. A request that
/// is never collected simply expires the next time one is made.
export const focus: { nodes: string[] | null; range: string | null; label: string | null } =
  { nodes: null, range: null, label: null };

/// Ask a page to open focused on these nodes. `range` is a Trends range value, e.g. 'today=1&step=300'.
export function requestFocus(nodes: string[], range: string | null, label: string | null) {
  focus.nodes = nodes.length ? [...nodes] : null;
  focus.range = range;
  focus.label = label;
}

/// Take the pending request, if there is one. Reading it clears it — landing on the page twice should not
/// re-apply a selection the reader has since changed.
export function takeFocus() {
  if (!focus.nodes) return null;
  const taken = { nodes: focus.nodes, range: focus.range, label: focus.label };
  focus.nodes = null; focus.range = null; focus.label = null;
  return taken;
}

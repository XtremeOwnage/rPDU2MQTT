// How much of the flow chart to draw: the unmetered-remainder and animation switches (browser-local), and
import { btn, el, toast } from './helpers.js';
import { state } from './state.js';

// --- Node groups (#groups): several nodes shown as one collapsible node on both flow graphs. Collapse
export const collapsedGroups = new Set<string>();
export const seenGroups = new Set<string>();   // groups we've applied the default (collapsed) to at least once

export function flowGroups(): any[] {
  return (state.data?.EnergyFlow?.Groups || []).filter((g: any) => g && g.Id);
}

// Collapse each group the FIRST time we see it (a group exists to tidy the diagram; opening it is the
export function ensureGroupState() {
  flowGroups().forEach((g: any) => { if (!seenGroups.has(g.Id)) { seenGroups.add(g.Id); collapsedGroups.add(g.Id); } });
}

// A member's owning group id, only when that group is currently collapsed.
export function collapsedMemberMap(): Record<string, any> {
  const map: Record<string, any> = {};
  flowGroups().forEach((g: any) => { if (collapsedGroups.has(g.Id)) (g.Members || []).forEach((m: string) => { map[m] = g; }); });
  return map;
}

// Fold a graph's {nodes, links} so each collapsed group becomes a single node (its members' sum), with the
/**
 * An expanded group shows its members *instead of* its anchor, not as well as it.
 *
 * The anchor (a group whose Id is also a real node — "Solar (PV)" over MPPT_1..3) stays the node everything
 * else uses: the rollup, the MQTT export, the HA feed. On the diagram it is one level of detail, and its
 * members are the other. Drawing both put an extra hop in the chain — members → anchor → inverter — which
 * added nothing (the anchor's reading just IS the members' sum) and braided the links into an X.
 *
 * So expanding substitutes: the members take over the anchor's outgoing links and the anchor drops out.
 * Collapsing does the reverse, which collapseGraph already handles. Both views carry the same total, and
 * the toggle changes only how finely it is broken down.
 *
 * Skipped when the anchor feeds more than one target: splitting each member's contribution across several
 * downstream nodes would mean inventing a split nothing measures. Chaining is wrong there too, but it is
 * at least not a fabricated number, so that case keeps the hop.
 */
export function explodeExpandedGroups(nodes: any[], links: any[]): { nodes: any[]; links: any[] } {
  const groups = flowGroups().filter((g: any) => g && g.Id && !collapsedGroups.has(g.Id));
  if (!groups.length) return { nodes, links };

  let outNodes = nodes, outLinks = links;
  groups.forEach((g: any) => {
    const byId: any = {}; outNodes.forEach((n: any) => { byId[n.id] = n; });
    if (!byId[g.Id]) return;                                    // synthetic group: nothing to substitute
    const members = (g.Members || []).filter((m: string) => byId[m]);
    if (!members.length) return;

    const feedsAnchor = outLinks.filter((l: any) => l.target === g.Id && members.includes(l.source));
    const anchorFeeds = outLinks.filter((l: any) => l.source === g.Id);
    if (!feedsAnchor.length || anchorFeeds.length !== 1) return;

    const target = anchorFeeds[0];
    const kept = outLinks.filter((l: any) => l.source !== g.Id && !(l.target === g.Id && members.includes(l.source)));
    outLinks = kept.concat(feedsAnchor.map((ml: any) => ({
      source: ml.source, target: target.target, value: ml.value,
      known: ml.known !== false && target.known !== false,
    })));
    outNodes = outNodes.filter((n: any) => n.id !== g.Id);
  });
  return { nodes: outNodes, links: outLinks };
}

export function collapseGraph(nodes: any[], links: any[]): { nodes: any[]; links: any[] } {
  const memberOf = collapsedMemberMap();
  if (!Object.keys(memberOf).length) return { nodes, links };

  const byId: any = {}; nodes.forEach(n => { byId[n.id] = n; });
  const groupNode: Record<string, any> = {};
  flowGroups().forEach((g: any) => {
    if (!collapsedGroups.has(g.Id)) return;
    const anchor = byId[g.Id];   // id matches a real node -> an "anchor" group (e.g. Solar PV over its MPPTs)
    let sum = 0, known = false;
    (g.Members || []).forEach((m: string) => { const n = byId[m]; if (n && n.value != null) { sum += n.value; known = true; } });
    groupNode[g.Id] = anchor
      // The anchor keeps its own identity and value; only if it has none does it fall back to the members' sum.
      ? { ...anchor, value: anchor.value != null ? anchor.value : (known ? sum : null), group: true }
      : { id: g.Id, label: g.Label || g.Id, kind: g.Kind || 'node', value: known ? sum : null, group: true };
  });

  const remap = (id: string) => (memberOf[id] ? memberOf[id].Id : id);
  // Drop the collapsed members, keep everyone else, add the group nodes (only groups that actually have a
  const present = new Set<string>();
  // Drop collapsed members and any anchor node (it's re-added as its group node, so it isn't duplicated).
  const outNodes = nodes.filter(n => !memberOf[n.id] && !groupNode[n.id]);
  const merged: Record<string, any> = {};
  links.forEach(l => {
    const s = remap(l.source), t = remap(l.target);
    if (s === t) return;                       // a link fully inside one collapsed group
    present.add(s); present.add(t);
    const k = s + '\u0000' + t;
    if (!merged[k]) merged[k] = { source: s, target: t, value: 0, known: true };
    merged[k].value += (l.value || 0);
    if (l.known === false) merged[k].known = false;
  });
  // An anchor group always appears (its node was already in the graph); a synthetic group only if a member was.
  Object.values(groupNode).forEach((gn: any) => { if (present.has(gn.id) || byId[gn.id]) outNodes.push(gn); });
  return { nodes: outNodes, links: Object.values(merged) };
}

// The toggle strip above the diagram: one chip per group, click to collapse/expand on both graphs.

export let showUnmeasured = (() => { try { return localStorage.getItem('rpdu-flow-unmeasured') !== '0'; } catch { return true; } })();

export function setShowUnmeasured(on: boolean) {
  showUnmeasured = on;
  try { localStorage.setItem('rpdu-flow-unmeasured', on ? '1' : '0'); } catch { /* private mode: this session only */ }
}

/// Drop the unmetered-remainder nodes and their links when the view is switched off. Return lanes (#in)
export function applyUnmeasuredPref(nodes: any[], links: any[]): { nodes: any[]; links: any[] } {
  if (showUnmeasured) return { nodes, links };
  const hidden = new Set(nodes.filter((n: any) => String(n.id || '').endsWith('#unmeasured')).map((n: any) => n.id));
  if (!hidden.size) return { nodes, links };
  return {
    nodes: nodes.filter((n: any) => !hidden.has(n.id)),
    links: links.filter((l: any) => !hidden.has(l.target) && !hidden.has(l.source)),
  };
}

/// The "Unmeasured load" view switch, shown wherever the group chips are.
export function unmeasuredToggle(onToggle: () => void): HTMLElement {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
    title: 'Show the gap between what a node passes and what its metered children draw, as its own node. '
      + 'A view setting only — the figure is never published, and turning it off does not change any total.',
  });
  const cb: any = el('input', { type: 'checkbox' });
  cb.checked = showUnmeasured;
  cb.onchange = () => { setShowUnmeasured(cb.checked); onToggle(); };
  lbl.append(cb, document.createTextNode('Unmeasured load'));
  return lbl;
}

/// The "Animate flow" view switch. Purely local: a per-viewer preference, not a property of the system, and
export function animateToggle(onToggle: () => void): HTMLElement {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
    title: 'Draw a moving stream along each ribbon. Speed follows how dense the flow is — flow per unit of '
      + 'ribbon width — so it says how hard something is moving, which width alone cannot. Links with no '
      + 'data, and measured zeroes, never animate: nothing should look busier than its reading.',
  });
  const cb: any = el('input', { type: 'checkbox' });
  cb.checked = localStorage.getItem('rpdu2mqtt.flow.animate') === '1';
  cb.onchange = () => { localStorage.setItem('rpdu2mqtt.flow.animate', cb.checked ? '1' : '0'); onToggle(); };
  lbl.append(cb, document.createTextNode('Animate flow'));
  return lbl;
}

// The "show a past moment" control, and the wording for what comes back, live in history-control.ts:

export function groupToggles(onToggle: () => void, drawn = true): HTMLElement | null {
  const groups = flowGroups();
  const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px', margin: '0 0 8px' } });
  // The view switches are not about groups and must not disappear with them — this used to return null
  if (drawn) {
    row.appendChild(unmeasuredToggle(onToggle));
    row.appendChild(animateToggle(onToggle));
  }
  if (!groups.length) return drawn ? row : null;
  row.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Groups:' }));
  groups.forEach((g: any) => {
    const on = collapsedGroups.has(g.Id);
    const count = (g.Members || []).length;
    const chip = btn(`${on ? '▸' : '▾'} ${g.Label || g.Id} (${count})`);
    // A group with no members has nothing to fold — collapsing/expanding it is a no-op, so say so instead of
    chip.title = count === 0 ? 'No members yet — add nodes to this group on the Nodes tab; then it collapses/expands.'
      : on ? `Collapsed — click to expand its ${count} member(s)` : 'Expanded — click to collapse into one node';
    chip.onclick = () => {
      if (count === 0) { toast(`“${g.Label || g.Id}” has no members yet — add some in the Groups section on the Nodes tab.`, false); return; }
      on ? collapsedGroups.delete(g.Id) : collapsedGroups.add(g.Id); onToggle();
    };
    row.appendChild(chip);
  });
  // Where membership is edited — the toggles only collapse/expand; you add or remove a group's nodes on the
  row.appendChild(el('span', { class: 'desc', style: { margin: '0 0 0 6px', fontSize: '11px' }, text: '· add/remove members in the Groups section on the Nodes tab' }));
  return row;
}

// The candidate node universe for wiring: the built graph's nodes (pdu/outlet/…) plus the custom defs.

// Flow diagram view switches and node groups.
import { btn, el, toast } from './helpers.js';
import { state } from './state.js';

export const collapsedGroups = new Set<string>();
export const seenGroups = new Set<string>();

export function flowGroups(): any[] {
  return (state.data?.EnergyFlow?.Groups || []).filter((g: any) => g && g.Id);
}

// Drop hidden nodes, and feeders that only feed hidden nodes.
export function hideHiddenNodes(nodes: any[], links: any[]): { nodes: any[]; links: any[] } {
  const hidden = new Set<string>((state.data?.EnergyFlow?.Nodes || []).filter((n: any) => n?.Hidden).map((n: any) => n.Id));
  if (!hidden.size) return { nodes, links };
  for (let grew = true; grew;) {
    grew = false;
    nodes.forEach((n: any) => {
      if (hidden.has(n.id)) return;
      const out = links.filter((l: any) => l.source === n.id);
      if (out.length && out.every((l: any) => hidden.has(l.target))) { hidden.add(n.id); grew = true; }
    });
  }
  return { nodes: nodes.filter((n: any) => !hidden.has(n.id)), links: links.filter((l: any) => !hidden.has(l.source) && !hidden.has(l.target)) };
}

export const expandMode = (g: any): string => g?.Expand || 'replace';

export function descendantGroups(g: any): any[] {
  const all = flowGroups(), out: any[] = [], seen = new Set<string>([g.Id]);
  for (let i = -1; i < out.length; i++) {
    const id = i < 0 ? g.Id : out[i].Id;
    all.forEach((x: any) => { if (x.Parent === id && !seen.has(x.Id)) { seen.add(x.Id); out.push(x); } });
  }
  return out;
}

export function toggleGroup(g: any) {
  const expand = collapsedGroups.has(g.Id);
  const ids = [g.Id, ...(g.ExpandChildren ? descendantGroups(g).map((d: any) => d.Id) : [])];
  ids.forEach(id => expand ? collapsedGroups.delete(id) : collapsedGroups.add(id));
}

// Drawn node ids an expanded group stands for: its members and its nested groups' members.
export function drawnMembers(g: any, present: Set<string>): string[] {
  const ids = new Set<string>();
  [g, ...descendantGroups(g)].forEach((x: any) => {
    if (x !== g && present.has(x.Id)) ids.add(x.Id);
    (x.Members || []).forEach((m: string) => { if (present.has(m)) ids.add(m); });
  });
  ids.delete(g.Id);
  return [...ids];
}

// An expanded group in 'parents' or 'children' mode keeps a group node beside its members.
export function nestExpandedGroups(nodes: any[], links: any[]): { nodes: any[]; links: any[] } {
  const depth = (g: any) => { let d = 0; for (let p = g, seen = new Set<string>(); p?.Parent && !seen.has(p.Id); d++) { seen.add(p.Id); p = flowGroups().find((x: any) => x.Id === p.Parent); } return d; };
  const groups = flowGroups().filter((g: any) => expandMode(g) !== 'replace' && !collapsedGroups.has(g.Id) && !foldedInto(g))
    .sort((a: any, b: any) => depth(b) - depth(a));
  let outNodes = nodes, outLinks = links;
  groups.forEach((g: any) => {
    const present = new Set<string>(outNodes.map((n: any) => n.id));
    if (present.has(g.Id)) return;
    const set = new Set(drawnMembers(g, present));
    if (!set.size) return;
    const merged: Record<string, any> = {};
    const add = (source: string, target: string, value: number, known: boolean) => {
      const k = source + '\u0000' + target;
      if (!merged[k]) merged[k] = { source, target, value: 0, known: true };
      merged[k].value += value || 0;
      if (!known) merged[k].known = false;
    };
    const parents = expandMode(g) === 'parents';
    const kept: any[] = [];
    outLinks.forEach((l: any) => {
      const crosses = parents ? set.has(l.source) && !set.has(l.target) : !set.has(l.source) && set.has(l.target);
      if (!crosses) { kept.push(l); return; }
      add(l.source, g.Id, l.value, l.known !== false); add(g.Id, l.target, l.value, l.known !== false);
    });
    if (!parents) set.forEach(m => {
      if (outLinks.some((l: any) => l.target === m)) return;
      const out = outLinks.filter((l: any) => l.source === m);
      if (out.length) add(g.Id, m, out.reduce((a: number, l: any) => a + (l.value || 0), 0), out.every((l: any) => l.known !== false));
    });
    const own = Object.values(merged).filter((l: any) => l.source === g.Id);
    if (!own.length) return;
    const value = own.reduce((a: number, l: any) => a + l.value, 0);
    const kinds = new Set([...set].map(id => outNodes.find((n: any) => n.id === id)?.kind).filter(Boolean));
    const kind = g.Kind || (kinds.size === 1 ? [...kinds][0] : 'node');
    outNodes = outNodes.concat([{ id: g.Id, label: g.Label || g.Id, kind, value, group: true, expanded: true }]);
    outLinks = kept.concat(Object.values(merged));
  });
  return { nodes: outNodes, links: outLinks };
}

// Groups start collapsed.
export function ensureGroupState() {
  flowGroups().forEach((g: any) => { if (!seenGroups.has(g.Id)) { seenGroups.add(g.Id); collapsedGroups.add(g.Id); } });
}

// The outermost collapsed group this group is nested in.
export function foldedInto(g: any): any | null {
  const byId: Record<string, any> = {};
  flowGroups().forEach((x: any) => { byId[x.Id] = x; });
  const seen = new Set<string>([g.Id]);
  let host: any = null;
  for (let p = byId[g.Parent]; p && !seen.has(p.Id); p = byId[p.Parent]) {
    seen.add(p.Id);
    if (collapsedGroups.has(p.Id)) host = p;
  }
  return host;
}

// Node id -> the collapsed group it folds into.
export function collapsedMemberMap(): Record<string, any> {
  const map: Record<string, any> = {};
  flowGroups().forEach((g: any) => {
    const host = foldedInto(g) || (collapsedGroups.has(g.Id) ? g : null);
    if (!host) return;
    (g.Members || []).forEach((m: string) => { map[m] = host; });
    if (host !== g) map[g.Id] = host;
  });
  return map;
}

// An expanded anchor group is replaced by its members, when the anchor feeds a single target.
export function explodeExpandedGroups(nodes: any[], links: any[]): { nodes: any[]; links: any[] } {
  const groups = flowGroups().filter((g: any) => g && g.Id && !collapsedGroups.has(g.Id) && expandMode(g) === 'replace');
  if (!groups.length) return { nodes, links };

  let outNodes = nodes, outLinks = links;
  groups.forEach((g: any) => {
    const byId: any = {}; outNodes.forEach((n: any) => { byId[n.id] = n; });
    if (!byId[g.Id]) return;
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
    if (!collapsedGroups.has(g.Id) || foldedInto(g)) return;
    if (!Object.keys(memberOf).some(id => memberOf[id] === g && byId[id])) return;
    const anchor = byId[g.Id];
    let sum = 0, known = false;
    (g.Members || []).forEach((m: string) => { const n = byId[m]; if (n && n.value != null) { sum += n.value; known = true; } });
    const kinds = new Set((g.Members || []).map((m: string) => byId[m]?.kind).filter(Boolean));
    const kind = g.Kind || (kinds.size === 1 ? [...kinds][0] : 'node');
    groupNode[g.Id] = anchor
      ? { ...anchor, value: anchor.value != null ? anchor.value : (known ? sum : null), group: true }
      : { id: g.Id, label: g.Label || g.Id, kind, value: known ? sum : null, group: true };
  });

  const remap = (id: string) => (memberOf[id] ? memberOf[id].Id : id);
  const present = new Set<string>();
  const outNodes = nodes.filter(n => !memberOf[n.id] && !groupNode[n.id]);
  const merged: Record<string, any> = {};
  links.forEach(l => {
    const s = remap(l.source), t = remap(l.target);
    if (s === t) return;
    present.add(s); present.add(t);
    const k = s + '\u0000' + t;
    if (!merged[k]) merged[k] = { source: s, target: t, value: 0, known: true };
    merged[k].value += (l.value || 0);
    if (l.known === false) merged[k].known = false;
  });
  Object.values(groupNode).forEach((gn: any) => { if (present.has(gn.id) || byId[gn.id]) outNodes.push(gn); });
  return { nodes: outNodes, links: Object.values(merged) };
}


export let showUnmeasured = (() => { try { return localStorage.getItem('rpdu-flow-unmeasured') !== '0'; } catch { return true; } })();

export function setShowUnmeasured(on: boolean) {
  showUnmeasured = on;
  try { localStorage.setItem('rpdu-flow-unmeasured', on ? '1' : '0'); } catch { /* private mode: this session only */ }
}

/// Drop the unmetered-remainder nodes and their links when the view is switched off.
export function applyUnmeasuredPref(nodes: any[], links: any[]): { nodes: any[]; links: any[] } {
  if (showUnmeasured) return { nodes, links };
  const hidden = new Set(nodes.filter((n: any) => String(n.id || '').endsWith('#unmeasured')).map((n: any) => n.id));
  if (!hidden.size) return { nodes, links };
  return {
    nodes: nodes.filter((n: any) => !hidden.has(n.id)),
    links: links.filter((l: any) => !hidden.has(l.target) && !hidden.has(l.source)),
  };
}

/// "Hide empty" preference.
export let hideEmpty = (() => { try { return localStorage.getItem('rpdu-flow-hide-empty') !== '0'; } catch { return true; } })();

export function setHideEmpty(on: boolean) {
  hideEmpty = on;
  try { localStorage.setItem('rpdu-flow-hide-empty', on ? '1' : '0'); } catch { /* private mode: this session only */ }
}

/// Drop zero nodes with nothing live downstream. Nodes with no value stay.
export function applyHideEmptyPref(nodes: any[], links: any[]): { nodes: any[]; links: any[] } {
  if (!hideEmpty) return { nodes, links };

  const carrying = (n: any) => n.value != null && Math.abs(n.value) > 0;
  const byId = new Map<string, any>(nodes.map((n: any) => [n.id, n]));
  const out = new Map<string, string[]>();
  links.forEach((l: any) => out.set(l.source, [...(out.get(l.source) || []), l.target]));

  const feedsSomethingLive = new Map<string, boolean>();
  const walking = new Set<string>();
  const live = (id: string): boolean => {
    if (feedsSomethingLive.has(id)) return feedsSomethingLive.get(id)!;
    if (walking.has(id)) return false;
    walking.add(id);
    const answer = (out.get(id) || []).some(t => {
      const n = byId.get(t);
      return (n && carrying(n)) || live(t);
    });
    walking.delete(id);
    feedsSomethingLive.set(id, answer);
    return answer;
  };

  const keep = (id: string) => {
    const n = byId.get(id);
    if (!n) return false;
    return n.value == null || carrying(n) || live(id);
  };

  return {
    nodes: nodes.filter((n: any) => keep(n.id)),
    links: links.filter((l: any) => keep(l.source) && keep(l.target)),
  };
}

/// "Hide small" threshold, as a share of the total.
export const HIDE_SMALL_CHOICES: [number, string][] = [[0, 'Off'], [0.5, 'under 0.5%'], [1, 'under 1%'], [2, 'under 2%'], [5, 'under 5%']];
export let hideSmallPercent = (() => {
  try {
    const v = Number(localStorage.getItem('rpdu-flow-hide-small') || '0');
    return HIDE_SMALL_CHOICES.some(([p]) => p === v) ? v : 0;
  } catch { return 0; }
})();

export function setHideSmall(percent: number) {
  hideSmallPercent = percent;
  try { localStorage.setItem('rpdu-flow-hide-small', String(percent)); } catch { /* private mode: this session only */ }
}

/// Drop nodes under the share of the total with nothing larger downstream; returns how many went.
export function applyHideSmallPref(nodes: any[], links: any[], percent = hideSmallPercent): { nodes: any[]; links: any[]; hidden: number } {
  if (!(percent > 0)) return { nodes, links, hidden: 0 };

  const byId = new Map<string, any>(nodes.map((n: any) => [n.id, n]));
  const out = new Map<string, string[]>();
  const fed = new Set<string>();
  links.forEach((l: any) => { out.set(l.source, [...(out.get(l.source) || []), l.target]); fed.add(l.target); });

  const size = (n: any) => typeof n?.value === 'number' ? Math.abs(n.value) : null;
  const roots = nodes.filter((n: any) => !fed.has(n.id) && size(n) != null);
  const total = roots.length ? roots.reduce((sum: number, n: any) => sum + size(n)!, 0)
    : Math.max(0, ...nodes.map((n: any) => size(n) ?? 0));
  if (!(total > 0)) return { nodes, links, hidden: 0 };
  const floor = total * percent / 100;
  const large = (n: any) => size(n) == null || size(n)! >= floor;

  const feedsLarge = new Map<string, boolean>();
  const walking = new Set<string>();
  const reaches = (id: string): boolean => {
    if (feedsLarge.has(id)) return feedsLarge.get(id)!;
    if (walking.has(id)) return false;
    walking.add(id);
    const answer = (out.get(id) || []).some(t => {
      const n = byId.get(t);
      return (n && size(n) != null && size(n)! >= floor) || reaches(t);
    });
    walking.delete(id);
    feedsLarge.set(id, answer);
    return answer;
  };

  const keep = (id: string) => byId.has(id) && (large(byId.get(id)) || reaches(id));
  const kept = nodes.filter((n: any) => keep(n.id));
  return {
    nodes: kept,
    links: links.filter((l: any) => keep(l.source) && keep(l.target)),
    hidden: nodes.length - kept.length,
  };
}

/// The "Hide small" view picker. Per-viewer, like the other switches.
export function hideSmallSelect(onChange: () => void): HTMLElement {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px' },
    title: 'Hide branches carrying less than this share of everything entering the diagram — loads using next '
      + 'to nothing. A small node that feeds a larger one stays, and a node with no data is never hidden by '
      + 'this. How many were hidden is shown beside the node count. A view setting only; no total changes.',
  });
  const sel: any = el('select', { style: { width: 'auto' } });
  HIDE_SMALL_CHOICES.forEach(([p, label]) => sel.appendChild(el('option', { value: String(p), text: label })));
  sel.value = String(hideSmallPercent);
  sel.onchange = () => { setHideSmall(Number(sel.value) || 0); onChange(); };
  lbl.append(document.createTextNode('Hide small'), sel);
  return lbl;
}

/// "Hide no data" preference.
export let hideNoData = (() => { try { return localStorage.getItem('rpdu-flow-hide-no-data') === '1'; } catch { return false; } })();

export function setHideNoData(on: boolean) {
  hideNoData = on;
  try { localStorage.setItem('rpdu-flow-hide-no-data', on ? '1' : '0'); } catch { /* private mode: this session only */ }
}

/// Drop no-data nodes with no data downstream; returns how many went.
export function applyHideNoDataPref(nodes: any[], links: any[]): { nodes: any[]; links: any[]; hidden: number } {
  if (!hideNoData) return { nodes, links, hidden: 0 };

  const byId = new Map<string, any>(nodes.map((n: any) => [n.id, n]));
  const out = new Map<string, string[]>();
  links.forEach((l: any) => out.set(l.source, [...(out.get(l.source) || []), l.target]));

  const reachesData = new Map<string, boolean>();
  const walking = new Set<string>();
  const feedsData = (id: string): boolean => {
    if (reachesData.has(id)) return reachesData.get(id)!;
    if (walking.has(id)) return false;
    walking.add(id);
    const answer = (out.get(id) || []).some(t => byId.get(t)?.value != null || feedsData(t));
    walking.delete(id);
    reachesData.set(id, answer);
    return answer;
  };

  const keep = (id: string) => byId.has(id) && (byId.get(id).value != null || feedsData(id));
  const kept = nodes.filter((n: any) => keep(n.id));
  return {
    nodes: kept,
    links: links.filter((l: any) => keep(l.source) && keep(l.target)),
    hidden: nodes.length - kept.length,
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

/// Ribbon routing.
export type RibbonStyle = 'curved' | 'ortho' | 'ortho-round';

const RIBBON_KEY = 'rpdu-flow-ribbon';
const RIBBON_STYLES: [RibbonStyle, string, string][] = [
  ['curved', 'Curved ribbons', 'The default: each ribbon sweeps from source to target as one smooth band.'],
  ['ortho', 'Wiring', 'Each link a wire, thickness by flow, run along one trunk per source with square corners.'],
  ['ortho-round', 'Wiring, rounded', 'The same wiring with rounded corners.'],
];

export let ribbonStyle: RibbonStyle = (() => {
  try {
    const v = localStorage.getItem(RIBBON_KEY);
    return RIBBON_STYLES.some(([id]) => id === v) ? v as RibbonStyle : 'curved';
  } catch { return 'curved'; }
})();

export function setRibbonStyle(v: RibbonStyle) {
  ribbonStyle = v;
  try { localStorage.setItem(RIBBON_KEY, v); } catch { /* private mode: this session only */ }
}

/// Ribbon routing picker.
export function ribbonStyleSelect(onChange: () => void): HTMLElement {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px' },
    title: 'How ribbons are routed between nodes. A view setting only — it changes nothing about the values.',
  });
  const sel: any = el('select', { style: { width: 'auto' } });
  RIBBON_STYLES.forEach(([id, label, why]) => {
    const opt = el('option', { value: id, text: label });
    opt.title = why;
    sel.appendChild(opt);
  });
  sel.value = ribbonStyle;
  sel.onchange = () => { setRibbonStyle(sel.value); onChange(); };
  lbl.append(document.createTextNode('Routing'), sel);
  return lbl;
}

/// "Animate flow" switch.
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


/// The diagram view switches.
export function viewSwitches(onToggle: () => void): HTMLElement {
  const row = el('div', { class: 'flow-view-switches' });
  row.append(hideEmptyToggle(onToggle), hideSmallSelect(onToggle), hideNoDataToggle(onToggle),
             unmeasuredToggle(onToggle), animateToggle(onToggle), ribbonStyleSelect(onToggle));
  return row;
}

/// One collapse/expand chip per visible group.
export function groupChips(onToggle: () => void): HTMLElement | null {
  const groups = flowGroups();
  if (!groups.length) return null;
  const row = el('div', { class: 'flow-view-chips' });
  groups.forEach((g: any) => {
    const count = (g.Members || []).length;
    if (foldedInto(g) || (g.Parent && !count)) return;
    const on = collapsedGroups.has(g.Id);
    const chip = btn(`${on ? '▸' : '▾'} ${g.Label || g.Id} (${count})`);
    chip.title = count === 0 ? 'No members. Add them on the Groups page.'
      : on ? `Collapsed. Click to expand its ${count} member(s).` : 'Expanded. Click to collapse into one node.';
    chip.onclick = () => {
      if (count === 0) { toast(`“${g.Label || g.Id}” has no members. Add them on the Groups page.`, false); return; }
      toggleGroup(g); onToggle();
    };
    row.appendChild(chip);
  });
  return row;
}

/// View switches and group chips in one strip.
export function groupToggles(onToggle: () => void, drawn = true): HTMLElement | null {
  const chips = groupChips(onToggle);
  if (!drawn && !chips) return null;
  const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '6px', margin: '0 0 8px' } });
  if (drawn) row.appendChild(viewSwitches(onToggle));
  if (chips) row.append(el('span', { class: 'desc', style: { margin: '0' }, text: 'Groups:' }), chips);
  return row;
}

// The candidate node universe for wiring: the built graph's nodes (pdu/outlet/…) plus the custom defs.

/// "Hide no data" switch.
export function hideNoDataToggle(onToggle: () => void): HTMLElement {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
    title: 'Hide nodes nothing measures, and the branches under them that have no data either. A node with no '
      + 'data that feeds a measured one stays, so nothing measured is cut off. How many were hidden is shown '
      + 'beside the node count. A view setting only; no total changes.',
  });
  const cb: any = el('input', { type: 'checkbox' });
  cb.checked = hideNoData;
  cb.onchange = () => { setHideNoData(cb.checked); onToggle(); };
  lbl.append(cb, document.createTextNode('Hide no data'));
  return lbl;
}

/// "Hide empty" switch.
export function hideEmptyToggle(onToggle: () => void): HTMLElement {
  const lbl = el('label', {
    class: 'desc',
    style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' },
    title: 'Hide branches reading zero — switched-off outlets and anything they feed. Nodes with NO data '
      + 'stay: nothing measures those, which is a gap in the model rather than an empty branch. A view '
      + 'setting only; no total changes.',
  });
  const cb: any = el('input', { type: 'checkbox' });
  cb.checked = hideEmpty;
  cb.onchange = () => { setHideEmpty(cb.checked); onToggle(); };
  lbl.append(cb, document.createTextNode('Hide empty'));
  return lbl;
}

// The details card for one node in the sunburst and the treemap: the Sankey's hover card, plus where the
// node sits in the tree those two views draw — its share of the whole and of its parent, and the path to it.
import { el, formatMeasure } from './helpers.js';
import { state } from './state.js';
import { metricLabel } from './flow-vocabulary.js';

/// Where a node sits in the drawn tree. A node fed from two parents is drawn once under each, so this is
/// about the piece under the pointer, not the node as a whole.
export type TreePlace = {
  /// This piece's value: a parent's share of the node when it has two.
  value: number;
  total: number;
  /// Labels from the top of the drawing down to this node, this node excluded.
  path: string[];
  parentValue: number | null;
};

const pct = (part: number, whole: number) => {
  if (!(whole > 0)) return '—';
  const p = 100 * part / whole;
  return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
};

export function flowCardRows(n: any, place: TreePlace, ctx: { units: string; metric: string; nodes: any[]; links: any[] }): any[] {
  const { units } = ctx;
  const fmt = (v: number) => formatMeasure(v, units);
  const byId = new Map(ctx.nodes.map((x: any) => [x.id, x]));
  const rows: any[] = [];
  rows.push(el('div', { class: 'nh-title', text: n.label || n.id }));
  rows.push(el('div', { class: 'nh-sub', text: `${n.kind || 'node'} · ${n.id}` }));
  rows.push(el('div', { class: 'nh-value' }, fmt(n.value ?? place.value),
    el('span', { class: 'nh-metric', text: ' ' + metricLabel(ctx.metric).toLowerCase() })));
  if (n.value != null && Math.abs(place.value - n.value) > 1e-6)
    rows.push(el('div', { class: 'desc', style: { margin: '2px 0 0' }, text: `${fmt(place.value)} of it through this branch` }));
  if (n.derivation && n.derivation !== 'measured')
    rows.push(el('div', { class: n.derivation === 'inferred' ? 'nh-warn' : 'desc', style: { margin: '2px 0 0' },
      text: n.derivation === 'inferred' ? 'inferred — nothing measures it' : 'summed from what it feeds' }));
  if (n.imbalance != null)
    rows.push(el('div', { class: 'nh-warn', text: `${fmt(Math.abs(n.imbalance))} ${n.imbalance > 0 ? 'more leaves than arrives' : 'short of what it passes on'}` }));

  // Shares: the question these two views answer.
  rows.push(el('div', { class: 'nh-head', text: 'Share' }));
  rows.push(el('div', { class: 'nh-row' }, el('span', { class: 'nh-name', text: 'of the total' }),
    el('span', { class: 'nh-num', text: pct(place.value, place.total) })));
  if (place.parentValue != null && place.path.length)
    rows.push(el('div', { class: 'nh-row' }, el('span', { class: 'nh-name', text: `of ${place.path[place.path.length - 1]}` }),
      el('span', { class: 'nh-num', text: pct(place.value, place.parentValue) })));
  if (place.path.length)
    rows.push(el('div', { class: 'nh-path', text: place.path.join(' › ') }));

  // What it feeds, largest first; the tail folded into a count.
  const out = ctx.links.filter((l: any) => l.source === n.id && (l.value ?? 0) > 0).sort((a: any, b: any) => b.value - a.value);
  if (out.length) {
    rows.push(el('div', { class: 'nh-head', text: `Feeds ${out.length}` }));
    out.slice(0, 6).forEach((l: any) => rows.push(el('div', { class: 'nh-row' },
      el('span', { class: 'nh-name', text: byId.get(l.target)?.label || l.target }),
      el('span', { class: 'nh-num', text: fmt(l.value) }))));
    if (out.length > 6) rows.push(el('div', { class: 'desc', style: { margin: '0' }, text: `+ ${out.length - 6} more` }));
    const passed = out.reduce((s: number, l: any) => s + l.value, 0);
    const own = (n.value ?? 0) - passed;
    if (n.value != null && own > 0.5)
      rows.push(el('div', { class: 'nh-row' }, el('span', { class: 'nh-name', text: 'not passed on' }),
        el('span', { class: 'nh-num', text: fmt(own) })));
  }

  const cfg = (state.data?.EnergyFlow?.Nodes || []).find((x: any) => x.Id === n.id);
  const bound = (cfg?.Sources || []).concat(cfg?.Mqtt ? cfg.Mqtt.map((m: any) => ({ Type: 'mqtt', ...m })) : []);
  if (bound.length) {
    rows.push(el('div', { class: 'nh-head', text: 'Bound sources' }));
    bound.forEach((s: any) => rows.push(el('div', { class: 'nh-row' },
      el('span', { class: 'nh-name', text: metricLabel(s.Metric) }),
      el('span', { class: 'nh-src', text: s.Type === 'modbus' ? `${s.Connection || 'modbus'} reg ${s.Register}` : (s.Topic || '') }))));
  }
  if ((n.tags || []).length) rows.push(el('div', { class: 'nh-sub', style: { margin: '6px 0 0' }, text: '#' + n.tags.join(' #') }));
  return rows;
}

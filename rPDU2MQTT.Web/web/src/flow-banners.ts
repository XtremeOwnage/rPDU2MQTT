// What the diagram says about readings it does not trust.
//
// Two banners above the chart, because the alternative is a small mark on a label printed in the same
// weight as every honest number — which is how a node carrying a 129.9 kWh gap went unnoticed for a day.
// Their own module: the rules for when to speak up are the point, and they are easier to find here than
// three hundred lines into a drawing routine.
import { el } from './helpers.js';

/// The banner naming every binding the bridge is dropping, and why. Separate from the contradiction banner
/// because it is a different statement: that one says a number on the chart disagrees with the chart, this
/// one says a number is absent on purpose. A node reading "no data" is otherwise indistinguishable from one
/// nobody ever bound a source to, and the two need completely different fixes.
export function withheldBanner(sources: any[]): HTMLElement {
  const box = el('div', { class: 'flow-contradiction' });
  box.appendChild(el('strong', {
    text: sources.length === 1
      ? '1 source is being withheld'
      : `${sources.length} sources are being withheld`,
  }));
  box.appendChild(el('div', {
    class: 'desc',
    style: { margin: '2px 0 6px' },
    text: 'These bindings are reporting, but what they report can be shown to be wrong, so it is not being '
        + 'used. The nodes below show no data for them rather than a figure that is not what it claims.',
  }));
  sources.forEach((w: any) => {
    const row = el('div', { class: 'nh-warn', style: { margin: '3px 0' } });
    row.appendChild(el('strong', { text: `${w.node} · ${w.source}: ` }));
    row.appendChild(el('span', { text: w.reason || '' }));
    box.appendChild(row);
  });
  return box;
}

/// The banner naming every node whose figure its own flows contradict. Above the chart, not inside it: the
/// point is to be read before the numbers are, by someone who came to the page to read the numbers.
export function contradictionBanner(items: { id: string, label: string, share: number }[], onFocus: (id: string) => void): HTMLElement {
  const box = el('div', { class: 'flow-contradiction' });
  const n = items.length;
  box.appendChild(el('strong', {
    text: n === 1
      ? '1 node’s figure is contradicted by its own flows'
      : `${n} nodes’ figures are contradicted by their own flows`,
  }));
  box.appendChild(el('div', {
    class: 'desc',
    style: { margin: '2px 0 6px' },
    text: 'More than a quarter of what passes through them is unaccounted for — too much to be rounding or '
        + 'sampling skew. Usually a source scaled wrongly, a sensor measuring one leg of the node, or a '
        + 'counter that is not the kind it was configured as. The readings are still shown; treat them as '
        + 'suspect until the gap is explained.',
  }));
  const row = el('div', { class: 'ld-toolbar', style: { gap: '6px', flexWrap: 'wrap' } });
  items.forEach(it => {
    const b = btn(`${it.label} · ${Math.round(it.share * 100)}% unaccounted`);
    b.onclick = () => onFocus(it.id);
    row.appendChild(b);
  });
  box.appendChild(row);
  return box;
}

/// What fraction of a node's throughput its own flows cannot account for, or null when there is no gap.
export function contradictionShare(n: any, reading: number | null): number | null {
  if (n.imbalance == null || reading == null || !isFinite(reading)) return null;
  // The denominator is what the node is handling — the larger of its two sides.
  //
  // This used to reconstruct it as `reading + imbalance`, which was true while a measured node's imbalance
  // meant "throughput − reading". It stopped being true when an imbalance became outflow − inflow for every
  // node, and the arithmetic went on producing a plausible number from a premise that no longer held. The
  // server states the throughput now, so there is nothing to reconstruct; a node without one is reporting
  // the larger side as its own value already.
  const throughput = typeof n.throughput === 'number' ? n.throughput : reading;
  if (!(throughput > 0)) return null;
  return Math.min(1, Math.abs(n.imbalance) / throughput);
}

// Show the "Unmeasured load" node on the diagram? A view preference, not config: the node is drawn from
// figures already measured and is never exported (see FlowNode.Synthetic), so hiding it changes what you
// are looking at and nothing else. On by default — a panel passing 8 kW to 560 W of metered outlets is
// worth seeing — but it can dominate a chart when most of the load is unmetered, which is exactly when
// someone wants the metered detail back.

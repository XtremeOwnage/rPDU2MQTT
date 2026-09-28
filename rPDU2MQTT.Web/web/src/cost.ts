// Energy as cost (#515): readings in kWh times the price per kWh from the GUI settings.
import { state } from './state.js';

/// The price of a kWh from the GUI settings, or null when none is set.
export function energyPrice(): number | null {
  const v = Number(state.data?.Gui?.EnergyPrice);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export const currency = () => String(state.data?.Gui?.Currency || '').trim() || '$';

/// The energy metric each cost metric prices.
export const COST_OF: Record<string, string> = { cost_d: 'energy_d', cost: 'energy' };

/// kWh per unit of an energy metric.
const KWH_PER: Record<string, number> = { Wh: 0.001, kWh: 1, MWh: 1000 };

const costFactor = (units: string, price: number) => price * (KWH_PER[units] ?? 1);

/// Energy series as cost. Linear, so it holds for deltas and totals alike.
export function toCost(b: any, price: number) {
  const factor = costFactor(b.units, price);
  (b.series || []).forEach((s: any) => { s.values = s.values.map((v: any) => (v == null ? null : v * factor)); });
  b.units = currency();
}

/// An energy flow graph as cost: a copy, since a live body may be shared.
export function priceGraph(g: any, price: number) {
  const factor = costFactor(g.units, price);
  const times = (v: any) => (typeof v === 'number' ? v * factor : v);
  return {
    ...g,
    units: currency(),
    nodes: (g.nodes || []).map((n: any) => ({ ...n, value: times(n.value), imbalance: times(n.imbalance), throughput: times(n.throughput) })),
    links: (g.links || []).map((l: any) => ({ ...l, value: times(l.value) })),
  };
}

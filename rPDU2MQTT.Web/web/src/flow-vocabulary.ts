// The shared vocabulary: metrics, node kinds, node modes, source types, Modbus shapes.
export const METRICS: [string, string, string, string[]][] = [
  ['realpower', 'Power', 'W', ['W', 'kW', 'MW']],
  ['apparentpower', 'Apparent power', 'VA', ['VA', 'kVA']],
  ['energy', 'Energy', 'kWh', ['Wh', 'kWh', 'MWh']],
  ['current', 'Current', 'A', ['A', 'mA']],
  ['voltage', 'Voltage', 'V', ['mV', 'V', 'kV']],
  ['frequency', 'Frequency', 'Hz', ['Hz']],
  ['powerfactor', 'Power factor', '', ['']],
  ['soc', 'State of charge', '%', ['%', 'fraction']],
  ['percent', 'Percentage', '%', ['%', 'fraction']],
  ['temperature', 'Temperature', '°C', ['°C', 'K']],
];
// Which metrics the flow may sum from the leaves upward. Mirrors FlowUnits.IsAdditive.
export const ADDITIVE_METRICS = new Set(['realpower', 'apparentpower', 'energy', 'energytoday', 'current']);
export const isAdditiveMetric = (key?: string) => ADDITIVE_METRICS.has(key || '');
export const SOURCE_METRICS = METRICS.map(m => m[0]);
export const metricMeta = (key?: string) => METRICS.find(m => m[0] === key) || METRICS[0];
// Metrics the diagram can be drawn by but nothing can be *bound* to, so they stay out of METRICS.
export const DERIVED_METRIC_LABELS: Record<string, string> = { energytoday: 'Energy today' };
export const metricLabel = (key?: string) => DERIVED_METRIC_LABELS[key || ''] || metricMeta(key)[1];
// The live-cache key a source reads under, given its direction.
export const sourceMetricKey = (src: any) => { const m = src.Metric || 'realpower'; return src.Direction === 'in' ? m + '#in' : m; };

// What a virtual node represents — mirrors [AllowedValues] on EnergyFlowNode.Kind.
export const NODE_KINDS: [string, string, string[]][] = [
  ['node', 'Virtual node', SOURCE_METRICS],
  ['panel', 'Electrical panel', ['realpower', 'apparentpower', 'current', 'voltage', 'energy', 'powerfactor']],
  ['inverter', 'Inverter', SOURCE_METRICS],
  ['battery', 'Battery', ['realpower', 'energy', 'current', 'voltage', 'soc']],
  ['solar', 'Solar / PV', ['realpower', 'energy', 'current', 'voltage']],
  ['grid', 'Grid', SOURCE_METRICS],
  ['load', 'Load', ['realpower', 'apparentpower', 'energy', 'current', 'voltage', 'powerfactor']],
];
export const kindMeta = (kind?: string) => NODE_KINDS.find(k => k[0] === (kind || 'node')) || NODE_KINDS[0];

// Source binding types — mirrors [AllowedValues] on EnergyFlowSource.Type.
// The built-in source types, and their labels. A plugin's type is appended from the schema at render
// time (see sourceTypes()), so contributing one needs no edit here.
export const BUILTIN_SOURCE_TYPES: [string, string][] = [['mqtt', 'MQTT topic'], ['modbus', 'Modbus TCP']];

/// Every source type on offer: the built-ins, plus whatever the server says a plugin contributed.
///
/// Read from the schema rather than kept in step by hand — the server already fills the Type field's
/// choices with the plugin types it loaded, and duplicating that list here is how the dropdown ends up
/// missing a type the backend accepts.
export function sourceTypes(schema: any[]): [string, string][] {
  const known = new Map<string, string>(BUILTIN_SOURCE_TYPES);
  // EnergyFlow -> Nodes -> Sources -> Type carries the enum the server built.
  const find = (nodes: any[]): any => {
    for (const n of nodes || []) {
      if (n.key === 'Type' && Array.isArray(n.enumValues)) return n;
      const deeper = find(n.properties || (n.valueSchema ? [n.valueSchema] : []));
      if (deeper) return deeper;
    }
    return null;
  };
  const flow = (schema || []).find((n: any) => n.key === 'EnergyFlow');
  const typeNode = flow ? find(flow.properties || []) : null;
  (typeNode?.enumValues || []).forEach((v: string) => {
    if (v && !known.has(v)) known.set(v, v);
  });
  return [...known.entries()] as [string, string][];
}

// Metrics whose sign carries direction, so inverting one is meaningful (export vs import, charge vs discharge).
export const SIGNED_METRICS = ['realpower', 'apparentpower', 'current'];
// Metrics where an in/out direction means anything at all.
export const DIRECTIONAL_METRICS = [...SIGNED_METRICS, 'energy'];

// Why a "Current" cell can sit empty — the thing every new binding trips over.
export const LIVE_HINT = 'Live value from the running ingest. It appears when the source next reports: an MQTT binding when the publisher sends, a Modbus one on the worker’s next poll — and a new or edited binding is not read at all until you Save. Nothing here is missing because the page needs reloading.';
export const MODBUS_REGISTER_TYPES = ['holding', 'input'];
export const MODBUS_DATATYPES = ['uint16', 'int16', 'uint32', 'int32', 'float32'];
export const MODBUS_WORDORDERS = ['big', 'little'];

// How an unmeasured node is valued — mirrors [AllowedValues] on EnergyFlowNode.Mode.
export const NODE_MODES: [string, string, string][] = [
  ['none', 'None (nothing inferred)', 'Never inferred — contributes nothing unless it has a real value or children, so an unmeasured node simply drops out instead of showing a fabricated figure. The default for a new node.'],
  ['auto', 'Auto (aggregate)', 'Sums its children. As a feeder it carries a node’s unmet demand only when it is the single path into it — where conservation leaves no other answer. It never splits a load between several unmeasured feeders: that would be inventing a number. Mark one feeder “residual” to say where the remainder actually comes from.'],
  ['static', 'Static (fixed value)', 'A fixed leaf valued at the number you enter (still superseded by a bound live source). Reveals the Fixed value field.'],
  ['residual', 'Residual (untracked feeder)', 'The designated absorber on the feeder side: carries the demand still needed after every measured feeder has supplied its part. This is how you tell the diagram where unaccounted power comes from — without it, competing unmeasured feeders all read “no data”.'],
  ['untracked', 'Untracked (child of a measured parent)', 'Place under a parent that has a measured total (a bound source or fixed value): shows the slice of that total its tracked siblings don’t account for. Contributes nothing if the parent has no measured total.'],
];

// The vocabulary the energy-flow code is written in: which metrics exist, what a node can be, what a
// source can be read from, and the Modbus shapes.
//
// One module because these are the terms every page uses to mean the same thing. Kept in step with
// FlowUnits.cs and the config model on the server — the server is the authority, and a name that drifts
// here is a binding the roll-up silently ignores.
// Metrics a live source can supply: [stored key (matches PDU Measurement.Type), friendly label, canonical
// unit, selectable input units]. The key stays the PDU vocabulary so live values roll up with outlets; the
// UI shows the friendly name and a unit picker. Mirrors EnergyFlowSource.Metric + FlowUnits (Core).
// key, label, canonical unit, input units it can be bound in.
// Kept in step with FlowUnits.cs (Core), which is the authority — including which of these add up the
// tree. The intensive ones below describe a condition at a point and are never rolled up: a node shows
// the reading it has, and one with none shows nothing rather than a sum that was true nowhere.
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
// Metrics the diagram can be drawn by but nothing can be *bound* to, so they stay out of METRICS — that
// list is the source-binding vocabulary, and the daily total is derived from counters already bound there.
export const DERIVED_METRIC_LABELS: Record<string, string> = { energytoday: 'Energy today' };
export const metricLabel = (key?: string) => DERIVED_METRIC_LABELS[key || ''] || metricMeta(key)[1];
// The live-cache key a source reads under, given its direction — mirrors FlowMetricKey (Core): an 'in'
// (charge/export) reading is stored under a '#in' suffix so it doesn't collide with the 'out' supply value.
export const sourceMetricKey = (src: any) => { const m = src.Metric || 'realpower'; return src.Direction === 'in' ? m + '#in' : m; };

// What a virtual node represents — mirrors [AllowedValues] on EnergyFlowNode.Kind. Each kind offers only
// the metrics that make sense for it (a battery has no frequency); 'battery' also gets a storage field.
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

// Source binding types — mirrors [AllowedValues] on EnergyFlowSource.Type. Each type renders its own fields
// in the two source columns; adding an ingest is another entry here plus a branch in the row renderer.
export const SOURCE_TYPES: [string, string][] = [['mqtt', 'MQTT topic'], ['modbus', 'Modbus TCP']];

// Metrics whose sign carries direction, so inverting one is meaningful (export vs import, charge vs discharge).
// These are also the ones a single ± value can be *split* into out/in — an instantaneous quantity, unlike a
// cumulative energy counter (which needs separate in/out totals, so it gets out/in but not split).
export const SIGNED_METRICS = ['realpower', 'apparentpower', 'current'];
// Metrics where an in/out direction means anything at all. Voltage, frequency, power factor and state of
// charge don't have a direction, so the Direction control is hidden for them entirely.
export const DIRECTIONAL_METRICS = [...SIGNED_METRICS, 'energy'];

// Why a "Current" cell can sit empty — the thing every new binding trips over.
export const LIVE_HINT = 'Live value from the running ingest. It appears when the source next reports: an MQTT binding when the publisher sends, a Modbus one on the worker’s next poll — and a new or edited binding is not read at all until you Save. Nothing here is missing because the page needs reloading.';
export const MODBUS_REGISTER_TYPES = ['holding', 'input'];
export const MODBUS_DATATYPES = ['uint16', 'int16', 'uint32', 'int32', 'float32'];
export const MODBUS_WORDORDERS = ['big', 'little'];

// How an unmeasured node is valued — mirrors [AllowedValues] on EnergyFlowNode.Mode. A live/static value
// always wins; this only governs nodes the graph would otherwise infer. 'None' leads because it's what a new
// node gets: a node you haven't measured yet should read as nothing, not as an inferred figure.
export const NODE_MODES: [string, string, string][] = [
  ['none', 'None (nothing inferred)', 'Never inferred — contributes nothing unless it has a real value or children, so an unmeasured node simply drops out instead of showing a fabricated figure. The default for a new node.'],
  ['auto', 'Auto (aggregate)', 'Sums its children. As a feeder it carries a node’s unmet demand only when it is the single path into it — where conservation leaves no other answer. It never splits a load between several unmeasured feeders: that would be inventing a number. Mark one feeder “residual” to say where the remainder actually comes from.'],
  ['static', 'Static (fixed value)', 'A fixed leaf valued at the number you enter (still superseded by a bound live source). Reveals the Fixed value field.'],
  ['residual', 'Residual (untracked feeder)', 'The designated absorber on the feeder side: carries the demand still needed after every measured feeder has supplied its part. This is how you tell the diagram where unaccounted power comes from — without it, competing unmeasured feeders all read “no data”.'],
  ['untracked', 'Untracked (child of a measured parent)', 'Place under a parent that has a measured total (a bound source or fixed value): shows the slice of that total its tracked siblings don’t account for. Contributes nothing if the parent has no measured total.'],
];

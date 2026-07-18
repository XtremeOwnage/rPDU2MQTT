using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// User-defined energy-flow hierarchy (#129). Lets you place the auto-derived PDU/outlet nodes (and
/// future producers) under custom upstream nodes — breakers, transfer-switch outputs, a "Total" root —
/// so the flow/Sankey shows the whole path (outlet → PDU → breaker → transfer switch → total). Optional;
/// when empty, only the auto-derived PDU → outlet flow is shown.
/// </summary>
public class EnergyFlowConfig
{
    /// <summary>
    /// Custom upstream nodes that aren't auto-derived from a PDU (e.g. a breaker, a transfer-switch
    /// output, the grid "Total"). Auto nodes use ids like <c>pdu:&lt;name&gt;</c> / <c>outlet:&lt;pdu&gt;:&lt;n&gt;</c>.
    /// </summary>
    [Description("Custom upstream flow nodes (breakers, transfer-switch outputs, Total, ...), keyed by a stable id.")]
    public List<EnergyFlowNode> Nodes { get; set; } = new();

    /// <summary>
    /// Directed energy-flow links — each entry means energy flows <c>From</c> → <c>To</c>. A node may be
    /// the <c>To</c> of several links (multiple feeders, e.g. a transfer switch fed by grid + generator +
    /// inverter), and a producer is just a link pointing into the thing it powers (solar → inverter).
    /// Endpoints may be custom node ids or auto ids (<c>pdu:…</c> / <c>outlet:…</c>).
    /// </summary>
    [Description("Directed energy-flow links (From feeds To). Allows multiple feeders per node and producer inputs.")]
    public List<EnergyFlowLink> Links { get; set; } = new();

    /// <summary>
    /// Legacy single-feeder map (child id → parent id), superseded by <see cref="Links"/>. Still honored on
    /// load (each entry behaves like a link parent → child) so older configs keep working.
    /// </summary>
    [Description("Legacy single-feeder map (child id -> parent id). Prefer Links; still honored for back-compat.")]
    public Dictionary<string, string> Parents { get; set; } = new();

    /// <summary>Publish each hierarchy tier's rolled-up value to MQTT every poll (#164).</summary>
    [DefaultValue(false)]
    [Description("Publish each energy-hierarchy tier's rolled-up value to MQTT every poll.")]
    public bool MqttExport { get; set; }

    /// <summary>Template for the per-node MQTT topic. Placeholders: {parent} {id} {label} {kind} {metric} {units}.</summary>
    [DefaultValue("{parent}/energyflow/{id}")]
    [Description("Template for each tier's MQTT topic. Placeholders: {parent} (MQTT parent topic), {id}, {label}, {kind}, {metric}, {units}. e.g. '{parent}/energyflow/{id}'.")]
    [TemplateVariables("parent", "id", "label", "kind", "metric", "units")]
    public string MqttTopicTemplate { get; set; } = "{parent}/energyflow/{id}";
}

/// <summary>A directed energy-flow link: energy flows <see cref="From"/> → <see cref="To"/>.</summary>
public class EnergyFlowLink
{
    [Description("Source node id — energy flows out of here.")]
    public string From { get; set; } = "";

    [Description("Target node id — energy flows into here.")]
    public string To { get; set; } = "";
}

/// <summary>A custom flow node (see <see cref="EnergyFlowConfig.Nodes"/>).</summary>
public class EnergyFlowNode
{
    [Description("Stable unique id used to wire parents/children.")]
    public string Id { get; set; } = "";

    [Description("Human-readable label shown in the flow diagram.")]
    public string Label { get; set; } = "";

    /// <summary>
    /// What this node represents (#129). Purely descriptive today — it drives the diagram's styling and
    /// which fields/metrics the editor offers (a battery has storage but no frequency, etc.) — but leaves
    /// room for kind-specific behaviour (battery charge/discharge, inverter efficiency) later. <c>node</c>
    /// is the plain virtual node it has always been.
    /// </summary>
    [DefaultValue("node")]
    [Description("What this node represents: 'node' (generic), 'panel', 'inverter', 'battery', 'solar', 'grid', or 'load'. Drives styling and the fields the editor offers.")]
    [AllowedValues("node", "panel", "inverter", "battery", "solar", "grid", "load")]
    public string Kind { get; set; } = "node";

    /// <summary>
    /// A directly-known value for this node, used when it has no children (a leaf) and no live
    /// <see cref="Sources"/> reading has arrived. A manual/known figure — e.g. an untracked load, or a
    /// panel you're modelling before its CT clamp is ingested. Ignored when the node aggregates children.
    /// </summary>
    [Description("Optional fixed value for a leaf node. Used only when no live source has reported for it.")]
    public double? Value { get; set; }

    /// <summary>For <see cref="Kind"/> <c>battery</c>: usable storage capacity in kWh. Metadata for the
    /// diagram/state-of-charge display; does not affect the power roll-up.</summary>
    [Description("For a battery node: usable storage capacity in kWh (display metadata; optional).")]
    public double? StorageKwh { get; set; }

    /// <summary>
    /// How this node's value is decided when it has no direct measurement (#129). A live source or static
    /// <see cref="Value"/> always wins regardless — this only governs nodes the graph would otherwise have
    /// to infer:
    /// <list type="bullet">
    /// <item><c>auto</c> (default): aggregate children, and as an upstream feeder take a share of what's
    /// left after measured siblings — the historical behaviour.</item>
    /// <item><c>static</c>: a fixed leaf valued at <see cref="Value"/> (still superseded by a live source).
    /// This is the mode that gives the fixed value meaning; with no value set it contributes nothing.</item>
    /// <item><c>residual</c>: the designated "untracked" absorber on the <em>feeder</em> side — takes the
    /// demand a node still needs after every measured feeder has supplied its bit (e.g. house load not
    /// behind a PDU or CT clamp).</item>
    /// <item><c>untracked</c>: the mirror on the <em>child</em> side — placed under a parent that has a
    /// measured total (a bound source / fixed value), it shows the slice of that total the parent's tracked
    /// children don't account for (HA-style untracked consumption). Contributes nothing if the parent has no
    /// measured total.</item>
    /// <item><c>none</c>: never inferred — contributes nothing unless it has a real value/children, so an
    /// unmeasured source (e.g. Grid, when solar already covers the load) simply drops out instead of being
    /// assigned a fabricated figure.</item>
    /// </list>
    /// </summary>
    [DefaultValue("auto")]
    [Description("How to value this node when it has no direct measurement: 'auto' (aggregate / share the remainder), 'static' (a fixed leaf at Value), 'residual' (absorb untracked remaining demand of what it feeds), 'untracked' (show a measured parent's unaccounted consumption), or 'none' (never inferred). A live source always wins.")]
    [AllowedValues("auto", "static", "residual", "untracked", "none")]
    public string Mode { get; set; } = "auto";

    /// <summary>
    /// Live value bindings for this node (#205), one per metric — the seam <see cref="Value"/> always
    /// described. Each binds a metric (realpower, energy, …) to an external source; a fresh reading
    /// supersedes <see cref="Value"/>, and binding several metrics lets the same node drive the power, the
    /// energy roll-up, voltage, etc. Every binding carries a <see cref="EnergyFlowSource.Type"/> (only
    /// <c>mqtt</c> today) so more ingest kinds can be added without reshaping the model.
    /// </summary>
    [Description("Live value bindings for this node, one per metric. Each binds a metric to an external source (Type 'mqtt' today). Supersedes Value.")]
    public List<EnergyFlowSource> Sources { get; set; } = new();

    /// <summary>
    /// Legacy pre-<see cref="Sources"/> MQTT bindings (#205). Still honored on load so older configs keep
    /// working; the GUI migrates these into <see cref="Sources"/> (each was implicitly <c>Type: mqtt</c>).
    /// </summary>
    [Description("Deprecated: use Sources. Legacy MQTT bindings (implicitly Type 'mqtt'); still honored for back-compat.")]
    public List<EnergyFlowSource> Mqtt { get; set; } = new();

    /// <summary>Every effective binding — the new <see cref="Sources"/> plus any legacy <see cref="Mqtt"/>.</summary>
    public IEnumerable<EnergyFlowSource> AllSources() => Sources.Concat(Mqtt);
}

/// <summary>
/// Binds one external source to one metric of a flow node (#205). Built for producers that already publish
/// their data — Solar Assistant, CT clamps, an inverter bridge — so it joins the same hierarchy, roll-ups
/// and exports as the PDU outlets. <see cref="Type"/> selects the ingest; the transport-specific fields
/// (today just the MQTT ones) apply per type.
/// </summary>
public class EnergyFlowSource
{
    [DefaultValue("mqtt")]
    [Description("Where this value comes from. Currently only 'mqtt' (subscribe to a broker topic); more ingest types can be added later.")]
    [AllowedValues("mqtt")]
    public string Type { get; set; } = "mqtt";

    [DefaultValue("realpower")]
    [Description("Which measurement this source supplies. The flow is rolled up per metric, so use realpower for live power and energy for cumulative kWh.")]
    [AllowedValues("realpower", "apparentpower", "energy", "current", "voltage", "frequency", "powerfactor")]
    public string Metric { get; set; } = "realpower";

    [Description("For Type 'mqtt': the topic carrying this value, e.g. 'solar_assistant/inverter_1/pv_power/state'. Subscribed on the configured broker.")]
    public string Topic { get; set; } = "";

    /// <summary>
    /// For JSON payloads: the field to read, dotted for nesting (<c>battery.power</c>). Blank treats the
    /// whole payload as the number, which is what Solar Assistant's <c>/state</c> topics publish.
    /// </summary>
    [Description("For JSON payloads, the field to read (dotted for nesting, e.g. 'battery.power'). Blank = the whole payload is the number.")]
    public string? JsonField { get; set; }

    [DefaultValue(1.0)]
    [Description("Multiplier applied to the received value — for unit conversion, e.g. 0.001 to turn W into kW, or -1 to flip a sign convention.")]
    public double Scale { get; set; } = 1.0;

    [DefaultValue(900)]
    [Range(0, 86400, ErrorMessage = "StaleAfterSeconds must be between 0 and 86400.")]
    [Description("Ignore the last value once it is this old, so a dead publisher stops silently propping up the flow. 0 disables the check (value never expires).")]
    public int StaleAfterSeconds { get; set; } = 900;
}

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
    /// A directly-known value for this node, used when it has no children (a leaf). The seam where
    /// external sensors will bind: today it's a manual/known figure (e.g. an untracked load, or a panel
    /// you're modelling before its CT clamp is ingested); later a node can instead bind to a live
    /// measurement from any producer (CT clamps over MQTT/emoncms, Tigo solar, inverter ports, …).
    /// Ignored when the node aggregates children.
    /// </summary>
    [Description("Optional directly-known value for a leaf node (used until a live sensor is bound).")]
    public double? Value { get; set; }
}

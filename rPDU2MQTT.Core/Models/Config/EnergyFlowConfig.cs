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
    /// Maps a node id to the id of the node that **feeds** it (its upstream parent). Keys/values may be
    /// custom node ids or auto ids. Energy flows parent → child; values aggregate up from the leaf
    /// (outlet) measurements.
    /// </summary>
    [Description("child node id -> parent (feeder) node id. Energy flows parent -> child.")]
    public Dictionary<string, string> Parents { get; set; } = new();
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

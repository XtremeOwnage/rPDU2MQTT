namespace rPDU2MQTT.Core.Flow;

/// <summary>A node in an energy/power flow graph (a PDU, an outlet, a circuit, …).</summary>
/// <param name="Id">Stable unique id (used to wire links).</param>
/// <param name="Label">Human-readable display name.</param>
/// <param name="Kind">Node kind: <c>pdu</c>, <c>outlet</c>, <c>circuit</c>, <c>total</c>, … (for styling/grouping).</param>
public sealed record FlowNode(string Id, string Label, string Kind);

/// <summary>A weighted link between two <see cref="FlowNode"/>s (energy flows Source → Target).</summary>
public sealed record FlowLink(string Source, string Target, double Value);

/// <summary>
/// A directed, weighted flow graph (nodes + links) suitable for a Sankey diagram. Today it is derived
/// automatically from a PDU snapshot (PDU → outlets, weighted by a measurement); user-defined / cross-
/// source links (#129) can later be merged into the same shape.
/// </summary>
/// <param name="Metric">The measurement the link values represent (e.g. <c>realpower</c>).</param>
/// <param name="Units">The units of the link values (e.g. <c>W</c>).</param>
public sealed record FlowGraph(
    IReadOnlyList<FlowNode> Nodes,
    IReadOnlyList<FlowLink> Links,
    string Metric,
    string Units);

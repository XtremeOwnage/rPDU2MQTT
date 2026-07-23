namespace rPDU2MQTT.Core.Flow;

/// <summary>A node in an energy/power flow graph (a PDU, an outlet, a circuit, …).</summary>
/// <param name="Id">Stable unique id (used to wire links).</param>
/// <param name="Label">Human-readable display name.</param>
/// <param name="Kind">Node kind: <c>pdu</c>, <c>outlet</c>, <c>circuit</c>, <c>total</c>, … (for styling/grouping).</param>
/// <param name="Value">
/// The node's power/energy for this graph's metric, or <see langword="null"/> when it is <b>unknown</b>.
/// <para>
/// Unknown is deliberately not zero. Zero is a claim — solar at night really is generating 0 W — whereas
/// unknown means nothing measures this node and nothing downstream determines it. Conflating the two is how
/// a diagram ends up stating a number nobody supplied, so the distinction is carried in the type.
/// </para>
/// </param>
public sealed record FlowNode(string Id, string Label, string Kind, double? Value = null);

/// <summary>A weighted link between two <see cref="FlowNode"/>s (energy flows Source → Target).</summary>
/// <param name="Known">
/// Is <paramref name="Value"/> actually derived from measurements? False means the topology says this link
/// exists but nothing determines how much flows along it — typically several unmeasured feeders into one
/// node, where any split between them would be invented. Such a link carries 0 and must be presented as
/// "no data", never as zero flow.
/// </param>
public sealed record FlowLink(string Source, string Target, double Value, bool Known = true);

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

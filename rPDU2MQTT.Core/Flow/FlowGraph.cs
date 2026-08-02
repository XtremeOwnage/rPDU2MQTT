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
/// <param name="Imbalance">
/// How far this node's outflow exceeds its inflow (<c>outflow - inflow</c>), when both are determined and
/// they materially disagree; <see langword="null"/> when they reconcile or when one of them is unknown.
///
/// <para>
/// Supply below load is not a state the hardware can be in, so a positive value here always means the two
/// sides of this node are quoting figures that cannot both be true — most often cumulative counters started
/// from different epochs (a PDU counting since it was commissioned, an inverter since its binding was
/// configured). <see cref="EnergyPeriod"/> is the fix for that; this is how the diagram admits to it in the
/// meantime, rather than quietly rendering the larger of the two numbers and letting it look deliberate.
/// </para>
/// </param>
public sealed record FlowNode(string Id, string Label, string Kind, double? Value = null, double? Imbalance = null)
{
    /// <summary>
    /// A node the builder invented for the diagram, rather than one the operator configured: a
    /// bidirectional node's return lane (<c>…#in</c>) and a pass-through's unmetered remainder
    /// (<c>…#unmeasured</c>).
    ///
    /// <para>
    /// These describe an arithmetic result, not a device. They must never be published: the id would
    /// become an MQTT topic, and '#' is the multi-level wildcard — <c>energy/main_panel#unmeasured</c> is
    /// not a legal publish topic at all. They would also duplicate figures the export already sends
    /// properly (the in-direction goes out as the parent's <c>energy_in</c>, not as a separate device).
    /// </para>
    /// <para>
    /// Centralised here because every consumer has to make this distinction and three of them got it wrong
    /// independently — the Energy Overview double-counted a battery as charging and discharging at once,
    /// the hierarchy editor offered these as wiring targets, and both exports published them.
    /// </para>
    /// </summary>
    public bool Synthetic => Id.Contains('#');
}

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

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// How a <see cref="FlowNode"/> came by its value.
///
/// <para>
/// <c>summed</c> is deliberately distinct from <c>measured</c>: a PDU's total is real, but it is real
/// <em>because</em> its outlets are. <c>inferred</c> is the one that matters most — conservation says the
/// load arrived by the one path left open, which is sound arithmetic about a topology someone drew, and only
/// as true as that topology.
/// </para>
/// </summary>
public static class FlowDerivation
{
    /// <summary>The node reports this value itself — a live source, a static value, an outlet measurement.</summary>
    public const string Measured = "measured";
    /// <summary>Aggregated from links that are themselves known: a PDU's outlets, a panel's circuits.</summary>
    public const string Summed = "summed";
    /// <summary>Back-filled by conservation: the only unmeasured path into a node whose demand is known.</summary>
    public const string Inferred = "inferred";
    /// <summary>Nothing measures it and nothing determines it. <c>Value</c> is null.</summary>
    public const string Unknown = "unknown";
}

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
/// How far this node's flows exceed what it claims. For an unmeasured node that is <c>outflow - inflow</c>;
/// for a measured one it is how far its throughput exceeds its own reading. <see langword="null"/> when they
/// reconcile, or when there is not enough determined on both sides to compare.
///
/// <para>
/// Supply below load is not a state the hardware can be in, so a positive value here always means the two
/// sides of this node are quoting figures that cannot both be true — most often cumulative counters started
/// from different epochs (a PDU counting since it was commissioned, an inverter since its binding was
/// configured). <see cref="EnergyPeriod"/> is the fix for that; this is how the diagram admits to it in the
/// meantime, rather than quietly rendering the larger of the two numbers and letting it look deliberate.
/// </para>
/// </param>
/// <param name="Derivation">
/// How this node's value was arrived at — see <see cref="FlowDerivation"/>. Carried because a number's
/// provenance is part of the number: an inferred figure is not wrong, but it is not a measurement either,
/// and rendering it identically to a metered reading is how a diagram states something it cannot back up.
/// </param>
/// <param name="Throughput">
/// What passes through the node, when that is more than its own reading covers — an inverter measuring its
/// AC-load leg while also charging a battery. <see langword="null"/> when the reading covers the throughput,
/// when the node is not measured, or when there is not enough on both sides to tell.
///
/// <para>
/// Not an <see cref="Imbalance"/>: the flows here reconcile perfectly and nothing is unaccounted for. The
/// two were conflated, and the diagram warned that a node's figure was "contradicted by its own flows" for
/// the ordinary case of a sensor sitting on one leg of a bidirectional device.
/// </para>
/// </param>
public sealed record FlowNode(
    string Id, string Label, string Kind, double? Value = null, double? Imbalance = null,
    string Derivation = FlowDerivation.Unknown, IReadOnlyList<string>? Tags = null, double? Throughput = null)
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

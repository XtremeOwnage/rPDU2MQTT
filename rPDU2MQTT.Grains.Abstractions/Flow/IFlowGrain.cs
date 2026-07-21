using rPDU2MQTT.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Abstractions.Flow;

/// <summary>
/// The cluster-wide edge of the energy flow (single-activation grain, key 0). Sources push their measurements
/// in here; the API/GUI/exporters read the computed flow out of here.
/// <para>
/// It does not compute the flow — the node grains do, each owning its own value and pushing it here via
/// <see cref="PublishNodeValue"/>. This grain is the <b>projection</b>: the current value of every node that
/// has published one, assembled into a <see cref="FlowSnapshot"/> on demand. Nodes appear here simply by
/// publishing, so config-declared and runtime-derived (auto PDU→outlet) nodes need no separate registration.
/// </para>
/// </summary>
public interface IFlowGrain : IGrainWithIntegerKey
{
    /// <summary>Ingest one source's measurements (already mapped to node/metric, canonical units).</summary>
    Task Ingest(MeasurementSnapshot measurements);

    /// <summary>A node grain reporting its newly computed value for a metric (null = it no longer has one).</summary>
    Task PublishNodeValue(string nodeId, Metric metric, double? value);

    /// <summary>The current flow snapshot: every node's value as the node grains last published it.</summary>
    Task<FlowSnapshot> Current();

    /// <summary>The current rolled-up value for one (node, metric), or null if no node has published it.</summary>
    Task<double?> NodeValue(string nodeId, Metric metric);

    /// <summary>Every fresh raw leaf value — for each process to sync into its local live-value source.</summary>
    Task<List<RawValue>> RawValues();
}

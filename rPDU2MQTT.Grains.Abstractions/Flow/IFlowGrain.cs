using rPDU2MQTT.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Abstractions.Flow;

/// <summary>
/// The energy-flow middleware as a single-activation grain (key 0) — the cluster-wide owner of the mapped
/// hierarchy. Sources push their measurements here; the API/GUI/exporters read the computed flow here. This
/// is the location-transparent replacement for the per-process <c>FlowValueCache</c> + the MQTT bus bridge:
/// one authority, reachable from any silo.
/// </summary>
public interface IFlowGrain : IGrainWithIntegerKey
{
    /// <summary>Ingest one source's measurements (already mapped to node/metric, canonical units).</summary>
    Task Ingest(MeasurementSnapshot measurements);

    /// <summary>The current computed flow snapshot (fresh version each call).</summary>
    Task<FlowSnapshot> Current();

    /// <summary>The current rolled-up value for one (node, metric), or null if unmapped.</summary>
    Task<double?> NodeValue(string nodeId, Metric metric);
}

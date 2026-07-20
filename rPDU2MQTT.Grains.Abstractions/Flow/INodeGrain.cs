using rPDU2MQTT.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Abstractions.Flow;

/// <summary>
/// One energy-flow node as its own grain (key = node id). Each node is an addressable, long-lived actor that
/// holds its own current leaf values — so a node can be queried directly, appears in the grain tree, and is
/// the place per-node behaviour (its source children, per-node exports) will hang off. The cluster-wide
/// <see cref="IFlowGrain"/> stays the roll-up authority (the hierarchy sum needs every value together); it
/// fans each node's leaf values out to that node's grain, so this is additive, not a second source of truth
/// for the roll-up.
/// </summary>
public interface INodeGrain : IGrainWithStringKey
{
    /// <summary>Set this node's current leaf values (pushed by the flow authority on ingest).</summary>
    Task Set(List<MeasurementReading> readings);

    /// <summary>This node's current, non-stale leaf values.</summary>
    Task<List<MeasurementReading>> Values();
}

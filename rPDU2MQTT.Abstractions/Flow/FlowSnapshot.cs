using rPDU2MQTT.Abstractions.Pipeline;

namespace rPDU2MQTT.Abstractions.Flow;

/// <summary>One node's rolled-up value for a metric, as computed by the flow middleware.</summary>
public readonly record struct FlowNodeValue(string NodeId, Metric Metric, double Value);

/// <summary>
/// The flow middleware's output — the whole mapped energy hierarchy at a point in time. This is the snapshot
/// that flows <b>middleware → destinations</b>. It is itself an <see cref="ISnapshot"/> (SourceId
/// <see cref="FlowSourceId"/>), so a destination consumes it exactly like it consumes a raw source snapshot:
/// the pipeline is snapshots-and-events all the way down.
/// </summary>
public sealed record FlowSnapshot(
    string SourceId,
    DateTimeOffset TimestampUtc,
    long Version,
    IReadOnlyList<FlowNodeValue> Values) : ISnapshot
{
    /// <summary>The conventional <see cref="ISnapshot.SourceId"/> for middleware output.</summary>
    public const string FlowSourceId = "flow";
}

using rPDU2MQTT.Abstractions.Pipeline;

namespace rPDU2MQTT.Abstractions.Flow;

/// <summary>One node's rolled-up value for a metric.</summary>
public readonly record struct FlowNodeValue(string NodeId, Metric Metric, double Value);

/// <summary>
/// The whole mapped energy hierarchy at a point in time — the snapshot that flows to the destinations. It is
/// itself an <see cref="ISnapshot"/> (SourceId
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

using Microsoft.Extensions.Logging;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Abstractions.Pipeline;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// The write side of the flow middleware: a source emits measurement snapshots into this, and they land in
/// the value cache the graph builder reads.
///
/// <para>
/// This replaces a round trip that existed only because the cache lived in a grain: a sink pushed each
/// snapshot into the flow grain, the grain wrote it into a <see cref="FlowValueCache"/>, and a service
/// polled that grain every two seconds to copy the values back into <i>this</i> process's cache. In one
/// process that is a write, a read, and a two-second delay between a reading arriving and anything being
/// able to see it — for data that was already local.
/// </para>
/// <para>
/// The ordering rule is kept, because it is real: a source that restarted has a reset (low) version but a
/// newer timestamp, so a snapshot is only ignored when it is stale by BOTH. Comparing versions alone locks
/// out a restarted source until its counter climbs back past the old high, which for a fast-ticking source
/// can be a very long time, or never.
/// </para>
/// </summary>
public sealed class FlowValueSink : ISnapshotSink<MeasurementSnapshot>
{
    private readonly FlowValueCache cache;
    private readonly ILogger<FlowValueSink>? log;
    private readonly Dictionary<string, (long Version, DateTimeOffset At)> sourceSeen = new(StringComparer.Ordinal);
    private readonly object gate = new();

    public FlowValueSink(FlowValueCache cache, ILogger<FlowValueSink>? log = null)
    {
        this.cache = cache;
        this.log = log;
    }

    public ValueTask EmitAsync(MeasurementSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        lock (gate)
        {
            if (sourceSeen.TryGetValue(snapshot.SourceId, out var seen)
                && snapshot.Version <= seen.Version && snapshot.TimestampUtc <= seen.At)
            {
                log?.LogTrace("Flow ingest from {Source}: v{Version}@{At} not newer than v{SeenV}@{SeenAt}, ignored.",
                    snapshot.SourceId, snapshot.Version, snapshot.TimestampUtc, seen.Version, seen.At);
                return ValueTask.CompletedTask;
            }
            sourceSeen[snapshot.SourceId] = (snapshot.Version, snapshot.TimestampUtc);
        }

        var now = DateTime.UtcNow;
        foreach (var r in snapshot.Readings)
            cache.Set(r.NodeId, r.Metric.CanonicalName(), r.Value, r.StaleAfterSeconds, now);

        log?.LogDebug("Flow ingest from {Source} v{Version}: {Count} reading(s).",
            snapshot.SourceId, snapshot.Version, snapshot.Readings.Count);

        return ValueTask.CompletedTask;
    }
}

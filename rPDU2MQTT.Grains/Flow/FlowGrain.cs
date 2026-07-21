using Orleans.Concurrency;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// The flow's edge grain (singleton, key 0). Two jobs, no math:
/// <list type="bullet">
/// <item>ingest — fan each source reading out to its measured-leaf node grain, which is where the dataflow
/// starts; the raw readings are also kept so each process can mirror them into its local value source.</item>
/// <item>project — hold what every node grain published (they push on change plus a heartbeat) and serve it
/// as a <see cref="FlowSnapshot"/>.</item>
/// </list>
/// Reentrant because ingest is a round trip: feeding a leaf makes that leaf (and its parents) publish back
/// into this grain while the ingest call is still in flight.
/// </summary>
[Reentrant]
public sealed class FlowGrain : Grain, IFlowGrain
{
    /// <summary>Raw leaf readings as ingested, with their staleness — the per-process sync reads these.</summary>
    private readonly FlowValueCache raw = new();

    /// <summary>Last seen snapshot version per source, so a duplicate/out-of-order snapshot is ignored.</summary>
    private readonly Dictionary<string, long> sourceVersions = new(StringComparer.Ordinal);

    /// <summary>The projection: each node's current value per metric, as its grain last published it.</summary>
    private readonly Dictionary<string, Dictionary<Metric, double>> nodes = new(StringComparer.OrdinalIgnoreCase);

    private long version;

    public async Task Ingest(MeasurementSnapshot measurements)
    {
        // Order-tolerant per source: an older/duplicate version is ignored.
        if (sourceVersions.TryGetValue(measurements.SourceId, out var seen) && measurements.Version <= seen) return;
        sourceVersions[measurements.SourceId] = measurements.Version;

        var now = DateTime.UtcNow;
        foreach (var r in measurements.Readings)
            raw.Set(r.NodeId, r.Metric.CanonicalName(), r.Value, r.StaleAfterSeconds, now);

        // A source feeds a measured leaf; everything above it recomputes by subscription from there.
        foreach (var r in measurements.Readings)
            await GrainFactory.GetGrain<IMeasuredNodeGrain>(r.NodeId).Observe(r.Metric, r.Value);
    }

    public Task PublishNodeValue(string nodeId, Metric metric, double? value)
    {
        if (!nodes.TryGetValue(nodeId, out var byMetric))
            nodes[nodeId] = byMetric = new();

        if (value is { } v) byMetric[metric] = v;
        else byMetric.Remove(metric);

        if (byMetric.Count == 0) nodes.Remove(nodeId);
        return Task.CompletedTask;
    }

    public Task<FlowSnapshot> Current()
    {
        var values = new List<FlowNodeValue>();
        foreach (var (id, byMetric) in nodes)
            foreach (var (metric, value) in byMetric)
                values.Add(new FlowNodeValue(id, metric, value));

        return Task.FromResult(new FlowSnapshot(
            FlowSnapshot.FlowSourceId, DateTimeOffset.UtcNow, Interlocked.Increment(ref version), values));
    }

    public Task<double?> NodeValue(string nodeId, Metric metric)
        => Task.FromResult(nodes.TryGetValue(nodeId, out var byMetric) && byMetric.TryGetValue(metric, out var v)
            ? v : (double?)null);

    public Task<List<RawValue>> RawValues()
    {
        var now = DateTime.UtcNow;
        var list = new List<RawValue>();
        foreach (var (node, metric) in raw.Keys)
            if (raw.TryGetValue(node, metric, now, out var v) && Metrics.TryParse(metric, out var m))
                list.Add(new RawValue(node, m, v));
        return Task.FromResult(list);
    }
}

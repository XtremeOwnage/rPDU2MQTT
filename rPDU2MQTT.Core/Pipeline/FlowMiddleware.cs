using System.Collections.Concurrent;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Abstractions.Pipeline;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Pipeline;

/// <summary>
/// The flow-mapping middleware (v3): the single place source measurements become the energy hierarchy.
/// Thin orchestration over the domain — it holds the latest value per <c>(node, metric)</c> and the latest
/// PDU data, then runs the pure <see cref="FlowGraphBuilder"/> (the global graph math) to produce a
/// <see cref="FlowSnapshot"/>. It is also an <see cref="IFlowValueSource"/> so the builder reads the live
/// values straight back out. No transport here — a grain hosts one of these.
/// </summary>
public sealed class FlowMiddleware : IFlowMiddleware, IFlowValueSource
{
    private readonly Func<EnergyFlowConfig> flow;
    private readonly FlowValueCache cache = new();
    private readonly ConcurrentDictionary<string, long> sourceVersions = new(StringComparer.Ordinal);
    private volatile PduData pdu = new();
    private long version;

    /// <param name="flow">Reads the current energy-flow topology (live, so GUI edits take effect at once).</param>
    public FlowMiddleware(Func<EnergyFlowConfig> flow) => this.flow = flow;

    /// <summary>Update the merged PDU data — the PDU is a source too; its snapshot feeds the same graph.</summary>
    public void SetPduData(PduData data) => pdu = data;

    public void Ingest(MeasurementSnapshot measurements)
    {
        // Order-tolerant per source: an older/duplicate version is ignored.
        if (sourceVersions.TryGetValue(measurements.SourceId, out var seen) && measurements.Version <= seen) return;
        sourceVersions[measurements.SourceId] = measurements.Version;

        var now = DateTime.UtcNow;
        foreach (var r in measurements.Readings)
            cache.Set(r.NodeId, r.Metric.CanonicalName(), r.Value, r.StaleAfterSeconds, now);
    }

    public bool TryGetValue(string nodeId, string metric, out double value) => cache.TryGetValue(nodeId, metric, out value);

    public FlowSnapshot Snapshot()
    {
        var cfg = flow();
        var values = new List<FlowNodeValue>();
        foreach (Metric metric in Enum.GetValues<Metric>())
        {
            var graph = FlowGraphBuilder.Build(pdu, cfg, metric.CanonicalName(), this);
            foreach (var node in graph.Nodes)
            {
                var v = FlowExport.NodeValue(graph, node.Id);
                if (v != 0) values.Add(new FlowNodeValue(node.Id, metric, v));
            }
        }
        return new FlowSnapshot(FlowSnapshot.FlowSourceId, DateTimeOffset.UtcNow, Interlocked.Increment(ref version), values);
    }
}

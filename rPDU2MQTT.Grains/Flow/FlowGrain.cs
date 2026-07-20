using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Pipeline;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// Hosts the <see cref="FlowMiddleware"/> as the cluster-wide flow authority (singleton grain, key 0). Thin:
/// all mapping is the middleware's (Core); the grain just makes it reachable from every silo.
/// </summary>
public sealed class FlowGrain : Grain, IFlowGrain
{
    private readonly FlowMiddleware middleware;

    public FlowGrain(Config config) => middleware = new FlowMiddleware(() => config.EnergyFlow);

    public async Task Ingest(MeasurementSnapshot measurements)
    {
        middleware.Ingest(measurements);

        // Fan each source reading out to its measured-leaf node grain — the leaves of the distributed roll-up
        // tree (a source feeds a measured node; aggregate nodes sum their children). Additive: the middleware
        // still drives the diagram/exports today; the node-grain tree is the scale path.
        foreach (var r in measurements.Readings)
            await GrainFactory.GetGrain<IMeasuredNodeGrain>(r.NodeId).Observe(r.Metric, r.Value);
    }

    public Task<FlowSnapshot> Current() => Task.FromResult(middleware.Snapshot());

    public Task<double?> NodeValue(string nodeId, Metric metric)
        => Task.FromResult(middleware.TryGetValue(nodeId, metric.CanonicalName(), out var v) ? v : (double?)null);

    public Task<List<RawValue>> RawValues() => Task.FromResult(middleware.RawValues().ToList());
}

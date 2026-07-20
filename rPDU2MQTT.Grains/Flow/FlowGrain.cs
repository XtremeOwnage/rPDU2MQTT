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

        // Fan each node's leaf values out to its own NodeGrain, so every node is an addressable, long-lived
        // actor (and visible in the grain tree). Additive: the middleware above stays the roll-up authority,
        // so this can't skew the hierarchy — it just gives nodes their own grain identity.
        foreach (var byNode in measurements.Readings.GroupBy(r => r.NodeId))
            await GrainFactory.GetGrain<INodeGrain>(byNode.Key).Set(byNode.ToList());
    }

    public Task<FlowSnapshot> Current() => Task.FromResult(middleware.Snapshot());

    public Task<double?> NodeValue(string nodeId, Metric metric)
        => Task.FromResult(middleware.TryGetValue(nodeId, metric.CanonicalName(), out var v) ? v : (double?)null);

    public Task<List<RawValue>> RawValues() => Task.FromResult(middleware.RawValues().ToList());
}

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

    public Task Ingest(MeasurementSnapshot measurements)
    {
        middleware.Ingest(measurements);
        return Task.CompletedTask;
    }

    public Task<FlowSnapshot> Current() => Task.FromResult(middleware.Snapshot());

    public Task<double?> NodeValue(string nodeId, Metric metric)
        => Task.FromResult(middleware.TryGetValue(nodeId, metric.CanonicalName(), out var v) ? v : (double?)null);
}

using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// A measured leaf: its value is whatever a source last reported for it (a Tigo/Modbus panel, a CT-clamped
/// breaker, an outlet, an MQTT reading). The source fan-out pushes values via <see cref="Observe"/>.
/// </summary>
public sealed class MeasuredNodeGrain : NodeGrainBase, IMeasuredNodeGrain
{
    private readonly Dictionary<Metric, double> observed = new();

    public Task Observe(Metric metric, double value) { observed[metric] = value; return Task.CompletedTask; }

    public override Task<double?> Value(Metric metric)
        => Task.FromResult(observed.TryGetValue(metric, out var v) ? v : (double?)null);
}

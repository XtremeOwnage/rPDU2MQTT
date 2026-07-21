using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// A measured leaf: its value is whatever a source last reported for it (a Tigo/Modbus panel, a CT-clamped
/// breaker, an outlet, an MQTT reading). The source fan-out pushes values via <see cref="Observe"/>, which is
/// where the dataflow starts — the leaf publishes onward to whoever subscribed to it.
/// </summary>
public sealed class MeasuredNodeGrain : NodeGrainBase, IMeasuredNodeGrain
{
    private readonly Dictionary<Metric, double> observed = new();

    protected override string NodeType => "measured";

    public async Task Observe(Metric metric, double value)
    {
        observed[metric] = value;
        await Recompute(metric);
    }

    protected override double? Compute(Metric metric)
        => observed.TryGetValue(metric, out var v) ? v : null;
}

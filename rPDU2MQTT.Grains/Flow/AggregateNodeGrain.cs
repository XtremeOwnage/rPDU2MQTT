using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// A node whose value is the sum of its children — the roll-up backbone (a string sums its panels, an MPPT
/// sums its strings, a sub-panel sums its breakers, "Total" sums the lot). Owns no measurement of its own.
/// </summary>
public sealed class AggregateNodeGrain : NodeGrainBase, IAggregateNodeGrain
{
    public override async Task<double?> Value(Metric metric)
        => spec.Children.Count == 0 ? null : await SumChildren(metric);
}

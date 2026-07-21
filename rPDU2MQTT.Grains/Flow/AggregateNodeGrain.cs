using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// A node whose value is the sum of its children — the roll-up backbone (a string sums its panels, an MPPT
/// sums its strings, a sub-panel sums its breakers, "Total" sums the lot). Owns no measurement of its own:
/// it sums what its children pushed it, and republishes whenever one of them moves.
/// </summary>
public sealed class AggregateNodeGrain : NodeGrainBase, IAggregateNodeGrain
{
    protected override string NodeType => "aggregate";

    protected override double? Compute(Metric metric)
    {
        double sum = 0;
        var any = false;
        foreach (var c in spec.Children)
            if (Input(c.Id, metric) is { } v) { sum += v; any = true; }

        // No children, or no child that knows this metric → no value (rather than a misleading zero).
        return any ? sum : null;
    }
}

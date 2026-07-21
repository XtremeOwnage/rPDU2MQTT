using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// A residual node: the part of a measured parent's total not accounted for by its measured siblings
/// (HA-style untracked consumption). Value = parent.total − Σ measured siblings, clamped at 0. Reports no
/// value (rather than a wrong one) until it has a measured parent to split.
/// </summary>
public sealed class ResidualNodeGrain : NodeGrainBase, IResidualNodeGrain
{
    public override async Task<double?> Value(Metric metric)
    {
        if (spec.Parent is null) return null;                       // nothing to split
        var total = await Child(spec.Parent).Value(metric);
        if (total is null) return null;                             // parent has no known total yet
        var tracked = await SumChildren(metric);                    // the measured siblings
        return Math.Max(0, total.Value - tracked);
    }
}

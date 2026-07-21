using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// A residual node: the part of a measured parent's total not accounted for by its measured siblings
/// (HA-style untracked consumption). Value = parent.total − Σ measured siblings, clamped at 0. It subscribes
/// to the parent and the siblings alike, so a move on either end republishes the remainder. Reports no value
/// (rather than a wrong one) until it has a measured parent to split.
/// </summary>
public sealed class ResidualNodeGrain : NodeGrainBase, IResidualNodeGrain
{
    public ResidualNodeGrain(Microsoft.Extensions.Logging.ILogger<ResidualNodeGrain> log) : base(log) { }

    protected override string NodeType => "residual";

    protected override double? Compute(Metric metric)
    {
        if (spec.Parent is not { } parent) return null;             // nothing to split
        if (Input(parent.Id, metric) is not { } total) return null;  // parent has no known total yet

        double tracked = 0;
        foreach (var c in spec.Children)
            if (Input(c.Id, metric) is { } v) tracked += v;

        return Math.Max(0, total - tracked);
    }
}

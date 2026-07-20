using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Flow;

/// <summary>
/// A residual node: absorbs the part of a measured parent's total not accounted for by its measured
/// siblings (HA-style untracked consumption). Needs its parent's total + sibling draw, so it's wired in a
/// follow-up (the parent passes context); today it reports no value rather than a wrong one.
/// </summary>
public sealed class ResidualNodeGrain : NodeGrainBase, IResidualNodeGrain
{
    public override Task<double?> Value(Metric metric) => Task.FromResult<double?>(null);
}

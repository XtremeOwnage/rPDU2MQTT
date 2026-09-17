using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>One pole of a breaker: the wire leaving it and the clamp on that wire, if there is one.</summary>
/// <param name="Leg">1 for a single-pole breaker; 1 and 2 for the two poles of a double-pole.</param>
public sealed record BreakerLeg(int Leg, string Wire, CtClampConfig? Clamp)
{
    /// <summary>The monitor channel this leg is measured by, or null when the chain stops short of one.</summary>
    public string? Channel => string.IsNullOrWhiteSpace(Clamp?.Channel) ? null : Clamp!.Channel;
}

/// <summary>A breaker and the chain from it to the channels measuring it: breaker → wire → clamp → channel.</summary>
public sealed record BreakerChain(PanelConfig Panel, BreakerConfig Breaker, IReadOnlyList<BreakerLeg> Legs);

/// <summary>
/// Why a breaker's power is not known. A partial sum is never reported as the whole (#454), so one missing
/// link leaves the breaker unknown rather than under-reported.
/// </summary>
public enum PowerGap
{
    None,
    NoClamp,
    NoChannel,
    NoReading,
}

/// <summary>
/// The panel directory resolved: from any of breaker, wire, clamp or channel, the rest of the chain (#454).
/// </summary>
public sealed class PanelMap
{
    private readonly List<BreakerChain> chains = new();

    public static PanelMap For(EnergyFlowConfig? flow)
    {
        var map = new PanelMap();
        var panels = flow?.Panels ?? new List<PanelConfig>();
        var clamps = flow?.Clamps ?? new List<CtClampConfig>();
        foreach (var panel in panels)
            foreach (var breaker in panel.Breakers)
            {
                var legs = new List<BreakerLeg>();
                for (var leg = 1; leg <= Math.Max(1, breaker.Poles); leg++)
                {
                    var clamp = clamps.FirstOrDefault(c =>
                        Same(c.Panel, panel.Id) && Same(c.Breaker, breaker.Number) && Math.Max(1, c.Leg) == leg);
                    var wire = !string.IsNullOrWhiteSpace(clamp?.Wire) ? clamp!.Wire : breaker.Wire;
                    legs.Add(new BreakerLeg(leg, wire, clamp));
                }
                map.chains.Add(new BreakerChain(panel, breaker, legs));
            }
        return map;
    }

    private static bool Same(string? a, string? b) =>
        !string.IsNullOrWhiteSpace(a) && string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    /// <summary>Every breaker in every panel, with its chain.</summary>
    public IReadOnlyList<BreakerChain> Chains => chains;

    /// <summary>The chain for one breaker, by the panel it is in and its number as written.</summary>
    public BreakerChain? Breaker(string panelId, string number) =>
        chains.FirstOrDefault(c => Same(c.Panel.Id, panelId) && Same(c.Breaker.Number, number));

    /// <summary>The breaker a monitor channel measures — the chain read from the far end.</summary>
    public BreakerChain? ByChannel(string channel) =>
        chains.FirstOrDefault(c => c.Legs.Any(l => Same(l.Channel, channel)));

    /// <summary>The breaker a wire leaves.</summary>
    public BreakerChain? ByWire(string wire) =>
        chains.FirstOrDefault(c => c.Legs.Any(l => Same(l.Wire, wire)));

    /// <summary>The breaker a clamp is measuring.</summary>
    public BreakerChain? ByClamp(string label) =>
        chains.FirstOrDefault(c => c.Legs.Any(l => Same(l.Clamp?.Label, label)));

    /// <summary>
    /// A breaker's power: the sum of its legs, or null when any leg has no clamp, no channel or no reading.
    /// Half of a double-pole breaker is not the breaker's power, and a reversed clamp is flipped rather than
    /// believed as a negative load.
    /// </summary>
    public static double? Power(BreakerChain chain, IFlowValueSource? live, string metric = FlowGraphBuilder.DefaultMetric)
        => Power(chain, live, metric, out _);

    /// <summary>As <see cref="Power(BreakerChain, IFlowValueSource?, string)"/>, and why it is unknown when it is.</summary>
    public static double? Power(BreakerChain chain, IFlowValueSource? live, string metric, out PowerGap gap)
    {
        double total = 0;
        foreach (var leg in chain.Legs)
        {
            if (leg.Clamp is null) { gap = PowerGap.NoClamp; return null; }
            if (leg.Channel is null) { gap = PowerGap.NoChannel; return null; }
            if (live is null || !live.TryGetValue(leg.Channel, metric, out var value)) { gap = PowerGap.NoReading; return null; }
            total += leg.Clamp.Reversed ? -value : value;
        }
        gap = PowerGap.None;
        return total;
    }
}

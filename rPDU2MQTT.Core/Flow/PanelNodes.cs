using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>A breaker as a node of the energy flow: beneath its panel, above the channels measuring it (#458).</summary>
/// <param name="Derived">The node is the breaker itself, invented here; false when the breaker names a node of its own.</param>
public sealed record BreakerNode(string Id, string Label, string PanelNode, IReadOnlyList<string> Channels, BreakerChain Chain, bool Derived);

/// <summary>
/// The nodes a panel directory implies (#458). A mapped breaker is a tier of its own, so per-breaker power and
/// energy reach the diagram and every export without anyone wiring it again by hand.
/// </summary>
public static class PanelNodes
{
    /// <summary>The node id for a breaker nobody has named a node for.</summary>
    public static string IdFor(string panelId, string number) => $"breaker:{panelId}:{number}";

    /// <summary>
    /// Every breaker that belongs on the graph: one that something measures, and one someone has identified,
    /// which appears with no value rather than a zero. An unused slot is not a tier.
    /// </summary>
    public static IReadOnlyList<BreakerNode> For(EnergyFlowConfig? flow)
    {
        var f = flow ?? new EnergyFlowConfig();
        var map = PanelMap.For(f);
        var out_ = new List<BreakerNode>();
        foreach (var chain in map.Chains)
        {
            var b = chain.Breaker;
            if (string.IsNullOrWhiteSpace(b.Number)) continue;
            if (BreakerState.Of(b.State) == BreakerState.Unused) continue;
            var channels = Channels(chain);
            if (channels.Count == 0 && BreakerState.Of(b.State) != BreakerState.Identified) continue;

            var named = !string.IsNullOrWhiteSpace(b.Node);
            var id = named ? b.Node.Trim() : IdFor(chain.Panel.Id, b.Number);
            var label = !string.IsNullOrWhiteSpace(b.Description) ? b.Description.Trim()
                : $"{(string.IsNullOrWhiteSpace(chain.Panel.Name) ? chain.Panel.Id : chain.Panel.Name)} {b.Number}";
            out_.Add(new BreakerNode(id, label, chain.Panel.Node ?? "", channels, chain, !named));
        }
        return out_;
    }

    /// <summary>The channels a breaker's power is read from: one clamp measuring the whole circuit, else every leg.</summary>
    public static IReadOnlyList<string> Channels(BreakerChain chain)
    {
        var legs = chain.Legs.Any(l => l.Clamp?.Whole == true) ? chain.Legs.Where(l => l.Clamp?.Whole == true) : chain.Legs;
        return [.. legs.Select(l => l.Channel).Where(c => !string.IsNullOrWhiteSpace(c)).Select(c => c!).Distinct(StringComparer.OrdinalIgnoreCase)];
    }
}

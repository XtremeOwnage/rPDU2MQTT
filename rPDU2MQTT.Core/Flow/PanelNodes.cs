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
    /// The node that <em>is</em> this breaker: the one it names, else the single channel measuring it — a tier
    /// above one channel would carry that channel's reading twice, under two names — else a node of its own,
    /// which is what a double-pole breaker on two channels, and a breaker nothing measures, need.
    /// </summary>
    /// <param name="known">The node ids the config has, so a channel nothing answers to is not adopted as the breaker.</param>
    public static string NodeIdFor(BreakerChain chain, ISet<string>? known = null)
    {
        if (!string.IsNullOrWhiteSpace(chain.Breaker.Node)) return chain.Breaker.Node.Trim();
        var channels = Channels(chain);
        if (channels.Count == 1 && (known is null || known.Contains(channels[0]))) return channels[0];
        return IdFor(chain.Panel.Id, chain.Breaker.Number);
    }

    /// <summary>The node ids a config holds, for deciding whether a breaker's channel is one of them.</summary>
    public static HashSet<string> NodeIds(EnergyFlowConfig? flow) =>
        new((flow?.Nodes ?? []).Select(n => n.Id).Where(id => !string.IsNullOrWhiteSpace(id)), StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Every breaker that belongs on the graph: one that something measures, and one someone has identified,
    /// which appears with no value rather than a zero. An unused slot is not a tier.
    /// </summary>
    /// <param name="known">
    /// Every node the graph has, so a breaker measured by one of them is that node rather than a tier above it.
    /// The config's own nodes are used when the caller does not say.
    /// </param>
    public static IReadOnlyList<BreakerNode> For(EnergyFlowConfig? flow, ISet<string>? known = null)
    {
        var f = flow ?? new EnergyFlowConfig();
        var map = PanelMap.For(f);
        known ??= NodeIds(f);
        var out_ = new List<BreakerNode>();
        foreach (var chain in map.Chains)
        {
            var b = chain.Breaker;
            if (string.IsNullOrWhiteSpace(b.Number)) continue;
            if (BreakerState.Of(b.State) == BreakerState.Unused) continue;
            var channels = Channels(chain);
            if (channels.Count == 0 && BreakerState.Of(b.State) != BreakerState.Identified) continue;

            var id = NodeIdFor(chain, known);
            // Derived only when the node is the breaker itself: a breaker that names a node, or that is the one
            // channel measuring it, is a node the config already has.
            var derived = string.Equals(id, IdFor(chain.Panel.Id, b.Number), StringComparison.OrdinalIgnoreCase)
                && string.IsNullOrWhiteSpace(b.Node);
            var label = !string.IsNullOrWhiteSpace(b.Description) ? b.Description.Trim()
                : $"{(string.IsNullOrWhiteSpace(chain.Panel.Name) ? chain.Panel.Id : chain.Panel.Name)} {b.Number}";
            out_.Add(new BreakerNode(id, label, chain.Panel.Node ?? "", channels, chain, derived));
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

using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>Something the panel mapping says that cannot all be true, or that the live readings contradict (#457).</summary>
/// <param name="Kind">What was found, for the page to group and style by.</param>
/// <param name="Breakers">The breakers involved, as "panel/number".</param>
public sealed record PanelFinding(string Kind, string Severity, string Message, IReadOnlyList<string> Breakers, IReadOnlyList<string> Channels);

/// <summary>
/// Checks the panel mapping against itself and against what the channels are reading (#457). Every finding is a
/// report naming what is involved; nothing here changes the mapping.
/// </summary>
public static class PanelAudit
{
    public const string ChannelShared = "channel-shared";
    public const string ChannelUnmapped = "channel-unmapped";
    public const string UnusedLive = "unused-live";
    public const string HalfClamped = "half-clamped";
    public const string OverRating = "over-rating";

    /// <summary>Power below this, in watts, is noise rather than a circuit drawing something.</summary>
    public const double Floor = 5;

    /// <param name="channels">Node ids that could be monitor channels, so one drawing power with no breaker can be named.</param>
    public static IReadOnlyList<PanelFinding> Check(EnergyFlowConfig? flow, IFlowValueSource? live, IEnumerable<string>? channels = null,
        string metric = FlowGraphBuilder.DefaultMetric)
    {
        var f = flow ?? new EnergyFlowConfig();
        var map = PanelMap.For(f);
        var found = new List<PanelFinding>();
        var ids = StringComparer.OrdinalIgnoreCase;
        string Ref(BreakerChain c) => Circuits.RefOf(c);
        double? Read(string node, string m = "") => live is not null && live.TryGetValue(node, string.IsNullOrEmpty(m) ? metric : m, out var v) ? v : null;

        // One channel measuring two breakers: at most one of them is right, and both are reporting its power.
        var byChannel = new Dictionary<string, List<BreakerChain>>(ids);
        foreach (var chain in map.Chains)
            foreach (var ch in PanelNodes.Channels(chain))
            {
                if (!byChannel.TryGetValue(ch, out var list)) byChannel[ch] = list = new();
                list.Add(chain);
            }
        foreach (var (ch, chains) in byChannel.Where(x => x.Value.Count > 1))
            found.Add(new PanelFinding(ChannelShared, "bad",
                $"{ch} is mapped to {chains.Count} breakers: {string.Join(", ", chains.Select(Ref))}. Only one of them is measured by it; the others report power that is not theirs.",
                [.. chains.Select(Ref)], [ch]));

        foreach (var chain in map.Chains)
        {
            var b = chain.Breaker;
            var state = BreakerState.Of(b.State);
            var chans = PanelNodes.Channels(chain);

            // A breaker written off as unused, with its channel drawing power.
            if (state == BreakerState.Unused)
                foreach (var ch in chans)
                    if (Read(ch) is { } w && w > Floor)
                        found.Add(new PanelFinding(UnusedLive, "warn",
                            $"{Ref(chain)} is marked unused, but {ch} is drawing {Math.Round(w)} W. Either it feeds something after all, or the clamp is on another circuit.",
                            [Ref(chain)], [ch]));

            // Half of a 240 V circuit is not the circuit: one clamp on a two-pole breaker leaves its power unknown.
            if (Math.Max(1, b.Poles) == 2 && !chain.Legs.Any(l => l.Clamp?.Whole == true) && chain.Legs.Count(l => l.Channel is not null) == 1)
                found.Add(new PanelFinding(HalfClamped, "warn",
                    $"{Ref(chain)} is a double-pole breaker with only one leg measured, so its power stays unknown. Clamp the other leg, or tick “one CT measures the whole circuit”.",
                    [Ref(chain)], [.. chans]));

            // More current than the breaker is rated for: the mapping, the clamp's rating, or the circuit is wrong.
            if (b.Amps is > 0 && PanelMap.Power(chain, live, "current", out var gap) is { } amps && gap == PowerGap.None && amps > b.Amps.Value)
                found.Add(new PanelFinding(OverRating, "bad",
                    $"{Ref(chain)} reads {Math.Round(amps, 1)} A on a {b.Amps} A breaker. A breaker over its rating trips; check that the clamp is on the right wire and its rating is right.",
                    [Ref(chain)], [.. chans]));
        }

        // A channel drawing power that no breaker claims: something is metered that the directory does not know about.
        var mapped = new HashSet<string>(byChannel.Keys, ids);
        var panelNodes = new HashSet<string>(f.Panels.Select(p => p.Node).Where(x => !string.IsNullOrWhiteSpace(x))!, ids);
        foreach (var node in (channels ?? []).Distinct(ids))
        {
            if (mapped.Contains(node) || panelNodes.Contains(node)) continue;
            if (Read(node) is not { } w || w <= Floor) continue;
            found.Add(new PanelFinding(ChannelUnmapped, "warn",
                $"{node} is drawing {Math.Round(w)} W and no breaker is mapped to it. Map it to the breaker it measures, so its power is counted as a circuit.",
                [], [node]));
        }
        return found;
    }
}

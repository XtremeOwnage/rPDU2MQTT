using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Current worked out from power and voltage, for a meter that reports watts and volts but no amps.
///
/// <para>
/// I = P ÷ V. Both readings must be present and fresh, and the voltage must be non-zero: a derived amperage
/// is only as true as the two figures behind it, and dividing by a missing volt reading would put a number
/// on the diagram that no meter ever measured.
/// </para>
/// </summary>
public static class DerivedCurrent
{
    /// <summary>The source type that means "work this out rather than read it".</summary>
    public const string SourceType = "derived";

    /// <summary>The only metric that can be derived today. Anything else asked for is a configuration mistake.</summary>
    public const string Metric = "current";

    public static bool IsDerived(EnergyFlowSource s)
        => string.Equals(s.Type, SourceType, StringComparison.OrdinalIgnoreCase);

    /// <summary>Node ids that ask for their current to be worked out, with the direction each one wants.</summary>
    public static IReadOnlyList<string> Keys(EnergyFlowConfig? flow)
        => (flow?.Nodes ?? new List<EnergyFlowNode>())
            .Where(n => !string.IsNullOrEmpty(n.Id))
            .SelectMany(n => (n.Sources ?? new List<EnergyFlowSource>())
                .Where(s => IsDerived(s) && string.Equals(s.Metric, Metric, StringComparison.OrdinalIgnoreCase))
                .Select(s => n.Id + '|' + FlowMetricKey.For(Metric, s.Direction)))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    /// <summary>
    /// What is wrong with the derived bindings, in the operator's terms. Empty when there is nothing to say.
    ///
    /// <para>
    /// A derived current is the only binding on the page that depends on OTHER bindings, so it is the only
    /// one that can be complete in itself and still produce nothing. Saying so at the point it is written
    /// beats a node that silently shows no amps.
    /// </para>
    /// </summary>
    public static IReadOnlyList<(string NodeId, string Message)> Problems(EnergyFlowConfig? flow)
    {
        var problems = new List<(string, string)>();
        foreach (var node in flow?.Nodes ?? new List<EnergyFlowNode>())
        {
            var sources = node.Sources ?? new List<EnergyFlowSource>();
            foreach (var derived in sources.Where(IsDerived))
            {
                if (!string.Equals(derived.Metric, Metric, StringComparison.OrdinalIgnoreCase))
                {
                    problems.Add((node.Id, $"'{derived.Metric}' cannot be worked out from the other readings — only current can (power ÷ voltage)."));
                    continue;
                }

                var missing = new List<string>();
                if (!Binds(sources, FlowGraphBuilder.DefaultMetric)) missing.Add("power");
                if (!Binds(sources, "voltage")) missing.Add("voltage");
                if (missing.Count > 0)
                    problems.Add((node.Id,
                        $"Current is set to be worked out as power ÷ voltage, but this node has no {string.Join(" and no ", missing)} "
                      + "binding. Bind both, or read the current from the device directly."));
            }
        }
        return problems;
    }

    private static bool Binds(IEnumerable<EnergyFlowSource> sources, string metric)
        => sources.Any(s => !IsDerived(s) && string.Equals(s.Metric, metric, StringComparison.OrdinalIgnoreCase));
}

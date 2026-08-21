using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// One product relation between three metrics: <c>Product = Left × Right</c>. Any one of the three follows
/// from the other two, which is what makes a meter that reports any pair able to report the third.
/// </summary>
/// <param name="Assumes">
/// What has to be true for this to hold, or null when it always does. Stated rather than hidden: a relation
/// that is exact for a DC string and approximate for an AC feeder must not read the same in both places.
/// </param>
public sealed record MetricRelation(string Product, string Left, string Right, string? Assumes = null);

/// <summary>
/// Values worked out from a node's other readings, for a meter that reports some of what it measures.
///
/// <para>
/// The relations are the electrical ones and nothing more is invented from them. <c>S = V × I</c> is exact
/// for a single phase; <c>P = S × PF</c> is exact; <c>P = V × I</c> holds only at a power factor of 1 (a DC
/// string, a resistive load), so it is the last one tried and says so wherever it is used.
/// </para>
/// <para>
/// Operands may themselves be derived — current from real power, voltage and power factor resolves as
/// <c>I = (P ÷ PF) ÷ V</c>, which is the exact answer rather than the unity-power-factor one. Nothing is
/// derived from itself: a relation whose operands lead back to what is being asked for is not used.
/// </para>
/// </summary>
public static class DerivedMetrics
{
    /// <summary>The source type that means "work this out rather than read it".</summary>
    public const string SourceType = "derived";

    /// <summary>Exact relations first: an approximation is only reached for when nothing else fits.</summary>
    public static readonly MetricRelation[] Relations =
    [
        new("apparentpower", "voltage", "current"),
        new("realpower", "apparentpower", "powerfactor"),
        new("realpower", "voltage", "current", "a power factor of 1"),
    ];

    /// <summary>Every metric that can be worked out at all.</summary>
    public static readonly string[] Derivable =
        Relations.SelectMany(r => new[] { r.Product, r.Left, r.Right }).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

    public static bool IsDerived(EnergyFlowSource s)
        => string.Equals(s.Type, SourceType, StringComparison.OrdinalIgnoreCase);

    /// <summary>One way to work a metric out: <c>A × B</c> or <c>A ÷ B</c>, and what that assumes.</summary>
    public sealed record Option(string A, string B, bool Multiply, string? Assumes)
    {
        /// <summary>The sum as it reads, e.g. "apparent power ÷ voltage".</summary>
        public string Label => $"{Name(A)} {(Multiply ? "×" : "÷")} {Name(B)}";
    }

    /// <summary>The ways any one metric can be worked out, in the order they are tried.</summary>
    public static IEnumerable<Option> PairsFor(string metric)
    {
        foreach (var r in Relations)
        {
            // Asked for the product it is a multiplication; asked for either factor it is a division by
            // the other one.
            if (Same(metric, r.Product)) yield return new Option(r.Left, r.Right, true, r.Assumes);
            else if (Same(metric, r.Left)) yield return new Option(r.Product, r.Right, false, r.Assumes);
            else if (Same(metric, r.Right)) yield return new Option(r.Product, r.Left, false, r.Assumes);
        }
    }

    /// <summary>
    /// Work <paramref name="metric"/> out from what <paramref name="read"/> can supply. Returns the reason
    /// it could not, or null on success. <paramref name="assumes"/> carries the caveat of the relation used.
    /// </summary>
    public static string? Derive(string metric, Func<string, double?> read, out double value, out string? assumes)
        => Derive(metric, read, new HashSet<string>(StringComparer.OrdinalIgnoreCase), out value, out assumes);

    private static string? Derive(string metric, Func<string, double?> read, HashSet<string> visiting,
                                  out double value, out string? assumes)
    {
        value = 0;
        assumes = null;
        if (!visiting.Add(metric)) return $"{Name(metric)} would have to be worked out from itself";

        try
        {
            // Two kinds of "no": a reading that is not there, and readings that are there but cannot be
            // used. The second is the more useful thing to say — it names something the operator can see —
            // so it wins whichever relation raised it.
            string? missing = null, unusable = null;
            foreach (var r in Relations)
            {
                // Which side of the relation is being asked for decides whether this is a product or a
                // quotient — and a quotient has a divisor that must not be zero.
                var (need1, need2, multiply) =
                    Same(metric, r.Product) ? (r.Left, r.Right, true)
                    : Same(metric, r.Left) ? (r.Product, r.Right, false)
                    : Same(metric, r.Right) ? (r.Product, r.Left, false)
                    : (null, null, false);
                if (need1 is null || need2 is null) continue;

                var a = Resolve(need1, read, visiting, out var aAssumes);
                if (a is null) { missing ??= $"no {Name(need1)} reading"; continue; }
                var b = Resolve(need2, read, visiting, out var bAssumes);
                if (b is null) { missing ??= $"no {Name(need2)} reading"; continue; }

                if (!multiply && b.Value == 0) { unusable ??= $"the {Name(need2)} reading is 0"; continue; }

                value = multiply ? a.Value * b.Value : a.Value / b.Value;
                assumes = r.Assumes ?? aAssumes ?? bAssumes;
                return null;
            }
            return unusable ?? missing ?? $"{Name(metric)} cannot be worked out from the other readings";
        }
        finally { visiting.Remove(metric); }
    }

    /// <summary>A reading if there is one, else the same arithmetic applied to that operand.</summary>
    private static double? Resolve(string metric, Func<string, double?> read, HashSet<string> visiting, out string? assumes)
    {
        assumes = null;
        if (read(metric) is { } measured) return measured;
        return Derive(metric, read, visiting, out var v, out assumes) is null ? v : null;
    }

    /// <summary>Node ids and metric keys that ask to be worked out.</summary>
    public static IReadOnlyList<string> Keys(EnergyFlowConfig? flow)
        => (flow?.Nodes ?? new List<EnergyFlowNode>())
            .Where(n => !string.IsNullOrEmpty(n.Id))
            .SelectMany(n => n.AllSources()
                .Where(IsDerived)
                .Select(s => n.Id + '|' + FlowMetricKey.For(s.Metric ?? "", s.Direction)))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    /// <summary>
    /// Does this node ask for this exact metric key to be worked out? Read from the config every time
    /// rather than snapshotted: EnergyFlow is applied live, so a binding added in the GUI has to work when
    /// it is saved — not after a restart, which is the one thing the panel promises it will not need.
    /// </summary>
    public static bool AsksFor(EnergyFlowConfig? flow, string nodeId, string metricKey)
    {
        foreach (var node in flow?.Nodes ?? new List<EnergyFlowNode>())
        {
            if (!string.Equals(node.Id, nodeId, StringComparison.OrdinalIgnoreCase)) continue;
            foreach (var s in node.AllSources())
                if (IsDerived(s) && string.Equals(FlowMetricKey.For(s.Metric ?? "", s.Direction), metricKey, StringComparison.OrdinalIgnoreCase))
                    return true;
            return false;   // node ids are unique; no other entry can answer for it
        }
        return false;
    }

    /// <summary>
    /// What is wrong with the derived bindings, in the operator's terms. Empty when there is nothing to say.
    ///
    /// <para>
    /// A derived binding is the only one that depends on OTHER bindings, so it is the only one that can be
    /// complete in itself and still produce nothing. Saying so where it is written beats a node that
    /// silently shows nothing.
    /// </para>
    /// </summary>
    public static IReadOnlyList<(string NodeId, string Message)> Problems(EnergyFlowConfig? flow)
    {
        var problems = new List<(string, string)>();
        foreach (var node in flow?.Nodes ?? new List<EnergyFlowNode>())
        {
            var sources = node.AllSources().ToList();
            foreach (var derived in sources.Where(IsDerived))
            {
                var metric = derived.Metric ?? "";
                if (!Derivable.Contains(metric, StringComparer.OrdinalIgnoreCase))
                {
                    problems.Add((node.Id, $"'{Name(metric)}' cannot be worked out from the other readings. "
                        + $"These can: {string.Join(", ", Derivable.Select(Name))}."));
                    continue;
                }

                bool Bound(string m) => sources.Any(s => !IsDerived(s) && string.Equals(s.Metric, m, StringComparison.OrdinalIgnoreCase));
                if (!CanSatisfy(metric, Bound, new HashSet<string>(StringComparer.OrdinalIgnoreCase)))
                    problems.Add((node.Id,
                        $"{Name(metric)} has nothing to be worked out from. Bind "
                      + string.Join(", or ", PairsFor(metric).Select(p => $"{Name(p.A)} and {Name(p.B)}"))
                      + " on this node."));
            }
        }
        return problems;
    }

    /// <summary>Could this be worked out at all from what is bound here, however many steps it takes?</summary>
    private static bool CanSatisfy(string metric, Func<string, bool> bound, HashSet<string> visiting)
    {
        if (bound(metric)) return true;
        if (!visiting.Add(metric)) return false;
        try
        {
            foreach (var o in PairsFor(metric))
                if (CanSatisfy(o.A, bound, visiting) && CanSatisfy(o.B, bound, visiting)) return true;
            return false;
        }
        finally { visiting.Remove(metric); }
    }

    /// <summary>The metric's name in the words the GUI and the messages use.</summary>
    public static string Name(string metric) => metric.ToLowerInvariant() switch
    {
        "realpower" => "power",
        "apparentpower" => "apparent power",
        "powerfactor" => "power factor",
        var other => other,
    };

    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
}

using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Wraps the live values and works out the ones a meter does not report — today, current from power and
/// voltage (<see cref="DerivedCurrent"/>).
///
/// <para>
/// It wraps rather than sits inside the composite because the two readings it divides may come from any
/// ingest: the power over MQTT, the voltage from Modbus. Asked for a metric, it answers with a real reading
/// whenever there is one — a device that reports amps is always believed over arithmetic about amps.
/// </para>
/// </summary>
public sealed class DerivedFlowValueSource : IFlowValueSource, IWithheldSources, IFlowValueDiagnostics, IPeriodTotalsReady
{
    private readonly IFlowValueSource inner;
    private readonly EnergyFlowConfig? flow;
    private readonly HashSet<string> derived;

    public DerivedFlowValueSource(IFlowValueSource inner, EnergyFlowConfig? flow)
    {
        this.inner = inner;
        this.flow = flow;
        derived = new HashSet<string>(DerivedCurrent.Keys(flow), StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Whether anything at all is configured to be worked out; false means this is pass-through.</summary>
    public bool Any => derived.Count > 0;

    public bool TryGetValue(string nodeId, string metric, out double value)
    {
        // A measured reading always wins: arithmetic about amps is not better than an ammeter.
        if (inner.TryGetValue(nodeId, metric, out value)) return true;

        value = 0;
        if (derived.Count == 0 || !derived.Contains(nodeId + '|' + metric)) return false;
        return Compute(nodeId, metric, out value) is null;
    }

    /// <summary>The reason this cannot be worked out, or null when <paramref name="value"/> is good.</summary>
    private string? Compute(string nodeId, string metric, out double value)
    {
        value = 0;
        // current#in is worked out from the power flowing that same way; voltage has no direction — the
        // bus is at one voltage whichever way the power is going through it.
        var suffix = metric.EndsWith(FlowMetricKey.InSuffix, StringComparison.Ordinal) ? FlowMetricKey.InSuffix : "";
        if (!inner.TryGetValue(nodeId, FlowGraphBuilder.DefaultMetric + suffix, out var watts))
            return $"no power reading{(suffix.Length > 0 ? " for that direction" : "")}";
        if (!inner.TryGetValue(nodeId, "voltage", out var volts))
            return "no voltage reading";
        if (volts == 0)
            return "the voltage reading is 0";

        value = watts / volts;
        return null;
    }

    /// <summary>
    /// Everything the sources behind this are withholding, plus every derived value that cannot be worked
    /// out right now and why. A node configured to derive its current and showing nothing has a reason,
    /// and the reason is the whole point of asking for it.
    /// </summary>
    public IReadOnlyCollection<WithheldSource> Withheld
    {
        get
        {
            var list = new List<WithheldSource>((inner as IWithheldSources)?.Withheld ?? Array.Empty<WithheldSource>());
            foreach (var key in derived)
            {
                var split = key.Split('|');
                if (split.Length != 2) continue;
                if (inner.TryGetValue(split[0], split[1], out _)) continue;   // a real reading arrived
                if (Compute(split[0], split[1], out _) is { } why)
                    list.Add(new WithheldSource(split[0], DerivedCurrent.SourceType, split[1],
                        $"Current is worked out as power ÷ voltage, and {why}. Nothing is shown rather than a "
                      + "figure that is not what it claims."));
            }
            return list;
        }
    }

    public bool TryDescribe(string nodeId, string metric, out FlowReading reading)
        => (inner as IFlowValueDiagnostics)?.TryDescribe(nodeId, metric, out reading) ?? Empty(out reading);

    public IReadOnlyCollection<(string Node, string Metric)> ReportedKeys
        => (inner as IFlowValueDiagnostics)?.ReportedKeys ?? Array.Empty<(string, string)>();

    public bool PeriodTotalsReady => (inner as IPeriodTotalsReady)?.PeriodTotalsReady ?? true;

    private static bool Empty(out FlowReading reading) { reading = default; return false; }
}

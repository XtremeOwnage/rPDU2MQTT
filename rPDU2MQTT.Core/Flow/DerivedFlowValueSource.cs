using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Wraps the live values and works out the ones a meter does not report, from the ones it does
/// (<see cref="DerivedMetrics"/>).
///
/// <para>
/// It wraps rather than sits inside the composite because the readings it combines may come from any
/// ingest: the power over MQTT, the voltage from Modbus. Asked for a metric, it answers with a real reading
/// whenever there is one — a device that reports amps is always believed over arithmetic about amps.
/// </para>
/// </summary>
public sealed class DerivedFlowValueSource : IFlowValueSource, IWithheldSources, IFlowValueDiagnostics, IPeriodTotalsReady, IPeriodTotalsOrigin
{
    private readonly IFlowValueSource inner;
    private readonly Config? cfg;

    public DerivedFlowValueSource(IFlowValueSource inner, Config? cfg)
    {
        this.inner = inner;
        this.cfg = cfg;
    }

    /// <summary>
    /// The hierarchy as it is now. Held as the root <see cref="Config"/>, never as the
    /// <see cref="EnergyFlowConfig"/> inside it: saving from the GUI and reloading the CR both REPLACE that
    /// object (<c>config.EnergyFlow = reloaded.EnergyFlow</c>), so a reference taken at startup goes stale
    /// on the first save and every calculated binding silently stops resolving until a restart.
    /// </summary>
    private EnergyFlowConfig? Flow => cfg?.EnergyFlow;

    public bool TryGetValue(string nodeId, string metric, out double value)
    {
        // A measured reading always wins: arithmetic about amps is not better than an ammeter.
        if (inner.TryGetValue(nodeId, metric, out value)) return true;

        value = 0;
        // Asked of the config each time, not of a set built at startup: EnergyFlow applies live.
        if (!DerivedMetrics.AsksFor(Flow, nodeId, metric)) return false;
        return Compute(nodeId, metric, out value, out _) is null;
    }

    /// <summary>The reason this cannot be worked out, or null when <paramref name="value"/> is good.</summary>
    private string? Compute(string nodeId, string metricKey, out double value, out string? assumes)
    {
        // A metric that flows keeps the direction it was asked for; one that is a condition at a point —
        // voltage, power factor — has no direction, because the bus is at one voltage whichever way the
        // power is moving through it.
        var suffix = metricKey.EndsWith(FlowMetricKey.InSuffix, StringComparison.Ordinal) ? FlowMetricKey.InSuffix : "";
        var bare = suffix.Length > 0 ? metricKey[..^suffix.Length] : metricKey;

        double? Read(string metric)
        {
            var key = metric + (FlowUnits.IsAdditive(metric) ? suffix : "");
            return inner.TryGetValue(nodeId, key, out var v) ? v : null;
        }

        return DerivedMetrics.Derive(bare, Read, out value, out assumes);
    }

    /// <summary>
    /// Everything the sources behind this are withholding, plus every derived value that cannot be worked
    /// out right now and why. A node configured to work out its current and showing nothing has a reason,
    /// and the reason is the whole point of asking for it.
    /// </summary>
    public IReadOnlyCollection<WithheldSource> Withheld
    {
        get
        {
            var list = new List<WithheldSource>((inner as IWithheldSources)?.Withheld ?? Array.Empty<WithheldSource>());
            foreach (var key in DerivedMetrics.Keys(Flow))
            {
                var split = key.Split('|');
                if (split.Length != 2) continue;
                if (inner.TryGetValue(split[0], split[1], out _)) continue;   // a real reading arrived
                if (Compute(split[0], split[1], out _, out _) is { } why)
                    list.Add(new WithheldSource(split[0], DerivedMetrics.SourceType, split[1],
                        $"{DerivedMetrics.Name(split[1])} is worked out from this node's other readings, and {why}. "
                      + "Nothing is shown rather than a figure that is not what it claims."));
            }
            return list;
        }
    }

    public bool TryDescribe(string nodeId, string metric, out FlowReading reading)
        => (inner as IFlowValueDiagnostics)?.TryDescribe(nodeId, metric, out reading) ?? Empty(out reading);

    public IReadOnlyCollection<(string Node, string Metric)> ReportedKeys
        => (inner as IFlowValueDiagnostics)?.ReportedKeys ?? Array.Empty<(string, string)>();

    public bool PeriodTotalsReady => (inner as IPeriodTotalsReady)?.PeriodTotalsReady ?? true;

    public int CarriedOverNodes => (inner as IPeriodTotalsOrigin)?.CarriedOverNodes ?? 0;
    public DateTime AccumulatingSinceUtc => (inner as IPeriodTotalsOrigin)?.AccumulatingSinceUtc ?? DateTime.UtcNow;
    public string StoreKind => (inner as IPeriodTotalsOrigin)?.StoreKind ?? "memory";

    private static bool Empty(out FlowReading reading) { reading = default; return false; }
}

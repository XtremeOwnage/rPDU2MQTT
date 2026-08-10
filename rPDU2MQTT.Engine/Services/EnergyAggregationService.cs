using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Services;

/// <summary>
/// Derives energy (kWh) from the power readings already being collected, for nodes that report power but
/// no cumulative energy — a CT clamp, an inverter's live wattage.
///
/// </summary>
public sealed class EnergyAggregationService : BackgroundService, IFlowValueSource, Core.Flow.IPeriodTotalsReady
{
    private const string PowerMetric = "realpower";
    private const string EnergyMetric = "energy";

    private readonly Config cfg;
    private readonly IFlowValueSource upstream;
    private readonly IEnergyStore store;
    private readonly Core.ISnapshotCache? snapshots;
    private readonly TimeZoneInfo zone;
    private volatile Dictionary<string, EnergyState> states = new(StringComparer.OrdinalIgnoreCase);

    public EnergyAggregationService(Config cfg, IFlowValueSource upstream, IEnergyStore store, Core.ISnapshotCache? snapshots = null)
    {
        this.cfg = cfg;
        this.upstream = upstream;
        this.store = store;
        this.snapshots = snapshots;
        zone = EnergyPeriod.Resolve(cfg.EnergyFlow.Aggregation.PeriodTimeZone, m => Log.Warning(m));
    }

    private bool Integrating => cfg.EnergyFlow.Aggregation.Enabled;
    private bool Periods => cfg.EnergyFlow.Aggregation.TrackPeriods;

    private static readonly string EnergyInMetric = FlowMetricKey.For(EnergyMetric, "in");
    private static readonly string PeriodInMetric = FlowMetricKey.For(EnergyPeriod.Metric, "in");

    /// <summary>The measurement a PDU reports its own cumulative energy under.</summary>
    private string OutletEnergyMetric
        => string.IsNullOrWhiteSpace(cfg.HASS.EnergyDashboard.EnergyMeasurementType)
            ? EnergyMetric
            : cfg.HASS.EnergyDashboard.EnergyMeasurementType;

    /// <summary>
    /// The derived total for a node, if one has been accumulated. Only once a sample has actually been
    /// taken — reporting 0 for a node that has never been measured would be a claim, not a gap.
    ///
    /// </summary>
    public bool TryGetValue(string nodeId, string metric, out double value)
    {
        value = 0;

        // The return lane (battery charge / grid export) is a counter in its own right and is accumulated
        var key = nodeId;
        if (string.Equals(metric, PeriodInMetric, StringComparison.OrdinalIgnoreCase))
        {
            key = nodeId + FlowMetricKey.InSuffix;
            metric = EnergyPeriod.Metric;
        }

        var period = string.Equals(metric, EnergyPeriod.Metric, StringComparison.OrdinalIgnoreCase);
        if (!period && !string.Equals(metric, EnergyMetric, StringComparison.OrdinalIgnoreCase))
            return false;
        if (period ? !Periods : !Integrating)
            return false;

        if (!states.TryGetValue(key, out var s) || s.LastSampleUtc == default)
            return false;

        // A period total is only meaningful once its baseline was captured; a state carried over from a
        if (period && s.PeriodKey is null)
            return false;

        // KWh on a counter-observed state is OUR re-based total, deliberately starting at zero the moment we
        if (!period && s.LastCounterKWh is not null)
            return false;

        value = period ? s.PeriodKWh : s.KWh;
        return true;
    }

    /// <summary>
    /// Continue from wherever the last run got to. Separate from ExecuteAsync so the carry-over — the
    /// whole reason the store exists — can be asserted directly; testing it by starting the service and
    /// waiting for a timer was timing-dependent, and duly failed on a slower machine.
    /// </summary>
    public int LoadTotals()
    {
        states = new Dictionary<string, EnergyState>(store.Load(), StringComparer.OrdinalIgnoreCase);
        loaded = true;
        return states.Count;
    }

    /// <summary>
    /// Whether the carried-over totals are in yet. Until they are, every daily figure derived from them is
    /// unworked-out rather than zero — see <see cref="Core.Flow.IPeriodTotalsReady"/>.
    /// </summary>
    public bool PeriodTotalsReady => !Periods || loaded;
    private volatile bool loaded;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var agg = cfg.EnergyFlow.Aggregation;
        var carried = LoadTotals();
        Log.Information($"Energy aggregation: sampling power every {agg.SampleIntervalSeconds}s "
                      + $"(gaps over {agg.MaxGapSeconds}s are not counted); carried over {carried} node total(s).");
        if (Periods)
        {
            var hour = agg.PeriodStartHour is >= 0 and <= 23 ? agg.PeriodStartHour : 0;
            Log.Information($"Energy periods: daily totals roll over at {hour:00}:00 {zone.Id} "
                          + $"(next {EnergyPeriod.NextRollover(DateTime.UtcNow, zone, hour):yyyy-MM-dd HH:mm} UTC), so every "
                          + "node's figure covers the same window and the flow roll-up adds up.");
        }

        var maxGap = TimeSpan.FromSeconds(Math.Max(1, agg.MaxGapSeconds));
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(1, agg.SampleIntervalSeconds)));
        try
        {
            do
            {
                try { Sample(maxGap); }
                catch (Exception ex) { Log.Warning($"Energy aggregation pass failed: {ex.Message}"); }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
        finally
        {
            // A clean stop is the one chance to record the last few samples; losing them silently would
            try { store.Save(states); } catch (Exception ex) { Log.Warning($"Could not persist energy totals on shutdown: {ex.Message}"); }
        }
    }

    /// <summary>One pass: integrate node power, and fold in every outlet's own counter. Internal so a test
    /// can drive it a tick at a time against a fixed clock instead of waiting on the timer.</summary>
    internal void Sample(TimeSpan maxGap) => Sample(maxGap, DateTime.UtcNow);

    internal void Sample(TimeSpan maxGap, DateTime now)
    {
        var next = new Dictionary<string, EnergyState>(states, StringComparer.OrdinalIgnoreCase);
        var periodKey = Periods ? EnergyPeriod.KeyFor(now, zone, cfg.EnergyFlow.Aggregation.PeriodStartHour) : null;
        var sampled = 0;

        static EnergyState Prev(Dictionary<string, EnergyState> d, string k) => d.TryGetValue(k, out var s) ? s : EnergyState.Empty;

        foreach (var node in cfg.EnergyFlow.Nodes)
        {
            var id = node.Id?.Trim();
            if (string.IsNullOrEmpty(id)) continue;

            // A node bound to a real cumulative energy source is re-based exactly as an outlet is: its face
            if (Periods && upstream.TryGetValue(id, EnergyMetric, out var counter))
            {
                next[id] = EnergyIntegrator.Observe(Prev(next, id), counter, now, periodKey);
                sampled++;
            }
            // Nothing meters this node's energy, so derive it from power — but only when asked to, because
            else if (Integrating && upstream.TryGetValue(id, PowerMetric, out var watts))
            {
                next[id] = EnergyIntegrator.Accumulate(Prev(next, id), watts, now, maxGap, periodKey);
                sampled++;
            }

            // The return lane — a battery being charged, a grid being exported to — is a separate counter
            if (Periods && upstream.TryGetValue(id, EnergyInMetric, out var inCounter))
            {
                var inId = id + FlowMetricKey.InSuffix;
                next[inId] = EnergyIntegrator.Observe(Prev(next, inId), inCounter, now, periodKey);
                sampled++;

                // Now that both energy directions are known for this node, check the power source's sign
                AuditDirection(id, next, now);
            }
        }

        sampled += SampleOutlets(next, periodKey, now);

        states = next;
        if (sampled > 0) store.Save(next);
    }

    // Warned nodes, so a contradiction that persists is said once rather than every sampling pass.
    private readonly HashSet<string> warnedDirection = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Where each node's counters stood at the start of the current comparison window.
    ///
    /// </summary>
    private readonly Dictionary<string, (DateTime At, double Out, double In)> directionWindow = new(StringComparer.OrdinalIgnoreCase);

    // Long enough that a coarse counter (often 0.1 kWh resolution) has actually moved, short enough that the
    private static readonly TimeSpan DirectionWindow = TimeSpan.FromMinutes(10);

    private void AuditDirection(string id, Dictionary<string, EnergyState> next, DateTime now)
    {
        var outNow = next.TryGetValue(id, out var o) ? o.KWh : 0;
        var inNow = next.TryGetValue(id + FlowMetricKey.InSuffix, out var i) ? i.KWh : 0;

        if (!directionWindow.TryGetValue(id, out var start))
        {
            directionWindow[id] = (now, outNow, inNow);
            return;
        }
        if (now - start.At < DirectionWindow) return;
        directionWindow[id] = (now, outNow, inNow);   // next window starts here either way

        if (!upstream.TryGetValue(id, PowerMetric, out var pOut)) return;
        upstream.TryGetValue(id, FlowMetricKey.For(PowerMetric, "in"), out var pIn);

        var outRise = Math.Max(0, outNow - start.Out);
        var inRise = Math.Max(0, inNow - start.In);

        if (!DirectionAudit.LooksInverted(pOut, pIn, outRise, inRise))
        {
            warnedDirection.Remove(id);   // it agrees again; a later contradiction is worth saying afresh
            return;
        }
        if (warnedDirection.Add(id))
            Log.Warning(DirectionAudit.Explain(id, pOut, pIn, outRise, inRise));
    }

    /// <summary>
    /// Fold each outlet's firmware counter into a total of our own, so its daily figure shares an epoch with
    /// every derived node's.
    ///
    /// </summary>
    private int SampleOutlets(Dictionary<string, EnergyState> next, string? periodKey, DateTime now)
    {
        if (!Periods || snapshots is null) return 0;

        var metric = OutletEnergyMetric;
        var sampled = 0;

        foreach (var snapshot in snapshots.All)
            foreach (var device in snapshot.Data.Devices)
                foreach (var outlet in device.Outlets)
                {
                    var m = outlet.Measurements.FirstOrDefault(x => string.Equals(x.Type, metric, StringComparison.OrdinalIgnoreCase));
                    if (m is null || !double.TryParse(m.Value, System.Globalization.NumberStyles.Any,
                            System.Globalization.CultureInfo.InvariantCulture, out var counter))
                        continue;

                    // Same id the flow graph builds for this outlet, so the value lands on the right node.
                    var id = $"outlet:{device.Entity_Name}:{outlet.Key}";
                    next[id] = EnergyIntegrator.Observe(
                        next.TryGetValue(id, out var prev) ? prev : EnergyState.Empty, counter, now, periodKey);
                    sampled++;

                }

        return sampled;
    }
}

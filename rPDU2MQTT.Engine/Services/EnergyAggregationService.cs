using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Services;

/// <summary>
/// Derives energy (kWh) from the power readings already being collected, for nodes that report power but
/// no cumulative energy — a CT clamp, an inverter's live wattage.
///
/// <para>
/// It samples <c>realpower</c> for every configured node on a timer, folds each reading into a running
/// total via <see cref="EnergyIntegrator"/>, and persists through <see cref="IEnergyStore"/> so a restart
/// continues the count rather than starting again — a counter that resets reads downstream as a meter
/// reset, and Home Assistant and EmonCMS correct their recorded history for it.
/// </para>
/// <para>
/// It is itself an <see cref="IFlowValueSource"/> for the <c>energy</c> metric, registered LAST in the
/// composite so that any node with a real energy binding uses that instead. A derived figure only ever
/// fills a gap; it never overrides a measurement.
/// </para>
/// <para>
/// It also maintains the <b>daily</b> total (<see cref="EnergyPeriod.Metric"/>) for every node <i>and every
/// PDU outlet</i>. Outlets are here because they are half the problem it solves: their kWh comes from
/// firmware and has been counting since the unit was commissioned, so putting it on the same diagram as a
/// figure we started deriving last month compares two different epochs and produces a chart that
/// contradicts its own arithmetic. Taking the rise of each counter since local midnight puts every node on
/// one epoch. That part is not an estimate and does not require <see cref="Config"/>'s aggregation to be
/// enabled — the rise of a metered counter is measured.
/// </para>
/// </summary>
public sealed class EnergyAggregationService : BackgroundService, IFlowValueSource
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
    /// <para>
    /// <c>energy</c> answers only when integration is on, because there it IS a derived estimate standing in
    /// for a missing meter. <see cref="EnergyPeriod.Metric"/> answers whenever periods are tracked, for
    /// outlets as well as nodes.
    /// </para>
    /// </summary>
    public bool TryGetValue(string nodeId, string metric, out double value)
    {
        value = 0;

        // The return lane (battery charge / grid export) is a counter in its own right and is accumulated
        // under its own key, so its daily total resolves the same way the supply direction's does.
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
        // build that predates period tracking has none until the next sample rolls it.
        if (period && s.PeriodKey is null)
            return false;

        // KWh on a counter-observed state is OUR re-based total, deliberately starting at zero the moment we
        // first saw the device — not the lifetime figure the device itself reports. Offering it as `energy`
        // would hand a consumer a number several thousand kWh below the meter it came from.
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
        return states.Count;
    }

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
            // show up later as a counter that jumped backwards.
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
            // value is measured from an epoch of its own — whenever that binding was configured, or whenever
            // the device it reads was commissioned — so only its rise is comparable to anything else here.
            // This is the case the daily total exists for; without it the inverter, grid and battery keep
            // their unrelated lifetime figures and the diagram goes on contradicting itself.
            if (Periods && upstream.TryGetValue(id, EnergyMetric, out var counter))
            {
                next[id] = EnergyIntegrator.Observe(Prev(next, id), counter, now, periodKey);
                sampled++;
            }
            // Nothing meters this node's energy, so derive it from power — but only when asked to, because
            // an integral of watts is an estimate in a way that the rise of a counter is not.
            // Only on a *fresh* power reading: TryGetValue already hides an expired one, and a stale value
            // must be treated as a gap rather than integrated as if it were current.
            else if (Integrating && upstream.TryGetValue(id, PowerMetric, out var watts))
            {
                next[id] = EnergyIntegrator.Accumulate(Prev(next, id), watts, now, maxGap, periodKey);
                sampled++;
            }

            // The return lane — a battery being charged, a grid being exported to — is a separate counter
            // measuring a separate quantity, so it gets a total of its own rather than netting off the
            // supply direction. Without this the daily diagram silently loses the charging/export lane that
            // the lifetime one draws.
            if (Periods && upstream.TryGetValue(id, EnergyInMetric, out var inCounter))
            {
                var inId = id + FlowMetricKey.InSuffix;
                next[inId] = EnergyIntegrator.Observe(Prev(next, inId), inCounter, now, periodKey);
                sampled++;
            }
        }

        sampled += SampleOutlets(next, periodKey, now);

        states = next;
        if (sampled > 0) store.Save(next);
    }

    /// <summary>
    /// Fold each outlet's firmware counter into a total of our own, so its daily figure shares an epoch with
    /// every derived node's.
    ///
    /// <para>
    /// Deliberately does not skip stale snapshots. A counter is not a power reading: if the PDU goes away for
    /// an hour and comes back, its counter has risen by the whole hour's energy, and taking the delta on the
    /// next reading counts every watt-hour of it. Integrating power across that gap could not — which is why
    /// a metered outlet gets this path and not the integrator.
    /// </para>
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

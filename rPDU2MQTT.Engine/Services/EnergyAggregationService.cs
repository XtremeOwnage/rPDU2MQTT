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
/// </summary>
public sealed class EnergyAggregationService : BackgroundService, IFlowValueSource
{
    private const string PowerMetric = "realpower";
    private const string EnergyMetric = "energy";

    private readonly Config cfg;
    private readonly IFlowValueSource upstream;
    private readonly IEnergyStore store;
    private volatile Dictionary<string, EnergyState> states = new(StringComparer.OrdinalIgnoreCase);

    public EnergyAggregationService(Config cfg, IFlowValueSource upstream, IEnergyStore store)
    {
        this.cfg = cfg;
        this.upstream = upstream;
        this.store = store;
    }

    /// <summary>
    /// The derived total for a node, if one has been accumulated. Only <c>energy</c>, and only once a
    /// sample has actually been taken — reporting 0 for a node that has never been measured would be a
    /// claim, not a gap.
    /// </summary>
    public bool TryGetValue(string nodeId, string metric, out double value)
    {
        value = 0;
        if (!string.Equals(metric, EnergyMetric, StringComparison.OrdinalIgnoreCase))
            return false;
        if (!states.TryGetValue(nodeId, out var s) || s.LastSampleUtc == default)
            return false;
        value = s.KWh;
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

    private void Sample(TimeSpan maxGap)
    {
        var now = DateTime.UtcNow;
        var next = new Dictionary<string, EnergyState>(states, StringComparer.OrdinalIgnoreCase);
        var sampled = 0;

        foreach (var node in cfg.EnergyFlow.Nodes)
        {
            var id = node.Id?.Trim();
            if (string.IsNullOrEmpty(id)) continue;

            // Only nodes with a *fresh* power reading: TryGetValue already hides an expired one, and a
            // stale value must be treated as a gap rather than integrated as if it were current.
            if (!upstream.TryGetValue(id, PowerMetric, out var watts)) continue;

            next[id] = EnergyIntegrator.Accumulate(
                next.TryGetValue(id, out var prev) ? prev : EnergyState.Empty, watts, now, maxGap);
            sampled++;
        }

        states = next;
        if (sampled > 0) store.Save(next);
    }
}

using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.History;
using rPDU2MQTT.Models.PDU;
using Serilog;

namespace rPDU2MQTT.Services;

/// <summary>
/// Fills the bridge's own history (#502): every node's readings, on a timer, into the local store.
///
/// <para>
/// The same sweep the rest of the bridge already does — build the graph, read each node — written to disk
/// rather than only published. A reading that is not there is not written: a gap in the files is a gap in
/// what was known, which is what every read of them then reports.
/// </para>
/// </summary>
public sealed class LocalHistoryWriterService(Config cfg, IFlowValueSource live, LocalSeriesStore store,
                                              ISnapshotCache? snapshots = null) : BackgroundService
{
    /// <summary>What is worth storing for every node. A metric nothing reports costs nothing: it is skipped.</summary>
    private static readonly string[] Metrics =
        ["realpower", "apparentpower", "current", "voltage", "frequency", "energy", "energy_d", "soc"];

    /// <summary>How often the coarser tiers are filled and old chunks dropped.</summary>
    private static readonly TimeSpan Housekeeping = TimeSpan.FromMinutes(5);

    private DateTime keptUpTo = DateTime.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!Local) return;

        var every = TimeSpan.FromSeconds(Math.Max(1, cfg.EnergyFlow.Aggregation.SampleIntervalSeconds));
        Log.Information($"Local history: storing every node's readings in {store.Root} every {every.TotalSeconds:0}s "
                      + $"(raw {store.Tiers[0].KeepDays}d, minute {store.Tiers[1].KeepDays}d, hour {store.Tiers[2].KeepDays}d).");

        using var timer = new PeriodicTimer(every);
        try
        {
            do
            {
                try { Sweep(DateTime.UtcNow); }
                catch (Exception ex) { Log.Warning($"Local history: a sweep failed ({ex.Message})."); }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }

    private bool Local => cfg.History.Enabled
        && string.Equals(cfg.History.Provider, "local", StringComparison.OrdinalIgnoreCase);

    /// <summary>One pass: what every node reads now, stored. Internal so a test can drive it against a clock.</summary>
    internal int Sweep(DateTime now)
    {
        var data = snapshots?.Latest?.Data ?? new PduData();
        var graph = FlowGraphBuilder.Build(data, cfg.EnergyFlow, FlowGraphBuilder.DefaultMetric, live);

        var readings = new List<(string Node, string Metric, double Value)>();
        foreach (var node in graph.Nodes)
        {
            foreach (var metric in Metrics)
                if (live.TryGetValue(node.Id, metric, out var value) && double.IsFinite(value))
                    readings.Add((node.Id, metric, value));

            // The return lane of a bidirectional node — battery charge, grid export — is stored as a series
            // of its own, exactly as it is exported, so a read of it is the same question as any other.
            foreach (var metric in Metrics)
            {
                var lane = metric + FlowMetricKey.InSuffix;
                if (live.TryGetValue(node.Id, lane, out var back) && double.IsFinite(back))
                    readings.Add((node.Id + FlowMetricKey.InSuffix, metric, back));
            }
        }

        if (readings.Count > 0) store.WriteSweep(now, readings);

        // Rolling up and trimming are the same sweep's work, done rarely: both are idempotent, so a restart
        // in between loses nothing.
        if (now - keptUpTo >= Housekeeping)
        {
            keptUpTo = now;
            try
            {
                foreach (var (node, metric) in readings.Select(r => (r.Node, r.Metric)).Distinct())
                    store.Rollup(node, metric, now);
                store.Trim(now);
            }
            catch (Exception ex) { Log.Warning($"Local history: housekeeping failed ({ex.Message})."); }
        }
        return readings.Count;
    }
}

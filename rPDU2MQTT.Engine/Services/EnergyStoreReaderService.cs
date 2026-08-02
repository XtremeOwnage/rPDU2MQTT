using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Services;

/// <summary>
/// Keeps a non-worker process's copy of the energy totals current by re-reading the shared store.
///
/// <para>
/// Accumulating is data production and belongs to the worker alone — several replicas each integrating the
/// same readings into their own copy of the counter is how a total ends up wrong in a way nothing can
/// reconcile. But that left every other role holding an <see cref="EnergyAggregationService"/> that was
/// constructed and never started, so its state stayed empty forever: in a split deployment the GUI and the
/// exporters reported "no data" for every energy and daily total, while the worker two pods over had them
/// all. Reading is not producing, so the read side can safely happen everywhere.
/// </para>
/// <para>
/// Only useful against a <b>shared</b> store — Redis/Valkey. The default file store is local to a process,
/// so in a split deployment a non-worker reads a file nobody is writing and finds nothing; that is a
/// deployment gap this cannot paper over, and <see cref="Config.Cache"/> is the fix for it.
/// </para>
/// </summary>
public sealed class EnergyStoreReaderService : BackgroundService
{
    private readonly Config cfg;
    private readonly EnergyAggregationService target;

    public EnergyStoreReaderService(Config cfg, EnergyAggregationService target)
    {
        this.cfg = cfg;
        this.target = target;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var agg = cfg.EnergyFlow.Aggregation;
        // The worker writes after every sampling pass, so re-reading faster than that only costs round-trips.
        var period = TimeSpan.FromSeconds(Math.Max(5, agg.SampleIntervalSeconds));

        if (!cfg.Cache.Enabled)
            Log.Warning("Energy totals are read from the local file store, which the worker in another process "
                      + "cannot share. Energy and daily totals will read as no-data here until Cache is enabled "
                      + "(Redis/Valkey), which is what makes them visible cluster-wide.");
        else
            Log.Information($"Energy totals: mirroring the shared store every {period.TotalSeconds:0}s (read-only; "
                          + "the worker owns the accumulation).");

        using var timer = new PeriodicTimer(period);
        try
        {
            do
            {
                try { target.LoadTotals(); }
                catch (Exception ex) { Log.Debug($"Could not refresh the energy totals: {ex.Message}"); }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}

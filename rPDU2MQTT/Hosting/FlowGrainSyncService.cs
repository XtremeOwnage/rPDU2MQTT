using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Mirrors the flow grain's live values into this process's local <see cref="FlowValueCache"/> (v3), so the
/// graph build and exporters read grain-backed data through the existing <see cref="IFlowValueSource"/> seam
/// without each process polling the sources. Push moves data into the grain; this pull keeps a local
/// current-state copy for the sync reads the graph builder needs.
/// </summary>
public sealed class FlowGrainSyncService : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly FlowValueCache target;

    public FlowGrainSyncService(IGrainFactory grains, FlowValueCache target)
    {
        this.grains = grains;
        this.target = target;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        do
        {
            try
            {
                var values = await grains.GetGrain<IFlowGrain>(0).RawValues();
                var now = DateTime.UtcNow;
                foreach (var v in values)
                    target.Set(v.NodeId, v.Metric.CanonicalName(), v.Value, staleAfterSeconds: 30, now);
            }
            catch (Exception ex) { Serilog.Log.Debug($"Flow-grain sync: {ex.Message}"); }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}

using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Hosting;

/// <summary>Drives each PDU instance's single-activation grain to poll (v3). Replaces InstanceManager's per-process poller.</summary>
public sealed class PduGrainActivator : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly PduInstanceRegistry registry;

    public PduGrainActivator(IGrainFactory grains, PduInstanceRegistry registry)
    {
        this.grains = grains;
        this.registry = registry;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            foreach (var id in registry.All.Keys)
            {
                try { await grains.GetGrain<IPduGrain>(id).Poll(); }
                catch (Exception ex) { Serilog.Log.Debug($"PDU activator: {id} poll failed: {ex.Message}"); }
            }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}

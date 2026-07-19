using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Publishes each PDU grain's latest snapshot onto this process's bus (v3), so the snapshot cache fills on
/// every process — worker, api, ui — straight from the grain. Replaces the MqttBusBridge that mirrored
/// snapshots over MQTT for split deployments.
/// </summary>
public sealed class PduSyncService : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly PduInstanceRegistry registry;
    private readonly IMessageBus bus;

    public PduSyncService(IGrainFactory grains, PduInstanceRegistry registry, IMessageBus bus)
    {
        this.grains = grains;
        this.registry = registry;
        this.bus = bus;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            foreach (var id in registry.All.Keys)
            {
                try
                {
                    var wire = await grains.GetGrain<IPduGrain>(id).Latest();
                    if (wire is not null)
                        await bus.PublishAsync(new PduSnapshot(wire.InstanceId, wire.TimestampUtc, RawSnapshotMapper.ToData(wire)), stoppingToken);
                }
                catch (Exception ex) { Serilog.Log.Debug($"PDU sync: {id} failed: {ex.Message}"); }
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

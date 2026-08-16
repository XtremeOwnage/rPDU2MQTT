using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Drives each device instance's single-activation grain to poll (v3). Replaces InstanceManager's
/// per-process poller.
///
/// <para>
/// Every device, not only the configured Vertiv PDUs: a plugin-supplied device is driven by the same grain,
/// so it gets the single cluster-wide activation and the child-grain supervision that outlet writes are
/// routed through — rather than a parallel poller that would have neither.
/// </para>
/// </summary>
public sealed class PduGrainActivator : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly PduInstanceRegistry registry;
    private readonly IReadOnlyList<string> pluginDevices;

    public PduGrainActivator(IGrainFactory grains, PduInstanceRegistry registry,
        IEnumerable<rPDU2MQTT.Core.Integrations.IDeviceReader>? readers = null)
    {
        this.grains = grains;
        this.registry = registry;
        pluginDevices = (readers ?? [])
            .OfType<rPDU2MQTT.Core.Integrations.PluginDeviceReader>()
            .SelectMany(r => r.InstanceIds)
            .ToList();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            foreach (var id in registry.All.Keys.Concat(pluginDevices))
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

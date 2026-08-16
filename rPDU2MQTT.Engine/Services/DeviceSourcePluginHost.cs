using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// Polls each plugin-supplied device and publishes its snapshot on the same bus the built-in poller uses.
///
/// <para>
/// Everything downstream is then already written — publishing, discovery, the flow graph, every
/// destination — because none of it asks what kind of device produced a reading. That is what makes a
/// second make of hardware a plugin rather than a fork.
/// </para>
/// </summary>
public sealed class DeviceSourcePluginHost : BackgroundService
{
    private readonly Config cfg;
    private readonly IntegrationRegistry registry;
    private readonly IMessageBus bus;
    private readonly IntegrationStatus status;
    private readonly ISingleOwnerLease lease;

    // When each device was last polled, so devices with different intervals share one timer.
    private readonly Dictionary<string, DateTime> lastPoll = new(StringComparer.OrdinalIgnoreCase);
    // Whether the last poll failed, so a persistent failure logs once rather than every pass.
    private readonly Dictionary<string, string> failing = new(StringComparer.OrdinalIgnoreCase);

    public DeviceSourcePluginHost(
        Config cfg, IntegrationRegistry registry, IMessageBus bus, IntegrationStatus status,
        ISingleOwnerLease? lease = null)
    {
        this.cfg = cfg;
        this.registry = registry;
        this.bus = bus;
        this.status = status;
        this.lease = lease ?? new SoleOwnerLease();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        do
        {
            try { await Poll(stoppingToken); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Log.Error(ex, "Device plugin poll failed."); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>One pass. Public so a test can drive it without a host.</summary>
    public async Task Poll(CancellationToken ct)
    {
        foreach (var (integration, device) in registry.Ready<IDeviceSourcePlugin>(cfg))
        {
            var due = !lastPoll.TryGetValue(device.InstanceId, out var last)
                      || DateTime.UtcNow - last >= device.PollInterval(cfg);
            if (!due) continue;
            lastPoll[device.InstanceId] = DateTime.UtcNow;

            // A device is a shared resource: many answer one client at a time, and every replica polling
            // independently is how reads start timing out. One owner cluster-wide, without the plugin
            // knowing what provides that.
            await lease.RunIfOwnerAsync($"device:{device.InstanceId}", async token =>
            {
                try
                {
                    var data = await device.PollAsync(cfg, token);
                    // Null is "nothing to report", not "everything went to zero" — the previous snapshot is
                    // left to go stale on its own, which is what marks the device unavailable downstream.
                    if (data is null) return;

                    // Published on the same bus the built-in poller uses, so the snapshot cache, the
                    // publishers and everything downstream receive it by the route they already listen on.
                    await bus.PublishAsync(new PduSnapshot(device.InstanceId, DateTime.UtcNow, data), token);
                    status.RecordSuccess(integration.Id, data.Devices.Sum(d => d.Outlets.Count));
                    if (failing.Remove(device.InstanceId))
                        Log.Information($"{integration.DisplayName} ({device.InstanceId}) is answering again.");
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    status.RecordFailure(integration.Id, ex.Message);
                    // Said once per outage, not once per poll — a device that is down for an hour should
                    // not be the only thing in the log.
                    if (!failing.TryGetValue(device.InstanceId, out var was) || was != ex.Message)
                    {
                        failing[device.InstanceId] = ex.Message;
                        Log.Error($"{integration.DisplayName} ({device.InstanceId}) poll failed: {ex.Message}. "
                                + "Its last readings will go stale rather than being republished as current.");
                    }
                }
            }, ct);
        }
    }
}

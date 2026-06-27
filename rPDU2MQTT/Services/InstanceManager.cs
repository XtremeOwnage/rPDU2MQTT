using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Services;

/// <summary>
/// Owns the running PDU producers — one <see cref="PduPoller"/> per instance in the
/// <see cref="PduInstanceRegistry"/>. Starts every instance at startup and, via <see cref="ReconcileAsync"/>,
/// adds/removes/rebuilds pollers at runtime when <see cref="Config.Pdus"/> changes (phase 5) — so a PDU
/// added or removed in the GUI takes effect without a restart. The primary instance is never torn down
/// (its PDU is the DI singleton shared with the GUI/control/discovery); a primary connection change is
/// logged as needing a restart.
/// </summary>
public sealed class InstanceManager : IHostedService
{
    private readonly Config cfg;
    private readonly PduInstanceRegistry registry;
    private readonly IMessageBus bus;
    private readonly HealthState health;
    private readonly Dictionary<string, PduPoller> pollers = new(StringComparer.OrdinalIgnoreCase);
    // The config signature each running poller was started with, so reconciliation can detect changes.
    private readonly Dictionary<string, string> runningSignatures = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim reconcileLock = new(1, 1);

    public InstanceManager(Config cfg, PduInstanceRegistry registry, IMessageBus bus, HealthState health)
    {
        this.cfg = cfg;
        this.registry = registry;
        this.bus = bus;
        this.health = health;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Start a poller for each instance the registry built at startup.
        foreach (var (id, pdu) in registry.All)
            StartPoller(id, pdu);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await reconcileLock.WaitAsync(cancellationToken);
        try
        {
            foreach (var poller in pollers.Values)
                await poller.StopAsync();
            pollers.Clear();
            runningSignatures.Clear();
        }
        finally { reconcileLock.Release(); }
    }

    /// <summary>
    /// Bring the running pollers in line with the current <see cref="Config.Pdus"/>: start newly-added
    /// instances, stop removed ones, and rebuild changed ones. Call after the config has been hot-reloaded.
    /// </summary>
    public async Task ReconcileAsync()
    {
        await reconcileLock.WaitAsync();
        try
        {
            var (toStop, toStart, primaryChanged) = InstanceReconcile.Plan(runningSignatures, cfg.Pdus, registry.PrimaryId);

            if (primaryChanged)
                Log.Warning($"Connection/credential changes to the primary PDU instance '{registry.PrimaryId}' need a restart to take effect.");

            foreach (var id in toStop)
            {
                Log.Information($"Stopping PDU instance '{id}' (removed or changed).");
                if (pollers.Remove(id, out var poller))
                    await poller.StopAsync();
                registry.Remove(id);
                runningSignatures.Remove(id);
            }

            foreach (var id in toStart)
            {
                if (!cfg.Pdus.TryGetValue(id, out var pduCfg))
                    continue;
                var pdu = registry.TryCreate(id, pduCfg);
                if (pdu is null)
                    continue; // hostless / not buildable — skip
                StartPoller(id, pdu);
            }
        }
        finally { reconcileLock.Release(); }
    }

    private void StartPoller(string id, PDU pdu)
    {
        var pollInterval = cfg.Pdus.TryGetValue(id, out var pduCfg) ? pduCfg.PollInterval : 5;
        Log.Information($"Starting PDU instance '{id}' (poll every {pollInterval}s).");
        var poller = new PduPoller(id, pdu, pollInterval, bus, health);
        poller.Start();
        pollers[id] = poller;
        runningSignatures[id] = cfg.Pdus.TryGetValue(id, out var c) ? InstanceReconcile.Signature(c) : "";
    }
}

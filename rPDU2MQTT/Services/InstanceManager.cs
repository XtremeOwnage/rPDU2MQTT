using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Services;

/// <summary>
/// Owns the running PDU producers — one <see cref="PduPoller"/> per configured instance
/// (<see cref="PduInstanceRegistry"/>). The registry that later enables adding/removing instances at
/// runtime; for now it starts every instance once at startup.
/// </summary>
public sealed class InstanceManager : IHostedService
{
    private readonly Config cfg;
    private readonly PduInstanceRegistry registry;
    private readonly IMessageBus bus;
    private readonly HealthState health;
    private readonly Dictionary<string, PduPoller> pollers = new(StringComparer.OrdinalIgnoreCase);

    public InstanceManager(Config cfg, PduInstanceRegistry registry, IMessageBus bus, HealthState health)
    {
        this.cfg = cfg;
        this.registry = registry;
        this.bus = bus;
        this.health = health;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        foreach (var (id, pdu) in registry.All)
        {
            var pollInterval = cfg.Pdus.TryGetValue(id, out var pduCfg) ? pduCfg.PollInterval : 5;
            Log.Information($"Starting PDU instance '{id}' (poll every {pollInterval}s).");
            var poller = new PduPoller(id, pdu, pollInterval, bus, health);
            poller.Start();
            pollers[id] = poller;
        }
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        foreach (var poller in pollers.Values)
            await poller.StopAsync();
        pollers.Clear();
    }
}

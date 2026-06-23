using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Services;

/// <summary>
/// Owns the running PDU producers — one <see cref="PduPoller"/> per configured instance
/// (<see cref="Config.Pdus"/>). The registry that later enables adding/removing instances at runtime.
/// </summary>
/// <remarks>
/// Today every entry maps to the single shared <see cref="PDU"/> (Config.Pdus has one "default" entry
/// derived from Config.PDU). Per-instance PDU construction (distinct connection/credentials) arrives
/// when Config.Pdus becomes user-configurable; until then a second entry would re-poll the same PDU, so
/// only the primary instance is started.
/// </remarks>
public sealed class InstanceManager : IHostedService
{
    private readonly Config cfg;
    private readonly PDU primaryPdu;
    private readonly IMessageBus bus;
    private readonly HealthState health;
    private readonly Dictionary<string, PduPoller> pollers = new(StringComparer.OrdinalIgnoreCase);

    public InstanceManager(Config cfg, PDU primaryPdu, IMessageBus bus, HealthState health)
    {
        this.cfg = cfg;
        this.primaryPdu = primaryPdu;
        this.bus = bus;
        this.health = health;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Start the primary instance. (Additional instances need per-instance PDU construction — wired
        // up when Config.Pdus is user-configurable; see remarks.)
        var (id, pduCfg) = cfg.Pdus.Count > 0
            ? cfg.Pdus.First()
            : new KeyValuePair<string, Models.Config.PduConfig>(Config.DefaultInstanceKey, cfg.PDU);

        if (cfg.Pdus.Count > 1)
            Log.Warning($"{cfg.Pdus.Count} PDU instances configured but only '{id}' is started; multi-instance polling is not enabled yet.");

        StartInstance(id, pduCfg);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        foreach (var poller in pollers.Values)
            await poller.StopAsync();
        pollers.Clear();
    }

    private void StartInstance(string id, Models.Config.PduConfig pduCfg)
    {
        Log.Information($"Starting PDU instance '{id}'.");
        var poller = new PduPoller(id, primaryPdu, pduCfg.PollInterval, bus, health);
        poller.Start();
        pollers[id] = poller;
    }
}

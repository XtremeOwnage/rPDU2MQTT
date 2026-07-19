using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// Polls one PDU instance, cluster-wide single owner (keyed by instance id). Throttled to the instance's
/// poll interval; concurrent callers serialize on the one activation. Holds the latest snapshot; a
/// per-process sync publishes it onto each process's bus so the snapshot cache fills everywhere.
/// </summary>
public sealed class PduGrain : Grain, IPduGrain
{
    private readonly Config config;
    private readonly PduInstanceRegistry registry;
    private readonly HealthState health;
    private readonly ILogger<PduGrain> log;
    private RawSnapshot? latest;
    private DateTime lastPollUtc = DateTime.MinValue;

    public PduGrain(Config config, PduInstanceRegistry registry, HealthState health, ILogger<PduGrain> log)
    {
        this.config = config;
        this.registry = registry;
        this.health = health;
        this.log = log;
    }

    public Task<RawSnapshot?> Latest() => Task.FromResult(latest);

    public async Task Poll()
    {
        var id = this.GetPrimaryKeyString();
        if (!registry.All.TryGetValue(id, out var pdu)) return;

        var interval = TimeSpan.FromSeconds(Math.Max(1, config.Pdus.TryGetValue(id, out var c) ? c.PollInterval : 5));
        if (DateTime.UtcNow - lastPollUtc < interval) return;   // throttle
        lastPollUtc = DateTime.UtcNow;

        try
        {
            var data = await pdu.GetRootData_Public(CancellationToken.None);
            // Project onto the round-trippable wire form — the live PduData can't be re-serialized faithfully.
            latest = RawSnapshotMapper.ToWire(id, DateTime.UtcNow, data);
            health.RecordPollSuccess();
        }
        catch (Exception ex) { log.LogError(ex, "PduGrain '{Id}' poll failed.", id); }
    }
}

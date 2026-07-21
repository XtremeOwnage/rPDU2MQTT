using Microsoft.Extensions.Logging;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Grains.Abstractions.Flow;
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
    // The children this supervisor owns, learned from the latest poll (device + outlet grain keys).
    private readonly List<string> deviceKeys = new();
    private readonly List<string> outletKeys = new();
    private readonly List<string> groupKeys = new();

    public PduGrain(Config config, PduInstanceRegistry registry, HealthState health, ILogger<PduGrain> log)
    {
        this.config = config;
        this.registry = registry;
        this.health = health;
        this.log = log;
    }

    public Task<RawSnapshot?> Latest() => Task.FromResult(latest);

    public Task<global::rPDU2MQTT.Abstractions.Pdu.PduChildren> Children()
        => Task.FromResult(new global::rPDU2MQTT.Abstractions.Pdu.PduChildren(this.GetPrimaryKeyString(), deviceKeys.ToList(), outletKeys.ToList(), groupKeys.ToList()));

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

            // Supervise the children: hand each device its own document and let it take what it needs (and
            // pass its outlets' documents further down). This grain captures the poll; it doesn't pick fields
            // on anyone else's behalf. It keeps only the keys, so it can report its own subtree.
            var now = DateTime.UtcNow;
            deviceKeys.Clear();
            outletKeys.Clear();
            groupKeys.Clear();
            foreach (var device in latest.Devices)
            {
                var deviceId = device.EntityName ?? device.Key ?? id;   // the identity used on the MQTT command topics
                deviceKeys.Add(deviceId);
                outletKeys.AddRange(device.Outlets.Select(o => IOutletGrain.KeyFor(deviceId, o.Key)));

                // The instance id travels with the document: that's what routes a write back to *this* PDU
                // when several are bridged, instead of to whichever one happens to be primary.
                await GrainFactory.GetGrain<IPduDeviceGrain>(deviceId).Observe(device, id, now);
            }

            // The OneView groups on this PDU are its children too: a group is resolved and actioned through
            // the PDU that has it, so bind each one to this instance. Without this a group action goes out
            // through the primary PDU, which on any other instance means the wrong outlets (or none).
            foreach (var group in data.Groups)
            {
                if (string.IsNullOrWhiteSpace(group.Key)) continue;
                groupKeys.Add(group.Key);
                await GrainFactory.GetGrain<IOneViewGroupGrain>(group.Key).Bind(id);
            }
        }
        catch (Exception ex) { log.LogError(ex, "PduGrain '{Id}' poll failed.", id); }
    }
}

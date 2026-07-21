using Microsoft.Extensions.Logging;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Grains.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Pdu;

namespace rPDU2MQTT.Grains.Pdu;

/// <summary>
/// One PDU instance, cluster-wide single owner (keyed by instance id). Throttled to the instance's poll
/// interval; concurrent callers serialize on the one activation. Holds the latest snapshot; a per-process
/// sync publishes it onto each process's bus so the snapshot cache fills everywhere.
/// <para>
/// It is also the only thing that talks to the physical device — reads and writes alike. Its children own
/// the <i>right</i> to write (one outlet grain per outlet, one group grain per group, so an action runs
/// exactly once) and ask this grain to make the call. Nothing below it goes looking for a PDU of its own,
/// which is what let a write reach the wrong device when several PDUs are bridged.
/// </para>
/// </summary>
public sealed class PduGrain : Grain, IPduGrain
{
    private readonly Config config;
    private readonly PduInstanceRegistry registry;
    private readonly ILogger<PduGrain> log;
    private RawSnapshot? latest;
    private DateTime lastPollUtc = DateTime.MinValue;
    // The children this supervisor owns, learned from the latest poll (device + outlet grain keys).
    private readonly List<string> deviceKeys = new();
    private readonly List<string> outletKeys = new();
    private readonly List<string> groupKeys = new();

    public PduGrain(Config config, PduInstanceRegistry registry, ILogger<PduGrain> log)
    {
        this.config = config;
        this.registry = registry;
        this.log = log;
    }

    /// <summary>This grain's own PDU: its key <i>is</i> the instance id, so there's nothing to choose.</summary>
    private PDU? Device => registry.All.TryGetValue(this.GetPrimaryKeyString(), out var pdu) ? pdu : null;

    public Task<RawSnapshot?> Latest() => Task.FromResult(latest);

    public Task<global::rPDU2MQTT.Abstractions.Pdu.PduChildren> Children()
        => Task.FromResult(new global::rPDU2MQTT.Abstractions.Pdu.PduChildren(this.GetPrimaryKeyString(), deviceKeys.ToList(), outletKeys.ToList(), groupKeys.ToList()));

    public async Task<string> ControlOutlet(string deviceId, int outletIndex, string action)
    {
        if (Device is not { } pdu) return $"PDU instance '{this.GetPrimaryKeyString()}' is not configured.";
        switch (action.Trim().ToLowerInvariant())
        {
            case "on": await pdu.SetOutletStateAsync(deviceId, outletIndex, true, CancellationToken.None); break;
            case "off": await pdu.SetOutletStateAsync(deviceId, outletIndex, false, CancellationToken.None); break;
            case "reboot": await pdu.ControlOutletAsync(deviceId, outletIndex, "reboot", CancellationToken.None); break;
            case "resetstats": await pdu.ResetOutletStatsAsync(deviceId, outletIndex, CancellationToken.None); break;
            default: return $"Unknown outlet action '{action}'.";
        }
        return $"{deviceId} outlet {outletIndex}: {action}.";
    }

    public async Task<string> SetOutletConfig(string deviceId, int outletIndex, string field, string payload, bool isDelay)
    {
        if (Device is not { } pdu) return "";
        object value;
        if (isDelay)
        {
            // HA sends the number as text; the API wants an integer.
            if (!double.TryParse(payload, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var num)) return "";
            value = (long)Math.Round(num);
        }
        else value = payload;   // poaAction etc.: the selected option string

        await pdu.SetOutletConfigAsync(deviceId, outletIndex, new Dictionary<string, object> { [field] = value }, CancellationToken.None);
        return value.ToString() ?? "";
    }

    public async Task<string> ControlGroup(string groupKey, string action)
    {
        if (Device is not { } pdu) return $"PDU instance '{this.GetPrimaryKeyString()}' is not configured.";
        var count = await pdu.ControlGroupAsync(groupKey, action, CancellationToken.None);
        return $"Group '{groupKey}' {action}: applied to {count} outlet(s).";
    }

    public async Task Poll()
    {
        var id = this.GetPrimaryKeyString();
        if (Device is not { } pdu) return;

        var interval = TimeSpan.FromSeconds(Math.Max(1, config.Pdus.TryGetValue(id, out var c) ? c.PollInterval : 5));
        if (DateTime.UtcNow - lastPollUtc < interval) return;   // throttle
        lastPollUtc = DateTime.UtcNow;

        try
        {
            var data = await pdu.GetRootData_Public(CancellationToken.None);
            // Project onto the round-trippable wire form — the live PduData can't be re-serialized faithfully.
            latest = RawSnapshotMapper.ToWire(id, DateTime.UtcNow, data);

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

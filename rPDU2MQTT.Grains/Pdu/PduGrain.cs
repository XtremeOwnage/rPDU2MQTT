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

    public PduGrain(Config config, PduInstanceRegistry registry, HealthState health, ILogger<PduGrain> log)
    {
        this.config = config;
        this.registry = registry;
        this.health = health;
        this.log = log;
    }

    public Task<RawSnapshot?> Latest() => Task.FromResult(latest);

    public Task<global::rPDU2MQTT.Abstractions.Pdu.PduChildren> Children()
        => Task.FromResult(new global::rPDU2MQTT.Abstractions.Pdu.PduChildren(this.GetPrimaryKeyString(), deviceKeys.ToList(), outletKeys.ToList()));

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

            // Supervise the children: this PDU owns a device (base-data) grain per device and an outlet grain
            // per outlet, so each becomes a live, addressable actor in the grain tree (and the write-owner for
            // its outlet). The parent tracks their keys so it can report its own subtree.
            var now = DateTime.UtcNow;
            deviceKeys.Clear();
            outletKeys.Clear();
            // The auto PDU→outlet flow, now in grains: each outlet feeds a measured flow node, each device is
            // an aggregate flow node summing its outlets. Node ids match the auto convention (pdu:/outlet:) so
            // custom nodes can wire onto them, and are registered with the flow grain for TreeSnapshot.
            var flowNodes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var device in latest.Devices)
            {
                var deviceId = device.EntityName ?? device.Key ?? id;   // the identity used on the MQTT command topics
                deviceKeys.Add(deviceId);
                await GrainFactory.GetGrain<IPduDeviceGrain>(deviceId)
                    .Observe(new global::rPDU2MQTT.Abstractions.Pdu.DeviceState(deviceId, device.Name, device.DisplayName, device.Make, device.Model, device.State, now));

                var outletFlowNodes = new List<NodeChild>();
                foreach (var o in device.Outlets)
                {
                    var key = IOutletGrain.KeyFor(deviceId, o.Key);
                    outletKeys.Add(key);
                    await GrainFactory.GetGrain<IOutletGrain>(key)
                        .Observe(new global::rPDU2MQTT.Abstractions.Pdu.OutletState(deviceId, o.Key, o.Name, o.DisplayName, o.State, now));

                    // Feed the outlet's measurements into its measured flow node (canonical units).
                    var outletNodeId = $"outlet:{deviceId}:{o.Key}";
                    foreach (var m in o.Measurements)
                        if (m.Type is { } t && Metrics.TryParse(t, out var metric)
                            && double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var val))
                            await GrainFactory.GetGrain<IMeasuredNodeGrain>(outletNodeId).Observe(metric, val * FlowUnits.ToCanonicalFactor(t, m.Units));

                    outletFlowNodes.Add(new NodeChild("measured", outletNodeId));
                    flowNodes[outletNodeId] = "measured";
                }

                var pduNodeId = $"pdu:{deviceId}";
                await GrainFactory.GetGrain<IAggregateNodeGrain>(pduNodeId).Configure(new NodeSpec("aggregate", outletFlowNodes));
                flowNodes[pduNodeId] = "aggregate";
            }
            if (flowNodes.Count > 0)
                await GrainFactory.GetGrain<IFlowGrain>(0).RegisterNodes(flowNodes);
        }
        catch (Exception ex) { log.LogError(ex, "PduGrain '{Id}' poll failed.", id); }
    }
}

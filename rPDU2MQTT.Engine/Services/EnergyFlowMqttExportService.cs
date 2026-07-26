using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services.baseTypes;
using System.Text.Json;

namespace rPDU2MQTT.Services;

/// <summary>
/// Publishes each energy-hierarchy tier's rolled-up power + energy to MQTT every poll (#164), when
/// <c>EnergyFlow.MqttExport</c> is on. The topic per tier comes from <c>EnergyFlow.MqttTopicTemplate</c>.
/// When HA discovery is enabled, each tier is also published as an HA device (Energy + Power sensors)
/// so the whole hierarchy — not just leaf outlets — appears in Home Assistant and can feed the Energy
/// Dashboard (#128). Registered in the Worker role; a no-op when the export is disabled.
/// </summary>
public class EnergyFlowMqttExportService : baseMQTTService
{
    // Discovery config topics we've already retired (once per process) — the duplicate energyflow sensors
    // an earlier build published for outlets/PDU tiers (#177). Cleared by an empty retained message.
    private readonly HashSet<string> clearedDuplicates = new();
    private readonly IFlowValueSource? live;

    public EnergyFlowMqttExportService(MQTTServiceDependencies deps, IFlowValueSource? live = null) : base(deps, deps.Cfg.Primary.PollInterval)
        => this.live = live;

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        var flow = cfg.EnergyFlow;
        if (!flow.MqttExport)
            return;

        // The hierarchy spans every PDU, so build one graph from all fresh sources combined.
        var merged = new PduData();
        DateTime? oldest = null;
        foreach (var snapshot in FreshSnapshotsWithId())
        {
            merged.Devices.AddRange(snapshot.Data.Devices);
            // A tier's roll-up is only as current as its stalest input, so report that rather than flatter it.
            if (oldest is null || snapshot.TimestampUtc < oldest) oldest = snapshot.TimestampUtc;
        }
        if (merged.Devices.Count == 0)
            return;
        DataTimestampUtc = oldest;

        // Power defines the hierarchy/topics; energy is the same roll-up over the energy measurement, so
        // each tier gets a total (kWh) it can contribute to the Energy Dashboard.
        var graph = FlowGraphBuilder.Build(merged, flow, FlowGraphBuilder.DefaultMetric, live);
        var energyMetric = string.IsNullOrWhiteSpace(cfg.HASS.EnergyDashboard.EnergyMeasurementType) ? "energy" : cfg.HASS.EnergyDashboard.EnergyMeasurementType;
        var energyGraph = FlowGraphBuilder.Build(merged, flow, energyMetric, live);

        var publishDiscovery = cfg.HASS.DiscoveryEnabled && !string.IsNullOrWhiteSpace(cfg.HASS.DiscoveryTopic);
        var availability = cfg.MQTT.LastWill ? MQTTHelper.StatusTopic(cfg.MQTT.ParentTopic) : null;
        // Outlets and PDU tiers already have native HA energy sensors from PDU discovery; publishing an
        // energyflow sensor for them too would duplicate the record in HA (#177). Only the synthetic
        // hierarchy tiers (panels/circuits/grid/etc.) get an energyflow discovery device.
        var native = FlowExport.NativeEnergyUniqueIds(merged, energyMetric);

        // Nodes that declare an in-direction (charge/export) energy source get a second energy sensor, fed
        // from the direction-qualified cache key. This is what lights up HA's battery-charge / grid-export.
        var energyInNodes = flow.Nodes
            .Where(n => n.AllSources().Any(s =>
                string.Equals(s.Metric, energyMetric, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(s.Direction, "in", StringComparison.OrdinalIgnoreCase)))
            .Select(n => n.Id)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        foreach (var node in graph.Nodes)
        {
            // Nothing determines this tier's power — no measurement, and no single path that conservation
            // pins down. Publishing it would put a fabricated 0 W into Home Assistant's history, which is
            // worse than the sensor going unavailable: one is a gap, the other is a lie that gets recorded.
            if (!FlowExport.TryNodeValue(graph, node.Id, out var power))
                continue;

            var topic = FlowExport.Topic(node, graph, cfg.MQTT.ParentTopic, flow);
            var energy = FlowExport.NodeValue(energyGraph, node.Id);   // 0 when this tier has no energy sensor
            var parents = FlowExport.Parents(graph, node.Id);          // the tiers that feed this one

            // The in-direction (charge/export) energy, when this node declares one and a fresh value exists —
            // null otherwise, so HA's energy_in sensor reads unavailable rather than a fabricated 0.
            double? energyIn = energyInNodes.Contains(node.Id) && live is not null
                && live.TryGetValue(node.Id, FlowMetricKey.For(energyMetric, "in"), out var ein) ? ein : null;

            var payload = JsonSerializer.Serialize(new
            {
                id = node.Id,
                value = power,       // retained for #164 back-compat (== power)
                power,
                energy,
                energy_in = energyIn,
                units = graph.Units,
                energyUnits = energyGraph.Units,
                label = node.Label,
                kind = node.Kind,
                parents,
                // #205: this payload is already JSON, so the read time can just be a field — no mode needed.
                timestamp = Core.MessageTimestamps.Format(oldest ?? DateTime.UtcNow),
            });
            await PublishString(topic, payload, retain: true, cancellationToken);

            if (!publishDiscovery)
                continue;

            var configTopic = $"{cfg.HASS.DiscoveryTopic}/device/{FlowExport.DeviceId(node.Id)}/config";
            if (native.ContainsKey(node.Id))
            {
                // Native sensor exists — retire any duplicate an earlier build left retained (once).
                if (clearedDuplicates.Add(configTopic))
                    await PublishString(configTopic, string.Empty, retain: true, cancellationToken);
            }
            else
            {
                var doc = FlowExport.DiscoveryDocument(node, parents.FirstOrDefault(), topic, energyGraph.Units, graph.Units, availability, includeEnergyIn: energyInNodes.Contains(node.Id));
                await PublishString(configTopic, doc.ToJsonString(), retain: cfg.HASS.DiscoveryRetain, cancellationToken);
            }
        }

        // Node groups (#groups): each group publishes its own summed tier alongside its members, so a
        // dashboard can chart "Incoming PV" as one series. Skipped when no member has a known value — never a
        // fabricated zero, the same rule as the nodes.
        foreach (var g in flow.Groups ?? new())
        {
            if (string.IsNullOrWhiteSpace(g.Id)) continue;

            var total = FlowGroups.Total(graph, g);
            if (total.Value is not { } power) continue;

            var energy = FlowGroups.Total(energyGraph, g).Value ?? 0;
            var groupNode = new FlowNode(total.Id, total.Label, total.Kind, power);
            var topic = FlowExport.Topic(groupNode, graph, cfg.MQTT.ParentTopic, flow);

            var payload = JsonSerializer.Serialize(new
            {
                id = g.Id,
                value = power,
                power,
                energy,
                units = graph.Units,
                energyUnits = energyGraph.Units,
                label = total.Label,
                kind = total.Kind,
                group = true,
                members = g.Members,
                timestamp = Core.MessageTimestamps.Format(oldest ?? DateTime.UtcNow),
            });
            await PublishString(topic, payload, retain: true, cancellationToken);

            if (!publishDiscovery) continue;

            var configTopic = $"{cfg.HASS.DiscoveryTopic}/device/{FlowExport.DeviceId(g.Id)}/config";
            var doc = FlowExport.DiscoveryDocument(groupNode, null, topic, energyGraph.Units, graph.Units, availability);
            await PublishString(configTopic, doc.ToJsonString(), retain: cfg.HASS.DiscoveryRetain, cancellationToken);
        }
    }
}

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
        foreach (var snapshot in FreshSnapshots())
            merged.Devices.AddRange(snapshot.Devices);
        if (merged.Devices.Count == 0)
            return;

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

        foreach (var node in graph.Nodes)
        {
            var topic = FlowExport.Topic(node, graph, cfg.MQTT.ParentTopic, flow);
            var power = FlowExport.NodeValue(graph, node.Id);
            var energy = FlowExport.NodeValue(energyGraph, node.Id);   // 0 when this tier has no energy sensor
            var parents = FlowExport.Parents(graph, node.Id);          // the tiers that feed this one

            var payload = JsonSerializer.Serialize(new
            {
                id = node.Id,
                value = power,       // retained for #164 back-compat (== power)
                power,
                energy,
                units = graph.Units,
                energyUnits = energyGraph.Units,
                label = node.Label,
                kind = node.Kind,
                parents,
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
                var doc = FlowExport.DiscoveryDocument(node, parents.FirstOrDefault(), topic, energyGraph.Units, graph.Units, availability);
                await PublishString(configTopic, doc.ToJsonString(), retain: cfg.HASS.DiscoveryRetain, cancellationToken);
            }
        }
    }
}

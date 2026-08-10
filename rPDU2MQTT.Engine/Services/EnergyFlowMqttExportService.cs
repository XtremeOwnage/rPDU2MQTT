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
    // Discovery config topics we've already retired (once per process).
    private readonly HashSet<string> clearedDuplicates = new();
    // Discovery configs retired because the tag filter now excludes their node. Cleared once per process.
    private readonly HashSet<string> retiredByFilter = new();
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

        // Power defines the hierarchy/topics; energy is the same roll-up over the energy measurement.
        var graph = FlowGraphBuilder.Build(merged, flow, FlowGraphBuilder.DefaultMetric, live);
        var energyMetric = string.IsNullOrWhiteSpace(cfg.HASS.EnergyDashboard.EnergyMeasurementType) ? "energy" : cfg.HASS.EnergyDashboard.EnergyMeasurementType;
        var energyGraph = FlowGraphBuilder.Build(merged, flow, energyMetric, live);
        // Energy since local midnight — the only energy roll-up whose tiers are comparable to each other.
        var todayGraph = FlowGraphBuilder.Build(merged, flow, EnergyPeriod.Metric, live);

        // ...but not until the carried-over totals are back.
        var periodsReady = (live as Core.Flow.IPeriodTotalsReady)?.PeriodTotalsReady ?? true;

        var publishDiscovery = cfg.HASS.DiscoveryEnabled && !string.IsNullOrWhiteSpace(cfg.HASS.DiscoveryTopic);
        var availability = cfg.MQTT.LastWill ? MQTTHelper.StatusTopic(cfg.MQTT.ParentTopic) : null;
        // Outlets and PDU tiers already have native HA energy sensors from PDU discovery.
        var native = FlowExport.NativeEnergyUniqueIds(merged, energyMetric);

        // Nodes that declare an in-direction (charge/export) energy source get a second energy sensor.
        var energyInNodes = flow.Nodes
            .Where(n => n.AllSources().Any(s =>
                string.Equals(s.Metric, energyMetric, StringComparison.OrdinalIgnoreCase) &&
                (string.Equals(s.Direction, "in", StringComparison.OrdinalIgnoreCase) || FlowMetricKey.IsSplit(s.Direction))))
            .Select(n => n.Id)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        // Nodes with a state-of-charge source (battery %) get an extra SoC sensor HA's battery source can use.
        var socNodes = flow.Nodes
            .Where(n => n.AllSources().Any(s => string.Equals(s.Metric, "soc", StringComparison.OrdinalIgnoreCase)))
            .Select(n => n.Id)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        // Synthetic nodes are for the diagram only — see FlowNode.Synthetic.
        var tagFilter = cfg.EnergyFlow.MqttExportTags;
        foreach (var node in graph.Nodes.Where(n => !n.Synthetic))
        {
            // Tag filter (#342): what this destination receives.
            if (!tagFilter.Allows(node.Tags))
            {
                // Retire the discovery config with it.
                if (publishDiscovery)
                {
                    var excludedTopic = $"{cfg.HASS.DiscoveryTopic}/device/{FlowExport.DeviceId(node.Id)}/config";
                    if (retiredByFilter.Add(excludedTopic))
                        await PublishString(excludedTopic, string.Empty, retain: true, cancellationToken);
                }
                continue;
            }

            // Nothing determines this tier's power — no measurement.
            if (!FlowExport.TryNodeValue(graph, node.Id, out var power))
                continue;

            var topic = FlowExport.Topic(node, graph, cfg.MQTT.ParentTopic, flow);
            var energy = FlowExport.NodeValue(energyGraph, node.Id);   // 0 when this tier has no energy sensor
            // Only feeders that are themselves being exported.
            var parents = FlowExport.Parents(graph, node.Id)
                .Where(pid => graph.Nodes.FirstOrDefault(n => string.Equals(n.Id, pid, StringComparison.OrdinalIgnoreCase)) is not { } pn
                              || tagFilter.Allows(pn.Tags))
                .ToList();

            // The in-direction (charge/export) energy, when this node declares one and a fresh value exists —
            double? energyIn = energyInNodes.Contains(node.Id) && live is not null
                && live.TryGetValue(node.Id, FlowMetricKey.For(energyMetric, "in"), out var ein) ? ein : null;

            // Today's total. Null — not 0 — when nothing determines it.
            double? energyToday = FlowExport.PeriodTotal(todayGraph, node.Id, periodsReady);

            // Signed net power for a bidirectional node: out (discharge/import) minus in (charge/export).
            double netPower = live is not null && live.TryGetValue(node.Id, FlowMetricKey.For("realpower", "in"), out var pin) ? power - pin : power;
            // Battery state of charge (%), when this node has a soc source with a fresh value.
            double? soc = socNodes.Contains(node.Id) && live is not null && live.TryGetValue(node.Id, "soc", out var s) ? s : null;

            var payload = JsonSerializer.Serialize(new
            {
                id = node.Id,
                value = netPower,    // retained for #164 back-compat (== power)
                power = netPower,
                energy,
                energy_in = energyIn,
                energy_today = energyToday,
                soc,
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
                var doc = FlowExport.DiscoveryDocument(node, parents.FirstOrDefault(), topic, energyGraph.Units, graph.Units, availability,
                    includeEnergyIn: energyInNodes.Contains(node.Id), includeSoc: socNodes.Contains(node.Id),
                    includeEnergyToday: energyToday is not null);
                await PublishString(configTopic, doc.ToJsonString(), retain: cfg.HASS.DiscoveryRetain, cancellationToken);
            }
        }

        // Node groups (#groups): each group publishes its own summed tier alongside its members.
        foreach (var g in flow.Groups ?? new())
        {
            if (string.IsNullOrWhiteSpace(g.Id)) continue;
            // An anchor group's id is a real node that already published its own tier above, so skip it.
            if (graph.Nodes.Any(n => string.Equals(n.Id, g.Id, StringComparison.OrdinalIgnoreCase))) continue;

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

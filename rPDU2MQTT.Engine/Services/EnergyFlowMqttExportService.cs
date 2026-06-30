using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services.baseTypes;
using System.Text.Json;

namespace rPDU2MQTT.Services;

/// <summary>
/// Publishes each energy-hierarchy tier's rolled-up value to MQTT every poll (#164), when
/// <c>EnergyFlow.MqttExport</c> is on. The topic per tier comes from <c>EnergyFlow.MqttTopicTemplate</c>.
/// Registered in the Worker role; a no-op when the export is disabled.
/// </summary>
public class EnergyFlowMqttExportService : baseMQTTService
{
    public EnergyFlowMqttExportService(MQTTServiceDependencies deps) : base(deps, deps.Cfg.Primary.PollInterval) { }

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

        var graph = FlowGraphBuilder.Build(merged, flow, FlowGraphBuilder.DefaultMetric);
        foreach (var node in graph.Nodes)
        {
            var payload = JsonSerializer.Serialize(new
            {
                value = FlowExport.NodeValue(graph, node.Id),
                units = graph.Units,
                label = node.Label,
                kind = node.Kind,
            });
            await PublishString(FlowExport.Topic(node, graph, cfg.MQTT.ParentTopic, flow), payload, retain: true, cancellationToken);
        }
    }
}

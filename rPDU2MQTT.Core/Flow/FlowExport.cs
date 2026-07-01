using System.Text.Json.Nodes;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Helpers for exporting an energy-hierarchy (<see cref="FlowGraph"/>) to MQTT (#164): each tier's
/// rolled-up value and the topic it publishes to.
/// </summary>
public static class FlowExport
{
    /// <summary>
    /// A node's rolled-up value: the larger of what flows in vs. what flows out (a root only has outflow,
    /// a leaf only inflow, a balanced tier has equal in/out). Matches the value shown in the GUI.
    /// </summary>
    public static double NodeValue(FlowGraph graph, string id)
    {
        double inflow = 0, outflow = 0;
        foreach (var l in graph.Links)
        {
            if (string.Equals(l.Target, id, StringComparison.OrdinalIgnoreCase)) inflow += l.Value;
            if (string.Equals(l.Source, id, StringComparison.OrdinalIgnoreCase)) outflow += l.Value;
        }
        return Math.Max(inflow, outflow);
    }

    /// <summary>The ids of a node's feeders (the sources of links pointing into it) — its upstream parents.</summary>
    public static string[] Parents(FlowGraph graph, string id)
        => graph.Links
            .Where(l => string.Equals(l.Target, id, StringComparison.OrdinalIgnoreCase))
            .Select(l => l.Source)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

    /// <summary>The MQTT topic a tier publishes to, with {parent}/{id}/{label}/{kind}/{metric}/{units} filled in.</summary>
    public static string Topic(FlowNode node, FlowGraph graph, string parentTopic, EnergyFlowConfig cfg)
    {
        var template = string.IsNullOrWhiteSpace(cfg.MqttTopicTemplate) ? "{parent}/energyflow/{id}" : cfg.MqttTopicTemplate;
        var topic = template
            .Replace("{parent}", (parentTopic ?? string.Empty).Trim('/'))
            .Replace("{id}", NodeKey(node.Id))
            .Replace("{label}", NodeKey(node.Label))
            .Replace("{kind}", node.Kind)
            .Replace("{metric}", graph.Metric)
            .Replace("{units}", graph.Units);
        // Collapse empty/duplicate slashes (e.g. an unused placeholder that resolved to empty).
        return string.Join('/', topic.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    }

    /// <summary>A stable, topic/id-safe key for a node id: ':' (outlet:pdu:n) and other separators -> '_'.</summary>
    public static string NodeKey(string value)
        => new((value ?? string.Empty).Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());

    /// <summary>The Home Assistant device identifier for a tier ("energyflow_&lt;key&gt;").</summary>
    public static string DeviceId(string nodeId) => "energyflow_" + NodeKey(nodeId);

    /// <summary>The HA unique_id / entity object_id of a tier's energy sensor ("energyflow_&lt;key&gt;_energy").</summary>
    public static string EnergyUniqueId(string nodeId) => DeviceId(nodeId) + "_energy";

    /// <summary>
    /// A Home Assistant device-discovery document for a tier (#128): one device with an Energy sensor
    /// (kWh, total_increasing — so it can feed the Energy Dashboard) and a Power sensor (W), both reading
    /// <c>value_json.energy</c> / <c>value_json.power</c> from the tier's exported MQTT topic. Publishing
    /// these makes the whole hierarchy — not just leaf outlets — visible to HA and linkable in the dashboard.
    /// </summary>
    public static JsonObject DiscoveryDocument(FlowNode node, string? primaryParentId, string stateTopic,
        string energyUnits, string powerUnits, string? availabilityTopic)
    {
        var id = DeviceId(node.Id);
        var device = new JsonObject
        {
            ["identifiers"] = new JsonArray(id),
            ["name"] = node.Label,
            ["manufacturer"] = "rPDU2MQTT",
            ["model"] = $"Energy Flow ({node.Kind})",
        };
        if (!string.IsNullOrEmpty(primaryParentId))
            device["via_device"] = DeviceId(primaryParentId);

        static JsonObject Sensor(string uniqueId, string name, string deviceClass, string stateClass, string units, string template) => new()
        {
            ["platform"] = "sensor",
            ["name"] = name,
            ["unique_id"] = uniqueId,
            ["object_id"] = uniqueId,
            ["device_class"] = deviceClass,
            ["state_class"] = stateClass,
            ["unit_of_measurement"] = units,
            ["value_template"] = template,
        };

        var doc = new JsonObject
        {
            ["device"] = device,
            ["origin"] = new JsonObject { ["name"] = "rPDU2MQTT" },
            ["state_topic"] = stateTopic,
            ["qos"] = 0,
            ["components"] = new JsonObject
            {
                [$"{id}_energy"] = Sensor($"{id}_energy", "Energy", "energy", "total_increasing", string.IsNullOrWhiteSpace(energyUnits) ? "kWh" : energyUnits, "{{ value_json.energy }}"),
                [$"{id}_power"] = Sensor($"{id}_power", "Power", "power", "measurement", string.IsNullOrWhiteSpace(powerUnits) ? "W" : powerUnits, "{{ value_json.power }}"),
            },
        };
        if (!string.IsNullOrEmpty(availabilityTopic))
            doc["availability_topic"] = availabilityTopic;
        return doc;
    }
}

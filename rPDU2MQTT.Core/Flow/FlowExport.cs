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
            .Replace("{id}", Slug(node.Id))
            .Replace("{label}", Slug(node.Label))
            .Replace("{kind}", node.Kind)
            .Replace("{metric}", graph.Metric)
            .Replace("{units}", graph.Units);
        // Collapse empty/duplicate slashes (e.g. an unused placeholder that resolved to empty).
        return string.Join('/', topic.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    }

    // Topic-safe form of an id/label: ':' (outlet:pdu:n) and other separators -> '_'.
    private static string Slug(string value)
        => new((value ?? string.Empty).Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());
}

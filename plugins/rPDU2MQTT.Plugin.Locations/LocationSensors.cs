using System.ComponentModel;

namespace rPDU2MQTT.Plugin.Locations;

/// <summary>A temperature/humidity sensor. Read by the ingests like a node, but outside the energy hierarchy.</summary>
public class SensorConfig
{
    [Description("Stable id, referenced from a room's or area's Climate.")]
    public string Id { get; set; } = "";

    public string Name { get; set; } = "";

    [Description("Bindings, as on a node: Metric temperature or percent (humidity).")]
    public List<EnergyFlowSource> Sources { get; set; } = new();
}

public static class LocationSensors
{
    public const string Prefix = "sensor:";

    /// <summary>The id the ingests file a sensor's readings under.</summary>
    public static string NodeId(string id) => Prefix + id;

    public static IEnumerable<EnergyFlowNode> Nodes(Config cfg) =>
        LocationSettings.Of(cfg).Sensors
            .Where(s => !string.IsNullOrWhiteSpace(s.Id))
            .Select(s => new EnergyFlowNode { Id = NodeId(s.Id), Label = s.Name is { Length: > 0 } n ? n : s.Id, Hidden = true, Sources = s.Sources ?? new() });

    /// <summary>A climate entry's reading: a sensor when one has that id, else the flow graph's value for a node.</summary>
    public static Func<string, double?> Reader(Config cfg, IFlowValueSource? live, string metric, Func<string, double?> nodes)
    {
        var ids = LocationSettings.Of(cfg).Sensors.Select(s => s.Id).Where(i => !string.IsNullOrWhiteSpace(i)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return id => ids.Contains(id)
            ? live is not null && live.TryGetValue(NodeId(id), metric, out var v) ? v : null
            : nodes(id);
    }
}

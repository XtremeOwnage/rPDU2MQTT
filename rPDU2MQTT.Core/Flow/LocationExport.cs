using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>Places as exported tiers (#467): each room, area, floor and site with its own topic and Home Assistant device.</summary>
public static class LocationExport
{
    /// <summary>The node id a place is exported under, kept apart from every flow node id.</summary>
    public static string NodeId(string locationId) => "location:" + locationId;

    /// <summary>The discovery device ids the location export publishes, so the orphan sweep leaves them be.</summary>
    public static IReadOnlyList<string> DeviceIds(EnergyFlowConfig flow) =>
        [.. LocationIndex.For(flow).All.Select(e => FlowExport.DeviceId(NodeId(e.Id)))];

    /// <summary>Each node's own determined value, unknown as null; a link's flow never stands in for a node nobody measured.</summary>
    public static Func<string, double?> ValuesOf(FlowGraph graph)
    {
        var values = new Dictionary<string, double?>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in graph.Nodes) values[n.Id] = n.Value;
        return id => values.TryGetValue(id, out var v) ? v : null;
    }

    /// <summary>The room each node is in, by name — what Home Assistant calls its area. Nodes in an area, floor or nowhere are left out.</summary>
    public static IReadOnlyDictionary<string, string> RoomNames(LocationIndex index, FlowTopology topology) =>
        LocationRollup.Placed(index, topology)
            .Where(kv => index[kv.Value] is { Kind: LocationKind.Room })
            .ToDictionary(kv => kv.Key, kv => index[kv.Value]!.Label, StringComparer.OrdinalIgnoreCase);
}

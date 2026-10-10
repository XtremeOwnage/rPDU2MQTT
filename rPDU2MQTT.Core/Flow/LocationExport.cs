using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>Places as exported tiers (#467): each room, area, floor and site with its own topic and Home Assistant device.</summary>
public static class LocationExport
{
    /// <summary>The node id a place is exported under, kept apart from every flow node id.</summary>
    public static string NodeId(string locationId) => "location:" + locationId;

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

/// <summary>Places as export tiers and rooms as Home Assistant areas, through the contributor hooks a plugin uses.</summary>
public sealed class LocationContributor : Integrations.IExportContributor, Integrations.IAreaProvider
{
    public IReadOnlyList<Integrations.ContributedTier> Tiers(Integrations.ExportPass pass, rPDU2MQTT.Classes.Config cfg)
    {
        var locations = LocationIndex.For(cfg.EnergyFlow);
        if (locations.All.Count == 0 || pass.Tiers.Count == 0) return [];
        var topology = FlowTopology.For(pass.Snapshot, cfg.EnergyFlow);
        var graph = pass.Tiers[0].Graph;
        var power = LocationRollup.Compute(locations, topology, LocationExport.ValuesOf(graph));
        var energy = LocationRollup.Compute(locations, topology, LocationExport.ValuesOf(pass.Tiers.Count > 1 ? pass.Tiers[1].Graph : graph));
        var today = LocationRollup.Compute(locations, topology, LocationExport.ValuesOf(pass.Tiers.Count > 2 ? pass.Tiers[2].Graph : graph));

        var tiers = new List<Integrations.ContributedTier>();
        foreach (var place in locations.All)
        {
            if (power[place.Id].Value is not { } watts) continue;
            tiers.Add(new(LocationExport.NodeId(place.Id), place.Label, place.Kind, watts, energy[place.Id].Value, today[place.Id].Value,
                place.Kind == LocationKind.Room ? place.Label : null, new Dictionary<string, object?> { ["location"] = place.Id }));
        }
        return tiers;
    }

    public IReadOnlyList<string> TierIds(rPDU2MQTT.Classes.Config cfg) =>
        [.. LocationIndex.For(cfg.EnergyFlow).All.Select(e => LocationExport.NodeId(e.Id))];

    public IReadOnlyDictionary<string, string> Areas(rPDU2MQTT.Classes.Config cfg, FlowTopology topology) =>
        LocationExport.RoomNames(LocationIndex.For(cfg.EnergyFlow), topology);
}

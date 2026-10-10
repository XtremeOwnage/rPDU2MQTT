using System.Text.Json.Nodes;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// Sites, placements, runs and location rules used to live in EnergyFlow, and each node's, panel's and breaker's
/// place on the entity itself. They now belong to the Locations plugin: its section, and its settings on each entity.
/// </summary>
public static class LegacyLocations
{
    public const string PluginId = "locations";

    /// <summary>Moves anything still in the old places to the plugin's, leaving what the plugin already has alone.</summary>
    public static void Migrate(rPDU2MQTT.Classes.Config config)
    {
        var flow = config.EnergyFlow;
        var section = config.Plugins is not null && config.Plugins.TryGetValue(PluginId, out var raw)
            ? PluginConfigBinder.ToJson(raw) as JsonObject ?? new JsonObject()
            : new JsonObject();
        var moved = false;
        void Move(string key, object? legacy)
        {
            if (PluginConfigBinder.ToJson(legacy) is not JsonArray { Count: > 0 } list) return;
            if (section[key] is JsonArray { Count: > 0 }) return;
            section[key] = list;
            moved = true;
        }
        Move("Sites", flow.LegacySites);
        Move("Placements", flow.LegacyPlacements);
        Move("Runs", flow.LegacyRuns);
        Move("AutoLocations", flow.LegacyAutoLocations);
        flow.LegacySites = flow.LegacyPlacements = flow.LegacyRuns = flow.LegacyAutoLocations = null;
        if (moved)
        {
            config.Plugins ??= new Dictionary<string, object?>();
            config.Plugins[PluginId] = section;
        }

        foreach (var node in flow.Nodes ?? [])
        {
            Put(node, "Location", string.IsNullOrWhiteSpace(node.LegacyLocation) ? null : JsonValue.Create(node.LegacyLocation.Trim()));
            node.LegacyLocation = null;
        }
        foreach (var panel in flow.Panels ?? [])
        {
            Put(panel, "Location", string.IsNullOrWhiteSpace(panel.LegacyLocation) ? null : JsonValue.Create(panel.LegacyLocation.Trim()));
            panel.LegacyLocation = null;
            foreach (var breaker in panel.Breakers ?? [])
            {
                var rooms = (breaker.LegacyRooms ?? []).Where(r => !string.IsNullOrWhiteSpace(r)).Select(r => (JsonNode?)JsonValue.Create(r.Trim())).ToArray();
                Put(breaker, "Rooms", rooms.Length > 0 ? new JsonArray(rooms) : null);
                breaker.LegacyRooms = null;
            }
        }

        // Disabling Floor Plans now disables the plugin that replaced it.
        if (config.DisabledPlugins is { } off)
            for (var i = 0; i < off.Count; i++)
                if (string.Equals(off[i]?.Trim(), "floorplan", StringComparison.OrdinalIgnoreCase)) off[i] = PluginId;
    }

    private static void Put(IExtensible entity, string key, JsonNode? value)
    {
        if (value is null) return;
        var mine = entity.Ext is not null && entity.Ext.TryGetValue(PluginId, out var raw)
            ? PluginConfigBinder.ToJson(raw) as JsonObject ?? new JsonObject()
            : new JsonObject();
        if (mine[key] is not null) return;
        mine[key] = value;
        entity.Ext ??= new Dictionary<string, object?>();
        entity.Ext[PluginId] = mine;
    }
}

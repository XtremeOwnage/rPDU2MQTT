using System.ComponentModel;
using System.Text.Json;

namespace rPDU2MQTT.Plugin.Locations;

/// <summary>Plugins.locations</summary>
public sealed class LocationSettings
{
    [Description("Where things are: sites, their floors, and the rooms and areas on each floor. Energy rolls up room → floor → site alongside the electrical hierarchy.")]
    public List<SiteConfig> Sites { get; set; } = new();

    [Description("Outlets, switches, fixtures, appliances and devices placed on the floor plans, each with its room and the circuit feeding it.")]
    public List<PlacementConfig> Placements { get; set; } = new();

    [Description("Cable runs drawn on the floor plans: branch circuits, feeders and the utility service, each between placed items.")]
    public List<RunConfig> Runs { get; set; } = new();

    [Description("Locations for derived nodes (PDUs and outlets), which have no entry of their own. Matched by node id with '*' as a wildcard; the first match wins, and an exact id beats a pattern.")]
    public List<AutoLocationRule> AutoLocations { get; set; } = new();

    [Description("What publishing to Home Assistant changes.")]
    public HaSyncConfig HomeAssistant { get; set; } = new();

    public const string PluginId = "locations";

    public static LocationSettings Of(Config cfg)
    {
        if (cfg.Plugins is null || !cfg.Plugins.TryGetValue(PluginId, out var raw) || raw is null) return new();
        lock (Cache)
        {
            var json = PluginConfigBinder.ToJson(raw)?.ToJsonString() ?? "{}";
            if (Cache.TryGetValue(cfg, out var seen) && seen.Json == json) return seen.Settings;
            LocationSettings settings;
            try { settings = JsonSerializer.Deserialize<LocationSettings>(json, Read) ?? new(); }
            catch (JsonException) { settings = new(); }
            Cache.AddOrUpdate(cfg, new Seen(json, settings));
            return settings;
        }
    }

    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Config, Seen> Cache = new();

    private sealed record Seen(string Json, LocationSettings Settings);

    private static readonly JsonSerializerOptions Read = new()
    {
        PropertyNameCaseInsensitive = true,
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString,
        Converters = { new LenientStringConverter() },
    };
}

public static class HaSyncMode
{
    public const string Create = "create";
    public const string Update = "update";
    public const string Off = "off";
    public const string UnsetOnly = "unset-only";
    public const string Fill = "fill";
    public const string Always = "always";
}

/// <summary>Home Assistant sync modes.</summary>
public sealed class HaSyncConfig
{
    [AllowedValues(HaSyncMode.Create, HaSyncMode.Update, HaSyncMode.Off)]
    [DefaultValue(HaSyncMode.Create)]
    [Description("Rooms to areas. create: make missing ones. update: only linked or same-name areas. off: never create or rename areas.")]
    public string Areas { get; set; } = HaSyncMode.Create;

    [AllowedValues(HaSyncMode.Create, HaSyncMode.Update, HaSyncMode.Off)]
    [DefaultValue(HaSyncMode.Off)]
    [Description("Floors to floors, and each area's floor. Same modes as Areas.")]
    public string Floors { get; set; } = HaSyncMode.Off;

    [AllowedValues(HaSyncMode.UnsetOnly, HaSyncMode.Off)]
    [DefaultValue(HaSyncMode.UnsetOnly)]
    [Description("Put this bridge's devices in their room's area. unset-only: only devices with no area.")]
    public string DeviceAreas { get; set; } = HaSyncMode.UnsetOnly;

    [AllowedValues(HaSyncMode.Fill, HaSyncMode.Always, HaSyncMode.Off)]
    [DefaultValue(HaSyncMode.Off)]
    [Description("Set each area's temperature and humidity sensors to its room's. fill: only when unset.")]
    public string AreaSensors { get; set; } = HaSyncMode.Off;

    internal static readonly HaSyncConfig Today = new();
}

public sealed class NodeLocation
{
    [ChoicesFrom("/api/integrations/locations/places")]
    [Description("The room, area, floor or site this node is in. Its own consumption counts toward that place.")]
    public string Location { get; set; } = "";
}

public sealed class PanelLocation
{
    [ChoicesFrom("/api/integrations/locations/places")]
    [Description("The room, area or floor the panel is mounted in.")]
    public string Location { get; set; } = "";
}

public sealed class BreakerRooms
{
    [ChoicesFrom("/api/integrations/locations/rooms")]
    [Description("The rooms and areas this breaker's circuit serves. A circuit serving several rooms lists each; its power then counts toward the smallest place holding all of them.")]
    public List<string> Rooms { get; set; } = new();
}

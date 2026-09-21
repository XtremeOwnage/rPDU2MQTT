using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>The kinds of place a location id can name (#461).</summary>
public static class LocationKind
{
    public const string Site = "site";
    public const string Floor = "floor";
    public const string Room = "room";
    public const string Area = "area";
}

/// <summary>A site: a house, a building, a plot. Holds floors (#461).</summary>
public class SiteConfig
{
    [Description("Stable unique id for this site, used to refer to it from elsewhere. For example 'home'. Ids are shared by sites, floors, rooms and areas, so each must be unique across all of them.")]
    public string Id { get; set; } = "";

    [Description("Human-readable name, for example 'Home'.")]
    public string Name { get; set; } = "";

    [Description("The floors of this site.")]
    public List<FloorConfig> Floors { get; set; } = new();
}

/// <summary>A floor of a site, with its plan and the rooms and areas drawn on it (#461, #463).</summary>
public class FloorConfig
{
    [Description("Stable unique id for this floor, for example 'ground'.")]
    public string Id { get; set; } = "";

    [Description("Human-readable name, for example 'Ground floor'.")]
    public string Name { get; set; } = "";

    [DefaultValue(0)]
    [Description("Where this floor sits in the building: 0 for the ground floor, 1 for the one above, -1 for a basement. Floors are listed in this order.")]
    public int Level { get; set; }

    [Description("The id of the uploaded floor plan image drawn behind this floor. Images are kept in plan storage, never in the configuration. Blank shows a grid.")]
    public string Image { get; set; } = "";

    [Range(100, 100000, ErrorMessage = "Width must be between 100 and 100000.")]
    [DefaultValue(1000)]
    [Description("Width of the plan in drawing units. Room outlines are given in these units, with 0,0 at the top left. Set from the image's proportions when one is uploaded.")]
    public double Width { get; set; } = 1000;

    [Range(100, 100000, ErrorMessage = "Height must be between 100 and 100000.")]
    [DefaultValue(700)]
    [Description("Height of the plan in drawing units.")]
    public double Height { get; set; } = 700;

    [Description("The rooms on this floor.")]
    public List<RoomConfig> Rooms { get; set; } = new();

    [Description("Areas on this floor. An area can span several rooms, such as 'upstairs' or 'server corner', and may overlap them.")]
    public List<AreaConfig> Areas { get; set; } = new();
}

/// <summary>A room on a floor, outlined on the plan (#461, #463).</summary>
public class RoomConfig
{
    [Description("Stable unique id for this room, for example 'kitchen'.")]
    public string Id { get; set; } = "";

    [Description("Human-readable name, for example 'Kitchen'. Also the name of its Home Assistant area.")]
    public string Name { get; set; } = "";

    [Description("The room's outline on the plan, as points in drawing units. Empty until the room is drawn.")]
    public List<PlanPoint> Shape { get; set; } = new();

    [Description("The Home Assistant area this room was linked to, by area id. Written when rooms are published to Home Assistant, so a rename updates the same area.")]
    public string HaArea { get; set; } = "";
}

/// <summary>An area on a floor: a named part of it that can span rooms (#461).</summary>
public class AreaConfig
{
    [Description("Stable unique id for this area, for example 'server_corner'.")]
    public string Id { get; set; } = "";

    [Description("Human-readable name, for example 'Server corner'.")]
    public string Name { get; set; } = "";

    [Description("The ids of the rooms this area takes in. Everything in those rooms counts toward the area as well.")]
    public List<string> Rooms { get; set; } = new();

    [Description("The area's outline on the plan, as points in drawing units. Optional: an area made of whole rooms needs no outline of its own.")]
    public List<PlanPoint> Shape { get; set; } = new();
}

/// <summary>A point on a floor plan, in the floor's drawing units.</summary>
public class PlanPoint
{
    public double X { get; set; }
    public double Y { get; set; }
}

/// <summary>What a placed item is (#464).</summary>
public static class PlacementKind
{
    public const string Outlet = "outlet";
    public const string Switch = "switch";
    public const string Fixture = "fixture";
    public const string Appliance = "appliance";
    public const string Device = "device";

    public static readonly string[] All = [Outlet, Switch, Fixture, Appliance, Device];
}

/// <summary>An outlet, switch, fixture, appliance or device placed on a floor plan (#464).</summary>
public class PlacementConfig
{
    [Description("Stable unique id for this item.")]
    public string Id { get; set; } = "";

    [AllowedValues(PlacementKind.Outlet, PlacementKind.Switch, PlacementKind.Fixture, PlacementKind.Appliance, PlacementKind.Device)]
    [DefaultValue(PlacementKind.Outlet)]
    [Description("What this is: an outlet, switch, fixture, appliance or device.")]
    public string Kind { get; set; } = PlacementKind.Outlet;

    [Description("What it is called, for example 'Fridge' or 'Desk outlet'.")]
    public string Label { get; set; } = "";

    [Description("The id of the room it is in.")]
    public string Room { get; set; } = "";

    [Description("Where it is on the floor plan, across, in drawing units.")]
    public double X { get; set; }

    [Description("Where it is on the floor plan, down, in drawing units.")]
    public double Y { get; set; }

    [Description("The circuit feeding it, as the panel id and breaker number: 'main_panel/B06'. Blank when nobody knows which breaker it is on.")]
    public string Circuit { get; set; } = "";

    [Description("The energy-flow node metering it, when it is individually metered — a smart plug, an ESPHome sensor, a PDU outlet.")]
    public string Node { get; set; } = "";
}

/// <summary>A location for every derived node whose id matches a pattern (#461).</summary>
public class AutoLocationRule
{
    [Description("Node id to match, with '*' matching any run of characters. For example 'outlet:rack_pdu_1:*' for every outlet on that PDU.")]
    public string Match { get; set; } = "";

    [Description("The id of the room, area, floor or site the matching nodes are in.")]
    public string Location { get; set; } = "";
}

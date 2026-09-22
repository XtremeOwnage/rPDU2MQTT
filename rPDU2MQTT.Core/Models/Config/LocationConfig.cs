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

    [Range(1, 100000, ErrorMessage = "Scale must be between 1 and 100000.")]
    [DefaultValue(100)]
    [Description("Drawing units per metre. 100 makes one unit a centimetre. Set it by measuring a known distance on the plan, so room sizes read in feet or metres.")]
    public double Scale { get; set; } = 100;

    [DefaultValue(0.85)]
    [Description("How strongly the plan image shows behind the drawing, from 0 (hidden) to 1.")]
    public double ImageOpacity { get; set; } = 0.85;

    [AllowedValues("", Surfaces.Grass, Surfaces.Concrete, Surfaces.Gravel, Surfaces.Dirt, Surfaces.Pavers, Surfaces.Snow)]
    [Description("What the ground around the rooms looks like: grass, concrete, gravel, dirt, pavers or snow. Blank is plain paper.")]
    public string Ground { get; set; } = "";

    [Description("The rooms on this floor.")]
    public List<RoomConfig> Rooms { get; set; } = new();

    [Description("Areas on this floor. An area can span several rooms, such as 'upstairs' or 'server corner', and may overlap them.")]
    public List<AreaConfig> Areas { get; set; } = new();

    [Description("Doors, windows and openings in the walls on this floor.")]
    public List<OpeningConfig> Openings { get; set; } = new();

    [Description("Geometric constraints between the corners and walls of this floor's rooms and areas: coincident, colinear, parallel, perpendicular, horizontal, vertical, a fixed angle or a fixed length. Kept as the plan is edited.")]
    public List<PlanConstraintConfig> Constraints { get; set; } = new();
}

/// <summary>What a plan constraint holds (#463).</summary>
public static class PlanConstraintKind
{
    public const string Coincident = "coincident";
    public const string Colinear = "colinear";
    public const string Parallel = "parallel";
    public const string Perpendicular = "perpendicular";
    public const string Horizontal = "horizontal";
    public const string Vertical = "vertical";
    public const string Angle = "angle";
    public const string Length = "length";
}

/// <summary>A constraint on corners and walls of the rooms and areas on a floor (#463).</summary>
public class PlanConstraintConfig
{
    [Description("Stable unique id for this constraint.")]
    public string Id { get; set; } = "";

    [AllowedValues(PlanConstraintKind.Coincident, PlanConstraintKind.Colinear, PlanConstraintKind.Parallel, PlanConstraintKind.Perpendicular,
        PlanConstraintKind.Horizontal, PlanConstraintKind.Vertical, PlanConstraintKind.Angle, PlanConstraintKind.Length)]
    [Description("Coincident (two corners), colinear, parallel or perpendicular (two walls), horizontal or vertical (a wall), angle (a corner) or length (a wall).")]
    public string Kind { get; set; } = PlanConstraintKind.Length;

    [Description("The corners or walls it holds, each a room or area id with a corner or wall number counted from 0.")]
    public List<PlanRefConfig> Refs { get; set; } = new();

    [Description("For a length, in drawing units; for an angle, in degrees, signed the way the outline turns at that corner.")]
    public double? Value { get; set; }
}

/// <summary>A corner or wall of a room or area, by position in its outline.</summary>
public class PlanRefConfig
{
    [Description("The id of the room or area.")]
    public string Room { get; set; } = "";

    [Description("The corner, counted from 0 in the outline. Blank when this refers to a wall.")]
    public int? Corner { get; set; }

    [Description("The wall, counted from 0: wall n runs from corner n to the next. Blank when this refers to a corner.")]
    public int? Edge { get; set; }
}

/// <summary>The textures a room, an outdoor zone or the ground can be drawn with (#463).</summary>
public static class Surfaces
{
    public const string Wood = "wood";
    public const string Tile = "tile";
    public const string Carpet = "carpet";
    public const string Concrete = "concrete";
    public const string Stone = "stone";
    public const string Grass = "grass";
    public const string Gravel = "gravel";
    public const string Dirt = "dirt";
    public const string Deck = "deck";
    public const string Pavers = "pavers";
    public const string Water = "water";
    public const string Snow = "snow";
    public const string Stairs = "stairs";
}

/// <summary>What an opening in a wall is (#463).</summary>
public static class OpeningKind
{
    public const string Door = "door";
    public const string DoubleDoor = "double-door";
    public const string SlidingDoor = "sliding-door";
    public const string GarageDoor = "garage-door";
    public const string Window = "window";
    public const string Opening = "opening";
}

/// <summary>A door, window or plain opening, centred on a point of a wall and lying along it (#463).</summary>
public class OpeningConfig
{
    [Description("Stable unique id for this opening.")]
    public string Id { get; set; } = "";

    [AllowedValues(OpeningKind.Door, OpeningKind.DoubleDoor, OpeningKind.SlidingDoor, OpeningKind.GarageDoor, OpeningKind.Window, OpeningKind.Opening)]
    [DefaultValue(OpeningKind.Door)]
    [Description("A door, double door, sliding door, garage door, window, or a plain opening.")]
    public string Kind { get; set; } = OpeningKind.Door;

    [Description("Centre of the opening across the plan, in drawing units.")]
    public double X { get; set; }

    [Description("Centre of the opening down the plan, in drawing units.")]
    public double Y { get; set; }

    [Description("The direction of the wall it sits in, in degrees clockwise from pointing right.")]
    public double Angle { get; set; }

    [Description("How wide the opening is, in drawing units.")]
    public double Width { get; set; } = 90;

    [AllowedValues("left", "right")]
    [DefaultValue("left")]
    [Description("Which end of a door the hinges are at.")]
    public string Swing { get; set; } = "left";

    [DefaultValue(false)]
    [Description("Swing the door to the other side of the wall.")]
    public bool Flip { get; set; }
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

    [DefaultValue(false)]
    [Description("An outdoor zone rather than a room: a yard, porch, patio, driveway or deck. Drawn as ground, not walls.")]
    public bool Outdoor { get; set; }

    [AllowedValues("", Surfaces.Wood, Surfaces.Tile, Surfaces.Carpet, Surfaces.Concrete, Surfaces.Stone, Surfaces.Grass, Surfaces.Gravel, Surfaces.Dirt, Surfaces.Deck, Surfaces.Pavers, Surfaces.Water, Surfaces.Snow, Surfaces.Stairs)]
    [Description("The floor or ground inside it: wood, tile, carpet, concrete, stone, grass, gravel, dirt, deck, pavers, water, snow, or stairs for a stairwell. Blank is plain.")]
    public string Surface { get; set; } = "";

    [RegularExpression("^(#[0-9a-fA-F]{6})?$", ErrorMessage = "A surface colour is written like #7a5c3e.")]
    [Description("The surface's colour, like #7a5c3e: the carpet, the tile, the paint. Blank uses the surface's own. With a plain surface it fills the room.")]
    public string SurfaceColor { get; set; } = "";

    [DefaultValue(false)]
    [Description("Lock the room: it cannot be moved, reshaped or deleted until it is unlocked.")]
    public bool Locked { get; set; }

    [Description("Walls that are locked in place, by number: wall n runs from corner n to the next.")]
    public List<int> LockedWalls { get; set; } = new();

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

    [DefaultValue(false)]
    [Description("Lock the area's outline: it cannot be moved, reshaped or deleted until it is unlocked.")]
    public bool Locked { get; set; }
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
    public const string Fan = "fan";
    public const string Hvac = "hvac";
    public const string EvCharger = "ev-charger";
    public const string Junction = "junction";
    public const string Panel = "panel";
    public const string Meter = "meter";
    public const string Pole = "pole";
    public const string Transformer = "transformer";
    public const string Solar = "solar";
    public const string Battery = "battery";
    public const string Inverter = "inverter";
    public const string Generator = "generator";

    public static readonly string[] All = [Outlet, Switch, Fixture, Appliance, Device, Fan, Hvac, EvCharger, Junction, Panel, Meter, Pole, Transformer, Solar, Battery, Inverter, Generator];
}

/// <summary>An outlet, switch, fixture, appliance or device placed on a floor plan (#464).</summary>
public class PlacementConfig
{
    [Description("Stable unique id for this item.")]
    public string Id { get; set; } = "";

    [AllowedValues(PlacementKind.Outlet, PlacementKind.Switch, PlacementKind.Fixture, PlacementKind.Appliance, PlacementKind.Device, PlacementKind.Fan, PlacementKind.Hvac, PlacementKind.EvCharger, PlacementKind.Junction, PlacementKind.Panel, PlacementKind.Meter, PlacementKind.Pole, PlacementKind.Transformer, PlacementKind.Solar, PlacementKind.Battery, PlacementKind.Inverter, PlacementKind.Generator)]
    [DefaultValue(PlacementKind.Outlet)]
    [Description("What this is: an outlet, switch, light fixture, fan, appliance, device, HVAC unit, EV charger, junction box, electrical panel, utility meter, utility pole, transformer, solar array, battery, inverter or generator.")]
    public string Kind { get; set; } = PlacementKind.Outlet;

    [Description("What it is called, for example 'Fridge' or 'Desk outlet'.")]
    public string Label { get; set; } = "";

    [Description("The id of the room or outdoor zone it is in. Blank when it is outdoors, or anywhere not drawn as a room.")]
    public string Room { get; set; } = "";

    [Description("The id of the floor it is drawn on. Needed for anything outside every room.")]
    public string Floor { get; set; } = "";

    [Description("For an item drawn at its real size — a washer, a fridge, an AC condenser — its width, in drawing units. Blank draws it as an icon.")]
    public double? Width { get; set; }

    [Description("Its depth, front to back, in drawing units.")]
    public double? Depth { get; set; }

    [Description("How far it is turned, in degrees clockwise. Its front faces down the plan at 0.")]
    public double? Rotation { get; set; }

    [Description("What appliance it is drawn as, seen from above: washer, dryer, fridge, freezer, range, dishwasher, water-heater, furnace, condenser, rack or hot-tub. Blank draws a plain box.")]
    public string Footprint { get; set; } = "";

    [DefaultValue(false)]
    [Description("Drawn round rather than square, such as a water heater; Width is its diameter.")]
    public bool Round { get; set; }

    [DefaultValue(false)]
    [Description("A GFCI outlet: everything wired downstream of it, from its load terminals, is protected by it.")]
    public bool Gfci { get; set; }

    [Description("For an item mounted on a wall, the direction it faces into its room, in degrees clockwise from pointing right. Blank when it stands free.")]
    public double? Facing { get; set; }

    [Description("For an electrical panel placed on the plan, the id of the panel in the panel schedule.")]
    public string Panel { get; set; } = "";

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

/// <summary>What a drawn run of cable is (#464).</summary>
public static class RunKind
{
    /// <summary>A branch circuit from a breaker to what it feeds.</summary>
    public const string Circuit = "circuit";
    /// <summary>A feeder between panels, or from a panel to a subpanel.</summary>
    public const string Feeder = "feeder";
    /// <summary>The utility service: pole or transformer to the meter and main panel.</summary>
    public const string Service = "service";
}

/// <summary>A cable run drawn on a floor plan, from one placed item to another through the points between (#464).</summary>
public class RunConfig
{
    [Description("Stable unique id for this run.")]
    public string Id { get; set; } = "";

    [AllowedValues(RunKind.Circuit, RunKind.Feeder, RunKind.Service)]
    [DefaultValue(RunKind.Circuit)]
    [Description("A branch circuit, a feeder between panels, or the utility service.")]
    public string Kind { get; set; } = RunKind.Circuit;

    [Description("The id of the floor it is drawn on.")]
    public string Floor { get; set; } = "";

    [Description("The circuit it carries, as the panel id and breaker number: 'main_panel/B06'. Blank when it is not known.")]
    public string Circuit { get; set; } = "";

    [Description("The placed item it starts at, on the supply side: runs are drawn from the panel outward, so what is downstream of an item is what its runs lead to. Blank when it starts at a bare point.")]
    public string From { get; set; } = "";

    [Description("The placed item it ends at. Blank when it ends at a bare point.")]
    public string To { get; set; } = "";

    [Description("The path between its ends, in drawing units: bends and, where an end is not an item, the end itself.")]
    public List<PlanPoint> Points { get; set; } = new();

    [Description("A note on the run, for example 'through the attic'.")]
    public string Label { get; set; } = "";
}

using System.ComponentModel;
using System.Text.Json.Serialization;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>What a breaker in the directory is known to be (#452).</summary>
public static class BreakerState
{
    /// <summary>Someone has said what this breaker feeds.</summary>
    public const string Identified = "identified";

    /// <summary>A breaker nobody has identified yet — the "????" rows of a paper directory.</summary>
    public const string Unknown = "unknown";

    /// <summary>An empty slot, or a breaker feeding nothing.</summary>
    public const string Unused = "unused";

    public static readonly string[] All = [Identified, Unknown, Unused];

    /// <summary>A state as written, with blank — the dropdown's "leave it to the default" — read as unknown.</summary>
    public static string Of(string? state) => string.IsNullOrWhiteSpace(state) ? Unknown : state;
}

/// <summary>
/// An electrical panel and what is in its slots (#452). The panel directory that lives on paper — breaker
/// number, wire label, description, and which circuits nobody has identified — held in config instead.
/// </summary>
public class PanelConfig
{
    [Description("Stable unique id for this panel, used to refer to it from elsewhere. For example 'main_panel'.")]
    public string Id { get; set; } = "";

    [Description("Human-readable name shown on the panel schedule. For example 'Main Panel'.")]
    public string Name { get; set; } = "";

    /// <summary>Slot positions in the panel, counting both columns — a 42-space panel has 42.</summary>
    [Range(2, 200, ErrorMessage = "Slots must be between 2 and 200.")]
    [DefaultValue(42)]
    [Description("How many breaker positions the panel has, counting both columns. A 42-space panel has 42. Odd numbers fill the left column; even numbers the right, as they are stamped in the panel.")]
    public int Slots { get; set; } = 42;

    /// <summary>The energy-flow node that is this panel: what feeds it, and what its circuits hang beneath.</summary>
    [Description("The energy-flow node that is this panel. Its reading is the power coming into the panel, and a circuit mapped to one of these breakers is placed beneath it.")]
    public string Node { get; set; } = "";

    [Description("The id of the room, area or floor the panel is mounted in.")]
    public string Location { get; set; } = "";

    [Description("The breakers in this panel's slots.")]
    public List<BreakerConfig> Breakers { get; set; } = new();

    /// <summary>Rows of slots down the panel: two slots to a row, left and right. Derived, never stored.</summary>
    [JsonIgnore]
    [YamlIgnore]
    public int Rows => (Slots + 1) / 2;

    /// <summary>A slot number the panel actually has.</summary>
    public bool HasSlot(int slot) => slot >= 1 && slot <= Slots;

    /// <summary>Odd slots are the left-hand column, as they are numbered in the panel itself.</summary>
    public static bool IsLeft(int slot) => slot % 2 == 1;

    /// <summary>Which row down the panel a slot sits in, counting from 1.</summary>
    public static int RowOf(int slot) => (slot + 1) / 2;
}

/// <summary>
/// One breaker in a panel slot (#452). A double-pole breaker holds the next slot in its own column as well;
/// a tandem breaker is two halves sharing one slot, numbered like "26.1" and "26.2".
/// </summary>
public class BreakerConfig
{
    /// <summary>The slot this breaker sits in, numbered as the panel is: odd on the left, even on the right.</summary>
    [Range(1, 200, ErrorMessage = "Slot must be between 1 and 200.")]
    [Description("Which slot the breaker is in, numbered as the panel is: odd down the left column, even down the right.")]
    public int Slot { get; set; }

    [Description("The breaker number as written in the directory. Usually the slot number; a tandem half is written like '26.1'.")]
    public string Number { get; set; } = "";

    /// <summary>1 for a single-pole breaker, 2 for a double-pole, which also holds the next slot in its column.</summary>
    [Range(1, 2, ErrorMessage = "Poles must be 1 or 2.")]
    [DefaultValue(1)]
    [Description("1 for a single-pole breaker, 2 for a double-pole. A double-pole also occupies the next slot in the same column (slot + 2).")]
    public int Poles { get; set; } = 1;

    /// <summary>Which half of a tandem breaker this is; blank when the breaker has the slot to itself.</summary>
    [Range(1, 2, ErrorMessage = "Half must be 1 or 2.")]
    [Description("For a tandem breaker, which half of the slot this is: 1 for the upper, 2 for the lower. Leave blank when the breaker has the whole slot.")]
    public int? Half { get; set; }

    [Range(1, 1000, ErrorMessage = "Amps must be between 1 and 1000.")]
    [Description("The breaker's rating in amps, as stamped on its handle.")]
    public int? Amps { get; set; }

    [Description("The label on the wire leaving this breaker, for example 'W11'. What the wire carries is mapped separately.")]
    public string Wire { get; set; } = "";

    [Description("What this breaker feeds, in the words the directory uses. For example 'Lights, Garage, Kitchen'.")]
    public string Description { get; set; } = "";

    /// <summary>The conductor size of the wire leaving this breaker, as it is written on the cable.</summary>
    [Description("The wire's gauge, as written on the cable — for example '12 AWG THWN' or '6 AWG'. Free text: the rating that matters is the breaker's, and the gauge is what says whether the wire can carry it.")]
    public string Gauge { get; set; } = "";

    [AllowedValues("copper", "aluminium")]
    [Description("What the wire is made of. Aluminium carries less for the same gauge, so a run sized in copper is not the same run in aluminium.")]
    public string Conductor { get; set; } = "";

    [Description("The ids of the rooms and areas this breaker's circuit serves. A circuit serving several rooms lists each; its power then counts toward the smallest place holding all of them.")]
    public List<string> Rooms { get; set; } = new();

    [Description("The energy-flow node that is this circuit. Blank uses the channel measuring it, when a single channel does.")]
    public string Node { get; set; } = "";

    /// <summary>Identified, not yet identified, or an empty slot. New breakers start unknown: a blank row claims nothing.</summary>
    [AllowedValues(BreakerState.Identified, BreakerState.Unknown, BreakerState.Unused)]
    [DefaultValue(BreakerState.Unknown)]
    [Description("Whether this breaker is identified, not yet identified (the '????' rows of a paper directory), or an unused slot. A new breaker starts unknown, so a blank row claims nothing.")]
    public string State { get; set; } = BreakerState.Unknown;

    /// <summary>Every slot this breaker occupies: a double-pole also holds the next slot in its own column.</summary>
    public IEnumerable<int> Occupies()
    {
        yield return Slot;
        if (Poles == 2) yield return Slot + 2;
    }

    /// <summary>Two breakers collide when they hold a slot together and are not the two halves of one tandem.</summary>
    public bool Collides(BreakerConfig other)
    {
        if (ReferenceEquals(this, other)) return false;
        if (!Occupies().Intersect(other.Occupies()).Any()) return false;
        return Half is null || other.Half is null || Half == other.Half;
    }
}

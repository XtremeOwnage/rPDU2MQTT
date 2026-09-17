using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// A CT clamp on a breaker's wire, and the monitor channel it is plugged into (#454). Each link in the chain
/// — breaker, wire, clamp, channel — is recorded on its own, so moving a clamp or relabelling a wire is one
/// change rather than a re-wiring of the directory.
/// </summary>
public class CtClampConfig
{
    [Description("The label written on the clamp, if it has one. Used to refer to this clamp from elsewhere.")]
    public string Label { get; set; } = "";

    [Range(1, 1000, ErrorMessage = "Amps must be between 1 and 1000.")]
    [Description("The clamp's rating in amps, as printed on it. For example 50 or 100.")]
    public int? Amps { get; set; }

    [Description("The id of the panel holding the breaker this clamp measures.")]
    public string Panel { get; set; } = "";

    [Description("The breaker number this clamp measures, as written in the directory. A tandem half is written like '26.1'.")]
    public string Breaker { get; set; } = "";

    /// <summary>Which pole of a double-pole breaker this clamp is on; 1 for a single-pole breaker.</summary>
    [Range(1, 2, ErrorMessage = "Leg must be 1 or 2.")]
    [DefaultValue(1)]
    [Description("Which leg of the breaker this clamp is on: 1 for a single-pole breaker, 1 or 2 for the two poles of a double-pole. Both legs need a clamp before the breaker's power is known.")]
    public int Leg { get; set; } = 1;

    [Description("The label on the wire this clamp sits on, for example 'W11'. Blank means the breaker's own wire.")]
    public string Wire { get; set; } = "";

    [Description("The monitor channel this clamp is plugged into, given as the node id the bridge already reads — for example 'n30_1_5'.")]
    public string Channel { get; set; } = "";

    /// <summary>One clamp measuring a whole 240 V circuit rather than one of its legs.</summary>
    [DefaultValue(false)]
    [Description("Tick when this single clamp measures the whole breaker rather than one leg — one CT on a 240 V circuit, where the monitor already accounts for both legs. Without it, a double-pole breaker needs a clamp on each leg before its power is known.")]
    public bool Whole { get; set; }

    /// <summary>A clamp put on backwards reads negative; the reading is flipped rather than believed.</summary>
    [DefaultValue(false)]
    [Description("Tick when the clamp is on the wire backwards, so it reads negative. Its reading is flipped rather than taken as a negative load.")]
    public bool Reversed { get; set; }
}

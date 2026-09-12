using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>Who works out a measurement type's feed: this bridge, or an EmonCMS process.</summary>
public enum EmonCmsCalculation
{
    [Description("This bridge's own reading where it has one, and an EmonCMS process otherwise.")]
    PreferLocal,

    [Description("An EmonCMS process where one applies, and this bridge's reading otherwise.")]
    PreferEmonCms,

    [Description("Only this bridge's reading. The feed goes unwritten when no reading arrives.")]
    ForceLocal,

    [Description("Only what EmonCMS works out. The feed goes unwritten when it has nothing to work from.")]
    ForceEmonCms,
}

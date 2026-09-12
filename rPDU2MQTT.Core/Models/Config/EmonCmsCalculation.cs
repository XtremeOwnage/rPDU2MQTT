using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>Where a measurement type's feed gets its value: the reading this bridge sends, or EmonCMS.</summary>
public enum EmonCmsCalculation
{
    [Description("Export the reading this bridge has. Where it has none, EmonCMS works the value out instead.")]
    PreferLocal,

    [Description("Export only the reading this bridge has. Where it has none, nothing is written — EmonCMS is not asked to work it out.")]
    ForceLocal,

    [Description("EmonCMS works the value out. The reading this bridge sends is never exported as this type.")]
    ForceEmonCms,
}

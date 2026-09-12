namespace rPDU2MQTT.Models.Config;

/// <summary>Who works out a measurement type's feed: this bridge, or an EmonCMS process.</summary>
public enum EmonCmsCalculation
{
    /// <summary>This bridge's reading where there is one, an EmonCMS process otherwise.</summary>
    PreferLocal,

    /// <summary>An EmonCMS process where one applies, this bridge's reading otherwise.</summary>
    PreferEmonCms,

    /// <summary>Only this bridge's reading; the feed goes unwritten when there is none.</summary>
    ForceLocal,

    /// <summary>Only an EmonCMS process; the feed goes unwritten when nothing can be derived.</summary>
    ForceEmonCms,
}

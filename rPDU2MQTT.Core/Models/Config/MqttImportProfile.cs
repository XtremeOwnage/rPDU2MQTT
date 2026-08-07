using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// A user-defined topic shape for the MQTT Import page.
///
/// <para>
/// A topic carries neither unit nor quantity. <see cref="Metrics"/> declares the quantity per captured
/// measure; the unit is selected at import time, with the sampled payload shown alongside.
/// </para>
/// </summary>
public class MqttImportProfile
{
    [Description("Name shown in the MQTT Import source list.")]
    public string Name { get; set; } = "";

    [Description("Subscription filter to browse, e.g. 'tele/#'. Narrow it: a broker's ACL may refuse '#'.")]
    public string Filter { get; set; } = "";

    [Description("Topic shape, with {device} and {measure} marking the parts to capture and '+' matching any single segment. e.g. 'tele/{device}/SENSOR/{measure}'.")]
    public string Pattern { get; set; } = "";

    [Description("Field holding the value when the payload is JSON — dotted for nesting. Leave blank when the payload is the bare number.")]
    public string? JsonField { get; set; }

    [Description("Captured {measure} -> metric name (realpower, apparentpower, energy, current, voltage, frequency, powerfactor). Measures not listed are ignored.")]
    public Dictionary<string, string> Metrics { get; set; } = new();
}

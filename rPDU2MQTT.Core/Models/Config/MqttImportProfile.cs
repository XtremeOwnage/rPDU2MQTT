using System.ComponentModel;

namespace rPDU2MQTT.Models.Config;

/// <summary>
/// A user-defined topic shape for the MQTT Import page — how to read one publisher's topics.
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

    [Description("Which captured {measure} supplies which metric. A measure that is not listed is ignored, so this is also the filter for the readings worth importing. Choose 'energy_d' for a counter the device zeroes each day (e.g. ESPHome's energy_d); it is imported as energy with a daily-reset counter.")]
    [MapColumns("Captured {measure}", "Metric it supplies", "e.g. the topic '…/sensor/power/state' captures 'power', which supplies realpower")]
    // The choices come from the unit table rather than a list written out here, so a metric added there is
    // offered here without this file changing — and cannot be offered here without being understood there.
    [MetricItemChoices]
    public Dictionary<string, string> Metrics { get; set; } = new();

    [Description("Tags put on every node imported through this profile, on top of the tag typed on the MQTT Import page. Use them in a destination's tag filter to keep these readings from being exported back where they came from.")]
    [TagChoices]
    public List<string> Tags { get; set; } = new();
}

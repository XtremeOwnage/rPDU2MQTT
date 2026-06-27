using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;

/// <summary>
/// Discovery for a writable numeric setting, exposed as a Home Assistant MQTT number.
/// Documentation: https://www.home-assistant.io/integrations/number.mqtt/
/// </summary>
public class NumberDiscovery : baseEntity
{
    /// <summary>Topic this number publishes the new value to (HA -> bridge).</summary>
    [JsonPropertyName("command_topic")]
    public string CommandTopic { get; set; } = string.Empty;

    /// <summary>Template used to extract the current value from <c>state_topic</c>.</summary>
    [JsonPropertyName("value_template")]
    public string? ValueTemplate { get; set; }

    [JsonPropertyName("min")]
    public double? Min { get; set; }

    [JsonPropertyName("max")]
    public double? Max { get; set; }

    [JsonPropertyName("step")]
    public double? Step { get; set; }

    [JsonPropertyName("unit_of_measurement")]
    public string? UnitOfMeasurement { get; set; }

    /// <summary>How the control is shown ("auto", "box" or "slider").</summary>
    [JsonPropertyName("mode")]
    public string? Mode { get; set; } = "box";
}

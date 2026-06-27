using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;

/// <summary>
/// Discovery for a writable enumerated setting, exposed as a Home Assistant MQTT select.
/// Documentation: https://www.home-assistant.io/integrations/select.mqtt/
/// </summary>
public class SelectDiscovery : baseEntity
{
    /// <summary>Topic this select publishes the chosen option to (HA -> bridge).</summary>
    [JsonPropertyName("command_topic")]
    public string CommandTopic { get; set; } = string.Empty;

    /// <summary>Template used to extract the current option from <c>state_topic</c>.</summary>
    [JsonPropertyName("value_template")]
    public string? ValueTemplate { get; set; }

    /// <summary>The list of selectable options.</summary>
    [JsonPropertyName("options")]
    public List<string> Options { get; set; } = new();
}

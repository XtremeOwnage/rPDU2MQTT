using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;

/// <summary>
/// Discovery for a controllable outlet, exposed as a Home Assistant MQTT switch.
/// Documentation: https://www.home-assistant.io/integrations/switch.mqtt/
/// </summary>
public class SwitchDiscovery : baseEntity
{
    /// <summary>The topic this switch publishes commands to (HA -> bridge).</summary>
    [JsonPropertyName("command_topic")]
    public string CommandTopic { get; set; } = string.Empty;

    /// <summary>Template used to extract the state value from <c>state_topic</c>.</summary>
    [JsonPropertyName("value_template")]
    public string? ValueTemplate { get; set; }

    /// <summary>Value in <c>state_topic</c> that represents the on state.</summary>
    [JsonPropertyName("state_on")]
    public string? StateOn { get; set; } = "on";

    /// <summary>Value in <c>state_topic</c> that represents the off state.</summary>
    [JsonPropertyName("state_off")]
    public string? StateOff { get; set; } = "off";

    /// <summary>Payload published to <c>command_topic</c> to turn the outlet on.</summary>
    [JsonPropertyName("payload_on")]
    public string? PayloadOn { get; set; } = "on";

    /// <summary>Payload published to <c>command_topic</c> to turn the outlet off.</summary>
    [JsonPropertyName("payload_off")]
    public string? PayloadOff { get; set; } = "off";

    [JsonPropertyName("device_class")]
    public string? DeviceClass { get; set; } = "outlet";
}

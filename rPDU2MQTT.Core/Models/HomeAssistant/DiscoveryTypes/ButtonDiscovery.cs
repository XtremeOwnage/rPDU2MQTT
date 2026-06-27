using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;

/// <summary>
/// Discovery for a stateless Home Assistant MQTT button (e.g. a diagnostic action).
/// Documentation: https://www.home-assistant.io/integrations/button.mqtt/
/// </summary>
public class ButtonDiscovery : baseEntity
{
    /// <summary>Topic this button publishes to when pressed (HA -> bridge).</summary>
    [JsonPropertyName("command_topic")]
    public string CommandTopic { get; set; } = string.Empty;

    /// <summary>Payload sent to <c>command_topic</c> when the button is pressed.</summary>
    [JsonPropertyName("payload_press")]
    public string PayloadPress { get; set; } = "PRESS";

    [JsonPropertyName("device_class")]
    public string? DeviceClass { get; set; }
}

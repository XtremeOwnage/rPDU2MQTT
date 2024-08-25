using rPDU2MQTT.Models.Converters;
using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using rPDU2MQTT.Models.HomeAssistant.Enums;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;
/// <summary>
/// Represents the configuration for an MQTT binary sensor in Home Assistant.
/// Documentation: <see href="https://www.home-assistant.io/integrations/binary_sensor.mqtt/"/>
/// </summary>
public class BinarySensorDiscovery : baseSensorEntity
{
    /// <summary>
    /// The string that represents the off state. It will be compared to the message in the state_topic.
    /// </summary>
    [JsonPropertyName("payload_off")]
    public string? PayloadOff { get; set; } = "OFF";

    /// <summary>
    /// The string that represents the on state. It will be compared to the message in the state_topic.
    /// </summary>
    [JsonPropertyName("payload_on")]
    public string? PayloadOn { get; set; } = "ON";


    /// <summary>
    /// Defines a template to extract the device’s availability from the topic.
    /// The result of this template will be compared to payload_available and payload_not_available.
    /// </summary>
    [JsonPropertyName("value_template")]
    public string? ValueTemplate { get; set; }

    /// <summary>
    /// For sensors that only send on state updates (like PIRs), this variable sets a delay in seconds after which the sensor’s state will be updated back to off.
    /// </summary>
    [JsonPropertyName("off_delay")]
    public TimeSpan? OffDelay { get; set; }
}

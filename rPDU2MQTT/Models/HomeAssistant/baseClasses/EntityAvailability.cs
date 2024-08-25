using rPDU2MQTT.Models.Converters;
using rPDU2MQTT.Models.HomeAssistant.Enums;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.baseClasses;

public class EntityAvailability
{
    /// <summary>
    /// The MQTT topic subscribed to receive birth and LWT messages from the MQTT device.
    /// Must not be used together with availability.
    /// </summary>
    [JsonPropertyName("availability_topic")]
    public string? AvailabilityTopic { get; set; }

    /// <summary>
    /// Defines a template to extract the device’s availability from the availability_topic.
    /// The result of this template will be compared to payload_available and payload_not_available.
    /// </summary>
    [JsonPropertyName("availability_template")]
    public string? AvailabilityTemplate { get; set; } = "{{ value }}";

    /// <summary>
    /// The payload that represents the unavailable state. Default is "offline".
    /// </summary>
    [JsonPropertyName("payload_not_available")]
    public string? PayloadNotAvailable { get; set; } = "offline";

    /// <summary>
    /// The payload that represents the available state. Default is "online".
    /// </summary>
    [JsonPropertyName("payload_available")]
    public string? PayloadAvailable { get; set; } = "online";


    ///// <summary>
    ///// A list of MQTT topics subscribed to receive availability (online/offline) updates.
    ///// Must not be used together with availability_topic.
    ///// </summary>
    //[JsonPropertyName("availability")]
    //public List<string>? Availability { get; set; }

    /// <summary>
    /// Controls the conditions needed to set the entity to available.
    /// Valid entries are "all", "any", and "latest". Default is "latest".
    /// </summary>
    [JsonPropertyName("availability_mode")]
    public AvailabilityMode AvailabilityMode { get; set; } = AvailabilityMode.Latest;
}

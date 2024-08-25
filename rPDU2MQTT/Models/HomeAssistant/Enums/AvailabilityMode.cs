using rPDU2MQTT.Models.Converters;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.Enums;

public enum AvailabilityMode
{
    /// <summary>
    /// All availability topics must receive a "payload_available" before the entity is marked as online.
    /// </summary>
    [JsonPropertyName("all")]
    All,

    /// <summary>
    /// The entity is marked as online if any one of the availability topics receives a "payload_available".
    /// </summary>
    [JsonPropertyName("any")]
    Any,

    /// <summary>
    /// The last received "payload_available" or "payload_not_available" on any availability topic controls the entity's availability.
    /// </summary>
    [JsonPropertyName("latest")]
    Latest
}

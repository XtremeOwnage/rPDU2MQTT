using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

public enum MqttPath
{
    [JsonPropertyName("outlets")]
    Outlets,

    [JsonPropertyName("entity")]
    Entity,

    [JsonPropertyName("state")]
    State,

    [JsonPropertyName("measurements")]
    Measurements,

    [JsonPropertyName("name")]
    Name,

    [JsonPropertyName("identifier")]
    UniqueIdentifier,
}
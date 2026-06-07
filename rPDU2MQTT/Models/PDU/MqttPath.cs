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

    [JsonPropertyName("set")]
    Set,

    [JsonPropertyName("measurements")]
    Measurements,

    [JsonPropertyName("name")]
    Name,

    [JsonPropertyName("identifier")]
    UniqueIdentifier,

    [JsonPropertyName("Groups")]
    Groups,

    [JsonPropertyName("avg")]
    Average,

    [JsonPropertyName("sum")]
    Sum,

    [JsonPropertyName("min")]
    Minimum,

    [JsonPropertyName("max")]
    Maximum,
}
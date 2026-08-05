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

    [JsonPropertyName("reboot")]
    Reboot,

    [JsonPropertyName("alarm")]
    Alarm,

    /// <summary>
    /// A JSON object of detail about the alarm — today its severity. Sits beside <see cref="Alarm"/>
    /// rather than replacing its payload, because the plain state topic is what existing installs already
    /// read, and changing that payload to JSON would break every one of them.
    /// </summary>
    [JsonPropertyName("alarm_attributes")]
    AlarmAttributes,

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
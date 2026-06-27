using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.PDU;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Interfaces;

/// <summary>
/// Represents an entity which contains a state, along with the expected values.
/// </summary>
public interface IEntityWithState
{
    [JsonPropertyName("state")]
    public string State { get; set; }

    /// <summary>
    /// This is the topic-name where this entity should report its state.
    /// </summary>
    [JsonIgnore]
    public string State_Topic => MqttPath.State.ToJsonString();

    /// <summary>
    /// This is the expected value returned when this entity is "on"
    /// </summary>
    [JsonIgnore]
    public string State_On => "on";

    /// <summary>
    /// This is the expected value returned when this entity is "off"
    /// </summary>
    [JsonIgnore]
    public string State_Off => "off";

    /// <summary>
    /// This is the value template which should be used.
    /// </summary>
    [JsonIgnore]
    public string State_ValueTemplate => "{{ value }}";
}


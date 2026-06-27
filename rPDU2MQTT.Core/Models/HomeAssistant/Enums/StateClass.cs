using rPDU2MQTT.Models.Converters;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.Enums;

/// <summary>
/// Represents the state class for a sensor in Home Assistant.
/// </summary>
public enum StateClass
{
    /// <summary>
    /// The state represents a measurement in present time, not a historical aggregation such as statistics or a prediction of the future.
    /// Examples: current temperature, humidity, or electric power.
    /// </summary>
    [JsonPropertyName("measurement")]
    Measurement,

    /// <summary>
    /// The state represents a total amount that can both increase and decrease, e.g., a net energy meter.
    /// This state class should not be used for sensors where the absolute value is interesting instead of the accumulated growth or decline.
    /// </summary>
    [JsonPropertyName("total")]
    Total,

    /// <summary>
    /// The state represents a monotonically increasing positive total which periodically restarts counting from 0,
    /// e.g., a daily amount of consumed gas, weekly water consumption, or lifetime energy consumption.
    /// </summary>
    [JsonPropertyName("total_increasing")]
    TotalIncreasing
}

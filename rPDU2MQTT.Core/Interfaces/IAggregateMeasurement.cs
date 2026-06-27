using System.Text.Json.Serialization;

namespace rPDU2MQTT.Interfaces;

/// <summary>
/// Represents an aggregate measurement.
/// </summary>
public interface IAggregateMeasurement
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyName("avg")]
    string AvgValue { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyName("sum")]
    string SumValue { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyName("max")]
    string MaxValue { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyName("min")]
    string MinValue { get; set; }
}

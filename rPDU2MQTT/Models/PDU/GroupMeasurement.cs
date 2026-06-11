using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.basePDU;
using System.Diagnostics;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

/// <summary>
/// Represent a grouped measurement.
/// </summary>
/// <remarks>
/// This may be oneview/aggregation specific.
/// </remarks>
[DebuggerDisplay("Measurement: {Type} Avg:{AvgValue} Sum:{SumValue} {Units}")]
public class GroupMeasurement : baseMeasurement, IAggregateMeasurement, IDictionaryKey<string>
{
    #region IDictionaryKey
    /// <inheritdoc cref="IDictionaryKey{TKeyType}.Key"/>>
    [JsonIgnore]
    public string Key { get; set; }
    #endregion

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyName("avgValue")]
    public string AvgValue { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyName("sumValue")]
    public string SumValue { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyName("maxValue")]
    public string MaxValue { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyName("minValue")]
    public string MinValue { get; set; }
}

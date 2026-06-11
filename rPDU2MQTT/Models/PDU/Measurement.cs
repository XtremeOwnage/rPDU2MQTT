using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.basePDU;
using System.Diagnostics;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

/// <summary>
/// This represents a measurement coming from Rack PDU.
/// </summary>
[DebuggerDisplay("Measurement: {Type} {Value} {Units}")]
public partial class Measurement : baseMeasurement, IDictionaryKey<string>
{
    #region IDictionaryKey
    /// <inheritdoc cref="IDictionaryKey{TKeyType}.Key"/>>
    [JsonIgnore]
    public string Key { get; set; }
    #endregion

    [JsonPropertyName("value")]
    public string Value { get; set; }
}

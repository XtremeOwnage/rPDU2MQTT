using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.Converters;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

/// <summary>
/// This represents an outlet, which belongs to a OneViewGroup. 
/// </summary>
/// <remarks>
/// Note, this will need to be correlated back to an ACTUAL outlet.
/// </remarks>
public class OneViewGroupedOutlet : IDictionaryKey<int>
{
    #region IDictionaryKey
    /// <inheritdoc cref="IDictionaryKey{TKeyType}.Key"/>>
    [JsonIgnore]
    public int Key { get; set; }
    #endregion

    [JsonPropertyName("measurement")]
    [JsonConverter(typeof(DictionaryToListConverter<GroupMeasurement, string>))]
    public List<GroupMeasurement> Measurements { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; }

    [JsonPropertyName("alarm")]
    public Alarm Alarm { get; set; }
}

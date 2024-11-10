using System.Text.Json.Serialization;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.DummyDevices;

namespace rPDU2MQTT.Models.PDU;

public partial class Entity : NamedEntityWithMeasurements, IDictionaryKey<string>
{ 
    #region IDictionaryKey
    /// <inheritdoc cref="IDictionaryKey{TKeyType}.Key"/>>
    [JsonIgnore]
    public string Key { get; set; }
    #endregion

    [JsonPropertyName("alarm")]
    public A0Ae260C851900C3Alarm Alarm { get; set; }

    [JsonPropertyName("conf")]
    public Action Conf { get; set; }

    [JsonPropertyName("point")]
    public Action Point { get; set; }
}

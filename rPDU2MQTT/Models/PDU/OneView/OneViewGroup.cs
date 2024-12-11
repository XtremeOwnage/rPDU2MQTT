using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.basePDU;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

public class OneViewGroup : EntityWithNameAndLabel, IDictionaryKey<string>
{
    #region IDictionaryKey
    /// <inheritdoc cref="IDictionaryKey{TKeyType}.Key"/>>
    [JsonIgnore]
    public string Key { get; set; }
    #endregion

    [JsonPropertyName("label")]
    public string Label { get; set; }

    [JsonPropertyName("snmpInstance")]
    public long SnmpInstance { get; set; }

    [JsonPropertyName("name")]
    public string Name { get; set; }

    [JsonPropertyName("order")]
    public long Order { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; }

    [JsonPropertyName("entity")]
    public OneViewGroupEntities Entity { get; set; }
}

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

    // Name and Label are inherited from EntityWithNameAndLabel.

    [JsonPropertyName("snmpInstance")]
    public long SnmpInstance { get; set; }

    [JsonPropertyName("order")]
    public long Order { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; }

    [JsonPropertyName("entity")]
    public OneViewGroupEntities Entity { get; set; }

    /// <summary>
    /// Member outlets (deviceSerial + outlet index), resolved from the host <c>groupMap</c>. Used to
    /// fan out group actions and to mirror member switches onto the group's Home Assistant device.
    /// </summary>
    [JsonIgnore]
    public List<(string DeviceId, int OutletIndex)> MemberOutlets { get; } = new();
}

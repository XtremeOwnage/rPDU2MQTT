using rPDU2MQTT.Interfaces;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

public class OneViewHost : IDictionaryKey<string>
{
    #region IDictionaryKey
    /// <inheritdoc cref="IDictionaryKey{TKeyType}.Key"/>>
    [JsonIgnore]
    public string Key { get; set; }
    #endregion

    [JsonPropertyName("snmpInstance")]
    public long SnmpInstance { get; set; }

    // Per-outlet group assignment: groupMap.dev.<serial>.outlet.<index>.group.
    [JsonPropertyName("groupMap")]
    public OneViewGroupMap? GroupMap { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; }

    [JsonPropertyName("httpsPort")]
    public long HttpsPort { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; }

    [JsonPropertyName("cache")]
    public rPDU Cache { get; set; }

    [JsonPropertyName("snmpPort")]
    public long SnmpPort { get; set; }

    /// <summary>
    /// This appears to be a reference to the group this PDU is assigned to.
    /// </summary>
    [JsonPropertyName("group")]
    //[JsonConverter(typeof(ParseStringConverter))]   
    public string? Group { get; set; }

    [JsonPropertyName("order")]
    public long Order { get; set; }

    [JsonPropertyName("webPort")]
    public long WebPort { get; set; }

    [JsonPropertyName("gdp")]
    public OneViewDeviceConfig Gdp { get; set; }
}

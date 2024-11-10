using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.Converters;
using rPDU2MQTT.Models.PDU.basePDU;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

public partial class Device : EntityWithNameAndLabel, IEntityWithState, IDictionaryKey<string>
{
    #region State
    string IEntityWithState.State_On => "normal";
    string IEntityWithState.State_Off => "";
    #endregion

    #region IDictionaryKey
    /// <inheritdoc cref="IDictionaryKey{TKeyType}.Key"/>>
    [JsonIgnore]
    public string Key { get; set; }
    #endregion

    [JsonPropertyName("state")]
    public string State { get; set; }

    [JsonPropertyName("order")]
    public long Order { get; set; }

    [JsonPropertyName("conf")]
    public A0Ae260C851900C3Conf Conf { get; set; }

    [JsonPropertyName("point")]
    public A0Ae260C851900C3Point Point { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; }

    [JsonPropertyName("snmpInstance")]
    public long SnmpInstance { get; set; }

    [JsonPropertyName("lifetimeEnergy")]
    [JsonConverter(typeof(ParseStringConverter))]
    public long LifetimeEnergy { get; set; }

    [JsonPropertyName("outlet")]
    [JsonConverter(typeof(DictionaryToListConverter<Outlet, int>))]
    public List<Outlet> Outlets { get; set; }

    [JsonPropertyName("alarm")]
    public A0Ae260C851900C3Alarm Alarm { get; set; }

    [JsonPropertyName("layout")]
    [JsonConverter(typeof(DictionaryToListConverter<string[], int>))]
    public Dictionary<int, string[]> Layout { get; set; }

    [JsonPropertyName("entity")]
    [JsonConverter(typeof(DictionaryToListConverter<Entity, string>))]
    public List<Entity> Entity { get; set; }
}

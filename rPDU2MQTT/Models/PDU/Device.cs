using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.basePDU;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

public partial class Device : EntityWithNameAndLabel, IEntityWithState
{
    #region State
    string IEntityWithState.State_On => "normal";
    string IEntityWithState.State_Off => "";
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
    public Dictionary<int, Outlet> Outlets { get; set; }

    [JsonPropertyName("alarm")]
    public A0Ae260C851900C3Alarm Alarm { get; set; }

    [JsonPropertyName("layout")]
    public Dictionary<string, string[]> Layout { get; set; }

    [JsonPropertyName("entity")]
    public Dictionary<string, Entity> Entity { get; set; }
}

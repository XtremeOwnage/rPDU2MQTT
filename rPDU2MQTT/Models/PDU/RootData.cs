using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU.DummyDevices;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

public partial class RootData : NamedEntity
{
    /// <summary>
    /// This is the URL used.
    /// </summary>
    [JsonIgnore]
    public string URL { get; set; } = string.Empty;

    [JsonPropertyName("sys")]
    public Sys Sys { get; set; }

    [JsonPropertyName("conf")]
    public DataConf Conf { get; set; }

    [JsonPropertyName("dev")]
    public Dictionary<string, Device> Devices { get; set; }

    [JsonPropertyName("auth")]
    public DataAuth Auth { get; set; }

    [JsonPropertyName("alarm")]
    public DataAlarm Alarm { get; set; }
}

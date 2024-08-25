using rPDU2MQTT.Interfaces;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

public partial class RootData : IMQTTKey
{
    #region IMQTTKey
    /// <remarks>
    /// I don't believe the name field ever changes. Only label...
    /// </remarks>
    [JsonIgnore]
    public string Entity_Identifier { get; set; }

    /// <inheritdoc cref="IMQTTKey.Record_Key"/>
    [JsonIgnore]
    public string Record_Key { get; set; }

    /// <inheritdoc cref="IMQTTKey.Record_Parent"/>
    [JsonIgnore]
    public IMQTTKey? Record_Parent { get; set; }
    #endregion

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

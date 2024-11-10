using rPDU2MQTT.Models.Converters;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace rPDU2MQTT.Models.PDU.OneView;

/// <summary>
/// Base data response-type from ONE-View.
/// </summary>
public partial class OneViewRootData
{
    [JsonPropertyName("conf")]
    public OneViewConf Conf { get; set; }

    [JsonPropertyName("info")]
    public OneViewInfo Info { get; set; }

    [JsonPropertyName("group")]
    [JsonConverter(typeof(DictionaryToListConverter<OneViewGroup, string>))]
    public List<OneViewGroup> Groups { get; set; }

    /// <summary>
    /// CLI info? ToDo - Document exact purpose.
    /// </summary>
    [JsonPropertyName("cli")]
    public OneViewCLI CLI { get; set; }

    /// <summary>
    /// Dictionary of hosts, Key is MAC Address
    /// </summary>
    [JsonPropertyName("host")]
    [JsonConverter(typeof(DictionaryToListConverter<OneViewHost, string>))]
    public List<OneViewHost> Hosts { get; set; } = new();
}

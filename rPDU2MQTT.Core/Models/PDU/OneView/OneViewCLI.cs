using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

/// <summary>
/// Not- exactly sure what this data is for...
/// </summary>
public partial class OneViewCLI
{
    [JsonPropertyName("state")]
    public string State { get; set; }

    [JsonPropertyName("code")]
    public long Code { get; set; }
}

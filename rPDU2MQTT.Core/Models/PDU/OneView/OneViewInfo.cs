using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

/// <summary>
/// Oneview API info?
/// </summary>
public class OneViewInfo
{
    [JsonPropertyName("apiVersion")]
    public string ApiVersion { get; set; }

    [JsonPropertyName("dirtyCount")]
    public long DirtyCount { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; }
}

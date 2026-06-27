using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

public class OneViewConfGDP
{
    [JsonPropertyName("address")]
    public string Address { get; set; }

    [JsonPropertyName("discoveryLimit")]
    public long DiscoveryLimit { get; set; }

    [JsonPropertyName("attempts")]
    public long Attempts { get; set; }

    [JsonPropertyName("sequenceId")]
    public long SequenceId { get; set; }

    [JsonPropertyName("timeout")]
    public long Timeout { get; set; }
}

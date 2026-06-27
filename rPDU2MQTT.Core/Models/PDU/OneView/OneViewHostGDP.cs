using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

/// <summary>
/// Device GDP (Geist Device Protocol)
/// </summary>
public class OneViewHostGDP
{
    [JsonPropertyName("retMsg")]
    public string RetMsg { get; set; }

    [JsonPropertyName("payload")]
    public OneViewDeviceConfig Payload { get; set; }

    [JsonPropertyName("retCode")]
    public long RetCode { get; set; }
}

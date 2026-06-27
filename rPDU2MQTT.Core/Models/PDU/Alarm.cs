using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU;

public class Alarm
{
    [JsonPropertyName("severity")]
    public string Severity { get; set; }

    [JsonPropertyName("state")]
    public string State { get; set; }
}
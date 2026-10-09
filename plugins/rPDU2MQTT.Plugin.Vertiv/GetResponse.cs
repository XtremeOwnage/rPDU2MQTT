using System.Text.Json.Serialization;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Models.PDUResponse;

internal class GetResponse<T>
{
    [JsonPropertyName("data")]
    public T Data { get; set; }

    [JsonPropertyName("retCode")]
    public int RetCode { get; set; }

    [JsonPropertyName("retMsg")]
    public string RetMsg { get; set; }
}
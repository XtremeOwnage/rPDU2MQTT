using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;
/// <summary>
/// Geist rPDU OneView GDP Config (Giest Device Protocol)
/// </summary>
public class OneViewDeviceConfig
{
    [JsonPropertyName("serialNumber")]
    public string SerialNumber { get; set; }

    [JsonPropertyName("adminExists")]
    public bool AdminExists { get; set; }

    [JsonPropertyName("staticAddress")]
    public string StaticAddress { get; set; }

    [JsonPropertyName("dhcpPrefix")]
    public long DhcpPrefix { get; set; }

    [JsonPropertyName("configurable")]
    public bool Configurable { get; set; }

    [JsonPropertyName("dhcpAddress")]
    public string DhcpAddress { get; set; }

    [JsonPropertyName("ip4GW")]
    public string Ip4Gw { get; set; }

    [JsonPropertyName("httpsPort")]
    public long HttpsPort { get; set; }

    [JsonPropertyName("hostname")]
    public string Hostname { get; set; }

    [JsonPropertyName("httpPort")]
    public long HttpPort { get; set; }

    [JsonPropertyName("staticPrefix")]
    public long StaticPrefix { get; set; }

    [JsonPropertyName("model")]
    public string Model { get; set; }

    [JsonPropertyName("dhcpOn")]
    public bool DhcpOn { get; set; }

    [JsonPropertyName("version")]
    public string Version { get; set; }

    [JsonPropertyName("label")]
    public string Label { get; set; }

    [JsonPropertyName("oem")]
    public string Oem { get; set; }
}

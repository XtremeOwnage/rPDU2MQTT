using System.Text.Json;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

public class DeviceConnectionsTests
{
    [Fact]
    public void RPdu_Deserializes_Network_MacAndIp()
    {
        const string json = """
        {
          "sys": { "serialNumber": "ABC", "oem": "GEI" },
          "conf": {
            "network": {
              "ethernet": {
                "macAddr": "00:19:85:0c:26:ae",
                "address": { "1": { "mutable": true, "prefix": 24, "address": "10.100.0.11" } }
              }
            }
          }
        }
        """;

        var pdu = JsonSerializer.Deserialize<rPDU>(json);

        Assert.NotNull(pdu);
        Assert.Equal("00:19:85:0c:26:ae", pdu!.Conf?.Network?.Ethernet?.MacAddr);
        Assert.Equal("10.100.0.11", pdu.Conf?.Network?.Ethernet?.Address?.The1?.Address);
    }
}

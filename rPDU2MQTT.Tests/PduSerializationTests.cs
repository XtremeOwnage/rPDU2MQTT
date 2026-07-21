using System.Text.Json;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// PduData ships across grains in v3, which serializes it — so DictionaryToListConverter's Write (long a
/// NotSupportedException stub) must round-trip. These lock that: the keyed collections survive
/// serialize → deserialize with their keys intact.
/// </summary>
public class PduSerializationTests
{
    [Fact]
    public void Device_KeyedCollections_RoundTripThroughJson()
    {
        var device = new Device
        {
            Key = "pdu1",
            Outlets = { new Outlet { Key = 3 }, new Outlet { Key = 7 } },
            Entity = { new Entity { Key = "voltage" } },
        };

        var json = JsonSerializer.Serialize(device);           // Write (previously threw)
        var back = JsonSerializer.Deserialize<Device>(json)!;  // Read re-keys from the dictionary form

        Assert.Equal(new[] { 3, 7 }, back.Outlets.Select(o => o.Key).OrderBy(k => k));
        Assert.Equal("voltage", Assert.Single(back.Entity).Key);
    }
}

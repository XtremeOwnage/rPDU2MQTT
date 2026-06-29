using System.Text.Json;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The cross-process transport (#127) serializes a <see cref="RawSnapshot"/> on a worker and reads it back
/// on a consumer. This locks that contract: the raw source data (device/outlet/measurement identity +
/// readings) survives PduData -> wire -> JSON -> wire -> PduData. (Derived display names are intentionally
/// not carried — the consumer regenerates them via the naming/override transform.)
/// </summary>
public class RawSnapshotTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static PduData SampleData()
    {
        var outlet = new Outlet { Key = 3, Name = "outlet3", Label = "Server", State = "on" };
        outlet.Measurements.Add(new Measurement { Key = "realpower", Type = "realpower", Value = "123", Units = "W", State = "normal" });
        var device = new Device { Key = "pdu1", Name = "pdu1", Label = "Rack PDU 1", State = "normal", Type = "device" };
        device.Outlets.Add(outlet);
        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }

    [Fact]
    public void RawSnapshot_RoundTrips_ThroughJsonAndBackToPduData()
    {
        var wire = RawSnapshotMapper.ToWire("pdu1", new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc), SampleData());

        var json = JsonSerializer.Serialize(wire, Json);
        var backWire = JsonSerializer.Deserialize<RawSnapshot>(json, Json)!;
        var data = RawSnapshotMapper.ToData(backWire);

        Assert.Equal("pdu1", backWire.InstanceId);
        Assert.Equal(new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc), backWire.TimestampUtc);

        var d = Assert.Single(data.Devices);
        Assert.Equal("pdu1", d.Key);            // the keys the API models drop on (de)serialization
        Assert.Equal("pdu1", d.Name);
        Assert.Equal("Rack PDU 1", d.Label);
        Assert.Equal("normal", d.State);
        Assert.Equal("device", d.Type);

        var o = Assert.Single(d.Outlets);
        Assert.Equal(3, o.Key);
        Assert.Equal("Server", o.Label);
        Assert.Equal("on", o.State);

        var m = Assert.Single(o.Measurements);
        Assert.Equal("realpower", m.Key);
        Assert.Equal("realpower", m.Type);
        Assert.Equal("123", m.Value);
        Assert.Equal("W", m.Units);
        Assert.Equal("normal", m.State);
    }

    [Fact]
    public void ToWire_PreservesStructureAndCounts()
    {
        var wire = RawSnapshotMapper.ToWire("inst", DateTime.UtcNow, SampleData());

        var device = Assert.Single(wire.Devices);
        var outlet = Assert.Single(device.Outlets);
        Assert.Single(outlet.Measurements);
        Assert.Equal(3, outlet.Key);
        Assert.Equal("realpower", outlet.Measurements[0].Type);
    }
}

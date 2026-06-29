using System.Text.Json;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The cross-process transport (#127) serializes a <see cref="RawSnapshot"/> on a worker and reads it back
/// on a consumer. This locks that contract: the data a consumer renders — keys, raw source name/label, the
/// computed display identity (Entity_Name/DisplayName/Make/Model), measurements, and device entities —
/// survives PduData -> wire -> JSON -> wire -> PduData.
/// </summary>
public class RawSnapshotTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static PduData SampleData()
    {
        var outlet = new Outlet
        {
            Key = 3, Name = "outlet3", Label = "Server", State = "on",
            Entity_Name = "rack_pdu_1_outlet_3", Entity_DisplayName = "Server", Entity_Make = "Vertiv", Entity_Model = "Geist",
        };
        outlet.Measurements.Add(new Measurement
        {
            Key = "realpower", Type = "realpower", Value = "123", Units = "W", State = "normal",
            Entity_Name = "rack_pdu_1_outlet_3_realpower", Entity_DisplayName = "Real Power",
        });

        var deviceEntity = new Entity { Key = "total", Name = "total", Label = "Total", Entity_Name = "rack_pdu_1_total", Entity_DisplayName = "Total" };
        deviceEntity.Measurements.Add(new Measurement { Key = "realpower", Type = "realpower", Value = "500", Units = "W", State = "normal", Entity_Name = "rack_pdu_1_total_realpower", Entity_DisplayName = "Real Power" });

        var device = new Device
        {
            Key = "pdu1", Name = "pdu1", Label = "Rack PDU 1", State = "normal", Type = "device",
            Entity_Name = "rack_pdu_1", Entity_DisplayName = "Rack PDU 1", Entity_Make = "Vertiv", Entity_Model = "Geist",
        };
        device.Outlets.Add(outlet);
        device.Entity.Add(deviceEntity);

        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }

    [Fact]
    public void RawSnapshot_RoundTrips_PreservingFinishedConsumerData()
    {
        var wire = RawSnapshotMapper.ToWire("pdu1", new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc), SampleData());

        var json = JsonSerializer.Serialize(wire, Json);
        var data = RawSnapshotMapper.ToData(JsonSerializer.Deserialize<RawSnapshot>(json, Json)!);

        var d = Assert.Single(data.Devices);
        Assert.Equal("pdu1", d.Key);
        Assert.Equal("Rack PDU 1", d.Label);          // raw source (for the Overrides editor)
        Assert.Equal("rack_pdu_1", d.Entity_Name);     // computed identity (object_id)
        Assert.Equal("Rack PDU 1", d.Entity_DisplayName);
        Assert.Equal("Vertiv", d.Entity_Make);
        Assert.Equal("Geist", d.Entity_Model);

        var o = Assert.Single(d.Outlets);
        Assert.Equal(3, o.Key);
        Assert.Equal("Server", o.Entity_DisplayName);
        var om = Assert.Single(o.Measurements);
        Assert.Equal("realpower", om.Type);
        Assert.Equal("123", om.Value);
        Assert.Equal("Real Power", om.Entity_DisplayName);

        var e = Assert.Single(d.Entity);
        Assert.Equal("rack_pdu_1_total", e.Entity_Name);
        Assert.Equal("500", Assert.Single(e.Measurements).Value);
    }
}

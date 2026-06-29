using System.Text.Json;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The MQTT bus bridge maps an in-process <see cref="PduSnapshot"/> to the <see cref="RawSnapshot"/> wire
/// form on a worker and back on a consumer. These lock the topic convention and that the worker's raw poll
/// survives the publish/ingest hop intact.
/// </summary>
public class MqttBusBridgeTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Fact]
    public void TopicFor_NestsInstanceUnderTheBusNamespace()
    {
        Assert.Equal("rpdu/_bus/snapshot/pdu1", MqttBusBridge.TopicFor("rpdu", "pdu1"));
    }

    [Fact]
    public void WorkerToConsumer_HopPreservesTheRawPoll()
    {
        var outlet = new Outlet { Key = 1, Name = "o1", Label = "NAS", State = "on" };
        outlet.Measurements.Add(new Measurement { Key = "realpower", Type = "realpower", Value = "42", Units = "W", State = "normal" });
        var device = new Device { Key = "pdu1", Name = "pdu1", Label = "PDU 1", State = "normal", Type = "device" };
        device.Outlets.Add(outlet);
        var data = new PduData();
        data.Devices.Add(device);

        // Worker side: snapshot -> wire -> JSON (what gets published).
        var snapshot = new PduSnapshot("pdu1", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc), data);
        var wireJson = JsonSerializer.Serialize(
            RawSnapshotMapper.ToWire(snapshot.InstanceId, snapshot.TimestampUtc, snapshot.Data), Json);

        // Consumer side: JSON -> wire -> PduSnapshot (what lands on the consumer's bus).
        var wire = JsonSerializer.Deserialize<RawSnapshot>(wireJson, Json)!;
        var ingested = new PduSnapshot(wire.InstanceId, wire.TimestampUtc, RawSnapshotMapper.ToData(wire));

        Assert.Equal("pdu1", ingested.InstanceId);
        Assert.Equal(snapshot.TimestampUtc, ingested.TimestampUtc);
        var d = Assert.Single(ingested.Data.Devices);
        Assert.Equal("pdu1", d.Key);
        var o = Assert.Single(d.Outlets);
        Assert.Equal(1, o.Key);
        Assert.Equal("NAS", o.Label);
        Assert.Equal("42", Assert.Single(o.Measurements).Value);
    }
}

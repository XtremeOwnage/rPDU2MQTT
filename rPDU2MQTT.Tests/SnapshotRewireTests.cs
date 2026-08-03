using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A snapshot that crosses the wire must come back publishable.
///
/// <para>
/// <c>Record_Key</c> and <c>Record_Parent</c> are <c>[JsonIgnore]</c>, so they do not survive, and
/// <c>GetTopicPath()</c> walks exactly that chain. Without them a measurement published to the bare topic
/// <c>state</c> — which is why every Home Assistant sensor read "Unavailable" while discovery, which builds
/// its ids by another route, looked healthy.
/// </para>
/// </summary>
public class SnapshotRewireTests
{
    private const string ParentTopic = "Rack_PDU";
    private const string RootId = "rPDU2MQTT";

    /// <summary>The graph as the poller builds it, wired the way PDU.processOneViewData wires it.</summary>
    private static (PduData Data, DummyEntity Root) Original()
    {
        var m = new Measurement { Key = "realpower", Type = "realpower", Value = "61", Units = "W", State = "state" };
        var outlet = new Outlet { Key = 3, Name = "Outlet 3", Label = "Kube01", State = "on" };
        outlet.Measurements.Add(m);
        var device = new Device { Key = "pdu_1", Name = "Rack-PDU-1", Label = "Rack-PDU-1", State = "on", Type = "rpdu" };
        device.Outlets.Add(outlet);

        var data = new PduData();
        data.Devices.Add(device);

        var root = new DummyEntity { Record_Key = ParentTopic, Record_Parent = null, Entity_Identifier = RootId };
        data.Devices.SetParentAndIdentifier(root, o => o.Key);
        foreach (var d in data.Devices)
        {
            d.Outlets.SetParentAndIdentifier(BaseEntity.FromDevice(d, MqttPath.Outlets), o => o.Key.ToString());
            foreach (var o in d.Outlets)
                o.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(o, MqttPath.Measurements), x => x.Type);
        }
        return (data, root);
    }

    private static Measurement FirstMeasurement(PduData d) => d.Devices[0].Outlets[0].Measurements[0];

    [Fact]
    public void WithoutRewiring_AMeasurementPublishesToTheBareTopic_state()
    {
        // The bug, reproduced. This is the topic the live system was trying to publish to, and the broker
        // never acknowledged it.
        var wire = RawSnapshotMapper.ToWire("default", DateTime.UtcNow, Original().Data);
        var rebuilt = RawSnapshotMapper.ToData(wire);

        var topic = FirstMeasurement(rebuilt).GetTopicPath();

        Assert.DoesNotContain(ParentTopic, topic);
        Assert.DoesNotContain("outlets", topic);
    }

    [Fact]
    public void AfterRewiring_TheTopicIsIdenticalToTheOneThePollerWouldPublish()
    {
        var (original, _) = Original();
        var expected = FirstMeasurement(original).GetTopicPath();

        var rebuilt = RawSnapshotMapper.ToData(RawSnapshotMapper.ToWire("default", DateTime.UtcNow, original));
        RawSnapshotMapper.Rewire(rebuilt, ParentTopic, RootId);

        Assert.Equal(expected, FirstMeasurement(rebuilt).GetTopicPath());
        Assert.StartsWith(ParentTopic, FirstMeasurement(rebuilt).GetTopicPath());
    }

    [Fact]
    public void AfterRewiring_EveryEntityIdentifierIsUnchanged()
    {
        // The one that must not drift. Entity_Identifier is the Home Assistant unique_id: a rewire that
        // produced different ids would not fail — it would silently mint a second device for every outlet
        // and orphan the originals, which is a mess that outlives the fix.
        var (original, _) = Original();
        var rebuilt = RawSnapshotMapper.ToData(RawSnapshotMapper.ToWire("default", DateTime.UtcNow, original));
        RawSnapshotMapper.Rewire(rebuilt, ParentTopic, RootId);

        Assert.Equal(original.Devices[0].Entity_Identifier, rebuilt.Devices[0].Entity_Identifier);
        Assert.Equal(original.Devices[0].Outlets[0].Entity_Identifier, rebuilt.Devices[0].Outlets[0].Entity_Identifier);
        Assert.Equal(FirstMeasurement(original).Entity_Identifier, FirstMeasurement(rebuilt).Entity_Identifier);
    }

    [Fact]
    public void AfterRewiring_TheDeviceAndOutletTopicsAlsoMatch()
    {
        var (original, _) = Original();
        var rebuilt = RawSnapshotMapper.ToData(RawSnapshotMapper.ToWire("default", DateTime.UtcNow, original));
        RawSnapshotMapper.Rewire(rebuilt, ParentTopic, RootId);

        Assert.Equal(original.Devices[0].GetTopicPath(), rebuilt.Devices[0].GetTopicPath());
        Assert.Equal(original.Devices[0].Outlets[0].GetTopicPath(), rebuilt.Devices[0].Outlets[0].GetTopicPath());
    }

    [Fact]
    public void RewiringIsIdempotent()
    {
        // The sync service rebuilds on a timer; running it twice must not compound the path or the id.
        var (original, _) = Original();
        var rebuilt = RawSnapshotMapper.ToData(RawSnapshotMapper.ToWire("default", DateTime.UtcNow, original));
        RawSnapshotMapper.Rewire(rebuilt, ParentTopic, RootId);
        var once = FirstMeasurement(rebuilt).GetTopicPath();
        var onceId = FirstMeasurement(rebuilt).Entity_Identifier;

        RawSnapshotMapper.Rewire(rebuilt, ParentTopic, RootId);

        Assert.Equal(once, FirstMeasurement(rebuilt).GetTopicPath());
        Assert.Equal(onceId, FirstMeasurement(rebuilt).Entity_Identifier);
    }
}

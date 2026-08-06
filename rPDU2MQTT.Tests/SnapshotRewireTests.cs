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
        var outlet = new Outlet
        {
            Key = 3, Name = "Outlet 3", Label = "Kube01", State = "on",
            OnDelay = 5, OffDelay = 5, RebootDelay = 5, PoaAction = "last",
        };
        outlet.Measurements.Add(m);
        var device = new Device
        {
            Key = "pdu_1", Name = "Rack-PDU-1", Label = "Rack-PDU-1", State = "on", Type = "rpdu",
            Layout = new Dictionary<int, string[]> { [0] = ["entity/phase0"], [2] = ["outlet/3"] },
        };
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
    public void AnActiveAlarmSurvivesTheWire_OnTheDeviceOutletAndMeasurement()
    {
        // The publisher emits "none" when the alarm object is absent, so an alarm lost in transit is
        // published as a no-problem state rather than as an error. The wire contract lists fields
        // explicitly, so an omitted one is dropped without any diagnostic.
        var (data, _) = Original();
        var device = data.Devices[0];
        var outlet = device.Outlets[0];
        var measurement = outlet.Measurements[0];
        device.Alarm = new Alarm { State = "active", Severity = "alarm" };
        outlet.Alarm = new Alarm { State = "active", Severity = "warning" };
        measurement.Alarm = new Alarm { State = "active", Severity = "alarm" };

        var rebuilt = RawSnapshotMapper.ToData(RawSnapshotMapper.ToWire("default", DateTime.UtcNow, data));

        Assert.Equal("active", rebuilt.Devices[0].Alarm?.State);
        Assert.Equal("alarm", rebuilt.Devices[0].Alarm?.Severity);
        Assert.Equal("active", rebuilt.Devices[0].Outlets[0].Alarm?.State);
        Assert.Equal("warning", rebuilt.Devices[0].Outlets[0].Alarm?.Severity);
        Assert.Equal("active", FirstMeasurement(rebuilt).Alarm?.State);
        Assert.Equal("alarm", FirstMeasurement(rebuilt).Alarm?.Severity);
    }

    [Fact]
    public void NoAlarmStaysNoAlarm_RatherThanBecomingAnEmptyOne()
    {
        // A missing alarm object must stay missing. A blank one would create an always-off "problem"
        // entity for every measurement of every outlet.
        var (data, _) = Original();
        var rebuilt = RawSnapshotMapper.ToData(RawSnapshotMapper.ToWire("default", DateTime.UtcNow, data));

        Assert.Null(rebuilt.Devices[0].Alarm);
        Assert.Null(rebuilt.Devices[0].Outlets[0].Alarm);
        Assert.Null(FirstMeasurement(rebuilt).Alarm);
    }

    [Fact]
    public void TheOutletConfigurationSurvivesTheWire()
    {
        // These back the writable delay and power-on-action entities in Home Assistant. Dropped from the
        // contract, they arrived as 0 and "", so the entities reported defaults rather than what the outlet
        // was actually set to; on the live PDU the outlet held onDelay/offDelay/rebootDelay of 5 and a
        // poaAction of "last", and the broker carried 0, 0, 0 and empty.
        var (data, _) = Original();

        var rebuilt = RawSnapshotMapper.ToData(RawSnapshotMapper.ToWire("default", DateTime.UtcNow, data));
        var outlet = rebuilt.Devices[0].Outlets[0];

        Assert.Equal(5, outlet.OnDelay);
        Assert.Equal(5, outlet.OffDelay);
        Assert.Equal(5, outlet.RebootDelay);
        Assert.Equal("last", outlet.PoaAction);
    }

    [Fact]
    public void TheDeviceLayoutSurvivesTheWire()
    {
        // Home Assistant discovery reads layout[0] to identify the device's root entity and discover its
        // measurements. Without the layout that step is skipped: the readings still reach the broker, but
        // no sensor is created for them.
        var (data, _) = Original();

        var rebuilt = RawSnapshotMapper.ToData(RawSnapshotMapper.ToWire("default", DateTime.UtcNow, data));

        Assert.NotNull(rebuilt.Devices[0].Layout);
        Assert.Equal(["entity/phase0"], rebuilt.Devices[0].Layout[0]);
    }

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

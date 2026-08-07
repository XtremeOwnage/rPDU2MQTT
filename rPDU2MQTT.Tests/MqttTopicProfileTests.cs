using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Matching readings by topic shape, for publishers that do not announce Home Assistant discovery.
/// A raw topic states no unit, so a match proposes the device, measure and metric only.
/// </summary>
public class MqttTopicProfileTests
{
    private static MqttTopicProfile.Profile Esphome => MqttTopicProfile.ById("esphome")!;
    private static MqttTopicProfile.Profile Zwave => MqttTopicProfile.ById("zwavejs")!;

    [Fact]
    public void EsphomeSensorTopicsMatch()
    {
        (string, string?)[] topics =
        [
            ("esphome/devices/bedroom_fan/sensor/power/state", "101.8"),
            ("esphome/devices/bedroom_fan/sensor/energy_d/state", "113.783"),
            ("esphome/devices/bedroom_fan/sensor/wifi_signal/state", "-70"),   // not a roll-up reading
            ("esphome/devices/bt_proxy/sensor/uptime/state", "1129146"),       // nor this
        ];

        var found = MqttTopicProfile.Scan(Esphome, topics);

        Assert.Equal(2, found.Count);
        Assert.Equal(["energy", "realpower"], found.Select(f => f.Metric));
        Assert.All(found, f => Assert.Equal("bedroom_fan", f.Device));
        // The payload is carried through so the unit can be judged: 113.783 for a fan is Wh, not kWh, and
        // nothing in the topic says which.
        Assert.Contains(found, f => f.Sample == "113.783");
        Assert.All(found, f => Assert.Null(f.JsonField));
    }

    [Fact]
    public void ZwaveMeterTopicsMatchAndReadTheValueField()
    {
        (string, string?)[] topics =
        [
            ("zwave/Hallway/Hallway_Light/50/0/value/66049", """{"time":1,"value":0.8}"""),
            ("zwave/Hallway/Hallway_Light/50/0/value/65537", """{"time":1,"value":11.975}"""),
            ("zwave/Hallway/Thermostat/49/0/Air_temperature", """{"time":1,"value":74}"""),   // not command class 50
            ("zwave/Hallway/Hallway_Light/lastActive", """{"time":1}"""),
        ];

        var found = MqttTopicProfile.Scan(Zwave, topics);

        Assert.Equal(2, found.Count);
        Assert.All(found, f => Assert.Equal("Hallway_Light", f.Device));
        Assert.All(found, f => Assert.Equal("value", f.JsonField));
        Assert.Equal(["energy", "realpower"], found.Select(f => f.Metric).Order());
    }

    [Fact]
    public void SegmentCountsMustAgreeExactly()
    {
        // A prefix match would capture a sibling topic whose extra segments change what the value means —
        // zwave/../50/0/value/66049 is watts, and anything below it is not.
        Assert.Null(MqttTopicProfile.Match("esphome/devices/{device}/sensor/{measure}/state",
                                           "esphome/devices/fan/sensor/power/state/extra", null, null));
        Assert.Null(MqttTopicProfile.Match("esphome/devices/{device}/sensor/{measure}/state",
                                           "esphome/devices/fan/sensor/power", null, null));
    }

    [Fact]
    public void ALiteralSegmentThatDiffersDoesNotMatch()
        => Assert.Null(MqttTopicProfile.Match("esphome/devices/{device}/sensor/{measure}/state",
                                              "esphome/gadgets/fan/sensor/power/state", null, null));

    [Fact]
    public void AWildcardSegmentMatchesAnythingWithoutCapturing()
    {
        var m = MqttTopicProfile.Match("zwave/+/{device}/50/+/value/{measure}",
                                       "zwave/Kitchen/Kitchen_Light/50/0/value/65537", "value", null);
        Assert.NotNull(m);
        Assert.Equal("Kitchen_Light", m!.Value.Device);
        Assert.Equal("65537", m.Value.Measure);
    }

    [Fact]
    public void AnUnknownMeasureMatchesWithNoMetric()
    {
        // Matched but unclassified: the picker can show it, and nothing pretends to know what it is.
        var m = MqttTopicProfile.Match(Esphome.Pattern, "esphome/devices/fan/sensor/lux/state", null, Esphome.Metrics);
        Assert.NotNull(m);
        Assert.Null(m!.Value.Metric);
    }

    [Fact]
    public void ScanKeepsOnlyRollupMetricsByDefault()
    {
        // Voltage and current are matched by the profile but are not part of the energy roll-up.
        (string, string?)[] topics =
        [
            ("esphome/devices/fan/sensor/voltage/state", "122.7"),
            ("esphome/devices/fan/sensor/current/state", "0.8"),
            ("esphome/devices/fan/sensor/power/state", "101.8"),
        ];

        Assert.Equal("realpower", Assert.Single(MqttTopicProfile.Scan(Esphome, topics)).Metric);
        Assert.Equal(3, MqttTopicProfile.Scan(Esphome, topics, rollupOnly: false).Count);
    }

    [Fact]
    public void BuiltInProfilesAreAddressableById()
    {
        Assert.Equal("ESPHome", MqttTopicProfile.ById("esphome")!.Label);
        Assert.Equal("Z-Wave JS", MqttTopicProfile.ById("ZWAVEJS")!.Label);
        Assert.Null(MqttTopicProfile.ById("nope"));
        Assert.Null(MqttTopicProfile.ById(null));
    }
}

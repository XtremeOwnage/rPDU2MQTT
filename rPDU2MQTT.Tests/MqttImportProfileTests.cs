using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Topic shapes the operator defines, for publishers with no built-in profile.
/// </summary>
public class MqttImportProfileTests
{
    private static List<MqttImportProfile> Configured(params MqttImportProfile[] p) => [.. p];

    private static MqttImportProfile Tasmota() => new()
    {
        Name = "Tasmota",
        Filter = "tele/#",
        Pattern = "tele/{device}/SENSOR/{measure}",
        JsonField = "ENERGY.Power",
        Metrics = new() { ["Power"] = "realpower", ["Total"] = "energy" },
    };

    [Fact]
    public void AConfiguredProfileResolvesAndScans()
    {
        var p = MqttTopicProfile.Resolve("custom:Tasmota", Configured(Tasmota()));

        Assert.NotNull(p);
        Assert.Equal("Tasmota", p!.Label);
        Assert.Equal("ENERGY.Power", p.JsonField);

        var found = MqttTopicProfile.Scan(p, [("tele/kitchen/SENSOR/Power", "{}"), ("tele/kitchen/STATE", "{}")]);
        var one = Assert.Single(found);
        Assert.Equal("kitchen", one.Device);
        Assert.Equal("realpower", one.Metric);
    }

    [Fact]
    public void ResolutionIsCaseInsensitiveOnTheName()
        => Assert.NotNull(MqttTopicProfile.Resolve("custom:tasmota", Configured(Tasmota())));

    [Fact]
    public void ABuiltInIdStillWins()
    {
        // Built-ins and configured profiles occupy separate id spaces.
        Assert.Equal("ESPHome", MqttTopicProfile.Resolve("esphome", Configured(Tasmota()))!.Label);
    }

    [Fact]
    public void AProfileWithNoPatternDoesNotResolve()
    {
        // A half-entered profile matches nothing.
        var blank = new MqttImportProfile { Name = "Half", Filter = "x/#", Pattern = "  " };
        Assert.Null(MqttTopicProfile.Resolve("custom:Half", Configured(blank)));
    }

    [Fact]
    public void AMissingFilterFallsBackToThePatternsRoot()
    {
        // Not "#", which some broker ACLs refuse.
        var p = new MqttImportProfile { Name = "NoFilter", Pattern = "tele/{device}/SENSOR/{measure}" };

        Assert.Equal("tele/#", MqttTopicProfile.Resolve("custom:NoFilter", Configured(p))!.Filter);
    }

    [Fact]
    public void AnUnknownOrAbsentProfileResolvesToNothing()
    {
        Assert.Null(MqttTopicProfile.Resolve("custom:Nope", Configured(Tasmota())));
        Assert.Null(MqttTopicProfile.Resolve("custom:Tasmota", null));
        Assert.Null(MqttTopicProfile.Resolve(null, Configured(Tasmota())));
    }

    [Fact]
    public void MeasureMatchingIgnoresCase()
    {
        // The map is written in config; the measure comes off the wire.
        var p = MqttTopicProfile.Resolve("custom:Tasmota", Configured(Tasmota()))!;
        var m = MqttTopicProfile.Match(p.Pattern, "tele/kitchen/SENSOR/power", p.JsonField, p.Metrics);

        Assert.Equal("realpower", m!.Value.Metric);
    }

    /// <summary>A measure mapped to the daily metric is a counter the device zeroes each day.</summary>
    [Fact]
    public void AMeasureMappedToTheDailyMetric_ImportsAsEnergyWithAPeriodCounter()
    {
        var p = MqttTopicProfile.Resolve("esphome", null);

        var found = MqttTopicProfile.Scan(p!, [
            ("esphome/devices/fridge/sensor/energy_d/state", "70.688"),
            ("esphome/devices/fridge/sensor/energy/state", "1200.5"),
        ]);

        var daily = found.Single(m => m.Measure == "energy_d");
        Assert.Equal("energy", daily.Metric);
        Assert.Equal("period", daily.Accumulation);

        // A lifetime counter is left alone: only the profile saying so makes it a daily one.
        var lifetime = found.Single(m => m.Measure == "energy");
        Assert.Equal("energy", lifetime.Metric);
        Assert.Null(lifetime.Accumulation);
    }

    /// <summary>A profile of the operator's own says it the same way.</summary>
    [Fact]
    public void AConfiguredProfileCanDeclareADailyResetCounter()
    {
        var profile = Tasmota();
        profile.Metrics["Today"] = "energy_d";

        var p = MqttTopicProfile.Resolve("custom:Tasmota", Configured(profile));
        var m = MqttTopicProfile.Scan(p!, [("tele/kitchen/SENSOR/Today", "0.9")]).Single();

        Assert.Equal("energy", m.Metric);
        Assert.Equal("period", m.Accumulation);
    }

    /// <summary>A profile's own tags travel with it, so what it imports can be filtered as a group.</summary>
    [Fact]
    public void AProfileCarriesItsDefaultTags()
    {
        var profile = Tasmota();
        profile.Tags = ["imported", "  ", "tasmota"];

        var p = MqttTopicProfile.Resolve("custom:Tasmota", Configured(profile));

        // Blank entries are dropped: a tag nothing can match is a filter that silently never fires.
        Assert.Equal(["imported", "tasmota"], p!.Tags);
        // A built-in tags nothing of its own.
        Assert.Empty(MqttTopicProfile.Resolve("esphome", null)!.Tags ?? []);
    }

    /// <summary>
    /// One ESPHome node reporting many channels names both in a single segment:
    /// esphome/devices/n30/sensor/n30_2_1_current/state is channel n30_2_1 measuring current.
    /// </summary>
    [Fact]
    public void APlaceholderPairInOneSegment_SplitsIntoChannelAndMeasure()
    {
        var p = MqttTopicProfile.Resolve("esphome_channels", null);

        var found = MqttTopicProfile.Scan(p!, [
            ("esphome/devices/n30/sensor/n30_2_1_current/state", "1.139"),
            ("esphome/devices/n30/sensor/bl0910_1_frequency/state", "60.01"),
            // Not one of ours: no metric maps it, so it is not offered for import.
            ("esphome/devices/n30/sensor/bl0910_1_tps1/state", "22.4"),
        ]);

        Assert.Equal(2, found.Count);
        var current = found.Single(m => m.Measure == "current");
        Assert.Equal("n30_2_1", current.Device);
        Assert.Equal("current", current.Metric);
        Assert.Equal("bl0910_1", found.Single(m => m.Measure == "frequency").Device);
    }

    /// <summary>
    /// Where the segment splits is ambiguous, so the metric map decides it: n30_2_1_apparent_power is not
    /// channel 'n30_2_1_apparent' measuring 'power'.
    /// </summary>
    [Fact]
    public void AMeasureCarryingTheSeparator_IsResolvedByTheMetricMap()
    {
        var p = MqttTopicProfile.Resolve("esphome_channels", null);

        var m = MqttTopicProfile.Scan(p!, [("esphome/devices/n30/sensor/n30_2_1_apparent_power/state", "12")]).Single();

        Assert.Equal("n30_2_1", m.Device);
        Assert.Equal("apparent_power", m.Measure);
        Assert.Equal("apparentpower", m.Metric);
    }

    /// <summary>A segment that does not carry both parts is not this profile's shape.</summary>
    [Fact]
    public void ASingleSensorTopic_DoesNotMatchTheMultiChannelShape()
        => Assert.Empty(MqttTopicProfile.Scan(
            MqttTopicProfile.Resolve("esphome_channels", null)!,
            [("esphome/devices/fridge/sensor/power/state", "97.6")]));

    /// <summary>The other order, and a profile of the operator's own: the measure leads.</summary>
    [Fact]
    public void TheMeasureMayComeFirstInTheSegment()
    {
        var profile = new MqttImportProfile
        {
            Name = "Leading", Filter = "x/#", Pattern = "x/{measure}-{device}",
            Metrics = new() { ["power"] = "realpower" },
        };

        var m = MqttTopicProfile.Scan(MqttTopicProfile.Resolve("custom:Leading", Configured(profile))!,
                                      [("x/power-rack_1", "41")]).Single();

        Assert.Equal("rack_1", m.Device);
        Assert.Equal("power", m.Measure);
    }
}

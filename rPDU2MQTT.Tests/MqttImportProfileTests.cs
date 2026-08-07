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
}

using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>PrometheusLabels: the configurable exporter label set (#188).</summary>
public class PrometheusLabelsTests
{
    private static MeasurementReading Reading() =>
        new("rack_pdu_1", "o0", "realpower", 60, "W", "id", "topic", "Server A", 1);

    [Fact]
    public void Names_DefaultsToLegacySet_AndFiltersUnknown()
    {
        var c = new Config();
        Assert.Equal(new[] { "device", "source", "units" }, PrometheusLabels.Names(c));   // default = back-compat

        c.Prometheus.Labels = new() { "Device", "bogus", "instance", "device" };          // case/dupe/unknown
        Assert.Equal(new[] { "device", "instance" }, PrometheusLabels.Names(c));

        c.Prometheus.Labels = new() { "bogus" };                                          // nothing valid -> defaults
        Assert.Equal(new[] { "device", "source", "units" }, PrometheusLabels.Names(c));
    }

    [Fact]
    public void Values_ResolveEverySupportedLabel_InOrder()
    {
        var c = new Config();
        var names = new[] { "device", "source", "name", "number", "type", "units", "instance", "hierarchy" };

        var v = PrometheusLabels.Values(names, Reading(), c, instance: "pdu-a", hierarchy: "Servers Circuit");

        Assert.Equal(new[] { "rack_pdu_1", "o0", "Server A", "1", "realpower", "W", "pdu-a", "Servers Circuit" }, v);
    }

    [Fact]
    public void Values_TypeHonoursMeasurementOverrideId()
    {
        var c = new Config();
        c.Overrides.Measurements["realpower"] = new() { ID = "power" };

        var v = PrometheusLabels.Values(new[] { "type" }, Reading(), c, "", "");

        Assert.Equal("power", v[0]);
    }
}

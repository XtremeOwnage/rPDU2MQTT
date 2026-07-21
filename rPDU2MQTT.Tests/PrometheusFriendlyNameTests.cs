using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// #206: a scraped series should be readable without knowing this project's vocabulary — the device and
/// outlet as they're *called*, and the measurement said in English.
/// </summary>
public class PrometheusFriendlyNameTests
{
    private static MeasurementReading Reading(string device = "rack_pdu", string deviceName = "Rack PDU",
        string source = "outlet_10", string sourceName = "Dell MD1200", string type = "realpower", string units = "W")
        => new(device, source, type, 123.4, units, "id", "topic", sourceName, 10, deviceName);

    [Fact]
    public void FriendlyTypeName_SaysItInEnglish()
    {
        Assert.Equal("Real Power", MetricsHelper.FriendlyTypeName("realpower"));
        Assert.Equal("Apparent Power", MetricsHelper.FriendlyTypeName("apparentpower"));
        Assert.Equal("Power Factor", MetricsHelper.FriendlyTypeName("powerfactor"));
        Assert.Equal("Energy", MetricsHelper.FriendlyTypeName("ENERGY"));   // case-insensitive

        // An unknown type is still shown, just title-cased — dropping it would be worse than imperfect.
        Assert.Equal("Wobbliness", MetricsHelper.FriendlyTypeName("wobbliness"));
        Assert.Equal("", MetricsHelper.FriendlyTypeName(null));
    }

    [Fact]
    public void Friendly_Labels_CarryTheDisplayNames()
    {
        var cfg = new Config();
        cfg.Prometheus.Labels = new() { "device", "device_name", "source", "name", "type", "type_name" };

        var names = PrometheusLabels.Names(cfg);
        var values = PrometheusLabels.Values(names, Reading(), cfg, "default", "");

        var byName = names.Zip(values).ToDictionary(p => p.First, p => p.Second);
        Assert.Equal("rack_pdu", byName["device"]);          // the object-id form, unchanged
        Assert.Equal("Rack PDU", byName["device_name"]);     // ...and what it's actually called
        Assert.Equal("outlet_10", byName["source"]);
        Assert.Equal("Dell MD1200", byName["name"]);
        Assert.Equal("realpower", byName["type"]);
        Assert.Equal("Real Power", byName["type_name"]);
    }

    [Fact]
    public void DeviceName_FallsBackToTheId_WhenThereIsntOne()
    {
        var cfg = new Config();
        cfg.Prometheus.Labels = new() { "device_name" };

        var names = PrometheusLabels.Names(cfg);
        Assert.Equal("rack_pdu", PrometheusLabels.Values(names, Reading(deviceName: ""), cfg, "default", "").Single());
    }

    [Fact]
    public void DefaultLabelSet_IsUnchanged()
    {
        // Adding a label to every series by default would change the identity of every existing time series
        // and break continuity in anyone's dashboards — the friendly ones are opt-in for that reason.
        Assert.Equal(new[] { "device", "source", "units" }, PrometheusLabels.Names(new Config()));
    }
}

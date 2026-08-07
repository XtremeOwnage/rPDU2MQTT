using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Importing power and energy readings other integrations announce over Home Assistant MQTT discovery.
/// The import binds a topic to a metric, so a reading whose meaning is not stated is refused.
/// </summary>
public class MqttDiscoveryImportTests
{
    private static readonly string[] Ours = ["energyflow_", "rPDU2MQTT_"];

    [Fact]
    public void AnEsphomePowerSensorIsImportable()
    {
        // ESPHome: one entity per config topic, bare value on the state topic, no template.
        const string json = """
        {"device":{"name":"Garage Meter","identifiers":["esp-garage"]},
         "name":"Power","unique_id":"esp_garage_power","device_class":"power",
         "unit_of_measurement":"W","state_topic":"esphome/garage/sensor/power/state"}
        """;

        var r = Assert.Single(MqttDiscoveryImport.Parse(json, Ours));
        Assert.Equal("realpower", r.Metric);
        Assert.Equal("W", r.Unit);
        Assert.Equal("esphome/garage/sensor/power/state", r.StateTopic);
        Assert.Equal("Garage Meter Power", r.Label);
        Assert.Null(r.JsonField);
        Assert.Null(r.Unsupported);
    }

    [Fact]
    public void AZwaveEnergySensorReadingAJsonFieldIsImportable()
    {
        const string json = """
        {"device":{"name":"Dryer Switch"},"name":"Energy","unique_id":"zwavejs_12_energy",
         "device_class":"energy","unit_of_measurement":"kWh","state_class":"total_increasing",
         "state_topic":"zwave/dryer/50/0/value/66049","value_template":"{{ value_json.value }}"}
        """;

        var r = Assert.Single(MqttDiscoveryImport.Parse(json, Ours));
        Assert.Equal("energy", r.Metric);
        Assert.Equal("value", r.JsonField);
        Assert.Null(r.Unsupported);
    }

    [Fact]
    public void ADeviceBundleYieldsEveryReadingItContains()
    {
        const string json = """
        {"device":{"name":"Shelly EM"},
         "components":{
           "a":{"name":"Power","unique_id":"shelly_em_power","device_class":"power","unit_of_measurement":"W","state_topic":"shelly/em/power"},
           "b":{"name":"Total","unique_id":"shelly_em_energy","device_class":"energy","unit_of_measurement":"kWh","state_topic":"shelly/em/energy"},
           "c":{"name":"Temp","unique_id":"shelly_em_temp","device_class":"temperature","unit_of_measurement":"°C","state_topic":"shelly/em/temp"}}}
        """;

        var found = MqttDiscoveryImport.Parse(json, Ours);

        // Temperature is neither a power nor an energy reading.
        Assert.Equal(2, found.Count);
        Assert.Equal(["realpower", "energy"], found.Select(f => f.Metric));
    }

    [Fact]
    public void OurOwnPublishedSensorsAreNeverOffered()
    {
        // Importing an entity this bridge published and re-exporting it duplicates the node in Home
        // Assistant and double-counts it in any roll-up that aggregates it.
        const string json = """
        {"device":{"name":"Solar (PV)"},"name":"Energy","unique_id":"energyflow_solar_energy",
         "device_class":"energy","unit_of_measurement":"kWh","state_topic":"energy/solar"}
        """;

        Assert.Empty(MqttDiscoveryImport.Parse(json, Ours));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("{{ value }}", null)]
    [InlineData("{{ value_json.value }}", "value")]
    [InlineData("{{ value_json.meter.total }}", "meter.total")]
    public void SimpleTemplatesMapToAField(string? template, string? expected)
    {
        var (field, unsupported) = MqttDiscoveryImport.ReadTemplate(template);
        Assert.Equal(expected, field);
        Assert.Null(unsupported);
    }

    [Theory]
    [InlineData("{{ value_json.power | float * 1000 }}")]
    [InlineData("{{ (value_json.w / 1000) | round(2) }}")]
    [InlineData("{% if value_json.on %}{{ value_json.w }}{% else %}0{% endif %}")]
    [InlineData("{{ value_json['power'] }}")]
    public void ATemplateThatDoesAnythingElseIsRefused(string template)
    {
        // The template transforms the field, so the field is not the published value.
        var (field, unsupported) = MqttDiscoveryImport.ReadTemplate(template);
        Assert.Null(field);
        Assert.False(string.IsNullOrWhiteSpace(unsupported));
    }

    [Fact]
    public void AnEntryWithoutTheEssentialsIsSkipped()
    {
        // No device class: the reading's quantity is unstated. No state topic: nothing to read.
        Assert.Empty(MqttDiscoveryImport.Parse("""{"name":"X","unique_id":"x","state_topic":"a/b"}""", Ours));
        Assert.Empty(MqttDiscoveryImport.Parse("""{"name":"X","unique_id":"x","device_class":"power"}""", Ours));
        Assert.Empty(MqttDiscoveryImport.Parse("not json at all", Ours));
    }

    [Theory]
    [InlineData("esp_garage_power", "esp_garage_power")]
    [InlineData("Shelly-EM/Power", "shelly_em_power")]
    [InlineData("  weird   id  ", "weird_id")]
    public void NodeIdsAreTopicSafe(string uniqueId, string expected)
        => Assert.Equal(expected, MqttDiscoveryImport.NodeId(uniqueId));
}

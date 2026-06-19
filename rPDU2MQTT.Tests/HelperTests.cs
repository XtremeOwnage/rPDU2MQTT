using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config.Schemas;
using rPDU2MQTT.Models.HomeAssistant.Enums;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.basePDU;
using Xunit;

namespace rPDU2MQTT.Tests;

public class StringHelperTests
{
    [Fact]
    public void Coalesce_ReturnsFirstNonEmpty()
        => Assert.Equal("x", StringHelper.Coalesce(null, "", "x", "y"));

    [Fact]
    public void Coalesce_SkipsWhitespace()
        => Assert.Equal("y", StringHelper.Coalesce("   ", "y"));

    [Fact]
    public void Coalesce_AllEmpty_ReturnsNull()
        => Assert.Null(StringHelper.Coalesce(null, "", "  "));
}

public class MqttHelperTests
{
    [Theory]
    [InlineData(new[] { "a", "b" }, "a/b")]
    [InlineData(new[] { "a/", "/b" }, "a/b")]
    [InlineData(new[] { "a", "", "b" }, "a/b")]
    public void JoinPaths_TrimsAndFiltersSegments(string[] parts, string expected)
        => Assert.Equal(expected, MQTTHelper.JoinPaths(parts));

    [Fact]
    public void StatusTopic_AppendsStatusSuffix()
        => Assert.Equal("Rack_PDU/Status", MQTTHelper.StatusTopic("Rack_PDU"));
}

public class EnumExtensionsTests
{
    [Theory]
    [InlineData(EntityType.Sensor, "sensor")]
    [InlineData(EntityType.BinarySensor, "binary_sensor")]
    [InlineData(EntityType.Switch, "switch")]
    public void ToJsonString_UsesJsonPropertyName(EntityType value, string expected)
        => Assert.Equal(expected, value.ToJsonString());

    [Theory]
    [InlineData(MqttPath.Set, "set")]
    [InlineData(MqttPath.Alarm, "alarm")]
    [InlineData(MqttPath.State, "state")]
    public void ToJsonString_MqttPaths(MqttPath value, string expected)
        => Assert.Equal(expected, value.ToJsonString());
}

public class MetricsHelperTests
{
    [Fact]
    public void EnumerateReadings_FlattensNumericMeasurements_AndSkipsNonNumeric()
    {
        var data = new PduData
        {
            Devices =
            {
                new Device
                {
                    Entity_Name = "PDU1",
                    Entity = new List<Entity>(),
                    Outlets = new List<Outlet>
                    {
                        new Outlet
                        {
                            Entity_Name = "Outlet1",
                            Measurements = new List<Measurement>
                            {
                                new Measurement { Type = "realPower", Value = "123.4", Units = "W", Entity_Identifier = "id_power" },
                                new Measurement { Type = "voltage",   Value = "n/a",   Units = "V", Entity_Identifier = "id_v" },
                            },
                        },
                    },
                },
            },
        };

        var readings = MetricsHelper.EnumerateReadings(data).ToList();

        Assert.Single(readings); // the non-numeric "voltage" is skipped
        Assert.Equal("PDU1", readings[0].Device);
        Assert.Equal("Outlet1", readings[0].Source);
        Assert.Equal("realPower", readings[0].Type);
        Assert.Equal(123.4, readings[0].Value);
        Assert.Equal("W", readings[0].Units);
    }

    [Fact]
    public void PrometheusMetricName_DefaultTemplate_SanitizesType()
        => Assert.Equal("rpdu2mqtt_realpower", MetricsHelper.PrometheusMetricName("realPower", "rack-pdu-1", "kube02", "W", new Config()));

    [Fact]
    public void PrometheusMetricName_HonorsMeasurementIdOverride()
    {
        var cfg = new Config();
        cfg.Overrides.Measurements["realPower"] = new EntityOverride { ID = "power" };
        Assert.Equal("rpdu2mqtt_power", MetricsHelper.PrometheusMetricName("realPower", "pdu", "kube02", "W", cfg));
    }

    [Fact]
    public void PrometheusMetricName_AppliesCustomTemplate()
    {
        var cfg = new Config();
        cfg.Prometheus.MetricNameTemplate = "homelab_{type}_watts";
        Assert.Equal("homelab_realpower_watts", MetricsHelper.PrometheusMetricName("realPower", "pdu", "kube02", "W", cfg));
    }

    [Fact]
    public void PrometheusMetricName_SupportsDeviceSourceUnitsPlaceholders()
    {
        var cfg = new Config();
        cfg.Prometheus.MetricNameTemplate = "pdu_{device}_{source}_{type}_{units}";
        // {outlet} is an alias for {source}.
        Assert.Equal("pdu_rack_pdu_1_kube02_realpower_w",
            MetricsHelper.PrometheusMetricName("realPower", "rack-pdu-1", "kube02", "W", cfg));
    }
}

public class MeasurementHelperTests
{
    [Theory]
    [InlineData("energy", StateClass.TotalIncreasing, DeviceClass.Energy)]
    [InlineData("realPower", StateClass.Measurement, DeviceClass.Power)]
    [InlineData("voltage", StateClass.Measurement, DeviceClass.Voltage)]
    public void TryParseValue_MapsKnownTypes(string type, StateClass state, DeviceClass device)
    {
        var dto = new baseMeasurement { Type = type }.TryParseValue();
        Assert.NotNull(dto);
        Assert.Equal(state, dto!.StateClass);
        Assert.Equal(device, dto.SensorClass);
    }

    [Fact]
    public void TryParseValue_UnknownType_FallsBackToUnknown()
    {
        var dto = new baseMeasurement { Type = "totally-not-real" }.TryParseValue();
        Assert.NotNull(dto);
        Assert.Equal(DeviceClass.Unknown, dto!.SensorClass);
    }
}

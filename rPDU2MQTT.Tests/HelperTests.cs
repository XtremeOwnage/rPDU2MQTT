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
    public void EmonCmsInputName_DefaultTemplate_BuildsCleanKey()
    {
        var r = new MeasurementReading("rack-pdu-1", "dell-md1200", "realPower", 5, "W", "raw_identifier", "topic", "Dell: MD1200", 7);
        Assert.Equal("rack_pdu_1_dell_md1200_realpower", MetricsHelper.EmonCmsInputName(r, new Config()));
    }

    [Fact]
    public void EmonCmsInputName_BlankTemplate_FallsBackToIdentifier()
    {
        var cfg = new Config();
        cfg.EmonCMS.InputNameTemplate = "";
        var r = new MeasurementReading("dev", "src", "realPower", 5, "W", "the_identifier", "topic", "Src", 1);
        Assert.Equal("the_identifier", MetricsHelper.EmonCmsInputName(r, cfg));
    }

    [Fact]
    public void EmonCmsInputName_HonorsMeasurementIdOverride()
    {
        var cfg = new Config();
        cfg.Overrides.Measurements["realPower"] = new EntityOverride { ID = "power" };
        var r = new MeasurementReading("pdu", "kube02", "realPower", 5, "W", "id", "topic", "Kube02", 5);
        Assert.Equal("pdu_kube02_power", MetricsHelper.EmonCmsInputName(r, cfg));
    }

    [Fact]
    public void EmonCmsInputName_SupportsNameAndNumber()
    {
        var cfg = new Config();
        cfg.EmonCMS.InputNameTemplate = "outlet{number}_{name}_{type}";
        var r = new MeasurementReading("pdu", "src", "realPower", 5, "W", "id", "topic", "kube02", 3);
        Assert.Equal("outlet3_kube02_realpower", MetricsHelper.EmonCmsInputName(r, cfg));
    }

    [Fact]
    public void EmonCmsMqttTopic_DefaultTemplate_IsBaseSlashNode_AndDoesNotSplit()
    {
        var cfg = new Config();
        Assert.False(MetricsHelper.EmonCmsSplitsByDevice(cfg));
        Assert.Equal("emon/rpdu2mqtt", MetricsHelper.EmonCmsMqttTopic("", cfg));
    }

    [Fact]
    public void EmonCmsMqttTopic_DeviceTemplate_SplitsPerPdu()
    {
        var cfg = new Config();
        cfg.EmonCMS.MqttBaseTopic = "emon";
        cfg.EmonCMS.Node = "rpdu";
        cfg.EmonCMS.MqttTopicTemplate = "{base}/{node}/{device}";
        Assert.True(MetricsHelper.EmonCmsSplitsByDevice(cfg));
        Assert.Equal("emon/rpdu/rack_pdu_1", MetricsHelper.EmonCmsMqttTopic("rack_pdu_1", cfg));
        // Empty device resolves cleanly (no doubled/trailing slash).
        Assert.Equal("emon/rpdu", MetricsHelper.EmonCmsMqttTopic("", cfg));
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

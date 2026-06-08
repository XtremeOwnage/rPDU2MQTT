using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
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

using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config.Schemas;
using Xunit;

namespace rPDU2MQTT.Tests;

public class MetricsHelperTests
{
    [Fact]
    public void PrometheusMetricName_DefaultTemplate_SanitizesType()
    {
        var cfg = new Config();
        Assert.Equal("rpdu2mqtt_realpower", MetricsHelper.PrometheusMetricName("realPower", cfg));
    }

    [Fact]
    public void PrometheusMetricName_HonorsMeasurementIdOverride()
    {
        var cfg = new Config();
        cfg.Overrides.Measurements["realPower"] = new EntityOverride { ID = "power" };
        Assert.Equal("rpdu2mqtt_power", MetricsHelper.PrometheusMetricName("realPower", cfg));
    }

    [Fact]
    public void PrometheusMetricName_AppliesCustomTemplate()
    {
        var cfg = new Config();
        cfg.Prometheus.MetricNameTemplate = "homelab_{type}_watts";
        Assert.Equal("homelab_realpower_watts", MetricsHelper.PrometheusMetricName("realPower", cfg));
    }
}

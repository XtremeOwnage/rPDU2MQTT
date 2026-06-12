using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

public class PrometheusConfigTests
{
    [Fact]
    public void Defaults_BothDeliveryMethodsOff()
    {
        var cfg = new Config();
        Assert.False(cfg.Prometheus.Exporter);
        Assert.False(cfg.Prometheus.Pushgateway.Enabled);
        Assert.Equal(9184, cfg.Prometheus.Port);
        Assert.Equal("rpdu2mqtt", cfg.Prometheus.Pushgateway.Job);
    }

    [Fact]
    public void ExporterAndPush_CanBothBeEnabled_AndRoundTrip()
    {
        var cfg = new Config();
        cfg.Prometheus.Exporter = true;
        cfg.Prometheus.Pushgateway.Enabled = true;
        cfg.Prometheus.Pushgateway.Url = "http://pushgateway:9091/metrics";
        cfg.Prometheus.Pushgateway.IntervalSeconds = 15;

        var back = ConfigSchema.FromJson(ConfigSchema.ToJson(cfg));

        Assert.True(back.Prometheus.Exporter);
        Assert.True(back.Prometheus.Pushgateway.Enabled);
        Assert.Equal("http://pushgateway:9091/metrics", back.Prometheus.Pushgateway.Url);
        Assert.Equal(15, back.Prometheus.Pushgateway.IntervalSeconds);
    }

    [Fact]
    public void Schema_ExposesIndependentToggles()
    {
        var prometheus = ConfigSchema.Build().Single(n => n.Key == "Prometheus");
        var keys = prometheus.Properties!.Select(n => n.Key).ToList();
        Assert.Contains("Exporter", keys);
        Assert.Contains("Pushgateway", keys);
        Assert.DoesNotContain("Mode", keys);
        Assert.DoesNotContain("Enabled", keys);   // back-compat alias is hidden from the GUI

        var pushgateway = prometheus.Properties!.Single(n => n.Key == "Pushgateway");
        Assert.Contains("Enabled", pushgateway.Properties!.Select(n => n.Key));
    }
}

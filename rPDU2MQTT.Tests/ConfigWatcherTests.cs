using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services.Kubernetes;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>KubernetesConfigWatcher.RequiresRestart: only connection/port/auth changes force a restart (#187/#192).</summary>
public class ConfigWatcherTests
{
    private static Config Sample()
    {
        var c = new Config();
        c.MQTT.Connection.Host = "mqtt.example.com";
        c.MQTT.Connection.Port = 1883;
        c.Pdus["default"] = new PduConfig();
        c.Pdus["default"].Connection.Host = "pdu.example.com";
        c.Gui.Port = 8080;
        return c;
    }

    [Fact]
    public void LiveReadableChanges_DoNotRequireRestart()
    {
        var a = Sample();
        var b = Sample();
        b.EmonCMS.Feeds.AutoConfigure = true;                       // EmonCMS
        b.HASS.DiscoveryEnabled = !a.HASS.DiscoveryEnabled;          // HASS
        b.EnergyFlow.MqttExport = true;                             // EnergyFlow
        b.Overrides.Measurements["realpower"] = new() { Name = "P" }; // Overrides
        b.Debug.PublishMessages = !a.Debug.PublishMessages;         // Debug

        Assert.False(KubernetesConfigWatcher.RequiresRestart(a, b));
    }

    [Fact]
    public void ConnectionPortAndAuthChanges_RequireRestart()
    {
        var baseline = Sample();

        var mqtt = Sample(); mqtt.MQTT.Connection.Host = "other.example.com";
        Assert.True(KubernetesConfigWatcher.RequiresRestart(baseline, mqtt));

        var pdu = Sample(); pdu.Pdus["default"].Connection.Port = 443;
        Assert.True(KubernetesConfigWatcher.RequiresRestart(baseline, pdu));

        var gui = Sample(); gui.Gui.Port = 9090;
        Assert.True(KubernetesConfigWatcher.RequiresRestart(baseline, gui));

        // The MQTT client is built once at startup, so switching transport must force a restart (#189).
        var scheme = Sample(); scheme.MQTT.Connection.Scheme = "mqtts";
        Assert.True(KubernetesConfigWatcher.RequiresRestart(baseline, scheme));
    }
}

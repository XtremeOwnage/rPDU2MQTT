using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Plugin.Vertiv;
using Xunit;

namespace rPDU2MQTT.Tests;

public class VertivPluginTests
{
    [Fact]
    public void Attach_WithNoHost_HasNoInstances_AndIsOff()
    {
        var cfg = new Config();
        cfg.Pdus["default"] = new PduConfig();
        var plugin = new VertivPlugin();

        var attached = plugin.Attach(cfg, new SnapshotCache(new ChannelMessageBus()));

        Assert.Empty(attached.Instances.All);
        Assert.Null(attached.Instances.Primary);
        Assert.False(plugin.Enabled(cfg));
    }

    [Fact]
    public async Task Reconcile_AddsAnInstanceSavedLater()
    {
        var cfg = new Config();
        var plugin = new VertivPlugin();
        var instances = plugin.Attach(cfg, new SnapshotCache(new ChannelMessageBus())).Instances;

        var pdu = new PduConfig();
        pdu.Connection.Host = "pdu-a.example.com";
        cfg.Pdus["default"] = pdu;
        await instances.ReconcileAsync();

        Assert.Equal("default", instances.PrimaryId);
        Assert.NotNull(instances.Get("default"));
        Assert.True(plugin.Enabled(cfg));
    }

    [Fact]
    public void Disabled_HidesInstances_AndStopsPolling()
    {
        var cfg = new Config();
        var pdu = new PduConfig();
        pdu.Connection.Host = "pdu-a.example.com";
        cfg.Pdus["default"] = pdu;
        var plugin = new VertivPlugin();
        var attached = plugin.Attach(cfg, new SnapshotCache(new ChannelMessageBus()));
        Assert.True(plugin.Enabled(cfg));

        cfg.Plugins["vertiv"] = new Dictionary<string, object?> { ["Enabled"] = "false" };

        Assert.False(plugin.Enabled(cfg));
        Assert.Empty(attached.Instances.All);
        Assert.Null(attached.Instances.Primary);
        Assert.False(attached.Reader!.Handles("default", cfg));
    }

    [Fact]
    public void TheBridgeShipsThePlugin_AndTheLoaderFindsIt()
    {
        var bridge = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "rPDU2MQTT", "bin"));
        var built = Directory.Exists(bridge)
            ? Directory.EnumerateFiles(bridge, "rPDU2MQTT.Plugin.Vertiv.dll", SearchOption.AllDirectories).FirstOrDefault(f => f.Contains(Path.Combine("bundled-plugins", "vertiv")))
            : null;
        Assert.True(built is not null, "the bridge's build did not copy the Vertiv plugin into bundled-plugins/vertiv/");
        var loaded = Plugins.PluginLoader.Load(Path.GetDirectoryName(built));
        Assert.Contains(loaded.SelectMany(p => p.Integrations), i => i.Id == "vertiv");
    }
}

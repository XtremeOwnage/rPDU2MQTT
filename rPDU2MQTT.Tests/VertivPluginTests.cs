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

    [Fact]
    public void ADisabledPlugin_IsListed_ButNeverLoaded()
    {
        var bundled = Path.GetDirectoryName(Path.GetDirectoryName(BuiltPlugin()))!;
        var copy = Path.Combine(Path.GetTempPath(), "rpdu-plugins-" + Guid.NewGuid().ToString("N"));
        foreach (var dir in new[] { "vertiv", "tigo" })
        {
            Directory.CreateDirectory(Path.Combine(copy, dir));
            foreach (var f in Directory.EnumerateFiles(Path.Combine(bundled, dir)))
                File.Copy(f, Path.Combine(copy, dir, Path.GetFileName(f)));
        }
        try
        {
            var found = Plugins.PluginLoader.LoadAll(Path.Combine(copy, "none"), copy, ["Vertiv"], null);

            var vertiv = Assert.Single(found, p => p.Key == "vertiv");
            Assert.True(vertiv.Disabled);
            Assert.Empty(vertiv.Integrations);
            Assert.Contains(found, p => p.Key == "tigo" && !p.Disabled && p.Integrations.Count > 0);
            Assert.DoesNotContain(System.Runtime.Loader.AssemblyLoadContext.All.SelectMany(c => c.Assemblies),
                a => !a.IsDynamic && a.Location.StartsWith(Path.Combine(copy, "vertiv")));

            var listed = new Plugins.PluginCatalog(found).Plugins;
            Assert.Contains(listed, p => p is { Key: "vertiv", Name: "Vertiv rPDU", Disabled: true, Bundled: true });
            Assert.Contains(listed, p => p is { Key: "tigo", Name: "Tigo TAP", Disabled: false });
        }
        finally { try { Directory.Delete(copy, true); } catch { } }
    }

    private static string BuiltPlugin()
    {
        var bridge = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "rPDU2MQTT", "bin"));
        return Directory.EnumerateFiles(bridge, "rPDU2MQTT.Plugin.Vertiv.dll", SearchOption.AllDirectories)
                        .First(f => f.Contains(Path.Combine("bundled-plugins", "vertiv")));
    }
}

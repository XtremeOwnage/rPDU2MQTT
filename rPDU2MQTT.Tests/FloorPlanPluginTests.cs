using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Plugin.FloorPlan;
using Xunit;

namespace rPDU2MQTT.Tests;

public class FloorPlanPluginTests
{
    [Fact]
    public void ThePageAndItsStylesheet_AreEmbedded()
    {
        var plugin = new FloorPlanPlugin();
        var page = Assert.Single(plugin.Pages);

        var js = plugin.PageAsset(page.Id + ".js");
        Assert.NotNull(js);
        Assert.EndsWith("return mount;\n", js);
        Assert.Contains("function planSolve", js);
        Assert.Contains(".fp-svg", plugin.PageAsset(page.Id + ".css"));
    }

    [Fact]
    public void StatusCountsFloors()
    {
        var cfg = new Config();
        cfg.EnergyFlow.Sites.Add(new SiteConfig { Id = "home", Floors = [new FloorConfig { Id = "ground" }, new FloorConfig { Id = "upstairs" }] });

        var status = new FloorPlanPlugin().Status(cfg);

        Assert.Equal(HealthLevel.Good, status.Level);
        Assert.Equal("2 floors", status.Detail);
    }

    [Fact]
    public void TheBridgeShipsThePlugin_AndTheLoaderFindsIt()
    {
        var bridge = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "rPDU2MQTT", "bin"));
        var built = Directory.Exists(bridge)
            ? Directory.EnumerateFiles(bridge, "rPDU2MQTT.Plugin.FloorPlan.dll", SearchOption.AllDirectories).FirstOrDefault(f => f.Contains(Path.Combine("bundled-plugins", "floorplan")))
            : null;
        Assert.True(built is not null, "the bridge's build did not copy the floor plan plugin into bundled-plugins/floorplan/");
        Assert.Contains(Plugins.PluginLoader.Load(Path.GetDirectoryName(built)).SelectMany(p => p.Integrations), i => i.Id == "floorplan");
    }
}

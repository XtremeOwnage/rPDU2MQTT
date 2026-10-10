using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Plugin.Locations;
using rPDU2MQTT.Services.Gui;
using rPDU2MQTT.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

public class LocationsPluginTests
{
    [Fact]
    public void ThePageAndItsStylesheet_AreEmbedded()
    {
        var plugin = new LocationsPlugin();
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
        var cfg = YamlConfigLoader.DeserializeString("""
            Plugins:
              locations:
                Sites:
                  - Id: home
                    Floors:
                      - Id: ground
                      - Id: upstairs
            """);

        var status = new LocationsPlugin().Status(cfg);

        Assert.Equal(HealthLevel.Good, status.Level);
        Assert.Equal("2 floors", status.Detail);
    }

    [Fact]
    public void TheBridgeShipsThePlugin_AndTheLoaderFindsIt()
    {
        var bridge = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "rPDU2MQTT", "bin"));
        var built = Directory.Exists(bridge)
            ? Directory.EnumerateFiles(bridge, "rPDU2MQTT.Plugin.Locations.dll", SearchOption.AllDirectories).FirstOrDefault(f => f.Contains(Path.Combine("bundled-plugins", "locations")))
            : null;
        Assert.True(built is not null, "the bridge's build did not copy the locations plugin into bundled-plugins/locations/");
        Assert.Contains(Plugins.PluginLoader.Load(Path.GetDirectoryName(built)).SelectMany(p => p.Integrations), i => i.Id == "locations");
    }

    private const string OldConfig = """
        DisabledPlugins: [floorplan]
        EnergyFlow:
          Sites:
            - Id: home
              Floors:
                - Id: ground
                  Rooms:
                    - Id: kitchen
                      Name: Kitchen
                    - Id: "2"
                      Name: 2
          AutoLocations:
            - Match: "outlet:rack:*"
              Location: kitchen
          Nodes:
            - Id: fridge
              Location: kitchen
          Panels:
            - Id: main
              Location: ground
              Breakers:
                - Slot: 6
                  Number: B06
                  Rooms: [kitchen, "2"]
          Clamps:
            - Panel: main
              Breaker: B06
              Channel: ch5
        """;

    [Fact]
    public void LocationsSavedTheOldWay_MoveToThePlugin_OnLoad()
    {
        var cfg = YamlConfigLoader.DeserializeString(OldConfig);

        var places = LocationSettings.Of(cfg);
        Assert.Equal(["kitchen", "2"], places.Sites.Single().Floors.Single().Rooms.Select(r => r.Id));
        Assert.Equal("2", places.Sites[0].Floors[0].Rooms[1].Name);
        Assert.Equal("kitchen", Assert.Single(places.AutoLocations).Location);
        Assert.Equal("kitchen", EntityExtensions.Read<NodeLocation>(cfg.EnergyFlow.Nodes[0], "locations").Location);
        Assert.Equal("ground", EntityExtensions.Read<PanelLocation>(cfg.EnergyFlow.Panels[0], "locations").Location);
        Assert.Equal(["kitchen", "2"], EntityExtensions.Read<BreakerRooms>(cfg.EnergyFlow.Panels[0].Breakers[0], "locations").Rooms);
        Assert.Equal(["locations"], cfg.DisabledPlugins);
    }

    [Fact]
    public void OnceMoved_TheOldKeysAreNotWrittenAgain()
    {
        var yaml = ConfigSchema.ToYaml(YamlConfigLoader.DeserializeString(OldConfig));
        var reloaded = YamlConfigLoader.DeserializeString(yaml);

        Assert.DoesNotContain("\n  Sites:", yaml);
        Assert.DoesNotContain("Rooms: [", yaml);
        Assert.Equal("kitchen", LocationIndex.For(reloaded).LocationOf("fridge"));
        Assert.Equal("ground", LocationIndex.For(reloaded).LocationOf("breaker:main:B06"));
    }

    [Fact]
    public void WhatThePluginAlreadyHas_IsNotOverwritten()
    {
        var cfg = YamlConfigLoader.DeserializeString("""
            Plugins:
              locations:
                Sites:
                  - Id: new_home
            EnergyFlow:
              Sites:
                - Id: old_home
              Nodes:
                - Id: fridge
                  Location: old_room
                  Ext:
                    locations:
                      Location: new_room
            """);

        Assert.Equal("new_home", LocationSettings.Of(cfg).Sites.Single().Id);
        Assert.Equal("new_room", EntityExtensions.Read<NodeLocation>(cfg.EnergyFlow.Nodes[0], "locations").Location);
    }

    [Fact]
    public async Task ThePickers_OfferEveryPlace_OrJustRoomsAndAreas()
    {
        var plugin = new LocationsPlugin();
        var cfg = YamlConfigLoader.DeserializeString(OldConfig);
        async Task<string[]> Ids(string action)
        {
            var found = IntegrationActions.Find(plugin, action)!;
            var result = (string[][])(await found.Handler(new IntegrationActionContext(cfg, new Dictionary<string, string?>()), CancellationToken.None))!;
            return result.Select(r => r[0]).ToArray();
        }

        Assert.Equal(["home", "ground", "kitchen", "2"], await Ids("places"));
        Assert.Equal(["kitchen", "2"], await Ids("rooms"));
        Assert.All(plugin.Actions, a => Assert.False(a.Listed));
    }

    [Fact]
    public void ThePlugin_KeepsAPlaceOnNodesPanelsAndBreakers()
    {
        var schema = ConfigSchema.Build([], EntityExtensions.Of([new LocationsPlugin()]));

        var node = schema.Single(n => n.Key == "EnergyFlow").Properties!.Single(n => n.Key == "Nodes").ValueSchema!.Properties!.Single(p => p.Key == "Ext");
        var field = Assert.Single(Assert.Single(node.Extensions!).Properties!);
        Assert.Equal("/api/integrations/locations/places", field.ChoicesFrom);
        Assert.DoesNotContain(schema.Single(n => n.Key == "EnergyFlow").Properties!, p => p.Key is "Sites" or "Placements" or "Runs" or "AutoLocations");
    }
}

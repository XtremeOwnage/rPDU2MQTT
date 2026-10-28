using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Plugin.Locations;
using rPDU2MQTT.Services;
using rPDU2MQTT.Services.Gui;
using rPDU2MQTT.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

public class LocationsPluginTests
{
    [Fact]
    public void ThePagesAndTheirStylesheets_AreEmbedded()
    {
        var plugin = new LocationsPlugin();
        Assert.Equal(["locations", "floor-plans"], plugin.Pages.Select(p => p.Id));

        foreach (var page in plugin.Pages)
            Assert.EndsWith("return mount;\n", plugin.PageAsset(page.Id + ".js"));
        Assert.Contains("function planSolve", plugin.PageAsset("floor-plans.js"));
        Assert.Contains(".fp-svg", plugin.PageAsset("floor-plans.css"));
        Assert.Contains(".loc-tree", plugin.PageAsset("locations.css"));
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
    public void NetworkJacks_PatchPanelsAndCables_AreRead()
    {
        var cfg = YamlConfigLoader.DeserializeString("""
            Plugins:
              locations:
                Placements:
                  - Id: patch_panel_1
                    Kind: patch-panel
                    Ports: 24
                    Patches:
                      - Port: 3
                        Switch: network_switch_1/7
                  - Id: network_switch_1
                    Kind: network-switch
                    Ports: 8
                  - Id: jack_1
                    Kind: jack
                    Port: patch_panel_1/3
                Runs:
                  - Id: run_1
                    Kind: network
                    From: patch_panel_1
                    To: jack_1
            """);

        var places = LocationSettings.Of(cfg);
        var panel = places.Placements.Single(p => p.Id == "patch_panel_1");
        Assert.Equal(24, panel.Ports);
        Assert.Equal("network_switch_1/7", Assert.Single(panel.Patches).Switch);
        Assert.Equal("patch_panel_1/3", places.Placements.Single(p => p.Id == "jack_1").Port);
        Assert.Equal(RunKind.Network, places.Runs.Single().Kind);
        foreach (var p in places.Placements)
            Assert.True(System.ComponentModel.DataAnnotations.Validator.TryValidateObject(p, new(p), null, validateAllProperties: true), p.Id);
        Assert.True(System.ComponentModel.DataAnnotations.Validator.TryValidateObject(places.Runs[0], new(places.Runs[0]), null, validateAllProperties: true));
    }

    private sealed class PastHost(Config cfg, IMeasurementHistory? history) : IPluginHost
    {
        public Config Config => cfg;
        public ISnapshotCache Snapshots { get; } = new SnapshotCache(new ChannelMessageBus());
        public IFlowValueSource? LiveValues => null;
        public IMessagePublisher? Publisher => null;
        public IntegrationStatus Status { get; } = new();
        public IPeriodAuditor? Auditor => null;
        public IMeasurementHistory? History => history;
    }

    /// <summary>The kitchen circuit's clamp read 6 A before noon and 18 A from noon on.</summary>
    private sealed class PastCurrent : IMeasurementHistory
    {
        public static readonly DateTime Noon = new(2026, 8, 3, 12, 0, 0, DateTimeKind.Utc);
        public string Id => "fake";
        public Task<IReadOnlyDictionary<string, double>> ValuesAtAsync(IReadOnlyCollection<string> nodeIds, string metric, DateTime atUtc, CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<string, double>>(metric == "current" && nodeIds.Contains("ch5")
                ? new Dictionary<string, double> { ["ch5"] = atUtc < Noon ? 6 : 18 }
                : new Dictionary<string, double>());
        public Task<(bool Ok, string Detail)> ProbeAsync(CancellationToken ct) => Task.FromResult((true, ""));
    }

    private static Config KitchenCircuit() => YamlConfigLoader.DeserializeString("""
        EnergyFlow:
          Panels:
            - Id: main
              Breakers:
                - Slot: 6
                  Number: B06
                  Amps: 20
          Clamps:
            - Panel: main
              Breaker: B06
              Channel: ch5
        """);

    private static async Task<JsonElement> Run(LocationsPlugin plugin, Config cfg, string action, Dictionary<string, string?> args)
    {
        var result = await IntegrationActions.Find(plugin, action)!.Handler(new IntegrationActionContext(cfg, args), CancellationToken.None);
        return JsonSerializer.SerializeToElement(result);
    }

    [Fact]
    public async Task APastMoment_ShowsEachCircuitsCurrentAsHistoryHeldIt()
    {
        var cfg = KitchenCircuit();
        var plugin = new LocationsPlugin();
        plugin.UseHost(new PastHost(cfg, new PastCurrent()));

        var before = await Run(plugin, cfg, "totals", new() { ["at"] = "2026-08-03T11:00:00Z" });
        Assert.True(before.GetProperty("historical").GetBoolean());
        Assert.Equal(6, before.GetProperty("circuits")[0].GetProperty("current").GetDouble());
        var after = await Run(plugin, cfg, "totals", new() { ["at"] = "2026-08-03T13:00:00Z" });
        Assert.Equal(18, after.GetProperty("circuits")[0].GetProperty("current").GetDouble());

        var series = await Run(plugin, cfg, "load-series", new() { ["from"] = "2026-08-03T10:00:00Z", ["to"] = "2026-08-03T14:00:00Z", ["step"] = "3600" });
        var kitchen = series.GetProperty("circuits")[0];
        Assert.Equal("main/B06", kitchen.GetProperty("ref").GetString());
        Assert.Equal(20, kitchen.GetProperty("amps").GetInt32());
        Assert.Equal([6, 6, 18, 18, 18], kitchen.GetProperty("values").EnumerateArray().Select(v => v.GetDouble()));
    }

    [Fact]
    public async Task APastMoment_WithoutHistory_SaysSo()
    {
        var cfg = KitchenCircuit();
        var plugin = new LocationsPlugin();
        plugin.UseHost(new PastHost(cfg, null));

        var r = await Run(plugin, cfg, "totals", new() { ["at"] = "2026-08-03T11:00:00Z" });
        Assert.False(r.GetProperty("ok").GetBoolean());
        Assert.False((await Run(plugin, cfg, "load-series", new() { ["from"] = "2026-08-03T10:00:00Z", ["to"] = "2026-08-03T14:00:00Z" })).GetProperty("ok").GetBoolean());
        // Live is unchanged.
        Assert.False((await Run(plugin, cfg, "totals", new())).GetProperty("historical").GetBoolean());
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

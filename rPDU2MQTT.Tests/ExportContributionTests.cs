using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Integrations.Mqtt;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Tiers and Home Assistant areas a plugin adds to the energy export.</summary>
public class ExportContributionTests
{
    private sealed class Captured : IMessagePublisher
    {
        public Dictionary<string, string> Sent { get; } = new();
        public Task PublishAsync(string topic, string payload, bool retain, CancellationToken ct, DateTime? at = null)
        { Sent[topic] = payload; return Task.CompletedTask; }
    }

    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    private sealed class Zones : IExportContributor, IAreaProvider
    {
        public IReadOnlyList<ContributedTier> Tiers(ExportPass pass, Config cfg) =>
            [new("zone:shop", "Shop", "zone", 250, 12, 1.5, "Shop", new Dictionary<string, object?> { ["zone"] = "shop" })];
        public IReadOnlyList<string> TierIds(Config cfg) => ["zone:shop"];
        public IReadOnlyDictionary<string, string> Areas(Config cfg, FlowTopology topology) =>
            new Dictionary<string, string> { ["fridge"] = "Shop" };
    }

    private sealed class Other : IAreaProvider
    {
        public IReadOnlyDictionary<string, string> Areas(Config cfg, FlowTopology topology) =>
            new Dictionary<string, string> { ["fridge"] = "Garage", ["lamp"] = "Den" };
    }

    private static Config Configured()
    {
        var cfg = new Config();
        cfg.EnergyFlow.MqttExport = true;
        cfg.HASS.DiscoveryEnabled = true;
        cfg.HASS.DiscoveryTopic = "homeassistant";
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "fridge", Label = "Fridge", Kind = "load" });
        return cfg;
    }

    private static async Task<Captured> Publish(Config cfg, ExportContributions? contributions)
    {
        var pub = new Captured();
        var src = new Fixed(new() { ["fridge|realpower"] = 120 });
        var pass = ExportPass.Build([new PduSnapshot("pdu", DateTime.UtcNow, new PduData())], cfg, src);
        await new MqttIntegration(cfg, pub, src, contributions: contributions).SendAsync(pass, CancellationToken.None);
        return pub;
    }

    private static JsonElement State(Captured pub, string id) => pub.Sent
        .Where(kv => !kv.Key.Contains("/config") && !string.IsNullOrWhiteSpace(kv.Value))
        .Select(kv => JsonDocument.Parse(kv.Value).RootElement.Clone())
        .Single(v => v.GetProperty("id").GetString() == id);

    private static JsonElement Discovery(Captured pub, string id) =>
        JsonDocument.Parse(pub.Sent[$"homeassistant/device/{FlowExport.DeviceId(id)}/config"]).RootElement.Clone();

    [Fact]
    public async Task AContributedTier_IsPublishedLikeANode()
    {
        var pub = await Publish(Configured(), new ExportContributions([new Zones()]));

        var state = State(pub, "zone:shop");
        Assert.Equal(250, state.GetProperty("power").GetDouble());
        Assert.Equal(12, state.GetProperty("energy").GetDouble());
        Assert.Equal(1.5, state.GetProperty("energy_d").GetDouble());
        Assert.Equal("shop", state.GetProperty("zone").GetString());
        Assert.Equal("Shop", Discovery(pub, "zone:shop").GetProperty("device").GetProperty("suggested_area").GetString());
    }

    [Fact]
    public async Task ANodesDevice_LandsInTheAreaAProviderGivesIt()
    {
        var pub = await Publish(Configured(), new ExportContributions([new Zones()]));

        Assert.Equal("Shop", Discovery(pub, "fridge").GetProperty("device").GetProperty("suggested_area").GetString());
    }

    [Fact]
    public void WhereTwoProvidersPlaceANode_TheFirstLoadedWins()
    {
        var areas = new ExportContributions([new Zones(), new Other()]).Areas(new Config(), FlowTopology.For(null, null));

        Assert.Equal("Shop", areas["fridge"]);
        Assert.Equal("Den", areas["lamp"]);
    }

    [Fact]
    public async Task TheBuiltInPlaces_StillPublishAsTiers()
    {
        var cfg = Configured();
        cfg.EnergyFlow.Sites.Add(new SiteConfig
        {
            Id = "home", Name = "Home",
            Floors = [new FloorConfig { Id = "ground", Name = "Ground", Rooms = [new RoomConfig { Id = "kitchen", Name = "Kitchen" }] }],
        });
        cfg.EnergyFlow.Nodes[0].Location = "kitchen";

        var pub = await Publish(cfg, null);

        var room = State(pub, LocationExport.NodeId("kitchen"));
        Assert.Equal(120, room.GetProperty("power").GetDouble());
        Assert.Equal("kitchen", room.GetProperty("location").GetString());
        Assert.Equal("Kitchen", Discovery(pub, "fridge").GetProperty("device").GetProperty("suggested_area").GetString());
    }

    private sealed class Picks
    {
        [ChoicesFrom("/api/plugins/where/choices")]
        public string Room { get; set; } = "";
    }

    [Fact]
    public void AFieldsServerChoices_AreNamedInTheSchema()
    {
        var schema = ConfigSchema.Build([("where", "Where", typeof(Picks), null)]);

        Assert.Equal("/api/plugins/where/choices", schema.Single(n => n.Key == "where").Properties!.Single().ChoicesFrom);
    }
}

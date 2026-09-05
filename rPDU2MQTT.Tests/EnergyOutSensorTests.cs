using System.Text.Json;
using System.Text.Json.Nodes;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Integrations.Mqtt;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A bidirectional node publishes both directions by name, and <c>energy</c> as what passed through it.
/// <para>
/// Naming only one direction leaves the other to a convention nobody can see: "Energy In" sat under Home
/// Assistant's "Energy exported to grid" and read as its own opposite. Each direction now says which it is,
/// and <c>energy</c> is the total either way — so the dashboard has to bind the named direction, or an
/// export would be counted as an import.
/// </para>
/// </summary>
public class EnergyOutSensorTests
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

    /// <summary>A grid that both imports and exports, feeding the house.</summary>
    private static Config Configured()
    {
        var cfg = new Config();
        cfg.EnergyFlow.MqttExport = true;
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode
        {
            Id = "grid", Label = "Grid", Kind = "grid",
            Sources =
            [
                new EnergyFlowSource { Type = "mqtt", Metric = "energy", Direction = "out", Topic = "sa/grid_in" },
                new EnergyFlowSource { Type = "mqtt", Metric = "energy", Direction = "in", Topic = "sa/grid_out" },
            ],
        });
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "home", Label = "Home", Kind = "load" });
        cfg.EnergyFlow.Links.Add(new EnergyFlowLink { From = "grid", To = "home" });
        return cfg;
    }

    private static async Task<JsonElement> Grid(Dictionary<string, double> live)
    {
        var cfg = Configured();
        var pub = new Captured();
        var src = new Fixed(live);
        var integration = new MqttIntegration(cfg, pub, src);
        var pass = ExportPass.Build([new PduSnapshot("pdu", DateTime.UtcNow, new PduData())], cfg, src);
        await integration.SendAsync(pass, CancellationToken.None);
        return pub.Sent.Where(kv => !kv.Key.Contains("/config") && !string.IsNullOrWhiteSpace(kv.Value))
            .Select(kv => JsonDocument.Parse(kv.Value).RootElement.Clone())
            .Single(v => v.GetProperty("id").GetString() == "grid");
    }

    // 1200 imported, 300 exported.
    private static Dictionary<string, double> Both() => new()
    {
        ["grid|realpower"] = 800,
        ["grid|energy"] = 1200,
        ["grid|energy#in"] = 300,
    };

    [Fact]
    public async Task EachDirectionIsPublishedUnderItsOwnName()
    {
        var grid = await Grid(Both());

        Assert.Equal(1200, grid.GetProperty("energy_out").GetDouble(), 3);
        Assert.Equal(300, grid.GetProperty("energy_in").GetDouble(), 3);
    }

    [Fact]
    public async Task EnergyIsWhatPassedThroughEitherWay()
    {
        var grid = await Grid(Both());

        Assert.Equal(1500, grid.GetProperty("energy").GetDouble(), 3);
    }

    [Fact]
    public async Task AOneWayNodeIsUnchanged()
    {
        // Only a node with both directions gains the pair. Solar has one, so `energy` still means what it
        // always did and nothing new appears beside it — its recorded series must not change meaning.
        var cfg = new Config();
        cfg.EnergyFlow.MqttExport = true;
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode
        {
            Id = "solar", Label = "Solar", Kind = "solar",
            Sources = [new EnergyFlowSource { Type = "mqtt", Metric = "energy", Topic = "sa/pv" }],
        });
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "home", Label = "Home", Kind = "load" });
        cfg.EnergyFlow.Links.Add(new EnergyFlowLink { From = "solar", To = "home" });

        var pub = new Captured();
        var src = new Fixed(new() { ["solar|realpower"] = 4200, ["solar|energy"] = 880 });
        var pass = ExportPass.Build([new PduSnapshot("pdu", DateTime.UtcNow, new PduData())], cfg, src);
        await new MqttIntegration(cfg, pub, src).SendAsync(pass, CancellationToken.None);

        var solar = pub.Sent.Where(kv => !kv.Key.Contains("/config") && !string.IsNullOrWhiteSpace(kv.Value))
            .Select(kv => JsonDocument.Parse(kv.Value).RootElement.Clone())
            .Single(v => v.GetProperty("id").GetString() == "solar");

        Assert.Equal(880, solar.GetProperty("energy").GetDouble(), 3);
        Assert.Equal(JsonValueKind.Null, solar.GetProperty("energy_out").ValueKind);
    }

    [Fact]
    public void TheDiscoveryDocumentDescribesAllThree()
    {
        var doc = FlowExport.DiscoveryDocument(new FlowNode("grid", "Grid", "grid", 800), null,
            "rpdu/energyflow/grid", "kWh", "W", null, includeEnergyIn: true);
        var parts = doc["components"]!.AsObject();

        Assert.Equal("Energy", (string?)parts["energyflow_grid_energy"]!["name"]);
        Assert.Equal("Energy Out", (string?)parts["energyflow_grid_energy_out"]!["name"]);
        Assert.Equal("Energy In", (string?)parts["energyflow_grid_energy_in"]!["name"]);
    }

    [Fact]
    public void AOneWayNodeGetsNoSecondDirection()
    {
        var doc = FlowExport.DiscoveryDocument(new FlowNode("solar", "Solar", "solar", 4200), null,
            "rpdu/energyflow/solar", "kWh", "W", null, includeEnergyIn: false);
        var parts = doc["components"]!.AsObject();

        Assert.False(parts.ContainsKey("energyflow_solar_energy_out"));
        Assert.False(parts.ContainsKey("energyflow_solar_energy_in"));
    }

    /// <summary>
    /// The property the dashboard rests on. `energy` is now import+export on a grid, so binding it to
    /// stat_energy_from would report everything sent back to the grid as energy drawn from it.
    /// </summary>
    [Fact]
    public void TheDashboardBindsTheNamedDirection_NotTheTotal()
    {
        var graph = new FlowGraph(
            [new FlowNode("grid", "Grid", "grid", 800)],
            [], "realpower", "W");

        var entities = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["energyflow_grid_energy"] = "sensor.grid_energy",
            ["energyflow_grid_energy_out"] = "sensor.grid_energy_out",
            ["energyflow_grid_energy_in"] = "sensor.grid_energy_in",
        };
        string? Resolve(string uid) => entities.TryGetValue(uid, out var e) ? e : null;

        var sources = EnergyDashboardSync.BuildEnergySources(graph,
            (id, dir) => dir == EnergyDirection.Out
                ? Resolve(FlowExport.EnergyOutUniqueId(id)) ?? Resolve(FlowExport.EnergyUniqueId(id))
                : Resolve(FlowExport.EnergyInUniqueId(id)));

        var grid = Assert.Single(sources);
        Assert.Equal("sensor.grid_energy_out", (string?)grid["stat_energy_from"]);
        Assert.Equal("sensor.grid_energy_in", (string?)grid["stat_energy_to"]);
    }

    [Fact]
    public void WithoutTheNamedDirection_TheDashboardFallsBackToEnergy()
    {
        // A one-way node publishes no energy_out, and there `energy` IS the out direction.
        var graph = new FlowGraph([new FlowNode("solar", "Solar", "solar", 4200)], [], "realpower", "W");
        var entities = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["energyflow_solar_energy"] = "sensor.solar_energy",
        };
        string? Resolve(string uid) => entities.TryGetValue(uid, out var e) ? e : null;

        var sources = EnergyDashboardSync.BuildEnergySources(graph,
            (id, dir) => dir == EnergyDirection.Out
                ? Resolve(FlowExport.EnergyOutUniqueId(id)) ?? Resolve(FlowExport.EnergyUniqueId(id))
                : Resolve(FlowExport.EnergyInUniqueId(id)));

        Assert.Equal("sensor.solar_energy", (string?)Assert.Single(sources)["stat_energy_from"]);
    }
}

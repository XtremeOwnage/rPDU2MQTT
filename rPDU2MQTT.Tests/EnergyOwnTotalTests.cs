using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Integrations.Mqtt;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Home Assistant's energy sensors read the bridge's own running total, carried on from what was already published.</summary>
public class EnergyOwnTotalTests
{
    private sealed class Fixed : IFlowValueSource
    {
        public readonly Dictionary<string, double> Values = new();
        public bool TryGetValue(string node, string metric, out double value) => Values.TryGetValue(node + "|" + metric, out value);
    }

    private sealed class Peaks : IEnergyStore
    {
        public readonly Dictionary<string, double> Saved = new();
        public IReadOnlyDictionary<string, EnergyState> Load() => new Dictionary<string, EnergyState>();
        public void Save(IReadOnlyDictionary<string, EnergyState> states) { }
        public IReadOnlyDictionary<string, double> LoadPeaks() => new Dictionary<string, double>(Saved);
        public void SavePeak(string key, double value) => Saved[key] = value;
    }

    private sealed class Captured : IMessagePublisher
    {
        public Dictionary<string, string> Sent { get; } = new();
        public Task PublishAsync(string topic, string payload, bool retain, CancellationToken ct, DateTime? at = null)
        { Sent[topic] = payload; return Task.CompletedTask; }
    }

    [Fact]
    public void ContinueStartsExactlyAtTheExistingMark()
    {
        var store = new Peaks { Saved = { ["grid|energy"] = 568.8 } };
        var guard = new CumulativeExport(store);

        Assert.Equal(568.8, guard.Continue("grid|energy", 40)!.Value, 6);
        Assert.Equal(570.3, guard.Continue("grid|energy", 41.5)!.Value, 6);
    }

    [Fact]
    public void ContinueStartsAtTheMarkWhenTheTotalIsAbove()
    {
        var guard = new CumulativeExport(new Peaks { Saved = { ["solar|energy"] = 381.6 } });

        Assert.Equal(381.6, guard.Continue("solar|energy", 900)!.Value, 6);
        Assert.Equal(382.6, guard.Continue("solar|energy", 901)!.Value, 6);
    }

    [Fact]
    public void ContinueWithNoMarkPublishesTheTotal()
    {
        var guard = new CumulativeExport();

        Assert.Equal(10, guard.Continue("a|energy", 10));
        Assert.Equal(12, guard.Continue("a|energy", 12));
    }

    [Fact]
    public void ADropIsFlattenedNotWithheld()
    {
        var guard = new CumulativeExport();
        guard.Continue("a|energy", 100);

        Assert.Equal(100, guard.Continue("a|energy", 3));
        Assert.Equal(102, guard.Continue("a|energy", 5));
        Assert.Empty(guard.Withheld);
    }

    [Fact]
    public void TheOffsetSurvivesARestart()
    {
        var store = new Peaks { Saved = { ["grid|energy"] = 568.8 } };
        new CumulativeExport(store).Continue("grid|energy", 40);

        Assert.Equal(570.8, new CumulativeExport(store).Continue("grid|energy", 42)!.Value, 6);
    }

    [Fact]
    public void TheOwnTotalKeepsGrowingWhenTheCounterStopsArriving()
    {
        var cfg = new Config();
        cfg.EnergyFlow.Aggregation.Enabled = true;
        cfg.EnergyFlow.Aggregation.TrackPeriods = true;
        cfg.EnergyFlow.Aggregation.PeriodTimeZone = "UTC";
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "grid", Label = "Grid", Kind = "grid" });
        var up = new Fixed();
        var svc = new EnergyAggregationService(cfg, up, new MemoryEnergyStore());
        svc.LoadTotals();
        var t0 = new DateTime(2026, 9, 30, 10, 0, 0, DateTimeKind.Utc);

        up.Values["grid|energy"] = 500;
        svc.Sample(TimeSpan.FromMinutes(2), t0);
        up.Values["grid|energy"] = 501;
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(1));

        up.Values.Remove("grid|energy");
        up.Values["grid|realpower"] = 6000;
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(2));
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(3));

        Assert.False(svc.TryGetValue("grid", "energy", out _));
        Assert.True(svc.TryGetValue("grid", FlowMetricKey.OwnEnergyTotal, out var total));
        Assert.Equal(1.15, total, 3);
    }

    [Fact]
    public void ACounterComingBackDoesNotCountTheBridgedSpanTwice()
    {
        var cfg = new Config();
        cfg.EnergyFlow.Aggregation.Enabled = true;
        cfg.EnergyFlow.Aggregation.TrackPeriods = true;
        cfg.EnergyFlow.Aggregation.PeriodTimeZone = "UTC";
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar", Kind = "solar" });
        var up = new Fixed();
        var svc = new EnergyAggregationService(cfg, up, new MemoryEnergyStore());
        svc.LoadTotals();
        var t0 = new DateTime(2026, 9, 30, 10, 0, 0, DateTimeKind.Utc);

        up.Values["solar|energy"] = 100;
        svc.Sample(TimeSpan.FromMinutes(2), t0);
        up.Values.Remove("solar|energy");
        up.Values["solar|realpower"] = 6000;
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(1));
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(2));
        svc.TryGetValue("solar", FlowMetricKey.OwnEnergyTotal, out var bridged);

        up.Values["solar|energy"] = 150;
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(3));
        up.Values["solar|energy"] = 151;
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(4));

        Assert.True(svc.TryGetValue("solar", FlowMetricKey.OwnEnergyTotal, out var total));
        Assert.Equal(bridged + 1, total, 6);
    }

    [Fact]
    public void TheReturnLaneIsIntegratedFromItsPowerWhenNoCounterArrives()
    {
        var cfg = new Config();
        cfg.EnergyFlow.Aggregation.Enabled = true;
        cfg.EnergyFlow.Aggregation.TrackPeriods = true;
        cfg.EnergyFlow.Aggregation.PeriodTimeZone = "UTC";
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "battery", Label = "Battery", Kind = "battery" });
        var up = new Fixed();
        up.Values["battery|realpower"] = 0;
        up.Values["battery|realpower#in"] = 3600;
        var svc = new EnergyAggregationService(cfg, up, new MemoryEnergyStore());
        svc.LoadTotals();
        var t0 = new DateTime(2026, 9, 30, 10, 0, 0, DateTimeKind.Utc);

        svc.Sample(TimeSpan.FromMinutes(2), t0);
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(1));
        svc.Sample(TimeSpan.FromMinutes(2), t0.AddMinutes(2));

        Assert.True(svc.TryGetValue("battery", FlowMetricKey.For(FlowMetricKey.OwnEnergyTotal, "in"), out var charged));
        Assert.Equal(0.12, charged, 3);
    }

    [Fact]
    public async Task EnergyIsPublishedFromTheOwnTotalWithoutTheCounter()
    {
        var cfg = new Config();
        cfg.EnergyFlow.MqttExport = true;
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode
        {
            Id = "grid", Label = "Grid", Kind = "grid",
            Sources =
            [
                new EnergyFlowSource { Type = "mqtt", Metric = "realpower", Direction = "split", Topic = "sa/grid_power" },
                new EnergyFlowSource { Type = "mqtt", Metric = "energy", Direction = "out", Topic = "sa/grid_in" },
                new EnergyFlowSource { Type = "mqtt", Metric = "energy", Direction = "in", Topic = "sa/grid_out" },
            ],
        });
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "home", Label = "Home", Kind = "load" });
        cfg.EnergyFlow.Links.Add(new EnergyFlowLink { From = "grid", To = "home" });

        var src = new Fixed();
        src.Values["grid|realpower"] = 800;
        src.Values["grid|" + FlowMetricKey.OwnEnergyTotal] = 12;
        src.Values["grid|" + FlowMetricKey.For(FlowMetricKey.OwnEnergyTotal, "in")] = 3;
        var pub = new Captured();
        var pass = ExportPass.Build([new PduSnapshot("pdu", DateTime.UtcNow, new PduData())], cfg, src);
        await new MqttIntegration(cfg, pub, src).SendAsync(pass, CancellationToken.None);

        var grid = pub.Sent.Where(kv => !kv.Key.Contains("/config") && !string.IsNullOrWhiteSpace(kv.Value))
            .Select(kv => JsonDocument.Parse(kv.Value).RootElement.Clone())
            .Single(v => v.GetProperty("id").GetString() == "grid");
        Assert.Equal(12, grid.GetProperty("energy_out").GetDouble(), 3);
        Assert.Equal(3, grid.GetProperty("energy_in").GetDouble(), 3);
        Assert.Equal(15, grid.GetProperty("energy").GetDouble(), 3);
    }

    [Fact]
    public void DiscoveryRetiresTheDailySensors()
    {
        var parts = FlowExport.DiscoveryDocument(new FlowNode("grid", "Grid", "grid", 800), null,
            "energy/grid", "kWh", "W", null)["components"]!.AsObject();

        Assert.Equal("sensor", (string?)parts["energyflow_grid_energy_d"]!["platform"]);
        Assert.Null(parts["energyflow_grid_energy_d"]!["unique_id"]);
        Assert.Null(parts["energyflow_grid_energy_today"]!["unique_id"]);
        Assert.NotNull(parts["energyflow_grid_energy"]!["unique_id"]);
    }

    [Fact]
    public void ADashboardDeviceOfOursNoLongerProducedIsOurs()
    {
        var uniqueByEntity = new Dictionary<string, string>
        {
            ["sensor.office_minisplit_energy_2"] = "energyflow_breaker_sub_panel_1_5_energy",
            ["sensor.fridge_plug_energy"] = "0x00124b_energy",
        };
        var managed = new HashSet<string> { "sensor.office_minisplit_energy" };

        Assert.True(EnergyDashboardSync.IsOurDevice("sensor.office_minisplit_energy", uniqueByEntity, managed));
        Assert.True(EnergyDashboardSync.IsOurDevice("sensor.office_minisplit_energy_2", uniqueByEntity, managed));
        Assert.False(EnergyDashboardSync.IsOurDevice("sensor.fridge_plug_energy", uniqueByEntity, managed));
        Assert.False(EnergyDashboardSync.IsOurDevice("sensor.not_in_registry", uniqueByEntity, managed));
    }
}

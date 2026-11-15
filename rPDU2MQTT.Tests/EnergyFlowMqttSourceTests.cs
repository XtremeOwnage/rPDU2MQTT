using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Energy-flow nodes fed from MQTT — payload parsing, and the builder preferring a live reading over the node's static Value.</summary>
public class EnergyFlowMqttSourceTests
{
    /// <summary>A stand-in for the live MQTT cache.</summary>
    private sealed class FakeLive : IFlowValueSource
    {
        private readonly Dictionary<(string, string), double> values = new();
        public FakeLive Set(string node, string metric, double v) { values[(node, metric)] = v; return this; }
        public bool TryGetValue(string nodeId, string metric, out double value)
            => values.TryGetValue((nodeId, metric), out value);
    }

    private static Outlet Outlet(int key, string name, string type, string value, string units = "W")
    {
        var o = new Outlet { Key = key, Entity_Name = $"o{key}", Entity_DisplayName = name };
        o.Measurements.Add(new Measurement { Type = type, Value = value, Units = units });
        return o;
    }

    private static PduData OnePdu(params Outlet[] outlets)
    {
        var device = new Device { Key = "pdu1", Entity_Name = "pdu1", Entity_DisplayName = "PDU 1" };
        device.Outlets.AddRange(outlets);
        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }


    [Theory]
    [InlineData("1234", 1234d)]
    [InlineData("1234.5", 1234.5d)]
    [InlineData("  42 ", 42d)]
    [InlineData("-15.5", -15.5d)]
    [InlineData("0", 0d)]
    public void TryParse_ReadsABarePayload(string payload, double expected)
    {
        Assert.True(EnergyFlowMqttSourceService.TryParse(payload, null, out var v));
        Assert.Equal(expected, v);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("ON")]
    [InlineData("unavailable")]
    public void TryParse_RejectsANonNumericPayload(string payload)
        => Assert.False(EnergyFlowMqttSourceService.TryParse(payload, null, out _));

    [Fact]
    public void TryParse_ReadsAJsonField()
    {
        Assert.True(EnergyFlowMqttSourceService.TryParse("""{"power":812.5,"unit":"W"}""", "power", out var v));
        Assert.Equal(812.5, v);
    }

    [Fact]
    public void TryParse_ReadsANestedJsonField()
    {
        Assert.True(EnergyFlowMqttSourceService.TryParse("""{"battery":{"power":-240}}""", "battery.power", out var v));
        Assert.Equal(-240, v);
    }

    [Fact]
    public void TryParse_ReadsANumberPublishedAsAString()
    {
        Assert.True(EnergyFlowMqttSourceService.TryParse("""{"power":"812.5"}""", "power", out var v));
        Assert.Equal(812.5, v);
    }

    [Theory]
    [InlineData("""{"power":1}""", "missing")]
    [InlineData("""{"power":{"a":1}}""", "power")]
    [InlineData("not json", "power")]
    [InlineData("""{"power":1}""", "power.deeper")]
    public void TryParse_RejectsAJsonPayloadItCannotRead(string payload, string field)
        => Assert.False(EnergyFlowMqttSourceService.TryParse(payload, field, out _));

    [Fact]
    public void TryParse_WithoutAFieldDoesNotAcceptAJsonObject()
        => Assert.False(EnergyFlowMqttSourceService.TryParse("""{"power":1}""", null, out _));


    [Fact]
    public void Cache_ReturnsAFreshReading()
    {
        var now = new DateTime(2026, 7, 17, 12, 0, 0, DateTimeKind.Utc);
        var cache = new FlowValueCache();
        cache.Set("solar", "realpower", 750, staleAfterSeconds: 900, now);

        Assert.True(cache.TryGetValue("solar", "realpower", now.AddSeconds(60), out var v));
        Assert.Equal(750, v);
    }

    [Fact]
    public void Cache_ExpiresAReadingOnceThePublisherGoesQuiet()
    {
        var now = new DateTime(2026, 7, 17, 12, 0, 0, DateTimeKind.Utc);
        var cache = new FlowValueCache();
        cache.Set("solar", "realpower", 750, staleAfterSeconds: 900, now);

        Assert.True(cache.TryGetValue("solar", "realpower", now.AddSeconds(900), out _));
        Assert.False(cache.TryGetValue("solar", "realpower", now.AddSeconds(901), out _));
    }

    [Fact]
    public void Cache_ZeroStaleAfterMeansNeverExpires()
    {
        var now = new DateTime(2026, 7, 17, 12, 0, 0, DateTimeKind.Utc);
        var cache = new FlowValueCache();
        cache.Set("meter", "energy", 42, staleAfterSeconds: 0, now);

        Assert.True(cache.TryGetValue("meter", "energy", now.AddDays(30), out var v));
        Assert.Equal(42, v);
    }

    [Fact]
    public void Cache_AnExpiredNodeDropsOutOfTheGraphRatherThanExportingAStaleValue()
    {
        var cache = new FlowValueCache();

        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "outlet:pdu1:0" });

        cache.Set("solar", "realpower", 750, staleAfterSeconds: 60, DateTime.UtcNow);
        Assert.Equal(750, Assert.Single(FlowGraphBuilder.Build(data, flow, "realpower", cache).Links, l => l.Source == "solar").Value);

        cache.Set("solar", "realpower", 750, staleAfterSeconds: 60, DateTime.UtcNow.AddDays(-1));
        Assert.Equal(100, Assert.Single(FlowGraphBuilder.Build(data, flow, "realpower", cache).Links, l => l.Source == "solar").Value);
    }

    [Fact]
    public void Cache_LatestWriteWins()
    {
        var now = new DateTime(2026, 7, 17, 12, 0, 0, DateTimeKind.Utc);
        var cache = new FlowValueCache();
        cache.Set("solar", "realpower", 100, 900, now);
        cache.Set("solar", "realpower", 250, 900, now.AddSeconds(5));

        Assert.True(cache.TryGetValue("solar", "realpower", now.AddSeconds(6), out var v));
        Assert.Equal(250, v);
    }

    [Fact]
    public void Cache_RemoveDropsTheReading()
    {
        var now = new DateTime(2026, 7, 17, 12, 0, 0, DateTimeKind.Utc);
        var cache = new FlowValueCache();
        cache.Set("solar", "realpower", 100, 900, now);
        cache.Remove("solar", "realpower");

        Assert.False(cache.TryGetValue("solar", "realpower", now, out _));
    }


    private static EnergyFlowNode NodeWith(string id, params EnergyFlowSource[] sources)
    {
        var n = new EnergyFlowNode { Id = id, Label = id };
        n.Sources.AddRange(sources);
        return n;
    }

    [Fact]
    public void Apply_RoutesAPayloadToTheBoundNodeAndMetric()
    {
        var nodes = new[] { NodeWith("solar", new EnergyFlowSource { Topic = "sa/pv_power", Metric = "realpower" }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_power", "812.5", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("solar", "realpower", out var v));
        Assert.Equal(812.5, v);
    }

    [Fact]
    public void Apply_KeepsInAndOutDirectionsSeparate()
    {
        var nodes = new[]
        {
            NodeWith("battery",
                new EnergyFlowSource { Topic = "sa/discharge", Metric = "energy" },
                new EnergyFlowSource { Topic = "sa/charge", Metric = "energy", Direction = "in" }),
        };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/discharge", "12.5", DateTime.UtcNow);
        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/charge", "4.0", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("battery", "energy", out var discharge));
        Assert.Equal(12.5, discharge);
        Assert.True(cache.TryGetValue("battery", FlowMetricKey.For("energy", "in"), out var charge));
        Assert.Equal(4.0, charge);
    }

    [Theory]
    [InlineData("energy", "out", "energy")]
    [InlineData("energy", "in", "energy#in")]
    [InlineData("energy", null, "energy")]
    [InlineData("energy", "IN", "energy#in")]
    public void FlowMetricKey_SuffixesOnlyTheInDirection(string metric, string? direction, string expected)
        => Assert.Equal(expected, FlowMetricKey.For(metric, direction));

    [Fact]
    public void Apply_SplitDirection_FansOneSignedValueIntoBothOutAndIn()
    {
        var nodes = new[] { NodeWith("battery", new EnergyFlowSource { Topic = "sa/batt_power", Metric = "realpower", Direction = "split" }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/batt_power", "1500", DateTime.UtcNow);
        Assert.True(cache.TryGetValue("battery", "realpower", out var outV) && outV == 1500);
        Assert.True(cache.TryGetValue("battery", FlowMetricKey.For("realpower", "in"), out var inV) && inV == 0);

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/batt_power", "-800", DateTime.UtcNow);
        Assert.True(cache.TryGetValue("battery", "realpower", out outV) && outV == 0);
        Assert.True(cache.TryGetValue("battery", FlowMetricKey.For("realpower", "in"), out inV) && inV == 800);
    }

    [Fact]
    public void FlowMetricKey_Fan_SplitsSignedValue_ElsePassesThrough()
    {
        Assert.Equal(new[] { ("p", 5.0), ("p#in", 0.0) }, FlowMetricKey.Fan("p", "split", 5).ToArray());
        Assert.Equal(new[] { ("p", 0.0), ("p#in", 3.0) }, FlowMetricKey.Fan("p", "split", -3).ToArray());
        Assert.Equal(new[] { ("p", -3.0) }, FlowMetricKey.Fan("p", "out", -3).ToArray());
        Assert.Equal(new[] { ("p#in", 4.0) }, FlowMetricKey.Fan("p", "in", 4).ToArray());
    }

    [Theory]
    [InlineData("realpower", "kW", 1000)]
    [InlineData("energy", "Wh", 0.001)]
    [InlineData("voltage", "mV", 0.001)]
    [InlineData("realpower", "W", 1)]
    [InlineData("realpower", null, 1)]
    [InlineData("realpower", "bogus", 1)]
    public void FlowUnits_ConvertsToTheCanonicalUnit(string metric, string? unit, double factor)
        => Assert.Equal(factor, FlowUnits.ToCanonicalFactor(metric, unit));

    [Fact]
    public void FlowUnits_ExposesTheCanonicalUnitPerMetric()
    {
        Assert.Equal("W", FlowUnits.Canonical("realpower"));
        Assert.Equal("kWh", FlowUnits.Canonical("energy"));
        Assert.Contains("kW", FlowUnits.UnitsFor("realpower"));
    }

    [Fact]
    public void FlowUnits_Soc_IsAPercentageWithFractionScaling()
    {
        Assert.Equal("%", FlowUnits.Canonical("soc"));
        Assert.Equal(1, FlowUnits.ToCanonicalFactor("soc", "%"));
        Assert.Equal(100, FlowUnits.ToCanonicalFactor("soc", "fraction"));
    }

    [Fact]
    public void Apply_WithholdsAPeriodCounterThatNeverResets()
    {
        var nodes = new[] { NodeWith("solar", new EnergyFlowSource { Topic = "sa/pv_energy", Metric = "energy", Accumulation = "period" }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();
        var owner = new FakeAuditor();
        var now = DateTime.UtcNow;

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_energy", "129.9", now, null, owner.Allow, "2026-08-04");
        Assert.True(cache.TryGetValue("solar", EnergyPeriod.Metric, out var dayOne) && dayOne == 129.9);

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_energy", "130.4", now, null, owner.Allow, "2026-08-05");
        Assert.True(cache.TryGetValue("solar", EnergyPeriod.Metric, out var afterRoll) && afterRoll == 129.9,
            "the stale reading was overwritten with a value that is not today's total");
        Assert.Single(owner.Warnings);
        Assert.Contains("did not reset", owner.Warnings[0]);

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_energy", "131.0", now, null, owner.Allow, "2026-08-05");
        Assert.Single(owner.Warnings);
    }

    /// <summary>Stands in for the audit's owner.</summary>
    private sealed class FakeAuditor
    {
        private readonly Dictionary<string, PeriodCounterAudit.State> audit = new(StringComparer.Ordinal);
        public readonly List<string> Warnings = new();
        public bool Allow(string node, string source, string? direction, string periodKey, double value)
            => PeriodCounterAudit.Allow(audit, periodKey, node, source, direction, value, Warnings.Add);
    }

    [Fact]
    public void Apply_LeavesAnHonestDailyCounterAlone()
    {
        var nodes = new[] { NodeWith("solar", new EnergyFlowSource { Topic = "sa/pv_energy", Metric = "energy", Accumulation = "period" }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();
        var owner = new FakeAuditor();
        var now = DateTime.UtcNow;

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_energy", "69.4", now, null, owner.Allow, "2026-08-04");
        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_energy", "0.2", now, null, owner.Allow, "2026-08-05");

        Assert.True(cache.TryGetValue("solar", EnergyPeriod.Metric, out var today) && today == 0.2);
        Assert.Empty(owner.Warnings);
    }

    [Fact]
    public void Apply_NeverWithholdsALifetimeCounter()
    {
        var nodes = new[] { NodeWith("grid", new EnergyFlowSource { Topic = "sa/grid_energy", Metric = "energy", Accumulation = "lifetime" }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();
        var owner = new FakeAuditor();
        var now = DateTime.UtcNow;

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/grid_energy", "1306.3", now, null, owner.Allow, "2026-08-04");
        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/grid_energy", "1308.4", now, null, owner.Allow, "2026-08-05");

        Assert.True(cache.TryGetValue("grid", "energy", out var v) && v == 1308.4);
        Assert.Empty(owner.Warnings);
    }

    [Fact]
    public void Apply_ConvertsTheSourceUnitToCanonicalBeforeCaching()
    {
        var nodes = new[] { NodeWith("solar", new EnergyFlowSource { Topic = "sa/pv_power", Metric = "realpower", Unit = "kW" }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_power", "6", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("solar", "realpower", out var v));
        Assert.Equal(6000, v);
    }

    [Fact]
    public void Apply_UnitConversionAndScaleCompose()
    {
        var nodes = new[] { NodeWith("batt", new EnergyFlowSource { Topic = "sa/batt", Metric = "realpower", Unit = "kW", Scale = -1 }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/batt", "2", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("batt", "realpower", out var v));
        Assert.Equal(-2000, v);
    }

    [Fact]
    public void Apply_AppliesScaleAndReadsAJsonField()
    {
        var nodes = new[] { NodeWith("meter", new EnergyFlowSource { Topic = "sa/energy", Metric = "energy", JsonField = "wh", Scale = 0.001 }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/energy", """{"wh":1500}""", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("meter", "energy", out var v));
        Assert.Equal(1.5, v);
    }

    [Fact]
    public void Apply_IgnoresAnUnboundTopic()
    {
        var bindings = EnergyFlowMqttSourceService.BuildBindings(
            new[] { NodeWith("solar", new EnergyFlowSource { Topic = "sa/pv_power", Metric = "realpower" }) });
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "some/other/topic", "999", DateTime.UtcNow);

        Assert.Empty(cache.Keys);
    }

    [Fact]
    public void Apply_LeavesTheCacheUntouchedForAnUnparseablePayload()
    {
        var bindings = EnergyFlowMqttSourceService.BuildBindings(
            new[] { NodeWith("solar", new EnergyFlowSource { Topic = "sa/pv_power", Metric = "realpower" }) });
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_power", "unavailable", DateTime.UtcNow);

        Assert.False(cache.TryGetValue("solar", "realpower", out _));
    }

    [Fact]
    public void Apply_FansOneTopicOutToEveryNodeBoundToIt()
    {
        var nodes = new[]
        {
            NodeWith("a", new EnergyFlowSource { Topic = "shared/power", Metric = "realpower" }),
            NodeWith("b", new EnergyFlowSource { Topic = "shared/power", Metric = "realpower", Scale = 2 }),
        };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "shared/power", "50", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("a", "realpower", out var va)); Assert.Equal(50, va);
        Assert.True(cache.TryGetValue("b", "realpower", out var vb)); Assert.Equal(100, vb);
    }

    [Fact]
    public void Apply_SumsSeveralSourcesOnOneMetric()
    {
        var nodes = new[]
        {
            NodeWith("main",
                new EnergyFlowSource { Topic = "n30/l1_power", Metric = "realpower", Scale = 0.5 },
                new EnergyFlowSource { Topic = "n30/l2_power", Metric = "realpower", Scale = 0.5 }),
        };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();
        var now = DateTime.UtcNow;

        EnergyFlowMqttSourceService.Apply(bindings, cache, "n30/l1_power", "1650", now);
        Assert.False(cache.TryGetValue("main", "realpower", now, out _));

        EnergyFlowMqttSourceService.Apply(bindings, cache, "n30/l2_power", "1730", now);
        Assert.True(cache.TryGetValue("main", "realpower", now, out var v)); Assert.Equal(1690, v);

        EnergyFlowMqttSourceService.Apply(bindings, cache, "n30/l1_power", "1850", now);
        Assert.True(cache.TryGetValue("main", "realpower", now, out v)); Assert.Equal(1790, v);
    }

    [Fact]
    public void Apply_WithholdsTheSumWhileAPartIsStale()
    {
        var nodes = new[]
        {
            NodeWith("main",
                new EnergyFlowSource { Topic = "a", Metric = "energy", StaleAfterSeconds = 60 },
                new EnergyFlowSource { Topic = "b", Metric = "energy", StaleAfterSeconds = 60 }),
        };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();
        var t0 = DateTime.UtcNow;

        EnergyFlowMqttSourceService.Apply(bindings, cache, "a", "10", t0);
        EnergyFlowMqttSourceService.Apply(bindings, cache, "b", "20", t0);
        Assert.True(cache.TryGetValue("main", "energy", t0, out var v)); Assert.Equal(30, v);

        EnergyFlowMqttSourceService.Apply(bindings, cache, "a", "11", t0.AddSeconds(120));
        Assert.True(cache.TryGetValue("main", "energy", t0, out v)); Assert.Equal(30, v);
    }

    [Fact]
    public void BuildBindings_SkipsNodesWithNoTopicOrId()
    {
        var nodes = new[]
        {
            NodeWith("", new EnergyFlowSource { Topic = "t1", Metric = "realpower" }),
            NodeWith("ok", new EnergyFlowSource { Topic = "", Metric = "realpower" }),
            NodeWith("solar", new EnergyFlowSource { Topic = "  sa/pv  ", Metric = "realpower" }),
        };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);

        Assert.True(bindings.ContainsKey("sa/pv"));
        Assert.Single(bindings);
    }


    [Fact]
    public void Build_UsesTheLiveValueForAnMqttBoundNode()
    {
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "panel", Label = "Panel" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "panel" });
        flow.Links.Add(new EnergyFlowLink { From = "panel", To = "outlet:pdu1:0" });

        var graph = FlowGraphBuilder.Build(data, flow, "realpower", new FakeLive().Set("solar", "realpower", 750));

        var link = Assert.Single(graph.Links, l => l.Source == "solar" && l.Target == "panel");
        Assert.Equal(750, link.Value);
    }

    [Fact]
    public void Build_PrefersTheLiveValueOverTheStaticValue()
    {
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar", Value = 50 });
        flow.Nodes.Add(new EnergyFlowNode { Id = "panel", Label = "Panel" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "panel" });
        flow.Links.Add(new EnergyFlowLink { From = "panel", To = "outlet:pdu1:0" });

        var graph = FlowGraphBuilder.Build(data, flow, "realpower", new FakeLive().Set("solar", "realpower", 750));

        Assert.Equal(750, Assert.Single(graph.Links, l => l.Source == "solar").Value);
    }

    [Fact]
    public void Build_FallsBackToTheStaticValueWhenNothingIsReported()
    {
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar", Value = 50 });
        flow.Nodes.Add(new EnergyFlowNode { Id = "panel", Label = "Panel" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "panel" });
        flow.Links.Add(new EnergyFlowLink { From = "panel", To = "outlet:pdu1:0" });

        var graph = FlowGraphBuilder.Build(data, flow, "realpower", new FakeLive().Set("solar", "energy", 9));

        Assert.Equal(50, Assert.Single(graph.Links, l => l.Source == "solar").Value);
    }

    [Fact]
    public void Build_LiveValueIsPerMetric()
    {
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"), Outlet(1, "Load", "energy", "5", "kWh"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "panel", Label = "Panel" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "panel" });

        var live = new FakeLive().Set("solar", "realpower", 750).Set("solar", "energy", 12.5);

        Assert.Equal(750, Assert.Single(FlowGraphBuilder.Build(data, flow, "realpower", live).Links, l => l.Source == "solar").Value);
        Assert.Equal(12.5, Assert.Single(FlowGraphBuilder.Build(data, flow, "energy", live).Links, l => l.Source == "solar").Value);
    }

    [Fact]
    public void Build_LiveZeroMeansZeroAndDoesNotFallBackToValue()
    {
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar", Value = 50 });
        flow.Nodes.Add(new EnergyFlowNode { Id = "panel", Label = "Panel" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "panel" });
        flow.Links.Add(new EnergyFlowLink { From = "panel", To = "outlet:pdu1:0" });

        var graph = FlowGraphBuilder.Build(data, flow, "realpower", new FakeLive().Set("solar", "realpower", 0));

        Assert.DoesNotContain(graph.Links, l => l.Source == "solar");
    }

    [Fact]
    public void Build_ClampsANegativeLiveReadingRatherThanSubtractingFromTheRollUp()
    {
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "battery", Label = "Battery" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "panel", Label = "Panel" });
        flow.Links.Add(new EnergyFlowLink { From = "battery", To = "panel" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "panel" });
        flow.Links.Add(new EnergyFlowLink { From = "panel", To = "outlet:pdu1:0" });

        var live = new FakeLive().Set("battery", "realpower", -240).Set("solar", "realpower", 600);
        var graph = FlowGraphBuilder.Build(data, flow, "realpower", live);

        Assert.DoesNotContain(graph.Links, l => l.Source == "battery");
        Assert.Equal(600, Assert.Single(graph.Links, l => l.Source == "solar").Value);
    }

    [Fact]
    public void Build_MidChainNodeReadingZero_KeepsTheWiredLink_SoDownstreamStaysConnected()
    {
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "inverter", Label = "Inverter" });
        flow.Nodes.Add(new EnergyFlowNode { Id = "gridboss", Label = "GridBoss" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "inverter" });
        flow.Links.Add(new EnergyFlowLink { From = "inverter", To = "gridboss" });
        flow.Links.Add(new EnergyFlowLink { From = "gridboss", To = "outlet:pdu1:0" });

        var live = new FakeLive().Set("solar", "realpower", 4916).Set("inverter", "realpower", 0).Set("gridboss", "realpower", 3322);
        var graph = FlowGraphBuilder.Build(data, flow, "realpower", live);

        var link = Assert.Single(graph.Links, l => l.Source == "inverter" && l.Target == "gridboss");
        Assert.Equal(0, link.Value);
        Assert.True(link.Known);
        var night = FlowGraphBuilder.Build(data, flow, "realpower",
            new FakeLive().Set("solar", "realpower", 0).Set("inverter", "realpower", 0).Set("gridboss", "realpower", 3322));
        Assert.DoesNotContain(night.Links, l => l.Source == "solar");
    }

    [Fact]
    public void Build_WithoutALiveSourceIsUnchanged()
    {
        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar", Value = 50 });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "outlet:pdu1:0" });

        var withNull = FlowGraphBuilder.Build(data, flow, "realpower", null);
        var withDefault = FlowGraphBuilder.Build(data, flow, "realpower");

        Assert.Equal(withDefault.Links.Count, withNull.Links.Count);
        Assert.Equal(50, Assert.Single(withNull.Links, l => l.Source == "solar").Value);
    }
[Fact]
    public void Cache_ReportsAnExpiredReading_RatherThanHidingIt()
    {
        var cache = new FlowValueCache();
        var t0 = new DateTime(2026, 7, 30, 12, 0, 0, DateTimeKind.Utc);
        cache.Set("battery", "soc", 87, staleAfterSeconds: 60, nowUtc: t0);

        var later = t0.AddMinutes(10);
        Assert.False(cache.TryGetValue("battery", "soc", later, out _));

        Assert.True(cache.TryDescribe("battery", "soc", later, out var reading));
        Assert.Equal(87, reading.Value);
        Assert.False(reading.Fresh);
        Assert.Equal(t0, reading.AtUtc);

        Assert.False(cache.TryDescribe("battery", "temperature", later, out _));
    }
}

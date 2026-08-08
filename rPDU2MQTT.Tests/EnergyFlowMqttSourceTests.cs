using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Energy-flow nodes fed from MQTT (#205) — payload parsing, and the builder preferring a live reading
/// over the node's static Value.
/// </summary>
public class EnergyFlowMqttSourceTests
{
    /// <summary>A stand-in for the live MQTT cache: whatever the test says is currently reported.</summary>
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

    // --- Payload parsing ---------------------------------------------------------------------------

    [Theory]
    // Solar Assistant's /state topics publish the bare number.
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
    [InlineData("""{"power":1}""", "missing")]          // field absent
    [InlineData("""{"power":{"a":1}}""", "power")]      // field isn't a number
    [InlineData("not json", "power")]                   // payload isn't JSON
    [InlineData("""{"power":1}""", "power.deeper")]     // path runs past a leaf
    public void TryParse_RejectsAJsonPayloadItCannotRead(string payload, string field)
        => Assert.False(EnergyFlowMqttSourceService.TryParse(payload, field, out _));

    [Fact]
    public void TryParse_WithoutAFieldDoesNotAcceptAJsonObject()
        => Assert.False(EnergyFlowMqttSourceService.TryParse("""{"power":1}""", null, out _));

    // --- Staleness (FlowValueCache) ----------------------------------------------------------------

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
        // The point of the whole staleness rule: a dead Solar Assistant must stop propping up the flow.
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
        // The builder resolves freshness against the real clock (no seam for "now"), so seed timestamps
        // relative to DateTime.UtcNow rather than a fixed instant, or the "fresh" reading is already stale.
        var cache = new FlowValueCache();

        var data = OnePdu(Outlet(0, "Load", "realpower", "100"));
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "outlet:pdu1:0" });

        // Fresh: just published, so solar supplies its reading.
        cache.Set("solar", "realpower", 750, staleAfterSeconds: 60, DateTime.UtcNow);
        Assert.Equal(750, Assert.Single(FlowGraphBuilder.Build(data, flow, "realpower", cache).Links, l => l.Source == "solar").Value);

        // Stale: last published a day ago, past the 60s window. The reading is gone, so the node has no
        // value of its own and falls back to carrying the outlet's demand rather than reporting a
        // generation figure that stopped being true.
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

    // --- Subscribe → parse → cache glue (BuildBindings + Apply) ------------------------------------

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
        // A battery binds discharge (out, default) and charge (in) on the same node/metric. Before the
        // direction key they collided on (node, "energy") and one silently overwrote the other.
        var nodes = new[]
        {
            NodeWith("battery",
                new EnergyFlowSource { Topic = "sa/discharge", Metric = "energy" },                      // out (default)
                new EnergyFlowSource { Topic = "sa/charge", Metric = "energy", Direction = "in" }),
        };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/discharge", "12.5", DateTime.UtcNow);
        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/charge", "4.0", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("battery", "energy", out var discharge));     // the supply value the roll-up reads
        Assert.Equal(12.5, discharge);
        Assert.True(cache.TryGetValue("battery", FlowMetricKey.For("energy", "in"), out var charge));
        Assert.Equal(4.0, charge);
    }

    [Theory]
    [InlineData("energy", "out", "energy")]
    [InlineData("energy", "in", "energy#in")]
    [InlineData("energy", null, "energy")]        // default is out
    [InlineData("energy", "IN", "energy#in")]     // case-insensitive
    public void FlowMetricKey_SuffixesOnlyTheInDirection(string metric, string? direction, string expected)
        => Assert.Equal(expected, FlowMetricKey.For(metric, direction));

    [Fact]
    public void Apply_SplitDirection_FansOneSignedValueIntoBothOutAndIn()
    {
        // A single battery-power topic swings ±: positive = discharging (out), negative = charging (in). One
        // 'split' binding drives both, so the user needn't invent two topics they don't have.
        var nodes = new[] { NodeWith("battery", new EnergyFlowSource { Topic = "sa/batt_power", Metric = "realpower", Direction = "split" }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/batt_power", "1500", DateTime.UtcNow);   // discharging
        Assert.True(cache.TryGetValue("battery", "realpower", out var outV) && outV == 1500);
        Assert.True(cache.TryGetValue("battery", FlowMetricKey.For("realpower", "in"), out var inV) && inV == 0);

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/batt_power", "-800", DateTime.UtcNow);   // charging
        Assert.True(cache.TryGetValue("battery", "realpower", out outV) && outV == 0);
        Assert.True(cache.TryGetValue("battery", FlowMetricKey.For("realpower", "in"), out inV) && inV == 800);
    }

    [Fact]
    public void FlowMetricKey_Fan_SplitsSignedValue_ElsePassesThrough()
    {
        Assert.Equal(new[] { ("p", 5.0), ("p#in", 0.0) }, FlowMetricKey.Fan("p", "split", 5).ToArray());
        Assert.Equal(new[] { ("p", 0.0), ("p#in", 3.0) }, FlowMetricKey.Fan("p", "split", -3).ToArray());
        Assert.Equal(new[] { ("p", -3.0) }, FlowMetricKey.Fan("p", "out", -3).ToArray());   // no split: as-is
        Assert.Equal(new[] { ("p#in", 4.0) }, FlowMetricKey.Fan("p", "in", 4).ToArray());
    }

    [Theory]
    [InlineData("realpower", "kW", 1000)]        // 1 kW -> 1000 W
    [InlineData("energy", "Wh", 0.001)]          // 1 Wh -> 0.001 kWh
    [InlineData("voltage", "mV", 0.001)]         // 1 mV -> 0.001 V
    [InlineData("realpower", "W", 1)]            // already canonical
    [InlineData("realpower", null, 1)]           // no unit -> assumed canonical
    [InlineData("realpower", "bogus", 1)]        // unknown unit -> no-op, never scales wildly
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
        Assert.Equal(1, FlowUnits.ToCanonicalFactor("soc", "%"));      // already a percentage
        Assert.Equal(100, FlowUnits.ToCanonicalFactor("soc", "fraction")); // 0.82 -> 82%
    }

    [Fact]
    public void Apply_WithholdsAPeriodCounterThatNeverResets()
    {
        // The live failure (#292-era): a cumulative PV counter declared as a daily one was published verbatim
        // as "today", reading 129.9 kWh at 00:20 with the sun down. The pure rule is covered in
        // PeriodCounterAuditTests; this pins that the ingest actually acts on the verdict, because a rule
        // nothing consults changes nothing.
        var nodes = new[] { NodeWith("solar", new EnergyFlowSource { Topic = "sa/pv_energy", Metric = "energy", Accumulation = "period" }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();
        var owner = new FakeAuditor();
        var now = DateTime.UtcNow;

        // Day one: no evidence yet, so it is trusted and published as the day's total.
        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_energy", "129.9", now, null, owner.Allow, "2026-08-04");
        Assert.True(cache.TryGetValue("solar", EnergyPeriod.Metric, out var dayOne) && dayOne == 129.9);

        // The rollover, with the counter carrying straight on. That is not today's total, and it must not be
        // stated as one — the cache keeps no new value, so the node reports no data rather than 129.9 kWh.
        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_energy", "130.4", now, null, owner.Allow, "2026-08-05");
        Assert.True(cache.TryGetValue("solar", EnergyPeriod.Metric, out var afterRoll) && afterRoll == 129.9,
            "the stale reading was overwritten with a value that is not today's total");
        Assert.Single(owner.Warnings);
        Assert.Contains("did not reset", owner.Warnings[0]);

        // Still withheld on every later sample, and the operator is told once, not once per message.
        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_energy", "131.0", now, null, owner.Allow, "2026-08-05");
        Assert.Single(owner.Warnings);
    }

    /// <summary>Stands in for the audit's owner — the grain in production.</summary>
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
        // The audit exists to check a claim only 'period' sources make. A lifetime counter is *supposed* to
        // keep climbing across midnight, and the daily figure is derived from it — auditing it would break
        // every correctly configured install.
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
        // Solar Assistant publishing kW must land in the cache as W, so it lines up with the PDU's watts.
        var nodes = new[] { NodeWith("solar", new EnergyFlowSource { Topic = "sa/pv_power", Metric = "realpower", Unit = "kW" }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/pv_power", "6", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("solar", "realpower", out var v));
        Assert.Equal(6000, v);   // 6 kW -> 6000 W
    }

    [Fact]
    public void Apply_UnitConversionAndScaleCompose()
    {
        // Unit normalises (kW -> W), then Scale flips the sign convention on top.
        var nodes = new[] { NodeWith("batt", new EnergyFlowSource { Topic = "sa/batt", Metric = "realpower", Unit = "kW", Scale = -1 }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/batt", "2", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("batt", "realpower", out var v));
        Assert.Equal(-2000, v);   // 2 kW -> 2000 W, then * -1
    }

    [Fact]
    public void Apply_AppliesScaleAndReadsAJsonField()
    {
        var nodes = new[] { NodeWith("meter", new EnergyFlowSource { Topic = "sa/energy", Metric = "energy", JsonField = "wh", Scale = 0.001 }) };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);
        var cache = new FlowValueCache();

        EnergyFlowMqttSourceService.Apply(bindings, cache, "sa/energy", """{"wh":1500}""", DateTime.UtcNow);

        Assert.True(cache.TryGetValue("meter", "energy", out var v));
        Assert.Equal(1.5, v);   // 1500 Wh * 0.001 = 1.5 kWh
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
        // A shared bus topic can legitimately feed more than one node.
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
    public void BuildBindings_SkipsNodesWithNoTopicOrId()
    {
        var nodes = new[]
        {
            NodeWith("", new EnergyFlowSource { Topic = "t1", Metric = "realpower" }),         // no id
            NodeWith("ok", new EnergyFlowSource { Topic = "", Metric = "realpower" }),          // no topic
            NodeWith("solar", new EnergyFlowSource { Topic = "  sa/pv  ", Metric = "realpower" }), // trimmed
        };
        var bindings = EnergyFlowMqttSourceService.BuildBindings(nodes);

        Assert.True(bindings.ContainsKey("sa/pv"));
        Assert.Single(bindings);
    }

    // --- Builder integration -----------------------------------------------------------------------

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

        // Solar is a producer: it supplies its measured generation into the panel.
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

        // A live source exists but has only reported energy — the power graph must still use Value.
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
        // Solar at night reports 0. That's a real reading, not "no reading" — the static Value must not
        // resurrect a phantom 50W, so the producer link drops out entirely.
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
        // Battery power is negative under some sign conventions (Solar Assistant included). A directed DAG
        // can't carry a negative flow, and letting it through would subtract from the parent's roll-up, so
        // it clamps to 0 — Scale: -1 is the way to flip the convention.
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
        // Solar's contribution is untouched by the battery's negative reading.
        Assert.Equal(600, Assert.Single(graph.Links, l => l.Source == "solar").Value);
    }

    [Fact]
    public void Build_MidChainNodeReadingZero_KeepsTheWiredLink_SoDownstreamStaysConnected()
    {
        // A real setup: Solar (PV) → inverter → GridBoss, a live source bound to each. The inverter's "load
        // output" register reads 0 (its PV feeds straight through to the grid), which used to zero the
        // inverter→gridboss link and drop it — detaching GridBoss into a root and breaking the wired chain.
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

        // The wired inverter→gridboss link survives (a hairline 0), so GridBoss keeps its feeder and the chain
        // renders solar → inverter → gridboss instead of GridBoss floating off as a root.
        var link = Assert.Single(graph.Links, l => l.Source == "inverter" && l.Target == "gridboss");
        Assert.Equal(0, link.Value);
        Assert.True(link.Known);
        // Contrast: a *pure* zero-producing source (no inflow) still drops — solar reading 0 has no link.
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
        // TryGetValue must hide a stale reading — the roll-up and exports must never carry one. But a UI
        // needs to tell "this publisher died an hour ago" apart from "nothing was ever bound here", and
        // those look identical if the expired value is simply dropped. TryDescribe returns it, flagged.
        var cache = new FlowValueCache();
        var t0 = new DateTime(2026, 7, 30, 12, 0, 0, DateTimeKind.Utc);
        cache.Set("battery", "soc", 87, staleAfterSeconds: 60, nowUtc: t0);

        var later = t0.AddMinutes(10);
        Assert.False(cache.TryGetValue("battery", "soc", later, out _));

        Assert.True(cache.TryDescribe("battery", "soc", later, out var reading));
        Assert.Equal(87, reading.Value);
        Assert.False(reading.Fresh);
        Assert.Equal(t0, reading.AtUtc);

        // And nothing at all is still nothing — the two states stay distinct.
        Assert.False(cache.TryDescribe("battery", "temperature", later, out _));
    }
}

using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Values worked out from a node's other readings. The arithmetic is school electrics; what matters is
/// which relation is reached for, that an approximation says it is one, and that nothing is produced when
/// the readings behind it are not there (#395 follow-up).
/// </summary>
public class DerivedMetricsTests
{
    private static EnergyFlowConfig Flow(params EnergyFlowSource[] sources) => new()
    {
        Nodes = new() { new EnergyFlowNode { Id = "grid", Label = "Grid", Kind = "grid", Sources = sources.ToList() } },
    };

    private static EnergyFlowSource Src(string metric, string type = "mqtt", string direction = "out")
        => new() { Type = type, Metric = metric, Direction = direction, Topic = type == "mqtt" ? "x/y" : "" };

    private static EnergyFlowSource Derived(string metric, string direction = "out") => Src(metric, "derived", direction);

    private sealed class Fake : IFlowValueSource
    {
        public Dictionary<string, double> Values { get; } = new(StringComparer.OrdinalIgnoreCase);
        public bool TryGetValue(string nodeId, string metric, out double value)
            => Values.TryGetValue(nodeId + "|" + metric, out value);
    }

    private static DerivedFlowValueSource Build(Fake inner, params EnergyFlowSource[] sources)
        => new(inner, Flow(sources));

    // --- Each way round ------------------------------------------------------------------------------

    [Fact]
    public void CurrentFromApparentPowerAndVoltage()
    {
        var inner = new Fake();
        inner.Values["grid|apparentpower"] = 2500;
        inner.Values["grid|voltage"] = 250;
        var src = Build(inner, Src("apparentpower"), Src("voltage"), Derived("current"));

        Assert.True(src.TryGetValue("grid", "current", out var amps));
        Assert.Equal(10, amps);
    }

    [Fact]
    public void VoltageFromPowerAndCurrent()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2500;
        inner.Values["grid|current"] = 10;
        var src = Build(inner, Src("realpower"), Src("current"), Derived("voltage"));

        Assert.True(src.TryGetValue("grid", "voltage", out var volts));
        Assert.Equal(250, volts);
    }

    [Fact]
    public void PowerFromVoltageAndCurrent()
    {
        var inner = new Fake();
        inner.Values["grid|voltage"] = 250;
        inner.Values["grid|current"] = 10;
        var src = Build(inner, Src("voltage"), Src("current"), Derived("realpower"));

        Assert.True(src.TryGetValue("grid", "realpower", out var watts));
        Assert.Equal(2500, watts);
    }

    [Fact]
    public void ApparentPowerFromVoltageAndCurrent()
    {
        var inner = new Fake();
        inner.Values["grid|voltage"] = 250;
        inner.Values["grid|current"] = 10;
        var src = Build(inner, Src("voltage"), Src("current"), Derived("apparentpower"));

        Assert.True(src.TryGetValue("grid", "apparentpower", out var va));
        Assert.Equal(2500, va);
    }

    [Fact]
    public void PowerFactorFromPowerAndApparentPower()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2400;
        inner.Values["grid|apparentpower"] = 2500;
        var src = Build(inner, Src("realpower"), Src("apparentpower"), Derived("powerfactor"));

        Assert.True(src.TryGetValue("grid", "powerfactor", out var pf));
        Assert.Equal(0.96, pf, 6);
    }

    [Fact]
    public void PowerFromApparentPowerAndPowerFactor()
    {
        var inner = new Fake();
        inner.Values["grid|apparentpower"] = 2500;
        inner.Values["grid|powerfactor"] = 0.96;
        var src = Build(inner, Src("apparentpower"), Src("powerfactor"), Derived("realpower"));

        Assert.True(src.TryGetValue("grid", "realpower", out var watts));
        Assert.Equal(2400, watts, 6);
    }

    // --- Which relation gets reached for --------------------------------------------------------------

    /// <summary>
    /// P = V × I is only true at a power factor of 1. With a power factor to hand the exact answer is
    /// I = (P ÷ PF) ÷ V, and taking the shortcut would under-report the current by that factor.
    /// </summary>
    [Fact]
    public void APowerFactorReadingIsUsedRatherThanAssumed()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2400;
        inner.Values["grid|voltage"] = 250;
        inner.Values["grid|powerfactor"] = 0.8;
        var src = Build(inner, Src("realpower"), Src("voltage"), Src("powerfactor"), Derived("current"));

        Assert.True(src.TryGetValue("grid", "current", out var amps));
        Assert.Equal(12, amps, 6);      // (2400 / 0.8) / 250, not 2400 / 250 = 9.6
    }

    [Fact]
    public void WithoutAPowerFactorTheShortcutIsUsedAndSaysWhatItAssumed()
    {
        var read = (string m) => m switch { "realpower" => (double?)2400, "voltage" => 250, _ => null };

        Assert.Null(DerivedMetrics.Derive("current", read, out var amps, out var assumes));
        Assert.Equal(9.6, amps, 6);
        Assert.Equal("a power factor of 1", assumes);
    }

    [Fact]
    public void AnExactRelationCarriesNoCaveat()
    {
        var read = (string m) => m switch { "apparentpower" => (double?)2500, "voltage" => 250, _ => null };

        Assert.Null(DerivedMetrics.Derive("current", read, out _, out var assumes));
        Assert.Null(assumes);
    }

    // --- Refusing to invent one -----------------------------------------------------------------------

    [Fact]
    public void OneReadingIsNotEnough()
    {
        var inner = new Fake();
        inner.Values["grid|voltage"] = 250;
        var src = Build(inner, Src("realpower"), Src("voltage"), Derived("current"));

        Assert.False(src.TryGetValue("grid", "current", out _));
        Assert.Contains(src.Withheld, w => w.Node == "grid" && w.Metric == "current");
    }

    [Fact]
    public void ZeroInTheDivisorProducesNothing()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2400;
        inner.Values["grid|voltage"] = 0;
        var src = Build(inner, Src("realpower"), Src("voltage"), Derived("current"));

        Assert.False(src.TryGetValue("grid", "current", out _));
        Assert.Contains(src.Withheld, w => w.Reason.Contains("voltage reading is 0"));
    }

    /// <summary>An ammeter beats arithmetic about an ammeter.</summary>
    [Fact]
    public void AMeasuredReadingWins()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2400;
        inner.Values["grid|voltage"] = 250;
        inner.Values["grid|current"] = 11.1;
        var src = Build(inner, Src("realpower"), Src("voltage"), Derived("current"));

        Assert.True(src.TryGetValue("grid", "current", out var amps));
        Assert.Equal(11.1, amps);
    }

    /// <summary>Nothing is worked out from itself, however many steps round the loop it would take.</summary>
    [Fact]
    public void NothingIsDerivedFromItself()
    {
        var src = Build(new Fake(), Src("realpower"), Derived("current"));

        Assert.False(src.TryGetValue("grid", "current", out _));
    }

    [Fact]
    public void NothingIsDerivedWhereNothingWasAskedFor()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2400;
        inner.Values["grid|voltage"] = 250;
        var src = Build(inner, Src("realpower"), Src("voltage"));

        Assert.False(src.TryGetValue("grid", "current", out _));
        Assert.Empty(src.Withheld);
    }

    /// <summary>The return lane divides the power going that way by the same bus voltage.</summary>
    [Fact]
    public void TheReturnLaneUsesItsOwnDirectionalReadings()
    {
        var inner = new Fake();
        inner.Values["grid|realpower#in"] = 1000;
        inner.Values["grid|voltage"] = 250;      // no direction: one bus, one voltage
        var src = Build(inner, Src("realpower", direction: "in"), Src("voltage"), Derived("current", "in"));

        Assert.True(src.TryGetValue("grid", "current#in", out var amps));
        Assert.Equal(4, amps);
    }

    // --- Live config ----------------------------------------------------------------------------------

    /// <summary>
    /// A binding added through the GUI works when it is saved. EnergyFlow is applied live and the panel
    /// says so outright, so a set built once at startup makes the editor promise something untrue.
    /// </summary>
    [Fact]
    public void ABindingAddedAfterStartupTakesEffect()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2745;
        inner.Values["grid|voltage"] = 249.1;
        var flow = Flow(Src("realpower"), Src("voltage"));
        var src = new DerivedFlowValueSource(inner, flow);
        Assert.False(src.TryGetValue("grid", "current", out _));

        flow.Nodes[0].Sources.Add(Derived("current"));

        Assert.True(src.TryGetValue("grid", "current", out var amps));
        Assert.Equal(2745 / 249.1, amps, 6);
    }

    [Fact]
    public void ABindingRemovedStopsAnswering()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2745;
        inner.Values["grid|voltage"] = 249.1;
        var flow = Flow(Src("realpower"), Src("voltage"), Derived("current"));
        var src = new DerivedFlowValueSource(inner, flow);
        Assert.True(src.TryGetValue("grid", "current", out _));

        flow.Nodes[0].Sources.RemoveAll(DerivedMetrics.IsDerived);

        Assert.False(src.TryGetValue("grid", "current", out _));
    }

    // --- Saying so before it runs ---------------------------------------------------------------------

    [Fact]
    public void ABindingWithNothingToWorkFromNamesThePairsThatWouldDo()
    {
        var message = Assert.Single(DerivedMetrics.Problems(Flow(Derived("current")))).Message;

        Assert.Contains("apparent power and voltage", message);
        Assert.Contains("power and voltage", message);
    }

    /// <summary>Half a pair is still nothing to work from.</summary>
    [Fact]
    public void OneBoundReadingIsStillAProblem()
        => Assert.Single(DerivedMetrics.Problems(Flow(Src("voltage"), Derived("current"))));

    [Fact]
    public void APairThatWorksIsNoProblem()
        => Assert.Empty(DerivedMetrics.Problems(Flow(Src("realpower"), Src("voltage"), Derived("current"))));

    /// <summary>Reached in two steps: power factor and apparent power give power, which with voltage gives current.</summary>
    [Fact]
    public void APairReachedInTwoStepsIsNoProblem()
        => Assert.Empty(DerivedMetrics.Problems(Flow(Src("apparentpower"), Src("powerfactor"), Src("voltage"), Derived("current"))));

    [Fact]
    public void AMetricNoRelationCoversSaysSo()
    {
        var message = Assert.Single(DerivedMetrics.Problems(Flow(Src("realpower"), Src("voltage"), Derived("energy")))).Message;

        Assert.Contains("cannot be worked out", message);
        Assert.Contains("current", message);      // and names the ones that can
    }
}

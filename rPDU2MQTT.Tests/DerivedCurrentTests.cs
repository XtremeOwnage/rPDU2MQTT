using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Current worked out from power and voltage, for a meter that reports watts and volts but no amps (#395
/// follow-up). The arithmetic is trivial; what matters is that it refuses to produce a figure when either
/// reading behind it is missing, and says why.
/// </summary>
public class DerivedCurrentTests
{
    private static EnergyFlowConfig Flow(params EnergyFlowSource[] sources) => new()
    {
        Nodes = new() { new EnergyFlowNode { Id = "grid", Label = "Grid", Kind = "grid", Sources = sources.ToList() } },
    };

    private static EnergyFlowSource Src(string metric, string type = "mqtt", string direction = "out")
        => new() { Type = type, Metric = metric, Direction = direction, Topic = type == "mqtt" ? "x/y" : "" };

    private static EnergyFlowSource Derived(string metric = "current", string direction = "out")
        => Src(metric, "derived", direction);

    private sealed class Fake : IFlowValueSource
    {
        public Dictionary<string, double> Values { get; } = new(StringComparer.OrdinalIgnoreCase);
        public bool TryGetValue(string nodeId, string metric, out double value)
            => Values.TryGetValue(nodeId + "|" + metric, out value);
    }

    // --- The arithmetic ------------------------------------------------------------------------------

    [Fact]
    public void CurrentIsPowerOverVoltage()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2700;
        inner.Values["grid|voltage"] = 248.7;
        var src = new DerivedFlowValueSource(inner, Flow(Src("realpower"), Src("voltage"), Derived()));

        Assert.True(src.TryGetValue("grid", "current", out var amps));
        Assert.Equal(2700 / 248.7, amps, 6);
    }

    /// <summary>An ammeter beats arithmetic about an ammeter.</summary>
    [Fact]
    public void AMeasuredReadingWins()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2700;
        inner.Values["grid|voltage"] = 248.7;
        inner.Values["grid|current"] = 11.1;
        var src = new DerivedFlowValueSource(inner, Flow(Src("realpower"), Src("voltage"), Derived()));

        Assert.True(src.TryGetValue("grid", "current", out var amps));
        Assert.Equal(11.1, amps);
    }

    /// <summary>The return lane divides the power going that way by the same bus voltage.</summary>
    [Fact]
    public void TheReturnLaneUsesItsOwnPower()
    {
        var inner = new Fake();
        inner.Values["grid|realpower#in"] = 1000;
        inner.Values["grid|voltage"] = 250;
        var src = new DerivedFlowValueSource(inner, Flow(Src("realpower", direction: "in"), Src("voltage"), Derived(direction: "in")));

        Assert.True(src.TryGetValue("grid", "current#in", out var amps));
        Assert.Equal(4, amps);
    }

    // --- Refusing to invent one ----------------------------------------------------------------------

    [Theory]
    [InlineData("grid|voltage", 248.7)]   // power missing
    [InlineData("grid|realpower", 2700)]  // voltage missing
    public void OneReadingIsNotEnough(string key, double value)
    {
        var inner = new Fake();
        inner.Values[key] = value;
        var src = new DerivedFlowValueSource(inner, Flow(Src("realpower"), Src("voltage"), Derived()));

        Assert.False(src.TryGetValue("grid", "current", out _));
        Assert.Contains(src.Withheld, w => w.Node == "grid" && w.Metric == "current");
    }

    /// <summary>Dividing by a dead voltage reading is how a node ends up with an infinite amperage.</summary>
    [Fact]
    public void ZeroVoltsProducesNothing()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2700;
        inner.Values["grid|voltage"] = 0;
        var src = new DerivedFlowValueSource(inner, Flow(Src("realpower"), Src("voltage"), Derived()));

        Assert.False(src.TryGetValue("grid", "current", out _));
        Assert.Contains(src.Withheld, w => w.Reason.Contains("voltage reading is 0"));
    }

    /// <summary>A node that never asked for this keeps its own answer: absent.</summary>
    [Fact]
    public void NothingIsDerivedWhereNothingWasAskedFor()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2700;
        inner.Values["grid|voltage"] = 248.7;
        var src = new DerivedFlowValueSource(inner, Flow(Src("realpower"), Src("voltage")));

        Assert.False(src.TryGetValue("grid", "current", out _));
        Assert.Empty(src.Withheld);
    }

    /// <summary>
    /// A binding added through the GUI works when it is saved. EnergyFlow is applied live and the panel
    /// says so outright — "takes effect without a restart once saved" — so a set built once at startup
    /// makes the editor tell an operator something that is not true.
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

        // …the operator adds the calculated binding and saves.
        flow.Nodes[0].Sources.Add(Derived());

        Assert.True(src.TryGetValue("grid", "current", out var amps));
        Assert.Equal(2745 / 249.1, amps, 6);
    }

    /// <summary>The same for a binding removed: it stops answering, without a restart.</summary>
    [Fact]
    public void ABindingRemovedStopsAnswering()
    {
        var inner = new Fake();
        inner.Values["grid|realpower"] = 2745;
        inner.Values["grid|voltage"] = 249.1;
        var flow = Flow(Src("realpower"), Src("voltage"), Derived());
        var src = new DerivedFlowValueSource(inner, flow);
        Assert.True(src.TryGetValue("grid", "current", out _));

        flow.Nodes[0].Sources.RemoveAll(DerivedCurrent.IsDerived);

        Assert.False(src.TryGetValue("grid", "current", out _));
    }

    // --- Saying so before it runs --------------------------------------------------------------------

    [Fact]
    public void ABindingWithNothingToDivideIsAProblem()
    {
        var problems = DerivedCurrent.Problems(Flow(Derived()));

        var message = Assert.Single(problems).Message;
        Assert.Contains("no power", message);
        Assert.Contains("no voltage", message);
    }

    [Fact]
    public void AMissingVoltageIsNamedOnItsOwn()
    {
        var problems = DerivedCurrent.Problems(Flow(Src("realpower"), Derived()));

        var message = Assert.Single(problems).Message;
        Assert.DoesNotContain("no power", message);
        Assert.Contains("no voltage", message);
    }

    [Fact]
    public void BothBoundIsNoProblem()
        => Assert.Empty(DerivedCurrent.Problems(Flow(Src("realpower"), Src("voltage"), Derived())));

    /// <summary>Only current can be worked out; asking for a derived anything-else is a mistake, said so.</summary>
    [Fact]
    public void OnlyCurrentCanBeDerived()
    {
        var problems = DerivedCurrent.Problems(Flow(Src("realpower"), Src("voltage"), Derived("energy")));

        Assert.Contains("only current", Assert.Single(problems).Message);
    }
}

using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

/// <summary>
/// An untracked node's history is a difference of counters, which is not a counter. Read as one, every fall was a
/// "reset" and a sub-panel whose every breaker is metered showed hundreds of kWh a day as untracked.
/// </summary>
public class UntrackedSeriesTests
{
    private static EnergyFlowConfig SubPanel() => new()
    {
        Nodes =
        {
            new() { Id = "sub" },
            new() { Id = "b1" },
            new() { Id = "b2" },
            new() { Id = "sub_untracked", Mode = "untracked" },
        },
        Links =
        {
            new() { From = "sub", To = "b1" },
            new() { From = "sub", To = "b2" },
            new() { From = "sub", To = "sub_untracked" },
        },
    };

    private static FlowTopology Topology(EnergyFlowConfig flow) => FlowTopology.Of(flow.Links.Select(l => (l.From, l.To)));

    private static IReadOnlyList<IReadOnlyDictionary<string, double>> Steps(params (string Node, double?[] Values)[] lanes)
    {
        var n = lanes.Max(l => l.Values.Length);
        return Enumerable.Range(0, n).Select(i =>
        {
            var step = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            foreach (var (node, values) in lanes) if (values[i] is { } v) step[node] = v;
            return (IReadOnlyDictionary<string, double>)step;
        }).ToList();
    }

    private static double?[] Lane(IReadOnlyList<IReadOnlyDictionary<string, double>> steps, string node)
        => steps.Select(s => s.TryGetValue(node, out var v) ? (double?)v : null).ToArray();

    [Fact]
    public void ThePlanNamesTheParentAndTheTrackedSiblings()
    {
        var flow = SubPanel();
        var plan = Assert.Single(UntrackedSeries.For(flow, Topology(flow)));
        Assert.Equal("sub_untracked", plan.Node);
        Assert.Equal("sub", plan.Parent);
        Assert.Equal(new[] { "b1", "b2" }, plan.Tracked.OrderBy(x => x));
    }

    [Fact]
    public void TwoUntrackedChildrenOfOneParentAreLeftAsRecorded()
    {
        var flow = SubPanel();
        flow.Nodes.Add(new() { Id = "other_untracked", Mode = "untracked" });
        flow.Links.Add(new() { From = "sub", To = "other_untracked" });
        Assert.Empty(UntrackedSeries.For(flow, Topology(flow)));
    }

    [Fact]
    public void OnlyCountersReadAsCountersAreRebuilt()
    {
        Assert.True(UntrackedSeries.Differenced("energy", perDay: true));
        Assert.True(UntrackedSeries.Differenced("energy_d", perDay: false));
        Assert.False(UntrackedSeries.Differenced("energy_d", perDay: true));
        Assert.False(UntrackedSeries.Differenced("realpower", perDay: false));
    }

    [Fact]
    public void RisesFollowTheTrendsPagesReading()
    {
        // A fall is a reset and books what has accumulated since; a single low reading followed by a normal one is noise.
        Assert.Equal(new double?[] { null, 5, 3, 0, 4, null, null, 2 }, UntrackedSeries.Rises(new double?[] { 10, 15, 3, 1, 7, null, 20, 22 }));
        Assert.Equal(new double?[] { null, 0, 2 }, UntrackedSeries.Rises(new double?[] { 10, 9, 12 }));
    }

    [Fact]
    public void ABreakerCounterResetIsNotUntrackedEnergy()
    {
        // The panel rises 10 a day and its breakers 6 and 4 between them, so nothing is untracked. On the third day
        // b1's counter resets: recorded as panel less breakers, the difference leaps by b1's whole lifetime total.
        var sub = new double?[] { 1000, 1010, 1020, 1030, 1040 };
        var b1 = new double?[] { 600, 606, 2, 8, 14 };
        var b2 = new double?[] { 400, 404, 408, 412, 416 };
        var recorded = sub.Select((p, i) => (double?)Math.Max(0, p!.Value - b1[i]!.Value - b2[i]!.Value)).ToArray();
        var steps = Steps(("sub", sub), ("b1", b1), ("b2", b2), ("sub_untracked", recorded));

        var flow = SubPanel();
        var rebuilt = Lane(UntrackedSeries.Apply(UntrackedSeries.For(flow, Topology(flow)), steps), "sub_untracked");

        // b1's reset books what it ran since (2), so the panel's 10 is 2 + 4 tracked and 4 untracked that day only.
        Assert.Equal(new double?[] { 0, 0, 4, 4, 4 }, rebuilt);
        Assert.Equal(sub, Lane(UntrackedSeries.Apply(UntrackedSeries.For(flow, Topology(flow)), steps), "sub"));
    }

    [Fact]
    public void BreakersThatOutpaceThePanelDoNotBookTheDifference()
    {
        // Clamps disagree by a little each day: the recorded difference falls daily, and every fall read as a reset
        // booked the whole difference again.
        var sub = new double?[] { 1500, 1510, 1520, 1530 };
        var b1 = new double?[] { 600, 606, 612, 618 };
        var b2 = new double?[] { 400, 405, 410, 415 };
        var steps = Steps(("sub", sub), ("b1", b1), ("b2", b2), ("sub_untracked", new double?[] { 500, 499, 498, 497 }));

        var flow = SubPanel();
        Assert.Equal(new double?[] { 0, 0, 0, 0 }, Lane(UntrackedSeries.Apply(UntrackedSeries.For(flow, Topology(flow)), steps), "sub_untracked"));
    }

    [Fact]
    public void ARealSpareIsKeptAndAGapStaysAGap()
    {
        var sub = new double?[] { 100, 112, null, 130, 142 };
        var b1 = new double?[] { 50, 55, 60, 65, 70 };
        var b2 = new double?[] { 50, 55, 60, null, 75 };
        var steps = Steps(("sub", sub), ("b1", b1), ("b2", b2));

        var flow = SubPanel();
        // 12 - 10 = 2 untracked; then the panel's gap, and b2's, leave steps nothing can say about.
        Assert.Equal(new double?[] { 0, 2, null, null, null }, Lane(UntrackedSeries.Apply(UntrackedSeries.For(flow, Topology(flow)), steps), "sub_untracked"));
    }

    [Fact]
    public void ASiblingWithNothingInTheWindowIsNotPartOfTheDraw()
    {
        var steps = Steps(("sub", new double?[] { 100, 110, 120 }), ("b1", new double?[] { 50, 56, 62 }));
        var flow = SubPanel();
        Assert.Equal(new double?[] { 0, 4, 8 }, Lane(UntrackedSeries.Apply(UntrackedSeries.For(flow, Topology(flow)), steps), "sub_untracked"));
    }
}

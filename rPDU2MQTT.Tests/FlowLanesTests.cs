using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Tests;

/// <summary>
/// What a chart of history asks the backend for. Grid export never appeared on the Trends page: the lines
/// were read off the live graph, where a return lane exists only while something is flowing back at that
/// instant, so opening the page at night asked for no export and was told there was none (#395).
/// </summary>
public class FlowLanesTests
{
    private static FlowNode Node(string id, string label, string kind) => new(id, label, kind);

    [Fact]
    public void EveryNodeIsAskedForInBothDirections()
    {
        var lanes = FlowLanes.For(new[] { Node("grid", "Grid", "grid"), Node("battery", "Battery", "battery") });

        Assert.Contains(lanes, l => l.Id == "grid");
        Assert.Contains(lanes, l => l.Id == "grid#in");
        Assert.Contains(lanes, l => l.Id == "battery");
        Assert.Contains(lanes, l => l.Id == "battery#in");
    }

    [Fact]
    public void ReturnLanesAreNamedForWhatFlowingBackMeans()
    {
        var lanes = FlowLanes.For(new[] { Node("grid", "Grid", "grid"), Node("battery", "Battery", "battery"), Node("shed", "Shed", "load") });

        Assert.Equal("Grid (export)", lanes.Single(l => l.Id == "grid#in").Label);
        Assert.Equal("Battery (charging)", lanes.Single(l => l.Id == "battery#in").Label);
        Assert.Equal("Shed (in)", lanes.Single(l => l.Id == "shed#in").Label);
    }

    [Fact]
    public void ALaneKeepsItsNodesKindAndTags()
    {
        var lanes = FlowLanes.For(new[] { new FlowNode("grid", "Grid", "grid", Tags: new[] { "meter" }) });

        var lane = lanes.Single(l => l.Id == "grid#in");
        Assert.Equal("grid", lane.Kind);
        Assert.Equal(new[] { "meter" }, lane.Tags);
    }

    /// <summary>A computed remainder is not a measurement, so there is nothing in history to ask for.</summary>
    [Fact]
    public void TheUnmeasuredRemainderIsNotAskedFor()
    {
        var lanes = FlowLanes.For(new[] { Node("grid", "Grid", "grid"), Node("grid#unmeasured", "Grid (unmeasured)", "grid") });

        Assert.DoesNotContain(lanes, l => l.Id.Contains("unmeasured"));
    }
}

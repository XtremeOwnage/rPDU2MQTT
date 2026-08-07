using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Which nodes a destination receives, chosen by tag (#342). The filter decides what is sent and nothing
/// else — a node excluded from one destination still reports on the diagram, still contributes to whatever
/// aggregates from it, and still reaches every other destination.
/// </summary>
public class NodeTagFilterTests
{
    private static NodeTagFilter Filter(string[]? include = null, string[]? exclude = null) =>
        new() { Include = [.. include ?? []], Exclude = [.. exclude ?? []] };

    [Fact]
    public void AnEmptyFilterSendsEverything()
    {
        // The default on every existing install: adding the field must change nothing until it is used.
        var f = Filter();
        Assert.True(f.IsEmpty);
        Assert.True(f.Allows(["anything"]));
        Assert.True(f.Allows(null));
        Assert.True(f.Allows([]));
    }

    [Fact]
    public void IncludeSendsOnlyTaggedNodes()
    {
        var f = Filter(include: ["critical"]);
        Assert.True(f.Allows(["critical"]));
        Assert.True(f.Allows(["roof", "critical"]));
        Assert.False(f.Allows(["roof"]));
        // An untagged node fails a populated include list — that is what "only send nodes tagged X" means.
        Assert.False(f.Allows(null));
    }

    [Fact]
    public void ExcludeBeatsInclude()
    {
        // A node matching both must be dropped. The other reading makes a node silently reappear despite an
        // explicit exclusion, which is the opposite of what someone typing one expects.
        var f = Filter(include: ["critical"], exclude: ["noisy"]);
        Assert.True(f.Allows(["critical"]));
        Assert.False(f.Allows(["critical", "noisy"]));
    }

    [Fact]
    public void ExcludeAloneSendsEverythingElse_IncludingUntaggedNodes()
    {
        var f = Filter(exclude: ["noisy"]);
        Assert.False(f.Allows(["noisy"]));
        Assert.True(f.Allows(["roof"]));
        Assert.True(f.Allows(null));
    }

    [Fact]
    public void MatchingIgnoresCaseAndSurroundingSpace()
    {
        // Tags are hand-typed in one place and the filter in another; they will not agree on either.
        var f = Filter(include: [" Critical "]);
        Assert.True(f.Allows(["critical"]));
        Assert.True(f.Allows(["CRITICAL"]));
    }

    [Fact]
    public void FilteringADestinationDoesNotChangeTheGraph()
    {
        // The property the whole feature rests on. Excluding a node from an export must leave the roll-up
        // untouched, or a display filter becomes a way to alter the figures every other consumer reads.
        var flow = new EnergyFlowConfig();
        flow.Nodes.Add(new EnergyFlowNode { Id = "solar", Mode = "static", Value = 100, Tags = ["noisy"] });
        flow.Nodes.Add(new EnergyFlowNode { Id = "inverter" });
        flow.Links.Add(new EnergyFlowLink { From = "solar", To = "inverter" });

        var graph = FlowGraphBuilder.Build(new rPDU2MQTT.Models.PDU.PduData(), flow);
        var excluded = Filter(exclude: ["noisy"]);

        // The node is still in the graph with its value; only the destination declines to send it.
        var solar = graph.Nodes.Single(n => n.Id == "solar");
        Assert.Equal(100, solar.Value);
        Assert.False(excluded.Allows(solar.Tags));
        Assert.True(excluded.Allows(graph.Nodes.Single(n => n.Id == "inverter").Tags));
    }
}

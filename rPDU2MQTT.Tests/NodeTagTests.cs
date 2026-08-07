using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Tags group nodes across the hierarchy (#342). They decide what a view emphasises and nothing else — no
/// tag may change a value, a link, or which nodes exist.
/// </summary>
public class NodeTagTests
{
    private static EnergyFlowConfig Flow(params EnergyFlowNode[] nodes)
    {
        var f = new EnergyFlowConfig();
        foreach (var n in nodes) f.Nodes.Add(n);
        f.Links.Add(new EnergyFlowLink { From = "solar", To = "inverter" });
        return f;
    }

    private static FlowNode Node(FlowGraph g, string id) => g.Nodes.Single(n => n.Id == id);

    [Fact]
    public void TagsReachTheGraph()
    {
        var graph = FlowGraphBuilder.Build(new PduData(), Flow(
            new EnergyFlowNode { Id = "solar", Mode = "static", Value = 100, Tags = ["roof", "critical"] },
            new EnergyFlowNode { Id = "inverter" }));

        Assert.Equal(["roof", "critical"], Node(graph, "solar").Tags);
    }

    [Fact]
    public void TagsAreTrimmedAndDeduplicated()
    {
        // Hand-typed and comma-split, so blanks and repeats arrive routinely. Two chips reading "Rack 1"
        // is noise, and a tag of " " would render as an unclickable empty chip.
        var graph = FlowGraphBuilder.Build(new PduData(), Flow(
            new EnergyFlowNode { Id = "solar", Mode = "static", Value = 100, Tags = [" roof ", "", "  ", "ROOF", "roof"] },
            new EnergyFlowNode { Id = "inverter" }));

        Assert.Equal(["roof"], Node(graph, "solar").Tags);
    }

    [Fact]
    public void AnUntaggedNodeCarriesNoTagList()
    {
        var graph = FlowGraphBuilder.Build(new PduData(), Flow(
            new EnergyFlowNode { Id = "solar", Mode = "static", Value = 100 },
            new EnergyFlowNode { Id = "inverter" }));

        Assert.Null(Node(graph, "solar").Tags);
    }

    [Fact]
    public void TaggingChangesNoValueLinkOrNode()
    {
        // The property that matters: a tag is metadata. Adding one must produce a byte-identical roll-up,
        // or "filter by tag" becomes a way to change the numbers being read.
        var plain = FlowGraphBuilder.Build(new PduData(), Flow(
            new EnergyFlowNode { Id = "solar", Mode = "static", Value = 100 },
            new EnergyFlowNode { Id = "inverter" }));

        var tagged = FlowGraphBuilder.Build(new PduData(), Flow(
            new EnergyFlowNode { Id = "solar", Mode = "static", Value = 100, Tags = ["roof"] },
            new EnergyFlowNode { Id = "inverter", Tags = ["critical"] }));

        Assert.Equal(plain.Nodes.Select(n => n.Id), tagged.Nodes.Select(n => n.Id));
        Assert.Equal(plain.Nodes.Select(n => n.Value), tagged.Nodes.Select(n => n.Value));
        Assert.Equal(plain.Nodes.Select(n => n.Derivation), tagged.Nodes.Select(n => n.Derivation));
        Assert.Equal(plain.Links.Select(l => (l.Source, l.Target, l.Value, l.Known)),
                     tagged.Links.Select(l => (l.Source, l.Target, l.Value, l.Known)));
    }
}

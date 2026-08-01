using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Nodes the builder invents for the diagram must never reach an export. Three consumers got this wrong
/// independently, so the rule lives on the node itself rather than in each caller.
/// </summary>
public class SyntheticNodesAreNotExportedTests
{
    [Theory]
    [InlineData("main_panel#unmeasured")]
    [InlineData("eg4-flexboss21-battery#in")]
    [InlineData("grid#in")]
    public void BuilderInventionsAreSynthetic(string id)
        => Assert.True(new FlowNode(id, "x", "node").Synthetic);

    [Theory]
    [InlineData("main_panel")]
    [InlineData("eg4-flexboss21-battery")]
    [InlineData("pdu:pdu_1")]          // real ids use ':' as their separator, never '#'
    [InlineData("outlet:pdu_1:0")]
    [InlineData("MPPT_1")]
    public void ConfiguredAndAutoNodesAreNot(string id)
        => Assert.False(new FlowNode(id, "x", "node").Synthetic);

    [Fact]
    public void ASyntheticIdWouldNotBeALegalMqttTopic()
    {
        // The export publishes to `energy/{id}`. '#' is the multi-level wildcard and is not allowed in a
        // publish topic at all, so this is why these can never be exported — not merely why they should not.
        var topic = "energy/" + new FlowNode("main_panel#unmeasured", "Unmeasured load", "unmeasured").Id;

        Assert.Contains('#', topic);
        Assert.True(new FlowNode("main_panel#unmeasured", "x", "x").Synthetic);
    }

    [Fact]
    public void TheEnergyDashboardSkipsThem()
    {
        var graph = new FlowGraph(
            new List<FlowNode>
            {
                new("main_panel", "Main Panel", "panel", 8184),
                new("main_panel#unmeasured", "Unmeasured load", "unmeasured", 7624),
            },
            new List<FlowLink> { new("main_panel", "main_panel#unmeasured", 7624) },
            "realpower", "W");

        var sources = EnergyDashboardSync.BuildEnergySources(graph, (id, _) => "sensor." + id.Replace('#', '_'));

        Assert.DoesNotContain(sources, s => s.ToJsonString().Contains("unmeasured"));
    }
}

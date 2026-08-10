using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Battery charge and grid export reach the history backends.</summary>
public class ReturnLaneExportTests
{
    private sealed class Fixed(Dictionary<string, double> v) : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>solar → inverter → panel, battery charging off the inverter.</summary>
    private static (FlowGraph Graph, EnergyFlowConfig Flow) Build(params (string Key, double Value)[] live)
    {
        var c = new EnergyFlowConfig();
        c.Nodes.Add(new EnergyFlowNode { Id = "solar", Kind = "solar" });
        c.Nodes.Add(new EnergyFlowNode { Id = "inverter", Kind = "inverter" });
        c.Nodes.Add(new EnergyFlowNode { Id = "battery", Kind = "battery", Tags = ["storage"] });
        c.Nodes.Add(new EnergyFlowNode { Id = "panel", Kind = "panel" });
        c.Links.Add(new EnergyFlowLink { From = "solar", To = "inverter" });
        c.Links.Add(new EnergyFlowLink { From = "battery", To = "inverter" });
        c.Links.Add(new EnergyFlowLink { From = "inverter", To = "panel" });
        return (FlowGraphBuilder.Build(new PduData(), c, "energytoday", new Fixed(live.ToDictionary(x => x.Key, x => x.Value))), c);
    }

    [Fact]
    public void AChargeLaneIsAReturnLane_NotTheUnmeteredRemainder()
    {
        var (graph, _) = Build(("solar|energytoday", 40), ("battery|energytoday", 0), ("battery|energytoday#in", 12));

        var charge = graph.Nodes.Single(n => n.Id == "battery#in");

        Assert.True(charge.Synthetic);      // the builder invented the node
        Assert.True(charge.ReturnLane);     // but the figure on it is measured
        Assert.Equal(12, charge.Value);
    }

    [Fact]
    public void TheUnmeteredRemainderIsStillNotAReturnLane()
    {
        // Arithmetic about a hierarchy. It belongs on a diagram and nowhere near a metrics store.
        var (graph, _) = Build(("solar|energytoday", 40), ("inverter|energytoday", 40), ("panel|energytoday", 40));

        foreach (var n in graph.Nodes.Where(n => n.Id.EndsWith("#unmeasured")))
            Assert.False(n.ReturnLane);
    }

    [Fact]
    public void AReturnLaneCarriesItsNodesTags()
    {
        // Or a tag filter keeps the discharge and silently drops the charge, and the export is half a story.
        var (graph, _) = Build(("battery|energytoday", 0), ("battery|energytoday#in", 12), ("solar|energytoday", 40));

        var charge = graph.Nodes.Single(n => n.Id == "battery#in");

        Assert.Equal(["storage"], charge.Tags!);
    }

    [Fact]
    public void TheExportRuleKeepsReturnLanesAndDropsRemainders()
    {
        // Calls the production rule rather than restating it: a test carrying its own copy of the condition
        // passes just as happily when the exporter stops using it.
        var (graph, _) = Build(("solar|energytoday", 40), ("battery|energytoday#in", 12), ("panel|energytoday", 5));

        var exported = graph.Nodes.Where(FlowExport.ToMetricsStore).Select(n => n.Id).ToList();

        Assert.Contains("battery#in", exported);
        Assert.DoesNotContain(exported, id => id.EndsWith("#unmeasured"));
    }
}

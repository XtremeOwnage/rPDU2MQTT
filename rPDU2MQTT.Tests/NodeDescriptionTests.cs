using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

public class NodeDescriptionTests
{
    private sealed class Fixed(Dictionary<string, double> v) : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    [Fact]
    public void ANodesDescription_IsCarriedOntoTheGraph()
    {
        var flow = new EnergyFlowConfig
        {
            Nodes =
            {
                new() { Id = "panel", Kind = "panel", Description = "  Garage sub-panel\nfed from the main  " },
                new() { Id = "load", Kind = "load" },
            },
            Links = { new() { From = "panel", To = "load" } },
        };

        var g = FlowGraphBuilder.Build(new PduData(), flow, FlowGraphBuilder.DefaultMetric,
            new Fixed(new() { ["load|realpower"] = 100 }));

        Assert.Equal("Garage sub-panel\nfed from the main", g.Nodes.Single(n => n.Id == "panel").Description);
        Assert.Null(g.Nodes.Single(n => n.Id == "load").Description);
    }
}

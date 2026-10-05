using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

public class SolarStringFlowTests
{
    private sealed class Fixed(Dictionary<string, double> v) : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TwoStringsOfMeasuredPanels_OnOneMppt_EachCarryTheirSum(bool grouped)
    {
        var flow = new EnergyFlowConfig();
        var readings = new Dictionary<string, double> { ["mppt|realpower"] = 500 };
        flow.Nodes.Add(new() { Id = "inverter", Kind = "inverter" });
        flow.Nodes.Add(new() { Id = "mppt", Kind = "node" });
        flow.Links.Add(new() { From = "mppt", To = "inverter" });
        foreach (var (s, watts) in new[] { ("a", 100.0), ("b", 150.0) })
        {
            flow.Nodes.Add(new() { Id = s, Kind = "solar", Tags = { "pv-string" } });
            flow.Links.Add(new() { From = s, To = "mppt" });
            for (var i = 0; i < 2; i++)
            {
                var panel = $"{s}{i}";
                flow.Nodes.Add(new() { Id = panel, Kind = "solar" });
                flow.Links.Add(new() { From = panel, To = s });
                readings[panel + "|realpower"] = watts;
            }
        }

        if (grouped)
            foreach (var s in new[] { "a", "b" })
                flow.Groups.Add(new EnergyFlowGroup { Id = s, Kind = "solar", Label = s, Members = { s + "0", s + "1" } });

        var g = FlowGraphBuilder.Build(new PduData(), flow, "realpower", new Fixed(readings));

        var a = Assert.Single(g.Links, l => l.Source == "a" && l.Target == "mppt");
        var b = Assert.Single(g.Links, l => l.Source == "b" && l.Target == "mppt");
        Assert.True(a.Known && b.Known);
        Assert.Equal(200, a.Value);
        Assert.Equal(300, b.Value);
        Assert.Equal(FlowDerivation.Summed, g.Nodes.Single(n => n.Id == "a").Derivation);
    }
}

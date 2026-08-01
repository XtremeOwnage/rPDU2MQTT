using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A node's bar is as tall as its throughput, but only its links carry flow — so a gap between the two
/// draws as unexplained height. Shaped after a real system: an inverter feeding a panel whose only metered
/// children are two rack PDUs drawing a few hundred watts of an 8 kW throughput.
/// </summary>
public class UnmeasuredLoadTests
{
    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>inverter (measured) → main_panel (untracked, unmetered) → two metered PDUs.</summary>
    private static EnergyFlowConfig Topology()
    {
        var cfg = new EnergyFlowConfig();
        cfg.Nodes.Add(new EnergyFlowNode { Id = "inverter", Kind = "inverter" });
        cfg.Nodes.Add(new EnergyFlowNode { Id = "main_panel", Kind = "panel", Mode = "untracked" });
        cfg.Nodes.Add(new EnergyFlowNode { Id = "pdu_1" });
        cfg.Nodes.Add(new EnergyFlowNode { Id = "pdu_2" });
        cfg.Links.Add(new EnergyFlowLink { From = "inverter", To = "main_panel" });
        cfg.Links.Add(new EnergyFlowLink { From = "main_panel", To = "pdu_1" });
        cfg.Links.Add(new EnergyFlowLink { From = "main_panel", To = "pdu_2" });
        return cfg;
    }

    private static FlowGraph Build(Dictionary<string, double> readings)
        => FlowGraphBuilder.Build(new PduData(), Topology(), "realpower", new Fixed(readings));

    private static readonly Dictionary<string, double> Live = new()
    {
        ["inverter|realpower"] = 8299,
        ["pdu_1|realpower"] = 273,
        ["pdu_2|realpower"] = 274,
    };

    [Fact]
    public void ThePanelsUnmeteredLoadIsNamedRatherThanLeftAsBarHeight()
    {
        var g = Build(Live);

        var gap = Assert.Single(g.Links, l => l.Source == "main_panel" && l.Target == "main_panel#unmeasured");
        Assert.Equal(8299 - 273 - 274, gap.Value, 0);
        Assert.Contains(g.Nodes, n => n.Id == "main_panel#unmeasured" && n.Label == "Unmeasured load" && n.Kind == "unmeasured");
    }

    [Fact]
    public void TheMeteredChildrenKeepTheirOwnReadings()
    {
        // The point of naming the gap is that it is NOT taken from the children: they still report what
        // they actually measure.
        var g = Build(Live);

        Assert.Contains(g.Links, l => l.Target == "pdu_1" && l.Value == 273);
        Assert.Contains(g.Links, l => l.Target == "pdu_2" && l.Value == 274);
    }

    [Fact]
    public void TheNodesOutflowNowAccountsForItsWholeThroughput()
    {
        var g = Build(Live);

        var outflow = g.Links.Where(l => l.Source == "main_panel").Sum(l => l.Value);
        Assert.Equal(8299, outflow, 0);   // nothing left unexplained
    }

    [Fact]
    public void AFullyMeteredNodeGetsNoUnmeasuredChild()
    {
        var g = Build(new() { ["inverter|realpower"] = 547, ["pdu_1|realpower"] = 273, ["pdu_2|realpower"] = 274 });

        Assert.DoesNotContain(g.Nodes, n => n.Kind == "unmeasured");
    }

    [Fact]
    public void RoundingNoiseDoesNotDrawAGap()
    {
        // Half a watt adrift on 547 W is measurement noise, not an unmetered load.
        var g = Build(new() { ["inverter|realpower"] = 547.5, ["pdu_1|realpower"] = 273, ["pdu_2|realpower"] = 274 });

        Assert.DoesNotContain(g.Nodes, n => n.Kind == "unmeasured");
    }

    [Fact]
    public void ATerminalLeafIsNeverGivenOne()
    {
        // pdu_1 has nothing below it, so its reading IS its consumption — there is no gap to explain.
        var g = Build(Live);

        Assert.DoesNotContain(g.Links, l => l.Source == "pdu_1" && l.Target.Contains("unmeasured"));
    }
}

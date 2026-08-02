using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A measured node's reading answers what its sensor measures, which is not always what passes through the
/// node. Reconstructed from the live inverter: bound to <c>load_power</c>, it reported its AC-load leg while
/// also sending several kW to charge a battery.
/// </summary>
public class ThroughputImbalanceTests
{
    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    /// <summary>solar → inverter → panel, with the inverter also charging a battery via its in-lane.</summary>
    private static EnergyFlowConfig Topology()
    {
        var c = new EnergyFlowConfig();
        c.Nodes.Add(new EnergyFlowNode { Id = "solar", Kind = "solar" });
        c.Nodes.Add(new EnergyFlowNode { Id = "inverter", Kind = "inverter" });
        c.Nodes.Add(new EnergyFlowNode { Id = "battery", Kind = "battery" });
        c.Nodes.Add(new EnergyFlowNode { Id = "panel", Kind = "panel" });
        c.Links.Add(new EnergyFlowLink { From = "solar", To = "inverter" });
        c.Links.Add(new EnergyFlowLink { From = "battery", To = "inverter" });
        c.Links.Add(new EnergyFlowLink { From = "inverter", To = "panel" });
        return c;
    }

    // The live figures: 8,344 W of PV in, 2,526 W to the panel, 5,652 W into the battery.
    private static readonly Dictionary<string, double> Live = new()
    {
        ["solar|realpower"] = 8344,
        ["inverter|realpower"] = 2526,
        ["battery|realpower"] = 0,
        ["battery|realpower#in"] = 5652,
    };

    [Fact]
    public void AMeasuredNodeCarryingMoreThanItReports_IsFlagged()
    {
        // This used to return null on sight for anything measured — "its own reading settles it" — so an
        // inverter drawing a bar a third the width of its own ribbons said nothing at all.
        var graph = FlowGraphBuilder.Build(new PduData(), Topology(), "realpower", new Fixed(Live));

        var inverter = graph.Nodes.Single(n => n.Id == "inverter");
        Assert.Equal(2526, inverter.Value);              // the reading is still the reading
        Assert.NotNull(inverter.Imbalance);              // but the discrepancy is no longer silent
        Assert.True(inverter.Imbalance > 5000, $"expected the ~5.8 kW shortfall, got {inverter.Imbalance}");
    }

    [Fact]
    public void AMeasuredNodeWhoseFlowsAgree_IsNotFlagged()
    {
        // The common case must stay quiet, or the marker means nothing.
        var live = new Dictionary<string, double>(Live) { ["inverter|realpower"] = 8344 };
        live.Remove("battery|realpower#in");

        var graph = FlowGraphBuilder.Build(new PduData(), Topology(), "realpower", new Fixed(live));

        Assert.Null(graph.Nodes.Single(n => n.Id == "inverter").Imbalance);
    }

    [Fact]
    public void RoundingIsNotADiscrepancy()
    {
        var live = new Dictionary<string, double>(Live) { ["inverter|realpower"] = 8300 };
        live.Remove("battery|realpower#in");

        var graph = FlowGraphBuilder.Build(new PduData(), Topology(), "realpower", new Fixed(live));

        Assert.Null(graph.Nodes.Single(n => n.Id == "inverter").Imbalance);
    }

    [Fact]
    public void ATerminalLeaf_IsNeverFlagged()
    {
        // Nothing leaves it, so there is no throughput to contradict its reading.
        var graph = FlowGraphBuilder.Build(new PduData(), Topology(), "realpower", new Fixed(Live));

        Assert.Null(graph.Nodes.Single(n => n.Id == "solar").Imbalance);
    }
}

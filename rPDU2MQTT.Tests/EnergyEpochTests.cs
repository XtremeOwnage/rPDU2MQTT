using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// The diagram's side of the epoch problem, reconstructed from the live system that exposed it: an inverter
/// reporting 740 kWh feeding a panel that reported 8,358 kWh, because the panel's figure rolled up from PDU
/// firmware counters that had been running for years while the inverter's had been derived for weeks.
/// </summary>
public class EnergyEpochTests
{
    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    private static Outlet Outlet(int key, string name, string type, string value, string units = "kWh")
    {
        var o = new Outlet { Key = key, Entity_Name = $"o{key}", Entity_DisplayName = name };
        if (type.Length > 0) o.Measurements.Add(new Measurement { Type = type, Value = value, Units = units });
        return o;
    }

    private static PduData Pdu(params Outlet[] outlets)
    {
        var device = new Device { Key = "rack_pdu_1", Entity_Name = "rack_pdu_1", Entity_DisplayName = "Rack-PDU-1" };
        device.Outlets.AddRange(outlets);
        var data = new PduData();
        data.Devices.Add(device);
        return data;
    }

    /// <summary>inverter → main_panel → the PDU whose outlets carry the metered totals.</summary>
    private static EnergyFlowConfig Topology()
    {
        var cfg = new EnergyFlowConfig();
        cfg.Nodes.Add(new EnergyFlowNode { Id = "inverter", Kind = "inverter" });
        cfg.Nodes.Add(new EnergyFlowNode { Id = "main_panel", Kind = "panel" });
        cfg.Links.Add(new EnergyFlowLink { From = "inverter", To = "main_panel" });
        cfg.Links.Add(new EnergyFlowLink { From = "main_panel", To = "pdu:rack_pdu_1" });
        return cfg;
    }

    [Fact]
    public void OnLifetimeEnergy_APanelPassingMoreThanArrives_IsReportedAsAnImbalance()
    {
        // Both figures are real; they just aren't measured from the same moment, so they cannot both be true
        // of one panel. Before this the builder reported max(inflow, outflow) and said nothing — the panel
        // drew at full height above a ribbon that was a sliver, and it read as a finished chart.
        var graph = FlowGraphBuilder.Build(
            Pdu(Outlet(0, "Kube05", "energy", "7371.006")),
            Topology(), "energy",
            new Fixed(new() { ["inverter|energy"] = 740 }));

        var panel = graph.Nodes.Single(n => n.Id == "main_panel");
        Assert.Equal(7371.006, panel.Value!.Value, 3);
        Assert.Equal(6631.006, panel.Imbalance!.Value, 3);   // 7371.006 out, 740 in
    }

    [Fact]
    public void OnTheDailyTotal_TheSamePanelReconciles_AndIsNotFlagged()
    {
        // Same topology, same devices — but every figure now covers today, so the arithmetic closes and the
        // diagram has nothing to warn about. This is the whole point of the period metric.
        var graph = FlowGraphBuilder.Build(
            Pdu(Outlet(0, "Kube05", "", "")),
            Topology(), EnergyPeriod.Metric,
            new Fixed(new()
            {
                ["inverter|" + EnergyPeriod.Metric] = 12.5,
                ["outlet:rack_pdu_1:0|" + EnergyPeriod.Metric] = 12.5,
            }));

        var panel = graph.Nodes.Single(n => n.Id == "main_panel");
        Assert.Equal(12.5, panel.Value!.Value, 3);
        Assert.Null(panel.Imbalance);
    }

    [Fact]
    public void ADerivedMetric_ReachesOutlets_ThoughThePduReportsNoSuchMeasurement()
    {
        // A PDU publishes no "energy today" measurement — the aggregator derives it from the rise of the
        // PDU's own counter. Without a live fallback for auto nodes the entire PDU side of the diagram
        // vanished on this metric, which would have looked like the fix working when it was doing nothing.
        var graph = FlowGraphBuilder.Build(
            Pdu(Outlet(0, "Kube05", "energy", "7371.006"), Outlet(1, "Unraid", "energy", "1865.463")),
            new EnergyFlowConfig(), EnergyPeriod.Metric,
            new Fixed(new()
            {
                ["outlet:rack_pdu_1:0|" + EnergyPeriod.Metric] = 4.5,
                ["outlet:rack_pdu_1:1|" + EnergyPeriod.Metric] = 6.0,
            }));

        Assert.Equal("kWh", graph.Units);
        Assert.Equal(4.5, graph.Links.Single(l => l.Target == "outlet:rack_pdu_1:0").Value, 3);
        Assert.Equal(10.5, graph.Nodes.Single(n => n.Id == "pdu:rack_pdu_1").Value!.Value, 3);
    }

    [Fact]
    public void ANativeMeasurement_StillWins_OverAnythingLiveForTheSameOutlet()
    {
        // The fallback must only fill a gap. A metric the PDU actually reports is the authority for it.
        var graph = FlowGraphBuilder.Build(
            Pdu(Outlet(0, "Kube05", "realpower", "100", "W")),
            new EnergyFlowConfig(), "realpower",
            new Fixed(new() { ["outlet:rack_pdu_1:0|realpower"] = 999 }));

        Assert.Equal(100, graph.Links.Single(l => l.Target == "outlet:rack_pdu_1:0").Value);
    }

    [Fact]
    public void ARoot_AndATerminalLeaf_AreNeverFlaggedAsImbalanced()
    {
        // A root has no inflow and a leaf no outflow. Neither is a contradiction, and flagging them would
        // put a warning on most of the diagram.
        var graph = FlowGraphBuilder.Build(
            Pdu(Outlet(0, "Kube05", "energy", "7371.006")),
            Topology(), "energy",
            new Fixed(new() { ["inverter|energy"] = 740 }));

        Assert.Null(graph.Nodes.Single(n => n.Id == "inverter").Imbalance);
        Assert.Null(graph.Nodes.Single(n => n.Id == "outlet:rack_pdu_1:0").Imbalance);
    }

    [Fact]
    public void ConversionLossAndRounding_AreNotContradictions()
    {
        // An inverter is not 100% efficient and the counters do not agree to the milliwatt-hour. A 1% gap is
        // the system working; warning about it would train the operator to ignore the warning.
        var graph = FlowGraphBuilder.Build(
            Pdu(Outlet(0, "Kube05", "energy", "99")),
            Topology(), "energy",
            new Fixed(new() { ["inverter|energy"] = 100 }));

        Assert.Null(graph.Nodes.Single(n => n.Id == "main_panel").Imbalance);
    }
}
